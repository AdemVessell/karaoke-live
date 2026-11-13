#!/usr/bin/env python3
"""Create a reviewable source archive without private runtime artifacts."""
from pathlib import Path
import argparse
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {"README.md", "VALIDATION.md", "LICENSE", ".gitignore", "package.json", "package-lock.json", "main.cjs", "build-app.py"}
SOURCE_DIRS = {"public", "lib", "scripts", "tests"}
SOURCE_EXTENSIONS = {".js", ".mjs", ".cjs", ".html", ".css", ".py", ".svg"}

def included(path: Path) -> bool:
    if path.is_symlink() or not path.is_file(): return False
    relative = path.relative_to(ROOT)
    if len(relative.parts) == 1: return path.name in ROOT_FILES
    return relative.parts[0] in SOURCE_DIRS and path.suffix in SOURCE_EXTENSIONS and not any(part.startswith('.') or part == '__pycache__' for part in relative.parts)

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "karaoke-live-source.zip")
    args = parser.parse_args()
    target = args.out.expanduser().resolve(); target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists(): target.unlink()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(ROOT.rglob("*")):
            if included(path): archive.write(path, path.relative_to(ROOT).as_posix())
    print(target)

if __name__ == "__main__": main()
