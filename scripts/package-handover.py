#!/usr/bin/env python3
"""Export a reviewable source snapshot and optional private local backup.

No network, no Git mutation, no generation. Never merge into an existing export.
The source and backup have separate roots; only the source is suitable for Git.
"""
from __future__ import annotations
import argparse
import csv
from contextlib import closing
import datetime as dt
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import zipfile

SOURCE = Path(__file__).resolve().parents[1]
MANIFEST_DIR = Path('docs/交接/清单')


def excluded(path):
    parts = path.parts
    if any(p in {'.git', '__pycache__', '.DS_Store', 'node_modules'} for p in parts):
        return '版本库、缓存或本机依赖'
    if parts[:2] in {('data','runtime'), ('data','portable-runtime'), ('docs','qa')}:
        return '本地私有运行数据或历史实测证据'
    if parts and parts[0] == 'dist':
        return '本机生成的安装产物'
    if path.name == 'connections.json' or path.name.startswith('.env') or path.suffix in {'.pyc','.pyo','.log','.sqlite3','.pem','.key'} or path.name.endswith(('-wal','-shm')):
        return '密钥、数据库或派生文件'
    return ''


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def known_secrets(source):
    path = source/'data/runtime/connections.json'
    found = []
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if isinstance(item,str) and len(item)>=12 and re.search('key|token|secret|password',key,re.I):
                    found.append(item.encode())
                else: visit(item)
        elif isinstance(value,list):
            for item in value: visit(item)
    if path.exists(): visit(json.loads(path.read_text()))
    return found


def scan_release(root, secrets):
    patterns = [rb'(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}',
                rb'github_pat_[A-Za-z0-9_]{40,}',
                rb'sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}',
                rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----']
    findings = []
    def scan(data, label):
        if any(s in data for s in secrets) or any(re.search(p,data) for p in patterns):
            findings.append(label)  # Never print matching bytes.
    for path in sorted(root.rglob('*')):
        if not path.is_file() or '.git' in path.relative_to(root).parts: continue
        scan(path.read_bytes(), str(path.relative_to(root)))
        if path.suffix.lower()=='.zip':
            with zipfile.ZipFile(path) as archive:
                for name in archive.namelist(): scan(archive.read(name), str(path.relative_to(root))+'!'+name)
    if findings: raise RuntimeError('发布扫描发现疑似凭据，仅报告路径：'+', '.join(findings))


def inventory(root):
    rows=[]
    for path in sorted(root.rglob('*')):
        if not path.is_file(): continue
        rel=path.relative_to(root)
        if '.git' in rel.parts or rel.is_relative_to(MANIFEST_DIR): continue
        rows.append({'path':str(rel),'category':rel.parts[0] if len(rel.parts)>1 else '根目录',
                     'bytes':path.stat().st_size,'sha256':digest(path)})
    dest=root/MANIFEST_DIR
    dest.mkdir(parents=True,exist_ok=True)
    summary={'createdAt':dt.datetime.now().astimezone().isoformat(),'fileCount':len(rows),
             'totalBytes':sum(r['bytes'] for r in rows),'excludedFromHashing':'清单自身与 .git 元数据；避免自引用',
             'files':rows}
    write_json(dest/'全部文件清单.json',summary)
    with (dest/'全部文件清单.csv').open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=['path','category','bytes','sha256'])
        writer.writeheader();writer.writerows(rows)
    (dest/'README.md').write_text('# 逐文件清单\n\n清单列出源码发布包内全部普通文件的相对路径、分类、字节数和 SHA-256；仅排除本清单目录与 `.git` 元数据，以避免自引用。私有运行备份有独立校验文件，不在此范围。\n\n校验：在源码根目录运行 `python3 scripts/package-handover.py --verify .`。\n',encoding='utf-8')
    return summary


def verify(root):
    manifest=json.loads((root/MANIFEST_DIR/'全部文件清单.json').read_text())
    expected={r['path'] for r in manifest['files']}
    failures=[]
    for row in manifest['files']:
        path=root/row['path']
        if not path.is_file() or path.stat().st_size!=row['bytes'] or digest(path)!=row['sha256']: failures.append(row['path'])
    actual={str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()
            and '.git' not in p.relative_to(root).parts and not p.relative_to(root).is_relative_to(MANIFEST_DIR)
            and '__pycache__' not in p.relative_to(root).parts and p.name!='.DS_Store'}
    failures += ['unexpected:'+p for p in sorted(actual-expected)]
    if failures: raise RuntimeError('校验失败：'+', '.join(failures))
    return {'verifiedFiles':len(expected),'totalBytes':manifest['totalBytes'],'result':'passed'}


def backup_private(source, private):
    private.mkdir(mode=0o700)
    started=dt.datetime.now().astimezone().isoformat()
    checks={}
    for src,dst in [(source/'data/runtime',private/'runtime'), (source/'data/portable-runtime',private/'portable-runtime'), (source/'docs/qa',private/'historical-qa'), (source/'dist',private/'local-build')]:
        if not src.exists(): continue
        for path in sorted(src.rglob('*')):
            rel=path.relative_to(src); target=dst/rel
            if path.is_symlink(): raise RuntimeError('备份不跟随符号链接：'+str(rel))
            if not path.is_file() or path.name.endswith(('-wal','-shm')) or path.name in {'.service.lock','.DS_Store'}: continue
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            if path.suffix=='.sqlite3':
                with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as origin, closing(sqlite3.connect(target)) as out:
                    origin.backup(out)
                    result=out.execute('PRAGMA integrity_check').fetchone()[0]
                    if result!='ok': raise RuntimeError('SQLite integrity check failed: '+str(rel))
                    checks[str(target.relative_to(private))]=result
            else: shutil.copy2(path,target)
    write_json(private/'备份说明.json',{'startedAt':started,'finishedAt':dt.datetime.now().astimezone().isoformat(),
        'databaseChecks':checks,'source':str(source),'containsCredentials':(private/'runtime/connections.json').exists(),
        'consistency':'SQLite backup API 数据库一致性快照；运行文件在复制期间保存，不是停机全盘快照。',
        'notIncluded':['浏览器未同步 localStorage/sessionStorage','供应商远程媒体实际文件（除非源目录已存在）','Codex 登录凭据']})
    rows=[{'path':str(p.relative_to(private)),'bytes':p.stat().st_size,'sha256':digest(p)} for p in sorted(private.rglob('*')) if p.is_file()]
    write_json(private/'私有文件校验.json',rows)
    for path in private.rglob('*'): path.chmod(0o700 if path.is_dir() or path.stat().st_mode & 0o100 else 0o600)
    private.chmod(0o700)
    return len(rows)


def package(destination, include_private):
    destination=destination.expanduser().resolve()
    if destination.exists(): raise SystemExit('目标已存在，为避免覆盖请换一个新目录。')
    if destination.is_relative_to(SOURCE): raise SystemExit('交付目录必须位于源码目录之外，避免递归复制。')
    destination.mkdir(parents=True,mode=0o700)
    public=destination/'01_源码与资源';public.mkdir()
    omitted=[]
    for path in sorted(SOURCE.rglob('*')):
        rel=path.relative_to(SOURCE)
        reason=excluded(rel)
        if reason:
            if path.is_file():omitted.append({'path':str(rel),'reason':reason})
            continue
        if path.is_symlink(): raise RuntimeError('发布包不跟随符号链接：'+str(rel))
        if path.is_file():
            target=public/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,target)
    scan_release(public,known_secrets(SOURCE))
    stats=inventory(public)
    private_files=backup_private(SOURCE,destination/'02_本地私有数据备份') if include_private else 0
    if include_private:
        write_json(destination/'02_本地私有数据备份/发布排除记录.json',omitted)
        (destination/'02_本地私有数据备份/发布排除记录.json').chmod(0o600)
        private_root=destination/'02_本地私有数据备份'
        private_rows=[{'path':str(p.relative_to(private_root)),'bytes':p.stat().st_size,'sha256':digest(p)} for p in sorted(private_root.rglob('*')) if p.is_file() and p.name!='私有文件校验.json']
        write_json(private_root/'私有文件校验.json',private_rows)
        private_files=len(private_rows)
    page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>庞巴迪影视工作台 · 交付入口</title><style>body{margin:0;background:#f3f1ec;color:#292e35;font:16px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:960px;margin:60px auto;padding:30px}img{width:100%;max-height:360px;object-fit:cover;border-radius:24px}h1{font-size:30px;font-weight:600}a{color:#2d5c68}section{padding:24px;background:#ffffffbf;border:1px solid white;border-radius:20px;margin-top:20px}.button{display:inline-block;padding:12px 24px;background:#203f48;color:white;text-decoration:none;border-radius:12px}small{color:#707780}</style><main><img src="01_源码与资源/assets/projects/lighthouse-cover.webp" alt="灯塔案例"><small>2026-10-25 · 项目交接快照</small><h1>庞巴迪影视工作台</h1><p>从团队角色、影视制作流程，到代码、素材和本机运行备份。</p><a class="button" href="01_源码与资源/docs/交接/00_交付导航.html">打开完整 SOP 与操作手册</a><section><b>01 · 源码与资源</b><p>可推送至 GitHub 的项目源码、21 岗位提示词、视觉素材、设计历史与测试。便携启动：双击 <a href="01_源码与资源/scripts/start-portable.command">start-portable.command</a>，然后访问 http://127.0.0.1:8768/。</p><a href="https://github.com/itawjh-lgtm/pangbadi-film-workbench">GitHub 私有仓库</a></section><section><b>02 · 本地私有数据备份</b><p>包含项目数据库、运行记录、连接密钥和历史实测证据，仅在本地保存。不要上传这一目录。恢复步骤见完整手册第 06 节。</p></section><p>原工作台仍使用 8767；本交付包是快照，不会自动同步后续修改。远程媒体链接不等于离线媒体备份。</p></main></html>'''
    (destination/'00_从这里开始.html').write_text(page,encoding='utf-8')
    print(json.dumps({'destination':str(destination),'publicFiles':stats['fileCount'],'publicBytes':stats['totalBytes'],
                      'privateFiles':private_files,'validation':verify(public)},ensure_ascii=False))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--destination',type=Path)
    group.add_argument('--verify',type=Path)
    parser.add_argument('--include-private',action='store_true',help='另存本地私有数据，包含密钥；不应推送到Git')
    args=parser.parse_args()
    if args.verify: print(json.dumps(verify(args.verify.resolve()),ensure_ascii=False))
    else: package(args.destination,args.include_private)

if __name__=='__main__': main()
