#!/usr/bin/env python3
"""Build a portable Windows x64 ZIP for Karaoke Live.

The package is deliberately assembled from the pinned Electron release rather
than from a locally installed Electron runtime.  The release archive is
verified against Electron's published SHA-256 manifest before it is unpacked.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
RELEASE_ROOT = "https://github.com/electron/electron/releases/download"
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
SEMVER_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
RUNTIME_EXTENSIONS = {".js", ".mjs", ".cjs", ".html", ".css", ".svg"}


class PackageError(RuntimeError):
    """An expected, actionable packaging failure."""


def read_package(root: Path = ROOT) -> tuple[str, str]:
    """Return the app version and exact Electron version from package.json."""
    package_path = root / "package.json"
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PackageError(f"Cannot read {package_path}: {exc}") from exc

    version = package.get("version")
    if not isinstance(version, str) or not SEMVER_RE.fullmatch(version):
        raise PackageError("package.json must contain a concrete semver app version.")

    electron = None
    for section in ("devDependencies", "dependencies"):
        candidate = package.get(section, {}).get("electron")
        if candidate is not None:
            electron = candidate
            break
    if not isinstance(electron, str) or not SEMVER_RE.fullmatch(electron):
        raise PackageError(
            "package.json must pin Electron to an exact semver (ranges are refused)."
        )
    return version, electron


def release_names(electron_version: str) -> tuple[str, str, str]:
    """Return the official ZIP name, archive URL and checksum URL."""
    archive_name = f"electron-v{electron_version}-win32-x64.zip"
    base = f"{RELEASE_ROOT}/v{electron_version}"
    return archive_name, f"{base}/{archive_name}", f"{base}/SHASUMS256.txt"


def download(url: str, destination: Path) -> None:
    """Download one bounded official asset using Python's standard library."""
    request = urllib.request.Request(url, headers={"User-Agent": "KaraokeLive-packager/1"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as handle:
            shutil.copyfileobj(response, handle, length=1024 * 1024)
    except (OSError, urllib.error.URLError) as exc:
        raise PackageError(f"Could not download official Electron asset {url}: {exc}") from exc


def checksum_from_manifest(manifest: Path, archive_name: str) -> str:
    """Find the exact archive hash in an Electron SHASUMS256.txt file."""
    try:
        lines = manifest.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise PackageError(f"Cannot read checksum manifest {manifest}: {exc}") from exc

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue

        # GNU sha256sum format: <hash>  <filename> (the second field may start
        # with '*' for binary mode).
        fields = line.split()
        if len(fields) >= 2 and SHA256_RE.fullmatch(fields[0]):
            candidate = fields[-1].lstrip("*")
            if candidate == archive_name:
                return fields[0].lower()

        # BSD shasum format: SHA256 (filename) = <hash>.
        bsd = re.fullmatch(r"SHA256\s+\((.+)\)\s*=\s*([0-9a-fA-F]{64})", line)
        if bsd and bsd.group(1) == archive_name:
            return bsd.group(2).lower()

    raise PackageError(f"Checksum manifest has no exact entry for {archive_name}.")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise PackageError(f"Cannot read Electron ZIP {path}: {exc}") from exc
    return digest.hexdigest()


def verify_electron_zip(archive: Path, manifest: Path, archive_name: str) -> str:
    if not archive.is_file():
        raise PackageError(f"Electron ZIP does not exist: {archive}")
    expected = checksum_from_manifest(manifest, archive_name)
    actual = sha256_file(archive)
    if actual != expected:
        raise PackageError(
            f"Electron SHA-256 mismatch for {archive.name}: expected {expected}, got {actual}."
        )
    return actual


def _safe_member_path(root: Path, member_name: str) -> Path:
    """Return a safe destination for one ZIP member, or raise."""
    if "\x00" in member_name:
        raise PackageError("Electron ZIP contains a NUL byte in a member name.")
    normalized = member_name.replace("\\", "/")
    if not normalized or normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise PackageError(f"Unsafe absolute Windows ZIP member: {member_name!r}")
    parts = PurePosixPath(normalized).parts
    if any(part in ("", ".", "..") for part in parts):
        raise PackageError(f"Unsafe ZIP member path: {member_name!r}")
    destination = root.joinpath(*parts)
    try:
        destination.relative_to(root)
    except ValueError as exc:
        raise PackageError(f"ZIP member escapes extraction root: {member_name!r}") from exc
    return destination


def safe_extract(archive: Path, destination: Path) -> None:
    """Extract a ZIP after checking traversal, symlink, and case collisions."""
    destination.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    try:
        with zipfile.ZipFile(archive) as handle:
            for member in handle.infolist():
                target = _safe_member_path(destination, member.filename)
                key = target.relative_to(destination).as_posix().casefold()
                if key in seen:
                    raise PackageError(f"Electron ZIP contains a duplicate member: {member.filename!r}")
                seen.add(key)

                mode = (member.external_attr >> 16) & 0o170000
                if mode == 0o120000:
                    raise PackageError(f"Refusing symlink in Electron ZIP: {member.filename!r}")
                if member.is_dir() or member.filename.replace("\\", "/").endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with handle.open(member, "r") as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
    except zipfile.BadZipFile as exc:
        raise PackageError(f"Electron asset is not a valid ZIP: {archive}") from exc
    except OSError as exc:
        raise PackageError(f"Cannot extract Electron asset {archive}: {exc}") from exc


def copy_allowed_tree(source: Path, destination: Path) -> None:
    """Copy an allowlisted source directory without following symlinks."""
    if not source.is_dir() or source.is_symlink():
        raise PackageError(f"Required app directory is missing or unsafe: {source}")
    destination.mkdir(parents=True, exist_ok=True)
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part.startswith('.') or part == '__pycache__' for part in relative.parts):
            continue
        if path.is_symlink():
            raise PackageError(f"Refusing symlink in app source: {path}")
        if path.is_file() and path.suffix in RUNTIME_EXTENSIONS:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def copy_allowed_app(root: Path, app_root: Path, version: str) -> None:
    """Copy exactly the runtime files needed by Electron."""
    app_root.mkdir(parents=True, exist_ok=True)
    for name in ("main.cjs", "LICENSE"):
        source = root / name
        if not source.is_file() or source.is_symlink():
            raise PackageError(f"Required app file is missing or unsafe: {source}")
        shutil.copy2(source, app_root / name)
    for name in ("lib", "public"):
        copy_allowed_tree(root / name, app_root / name)

    runtime_package = {
        "name": "karaoke-live",
        "productName": "Karaoke Live",
        "version": version,
        "private": True,
        "type": "module",
        "main": "main.cjs",
        "license": "MIT",
    }
    (app_root / "package.json").write_text(
        json.dumps(runtime_package, indent=2) + "\n", encoding="utf-8"
    )


def zip_directory(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix='karaoke-windows-', suffix='.zip', dir=output.parent, delete=False) as handle:
        pending = Path(handle.name)
    try:
        with zipfile.ZipFile(pending, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(source.rglob("*")):
                if path.is_symlink():
                    raise PackageError(f"Refusing symlink in Windows package: {path}")
                if path.is_file():
                    archive.write(path, path.relative_to(source).as_posix())
        pending.replace(output)
    finally:
        pending.unlink(missing_ok=True)


def build(
    *,
    root: Path = ROOT,
    output: Path | None = None,
    electron_zip: Path | None = None,
    checksums: Path | None = None,
) -> tuple[Path, str]:
    """Build and return ``(ZIP path, verified Electron SHA-256)``."""
    version, electron_version = read_package(root)
    archive_name, archive_url, checksum_url = release_names(electron_version)
    output = (output or root / "dist" / f"KaraokeLive-{version}-windows-x64.zip").expanduser().resolve()
    if output.suffix.lower() != '.zip':
        raise PackageError('Choose a .zip file for the Windows package.')

    with tempfile.TemporaryDirectory(prefix="karaoke-windows-") as temporary:
        temporary_root = Path(temporary)
        archive = electron_zip.expanduser().resolve() if electron_zip else temporary_root / archive_name
        manifest = checksums.expanduser().resolve() if checksums else temporary_root / "SHASUMS256.txt"
        if electron_zip is None:
            download(archive_url, archive)
        if checksums is None:
            download(checksum_url, manifest)
        verified_hash = verify_electron_zip(archive, manifest, archive_name)

        electron_root = temporary_root / "electron"
        safe_extract(archive, electron_root)
        electron_exe = electron_root / "electron.exe"
        resources = electron_root / "resources"
        if not electron_exe.is_file() or not resources.is_dir():
            raise PackageError("Official Electron ZIP is missing electron.exe or resources/.")

        package_root = temporary_root / "package"
        package_root.mkdir(parents=True, exist_ok=True)
        for entry in sorted(electron_root.iterdir(), key=lambda item: item.name.casefold()):
            if entry.name.casefold() == "electron.exe":
                shutil.copy2(entry, package_root / "Karaoke Live.exe")
            elif entry.is_dir():
                shutil.copytree(entry, package_root / entry.name, symlinks=False)
            elif entry.is_file():
                shutil.copy2(entry, package_root / entry.name)
            else:
                raise PackageError(f"Unsupported Electron runtime entry: {entry}")

        app_root = package_root / "resources" / "app"
        copy_allowed_app(root, app_root, version)
        shutil.copy2(root / 'README.md', package_root / 'Karaoke Live README.md')
        zip_directory(package_root, output)

    return output, verified_hash


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--electron-zip",
        type=Path,
        help="Use a local pinned Electron ZIP instead of downloading the official asset.",
    )
    parser.add_argument(
        "--checksums",
        type=Path,
        help="Use a local SHASUMS256.txt instead of downloading Electron's official manifest.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="Output ZIP path (default: dist/KaraokeLive-<app-version>-windows-x64.zip).",
    )
    args = parser.parse_args(argv)
    try:
        output, digest = build(
            output=args.out,
            electron_zip=args.electron_zip,
            checksums=args.checksums,
        )
    except PackageError as exc:
        print(f"package-windows: {exc}", file=sys.stderr)
        return 2
    print(f"{output}\nElectron SHA-256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
