#!/usr/bin/env python3
"""Install the reviewed local app in ~/Applications, retaining an older copy."""
from pathlib import Path
import datetime
import json
import plistlib
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = "cn.dreamstudio.workbench"


def install():
    source = ROOT / "dist/造梦工作室.app"
    with (source / "Contents/Info.plist").open("rb") as f:
        if plistlib.load(f).get("CFBundleIdentifier") != IDENTIFIER:
            raise ValueError("构建产物身份不匹配。")
    folder = Path.home() / "Applications"
    folder.mkdir(exist_ok=True)
    target = folder / source.name
    if target.exists():
        if target.is_symlink():
            raise ValueError("安装位置是符号链接，已保留原应用。")
        with (target / "Contents/Info.plist").open("rb") as f:
            if plistlib.load(f).get("CFBundleIdentifier") != IDENTIFIER:
                raise ValueError("安装位置存在另一款应用，未替换。")
    staged = folder / (".dream-studio-install-" + uuid.uuid4().hex + ".app")
    backup = None
    try:
        # Copy file contents/modes, not FileProvider/Finder extended metadata.
        shutil.copytree(source, staged, copy_function=shutil.copy)
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", str(staged)], check=True)
        if target.exists():
            backup_folder = folder / "造梦工作室旧版本"
            backup_folder.mkdir(exist_ok=True)
            backup = backup_folder / ("造梦工作室-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ".app")
            target.rename(backup)
        try:
            staged.rename(target)
            subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", str(target)], check=True)
        except Exception:
            if target.exists():
                target.rename(folder / (".dream-studio-failed-" + uuid.uuid4().hex + ".app"))
            if backup:
                backup.rename(target)
            raise
        return {"app": str(target), "backup": str(backup) if backup else None, "signature": "ad-hoc", "notarized": False}
    finally:
        if staged.exists():
            shutil.rmtree(staged)


if __name__ == "__main__":
    print(json.dumps(install(), ensure_ascii=False))
