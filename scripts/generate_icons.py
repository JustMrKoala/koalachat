import shutil
from pathlib import Path


def sync_logo():
    root = Path(__file__).parent.parent
    src = root / "logo.png"
    dst = root / "frontend" / "icons" / "logo.png"
    if not src.exists():
        print("logo.png not found at project root.")
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f"Synced logo to {dst}")


if __name__ == "__main__":
    sync_logo()