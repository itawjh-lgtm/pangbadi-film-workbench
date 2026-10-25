/* Local planning templates. These describe work; they do not execute agents. */
(function (root, factory) {
  'use strict';
  const templates = factory();
  if (typeof module === 'object' && module.exports) module.exports = templates;
  if (root) root.STUDIO_TEMPLATES = templates;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const hybrid = {
    id: 'hybrid', title: '影视 × 游戏联动', kind: 'hybrid',
    description: '共用故事基准，关卡与分镜并行，再交原型与独立复核。',
    members: ['R02', 'R03', 'R04', 'G01', 'G02', 'G03', 'G05'],
    decisions: [{key: 'direction', title: '首关优先采用哪种体验？', options: ['探索解谜', '分支叙事']}],
    tasks: [
      {key: 'research', title: '资料研究与来源清单', ownerId: 'R02', reviewerId: 'R03', dependencies: [], deliverable: '带出处的资料索引、事实与创作设定分栏', acceptance: '每条关键事实可追溯；未核实内容明确标记。'},
      {key: 'story', title: '故事与世界设定', ownerId: 'R03', reviewerId: 'R04', dependencies: ['research'], deliverable: '故事节拍、人物目标与共享世界设定', acceptance: '核心冲突清楚，游戏与影视使用同一版人物和世界规则。'},
      {key: 'level', title: '首关流程与玩家体验', ownerId: 'G02', reviewerId: 'G01', dependencies: ['story'], decisionKey: 'direction', deliverable: '目标、线索、交互、失败与恢复流程', acceptance: '首关目标可理解，关键路径、反馈与恢复方式明确。'},
      {key: 'storyboard', title: '15 秒宣传片分镜', ownerId: 'R04', reviewerId: 'R03', dependencies: ['story'], decisionKey: 'direction', deliverable: '镜头表、画面意图与声画节奏', acceptance: '故事和视觉基准一致；时长合计清楚，未生成镜头不冒充成片。'},
      {key: 'prototype', title: '可玩原型与构建交接', ownerId: 'G03', reviewerId: 'G05', dependencies: ['level'], deliverable: '可运行候选、版本说明与已知问题', acceptance: '关键路径实际运行，构建版本和环境可复现。'},
      {key: 'review', title: '双线复核与验收候选', ownerId: 'G05', reviewerId: 'G01', dependencies: ['prototype', 'storyboard'], deliverable: '缺陷记录、复测证据与验收待办', acceptance: '实际测试记录与证据对应；影视播放、素材权利及发布核验单列待办。'}
    ]
  };
  const film = {
    id: 'film', title: '影视短片', kind: 'film',
    description: '资料、故事、分镜、视觉方案与交付检查按依赖推进。',
    members: ['R02', 'R03', 'R04', 'R05', 'R06', 'R09', 'R11', 'R13'],
    decisions: [{key: 'direction', title: '本片优先采用哪种叙事方式？', options: ['人物故事', '概念展示']}],
    tasks: [
      {key: 'research', title: '资料与权利待核清单', ownerId: 'R02', reviewerId: 'R13', dependencies: [], deliverable: '资料来源与素材使用边界', acceptance: '事实有出处；授权状态和待核问题逐项列出。'},
      {key: 'script', title: '短片故事与文稿', ownerId: 'R03', reviewerId: 'R04', dependencies: ['research'], deliverable: '可连续阅读的故事正文与旁白', acceptance: '表达核心、受众入口和结尾清楚，时长适配。'},
      {key: 'shots', title: '分镜与预演方案', ownerId: 'R04', reviewerId: 'R11', dependencies: ['script'], decisionKey: 'direction', deliverable: '逐镜画面、动作与声音意图', acceptance: '每镜服务叙事，输入输出与镜号完整。'},
      {key: 'visual', title: '视觉基准与影像候选', ownerId: 'R05', reviewerId: 'R06', dependencies: ['shots'], deliverable: '角色、场景、材质基准与小样', acceptance: '小样实际生成后检查一致性，未生成内容标待制作。'},
      {key: 'master', title: '母版检查与验收候选', ownerId: 'R09', reviewerId: 'R11', dependencies: ['visual'], deliverable: '播放与技术检查记录、交付清单', acceptance: '成片完整播放；声音、字幕、比例和版本有实际验证证据。'}
    ]
  };
  const game = {
    id: 'game', title: '独立游戏原型', kind: 'game',
    description: '从体验目标开始，关卡与视觉协作，程序实现后独立测试。',
    members: ['G01', 'G02', 'G03', 'G04', 'G05'],
    decisions: [{key: 'direction', title: '第一版原型优先验证什么？', options: ['核心交互', '关卡节奏']}],
    tasks: [
      {key: 'brief', title: '体验目标与范围', ownerId: 'G01', reviewerId: 'G02', dependencies: [], deliverable: '玩家、设备、输入和核心体验说明', acceptance: '明确第一版验证问题与暂缓内容。'},
      {key: 'level', title: '关卡流程与交互规格', ownerId: 'G02', reviewerId: 'G01', dependencies: ['brief'], decisionKey: 'direction', deliverable: '目标、流程、反馈与恢复规则', acceptance: '教学、挑战与恢复形成完整可测路径。'},
      {key: 'art', title: '视觉资产与界面规格', ownerId: 'G04', reviewerId: 'G03', dependencies: ['level'], deliverable: '资源清单、尺寸、状态与视觉小样', acceptance: '资产辨识清楚，尺寸、命名和运行限制可交接。'},
      {key: 'build', title: '可玩构建', ownerId: 'G03', reviewerId: 'G05', dependencies: ['level', 'art'], deliverable: '实际可运行版本与已知问题', acceptance: '输入、状态、失败与恢复路径可运行。'},
      {key: 'test', title: '独立测试与体验评估', ownerId: 'G05', reviewerId: 'G01', dependencies: ['build'], deliverable: '复现步骤、严重度与回归证据', acceptance: '关键缺陷实际复测，待验证项明确；自检不能写成独立复核。'}
    ]
  };
  return {hybrid, film, game};
});
