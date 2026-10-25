# v0.4 本机 Agent 工作台

2026-10-24。沿用现有银白玻璃界面、21 人物、项目数据和任务门禁。

## 架构决策

浏览器保留项目、任务、总策划决策、人工成果与布局偏好。Python 标准库服务负责岗位全文、Codex 调用、执行记录、完整文稿与外部生成任务。模型认证沿用已经登录的本机 Codex CLI。没有创建第二套角色库，也不把岗位摘要当执行指令。

```
总策划 → 独立工位 / 项目群聊 / 任务执行
                    ↓
        loopback HTTP + CSRF + scope validation
                    ↓
      RoleCatalog → Runtime → CodexProvider
          ↑              ↓
 Obsidian 岗位正文    SQLite + 文稿文件 + hash
                    ↓
           可视化运行 / 下载 / 继续修改

独立操作：RunningHub 可视化平台 ↔ 用户
工作台生成：参数 → 费用预览 → 明确确认 → RunningHub API
                                       ↓
                              任务编号 / 查询 / 结果链接
```

- 影视默认项目主控 R11，游戏 G01。项目可显式选择最多 4 位成员依次执行，每步独立调用并附前序完整成果和哈希。
- 不同工位/项目上下文隔离，同一会话最多一条在途运行；全局最多 2 条并行、8 条排队。
- 执行成功只表示文字已产生并保存；不自动通过任务复核或总策划验收。模型审阅建议不等于独立专业测试。
- 角色使用共享正文与角色正文全文，记录版本、源路径和 SHA-256。修改源提示词后重新启动服务以装载新快照。
- 当前 Codex 执行器专用于文字生成，禁用 shell、应用、浏览器、记忆、插件和子 Agent 工具。研究岗位可分析材料，但没有联网检索或事实核验能力；需要外部核查时标明待核实。

## 数据

| 数据 | 保存位置 | 说明 |
|---|---|---|
| 项目/任务/人工记录/布局 | 当前来源的浏览器 localStorage | 原有键保持兼容；可导出 JSON |
| 执行记录/媒体任务 | `data/runtime/studio.sqlite3` | 真实运行独立持久化，不受原 store 长度限制 |
| 角色输入/文稿版本 | `data/runtime/runs/<id>/` | 原始输入、岗位快照、每位成员的完整 Markdown |
| 外部密钥和工作流配置 | `data/runtime/connections.json` | 文件权限 0600；不会回传浏览器或写入项目 JSON |
| 图像/视频结果 | RunningHub 返回的 HTTPS 链接 | 尚未自动下载、播放或质检，链接可能失效 |

浏览器 JSON 导出不包含后端文件。备份应同时保留浏览器 JSON 和整个 `data/runtime/`；其中连接配置含密钥，不要公开分享。服务只监听 127.0.0.1，拒绝跨站请求和不匹配 Host；写操作需要当前服务 token。静态目录白名单排除运行数据库、密钥、源码、归档和文档，拒绝路径穿越与符号链接。

运行使用 requestId 幂等；同一 ID 改参数会拒绝。取消保留已经保存的部分成果。服务重启后未完成的文字运行标中断，不冒充可续跑。媒体提交网络结果不明时标 unknown，不自动重试，需到平台查账和任务。

## RunningHub 与扩展边界

当前实现工作流 API 通用适配，不预设工作流和模型，不触发付费测试。

1. 可视化入口打开 RunningHub；登录、搭节点、选模型由平台操作。
2. 工作台 API 入口保存密钥、工作流 ID 与用户估计的每次价格。
3. 节点输入保持 RunningHub `nodeInfoList` 格式。
4. 估价绑定工作流、节点、数量、币种、单价与预算；改参数需要重新预览。
5. 明确勾选费用确认后才提交一次。quantity 固定 1，不自动批量或重试。
6. 手动查询真实状态与结果；服务商返回费用才可登记实际数值。

预算是提交前比较，不是 RunningHub 账户的硬额度。当前预估采用用户填写的整次单价，不能把它称为平台报价或实扣。工作流包含哪些模型和节点会影响真实费用。

火山方舟、MiniMax、即梦、LibTV 保留统一 provider 目录与状态，尚未实现它们的真实 API 调用；不能宣称所有模型已接通，也不能据未知价格自动选“最低价”。下一步在选择模型后为每个平台补鉴权、提交/查询/取消、价格口径和结果归档适配。可视化节点编辑器也属于后续功能，当前工作台用表单和节点 JSON。

## 官方依据

- Codex 非交互调用：https://developers.openai.com/codex/noninteractive
- Codex 配置：https://developers.openai.com/codex/config-reference
- Grok Bot 互动参考：https://docs.x.ai/grok-bot/chat-and-collaboration
- RunningHub 工作流提交：https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013
- RunningHub v2 查询：https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306

没有接入 Grok 服务；参考其独立 Bot、群聊、交接和成果式交互。
