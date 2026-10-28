'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Runtime = require('../lib/runtime.js');
const Store = require('../lib/store.js');

const root = path.resolve(__dirname, '..');
const projectA = {id:'project-a',title:'甲项目',kind:'film',brief:'甲项目简报',members:['R03','R04'],isDemo:false,createdAt:1};
const projectB = {id:'project-b',title:'乙项目',kind:'film',brief:'乙项目简报',members:['R03','R04'],isDemo:false,createdAt:1};
const task = (id, projectId) => ({id,projectId,title:id+' 制作',ownerId:'R03',reviewerId:'R04',status:'queued',dependencies:[],decisionId:null,deliverable:'镜头成果',acceptance:'可追溯',evidence:'',reviewNote:'',updatedAt:1});
const storyboard = (projectId, suffix) => ({
  projectId,status:'ready',error:'',warnings:[],
  shots:[{id:'shot-'+suffix,title:'镜头 '+suffix,description:'画面 '+suffix,timing:'0–5s',imagePrompt:'图片提示词 '+suffix,videoPrompt:'视频提示词 '+suffix,sourceArtifactId:'source-'+suffix,promptArtifactId:'prompt-'+suffix}],
  sources:[{id:'source-'+suffix,title:'分镜修订版 '+suffix,url:'/api/artifacts/source-'+suffix},{id:'prompt-'+suffix,title:'提示词修订版 '+suffix,url:'/api/artifacts/prompt-'+suffix}]
});
const makeJob = (suffix, extra = {}) => ({
  id:'job-'+suffix,projectId:'project-'+suffix,taskId:'task-'+suffix,shotId:'shot-'+suffix,
  sourceArtifactId:'source-'+suffix,promptArtifactId:'prompt-'+suffix,name:'媒体任务 '+suffix,mediaKind:'image',
  provider:'runninghub',mode:'workflow_api',workflowId:'workflow-'+suffix,task_id:'provider-task-'+suffix,status:'succeeded',createdAt:1,
  parameters:{nodeInfoList:[{nodeId:'3',fieldName:'text',fieldValue:'画面提示词 '+suffix}]},
  outputs:[{url:'https://cdn.example.invalid/'+suffix+'.png',outputType:'png'}],...extra
});

function harness({jobs = [makeJob('a'),makeJob('b')], boards = {['project-a']:storyboard('project-a','a'),['project-b']:storyboard('project-b','b')}} = {}) {
  const win = {}, context = vm.createContext({window:win,console,URL});
  for (const file of ['data/employees.js','data/project-templates.js','lib/production-views.js','lib/views.js']) {
    vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  }
  const store = Store.create(win.TEAM_EMPLOYEES,{storage:{getItem(){return null;},setItem(){}},host:null});
  const state = {...store.getState(),view:'project',activeProjectId:projectA.id,activePeerId:null,projectTab:'assets',selectedTaskId:'task-a',projects:[projectA,projectB],tasks:[task('task-a',projectA.id),task('task-b',projectB.id)],artifacts:[],decisions:[],messages:[],activity:[]};
  const viewStore = {getState:()=>state,blockers:()=>[]};
  const runtime = {
    ready:()=>true,roles:[],connection:{state:'online',ready:true},
    media:{providers:[{id:'runninghub',label:'RunningHub',keyConfigured:true,config:{workflowId:'chosen-workflow',unitPrice:1,currency:'CNY'},models:[]}],jobs},
    artifacts:()=>[],getRuns:()=>[],getError:()=>'',getStoryboard:projectId=>boards[projectId]||{projectId,status:'idle',shots:[],sources:[],warnings:[],error:''},artifactURL:Runtime.artifactURL
  };
  return {views:win.StudioViews.create(win.TEAM_EMPLOYEES,viewStore,runtime),state,runtime};
}

function assertProjectMedia(html, included, excluded) {
  assert.ok(html.includes('https://cdn.example.invalid/'+included+'.png'),'selected project output is visible');
  for (const value of ['https://cdn.example.invalid/'+excluded+'.png','job-'+excluded,'provider-task-'+excluded,'/api/artifacts/source-'+excluded]) {
    assert.ok(!html.includes(value),'other project data must be absent: '+value);
  }
}

test('project discussion exposes collapse and restore controls while preserving its draft and project records',()=>{
  const {views,state}=harness(),before=JSON.stringify(state),draft='保留尚未发送的协作意见';
  for(const projectTab of ['production','overview','storyboard','assets','tasks','versions']){
    const selected={...state,projectTab};
    const expanded=views.collaboration(selected,draft,{discussionCollapsed:false});
    assert.ok(expanded.includes('data-action="project-discussion-toggle" aria-controls="project-discussion" aria-expanded="true">收起协作'));
    assert.ok(expanded.includes('<aside class="project-discussion" id="project-discussion">'));
    const collapsed=views.collaboration(selected,draft,{discussionCollapsed:true});
    assert.ok(collapsed.includes('class="project-review-layout is-discussion-collapsed"'));
    assert.ok(collapsed.includes('data-action="project-discussion-toggle" aria-controls="project-discussion" aria-expanded="false">展开协作'));
    assert.ok(collapsed.includes('<aside class="project-discussion" id="project-discussion" hidden>'));
    assert.ok(collapsed.includes(draft));assert.ok(!collapsed.includes('>收起协作</button>'));
  }
  assert.equal(JSON.stringify(state),before);
});

test('project discussion collapse does not add a panel or toggle to character assets canvas or independent workstations',()=>{
  const {views,state}=harness();
  for(const projectTab of ['characters','canvas'])for(const discussionCollapsed of [false,true]){
    const html=views.collaboration({...state,projectTab},'',{discussionCollapsed});
    assert.ok(!html.includes('data-action="project-discussion-toggle"'));assert.ok(!html.includes('id="project-discussion"'));assert.ok(!html.includes('is-discussion-collapsed'));
    assert.ok(html.includes(projectTab==='canvas'?'data-canvas-root':'data-character-assets-root'));
  }
  const workstation=views.collaboration({...state,activePeerId:'R03'},'',{discussionCollapsed:true});
  assert.ok(!workstation.includes('data-action="project-discussion-toggle"'));assert.ok(workstation.includes('class="collaboration-layout"'));
});

test('project media stays within its project in assets, tasks and the shared asset library', () => {
  const {views,state} = harness();
  for (const [selected,other] of [['a','b'],['b','a']]) {
    const selectedState = {...state,activeProjectId:'project-'+selected,selectedTaskId:'task-'+selected};
    assertProjectMedia(views.collaboration({...selectedState,projectTab:'assets'}),selected,other);
    const queue=views.collaboration({...selectedState,projectTab:'tasks'});
    assert.ok(queue.includes('data-media-task-id="job-'+selected+'"'));
    assert.ok(!queue.includes('data-media-task-id="job-'+other+'"'));
    assert.ok(!queue.includes('https://cdn.example.invalid/'),'queue links to results instead of duplicating previews');
    assert.ok(queue.includes('data-action="media-view-result"')); 
    assertProjectMedia(views.artifacts(selectedState),selected,other);
  }
});

test('connections only shows provider configuration, not global media jobs or output previews', () => {
  const {views,state} = harness();
  const html = views.connections(state);
  for (const value of ['job-a','job-b','provider-task-a','provider-task-b','https://cdn.example.invalid/a.png','https://cdn.example.invalid/b.png','data-form="media-estimate"']) assert.ok(!html.includes(value),'configuration view must not contain '+value);
  assert.ok(html.includes('runninghub-config'));
});

test('legacy jobs without shot attribution remain in their project without appearing on a shot', () => {
  const legacy = makeJob('a',{id:'legacy-job',name:'旧生成结果',shotId:null,sourceArtifactId:null,promptArtifactId:null,outputs:[{url:'https://cdn.example.invalid/legacy.png',outputType:'png'}]});
  const {views,state} = harness({jobs:[legacy]});
  assert.ok(views.collaboration({...state,projectTab:'assets'}).includes('https://cdn.example.invalid/legacy.png'));
  const queue=views.collaboration({...state,projectTab:'tasks'});
  assert.ok(queue.includes('data-media-task-id="legacy-job"'));
  assert.ok(!queue.includes('https://cdn.example.invalid/legacy.png')); 
  assert.ok(!views.collaboration({...state,projectTab:'storyboard'}).includes('https://cdn.example.invalid/legacy.png'));
  assert.ok(!views.collaboration({...state,activeProjectId:'project-b',projectTab:'assets'}).includes('legacy.png'));
});

test('storyboard shows source artifact versions and only the selected project and shot results', () => {
  const otherShot = makeJob('a',{id:'job-other-shot',shotId:'different-shot',outputs:[{url:'https://cdn.example.invalid/other-shot.png',outputType:'png'}]});
  const {views,state} = harness({jobs:[makeJob('a'),makeJob('b'),otherShot]});
  const html = views.collaboration({...state,projectTab:'storyboard'});
  assertProjectMedia(html,'a','b');
  assert.ok(!html.includes('https://cdn.example.invalid/other-shot.png'));
  assert.ok(html.includes('/api/artifacts/source-a'));
  assert.ok(html.includes('/api/artifacts/prompt-a'));
  assert.ok(html.includes('图片提示词 a'));
  assert.ok(html.includes('视频提示词 a'));
  assert.ok(!html.includes('图片提示词 b'));
});

test('an older source revision with the same shot ID stays in assets instead of masquerading as the current shot', () => {
  const oldVersion = makeJob('a',{id:'job-old-revision',sourceArtifactId:'source-a-old',promptArtifactId:'prompt-a-old',outputs:[{url:'https://cdn.example.invalid/old-revision.png',outputType:'png'}]});
  const {views,state} = harness({jobs:[makeJob('a'),oldVersion]});
  assert.ok(views.collaboration({...state,projectTab:'assets'}).includes('https://cdn.example.invalid/old-revision.png'));
  const html = views.collaboration({...state,projectTab:'storyboard'});
  assert.ok(html.includes('https://cdn.example.invalid/a.png'));
  assert.ok(!html.includes('https://cdn.example.invalid/old-revision.png'));
});

test('regenerating only the prompt document also separates current and historical shot media', () => {
  const oldPrompt = makeJob('a',{id:'job-old-prompt',promptArtifactId:'prompt-a-old',outputs:[{url:'https://cdn.example.invalid/old-prompt.png',outputType:'png'}]});
  const {views,state} = harness({jobs:[makeJob('a'),oldPrompt]});
  const current = views.collaboration({...state,projectTab:'storyboard'});
  assert.ok(current.includes('https://cdn.example.invalid/a.png'));
  assert.ok(!current.includes('https://cdn.example.invalid/old-prompt.png'));
  const assets = views.collaboration({...state,projectTab:'assets'});
  assert.ok(assets.includes('https://cdn.example.invalid/old-prompt.png'));
  assert.ok(assets.includes('href="/api/artifacts/prompt-a-old"'));
});

test('an open composer keeps its project task choices and edited prompt independent of the selected project', () => {
  const {views,state} = harness();
  state.activeProjectId = projectB.id;
  const prompt = '保留换行\n  夜色下的白色纸船\n</textarea><img src=x onerror=alert(1)>';
  const context = {projectId:projectA.id,mediaKind:'video',shotId:'shot-a',sourceArtifactId:'source-a',promptArtifactId:'prompt-a'};
  const html = views.projectMediaComposer(projectA,context,prompt);
  assert.ok(html.includes('关联项目：甲项目'));
  assert.ok(html.includes('name="mediaKind" value="video"'));
  assert.ok(html.includes('value="task-a"'));
  assert.ok(!html.includes('value="task-b"'));
  assert.ok(html.includes('保留换行\n  夜色下的白色纸船\n&lt;/textarea&gt;'));
  assert.ok(!html.includes('</textarea><img src=x'));
  const quote = views.mediaEstimateDetails({...context,name:'本镜头视频',workflowId:'123',nodeInfoList:[],budget:1},{known:true,estimatedCost:0.5,currency:'CNY',quantity:1,withinBudget:true});
  assert.ok(quote.includes('<dd>甲项目</dd>'));
  assert.ok(!quote.includes('<dd>乙项目</dd>'));
  assert.ok(quote.includes('本镜头视频 · shot-a'));
});

test('media previews allow real HTTPS video controls, reject unsafe URLs and escape task data', () => {
  const unsafe = ['javascript:alert(1)','data:text/html,<script>alert(1)</script>','file:///tmp/private.png','https://user:password@cdn.example.invalid/a.png','//cdn.example.invalid/a.png'];
  const injection = '</textarea><img src=x onerror=alert(1)>';
  const job = makeJob('a',{name:injection,error:injection,parameters:{prompt:injection},outputs:[{url:'https://cdn.example.invalid/a.mp4',outputType:'mp4'},...unsafe.map(url=>({url,outputType:'image'}))]});
  const {views,state} = harness({jobs:[job]});
  const html = views.collaboration({...state,projectTab:'assets'});
  assert.match(html,/<video\b(?=[^>]*\bcontrols\b)(?=[^>]*src="https:\/\/cdn\.example\.invalid\/a\.mp4")/);
  assert.ok(!html.includes('autoplay'));
  assert.ok(html.includes('<a href="/assets/media-preview.html?job=job-a" target="_blank" rel="noopener noreferrer">放大播放 ↗</a>'));
  assert.ok(html.includes('下载视频 ↓'));
  assert.ok(html.includes('data-media-fallback'));
  assert.ok(html.includes('&lt;/textarea&gt;'));
  assert.ok(!html.includes(injection));
  for (const url of unsafe) assert.ok(!html.includes('src="'+url)&&!html.includes('href="'+url),'unsafe media URL cannot be active: '+url);
});

test('expanded video playback encodes the task ID and does not appear on image cards', () => {
  const id='job/中文?x=1&next=" onmouseover="alert(1)#end';
  const {views,state}=harness({jobs:[makeJob('a',{id,mediaKind:'video',outputs:[{url:'https://cdn.example.invalid/safe.mp4',outputType:'video/mp4'}]})]});
  const html=views.collaboration({...state,projectTab:'assets'});
  assert.ok(html.includes('href="/assets/media-preview.html?job='+encodeURIComponent(id)+'" target="_blank" rel="noopener noreferrer">放大播放 ↗</a>'));
  assert.ok(!html.includes(' onmouseover="alert(1)'));
  const imageOnly=harness({jobs:[makeJob('a')]});
  assert.ok(!imageOnly.views.collaboration({...imageOnly.state,projectTab:'assets'}).includes('/assets/media-preview.html?job='));
});

test('images open an accessible in-page preview with download kept as a separate action',()=>{
  const {views,state}=harness({jobs:[makeJob('a',{name:'角色 "A" <定妆>'})]});
  const html=views.collaboration({...state,projectTab:'assets'});
  assert.match(html,/<img\b(?=[^>]*role="button")(?=[^>]*tabindex="0")(?=[^>]*data-image-preview="https:\/\/cdn\.example\.invalid\/a\.png")/);
  assert.match(html,/<button type="button"[^>]*data-image-preview="[^"]+"[^>]*>查看大图<\/button>/);
  assert.match(html,/<a [^>]*download>下载原图 ↓<\/a>/);
  assert.ok(html.includes('data-image-title="角色 &quot;A&quot; &lt;定妆&gt; · 1"'));
  assert.ok(!html.includes('下载 / 打开原文件'));
  assert.ok(!/<a[^>]*>\s*<img/.test(html),'clicking the thumbnail cannot navigate to an attachment URL');
});

test('storyboard sources only create links to local artifact endpoints', () => {
  const board = storyboard('project-a','a');
  const invalidSources = ['javascript:alert(1)','https://example.invalid/redirect','/api/artifacts/..','/api/artifacts/%2e%2e','/api/artifacts/abc%2f..'];
  board.sources.push(...invalidSources.map((url,index)=>({id:'invalid-'+index,title:'<svg onload=alert(1)>',url})));
  board.shots.push({...board.shots[0],id:'unsafe-shot',sourceArtifactId:'..',promptArtifactId:'abc%2f..'});
  const {views,state} = harness({boards:{'project-a':board}});
  const html = views.collaboration({...state,projectTab:'storyboard'});
  assert.ok(html.includes('href="/api/artifacts/source-a"'));
  for (const url of invalidSources) assert.ok(!html.includes('href="'+url+'"'));
  assert.ok(!html.includes('<svg onload='));
});

function deferred() {
  let resolve;
  const promise = new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

function runtimeHarness(storyboardFetch) {
  return Runtime.create({setTimeout:()=>1,clearTimeout(){},fetch:async url=>({ok:true,json:async()=>{
    if(url==='/api/health')return {ok:true,service:'dream-studio-runtime',csrfToken:'fake-csrf',provider:{available:false,authenticated:false}};
    if(url==='/api/roles')return {roles:[]};
    if(url==='/api/trash')return {items:[]};
    return storyboardFetch(url);
  }})});
}

test('out of order storyboard responses and same-project deduplication keep caches isolated', async () => {
  const pendingA = deferred(), pendingB = deferred(), calls = [];
  const runtime = runtimeHarness(url=>{calls.push(url);return url==='/api/projects/project-a/storyboard'?pendingA.promise:pendingB.promise;});
  await runtime.connect();
  const a = runtime.loadStoryboard('project-a'), duplicateA = runtime.loadStoryboard('project-a'), b = runtime.loadStoryboard('project-b');
  assert.equal(runtime.getStoryboard('project-a').status,'loading');
  assert.equal(runtime.getStoryboard('project-b').status,'loading');
  pendingB.resolve(storyboard('project-b','b'));await b;
  assert.equal(runtime.getStoryboard('project-b').shots[0].sourceArtifactId,'source-b');
  assert.equal(runtime.getStoryboard('project-a').status,'loading');
  pendingA.resolve(storyboard('project-a','a'));await Promise.all([a,duplicateA]);
  assert.equal(runtime.getStoryboard('project-a').shots[0].sourceArtifactId,'source-a');
  assert.equal(runtime.getStoryboard('project-b').shots[0].sourceArtifactId,'source-b');
  assert.equal(calls.filter(url=>url==='/api/projects/project-a/storyboard').length,1);
  await runtime.loadStoryboard('project-a');assert.equal(calls.length,2);
});

test('a server response bearing another project ID cannot contaminate the requested storyboard cache', async () => {
  const runtime = runtimeHarness(()=>storyboard('project-b','b'));
  await runtime.connect();
  const result = await runtime.loadStoryboard('project-a');
  assert.equal(result.status,'error');
  assert.match(result.error,/项目不匹配/);
  assert.equal(result.shots.length,0);
  assert.equal(runtime.getStoryboard('project-b').status,'idle');
});

test('asset library contains only successful returned outputs and never queued, failed, or empty records',()=>{
  const jobs=[makeJob('a'),makeJob('a',{id:'failed-id',name:'失败只留任务',status:'failed',outputs:[{url:'https://cdn.example.invalid/failed.png',outputType:'png'}]}),makeJob('a',{id:'waiting-id',name:'等待只留任务',status:'queued',outputs:[]}),makeJob('a',{id:'empty-id',name:'空结果不算素材',outputs:[]})];
  const {views,state}=harness({jobs});
  for(const html of [views.collaboration({...state,projectTab:'assets'}),views.artifacts(state)]){
    assert.match(html,/https:\/\/cdn\.example\.invalid\/a\.png/);
    for(const value of ['失败只留任务','等待只留任务','空结果不算素材','failed.png','media-prepare-retry'])assert.ok(!html.includes(value),value+' should not appear in the asset library');
    assert.match(html,/来源与版本/);assert.match(html,/download/);
  }
});
test('execution queue exposes real status, observed time and retry preparation without inline generated media',()=>{
  const jobs=[makeJob('a',{createdAt:'2026-10-25T01:00:00Z',updatedAt:'2026-10-25T01:00:12Z',estimate:{estimatedCost:1,currency:'CNY'}}),makeJob('a',{id:'failed-id',status:'failed',error:'平台返回参数无效',outputs:[]}),makeJob('a',{id:'unknown-id',status:'unknown',error:'受理尚未确认',outputs:[]})];
  const {views,state}=harness({jobs}),html=views.collaboration({...state,projectTab:'tasks'});
  assert.match(html,/提交至最近记录 12 秒/);assert.match(html,/平台返回参数无效/);assert.match(html,/1 CNY/);assert.match(html,/media-view-result/);
  assert.ok(!html.includes('src="https://cdn.example.invalid/'));assert.ok(!html.includes('<video'));
  const unknown=html.match(/<article[^>]*data-media-task-id="unknown-id"[\s\S]*?<\/article>/)[0];
  assert.match(unknown,/避免重复提交/);assert.ok(!unknown.includes('media-prepare-retry'));
  const failed=html.match(/<article[^>]*data-media-task-id="failed-id"[\s\S]*?<\/article>/)[0];assert.match(failed,/media-prepare-retry/);
});
test('canvas renders one delegated real conversation and preserves its draft and project scope',()=>{
  const {views,state,runtime}=harness();
  runtime.active=run=>['running','queued'].includes(run.status);
  runtime.getRuns=scope=>scope.projectId==='project-a'?[{id:'run-a',projectId:'project-a',status:'succeeded',mode:'chat',prompt:'讨论当前镜头',createdAt:'2026-10-25T01:00:00Z',messages:[{authorId:'R03',content:'甲项目真实回复'}],steps:[],events:[]}]:[];
  const page=views.collaboration({...state,projectTab:'canvas'}),chat=views.projectConversation(state,'未发送的草稿 <保留>',{mode:'chat',agentIds:['R03']});
  assert.ok(!page.includes('id="message-text"'));assert.ok(!page.includes('class="project-discussion"'));
  assert.equal((chat.match(/id="message-text"/g)||[]).length,1);assert.match(chat,/甲项目真实回复/);assert.match(chat,/未发送的草稿 &lt;保留&gt;/);assert.match(chat,/data-form="message"/);
  assert.ok(!views.projectConversation({...state,activeProjectId:'project-b'},'',{mode:'chat'}).includes('甲项目真实回复'));
});
test('employee portraits are explicitly presented as team appearance, not story character assets',()=>{
  const {views,state}=harness(),html=views.artifacts(state);
  assert.match(html,/团队形象/);assert.ok(!html.includes('<h2>人物资产</h2>'));
});
test('character assets is a distinct full-width project tab before storyboard and canvas',()=>{
  const {views,state}=harness(),html=views.collaboration({...state,projectTab:'characters'});
  const storyboardTab=html.indexOf('data-id="storyboard"'),characterTab=html.indexOf('data-id="characters"'),canvasTab=html.indexOf('data-id="canvas"');
  assert.ok(characterTab>=0&&characterTab<storyboardTab&&storyboardTab<canvasTab);
  assert.match(html,/is-character-assets/);assert.match(html,/data-character-assets-root data-project-id="project-a"/);
  assert.ok(!html.includes('data-canvas-root'));assert.ok(!html.includes('class="project-discussion"'));assert.ok(!html.includes('id="message-text"'));assert.ok(!html.includes('data-character-assets-root data-project-id="project-b"'));
  const other=views.collaboration({...state,activeProjectId:'project-b',projectTab:'characters'});assert.match(other,/data-character-assets-root data-project-id="project-b"/);
});
test('character assets project tab survives normalization and UI dispatch',()=>{
  const win={},context=vm.createContext({window:win});vm.runInContext(fs.readFileSync(path.join(root,'data/employees.js'),'utf8'),context);
  const store=Store.create(win.TEAM_EMPLOYEES,{storage:{getItem(){return null;},setItem(){}},host:null});
  assert.equal(store.dispatch({type:'SET_UI',projectTab:'characters'}).ok,true);
  assert.equal(Store.normalize(store.getState(),win.TEAM_EMPLOYEES).projectTab,'characters');
});
test('media location routes characters to assets and never creates a free node for an unmatched result',async()=>{
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8'),start=source.indexOf('  async function focusMediaJob('),end=source.indexOf('  function render(){',start),actions=[],focus=[],notices=[],requests=[];
  const context={canvasNavigationEpoch:0,canvasEditingEpoch:0,saveProjectSurface:async()=>{},dialog:{open:false},panel:{hidden:true},visibleState:()=>({view:'project',activeProjectId:'project-a'}),dispatch:action=>actions.push(action),toast:text=>notices.push(text),canvas:{focusAssets:value=>focus.push({kind:'characters',...value}),focus:value=>focus.push({kind:'canvas',...value})},runtime:{request:async(...args)=>{requests.push(args);return {canvas:{projectId:'project-a',nodes:[{id:'asset-1',nodeKind:'character',mediaKind:'image',jobIds:['character-job']},{id:'shot-1',nodeKind:'shot',mediaKind:'video',jobIds:['video-job']}]}};}}};
  vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.locate=focusMediaJob;',context);
  await context.locate({id:'character-job',projectId:'project-a',canvasNodeId:'asset-1'});assert.equal(actions.at(-1).projectTab,'characters');assert.equal(focus.at(-1).nodeId,'asset-1');assert.equal(focus.at(-1).create,false);
  await context.locate({id:'video-job',projectId:'project-a',canvasNodeId:'shot-1'});assert.equal(actions.at(-1).projectTab,'canvas');assert.equal(focus.at(-1).kind,'canvas');assert.equal(focus.at(-1).create,false);
  const count=actions.length;await context.locate({id:'legacy-result',projectId:'project-a'});assert.equal(actions.length,count);assert.equal(focus.length,2);assert.match(notices.at(-1),/没有对应的可用画布节点/);assert.ok(requests.every(args=>args.length===1));
});
test('canvas chat context excludes other projects and credentials while retaining editable shot and asset facts',()=>{
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8'),start=source.indexOf('  function canvasContextText('),end=source.indexOf('  function payloadFor(',start),context={};
  vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.pick=canvasContextText;',context);
  const data={projectId:'project-a',apiKey:'PRIVATE_KEY',node:{id:'n1',shotId:'S01-003',prompt:'当前画面',modelId:'model',apiKey:'PRIVATE_NODE'},assets:[{id:'c1',nodeId:'character-node',type:'character',name:'主角',status:'ready',description:'',prompt:'短发校服，蓝色外套，全身定妆',version:2,referenceJobId:'character-reference-job',referenceUrl:'https://private.invalid/reference.png'},{projectId:'project-b',id:'c2',name:'其他项目'}],media:[{id:'j1',status:'running',modelId:'model',headers:{Authorization:'PRIVATE_HEADER'}}]};
  const text=context.pick(data,'project-a');assert.match(text,/S01-003/);assert.match(text,/主角/);assert.match(text,/running/);
  const asset=JSON.parse(text).assets[0];assert.equal(asset.nodeId,'character-node');assert.equal(asset.prompt,'短发校服，蓝色外套，全身定妆');assert.equal(asset.referenceJobId,'character-reference-job');assert.equal(asset.version,'2');
  for(const secret of ['PRIVATE_KEY','PRIVATE_NODE','PRIVATE_HEADER','其他项目','https://private.invalid/reference.png'])assert.ok(!text.includes(secret));
  assert.equal(context.pick(data,'project-b'),'');
});

function optimizationHarness({ready=true}={}) {
  const calls=[],source=fs.readFileSync(path.join(root,'app.js'),'utf8'),start=source.indexOf('  async function optimizeCanvasPrompt('),end=source.indexOf('  async function submitRuntime(',start);
  const context={runtime:{ready:()=>ready,start:async payload=>{calls.push(JSON.parse(JSON.stringify(payload)));return {id:'text-run',status:'queued'};}},production:{getProductions:()=>[{project:{members:['R03','R04']}}]},crypto:{randomUUID:()=> 'generated-request-id'}};
  vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.optimize=optimizeCanvasPrompt;',context);
  return {...context,calls};
}

test('character prompt optimization routes through R05 and preserves identity for a manga turnaround sheet',async()=>{
  const {optimize,calls}=optimizationHarness(),node={id:'character-node',nodeKind:'character',mediaKind:'image',title:'林夏 · 人物定妆',prompt:'林夏，17岁，灰蓝开衫与白色衬衣，短发',modelId:'current-model',sourceArtifactId:'character-source'};
  const result=await optimize({project:projectA,node,model:{label:'现有图片模型'},instruction:'保留灰蓝开衫，优化剪裁',requestId:'character-request'});
  assert.equal(result.id,'text-run');assert.equal(calls.length,1);const payload=calls[0];
  assert.deepEqual(payload.agentIds,['R05']);assert.equal(payload.mode,'produce');assert.equal(payload.requestId,'character-request');assert.ok(payload.project.members.includes('R05'));assert.ok(!payload.project.members.includes('R06'));
  assert.deepEqual(payload.inputArtifacts,[{id:'character-source'}]);
  for(const text of ['R05 美术指导兼视觉资产设计原岗位正文','二维青春漫画','保留角色身份、年龄、关键服装','脸型结构','发型轮廓','服装剪裁','配色关系与材质','正面、侧面、背面','头像特写','禁止伪造人物参考图已生成、已检查或已审核','不启动任何图片或视频生成','保留灰蓝开衫，优化剪裁',node.prompt])assert.ok(payload.prompt.includes(text),text);
});

test('ordinary shot prompt optimization keeps R06 and its original shot workflow',async()=>{
  const {optimize,calls}=optimizationHarness(),node={id:'shot-node',shotId:'S01-003',mediaKind:'video',title:'河边回眸',prompt:'保留镜头动作与时间',modelId:'current-video-model',sourceArtifactId:'shot-source',promptArtifactId:'shot-prompt'};
  await optimize({project:projectA,node});const payload=calls[0];
  assert.deepEqual(payload.agentIds,['R06']);assert.ok(payload.project.members.includes('R06'));assert.equal(payload.requestId,'generated-request-id');assert.deepEqual(payload.inputArtifacts,[{id:'shot-source'},{id:'shot-prompt'}]);
  assert.ok(payload.prompt.includes('改善表达的精确度、镜头与光影层次，保留原意。'));assert.ok(payload.prompt.includes(node.prompt));assert.ok(!payload.prompt.includes('二维青春漫画'));assert.ok(!payload.prompt.includes('定妆参考板'));
});

test('prompt optimization rejects unavailable execution and oversized input before submission',async()=>{
  const unavailable=optimizationHarness({ready:false});await assert.rejects(unavailable.optimize({project:projectA,node:{nodeKind:'character'}}),/员工执行器尚未就绪/);assert.equal(unavailable.calls.length,0);
  const oversized=optimizationHarness();await assert.rejects(oversized.optimize({project:projectA,node:{nodeKind:'character',prompt:'字'.repeat(20001)}}),/合计过长/);assert.equal(oversized.calls.length,0);
});
