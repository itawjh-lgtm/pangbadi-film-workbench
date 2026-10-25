# 自动影视团队协作实施计划

**Goal:** 用户提交一次影视制作需求，员工按依赖真实执行、交接、等待审阅并支持定点返修，全部进度和文稿留在现有项目。

**Architecture:** 现有 SQLite records 新增 production 记录；每阶段调用现有 Runtime 单人 run，复用岗位全文和真实成果。浏览器只展示服务端计划，不改手动任务验收状态；项目/工位继续共用现有数据库。

**Tech Stack:** Python 标准库、SQLite、原生 JavaScript、现有 Mac WKWebView。

## 范围与决策

- 影视协作首先覆盖 R11 制作规划 → R03 剧本 → R05 视觉设定 → R04 分镜 → R06 生成输入 → R11 交付整理。
- 逐步审阅在剧本、视觉及最终交付停靠；连续模式允许中间文本自动交接，最终仍需审阅。
- 所有图片/视频状态根据实际媒体任务，文稿完成不能等同媒体完成。未配置工作流时显示生成准备和接入提示。
- 不改费用/用户管理；不重做头像、Mac 外壳或已确认风格；不调用付费媒体测试。
- 项目当前未纳入 Git 跟踪，采用原目录开发，源码与 SQLite 已备份到 data/runtime/backups/before-auto-collaboration-20261025/，不建缺少源文件的 worktree。

## Task 1: 持久化编排

Create server/production.py and tests/test_production.py. Implement idempotent start; stages and input artifact references; reviewMode; revision CAS; pause/resume/revise; old versions; event seq; restart reconciliation. Use Runtime.start per stage, never hold provider slots while waiting. Retry only unfinished stage; retain completed evidence. Tests use temporary data and fake provider.

## Task 2: API 与运行保障

Modify server/httpd.py and server/runtime.py. Expose GET/POST /api/productions and GET detail, POST pause/resume/review. Keep same-origin/CSRF and project scope. Prevent manual runs from racing active auto plans. Report activeProductionCount, preserve graceful stop and update service/launcher compatibility together if version changes. Add HTTP tests.

## Task 3: 项目可视化入口

Create lib/production.js, lib/production-views.js, styles/production.css. Modify app.js, lib/views.js, lib/store.js, index.html. Add project automatic collaboration entry, goal/mode form, stage owner/status, review/return/pause/resume, full-text artifacts and event history. Preserve drafts/focus during polling, prevent repeated starts, isolate projects and disable execution in embedded previews. Add Node tests and expand view checks.

## Task 4: 验证与使用说明

Run python3 -m unittest discover -s tests -p 'test_*.py'; node --test tests/*.test.cjs; node tests/views.smoke.cjs. Inspect real page using CUA; test plan progression with isolated fake-provider server, label fixture clearly. If local Codex is available, run a bounded text-only smoke in an isolated data directory. Never insert QA projects into user workspace. Update README and docs; build existing inline preview.

## 验收标准

1. 一次提交按阶段调用不同岗位，交接真实 artifact 正文。
2. 审阅点不自动越过；重复点击与迟到响应不重复创建任务。
3. 返修追加版本并使受影响下游待重做，旧文件可查看。
4. 暂停、失败和重启保留成果，不从头重做。
5. UI 能看到负责人、当前阶段、真实交付、错误和下一步；刷新不丢编辑草稿。
6. 文本生成、媒体生成、用户验收分开标记。
