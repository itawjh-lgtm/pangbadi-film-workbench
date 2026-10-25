// 虚构人物；岗位字段来自现有角色。21张独立PNG已保存，核对记录见docs/assets-manifest.json。
window.TEAM_EMPLOYEES = [
  {
    "id": "R01",
    "name": "顾闻溪",
    "short": "经营 / 商务",
    "title": "经营负责人兼商务制片人",
    "team": "film",
    "summary": "经营方向、项目价值、合作与商务测算。",
    "task": "商业目标与合作条件",
    "input": "项目目标、受众与资源约束",
    "output": "商业可行性与合作建议",
    "next": "你 / R11",
    "review": "R16 核对成本",
    "boundary": "不代替 R11 调度制作。",
    "tags": [
      "商业判断",
      "合作设计"
    ],
    "appearance": "成年女性，约38岁年龄感；略长椭圆脸、平直浓眉、深棕杏眼，鼻梁清晰、唇形利落；下颌长度乌黑侧分短发，左侧一缕银发；象牙白无领外套配墨绿内搭；深色薄型项目简报夹。",
    "portrait": "assets/employees/R01.png",
    "thumb": "assets/thumbs/R01.webp"
  },
  {
    "id": "R02",
    "name": "许澄",
    "short": "研究 / IP",
    "title": "研究与IP开发制片人",
    "team": "film",
    "summary": "搜集资料、事实核查、筛选小说剧本并规划系列。",
    "task": "资料与权利核验",
    "input": "项目简报与候选参考资料",
    "output": "资料索引与权利待核表",
    "next": "R03 / R13",
    "review": "R13 核对权利边界",
    "boundary": "原作事实与改编设定分开记录。",
    "tags": [
      "事实核查",
      "IP评估"
    ],
    "appearance": "成年男性，约28岁年龄感；圆方脸、柔和短眉、深棕大眼、稍宽鼻翼，左颊小痣；蓬松黑色短卷发；灰蓝针织开衫配白圆领衫；带彩色签条的资料册。",
    "portrait": "assets/employees/R02.png",
    "thumb": "assets/thumbs/R02.webp"
  },
  {
    "id": "R03",
    "name": "林砚舟",
    "short": "编剧 / 故事",
    "title": "编剧兼故事策划",
    "team": "film",
    "summary": "人物行动、冲突、因果、节拍及原创与改编剧本。",
    "task": "故事与世界设定",
    "input": "R02 资料索引与总策划方向",
    "output": "人物小传、故事梗概与关键节拍",
    "next": "R04 / G01 / G02",
    "review": "R04 复核叙事表达",
    "boundary": "变更核心设定，先回到总策划决定。",
    "tags": [
      "故事结构",
      "人物弧线"
    ],
    "appearance": "成年男性，约47岁年龄感；窄长脸、眉骨清晰、深棕大眼、圆鼻尖、浅笑纹；齐耳深棕微卷发夹少量灰色，无胡须；暗红针织衫配烟灰外套；装订剧本稿。",
    "portrait": "assets/employees/R03.png",
    "thumb": "assets/thumbs/R03.webp"
  },
  {
    "id": "R04",
    "name": "沈知遥",
    "short": "导演 / 分镜",
    "title": "导演兼分镜与预演设计",
    "team": "film",
    "summary": "叙事、表演、摄影调度、分镜与镜头衔接。",
    "task": "15 秒宣传片的导演方案",
    "input": "确认故事与游戏视觉规格",
    "output": "镜头表与预演方案",
    "next": "R05 / R06 / R08",
    "review": "R11 组织专业复核",
    "boundary": "导演方案须使用已确认故事版本。",
    "tags": [
      "视听调度",
      "分镜预演"
    ],
    "appearance": "成年女性，约33岁年龄感；短方脸、浓弯眉、眼距较宽的黑色大眼，直鼻梁和稍厚下唇；黑色低马尾配短侧刘海；深靛工装夹克配浅灰衬衣；折叠导演取景器。",
    "portrait": "assets/employees/R04.png",
    "thumb": "assets/thumbs/R04.webp"
  },
  {
    "id": "R05",
    "name": "周予白",
    "short": "美术指导",
    "title": "美术指导兼视觉资产设计",
    "team": "film",
    "summary": "视觉方向、角色场景、造型、光色与资产规范。",
    "task": "宣传片美术规范",
    "input": "导演方案与跨团队视觉基准",
    "output": "风格、角色及场景资产规格",
    "next": "R06 / R07 / G04",
    "review": "R04 复核叙事适配",
    "boundary": "与 G04 对齐共享视觉资产版本。",
    "tags": [
      "视觉开发",
      "资产规范"
    ],
    "appearance": "成年男性，约35岁年龄感；鹅蛋脸、浅眉、深棕眼睛、略弧鼻梁，嘴角上扬；栗棕中长发束低髻；奶茶色宽松衬衫配深棕马甲；折页材质色样册。",
    "portrait": "assets/employees/R05.png",
    "thumb": "assets/thumbs/R05.webp"
  },
  {
    "id": "R06",
    "name": "姜云岫",
    "short": "AI 影像",
    "title": "AI影像艺术家兼技术美术",
    "team": "film",
    "summary": "模型适配、参考控制、图视频生成、诊断和返修。",
    "task": "宣传片镜头制作",
    "input": "确认分镜、参考图与美术规范",
    "output": "镜头候选及生成记录",
    "next": "R08 / R09",
    "review": "R04 看叙事；R05 看视觉",
    "boundary": "生成候选不等于已验收镜头。",
    "tags": [
      "生成控制",
      "影像诊断"
    ],
    "appearance": "成年女性，约44岁年龄感；菱形脸、清晰颧骨、弧眉、明亮大眼、微翘鼻尖，左嘴角浅痣；黑色超短发加前额一道银白发束；炭灰立领衬衫配钴蓝轻外套；数位板。",
    "portrait": "assets/employees/R06.png",
    "thumb": "assets/thumbs/R06.webp"
  },
  {
    "id": "R07",
    "name": "程既明",
    "short": "CG / 视效",
    "title": "动画CG与视效制作负责人",
    "team": "film",
    "summary": "数字资产、绑定、动画、模拟、灯光渲染及专项协同。",
    "task": "按需支援 CG 与视效",
    "input": "确认镜头需求与资产规格",
    "output": "动画、渲染与合成交接包",
    "next": "R09 / R11",
    "review": "R05 / R09 专业复核",
    "boundary": "有专项需求时进入任务，不强行全员开工。",
    "tags": [
      "动画视效",
      "灯光渲染"
    ],
    "appearance": "成年男性，约30岁年龄感；宽圆脸、平眉、圆眼、宽鼻梁、圆下巴；浓密黑发向两侧分开，整齐短络腮胡；柔紫针织衫配黑色轻薄背心；小型关节人偶。",
    "portrait": "assets/employees/R07.png",
    "thumb": "assets/thumbs/R07.webp"
  },
  {
    "id": "R08",
    "name": "叶初禾",
    "short": "剪辑 / 包装",
    "title": "剪辑师兼动态图形设计",
    "team": "film",
    "summary": "叙事结构、节奏、字幕、图形包装与时间线交接。",
    "task": "宣传片剪辑草案",
    "input": "确认镜头与 R10 声音素材",
    "output": "剪辑草案、字幕和时间线",
    "next": "R09 / R10",
    "review": "R04 复核叙事节奏",
    "boundary": "剪辑预览与正式导出分别验收。",
    "tags": [
      "叙事剪辑",
      "动态图形"
    ],
    "appearance": "成年女性，约27岁年龄感；略窄心形脸、明亮棕色杏眼、小圆鼻；栗红色耳下直短发与短齐刘海；雾紫宽松卫衣、深蓝九分直筒裤、奶白运动鞋；双手操作无文字剪辑时间线面板。浅薰衣草紫背景，气质专注俏皮。",
    "portrait": "assets/employees/R08.png",
    "thumb": "assets/thumbs/R08.webp"
  },
  {
    "id": "R09",
    "name": "梁时远",
    "short": "合成 / 母版",
    "title": "合成调色与母版负责人",
    "team": "film",
    "summary": "镜头融合、修复、色彩管理、技术检测及发行母版。",
    "task": "宣传片技术复核",
    "input": "剪辑时间线与已确认镜头",
    "output": "技术问题单、母版候选",
    "next": "R11 / R14",
    "review": "R11 组织播放与交付核验",
    "boundary": "文件存在不等于播放和母版验收通过。",
    "tags": [
      "色彩管理",
      "母版质检"
    ],
    "appearance": "成年男性，约52岁年龄感；长方脸、低浓眉、深棕大眼、宽直鼻梁，少量自然笑纹；银灰黑色相间短发，无胡须；雾蓝圆领毛衣配深灰外套；标准色卡。",
    "portrait": "assets/employees/R09.png",
    "thumb": "assets/thumbs/R09.webp"
  },
  {
    "id": "R10",
    "name": "苏听澜",
    "short": "声音 / 配乐",
    "title": "声音设计兼配音与音乐统筹",
    "team": "film",
    "summary": "对白表演、环境音效、音乐、混音与分轨。",
    "task": "宣传片声音，并支援游戏",
    "input": "台词、节奏、声音需求与授权边界",
    "output": "配音、音乐、音效和分轨包",
    "next": "R08 / G03",
    "review": "R04 / G01 按用途复核",
    "boundary": "跨团队复用声音须带授权与版本。",
    "tags": [
      "声音叙事",
      "混音统筹"
    ],
    "appearance": "成年女性，约39岁年龄感；丰润椭圆脸、弯眉、黑色杏眼、圆鼻头，浅酒窝；深棕螺旋卷发松束脑后，两侧留卷发；赭黄细纹衬衫配深蓝外套；专业包耳监听耳机。",
    "portrait": "assets/employees/R10.png",
    "thumb": "assets/thumbs/R10.webp"
  },
  {
    "id": "R11",
    "name": "陆观行",
    "short": "影视统筹",
    "title": "项目主控与质量交付统筹",
    "team": "film",
    "summary": "管理影视任务、依赖、正式版本、专业复核和交付证据。",
    "task": "影视排程与跨线验收汇总",
    "input": "总协调派单与确认项目底稿",
    "output": "影视交付清单与问题汇总",
    "next": "总协调 → 你",
    "review": "各专业复核后汇总",
    "boundary": "不取代总策划；每个制作任务另有责任人。",
    "tags": [
      "依赖调度",
      "交付核验"
    ],
    "appearance": "成年男性，约34岁年龄感；窄方脸、短眉尾、深棕单眼皮，直而不高鼻梁、薄唇；黑色短碎发向前梳；浅石色无结构西装配深蓝圆领衫；带空白任务卡的便携任务板。",
    "portrait": "assets/employees/R11.png",
    "thumb": "assets/thumbs/R11.webp"
  },
  {
    "id": "R12",
    "name": "宋岑",
    "short": "技术 / 资产",
    "title": "技术负责人兼工作流与资产管理",
    "team": "film",
    "summary": "工具实测、制作管线、工程接口、资产、算力和恢复。",
    "task": "工具与资产支援",
    "input": "制作需求和资源约束",
    "output": "实测记录、资产规范与工作流",
    "next": "R06 / R07 / G03",
    "review": "R11 核对可用性",
    "boundary": "接入成功必须有实际调用证据。",
    "tags": [
      "管线集成",
      "资产恢复"
    ],
    "appearance": "成年女性，约31岁年龄感；圆脸、浓直眉、内双黑眼睛、窄鼻翼、柔和下巴；黑色齐下颌短发，右侧铜色发束；深紫工装衬衫配浅灰T恤；无品牌便携固态硬盘。",
    "portrait": "assets/employees/R12.png",
    "thumb": "assets/thumbs/R12.webp"
  },
  {
    "id": "R13",
    "name": "何景澈",
    "short": "版权 / 合规",
    "title": "版权法务与地区平台合规负责人",
    "team": "film",
    "summary": "核对授权链、合同支持、地区与平台现行规则。",
    "task": "核验与发布前复核",
    "input": "来源记录、目标地区与平台",
    "output": "权利待核表与规则检查记录",
    "next": "R02 / R14 / G01",
    "review": "必要时外部专业确认",
    "boundary": "规则要注明来源和日期；不能凭旧记忆放行。",
    "tags": [
      "权利核验",
      "规则追踪"
    ],
    "appearance": "成年男性，约29岁年龄感；略长且下颌柔方的脸、浓眉、深棕杏眼、含蓄微笑；黑色利落短侧分，露出一侧额头；藏蓝立领外套、浅蓝衬衫、暖灰长裤、深棕圆头皮鞋；抱授权资料夹并展开一页空白文件。浅暖灰背景，气质可靠温和。",
    "portrait": "assets/employees/R13.png",
    "thumb": "assets/thumbs/R13.webp"
  },
  {
    "id": "R14",
    "name": "孟舒言",
    "short": "发行 / 本地化",
    "title": "国际发行兼本地化与平台运营",
    "team": "film",
    "summary": "地区渠道、翻译译配、发布包、上线执行和回读。",
    "task": "发布准备，待平台确定",
    "input": "确认母版、地区清单与合规意见",
    "output": "本地化与渠道发布包",
    "next": "R15 / 你",
    "review": "R13 合规；R11 包完整性",
    "boundary": "上线执行与平台回执分别记录。",
    "tags": [
      "国际发行",
      "本地化"
    ],
    "appearance": "成年女性，约48岁年龄感；长椭圆脸、柔眉峰、微笑大眼、窄鼻梁、自然笑纹；盐灰齐肩直发，一侧别耳后；湖蓝衬衫配米白短外套；无文字字幕电子阅读器。",
    "portrait": "assets/employees/R14.png",
    "thumb": "assets/thumbs/R14.webp"
  },
  {
    "id": "R15",
    "name": "邵行舟",
    "short": "营销 / 增长",
    "title": "营销增长与商业化负责人",
    "team": "film",
    "summary": "作品定位、宣传、渠道实验、留存、数据与收入方案。",
    "task": "宣传及增长准备",
    "input": "确认定位、素材与渠道目标",
    "output": "宣传方案与可验证的增长实验",
    "next": "你 / R14 / G01",
    "review": "R01 核对商业目标",
    "boundary": "不虚构播放、用户增长或收入。",
    "tags": [
      "增长实验",
      "商业化"
    ],
    "appearance": "成年男性，约41岁年龄感；宽方脸、粗弯眉、深棕大眼、开朗露齿笑容；深棕短卷发、修整短络腮胡；砖红圆领衫、沙色夹克、深棕长裤、奶白运动鞋；单手举抽象趋势图平板，另一手张开讲解。柔杏橙背景。",
    "portrait": "assets/employees/R15.png",
    "thumb": "assets/thumbs/R15.webp"
  },
  {
    "id": "R16",
    "name": "陶知夏",
    "short": "财务 / 人力",
    "title": "财务人力与行政统筹",
    "team": "film",
    "summary": "预算现金流、成本结算、人才供应商与资源安排。",
    "task": "预算与供应商支援",
    "input": "确认范围、实际报价与资源需求",
    "output": "预算、成本和资源安排",
    "next": "你 / R01 / R11",
    "review": "R01 核对经营可行性",
    "boundary": "预算与实际支出分开，费用不能猜测。",
    "tags": [
      "成本核验",
      "人才配置"
    ],
    "appearance": "成年女性，约30岁年龄感；稍长鹅蛋脸、短平眉、深棕凤眼、温柔微笑；黑色侧分长发编成一条紧实长辫垂肩，浅黄发圈束发尾；浅黄衬衫、深棕马甲、深棕及踝A字裙、棕色乐福鞋；双手捧打开的无文字双栏资源日程本。浅玫瑰粉背景。",
    "portrait": "assets/employees/R16.png",
    "thumb": "assets/thumbs/R16.webp"
  },
  {
    "id": "G01",
    "name": "季怀宁",
    "short": "游戏统筹",
    "title": "游戏制作人兼主策划",
    "team": "game",
    "summary": "游戏内部主控，管理核心循环、规则、必要数值、范围与版本。",
    "task": "游戏方案与内部调度",
    "input": "你确认的目标与 R03 故事底稿",
    "output": "游戏设计基线与交付清单",
    "next": "G02 / G03 / G04；汇总交总协调 → 你",
    "review": "G05 提交测试依据",
    "boundary": "这里的主策划是专业岗位；项目总策划始终是你。",
    "tags": [
      "核心玩法",
      "制作统筹"
    ],
    "appearance": "成年女性，约42岁年龄感；饱满方圆脸、浓眉、清澈黑眼、右侧浅酒窝；深棕齐耳蓬松小卷发，右侧一缕灰发；珊瑚橘与奶油白拼色棒球外套、深靛蓝宽松牛仔裤、米白运动鞋；双手捧无品牌游戏手柄。浅天蓝背景，气质温暖开朗。",
    "portrait": "assets/employees/G01.png",
    "thumb": "assets/thumbs/G01.webp"
  },
  {
    "id": "G02",
    "name": "陈屿川",
    "short": "关卡 / 体验",
    "title": "关卡与玩家体验设计师",
    "team": "game",
    "summary": "关卡任务、玩家动线、教学节奏、交互行为与 UI 信息结构。",
    "task": "首关设计与交互规格",
    "input": "确认玩法与世界设定",
    "output": "关卡流程、交互和教学规格",
    "next": "G03 / G04",
    "review": "G01 看规则；G05 看可验证性",
    "boundary": "交互规则与 G04 的界面视觉分开负责。",
    "tags": [
      "关卡节奏",
      "交互设计"
    ],
    "appearance": "成年男性，约36岁年龄感；窄椭圆脸、弧眉、眼距宽的深棕大眼、圆鼻尖、偏厚唇；后颈长度黑色直发，上半束起；雾粉衬衫配深灰工装外套；抽象节点路径折叠设计板。",
    "portrait": "assets/employees/G02.png",
    "thumb": "assets/thumbs/G02.webp"
  },
  {
    "id": "G03",
    "name": "唐亦晴",
    "short": "程序 / 技美",
    "title": "游戏程序兼技术美术",
    "team": "game",
    "summary": "引擎功能、代码、资产接入、运行表现、构建与性能修复。",
    "task": "可玩构建与返修",
    "input": "确认交互规格、资产与引擎约束",
    "output": "可运行构建、代码与构建说明",
    "next": "G05",
    "review": "G05 独立执行测试后提交记录",
    "boundary": "换成测试身份自评，不能算独立复核。",
    "tags": [
      "引擎实现",
      "实时技美"
    ],
    "appearance": "成年女性，约28岁年龄感；短菱形脸、微挑眉、圆杏眼、短直鼻梁，左眼下浅痣；黑色短卷发，侧边修短、顶部蓬松；深青拉链外套配淡紫T恤；无品牌掌上测试设备。",
    "portrait": "assets/employees/G03.png",
    "thumb": "assets/thumbs/G03.webp"
  },
  {
    "id": "G04",
    "name": "温墨衡",
    "short": "游戏美术",
    "title": "游戏美术兼动画与界面视觉",
    "team": "game",
    "summary": "风格、角色场景资产、动画与 UI 视觉。",
    "task": "首关视觉资产，并支援宣传片",
    "input": "G02 交互规格与共享视觉基准",
    "output": "游戏资产、动画与 UI 视觉包",
    "next": "G03 / R05",
    "review": "G01 / R05 按用途复核",
    "boundary": "不擅自修改 G02 已确认的交互规则。",
    "tags": [
      "游戏造型",
      "动画与UI"
    ],
    "appearance": "成年男性，约45岁年龄感；长圆脸、短浓眉、眼角稍垂的深棕大眼、偏宽鼻梁；黑色及肩直发夹银丝，颈后低束，无胡须；暖橙衬衫配深蓝针织背心；数位绘图笔。",
    "portrait": "assets/employees/G04.png",
    "thumb": "assets/thumbs/G04.webp"
  },
  {
    "id": "G05",
    "name": "白若棠",
    "short": "测试 / 评估",
    "title": "游戏测试兼体验评估",
    "team": "game",
    "summary": "功能、异常、体验、兼容、性能、存档与复测。",
    "task": "首关测试与返修复测",
    "input": "G03 构建、验收项与测试环境",
    "output": "问题单、复测记录与体验结论",
    "next": "G03 返修 / G01 汇总",
    "review": "独立测试执行记录",
    "boundary": "未运行、未试玩的内容明确标待验证。",
    "tags": [
      "探索测试",
      "体验诊断"
    ],
    "appearance": "成年女性，约35岁年龄感；圆方脸、细长眉尾、黑色单眼皮、小鼻尖，左侧酒窝；深棕高束卷马尾，前额两缕短卷；青蓝运动衬衫配浅沙夹克；带空白检查格的测试记录板。",
    "portrait": "assets/employees/G05.png",
    "thumb": "assets/thumbs/G05.webp"
  }
];
