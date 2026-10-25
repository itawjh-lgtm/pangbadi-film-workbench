'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Profile=require('../lib/character-profile.js');
test('legacy character narrative is shown instead of raw appearance tables and generation instructions',()=>{
  const asset={name:'少女',description:'> 原作身份均待核实。\n\n### 角色视觉命题\n她是一个习惯降低存在感、但内在判断并不含糊的普通学生。\n\n### 外貌\n| 发型 | 深棕黑色短发 |\n\n### 参考图生成提示词\n高清出图，正面、侧面、背面。',prompt:'不得用作介绍的执行提示词'},before=JSON.stringify(asset);
  assert.equal(Profile.summary(asset),'她是一个习惯降低存在感、但内在判断并不含糊的普通学生。');assert.equal(JSON.stringify(asset),before);
});
test('explicit introductions and group narrative remain separate from prompts',()=>{
  assert.equal(Profile.summary({description:'- 人物介绍：年轻的文物修复师，谨慎耐心，负责发现藏在壁画中的线索。\n- 参考图生成提示词：生成要求…'}),'年轻的文物修复师，谨慎耐心，负责发现藏在壁画中的线索。');
  assert.match(Profile.summary({description:'### 数量与功能\n三位同学构成围观人群，在结尾为主角让路。\n\n### 群像差异\n| 编号 | 轮廓 |\n| A | 高个 |'}),/^三位同学/);
});
test('structured identity and personality keep uncertainty without using appearance or prompt fields',()=>{
  assert.equal(Profile.summary({fields:{identityAge:'高中生，约16—18岁，待原作核实',performance:'克制但坚韧',appearance:'圆脸',referencePrompt:'8K，正面侧面背面'}}),'高中生，约16—18岁，待原作核实；克制但坚韧');
  assert.equal(Profile.summary({description:'### 外貌\n| 年龄观感 | 约18岁，待核实 |\n| 发型 | 短发 |\n\n### 性格与表演\n沉静，善于观察。'}),'约18岁，待核实；沉静，善于观察。');
});
test('missing introductions never fall back to a prompt or a technical table',()=>{
  for(const asset of [{prompt:'必须保留的模型prompt'},{description:'人物定妆生成要求：高清出图，正面、侧面、背面，8K。'},{description:'### 外貌\n| 发型 | 短发 |\n| 服装 | 衬衫 |'}])assert.match(Profile.summary(asset),/^暂无人物介绍/);
});
test('manual plain prose is readable, bounded and does not retain markup',()=>{
  assert.equal(Profile.summary({description:'**林夏**是[档案管理员](https://example.com)，负责追查失踪案。'}),'林夏是档案管理员，负责追查失踪案。');
  assert.ok(Profile.summary({introduction:'人物经历很长'.repeat(80)}).length<=241);
});
