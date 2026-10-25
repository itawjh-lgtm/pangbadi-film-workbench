# 造梦工作室 · 团队工作台 v0.3

用户担任项目总策划，主助手协调影视与游戏团队。21 位虚构伙伴保留独立工位与会话，共用项目、任务、决策和成果。

## 使用

双击 `index.html` 可离线打开。开发预览可用 `python3 -m http.server 8767 --bind 127.0.0.1`，从当前项目目录启动。

- **总策划台**：3D 创作工作室主视觉、影视/游戏入口、项目、待拍板事项和协作记录。
- **项目协作**：项目组与员工独立会话、项目上下文、任务交接和成果预览。会话当前只保存本地便笺，角色示例发言明确标注。
- **任务看板**：新建任务、独立指定负责人与复核人、查看依赖、手动登记状态、成果依据与复核记录。
- **团队伙伴**：影视16位、游戏5位，搜索、收藏、完整岗位详情和人物图保存。
- **共享成果**：文稿正文、版本、关联任务与来源。HTML/XML标签按原文安全显示。
- **工具与连接**：能力边界、操作记录和JSON备份。

全站采用明亮磨砂玻璃：背景光晕、薄导航玻璃、内容玻璃、近景厚玻璃；支持窄屏重排和低动效偏好。3张首页场景由内置 image_gen 生成，PNG源图与网页WebP均在 `assets/scenes/`，完整提示词、角色参考和来源见 `docs/home-art-generation.json`。

## 当前边界

这是可交互本地协作原型。未接入真实模型、Agent执行器、外部应用登录、后台持续任务、多人同步或发布能力。手动状态、便笺、交接意图和示例内容不代表实际派发、接收、制作、独立复核或发布。

任务进入推进、复核或完成状态前，会检查上游依赖和方向决策。手动登记完成还需要成果依据与本轮复核记录。上游返修、退回决策或更改方向会使受影响下游回到待安排，并要求重新复核。

## 数据与保存

数据保存在当前浏览器/来源的 localStorage；离线文件、127.0.0.1、localhost 和对话预览各自可能拥有不同的存储空间。旧版v2收藏、筛选和查询可迁移，旧演示步数不会变成真实完成状态。

对话预览保存受限大小快照；超过限制时只保存界面指针，完整数据仍依赖本地存储。保存失败会显示提示。可在「工具与连接」导出JSON快照；本版尚未提供导入恢复界面。

## 代码结构

按顺序加载 `data/employees.js` → `data/project-templates.js` → `lib/store.js` → `lib/views.js` → `app.js`。

- `lib/store.js`：实体、规则、状态迁移与持久化。
- `lib/views.js`：六个视图和详情/表单展示。
- `app.js`：事件、导航、表单、草稿和焦点生命周期。
- `scripts/build-preview.py`：内嵌全部模块、21张人物缩略图和3张场景图，生成对话预览。
- `tests/store.test.cjs`：迁移、损坏状态、依赖、决策、返修、内容保真与保存边界测试。

架构与后续执行器接入边界见 `docs/architecture-v0.3.md`，实施决策见 `docs/plans/2026-10-23-bot-workbench-implementation.md`。

## 人物与版本保留

21张独立PNG在 `assets/employees/`，320px缩略图在 `assets/thumbs/`。本轮架构/玻璃升级不修改人物；前一轮修订的5位形象继续使用。人物设定、生成提示词与哈希见 `docs/character-bible.md`、`docs/portrait-prompts.json`、`docs/assets-manifest.json`。

升级前界面保存在 `docs/archive/ui-v0.2-before-bot-upgrade/`。原有目录路径保留以兼容既有入口；内部应用版本为v0.3。

## 设计依据

协作组织参考 Grok Bot 的固定职责、独立会话、群组交接和成果预览，按影视游戏创作场景重新设计；没有接入Grok或复制其云电脑能力。官方参考：

- https://docs.x.ai/grok-bot/bots
- https://docs.x.ai/grok-bot/chat-and-collaboration
- https://docs.x.ai/grok-bot/files-and-results
