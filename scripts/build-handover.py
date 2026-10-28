#!/usr/bin/env python3
"""Render the Chinese handover manual as an offline HTML reading page.

Requires the optional build dependency `markdown` (Python-Markdown).
The app itself does not depend on this renderer.
"""
from pathlib import Path
import html
import json
import re
import markdown

ROOT=Path(__file__).resolve().parents[1]
DOCS=ROOT/'docs/交接'
FILES=[
 '01_项目现状与完成边界.md','02_影视制作SOP.md','03_用户操作手册.md',
 '04_技术架构与开发维护.md','05_全部元素与素材清单.md',
 '06_部署备份与恢复.md','07_验证记录与待办.md','08_本次整理与下载导航.md'
]


def main():
    missing=[name for name in FILES if not (DOCS/name).is_file()]
    if missing:raise SystemExit('缺少交接文档：'+', '.join(missing))
    sections=[];navigation=[]
    for i,name in enumerate(FILES,1):
        text=(DOCS/name).read_text()
        title=text.splitlines()[0].lstrip('# ').strip()
        rendered=markdown.markdown(text,extensions=['tables','fenced_code','sane_lists'])
        for j,other in enumerate(FILES,1):
            rendered=rendered.replace(f'href="{other}"',f'href="#chapter-{j}"')
        navigation.append(f'<a href="#chapter-{i}">{html.escape(title)}</a>')
        sections.append(f'<section id="chapter-{i}" class="chapter">{rendered}<p class="source"><a href="{html.escape(name)}">查看 Markdown 源文档</a></p></section>')
    employees=json.JSONDecoder().raw_decode(re.search(r'TEAM_EMPLOYEES\s*=\s*(.*)',(ROOT/'data/employees.js').read_text(),re.S).group(1))[0]
    portraits=''.join(f'<figure><img loading="lazy" src="../../{html.escape(e["thumb"])}" alt="{html.escape(e["name"])}"><figcaption>{html.escape(e["name"])}<small>{html.escape(e["id"])}</small></figcaption></figure>' for e in employees)
    css='''*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f0f1ed;color:#263137;font:15px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}a{color:#28626d;text-underline-offset:4px}aside{position:fixed;left:0;top:0;bottom:0;width:250px;padding:34px 24px;background:#f8f9f5df;border-right:1px solid #dde2dc;overflow:auto;backdrop-filter:blur(18px)}aside b{font-size:17px;display:block;margin-bottom:28px}aside a{display:block;text-decoration:none;color:#56666c;padding:10px 0;font-size:13px}main{max-width:1260px;margin:0 auto 0 250px;padding:40px 5vw 90px}.hero{position:relative;background:#162d31;border-radius:24px;overflow:hidden;color:white;min-height:330px;display:flex;align-items:end}.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.7}.hero div{position:relative;padding:36px;background:linear-gradient(transparent,#142b3ce0);width:100%}.hero h1{font-size:30px;margin:0;font-weight:600;letter-spacing:.03em}.hero p{color:#eef5f3}.tags{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}.tags span{background:#ffffffb8;border:1px solid white;border-radius:12px;padding:10px 16px;color:#56666c}.intro,.chapter,.gallery{background:#ffffffbf;border:1px solid #fff;border-radius:22px;padding:30px;margin:24px 0;box-shadow:0 12px 40px #26313704}.chapter{scroll-margin-top:24px}.chapter h1{font-size:25px;font-weight:600;margin-top:0}.chapter h2{font-size:20px;margin-top:32px}.chapter h3{font-size:17px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f1;border-radius:10px;padding:18px;font-size:13px;line-height:1.7}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:#e9eeeb;padding:1px 4px;border-radius:3px}pre code{background:none;padding:0}table{width:100%;border-collapse:collapse;font-size:13px;display:block;overflow-x:auto}th,td{text-align:left;border-bottom:1px solid #dce3de;padding:10px;vertical-align:top;min-width:100px}th{background:#edf2ee}blockquote{margin:20px 0;border-left:3px solid #7b9c94;padding:4px 20px;color:#536761}li{margin:6px 0}.source{font-size:12px;border-top:1px solid #e4e9e4;padding-top:20px}.portraits{display:grid;grid-template-columns:repeat(7,1fr);gap:12px}figure{margin:0}figure img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:14px}figcaption{text-align:center;font-size:12px;padding:6px}small{display:block;color:#7e908d}.gallery h2{font-size:20px;margin-top:0}.foot{font-size:13px;color:#788782}@media(max-width:1000px){aside{position:static;width:auto;height:auto;border:0;padding:20px}aside b{margin:0}aside nav{display:flex;flex-wrap:wrap;gap:10px}aside a{padding:4px}main{margin:0;padding:18px}.portraits{grid-template-columns:repeat(4,1fr)}.chapter{padding:20px}.hero h1{font-size:26px}}@media print{aside,.hero,.gallery{display:none}main{margin:0;padding:0}.chapter{box-shadow:none;border-radius:0;page-break-before:always}body{background:white}a{color:inherit}}'''
    page='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>夏夏工作台 · SOP 与操作手册</title><style>'+css+'</style></head><body><aside><b>夏夏工作台<br><small>交接阅读入口 · 2026.10.29</small></b><nav>'+''.join(navigation)+'</nav><a href="清单/全部文件清单.csv">逐文件素材 / 代码清单 ↗</a><a href="https://github.com/itawjh-lgtm/pangbadi-film-workbench">GitHub 公开仓库 ↗</a><a href="https://pangbadi-film-workbench.zainabadenike433.chatgpt.site">历史云端入口（本轮未复验）↗</a></aside><main><header class="hero"><img src="../../assets/projects/lighthouse-cover.webp" alt="灯塔案例"><div><p>项目交接 · 截至 2026 年 10 月 29 日</p><h1>从一个想法，到一支创作团队。</h1><p>本机工作台与云端试用的当前能力、制作 SOP、操作手册、资源与代码，一次交接。</p></div></header><div class="tags"><span>21 位伙伴</span><span>16 影视 + 5 游戏岗位</span><span>25 份岗位原文</span><span>本机工作台 + 独立云端源码</span><span>Mac 客户端源码</span></div><div class="intro"><b>先选择入口，再开始操作。</b><p>日常原工作台在 8767；下载源码后使用便携模式 8768。先阅读下载导航，再按操作手册配置自己的执行器和 RunningHub Key。GitHub 保存源码、视觉素材、提示词与文档；本机私人项目、参考图和密钥留在本地。online/ 是独立云端源码，本次代码整理不执行线上部署，也不代表两端功能同步。本轮测试使用模拟提供者，没有付费生成。</p><a href="#chapter-3">我想直接看操作手册 →</a></div><section class="gallery"><h2>团队伙伴与人物资源</h2><div class="portraits">'+portraits+'</div></section>'+''.join(sections)+'<p class="foot">这是一份本地可浏览的交接文档，支持浏览器打印为 PDF。读取本文不会调用模型或启动付费生成。</p></main></body></html>'
    (DOCS/'00_交付导航.html').write_text(page,encoding='utf-8')
    print(json.dumps({'manual':str(DOCS/'00_交付导航.html'),'chapters':len(FILES),'portraits':len(employees),'bytes':len(page.encode())},ensure_ascii=False))

if __name__=='__main__':main()
