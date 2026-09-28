"""Create the project venv and run the installer with its Python."""

import hashlib
import os
from pathlib import Path
import subprocess
import sys
import venv


def main() -> int:
    if sys.version_info < (3, 10):
        print("Python 3.10+ is required.", file=sys.stderr)
        return 1

    root = Path(__file__).resolve().parent.parent
    environment = root / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        print("Creating .venv ...", flush=True)
        venv.EnvBuilder(with_pip=True).create(environment)

    requirements = root / "requirements.txt"
    fingerprint = hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker = environment / ".requirements.sha256"
    ready = marker.is_file() and marker.read_text().strip() == fingerprint
    if ready:
        ready = subprocess.run(
            [str(python), "-c", "import textual, sqlite3"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode == 0
    if not ready:
        subprocess.run(
            [str(python), "-m", "pip", "install", "--disable-pip-version-check",
             "-r", str(requirements)], check=True,
        )
        marker.write_text(fingerprint + "\n")

    return subprocess.call([str(python), "-m", "tui", *sys.argv[1:]], cwd=root)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"Setup failed: {error}", file=sys.stderr)
        raise SystemExit(1)
