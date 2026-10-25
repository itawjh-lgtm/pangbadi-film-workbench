# 创作团队工作台 v0.2

用户是项目总策划；主助手负责跨团队协调，R11负责影视统筹，G01负责游戏专业统筹。

## 打开

双击 `index.html`，即可在浏览器查看。页面、数据和21张人物图都在本地，不依赖接口或登录。

- 团队大厅：全部21位、影视16位、游戏5位；支持搜索、收藏、分页及工位详情。
- 项目工作台：用《灯塔来信》演示资料、故事、游戏与影视并行、独立复核、总策划拍板和返修。
- 协作记录：只记录本地浏览和演示操作。

本版是可交互概念演示。没有接入实际Agent执行器，不会自动生成剧本、视频或游戏，也不会发布内容。收藏与演示状态优先保存在当前浏览器；保存失败时会显示提示。

## 人物资产

- `assets/employees/`：21张独立PNG原图，R01—R16、G01—G05各一张。
- `assets/thumbs/`：网页展示用WebP缩略图，原图保持不变。
- `docs/assets-manifest.json`：角色、原图、尺寸、哈希及生成来源核对记录。
- `docs/character-bible.md`：21位员工的虚构姓名、外貌和职业特征。
- `docs/portrait-prompts.json`：完整人物提示词集。
- `docs/portrait-generation-*.json`：实际生图请求、参考图及修订过程。

所有姓名和人物形象均为原创虚构角色，使用内置 `image_gen` 逐人生成。统一采用可爱的Q版3D动画方向，以发型、服装、脸型和职业道具区分；个别人头身比例、画面占幅会有生成差异。

本轮人物差异化修订保留顾闻溪，调整叶初禾、何景澈、邵行舟、陶知夏和季怀宁的外形与背景。旧图保存在 `assets/archive/before-portrait-differentiation/`；选用的新图源在 `assets/revisions/differentiation-v1/`。实际编辑提示词见 `docs/portrait-generation-differentiation-v1.json`，文件核验与视觉复核记录见 `docs/qa/portrait-differentiation-validation.json`。21人原图ZIP已同步更新。

## 设计参考与调整

参考用户指定的 https://www.super-i.cn/tool.html ，沿用黑白基底、荧光绿强调、大标题、细黑边、大圆角、桌面四列和筛选搜索结构。针对全身人物将卡片图片区改为1:1，避免裁掉头部与鞋子；不复用原站标识或文章素材。

## 职责依据

岗位职责以当前 Obsidian 的影视16岗和游戏5岗提示词为依据。人物包装不替代完整提示词；同一执行者切换身份不构成独立复核。
