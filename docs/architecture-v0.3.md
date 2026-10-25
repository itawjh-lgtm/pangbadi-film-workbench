# 造梦工作室 v0.3：本地协作架构

2026-10-23。适用目录仍为 `AI团队工作台_v0.2`，避免切换项目路径。v0.3 是工作台与状态格式升级，不表示已经部署后台服务。

## 1. 当前能力与参考来源

本版把 21 位虚构伙伴的身份资料连接到项目、员工会话、任务依赖、关键决策与共享成果。用户可以建立自己的项目、写本地便笺、安排任务、登记验证证据、手动拍板与退回返修。工作台没有模型执行器，也没有真正的员工消息投递、文件制作、后台调度或发布接口。人物图已存在；《灯塔来信》的文稿、角色发言与前两项完成状态均明确标为预置协作示例。

参考的是 Grok Bot 的协作组织方式：职责明确的伙伴有独立工作上下文与会话，项目共同结果通过可见交接连接；成果能在讨论旁被打开检查。官方依据为 [Create and manage Bots](https://docs.x.ai/grok-bot/bots)、[Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)、[Files and results](https://docs.x.ai/grok-bot/files-and-results) 与 [Grok Bot 产品页](https://x.ai/bot)，于 2026-10-23 查阅。本地的“伙伴工位”“项目协作”“共享成果”是对此的产品映射，不宣称获得或接入 Grok Bot 的运行能力。

Grok Bot 官方还区分可复用方法与定时触发，并要求重要外部动作有清楚边界；本版据此保留未来接入位置，未实现自动执行与定时任务。参见 [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) 与 [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)。

## 2. 文件职责与加载顺序

| 文件 | 职责 |
|---|---|
| `index.html` | 应用外壳、侧栏、主视图挂载点与操作对话框 |
| `styles.css` | 产品自己的颜色、排版、布局与响应式规则 |
| `data/employees.js` | 21 位员工的稳定身份、岗位边界、输入输出与人物图路径 |
| `data/project-templates.js` | 影视、游戏、联动项目的初始成员、任务与决策模板 |
| `lib/store.js` | 状态规范化、状态变更门禁、依赖传播、旧版迁移与持久化 |
| `lib/views.js` | 根据状态生成总策划台、会话、看板、团队和成果视图 |
| `app.js` | 处理界面事件，派发动作，订阅状态并更新视图 |
| `tests/store.test.cjs` | 用 Node 内置测试验证关键状态规则，不依赖浏览器 |
| `scripts/build-preview.py` | 按 `index.html` 原始顺序内嵌依赖，生成对话内可交互预览 |

脚本顺序为 `employees → project-templates → store → views → app`。当前不用框架、构建器、CDN 请求、服务器、网络连接或数据库。

## 3. 单一状态源

`window.TEAM_EMPLOYEES` 提供身份字典；`window.STUDIO_TEMPLATES` 是以 `film`、`game`、`hybrid` 为键的模板对象。二者只描述人和工作结构，不持有运行状态。`window.StudioStore` 创建本地状态仓库，界面必须通过它修改项目记录。

```js
const store = StudioStore.create(TEAM_EMPLOYEES);
const snapshot = store.getState();
const unsubscribe = store.subscribe((state, persistence) => render(state, persistence));
const result = store.dispatch({type: 'SELECT_PROJECT', id: 'demo-lighthouse'});
const blockers = store.blockers('demo-level');
```

`create(employees, {storage?, host?})` 允许测试或宿主注入存储；默认分别取 `localStorage` 和 `window.openai`。`getState()` 返回副本，外部修改不会改写仓库。`dispatch()` 同步校验并提交状态，再异步保存；失败返回 `{ok:false,error:'中文原因'}`，不改动原状态。创建项目、任务、便笺或成果成功时额外返回 `id`。`subscribe()` 返回取消订阅函数。公开的 `normalize(value,employees)`、`migrate(v2,employees)`、`initialState(employees)` 也用于恢复与测试；同一文件同时支持 CommonJS 导出。

v3 状态包括：

| 层次 | 字段及关系 |
|---|---|
| 界面指针 | `view`、`filter`、`query`、`page`、`favorites`、`activeProjectId`、`selectedTaskId`、`activePeerId` |
| 项目 | `projects`：名称、类型、简报、成员、`isDemo` 与创建时间 |
| 任务 | `tasks`：项目、责任人、复核人、状态、依赖、决策、交付物、验收条件、证据与复核记录 |
| 决策 | `decisions`：明确选项、用户选择、确认状态与理由 |
| 成果 | `artifacts`：所属项目和可选任务、文本或固定本地图片、版本、示例或手工来源 |
| 会话 | `messages`：项目频道或员工工位、作者、正文、时间与 `isExample` |
| 追踪 | `activity`：本地操作标签、细节与时间；`revision` 用于选择较新的完整快照 |

不把 Base64 人物图、工具凭证或模型密钥放入状态。规范化只读取已定义字段，限制文字长度与实体总量，过滤无效人员和跨项目引用；图片地址只允许现有 `assets/employees/ID.png` 白名单。项目最多 20 个、任务 120 项、决策 40 项、消息 80 条、成果 40 份；操作记录保留最近 80 条。新增实体超过上限时明确报错。

## 4. 项目、员工与任务的关系

新项目可从空白开始，也可选影视、游戏或联动模板。使用模板时，若没有提供成员列表，采用模板成员；若手动提供成员，必须覆盖模板责任人与复核人。真实用户项目恒为 `isDemo:false`，所有模板任务从 `queued` 开始；不会自动加入职业角色回复或完成证据。

`SELECT_PROJECT` 切换项目、清除员工会话并选中该项目首个任务；`OPEN_DM` 打开一个员工的本地便笺上下文。员工身份保持稳定；项目任务承担具体责任。同一员工可以进入多个项目，但不会因打开头像或输入文字自动开始工作。

主要动作如下：

| 动作 | 结果 |
|---|---|
| `NAVIGATE`、`FILTER`、`SEARCH`、`PAGE` | 更新导航、团队筛选、搜索与分页 |
| `SELECT_PROJECT`、`OPEN_DM`、`SELECT_TASK` | 更新当前项目、员工工位或任务 |
| `TOGGLE_FAVORITE` | 收藏或取消收藏有效员工 |
| `CREATE_PROJECT` | 建立本地项目，可选模板 |
| `CREATE_TASK` | 建立有独立责任人与复核人的待办，并校验依赖 |
| `UPDATE_TASK` | 更新状态、证据与复核记录；不能绕过门禁 |
| `DECIDE`、`REWORK_DECISION` | 由用户确认合法选项，或退回方向并使相关任务失效 |
| `SEND_MESSAGE` | 只保存用户便笺，恒为 `authorId:'user'`、`isExample:false` |
| `HANDOFF` | 只记“本地交接意图”，不声称已发送、已接收或已执行 |
| `ADD_ARTIFACT` | 保存手工文档及版本，不自动完成任务 |

## 5. 状态流转与失效传播

任务状态为 `queued`、`in_progress`、`review`、`done`、`rework`。这些是用户登记或预置示例的工作记录，不能仅凭状态词推断真实员工在运行。

进入 `in_progress`、`review` 或 `done` 前，所有直接上游必须 `done`，绑定决策必须 `approved`。进入 `done` 还需非空 `evidence` 与本轮 `reviewNote`。责任人与复核人必须不同，且都在该项目成员中；依赖必须来自同一项目，不接受自依赖或循环。存储和宿主恢复也重新执行这些检查，不能恢复越过门禁的完成状态。

上游退回返修，或原来完成的任务被重新打开时，所有传递下游中正在制作、复核或已完成的任务降为 `queued`。旧证据保留，复核记录加上 `需复核：` 标记；即使上游随后完成，下游仍须登记新的复核记录，不能直接沿用失效记录。

`REWORK_DECISION` 将方向标为 `rework`，绑定任务及其传递下游重新排队。用户改变已批准选项时也使这些任务重新复核。`DECIDE` 只接受该决策提供的选项，并记录“你手动拍板”。方向确认不会自动把任何任务推进到制作或完成。

《灯塔来信》是独立演示项目：资料 → 故事之后，关卡与分镜两线等待同一方向确认，原型依赖关卡，最后复核依赖原型与分镜。前两项 `done` 有明确示例证据；没有真实调研、剧本、游戏构建或宣传片被据此宣称完成。

## 6. 迁移、保存与恢复

本地键为 `creative-workbench-v3`。启动先读 v3；没有兼容 v3 时回退读取 `creative-workbench-v2`。旧版只迁移收藏、查询、筛选、界面位置与标为旧演示的操作记录；`demoStep`、旧 `approved` 和 `rework` 不变成真实任务完成或新决策确认。

宿主快照从 `widgetState.privateContent.studioV3` 读取，兼容旧 `studioV2`。本地与宿主都提供完整兼容快照时，选 `revision` 较新的版本；相同版本优先本地。`openai:set_globals` 中的新状态也经过规范化和门禁，只接受比内存更新的完整状态。

每次有意义的本地操作先同步更新界面，然后排队保存。初始化只读取，不写本地或宿主；宿主状态恢复只按需缓存本地，不回写宿主。只有 `dispatch` 后才调用宿主保存。`store.persistence` 暴露 `local`、`host`、`pending`、`attempted` 与 `hostTruncated`，并在保存结果变化时通知订阅者。首次保存前 `local` 表示存储可读性，`attempted:false` 区分尚未保存与保存失败；不能把点击成功当作持久化成功。未保存到任何位置时，界面应明确显示刷新可能丢失。保存反馈不递增状态 `revision`，界面可跳过同版本内容重绘，保留用户未提交的表单文字。

宿主总快照限制为 16 KB。代码在完整状态接近约 15 KB 时改存带 `truncated:true`、`pointerOnly:true` 的小型界面指针，包括当前视图、项目与筛选；完整数据仍保存在 localStorage。指针不是完整仓库，不能经恢复路径覆盖本地项目、任务或文稿。若本地写入失败而宿主只有指针，必须明确提示完整更改仍可能丢失。当前没有跨设备同步数据库，也没有多用户冲突合并。

## 7. 对话预览与本地应用

`build-preview.py` 从实际 `index.html` 收集脚本并按原顺序内嵌，移除原有 `script src`，防止本地与内嵌依赖重复执行。员工资料保留全部 21 位身份，但把 `portrait`、`thumb` 替换为对应 WebP 缩略图的内嵌地址，保持预览小于 1 MB；下载与完整原图仍以项目资产为准。

预览只输出应用片段，保留 `creative-workbench-v2` 根与 `app-shell`。所有 CSS 选择器限定在应用根内，产品保留自己的设计 token；对话宿主的浅深色外观用产品 `light-dark` 配色适配。固定定位、视口高度与会话内滚动在预览中转为内容高度；移动侧栏展开后采用正常文档流。此转换不修改本地应用布局代码，也不增加 `fetch` 或远端执行能力。

## 8. 未来执行器接口：仅设计，未实现

真实协作应把项目计划、一次执行、一次交接与独立复核分开。未来增加 `ExecutorAdapter`，而非在 `SEND_MESSAGE` 中拼接模拟回复。建议最小接口为 `start(request)`、`cancel(runId)`、`subscribe(onEvent)`；当前代码没有这些函数或后端路由。

建议执行请求包含 `requestId`、`projectId`、`taskId`、`employeeId`、`inputArtifactIds`、`inputRevision`、期望交付及授权范围。建议回传事件使用以下信封：

```json
{
  "eventId": "唯一事件编号",
  "runId": "一次真实执行的编号",
  "projectId": "项目编号",
  "taskId": "任务编号",
  "actorId": "责任员工或执行服务编号",
  "type": "run.started",
  "occurredAt": "服务端时间",
  "inputRevision": 12,
  "payload": {}
}
```

可规划的事件包括 `run.queued`、`run.started`、`run.progress`、`artifact.created`、`review.requested`、`review.completed`、`approval.required`、`handoff.sent`、`handoff.received`、`run.failed`、`run.cancelled`。这些是本项目的拟议接口名称，不是 Grok Bot 已公开 API 的承诺。

接入时要验证事件来源、去重 `eventId`、检查输入版本与当前依赖是否一致，再由专门动作落入状态层。`artifact.created` 只证明获得候选成果；不自动等于验证通过。`handoff.sent` 和 `handoff.received` 必须分别有投递与接收证据。`review.completed` 要关联独立复核者与证据；发布、支出及外部消息须有具体授权。模型运行成功不自动产生 `done`，也不能绕过总策划确认与现有依赖门禁。

## 9. 已验证范围

`tests/store.test.cjs` 的 20 项 Node 测试已通过，覆盖迁移、坏数据清洗、依赖与决策门禁、不同责任人与复核人、完成证据、上游返修的传递失效、非伪造便笺、真实项目创建与本地回读、标签文本无损往返、项目至少两位伙伴、保存失败、宿主截断和宿主事件恢复，并验证初始化不写入、恢复不回写宿主、保存通知不改变版本。界面加载、响应式与对话预览仍应以本轮浏览器验收记录为准；状态测试不替代游戏运行、视频播放或真实执行器验证。
