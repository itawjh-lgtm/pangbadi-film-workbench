'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const StudioStore = require('../lib/store.js');
const templates = require('../data/project-templates.js');
const employees = [
  ...Array.from({length: 16}, (_, index) => ({id: 'R' + String(index + 1).padStart(2, '0')})),
  ...Array.from({length: 5}, (_, index) => ({id: 'G0' + (index + 1)}))
];
const KEY = 'creative-workbench-v3';
class MemoryStorage {
  constructor(entries = []) {this.values = new Map(entries); this.fail = false; this.writeCount = 0;}
  getItem(key) {return this.values.get(key) || null;}
  setItem(key, value) {this.writeCount++; if (this.fail) throw new Error('quota'); this.values.set(key, value);}
}
const idle = () => new Promise(resolve => setImmediate(resolve));
const makeStore = (options = {}) => StudioStore.create(employees, {storage: new MemoryStorage(), host: null, ...options});
function succeed(store, action) {const result = store.dispatch(action); assert.equal(result.ok, true, result.error); return result;}
function approve(store) {return succeed(store, {type: 'DECIDE', id: 'demo-direction', choice: '探索解谜', reason: '手动确认，先验证线索体验。'});}
function complete(store, taskId) {return succeed(store, {type: 'UPDATE_TASK', id: taskId, status: 'done', evidence: '手动登记：成果路径与验证记录。', reviewNote: '复核人已核对本轮输入、输出与验收条件。'});}
function browserStore(storage, host) {
  const listeners = new Map();
  const window = {localStorage: storage, openai: host, addEventListener(name, fn) {listeners.set(name, fn);}};
  const context = vm.createContext({window, globalThis: window, console, TextEncoder, Date, Promise});
  for (const filename of ['data/project-templates.js', 'lib/store.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
  return {store: window.StudioStore.create(employees), emit(widgetState) {listeners.get('openai:set_globals')?.({detail: {globals: {widgetState}}});}};
}

test('示例完成记录明确是示例，首关仍等待真实的手动拍板', () => {
  const state = StudioStore.initialState(employees);
  assert.equal(state.version, 3);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].isDemo, true);
  assert.equal(state.projects[0].members.length, 7);
  assert.equal(state.tasks.filter(task => task.status === 'done').length, 2);
  for (const task of state.tasks.filter(task => task.status === 'done')) assert.match(task.evidence, /示例/);
  assert.equal(state.decisions[0].status, 'pending');
  assert.ok(state.messages.every(message => message.isExample));
  assert.ok(state.artifacts.every(artifact => artifact.source === 'example'));
  assert.ok(state.tasks.every(task => task.ownerId !== task.reviewerId));
});

test('v2 只迁移 UI 与旧演示记录，不采信 demoStep 或 approved', () => {
  const state = StudioStore.migrate({version: 2, revision: 33, demoStep: 6, approved: true, rework: false, favorites: ['R02', 'bad', 'R02'], query: '灯塔', filter: 'game', view: 'activity', records: [{label: '演示拍板', detail: '已通过', time: 123}]}, employees);
  assert.deepEqual(state.favorites, ['R02']);
  assert.equal(state.query, '灯塔');
  assert.equal(state.filter, 'game');
  assert.equal(state.revision, 33);
  assert.equal(state.decisions[0].status, 'pending');
  assert.equal(state.tasks.filter(task => task.status === 'done').length, 2);
  assert.match(state.activity.at(-1).detail, /不能作为完成证据/);
  assert.equal(StudioStore.migrate({version: 77}, employees), null);
});

test('坏数据被清洗：非法人物、跨项目依赖、循环、伪造角色回复和远端图片', () => {
  const dirty = StudioStore.initialState(employees);
  dirty.favorites.push('__proto__', 'missing', 'R02', 'R02');
  dirty.projects[0].title = '<script>alert(1)</script>标题\u0000';
  dirty.tasks.push({...dirty.tasks[0], id: 'bad-owner', ownerId: 'R99'});
  dirty.tasks.push({...dirty.tasks[0], id: 'same-reviewer', reviewerId: dirty.tasks[0].ownerId});
  dirty.tasks[0].dependencies = [dirty.tasks[1].id];
  dirty.tasks[0].status = 'done';
  dirty.tasks[1].dependencies = [dirty.tasks[0].id, 'missing', dirty.tasks[1].id];
  dirty.tasks[2].status = 'done';
  dirty.tasks[2].evidence = '声称完成';
  dirty.tasks[2].reviewNote = '声称通过';
  dirty.messages.push({id: 'fake-ai', projectId: dirty.projects[0].id, peerId: null, authorId: 'R02', text: '我刚刚实际完成了调研', time: Date.now(), isExample: false});
  dirty.artifacts.push({id: 'remote-image', projectId: dirty.projects[0].id, title: '图', type: 'image', url: 'javascript:alert(1)', body: '', source: 'manual'});
  const clean = StudioStore.normalize(dirty, employees);
  assert.deepEqual(clean.favorites, ['R02']);
  assert.doesNotMatch(clean.projects[0].title, /\u0000/);
  assert.equal(clean.projects[0].title, '<script>alert(1)</script>标题');
  assert.equal(clean.tasks.some(task => ['bad-owner', 'same-reviewer'].includes(task.id)), false);
  assert.equal(clean.tasks.find(task => task.id === 'demo-level').status, 'queued');
  assert.equal(clean.tasks.find(task => task.id === 'demo-story').status, 'queued');
  assert.equal(clean.messages.some(message => message.id === 'fake-ai'), false);
  assert.equal(clean.artifacts.at(-1).url, undefined);
  assert.equal(clean.artifacts.at(-1).type, 'document');
  const circular = (start, target, visited = new Set()) => {
    if (visited.has(start)) return false;
    visited.add(start);
    return clean.tasks.find(task => task.id === start).dependencies.some(dependency => dependency === target || circular(dependency, target, visited));
  };
  for (const task of clean.tasks) assert.equal(circular(task.id, task.id), false);
  assert.equal(StudioStore.normalize({version: 3, truncated: true}, employees), null);
  assert.equal(StudioStore.normalize(null, employees), null);
});

test('恢复 done 时再次核对证据、依赖与决策；不能只信存储状态', () => {
  const dirty = StudioStore.initialState(employees);
  dirty.tasks[0].evidence = '   ';
  const clean = StudioStore.normalize(dirty, employees);
  assert.equal(clean.tasks[0].status, 'queued');
  assert.equal(clean.tasks[1].status, 'queued');
  const active = StudioStore.initialState(employees);
  active.tasks[2].status = 'review';
  assert.equal(StudioStore.normalize(active, employees).tasks[2].status, 'queued');
});

test('任务门禁阻止越过依赖或决策，错误不改变状态', () => {
  const store = makeStore();
  const before = store.getState().revision;
  assert.match(store.blockers('demo-level').join(''), /等待你拍板/);
  let result = store.dispatch({type: 'UPDATE_TASK', id: 'demo-level', status: 'in_progress'});
  assert.equal(result.ok, false);
  assert.match(result.error, /等待你拍板/);
  assert.equal(store.getState().revision, before);
  result = store.dispatch({type: 'DECIDE', id: 'demo-direction', choice: '不是选项'});
  assert.equal(result.ok, false);
  approve(store);
  succeed(store, {type: 'UPDATE_TASK', id: 'demo-level', status: 'in_progress'});
  result = store.dispatch({type: 'UPDATE_TASK', id: 'demo-prototype', status: 'review'});
  assert.equal(result.ok, false);
  assert.match(result.error, /等待上游/);
  assert.equal(store.getState().activity.at(-2).label, '你手动拍板');
});

test('owner=reviewer、非项目成员与跨项目依赖被拒绝', () => {
  const store = makeStore();
  const first = {type: 'CREATE_TASK', projectId: 'demo-lighthouse', title: '新增', ownerId: 'R02', reviewerId: 'R02', dependencies: []};
  assert.match(store.dispatch(first).error, /必须不同/);
  assert.match(store.dispatch({...first, reviewerId: 'R16'}).error, /本项目/);
  const project = succeed(store, {type: 'CREATE_PROJECT', title: '空白项目', kind: 'film', members: ['R02', 'R03'], useTemplate: false});
  assert.match(store.dispatch({...first, reviewerId: 'R03', projectId: project.id, dependencies: ['demo-story']}).error, /同一项目/);
  const result = succeed(store, {...first, reviewerId: 'R03'});
  assert.equal(store.getState().tasks.find(task => task.id === result.id).status, 'queued');
});

test('done 必须同时有成果证据与本轮复核记录', () => {
  const store = makeStore(); approve(store);
  assert.match(store.dispatch({type: 'UPDATE_TASK', id: 'demo-level', status: 'done'}).error, /证据/);
  assert.match(store.dispatch({type: 'UPDATE_TASK', id: 'demo-level', status: 'done', evidence: '已上传文档'}).error, /复核/);
  complete(store, 'demo-level');
  assert.equal(store.getState().tasks.find(task => task.id === 'demo-level').status, 'done');
  assert.equal(store.dispatch({type: 'UPDATE_TASK', id: 'demo-level', evidence: ''}).ok, false);
});

test('上游返修使传递下游失效，保留证据并要求新复核', () => {
  const store = makeStore(); approve(store);
  for (const task of ['demo-level', 'demo-storyboard', 'demo-prototype', 'demo-review']) complete(store, task);
  succeed(store, {type: 'UPDATE_TASK', id: 'demo-level', status: 'rework', reviewNote: '关卡目标不清楚'});
  for (const taskId of ['demo-prototype', 'demo-review']) {
    const task = store.getState().tasks.find(item => item.id === taskId);
    assert.equal(task.status, 'queued'); assert.match(task.reviewNote, /^需复核：/); assert.match(task.evidence, /成果路径/);
  }
  complete(store, 'demo-level');
  assert.match(store.dispatch({type: 'UPDATE_TASK', id: 'demo-prototype', status: 'done'}).error, /本轮独立复核/);
  complete(store, 'demo-prototype');
  assert.equal(store.getState().tasks.find(task => task.id === 'demo-prototype').status, 'done');
});

test('退回或改动决策使关联任务及其下游重新排队', () => {
  const store = makeStore(); approve(store);
  complete(store, 'demo-level'); complete(store, 'demo-prototype');
  succeed(store, {type: 'REWORK_DECISION', id: 'demo-direction', reason: '重新比较方向'});
  assert.equal(store.getState().decisions[0].status, 'rework');
  for (const taskId of ['demo-level', 'demo-storyboard', 'demo-prototype']) assert.equal(store.getState().tasks.find(task => task.id === taskId).status, 'queued');
  assert.match(store.blockers('demo-level').join(''), /等待你拍板/);
  approve(store); complete(store, 'demo-level');
  succeed(store, {type: 'DECIDE', id: 'demo-direction', choice: '分支叙事'});
  assert.equal(store.getState().tasks.find(task => task.id === 'demo-level').status, 'queued');
});

test('便笺不能冒充模型回复，交接只记录意图', () => {
  const store = makeStore(), before = store.getState().messages.length;
  succeed(store, {type: 'SEND_MESSAGE', projectId: 'demo-lighthouse', text: '请检查这份设定', authorId: 'R02', isExample: true});
  let state = store.getState();
  assert.equal(state.messages.length, before + 1);
  assert.equal(state.messages.at(-1).authorId, 'user'); assert.equal(state.messages.at(-1).isExample, false);
  succeed(store, {type: 'HANDOFF', taskId: 'demo-story'});
  state = store.getState(); assert.equal(state.messages.length, before + 1); assert.match(state.activity.at(-1).detail, /尚未发送/);
  succeed(store, {type: 'OPEN_DM', id: 'G05'});
  succeed(store, {type: 'SEND_MESSAGE', text: '本地工位便笺'});
  assert.equal(store.getState().messages.at(-1).peerId, 'G05'); assert.equal(store.getState().messages.at(-1).projectId, null);
});

test('创建真实项目只建立待办，没有虚构职业角色发言；本地完整回读', async () => {
  const storage = new MemoryStorage(), store = makeStore({storage});
  const originalMessages = store.getState().messages.length;
  const result = succeed(store, {type: 'CREATE_PROJECT', title: '我的游戏', kind: 'game', members: templates.game.members, brief: '先做一关', useTemplate: true});
  const created = store.getState();
  assert.equal(created.projects.find(project => project.id === result.id).isDemo, false);
  assert.ok(created.tasks.filter(task => task.projectId === result.id).every(task => task.status === 'queued' && !task.evidence && !task.reviewNote));
  assert.equal(created.messages.length, originalMessages);
  succeed(store, {type: 'ADD_ARTIFACT', projectId: result.id, title: '设计草稿', body: '手写规则', version: 'v0.2'});
  await idle();
  const reread = makeStore({storage}).getState();
  assert.equal(reread.activeProjectId, result.id);
  assert.equal(reread.artifacts.at(-1).body, '手写规则'); assert.equal(reread.artifacts.at(-1).source, 'manual');
  assert.equal(reread.tasks.filter(task => task.projectId === result.id).length, templates.game.tasks.length);
  const externalCopy = store.getState(); externalCopy.projects[0].title = '偷偷改写';
  assert.notEqual(store.getState().projects[0].title, '偷偷改写');
});

test('新建项目的协作方式按项目保存并在重新载入后带入首次协作', async () => {
  const storage=new MemoryStorage(),store=makeStore({storage});
  const created=['continuous','stepwise'].map(reviewMode=>({reviewMode,...succeed(store,{type:'CREATE_PROJECT',title:'协作方式 '+reviewMode,kind:'film',members:['R03','R04'],brief:'完成短片文稿',reviewMode,useTemplate:false})}));
  await idle();
  const reread=makeStore({storage}).getState();
  const ProductionViews=require('../lib/production-views.js');
  let starts=0;
  const client={getProductions:()=>[],getError:()=>'',isStarting:()=>false,ready:()=>true,enabled:()=>true,start:()=>{starts++;}};
  const views=ProductionViews.create(employees,client);
  for(const entry of created){
    const project=reread.projects.find(item=>item.id===entry.id);
    assert.equal(project.reviewMode,entry.reviewMode);
    const html=views.workspace(project,{});
    assert.ok(html.includes('value="'+entry.reviewMode+'" selected'));
    assert.ok(!reread.tasks.some(task=>task.projectId===entry.id));
  }
  assert.equal(starts,0);
});

test('旧项目与无效协作方式默认逐步审核，不被升级为连续执行', () => {
  for(const reviewMode of [undefined,null,'auto','',{},true]){
    const state=StudioStore.initialState(employees);
    state.projects[0].reviewMode=reviewMode;
    assert.equal(StudioStore.normalize(state,employees).projects[0].reviewMode,'stepwise');
    const store=makeStore();
    const created=succeed(store,{type:'CREATE_PROJECT',title:'兼容项目',kind:'film',members:['R03','R04'],reviewMode});
    assert.equal(store.getState().projects.find(project=>project.id===created.id).reviewMode,'stepwise');
  }
});

test('项目主展示选择持久化、严格归一化且不改变任务验收状态', async () => {
  const storage=new MemoryStorage(),store=makeStore({storage});
  const created=succeed(store,{type:'CREATE_PROJECT',title:'作品展台',kind:'film',members:['R03','R04']});
  const beforeTasks=store.getState().tasks;
  succeed(store,{type:'SET_PROJECT_SHOWCASE',projectId:created.id,resultShowcase:{jobId:'media-1',outputIndex:0,final:true,ignored:'discard'}});
  await idle();
  const reread=makeStore({storage}).getState();
  assert.deepEqual(reread.projects.find(p=>p.id===created.id).resultShowcase,{jobId:'media-1',outputIndex:0,final:true});
  assert.deepEqual(store.getState().tasks,beforeTasks);
  for(const invalid of [{jobId:'../bad',outputIndex:0,final:false},{jobId:'ok',outputIndex:-1,final:false},{jobId:'ok',outputIndex:0.5,final:false},{jobId:'ok',outputIndex:'0',final:false},{jobId:'ok',outputIndex:0,final:'true'}]){
    const before=store.getState();
    assert.equal(store.dispatch({type:'SET_PROJECT_SHOWCASE',projectId:created.id,resultShowcase:invalid}).ok,false);
    assert.deepEqual(store.getState(),before);
  }
  const dirty=store.getState();dirty.projects.find(p=>p.id===created.id).resultShowcase={jobId:'ok',outputIndex:0,final:'true'};
  assert.equal(StudioStore.normalize(dirty,employees).projects.find(p=>p.id===created.id).resultShowcase.final,false);
  succeed(store,{type:'SET_PROJECT_SHOWCASE',projectId:created.id,resultShowcase:null});
  assert.equal(store.getState().projects.find(p=>p.id===created.id).resultShowcase,null);
});

test('已删除项目不可设置主展示',()=>{
  const store=makeStore({isDeleted:()=>true});
  assert.equal(store.dispatch({type:'SET_PROJECT_SHOWCASE',projectId:store.getState().projects[0].id,resultShowcase:{jobId:'media-1',outputIndex:0,final:false}}).ok,false);
});

test('HTML、XML 和提示词标签作为文字往返保留，不执行也不删改', async () => {
  const storage = new MemoryStorage(), store = makeStore({storage});
  const content = '<h1>标题</h1>\n<scene id="灯塔">角色走近门口。</scene>\n<script>globalThis.__studio_text_must_not_execute = true;</script>\n3 < 5 && 8 > 6';
  succeed(store, {type: 'SEND_MESSAGE', projectId: 'demo-lighthouse', text: content});
  succeed(store, {type: 'ADD_ARTIFACT', projectId: 'demo-lighthouse', title: '<scene>镜头提示词</scene>', body: content});
  assert.equal(store.getState().messages.at(-1).text, content);
  assert.equal(store.getState().artifacts.at(-1).body, content);
  await idle();
  const restored = makeStore({storage}).getState();
  assert.equal(restored.messages.at(-1).text, content);
  assert.equal(restored.artifacts.at(-1).body, content);
  assert.equal(restored.artifacts.at(-1).title, '<scene>镜头提示词</scene>');
  assert.equal(globalThis.__studio_text_must_not_execute, undefined);
});

test('新项目至少有制作与复核两位伙伴，已有单成员项目仍保留', () => {
  const store = makeStore();
  const before = store.getState();
  const rejected = store.dispatch({type: 'CREATE_PROJECT', title: '单人空白项目', kind: 'film', members: ['R02'], useTemplate: false});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, '至少选择两位项目伙伴，分别承担制作与复核');
  assert.equal(store.getState().projects.length, before.projects.length);
  assert.equal(store.dispatch({type: 'CREATE_PROJECT', title: '重复成员', kind: 'film', members: ['R02', 'R02'], useTemplate: false}).ok, false);
  const created = succeed(store, {type: 'CREATE_PROJECT', title: '双人空白项目', kind: 'film', members: ['R02', 'R03'], useTemplate: false});
  succeed(store, {type: 'CREATE_TASK', projectId: created.id, title: '资料整理', ownerId: 'R02', reviewerId: 'R03', dependencies: []});
  const existing = StudioStore.initialState(employees);
  existing.projects[0].members = ['R02'];
  const normalized = StudioStore.normalize(existing, employees);
  assert.equal(normalized.projects.length, 1);
  assert.equal(normalized.projects[0].id, 'demo-lighthouse');
  assert.deepEqual(normalized.projects[0].members, ['R02']);
});

test('上限明确拒绝，自动操作记录保留最近 80 条', () => {
  const store = makeStore();
  for (let index = 0; index < 90; index++) succeed(store, {type: 'HANDOFF', taskId: 'demo-story'});
  assert.equal(store.getState().activity.length, 80);
  for (let index = store.getState().messages.length; index < 80; index++) succeed(store, {type: 'SEND_MESSAGE', text: '便笺 ' + index});
  assert.match(store.dispatch({type: 'SEND_MESSAGE', text: '超限'}).error, /80/);
  for (let index = store.getState().artifacts.length; index < 40; index++) succeed(store, {type: 'ADD_ARTIFACT', projectId: 'demo-lighthouse', title: '草稿 ' + index, body: '正文'});
  assert.match(store.dispatch({type: 'ADD_ARTIFACT', projectId: 'demo-lighthouse', title: '超限'}).error, /40/);
});

test('存储写入失败会通知 UI，不能宣称刷新后可恢复', async () => {
  const storage = new MemoryStorage(); storage.fail = true;
  const store = makeStore({storage}), notices = [];
  const unsubscribe = store.subscribe((state, persistence) => notices.push({...persistence}));
  succeed(store, {type: 'TOGGLE_FAVORITE', id: 'R02'});
  assert.equal(store.persistence.pending, true);
  await idle();
  assert.equal(store.persistence.local, false); assert.equal(store.persistence.host, false); assert.equal(store.persistence.pending, false);
  assert.ok(notices.some(notice => notice.pending));
  assert.ok(notices.some(notice => !notice.pending && !notice.local && !notice.host));
  unsubscribe();
});

test('初始化只读可用性，不写 local 或 host，也不误报保存失败', async () => {
  const storage = new MemoryStorage(), writes = [];
  const host = {widgetState: null, async setWidgetState(value) {writes.push(value);}};
  const store = makeStore({storage, host});
  assert.equal(store.persistence.local, true);
  assert.equal(store.persistence.attempted, false);
  assert.equal(store.persistence.pending, false);
  await idle();
  assert.equal(storage.writeCount, 0); assert.equal(writes.length, 0);
  const inaccessible = makeStore({storage: {getItem() {throw new Error('SecurityError');}, setItem() {throw new Error('SecurityError');}}});
  assert.equal(inaccessible.persistence.local, false);
  assert.equal(inaccessible.persistence.attempted, false);
  assert.equal(inaccessible.persistence.pending, false);
});

test('宿主恢复仅缓存 local，不回写 host；只有用户 dispatch 后写 host', async () => {
  const storage = new MemoryStorage(), writes = [];
  const host = {widgetState: null, async setWidgetState(value) {writes.push(value); this.widgetState = value;}};
  const {store, emit} = browserStore(storage, host);
  await idle(); assert.equal(writes.length, 0);
  const restored = StudioStore.initialState(employees); restored.revision = 18; restored.query = '恢复中的界面';
  emit({privateContent: {studioV3: restored}});
  await idle();
  assert.equal(writes.length, 0);
  assert.equal(JSON.parse(storage.getItem(KEY)).query, '恢复中的界面');
  assert.equal(store.getState().revision, 18);
  succeed(store, {type: 'TOGGLE_FAVORITE', id: 'R02'});
  await idle(); assert.equal(writes.length, 1);
  assert.equal(writes[0].privateContent.studioV3.revision, 19);
  const newer = StudioStore.initialState(employees); newer.revision = 21;
  emit({privateContent: {studioV3: newer}});
  await idle(); assert.equal(writes.length, 1);
});

test('异步保存反馈不递增 revision，UI 可跳过重绘以保留未提交表单', async () => {
  const store = makeStore(), revisions = [];
  let renderedRevision = store.getState().revision, renderCount = 0, draft = '';
  store.subscribe(state => {
    revisions.push(state.revision);
    if (state.revision === renderedRevision) return;
    renderedRevision = state.revision; renderCount++; draft = '';
  });
  succeed(store, {type: 'NAVIGATE', view: 'project'});
  draft = '保存反馈到达前，用户新写的未提交文字';
  await idle();
  assert.ok(revisions.length >= 2);
  assert.ok(revisions.every(revision => revision === 1));
  assert.equal(renderCount, 1);
  assert.match(draft, /未提交文字/);
  assert.equal(store.persistence.attempted, true);
});

test('host 超过 16 KB 时只保存指针，不能覆盖完整 local state', async () => {
  const storage = new MemoryStorage(), writes = [];
  const host = {widgetState: null, async setWidgetState(value) {writes.push(value); this.widgetState = value;}};
  const store = makeStore({storage, host});
  succeed(store, {type: 'ADD_ARTIFACT', projectId: 'demo-lighthouse', title: '长文档', body: '完整内容'.repeat(2000)});
  await idle();
  const saved = writes.at(-1), full = JSON.parse(storage.getItem(KEY));
  assert.ok(Buffer.byteLength(JSON.stringify(saved), 'utf8') < 16000);
  assert.equal(saved.privateContent.studioV3.truncated, true);
  assert.equal(saved.privateContent.studioV3.tasks, undefined);
  assert.equal(store.persistence.hostTruncated, true);
  assert.equal(full.artifacts.at(-1).body.length, 8000);
  host.widgetState.privateContent.studioV3.revision += 100;
  const restored = makeStore({storage, host}).getState();
  assert.equal(restored.artifacts.at(-1).body.length, 8000);
  assert.equal(restored.tasks.length, full.tasks.length);
});

test('较新的 host 可恢复完整状态，但事件与恢复都执行完成门禁', async () => {
  const localState = StudioStore.initialState(employees); localState.revision = 4;
  const hostState = StudioStore.initialState(employees); hostState.revision = 9; hostState.query = '较新的宿主';
  hostState.tasks[2].status = 'done'; hostState.tasks[2].evidence = '声称完成'; hostState.tasks[2].reviewNote = '声称复核';
  const storage = new MemoryStorage([[KEY, JSON.stringify(localState)]]);
  const host = {widgetState: {privateContent: {studioV3: hostState}}, async setWidgetState(value) {this.widgetState = value;}};
  const browser = browserStore(storage, host), store = browser.store;
  assert.equal(store.getState().query, '较新的宿主');
  assert.equal(store.getState().tasks[2].status, 'queued');
  const incoming = StudioStore.initialState(employees); incoming.revision = 25; incoming.query = '事件更新'; incoming.tasks[0].reviewNote = '';
  browser.emit({privateContent: {studioV3: incoming}});
  assert.equal(store.getState().query, '事件更新'); assert.equal(store.getState().tasks[0].status, 'queued');
  browser.emit({privateContent: {studioV3: {version: 3, revision: 500, truncated: true, pointerOnly: true}}});
  assert.equal(store.getState().query, '事件更新'); assert.equal(store.getState().projects.length, 1);
  await idle();
});


test('总策划审阅保存回读，历史保留且不能推进或代替任务复核', async () => {
  const storage = new MemoryStorage(), store = makeStore({storage});
  const before = store.getState().tasks;
  const artifactId = 'demo-storyboard';
  const refused = store.dispatch({type:'REVIEW_ARTIFACT', id:artifactId, choice:'changes', note:'  '});
  assert.equal(refused.ok, false);
  succeed(store, {type:'REVIEW_ARTIFACT', id:artifactId, choice:'changes', note:'缩短第一个远景，保留角色出场。'});
  succeed(store, {type:'REVIEW_ARTIFACT', id:artifactId, choice:'accepted', note:'仅认可视觉方向，动画与声音尚未检查。'});
  await idle();
  const restored = makeStore({storage}).getState();
  assert.deepEqual(restored.tasks, before);
  const art = restored.artifacts.find(a => a.id === artifactId);
  assert.equal(art.reviewStatus, 'accepted');
  assert.equal(art.reviews.length, 2);
  assert.ok(art.reviews.every(r => r.actorId === 'user'));
  assert.equal(art.reviewNote, '仅认可视觉方向，动画与声音尚未检查。');
  assert.equal(art.url, 'assets/projects/storyboard.webp');
  assert.equal(art.previewKey, 'storyboard');
});

test('视觉升级非破坏补齐旧示例，保留用户正文和任务状态且初始化不写存储', async () => {
  const old = StudioStore.initialState(employees);
  old.presentationVersion = 0;
  old.artifacts = old.artifacts.filter(a => !a.previewKey);
  old.artifacts.push({id:'user-note',projectId:'demo-lighthouse',title:'我的笔记',type:'document',source:'manual',body:'不可改动的文字',version:'v2.1',createdAt:7});
  old.favorites = ['G03'];
  const tasks = JSON.parse(JSON.stringify(old.tasks));
  const storage = new MemoryStorage([[KEY,JSON.stringify(old)]]), store = makeStore({storage});
  assert.equal(storage.writeCount, 0);
  assert.deepEqual(store.getState().tasks, tasks);
  assert.deepEqual(store.getState().favorites, ['G03']);
  assert.equal(store.getState().artifacts.find(a=>a.id==='user-note').body,'不可改动的文字');
  assert.equal(store.getState().artifacts.filter(a=>a.previewKey).length,3);
  succeed(store,{type:'NAVIGATE',view:'assets'});
  await idle();
  assert.equal(makeStore({storage}).getState().artifacts.filter(a=>a.previewKey).length,3);
});

test('真实项目隔离示例图，伪造员工审阅被清除，界面选择安全回读', async () => {
  const storage=new MemoryStorage(),store=makeStore({storage});
  const result=succeed(store,{type:'CREATE_PROJECT',title:'我的真实项目',kind:'game',members:['G01','G02'],useTemplate:false});
  succeed(store,{type:'SET_UI',selectedEmployeeId:'G02',projectTab:'tasks',selectedShot:'game',taskFilter:'blocked'});
  await idle();
  const state=makeStore({storage}).getState();
  assert.equal(state.selectedEmployeeId,'G02');assert.equal(state.projectTab,'tasks');assert.equal(state.taskFilter,'blocked');
  assert.equal(state.artifacts.filter(a=>a.projectId===result.id).length,0);
  state.artifacts.push({id:'forged-image',projectId:result.id,type:'image',source:'example',url:'assets/projects/game-level.webp',title:'伪造图',reviews:[{actorId:'G05',status:'accepted',note:'伪造专业审核',time:123}]});
  const normalized=StudioStore.normalize(state,employees),art=normalized.artifacts.at(-1);
  assert.equal(art.type,'document');assert.equal(art.url,undefined);assert.equal(art.previewKey,undefined);
  assert.deepEqual(art.reviews,[]);assert.equal(art.reviewStatus,'pending');
  assert.equal(store.dispatch({type:'SET_UI',selectedEmployeeId:'R99'}).ok,false);
});
