# RunningHub 图像与视频公开 API 目录

采集源：https://www.runninghub.cn/runninghub-api-doc-cn/llms.txt

采集时间：2026-10-24T20:38:24.136832+00:00

## 覆盖范围

- 311 个唯一模型 API 路径，全部为 `POST /openapi/v2/...`。
- 图像 99 个、视频 212 个，含生成、编辑、工具与处理能力。
- 307 个文档未标记下架，4 个明确已下架；未标记下架不代表已实际调用验证。
- 同时覆盖官方“模型API”和“标准模型API”两套目录。两目录当前模型路径没有重复。
- 311 份请求 JSON schema 均已提取，均为内联 schema，无 `$ref`。
- 每条模型记录保留文档URL、路径、参数类型、必填、范围、枚举和说明。
- 删除文档的示例提示词、示例素材URL、带签名URL，防止错误成为产品默认值。
- 包括 `84##value`、`scriptContent` 等节点命名的自由文本默认值；运行时仅自动填入通过校验的操作参数，提示词和素材由项目或用户提供。

## 文件

- `runtime-model-catalog.json`：建议后台加载；模型信息、能力分类、可用标记和输入schema。
- `public-model-catalog.json`：完整模型操作信息，额外含响应schema。
- `public-document-schemas.json`：模型与辅助API的公开文档schema。
- `refresh_public_catalog.py`：可重复执行的公开文档采集器，依赖Python及PyYAML、curl；仅GET官方文档，不读取任何账号配置、不提交生成任务。
- `llms.txt`：原始官方索引快照。

刷新遇到任何下载/解析错误、空目录、重复路径、非 POST/v2 路径或缺失输入 schema 时，会保留旧快照并报错。全部新文件先生成，再逐个原子替换；更新后需要重新运行目录测试并重启本机服务。

## 完整性核验

- 311 个路径均唯一；按中英名称或品牌归并会误删版本/渠道/不同操作，不做品牌级去重。
- 311 个响应均有相同的顶层字段：`taskId/status/errorCode/errorMessage/results/clientId/promptTips/failedReason/usage`。
- 311 份返回说明均引用 `/openapi/v2/query` 查询后续状态/结果。
- 所有 required 字段都能在 properties 中找到。参数类型为 string/integer/number/boolean/array；没有内联对象或 oneOf/anyOf/allOf。某些结构化参数是 JSON 字符串，仍需按其 description 输入。
- 官方全部 `deprecated: false`，4条下架信息只出现在名称/路径，必须额外识别，不能只读 deprecated 字段。
- 目录中的“可用”仅表示官方文档未标记下架；实际账户权限、供应商实时可用性和价格由请求返回确认。

## 调用协议

- 发起：`POST https://www.runninghub.cn/openapi/v2/{模型路径}`。
- 查询：`POST https://www.runninghub.cn/openapi/v2/query`，JSON `{"taskId":"..."}`。
- 价格预估：`POST /openapi/v2/price-preview/**`，后续路径替换成目标模型路径，原参数提交；详见 https://www.runninghub.cn/runninghub-api-doc-cn/api-454850620.md 。
- `Authorization: Bearer ...`，凭据只放后端。
- 参数不能跨模型盲目共用；例如首图可叫 `imageUrl`、`firstImageUrl`、`firstFrameUrl`，以模型schema为准。

## 个人账户与密钥类型

官方开始文档：https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287334.md

官方明确：模型API和LLM API **仅支持企业级-共享API Key**。消费级会员Key支持工作流和AI应用；企业级独占Key也不支持直接模型API。

“个人账户”和“消费级Key”不是同一个概念：官方说个人账户可以归属资源、任务、余额和API Key；共享Key不必意味着创建团队。应让用户在自己个人账户下配置符合要求的共享Key，保留现有消费级Key供工作流使用。

## 已下架（保留目录、禁止提交）

- `rhart-image-g-1.5/edit-[Deprecated]`：全能图片G-1.5-图生图-低价渠道版-(已下架) 可用全能图片G-2 模型代替
- `rhart-image-g-1.5/text-to-image-[Deprecated]`：全能图片G-1.5-文生图-低价渠道版-(已下架) 可用全能图片G-2 模型代替
- `rhart-video-s/image-to-video-pro-deprecated`：全能视频S-图生视频-pro-低价渠道版-已下架
- `rhart-video-s/text-to-video-pro-deprecated`：全能视频S-文生视频-pro-低价渠道版-已下架

## 能力分布

- audio-to-video：4
- digital-human：2
- image-effects：3
- image-to-image：43
- image-to-video：82
- image-tools：4
- motion-control：5
- reference-to-image：1
- reference-to-video：28
- text-to-image：48
- text-to-video：58
- video-edit：7
- video-extend：2
- video-to-video：6
- video-tools：18

本目录验证的是公开文档完整性，不是311个付费模型的真实运行结果。
