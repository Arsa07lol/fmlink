"""Copies the files that belong in the public GitHub repo into another folder.

    python tools/stage_github.py <dest>

Only the paths in PUBLIC are copied. CLAUDE.md (private notes), the raw
recordings in results/ and Python caches stay here. <dest> must be outside
this project folder: an empty folder to drag into GitHub's "Upload files"
page, or a git clone of the repo.
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = [
    "README.md", "index.html", ".nojekyll", ".gitignore",
    "fmlink_uno", "fmlink_tx", "fmlink_rx", "python/fmlink.py",
    "tools", "web", "photos",
]
NEVER = {"CLAUDE.md"}
SKIP_DIRS = {"__pycache__", ".git"}


def public_files():
    for item in PUBLIC:
        p = ROOT / item
        if p.is_file():
            yield p
        elif p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file() and not SKIP_DIRS.intersection(f.relative_to(ROOT).parts):
                    yield f
        else:
            sys.exit(f"missing: {item}")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dest = Path(sys.argv[1]).resolve()
    if dest == ROOT or ROOT in dest.parents:
        sys.exit("dest must be outside the project folder")
    n = size = 0
    for f in public_files():
        rel = f.relative_to(ROOT)
        if rel.name in NEVER:
            sys.exit(f"refusing to copy {rel}")
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, out)
        n += 1
        size += f.stat().st_size
        print(rel.as_posix())
    print(f"{n} files, {size / 1024:.0f} KB -> {dest}")


if __name__ == "__main__":
    main()
