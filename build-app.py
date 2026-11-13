#!/usr/bin/env python3
"""Build a portable macOS app bundle without embedding the development path."""
from pathlib import Path
import argparse
import plistlib
import shutil
import subprocess
import json

ROOT = Path(__file__).resolve().parent

def copy_tree(source: Path, target: Path) -> None:
    shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True)

def build(output: Path) -> Path:
    source_app = ROOT / "node_modules" / "electron" / "dist" / "Electron.app"
    if not source_app.exists():
        raise SystemExit("Electron is not installed. Run npm ci in karaoke first.")
    output = output.expanduser().resolve()
    if output.suffix != '.app':
        raise SystemExit('Output must be a dedicated .app bundle path.')
    if output == Path.home() / "Desktop" / "Karaoke Live.app":
        raise SystemExit("Refusing to overwrite the Desktop working app; choose a dist output path.")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        try:
            with (output / 'Contents' / 'Info.plist').open('rb') as handle:
                existing = plistlib.load(handle)
            if existing.get('CFBundleIdentifier') != 'org.stevenson.karaoke-live':
                raise ValueError('unrelated application')
        except (OSError, ValueError, plistlib.InvalidFileException):
            raise SystemExit('Refusing to overwrite an unrelated path or application.')
        shutil.rmtree(output)
    shutil.copytree(source_app, output, symlinks=True)

    info_path = output / "Contents" / "Info.plist"
    with info_path.open("rb") as handle:
        info = plistlib.load(handle)
    info.update(CFBundleIdentifier="org.stevenson.karaoke-live", CFBundleName="Karaoke Live", CFBundleDisplayName="Karaoke Live", CFBundleExecutable="Karaoke Live", CFBundleVersion="0.2.0", CFBundleShortVersionString="0.2.0", NSCameraUsageDescription="Show your camera in your karaoke performance when you enable it.", NSMicrophoneUsageDescription="Process your microphone for your karaoke performance when you enable it.")
    with info_path.open("wb") as handle:
        plistlib.dump(info, handle)

    executable = output / "Contents" / "MacOS" / "Electron"
    if executable.exists():
        executable.rename(executable.with_name("Karaoke Live"))

    resources = output / "Contents" / "Resources" / "app"
    resources.mkdir(parents=True, exist_ok=True)
    for name in ("main.cjs", "lib", "public", "LICENSE"):
        source = ROOT / name
        if source.is_dir(): copy_tree(source, resources / name)
        elif source.is_file(): shutil.copy2(source, resources / name)
    package = {"name": "karaoke-live", "productName": "Karaoke Live", "version": "0.2.0", "main": "main.cjs", "private": True, "license": "MIT"}
    (resources / "package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(output)], check=True, capture_output=True)
    return output

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "KaraokeLive.app")
    args = parser.parse_args()
    print(build(args.out))

if __name__ == "__main__":
    main()
