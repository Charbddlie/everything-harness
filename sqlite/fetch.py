"""Refresh the bundled official SQLite shells (standard library only)."""

import hashlib
from io import BytesIO
import json
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile


VERSION = "3.53.4"
PACKAGES = {
    "linux-x64": ("linux-x64", "6eeb57e8f2aef7687f9f016a980992cf2799c8c07a87c5e21495530f91915047"),
    "macos-arm64": ("osx-arm64", "58d53e0eb69c17cabebed2754bf399e4d44939be42dcf194769c00078bfd776d"),
    "macos-x64": ("osx-x64", "3353bb4e5ac54f85c5b82012d30476d20539a9495abdd11a1707df578cff2d7e"),
    "windows-arm64": ("win-arm64", "0c99da3702b2517c1d738207db7e945e5c55be7748141a192a1c8f3b4455c44b"),
    "windows-x64": ("win-x64", "88b4659fe747896b853af10157316b4ade143553efb89c1c8ca7423a278dcc8b"),
}


def main() -> None:
    root = Path(__file__).resolve().parent
    manifest = {}
    for platform, (package, expected) in PACKAGES.items():
        url = f"https://www.sqlite.org/2026/sqlite-tools-{package}-3530400.zip"
        print(f"Downloading {platform} ...", flush=True)
        with urlopen(url, timeout=60) as response:
            archive = response.read()
        if hashlib.sha3_256(archive).hexdigest() != expected:
            raise ValueError(f"Archive checksum mismatch: {url}")
        name = "sqlite3.exe" if platform.startswith("windows") else "sqlite3"
        with ZipFile(BytesIO(archive)) as bundle:
            member, = [entry for entry in bundle.namelist() if entry.split("/")[-1] == name]
            binary = bundle.read(member)
        target = root / platform / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(binary)
        target.chmod(0o755)
        manifest[target.relative_to(root).as_posix()] = {
            "version": VERSION,
            "url": url,
            "archive_sha3_256": expected,
            "sha256": hashlib.sha256(binary).hexdigest(),
        }
    (root / "checksums.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
