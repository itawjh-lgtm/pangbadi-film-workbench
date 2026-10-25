const test=require('node:test');
const assert=require('node:assert/strict');
const Production=require('../lib/production.js');
const Views=require('../lib/production-views.js');
const project={id:'p1',title:'小样',kind:'film',brief:'做一个镜头',members:['R11','R03']};
const plan=(patch={})=>({id:'prod1',projectId:'p1',revision:1,status:'running',createdAt:'2026-10-25T01:00:00Z',prompt:'镜头目标',reviewMode:'stepwise',stages:[],events:[],...patch});
const artifact={id:'a1',title:'完整剧本',body:'正文全文',filename:'script.md',url:'/api/artifacts/a1',authorId:'R03',runId:'run1'};
const stage=(patch={})=>({id:'script',title:'剧本',agentId:'R03',status:'awaiting_review',attempt:1,artifacts:[artifact],history:[],...patch});
const payload={requestId:'request-1',project,prompt:'镜头目标',reviewMode:'stepwise'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function harness(handler,extra={}){
  const calls=[],timers=new Map();let clockId=0;
  const client=Production.create({request:async(path,body)=>{calls.push({path,body});return handler(path,body);},setTimeout:fn=>{const id=++clockId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),...extra});
  return {client,calls,timers};
}
test('inline preview and offline reads cannot start or query production',async()=>{
  const h=harness(()=>{throw Error('must not call');},{disabled:true});
  h.client.setProject('p1');await h.client.refresh('p1');await assert.rejects(h.client.start(payload));
  assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);h.client.dispose();
});
test('project loading only reads and rejects cross-project records',async()=>{
  const h=harness(()=>({productions:[plan(),plan({id:'other',projectId:'p2'})]}));
  h.client.setProject('p1');await h.client.refresh('p1');
  assert.deepEqual(h.client.getProductions('p1').map(p=>p.id),['prod1']);assert.equal(h.client.getProductions('p2').length,0);
  assert.ok(h.calls.every(c=>c.body===undefined));h.client.dispose();
});
test('same server revision does not redraw polling views',async()=>{
  const h=harness(()=>({productions:[plan()]}));await h.client.refresh('p1');const before=h.client.revision;
  await h.client.refresh('p1');assert.equal(h.client.revision,before);h.client.dispose();
});
test('paused and awaiting-review plans still poll changes from another window',async()=>{
  let value=plan({status:'paused'});const h=harness(()=>({productions:[value]}));h.client.setProject('p1');await h.client.refresh('p1');
  assert.equal(h.timers.size,1);value=plan({revision:2,status:'awaiting_review'});
  const [id,callback]=[...h.timers][0];h.timers.delete(id);await callback();
  assert.equal(h.client.find('prod1').status,'awaiting_review');assert.equal(h.timers.size,1);
  h.client.setProject(null);assert.equal(h.timers.size,0);h.client.dispose();
});
test('late list response cannot roll back a confirmed newer mutation',async()=>{
  let wait=null;const h=harness((path,body)=>body?{production:plan({revision:3,status:'paused'})}:wait?wait.promise:{productions:[plan()]});
  await h.client.refresh('p1');wait=deferred();const refresh=h.client.refresh('p1');await h.client.pause('prod1',1);
  wait.resolve({productions:[plan({revision:2})]});await refresh;
  assert.equal(h.client.find('prod1').revision,3);assert.equal(h.client.find('prod1').status,'paused');h.client.dispose();
});
test('double start submits once and preserves the supplied idempotency request ID',async()=>{
  const wait=deferred(),h=harness(()=>wait.promise);const first=h.client.start(payload),second=h.client.start(payload);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.requestId,'request-1');assert.equal(h.client.isStarting('p1'),true);
  wait.resolve({production:plan()});await Promise.all([first,second]);assert.equal(h.client.isStarting('p1'),false);h.client.dispose();
});
test('review uses the displayed revision rather than replacing it with a newer one',async()=>{
  const h=harness((path,body)=>body?{production:plan({revision:5,status:'running'})}:{productions:[plan({revision:4,status:'awaiting_review',stages:[stage()]})]});
  await h.client.refresh('p1');await h.client.review('prod1',{stageId:'script',action:'revise',note:'保留人物，改结尾',expectedRevision:3});
  const post=h.calls.find(c=>c.body);assert.equal(post.path,'/api/productions/prod1/review');assert.equal(post.body.expectedRevision,3);h.client.dispose();
});
test('rejected actions stay visible without inventing successful state',async()=>{
  const h=harness((path,body)=>{if(body)throw Error('版本已改变');return {productions:[plan({status:'awaiting_review',stages:[stage()]})]};});
  await h.client.refresh('p1');await assert.rejects(h.client.review('prod1',{stageId:'script',action:'approve',note:''}),/版本已改变/);
  assert.equal(h.client.find('prod1').status,'awaiting_review');assert.match(h.client.getError('p1'),/版本已改变/);h.client.dispose();
});
test('current and archived full artifacts remain available separately',async()=>{
  const old={...artifact,id:'old',body:'旧稿'};const h=harness(()=>({productions:[plan({stages:[stage({history:[{attempt:1,artifacts:[old]}]})]})]}));
  await h.client.refresh('p1');assert.equal(h.client.findArtifact('a1').body,'正文全文');assert.equal(h.client.findArtifact('old').body,'旧稿');assert.equal(h.client.findArtifact('old').archived,true);h.client.dispose();
});
test('invalid project and game requests never reach generation API',async()=>{
  const h=harness(()=>{throw Error('unexpected request');});
  for(const p of [{...project,id:'../../secret'},{...project,kind:'game'}])await assert.rejects(h.client.start({...payload,project:p}));
  assert.equal(h.calls.length,0);h.client.dispose();
});
test('production revisions refresh runtime once and do not loop on unchanged data',async()=>{
  const calls=[],sync=Production.createRunSynchronizer({loadScope:async(scope,force)=>calls.push({scope,force})});
  await sync.sync('p1',[plan()]);assert.equal(calls.length,2);assert.equal(calls[1].force,true);
  await sync.sync('p1',[plan()]);assert.equal(calls.length,2);
  await sync.sync('p1',[plan({revision:2})]);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.scope.projectId==='p1'));
});
test('runtime refresh drains an old request and catches a revision arriving mid-refresh',async()=>{
  const wait=deferred(),calls=[];let first=true;
  const sync=Production.createRunSynchronizer({loadScope:async(scope,force)=>{calls.push(force);if(first){first=false;await wait.promise;}}});
  const p=sync.sync('p1',[plan()]);const again=sync.sync('p1',[plan({revision:2})]);assert.equal(calls.length,1);
  wait.resolve();await Promise.all([p,again]);assert.deepEqual(calls,[undefined,true,undefined,true]);
});
function viewsFor(productions,ui={},options={}){
  const client={getProductions:()=>productions,getError:()=>'',active:Production.active,isBusy:()=>false,isStarting:()=>false,ready:()=>true,enabled:()=>true,find:id=>productions.find(p=>p.id===id),...options.client};
  const views=Views.create([{id:'R03',name:'编剧伙伴',thumb:'assets/team/test.webp'}],client);
  return {html:views.workspace(options.project||project,ui),views};
}

test('active or recoverable collaboration shows progress and review without a repeated launch form',()=>{
  for(const status of ['running','awaiting_review','paused','failed']){
    const {html}=viewsFor([plan({status,stages:[stage()]})]);
    assert.ok(html.includes('class="production-plan surface"'));assert.ok(html.includes('data-action="production-artifact"'));
    assert.ok(!html.includes('data-form="production-start"'));assert.ok(!html.includes('发起新一轮协作'));assert.ok(!html.includes('从你的想法开始'));
    if(['paused','failed'].includes(status))assert.ok(html.includes('data-action="production-resume"'));
  }
});

test('finished collaboration offers only a closed new-round entry and preserves the existing brief',()=>{
  for(const status of ['completed','cancelled']){
    const {html}=viewsFor([plan({status,reviewMode:'continuous',stages:[stage({status:'completed'})]})]);
    assert.ok(html.includes('<details class="production-new-round" data-runtime-detail="production-new-round-p1"><summary>发起新一轮协作</summary>'));
    assert.ok(!html.includes('data-runtime-detail="production-new-round-p1" open'));
    const index=html.indexOf('data-form="production-start"');assert.ok(index>html.indexOf('class="production-new-round"'));
    assert.ok(html.includes('>'+project.brief+'</textarea>'));assert.ok(html.includes('<option value="continuous" selected>'));assert.ok(!html.includes('这次想做什么'));assert.ok(!html.includes('交给团队一起完成'));
  }
});

test('a project without collaboration can start with its saved brief while optional edits stay closed',()=>{
  let starts=0;const before=JSON.stringify(project),{html}=viewsFor([],{}, {client:{start(){starts++;}}});
  assert.ok(html.includes('按现有说明开始'));assert.ok(html.includes('data-form="production-start"'));assert.ok(html.includes('data-project-id="p1"'));
  assert.ok(html.includes('>'+project.brief+'</textarea>'));assert.ok(html.includes('data-runtime-detail="production-start-options-p1"><summary>查看或调整项目说明'));
  assert.ok(!html.includes('class="production-team-preview"'));assert.ok(!html.includes('data-runtime-detail="production-start-options-p1" open'));assert.equal(starts,0);assert.equal(JSON.stringify(project),before);
});

test('missing briefs expose the compact editor and saved drafts replace the brief without losing review mode',()=>{
  const empty=viewsFor([],{}, {project:{...project,brief:''}}).html;
  assert.ok(empty.includes('data-runtime-detail="production-start-options-p1" open'));assert.ok(empty.includes('补充项目说明'));assert.ok(empty.includes('name="prompt"'));assert.ok(empty.includes(' required>'));
  const html=viewsFor([],{getDraft:()=>({prompt:'调整后的说明 <保留>',reviewMode:'continuous'})}).html;
  assert.ok(html.includes('调整后的说明 &lt;保留&gt;</textarea>'));assert.ok(html.includes('<option value="continuous" selected>'));assert.ok(!html.includes('>'+project.brief+'</textarea>'));
});

test('collaboration mode remains visible outside the optional brief and explains the document boundary',()=>{
  const html=viewsFor([],{}, {project:{...project,reviewMode:'continuous'}}).html;
  const detailsStart=html.indexOf('<details class="production-start-options"'),detailsEnd=html.indexOf('</details>',detailsStart),folded=html.slice(detailsStart,detailsEnd);
  assert.ok(html.indexOf('name="reviewMode"')<detailsStart);assert.ok(!folded.includes('name="reviewMode"'));assert.ok(folded.includes('name="prompt"'));
  assert.ok(html.includes('>协作方式<select'));assert.ok(html.includes('团队连续完成 · 文稿完成后统一审核'));assert.ok(html.includes('逐步审核 · 剧本、美术设定、最终交付'));
  assert.ok(html.includes('两种方式都由总策划确认最终文稿'));assert.ok(html.includes('图片与视频在人物资产、创作画布中继续制作'));assert.ok(!html.includes('全自动出片'));
});

test('launch mode takes draft then previous round then project defaults without changing saved state',()=>{
  const cases=[
    {projectMode:'continuous',expected:'continuous'},
    {projectMode:'stepwise',expected:'stepwise'},
    {projectMode:undefined,expected:'stepwise'},
    {projectMode:'invalid',expected:'stepwise'},
    {projectMode:'continuous',lastMode:'stepwise',expected:'stepwise'},
    {projectMode:'stepwise',lastMode:'continuous',expected:'continuous'},
    {projectMode:'continuous',lastMode:undefined,round:true,expected:'continuous'},
    {projectMode:'continuous',lastMode:'invalid',expected:'stepwise'},
    {projectMode:'stepwise',lastMode:'stepwise',draftMode:'continuous',expected:'continuous'},
    {projectMode:'continuous',lastMode:'continuous',draftMode:'stepwise',expected:'stepwise'},
    {projectMode:'continuous',lastMode:'continuous',draftMode:'invalid',expected:'stepwise'}
  ];
  for(const item of cases){
    const saved={...project,reviewMode:item.projectMode},productions=item.lastMode!==undefined||item.round?[plan({status:'completed',reviewMode:item.lastMode})]:[],draft={reviewMode:item.draftMode};
    const before=JSON.stringify({saved,productions,draft}),html=viewsFor(productions,{getDraft:()=>draft},{project:saved}).html;
    assert.ok(html.includes('<option value="'+item.expected+'" selected>'),JSON.stringify(item));assert.equal((html.match(/<option value="(?:stepwise|continuous)" selected>/g)||[]).length,1);
    assert.equal(JSON.stringify({saved,productions,draft}),before);
  }
});

test('active plans retain their own review mode even when project or draft defaults differ',()=>{
  for(const reviewMode of ['stepwise','continuous']){
    const current=plan({reviewMode,status:'running'}),other=reviewMode==='continuous'?'stepwise':'continuous',before=JSON.stringify(current);
    const html=viewsFor([current],{getDraft:()=>({reviewMode:other})},{project:{...project,reviewMode:other}}).html;
    assert.ok(html.includes(reviewMode==='continuous'?'连续协作 · 最终审阅':'逐步审阅'));assert.ok(!html.includes('name="reviewMode"'));assert.ok(!html.includes('data-form="production-start"'));assert.equal(JSON.stringify(current),before);
  }
});

test('compact launch keeps actual loading errors offline guidance and busy protection without starting work',()=>{
  const offline=viewsFor([],{}, {client:{ready:()=>false,getError:()=>'<error>读取失败'}}).html;
  assert.ok(offline.includes('&lt;error&gt;读取失败'));assert.ok(offline.includes('data-action="production-refresh"'));assert.ok(offline.includes('文字执行器尚未就绪'));assert.ok(offline.includes('data-action="runtime-connect"'));assert.ok(offline.includes('type="submit" class="button-primary" disabled'));
  const preview=viewsFor([],{}, {client:{ready:()=>false,enabled:()=>false}}).html;assert.ok(preview.includes('当前预览仅展示界面'));
  const busy=viewsFor([],{}, {client:{isStarting:()=>true}}).html;assert.ok(busy.includes('type="submit" class="button-primary" disabled>正在提交…'));
});

test('R05 internal character reports do not add report cards or change the original delivery and revision entries',()=>{
  const original=stage({id:'visual',agentId:'R05',title:'视觉设定',status:'completed',artifacts:[{...artifact,title:'人物与场景设定',body:'林夏：青年修复师，黑色齐肩短发，穿旧蓝工作服。'}]});
  const report={contractVersion:1,status:'needs_details',characters:[{name:'林夏',fields:{identityAge:'青年修复师'},missingFields:['人物参考提示词']}],warnings:['内部检查提示'],evidenceLevel:'text_only',imageApprovalIncluded:false};
  const value=plan({status:'completed',stages:[{...original,characterAssetReport:report}]}),before=JSON.stringify(value);
  const {html,views}=viewsFor([value]),withoutReport=viewsFor([plan({status:'completed',stages:[original]})]).html;
  assert.equal(html,withoutReport);assert.ok(!html.includes('data-character-asset-report'));assert.ok(!html.includes('人物资产说明'));assert.ok(!html.includes('内部检查提示'));
  assert.ok(html.includes('data-action="production-artifact" data-id="a1"'));assert.ok(html.includes('人物与场景设定'));assert.ok(html.includes('修改这个阶段'));assert.ok(html.includes('进入人物资产'));
  assert.ok(views.artifactDetails({...original.artifacts[0],productionId:value.id,stageId:'visual'}).includes(original.artifacts[0].body));assert.equal(JSON.stringify(value),before);
});
test('continuous flow permits revising completed upstream stages and final delivery',()=>{
  const value=plan({reviewMode:'continuous',status:'awaiting_review',stages:[stage({status:'completed'}),stage({id:'delivery',title:'交付整理'})]});
  const {html}=viewsFor([value]);assert.match(html,/修改这个阶段/);assert.match(html,/后续阶段会按新版本重新制作/);
  assert.equal((html.match(/data-form="production-review"/g)||[]).length,2);assert.match(html,/确认文稿并进入人物资产/);assert.ok(!html.includes('maxlength="4000"'));
  assert.equal((html.match(/maxlength="2000"/g)||[]).length,2);
  const completed=viewsFor([plan({status:'completed',stages:[stage({status:'completed'})]})]).html;
  assert.match(completed,/修改这个阶段/);assert.ok(!completed.includes('value="approve"'));
});
test('stepwise R05 approval offers immediate character preparation while continuous mode keeps final review',()=>{
  const visual=stage({id:'visual',agentId:'R05',title:'美术设定'}),stepwise=viewsFor([plan({status:'awaiting_review',stages:[visual]})]).html;
  assert.match(stepwise,/确认设定，进入人物资产/);assert.match(stepwise,/镜头文稿会继续在后台协作/);
  const continuous=viewsFor([plan({reviewMode:'continuous',status:'awaiting_review',stages:[{...visual,status:'completed'},stage({id:'delivery',title:'最终交付'})]})]).html;
  assert.ok(!continuous.includes('确认设定，进入人物资产'));assert.match(continuous,/确认文稿并进入人物资产/);
});
test('review drafts persist and stale drafts cannot silently approve a newer version',()=>{
  const {html}=viewsFor([plan({revision:9,status:'awaiting_review',stages:[stage()]})],{getDraft:()=>({note:'正在编辑的意见 <保留>',expectedRevision:8})});
  assert.match(html,/正在编辑的意见 &lt;保留&gt;/);assert.match(html,/name="expectedRevision" value="8"/);
  assert.match(html,/data-action="production-review-current"/);assert.match(html,/value="approve" class="button-primary" disabled/);
});
test('historical plans expose artifacts but no actionable revision forms',()=>{
  const old=plan({id:'old',status:'completed',stages:[stage({status:'completed'})]}),latest=plan({id:'new',status:'running',stages:[stage({status:'pending',artifacts:[]})]});
  const {html}=viewsFor([old,latest]);assert.ok(html.includes('此前协作'));assert.ok(!html.includes('data-form="production-review"'));
});
test('model output, drafts, events and artifact links remain inert',()=>{
  const bad='<img src=x onerror=alert(1)>',value=plan({prompt:bad,events:[{text:bad,at:'2026-10-25T01:00:00Z'}],stages:[stage({title:bad,error:bad})]});
  const {html,views}=viewsFor([value]);assert.ok(!html.includes(bad));assert.ok(html.includes('&lt;img'));
  const detail=views.artifactDetails({...artifact,productionId:'prod1',stageId:'script',body:'<script>alert(1)</script>',url:'javascript:alert(1)'});
  assert.ok(!detail.includes('<script>'));assert.ok(!detail.includes('href="javascript:'));assert.ok(detail.includes('&lt;script&gt;'));
  for(const url of ['https://example.test/file','/api/artifacts/../secret','/api/artifacts/x?redirect=x'])assert.equal(Views.fileURL(url),'');
});

function approvedPlan(patch={}){
  return plan({status:'completed',stages:[stage({id:'delivery',status:'completed',review:{action:'approve',at:'2026-10-25T02:00:00Z',artifactIds:['final-1']}})],...patch});
}
test('first load and reopening a historical completed production never steal navigation',()=>{
  const tracker=Production.createCanvasHandoffTracker(),done=approvedPlan();
  assert.equal(tracker.observe([done]),null);
  assert.equal(tracker.observe([done]),null);
  assert.equal(tracker.observe([done],false),null);
  assert.equal(tracker.observe([done],true),null);
});
test('new final approval hands off exactly once, independent of unrelated production revisions',()=>{
  const handled=new Map(),tracker=Production.createCanvasHandoffTracker({handled}),done=approvedPlan();
  assert.equal(tracker.observe([plan()]),null);
  assert.equal(tracker.observe([done]),done);
  assert.equal(tracker.observe([approvedPlan({revision:20})]),null);
  assert.equal(handled.size,1);
  const reopened=Production.createCanvasHandoffTracker({handled});
  reopened.observe([plan()]);assert.equal(reopened.observe([done]),null);
});
test('editing or another project consumes the automatic transition without later hijacking the page',()=>{
  const tracker=Production.createCanvasHandoffTracker(),done=approvedPlan();
  tracker.observe([plan()]);assert.equal(tracker.observe([done],false),null);
  assert.equal(tracker.observe([done],true),null);
  assert.ok(tracker.claim(done)); // An explicit continue button remains usable.
});
test('only latest approved delivery can hand off; an unapproved completion cannot',()=>{
  const tracker=Production.createCanvasHandoffTracker(),old=approvedPlan(),current=plan({id:'prod2'});
  tracker.observe([old,current]);assert.equal(tracker.observe([old,plan({id:'prod2',status:'completed'})]),null);
  tracker.observe([old,current]);const done=approvedPlan({id:'prod2'});
  assert.equal(tracker.observe([old,done]),done);
});
test('revised final delivery has a new approval identity and can hand off once again',()=>{
  const tracker=Production.createCanvasHandoffTracker(),first=approvedPlan();
  tracker.observe([plan()]);assert.equal(tracker.observe([first]),first);
  tracker.observe([plan({revision:8})]);
  const next=approvedPlan({revision:9,stages:[stage({id:'delivery',status:'completed',review:{action:'approve',at:'2026-10-25T03:00:00Z',artifactIds:['final-2']}})]});
  assert.equal(tracker.observe([next]),next);assert.equal(tracker.observe([next]),null);
});
test('completed production makes the character asset page the next visible step',()=>{
  const {html}=viewsFor([approvedPlan()]);
  const next=html.indexOf('进入人物资产 →');assert.ok(next>=0&&next<html.indexOf('production-stages'));
  assert.match(html,/先在人物资产页准备定妆图，再核对分镜，随后进入创作画布/);
});

// Execute the actual controller helpers with an isolated runtime. This catches
// navigation races without approving or generating anything in a real project.
function handoffControllerHarness(){
  const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  const start=source.indexOf('  function trackCanvasNavigation('),end=source.indexOf('  function render(){',start);
  assert.ok(start>=0&&end>start);
  let resolve,reject;const wait=new Promise((yes,no)=>{resolve=yes;reject=no;});
  let calls=0;const actions=[],done=approvedPlan();
  const context={state:{view:'project',activeProjectId:'p1',projectTab:'production'},plan:done,canvas:{save:async()=>{}},window:{StudioProduction:Production},workspaceSync:{blocked:()=>false},dialog:{open:false},panel:{hidden:true},document:{activeElement:{matches:()=>false}},drafts:new Map(),productionDrafts:new Map(),canvasHandoffPending:new Map(),canvasHandoffTracker:Production.createCanvasHandoffTracker(),toast:()=>{}};
  context.visibleState=()=>context.state;context.production={getProductions:()=>[context.plan],isBusy:()=>false};
  context.dispatch=action=>{actions.push(action);context.state.projectTab=action.projectTab;context.track(context.state);};
  context.runtime={request:()=>{calls++;return wait;}};
  vm.createContext(context);vm.runInContext("let canvasNavigationEpoch=0,canvasNavigationScope='',canvasEditingEpoch=0;\n"+source.slice(start,end)+';this.open=openProductionCanvas;this.openVisual=openVisualAssets;this.visualKey=visualApprovalKey;this.position=()=>({navigationEpoch:canvasNavigationEpoch,editingEpoch:canvasEditingEpoch});this.openCanvas=openProjectCanvas;this.switchTab=switchProjectTab;this.track=trackCanvasNavigation;this.edit=trackCanvasEditing;',context);
  context.track(context.state);
  const navigate=patch=>{Object.assign(context.state,patch);context.track(context.state);};
  return {context,done,resolve,reject,actions,navigate,calls:()=>calls,data:{canvas:{projectId:'p1',nodes:[{id:'image',shotId:'S01'}]}}};
}
test('automatic and explicit handoffs sharing a response sync and navigate only once',async()=>{
  const h=handoffControllerHarness(),automatic=Promise.resolve().then(()=>h.context.open(h.done,{automatic:true}));
  await Promise.resolve();const explicit=h.context.open(h.done);assert.equal(h.calls(),1);
  h.resolve(h.data);await Promise.all([automatic,explicit]);assert.equal(h.actions.length,1);assert.equal(h.actions[0].projectTab,'characters');
});
test('navigating away and back during canvas sync cancels both automatic and explicit navigation',async()=>{
  for(const automatic of [true,false]){
    const h=handoffControllerHarness(),pending=h.context.open(h.done,{automatic});
    h.navigate({projectTab:'assets'});h.navigate({projectTab:'production'});
    h.resolve(h.data);await pending;assert.equal(h.actions.length,0);
  }
});
test('non-navigation updates do not cancel a pending canvas handoff',async()=>{
  const h=handoffControllerHarness(),pending=h.context.open(h.done);
  h.navigate({revision:2,taskFilter:'ready',selectedShot:'storyboard',query:'new search'});
  h.resolve(h.data);await pending;assert.equal(h.actions.length,1);
});
test('failed preparation leaves an explicit retry available even after its approval is marked handled',async()=>{
  const h=handoffControllerHarness(),pending=h.context.open(h.done);h.reject(new Error('sync failed'));
  await assert.rejects(pending,/sync failed/);assert.equal(h.context.canvasHandoffPending.size,0);
  let retried=0;h.context.runtime.request=async()=>{retried++;return h.data;};
  await h.context.open(h.done);assert.equal(retried,1);assert.equal(h.actions.length,1);
});

test('new input during an explicit canvas preparation keeps the user on the document page',async()=>{
  const h=handoffControllerHarness(),pending=h.context.open(h.done);
  h.context.drafts.set('project:p1','刚补充的新想法');h.context.edit({matches:()=>true});
  h.resolve(h.data);await pending;assert.equal(h.actions.length,0);
  assert.equal(h.context.drafts.get('project:p1'),'刚补充的新想法');
});
test('existing drafts still allow explicit entry, while a newly opened dialog blocks late navigation',async()=>{
  const existing=handoffControllerHarness();existing.context.drafts.set('project:p1','原有草稿');existing.context.edit({matches:()=>true});
  const pending=existing.context.open(existing.done);existing.resolve(existing.data);await pending;assert.equal(existing.actions.length,1);
  const dialog=handoffControllerHarness(),waiting=dialog.context.open(dialog.done);dialog.context.dialog.open=true;
  dialog.resolve(dialog.data);await waiting;assert.equal(dialog.actions.length,0);
});

test('formal canvas entry reads readiness and returns unfinished characters to their own page',async()=>{
  const h=handoffControllerHarness(),calls=[];h.navigate({projectTab:'characters'});
  h.context.runtime.request=async(...args)=>{calls.push(args);return {canvas:{...h.data.canvas,assetSourceVersion:'current',characterAssets:[{id:'hero',status:'draft',sourceVersion:'current'},{id:'old-hero',status:'stale',sourceVersion:'old'}]}};};
  await h.context.openCanvas(project);assert.equal(h.actions.at(-1).projectTab,'characters');assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/projects/p1/canvas');assert.equal(calls[0].length,1);
});

test('ready characters and projects without characters can enter canvas while old versions do not block',async()=>{
  for(const assets of [[],[{id:'hero',status:'ready',sourceVersion:'current'},{id:'old-hero',status:'stale',sourceVersion:'old'}]]){
    const h=handoffControllerHarness();h.navigate({projectTab:'characters'});h.context.runtime.request=async()=>({canvas:{...h.data.canvas,assetSourceVersion:'current',characterAssets:assets}});
    await h.context.openCanvas(project);assert.equal(h.actions.at(-1).projectTab,'canvas');
  }
  const manual=handoffControllerHarness();manual.navigate({projectTab:'characters'});manual.context.runtime.request=async()=>({canvas:{...manual.data.canvas,assetSourceVersion:'current',characterAssets:[{id:'manual',manual:true,status:'draft',sourceVersion:'old'}]}});
  await manual.context.openCanvas(project);assert.equal(manual.actions.at(-1).projectTab,'characters');
});

test('the new character completion action opens storyboard after saving and readiness, without skipping to canvas',async()=>{
  for(const status of ['ready','draft']){
    const h=handoffControllerHarness(),order=[];h.navigate({projectTab:'characters'});h.context.canvas.save=async()=>{order.push('save');};
    h.context.runtime.request=async()=>{order.push('read');return {canvas:{...h.data.canvas,assetSourceVersion:'current',characterAssets:[{id:'hero',status,sourceVersion:'current'}]}};};
    await h.context.openCanvas(project,null,'storyboard');assert.deepEqual(order,['save','read']);assert.equal(h.actions.at(-1).projectTab,status==='ready'?'storyboard':'characters');assert.ok(!h.actions.some(action=>action.projectTab==='canvas'));
  }
});

test('late readiness responses cannot steal navigation and other project asset data is rejected',async()=>{
  const h=handoffControllerHarness();h.navigate({projectTab:'characters'});const pending=h.context.openCanvas(project);h.navigate({projectTab:'tasks'});h.resolve({canvas:{...h.data.canvas,characterAssets:[]}});await pending;assert.equal(h.actions.length,0);
  const wrong=handoffControllerHarness();wrong.context.runtime.request=async()=>({canvas:{projectId:'another',nodes:[],characterAssets:[]}});await assert.rejects(wrong.context.openCanvas(project),/人物资产状态暂时无法读取/);assert.equal(wrong.actions.length,0);
});

test('leaving either editable surface waits for save and a failed save keeps that surface open',async()=>{
  for(const tab of ['characters','canvas']){
    const h=handoffControllerHarness(),saved=deferred();h.navigate({projectTab:tab});h.context.canvas.save=()=>saved.promise;
    const leaving=h.context.switchTab('storyboard');assert.equal(h.actions.length,0);saved.resolve();await leaving;assert.equal(h.actions.at(-1).projectTab,'storyboard');
    const failed=handoffControllerHarness();failed.navigate({projectTab:tab});failed.context.canvas.save=async()=>{throw Error('save failed');};await assert.rejects(failed.context.switchTab('storyboard'),/save failed/);assert.equal(failed.actions.length,0);
  }
});

test('only the latest tab intention wins after saving and formal canvas entry reads after saving',async()=>{
  const h=handoffControllerHarness(),saved=deferred();h.navigate({projectTab:'characters'});h.context.canvas.save=()=>saved.promise;
  const first=h.context.switchTab('storyboard'),last=h.context.switchTab('tasks');saved.resolve();await Promise.all([first,last]);assert.equal(h.actions.length,1);assert.equal(h.actions[0].projectTab,'tasks');
  const formal=handoffControllerHarness(),order=[];formal.navigate({projectTab:'characters'});formal.context.canvas.save=async()=>{order.push('save');};formal.context.runtime.request=async()=>{order.push('read');return {canvas:{...formal.data.canvas,characterAssets:[]}};};await formal.context.openCanvas(project);assert.deepEqual(order,['save','read']);assert.equal(formal.actions[0].projectTab,'canvas');
});

function approvedVisualPlan(patch={}){return plan({status:'running',stages:[stage({id:'visual',agentId:'R05',status:'completed',outputArtifactIds:['a1'],review:{action:'approve',reviewer:'user',at:'2026-10-25T03:00:00Z',artifactIds:['a1']}}),stage({id:'storyboard',agentId:'R04',status:'running',artifacts:[]})],...patch});}
test('real R05 user approval imports characters with a GET before storyboard completion',async()=>{
  const h=handoffControllerHarness(),calls=[];h.context.plan=approvedVisualPlan();h.context.runtime.request=async(...args)=>{calls.push(args);return {canvas:{projectId:'p1',characterAssets:[{id:'hero',status:'draft'}],nodes:[]}};};
  await h.context.openVisual(h.context.plan);assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/projects/p1/canvas');assert.equal(calls[0].length,1);assert.equal(h.actions[0].projectTab,'characters');assert.equal(h.context.plan.stages[1].status,'running');
});
test('visual handoff refuses non-user approval, mismatched artifacts, and continuous runs',async()=>{
  const original=approvedVisualPlan(),visual=original.stages[0];
  for(const candidate of [approvedVisualPlan({reviewMode:'continuous'}),approvedVisualPlan({stages:[{...visual,review:{...visual.review,reviewer:'agent'}}]}),approvedVisualPlan({stages:[{...visual,review:{...visual.review,artifactIds:['old-version']}}]}),approvedVisualPlan({stages:[{...visual,review:null}]})]){
    const h=handoffControllerHarness();h.context.plan=candidate;assert.equal(h.context.visualKey(candidate),'');await h.context.openVisual(candidate);assert.equal(h.calls(),0);assert.equal(h.actions.length,0);
  }
});
test('R05 approval and import latency cannot steal navigation or newly edited text',async()=>{
  const before=handoffControllerHarness();before.context.plan=approvedVisualPlan();const position=before.context.position();before.context.edit({matches:()=>true});await before.context.openVisual(before.context.plan,position);assert.equal(before.calls(),0);
  for(const edit of [false,true]){const h=handoffControllerHarness();h.context.plan=approvedVisualPlan();const opening=h.context.openVisual(h.context.plan);if(edit)h.context.edit({matches:()=>true});else{h.navigate({projectTab:'tasks'});h.navigate({projectTab:'production'});}h.resolve({canvas:{projectId:'p1',characterAssets:[]}});await opening;assert.equal(h.actions.length,0);}
});
