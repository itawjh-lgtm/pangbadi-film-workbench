#!/usr/bin/env python3
"""Build a local-use, ad-hoc signed AppKit client without downloading dependencies."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DESKTOP = PROJECT_ROOT / 'desktop'
APP_NAME = '造梦工作室'
IDENTIFIER = 'cn.dreamstudio.workbench'
DEFAULT_PYTHON = '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3'
CACHE = Path('/tmp/dream-studio-module-cache')


def run(args: list[str | Path]) -> str:
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f'命令失败（{result.returncode}）：{args[0]}\n{result.stdout}{result.stderr}')
    return (result.stdout + result.stderr).strip()


def verify(app: Path) -> dict:
    plist_path = app / 'Contents/Info.plist'
    run(['/usr/bin/plutil', '-lint', plist_path])
    with plist_path.open('rb') as stream:
        plist = plistlib.load(stream)
    if plist.get('CFBundleIdentifier') != IDENTIFIER or plist.get('CFBundleExecutable') != 'DreamStudio':
        raise RuntimeError('应用标识与可执行文件声明不一致。')
    run(['/usr/bin/codesign', '--verify', '--strict', '--verbose=2', app])
    signature = run(['/usr/bin/codesign', '--display', '--verbose=2', '--requirements', '-', app])
    if f'Identifier={IDENTIFIER}' not in signature or 'Signature=adhoc' not in signature:
        raise RuntimeError('签名检查未得到预期的本机 ad-hoc 标识。')
    if f'designated => identifier "{IDENTIFIER}"' not in signature:
        raise RuntimeError('客户端持久身份要求不匹配，暂不替换已有客户端。')
    return {'bundleIdentifier': IDENTIFIER, 'signature': 'ad-hoc', 'notarized': False, 'minimumMacOS': plist['LSMinimumSystemVersion']}


def build(python: str, port: int) -> dict:
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise RuntimeError('当前本机构建面向 Apple Silicon Mac（arm64）。')
    executable = Path(python).expanduser()
    if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError('Python 可执行路径无效；请通过 --python 指定绝对路径。')
    if not 1024 <= port <= 65535:
        raise RuntimeError('端口必须在 1024–65535 之间。')
    for source in ['Info.plist', 'Sources/StudioApp.swift', 'Sources/DrawIcon.swift', 'service_manager.py']:
        if not (DESKTOP / source).is_file():
            raise RuntimeError(f'缺少构建源文件：{source}')
    if not (PROJECT_ROOT / 'server/httpd.py').is_file():
        raise RuntimeError('未找到工作台本机执行服务。')

    dist = PROJECT_ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    target = dist / f'{APP_NAME}.app'
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        raise RuntimeError('目标路径不是普通应用目录，已保留原文件。')
    staged = dist / f'.{APP_NAME}-build-{uuid.uuid4().hex}.app'
    CACHE.mkdir(exist_ok=True)
    backup = None
    try:
        resources = staged / 'Contents/Resources'
        binaries = staged / 'Contents/MacOS'
        resources.mkdir(parents=True); binaries.mkdir()
        shutil.copyfile(DESKTOP / 'Info.plist', staged / 'Contents/Info.plist')
        config = {'projectRoot': str(PROJECT_ROOT), 'pythonExecutable': str(executable), 'port': port, 'backendVersion': '0.6', 'onlineURL': 'https://pangbadi-film-workbench.zainabadenike433.chatgpt.site'}
        (resources / 'DesktopConfig.json').write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (resources / 'LOCAL-CLIENT.txt').write_text(
            '本机客户端：页面、执行服务和项目数据仍保存在原项目目录。\n'
            f'请保留：{PROJECT_ROOT}\n'
            '当前使用 ad-hoc 本机签名，未做开发者签名或 Apple 公证。\n', encoding='utf-8')
        (staged / 'Contents/PkgInfo').write_bytes(b'APPL????')
        compiler = ['/usr/bin/xcrun', 'swiftc', '-parse-as-library', '-target', 'arm64-apple-macosx12.0', '-module-cache-path', CACHE]
        print('编译原生客户端…', flush=True)
        run(compiler + ['-O', '-framework', 'AppKit', '-framework', 'WebKit', DESKTOP / 'Sources/StudioApp.swift', '-o', binaries / 'DreamStudio'])
        with tempfile.TemporaryDirectory(prefix='dream-studio-icon-', dir='/tmp') as temporary:
            temp = Path(temporary)
            renderer = temp / 'DrawIcon'
            print('绘制本机图标…', flush=True)
            run(compiler + ['-O', '-framework', 'AppKit', DESKTOP / 'Sources/DrawIcon.swift', '-o', renderer])
            iconset = temp / 'AppIcon.iconset'
            run([renderer, iconset])
            run(['/usr/bin/iconutil', '-c', 'icns', iconset, '-o', resources / 'AppIcon.icns'])
        print('本机签名与结构检查…', flush=True)
        # Clear metadata only on this freshly generated staging bundle. Finder
        # may attach metadata while a new .app is being indexed, so retry only
        # this specific local-signing error; unrelated signing failures surface.
        for attempt in range(3):
            run(['/usr/bin/xattr', '-cr', staged])
            try:
                # A constant requirement preserves local identity across builds;
                # this is not a Developer ID signature or Apple notarization.
                run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', IDENTIFIER,
                     '--requirements', f'=designated => identifier "{IDENTIFIER}"', staged])
                break
            except RuntimeError as error:
                if 'resource fork, Finder information' not in str(error) or attempt == 2:
                    raise
                time.sleep(0.2 * (attempt + 1))
        validation = verify(staged)
        if target.exists():
            backups = dist / 'backups'
            backups.mkdir(exist_ok=True)
            stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
            backup = backups / f'{APP_NAME}-{stamp}-{uuid.uuid4().hex[:6]}.app'
            target.rename(backup)
        try:
            staged.rename(target)
            verify(target)
        except Exception:
            # Leave a recoverable failed build and restore the previous app path.
            if target.exists():
                target.rename(dist / f'.failed-{APP_NAME}-{uuid.uuid4().hex}.app')
            if backup and backup.exists():
                backup.rename(target)
            raise
        result = {'ok': True, 'app': str(target), 'backup': str(backup) if backup else None,
                  'projectRoot': str(PROJECT_ROOT), 'architecture': 'arm64', **validation}
        (dist / 'build-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        return result
    finally:
        if staged.exists():
            shutil.rmtree(staged)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', default=DEFAULT_PYTHON, help='本机后端 Python 的绝对可执行路径')
    parser.add_argument('--port', type=int, default=8767)
    args = parser.parse_args()
    try:
        result = build(args.python, args.port)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
