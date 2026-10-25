'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Store=require('../lib/store.js');
const project=(id,extra={})=>({id,title:'项目 '+id,kind:'film',brief:'项目简报',members:['R03','R04'],isDemo:false,createdAt:1,...extra});
const job=(id,projectId='a',extra={})=>({id,projectId,name:'作品 '+id,status:'succeeded',mediaKind:'image',createdAt:1,outputs:[{url:'https://cdn.example.invalid/'+id+'.png',outputType:'png'}],...extra});
function harness({jobs=[],projects=[project('a'),project('b')],documents=[],local=[],deleted=()=>false}={}){
  const win={},context=vm.createContext({window:win,console,URL});
  for(const file of ['data/employees.js','data/project-templates.js','lib/views.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context,{filename:file});
  const store=Store.create(win.TEAM_EMPLOYEES,{storage:{getItem(){return null;},setItem(){}},host:null});
  const state={...store.getState(),view:'overview',activeProjectId:projects[0]?.id||null,projects,tasks:[],artifacts:local,decisions:[],messages:[],activity:[]};
  const runtime={connection:{state:'online',ready:true},media:{jobs},isDeleted:deleted,artifacts:scope=>documents.filter(a=>a.projectId===scope.projectId)};
  const views=win.StudioViews.create(win.TEAM_EMPLOYEES,{getState:()=>state,blockers:()=>[]},runtime);
  return {state,runtime,views,html:()=>views.overview(state)};
}

test('home displays actual images and playable videos before compact project work with exact ownership',()=>{
  const video=job('edc59be5-video','b',{name:'镜头二成片',mediaKind:'video',createdAt:2,outputs:[{url:'https://cdn.example.invalid/cut.mp4?token=abc&part=1',outputType:'video/mp4'}]}),h=harness({jobs:[job('image'),video]});
  const before=JSON.stringify(h.state),html=h.html();
  assert.ok(html.indexOf('class="home-results"')<html.indexOf('class="home-project-flow"'));assert.ok(html.includes('<h2>项目成果</h2>'));
  assert.match(html,/<article class="home-result-card" data-home-media-id="image" data-project-id="a">/);
  assert.match(html,/<article class="home-result-card" data-home-media-id="edc59be5-video" data-project-id="b">/);
  assert.match(html,/<video controls preload="metadata" playsinline src="https:\/\/cdn\.example\.invalid\/cut\.mp4\?token=abc&amp;part=1"/);
  assert.ok(html.includes('项目 b · 视频'));assert.ok(html.includes('镜头二成片'));assert.ok(html.includes('/assets/media-preview.html?job=edc59be5-video'));
  assert.ok(html.includes('data-action="media-view-result" data-id="edc59be5-video"'));assert.ok(html.includes('data-media-preview-key="home:edc59be5-video:0:'));
  assert.equal(JSON.stringify(h.state),before);
});

test('home excludes pending failed empty nonvisual orphan demo and deleted outputs',()=>{
  const projects=[project('a'),project('demo',{isDemo:true}),project('deleted-project')];
  const jobs=[job('valid'),job('queued','a',{status:'queued'}),job('failed','a',{status:'failed'}),job('empty','a',{outputs:[]}),job('text','a',{outputs:[],textOutputs:[{text:'JSON_LONG_BODY'}]}),job('pdf','a',{outputs:[{url:'https://cdn.example.invalid/file.pdf',outputType:'pdf'}]}),job('orphan','missing'),job('demo-output','demo'),job('deleted-job'),job('deleted-parent','deleted-project')];
  const h=harness({jobs,projects,deleted:(kind,id)=>kind==='media'&&id==='deleted-job'||kind==='project'&&id==='deleted-project'}),html=h.html();
  assert.equal((html.match(/class="home-result-card"/g)||[]).length,1);
  for(const id of ['queued','failed','empty','text','pdf','orphan','demo-output','deleted-job','deleted-parent'])assert.ok(!html.includes('data-home-media-id="'+id+'"'),id);
  assert.ok(!html.includes('JSON_LONG_BODY'));
});

test('home uses the shared HTTPS media safety rules and safely escapes task and project titles',()=>{
  const bad=['javascript:alert(1)','http://example.invalid/a.png','https://user:password@example.invalid/a.png','https://example.invalid/a.png" onerror="alert(1)','data:image/png;base64,abc'];
  const jobs=bad.map((url,i)=>job('unsafe-'+i,'a',{outputs:[{url,outputType:'png'}]}));
  jobs.push(job('safe','a',{name:'<img src=x onerror=alert(1)>',outputs:[null,{url:'https://cdn.example.invalid/valid.webp',outputType:'webp'}]}));
  const html=harness({projects:[project('a',{title:'<script>owner</script>'})],jobs}).html();
  assert.equal((html.match(/class="home-result-card"/g)||[]).length,1);assert.ok(html.includes('&lt;script&gt;owner&lt;/script&gt;'));assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<script>owner</script>'));for(let i=0;i<bad.length;i++)assert.ok(!html.includes('data-home-media-id="unsafe-'+i+'"'));
  assert.ok(html.includes('data-media-preview-key="home:safe:1:'));assert.ok(html.includes('data-media-fallback hidden'));
});

test('home caps the newest gallery at four outputs with stable distinct preview identities',()=>{
  const jobs=Array.from({length:10},(_,i)=>job('item-'+i,'a',{createdAt:100+i}));
  const html=harness({jobs}).html();assert.equal((html.match(/class="home-result-card"/g)||[]).length,4);
  assert.ok(html.indexOf('data-home-media-id="item-9"')<html.indexOf('data-home-media-id="item-8"'));
  for(let i=0;i<6;i++)assert.ok(!html.includes('data-home-media-id="item-'+i+'"'));
  assert.ok(html.includes('最近 4 份 / 共 10 份'));assert.ok(html.includes('data-home-media-id="item-6"'));
  const multi=harness({jobs:[job('multiple','a',{outputs:[{url:'https://cdn.example.invalid/same.png',outputType:'png'},{url:'https://cdn.example.invalid/same.png',outputType:'png'}]})]}).html();
  assert.ok(multi.includes('home:multiple:0:'));assert.ok(multi.includes('home:multiple:1:'));
});

test('home documents show at most three current project titles without body excerpts',()=>{
  const documents=[1,2,3,4].map(i=>({id:'doc-'+i,projectId:'a',title:'执行文稿 '+i,createdAt:i,body:'HUGE_RUNTIME_BODY_'+i,preview:'HUGE_RUNTIME_PREVIEW_'+i}));
  documents.push({id:'other-doc',projectId:'b',title:'别的项目文稿',body:'OTHER_PROJECT_BODY',createdAt:99},{id:'deleted-doc',projectId:'a',title:'已删文稿',createdAt:100});
  const local=[{id:'local',projectId:'a',title:'登记制作规划',createdAt:10,body:'HUGE_LOCAL_BODY'},{id:'local-deleted',projectId:'a',title:'已删手工文稿',createdAt:101,body:'REMOVED_LOCAL_BODY'},{id:'example-doc',projectId:'a',title:'示例资料',source:'example',createdAt:102,body:'EXAMPLE_BODY'}];
  const html=harness({documents,local,deleted:(kind,id)=>kind==='artifact'&&id==='deleted-doc'||kind==='local_artifact'&&id==='local-deleted'}).html();
  assert.equal((html.match(/class="home-document-row"/g)||[]).length,3);assert.ok(html.includes('登记制作规划'));assert.ok(html.includes('执行文稿 4'));assert.ok(html.includes('执行文稿 3'));
  assert.ok(html.includes('data-action="runtime-artifact" data-id="doc-4"'));assert.ok(html.includes('data-action="review-asset" data-id="local"'));assert.ok(html.includes('查看全部 →'));
  for(const text of ['HUGE_','OTHER_PROJECT_BODY','REMOVED_LOCAL_BODY','EXAMPLE_BODY','已删文稿','已删手工文稿','别的项目文稿'])assert.ok(!html.includes(text),text);
  assert.ok(!html.includes('class="runtime-artifact-list"'));assert.ok(!html.includes('class="deliveries-grid"'));
});

test('empty and demo-only workspaces state the lack of real work without inventing thumbnails',()=>{
  for(const projects of [[],[project('a')],[project('demo',{isDemo:true})]]){
    const html=harness({projects}).html();assert.ok(html.includes('还没有生成完成的作品'));assert.ok(!html.includes('class="home-result-card"'));assert.ok(!html.includes('class="home-document-row"'));
    const gallery=html.slice(html.indexOf('<section class="home-results"'),html.indexOf('<section class="home-project-flow"'));assert.ok(!gallery.includes('<img '));assert.ok(!gallery.includes('<video '));
  }
});

test('home media refresh joins the existing read-only refresh path even after an independent workstation',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),body=source.match(/function mediaSurface\(state\)\{([^}]+)\}/)?.[1];assert.ok(body);
  const surface=new Function('state',body);assert.equal(surface({view:'overview',activePeerId:'R03'}),'overview');assert.equal(surface({view:'project',activePeerId:'R03',projectTab:'assets'}),'');assert.equal(surface({view:'project',activeProjectId:'a',projectTab:'assets'}),'assets:a');
});

test('returning from a private workstation loads project documents on home while keeping private scope in that workstation',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),expression=source.match(/const runtimeScope=s=>([^;]+);/)?.[1];assert.ok(expression);
  const scope=new Function('s','V','return '+expression),views={project:()=>({id:'a'})};
  assert.deepEqual(scope({view:'overview',activePeerId:'R03'},views),{projectId:'a'});
  assert.deepEqual(scope({view:'project',activePeerId:'R03'},views),{peerId:'R03'});
  assert.deepEqual(scope({view:'project',activePeerId:null},views),{projectId:'a'});
  const withDemo={project:()=>({id:'demo'}),homeProject:()=>({id:'real-project'})};
  assert.deepEqual(scope({view:'overview',activePeerId:null},withDemo),{projectId:'real-project'});
  assert.deepEqual(scope({view:'project',activePeerId:null},withDemo),{projectId:'demo'});
});

test('the visible lighthouse case stays first when the current real project changes and only uses its own decisions',()=>{
  const demo=project('demo-lighthouse',{title:'灯塔示范',isDemo:true}),h=harness({projects:[project('a'),demo,project('b')],jobs:[job('real-output')]});
  h.state.decisions=[{id:'real-decision-a',projectId:'a',title:'真实项目待拍板',status:'pending',options:['实拍','动画']},{id:'demo-decision',projectId:demo.id,title:'灯塔示范方向',status:'pending',options:['探索解谜','线性叙事']},{id:'real-decision-b',projectId:'b',title:'第二项目待拍板',status:'pending',options:['A','B']}];
  for(const id of ['a','b']){
    h.state.activeProjectId=id;const before=JSON.stringify(h.state),html=h.html(),showcase=html.slice(html.indexOf('<section class="home-showcase"'),html.indexOf('<section class="home-results"'));
    assert.ok(html.indexOf('class="home-showcase"')<html.indexOf('class="home-results"'));assert.ok(showcase.includes('案例与示范'));assert.ok(showcase.includes('data-showcase-project-id="demo-lighthouse"'));
    assert.match(showcase,/<img class="home-reference-art home-reference-cover" src="assets\/projects\/lighthouse-cover\.webp"/);assert.ok(showcase.includes('assets/projects/home-visual-reference.png'));assert.equal((showcase.match(/class="home-reference-art home-reference-/g)||[]).length,3);assert.ok(showcase.includes('class="feature-team"'));assert.ok(showcase.includes('class="decision-visual-options"'));
    assert.ok(showcase.includes('data-action="select-project" data-id="demo-lighthouse"'));assert.ok(showcase.includes('data-action="open-decision" data-id="demo-decision"'));
    assert.ok(!showcase.includes('real-decision-a'));assert.ok(!showcase.includes('real-decision-b'));assert.ok(!showcase.includes('真实项目待拍板'));assert.ok(!showcase.includes('第二项目待拍板'));
    assert.ok(html.includes('data-home-project-id="'+id+'"'));assert.equal(JSON.stringify(h.state),before);
  }
});

test('approved demo directions remain demonstrations and never fall back to real pending decisions',()=>{
  const h=harness({projects:[project('a'),project('demo-lighthouse',{isDemo:true})]});
  h.state.decisions=[{id:'real-pending',projectId:'a',title:'真实决定',status:'pending',options:['A','B']},{id:'demo-approved',projectId:'demo-lighthouse',title:'已确认的示范',status:'approved',options:['示范A','示范B']}];
  const html=h.html(),showcase=html.slice(html.indexOf('<section class="home-showcase"'),html.indexOf('<section class="home-results"'));
  assert.ok(showcase.includes('示范方向'));assert.ok(showcase.includes('demo-approved'));assert.ok(showcase.includes('已记录示例选择'));assert.ok(!showcase.includes('real-pending'));
  h.state.decisions=h.state.decisions.filter(d=>d.id!=='demo-approved');const noDemoDecision=h.html().split('<section class="home-results"')[0];
  assert.ok(noDemoDecision.includes('这个案例暂时没有方向卡'));assert.ok(!noDemoDecision.includes('real-pending'));
});

test('deleted or removed demo projects are never recreated and real work has no empty hero image',()=>{
  for(const retain of [true,false]){
    const projects=[project('a'),...(retain?[project('demo-lighthouse',{isDemo:true})]:[])],html=harness({projects,deleted:(kind,id)=>kind==='project'&&id==='demo-lighthouse'}).html();
    assert.ok(!html.includes('class="home-showcase"'));assert.ok(!html.includes('data-showcase-project-id'));assert.ok(!html.includes('assets/projects/home-visual-reference.png'));assert.ok(!html.includes('artwork-placeholder'));assert.ok(html.includes('data-home-project-id="a"'));
  }
});

test('selecting a demo does not replace the real project documents or route its work buttons to that demo',()=>{
  const demo=project('demo-lighthouse',{isDemo:true}),h=harness({projects:[demo,project('a')],documents:[{id:'demo-doc',projectId:demo.id,title:'示例文稿'},{id:'real-doc',projectId:'a',title:'真实文稿'}]});
  const before=JSON.stringify(h.state),html=h.html();
  assert.equal(h.views.homeProject(h.state).id,'a');assert.ok(html.includes('真实文稿'));assert.ok(!html.includes('示例文稿'));
  assert.ok(html.includes('data-action="home-project-tab" data-id="a" data-project-tab="assets"'));assert.ok(html.includes('data-action="home-project-tab" data-id="a" data-project-tab="tasks"'));
  assert.equal(h.state.activeProjectId,demo.id);assert.equal(JSON.stringify(h.state),before);
});


test('home sample occupies the first row without a duplicate heading and keeps all real work below',()=>{
  const h=harness({projects:[project('a'),project('demo-lighthouse',{isDemo:true})],jobs:[job('real-output')]});
  const html=h.html(),showcase=html.slice(html.indexOf('<section class="home-showcase"'),html.indexOf('<section class="home-results"'));
  assert.ok(showcase.startsWith('<section class="home-showcase" aria-label="案例与示范"><div class="overview-work-grid">'));
  assert.ok(showcase.includes('class="home-feature-eyebrow">案例与示范'));
  assert.ok(!showcase.includes('<h2>案例与示范</h2>'));
  const blocks=['class="home-showcase"','class="home-results"','class="home-project-flow"','class="home-documents"','class="home-next"'];
  blocks.forEach((marker,index)=>{assert.ok(html.includes(marker));if(index)assert.ok(html.indexOf(blocks[index-1])<html.indexOf(marker));});
});

test('home sample progress uses registered example tasks and never claims real completion',()=>{
  const h=harness({projects:[project('a'),project('demo-lighthouse',{isDemo:true})]});
  const ids=['demo-research','demo-story','demo-level','demo-storyboard','demo-prototype','demo-review'];
  h.state.tasks=ids.map((id,index)=>({id,projectId:'demo-lighthouse',title:id,status:index<2?'done':'queued',ownerId:'R04',reviewerId:'R03'}));
  const before=JSON.stringify(h.state),html=h.html(),showcase=html.slice(html.indexOf('<section class="home-showcase"'),html.indexOf('<section class="home-results"'));
  assert.match(showcase,/class="home-demo-phases" aria-label="示例进度，不代表实际制作"/);
  assert.match(showcase,/class="is-done"><i aria-hidden="true"><\/i><b>故事定稿/);
  assert.match(showcase,/class="is-current" aria-current="step"><i aria-hidden="true"><\/i><b>分镜开发/);
  assert.equal((showcase.match(/aria-current="step"/g)||[]).length,1);assert.equal(JSON.stringify(h.state),before);
  h.state.tasks.find(t=>t.id==='demo-story').status='rework';
  assert.match(h.html(),/class="is-current" aria-current="step"><i aria-hidden="true"><\/i><b>故事定稿/);
  h.state.tasks=[];assert.ok(!h.html().includes('class="home-demo-phases"'));
});

test('home sample delivery stays clickable and uses only undeleted example media from that example',()=>{
  const h=harness({projects:[project('a'),project('demo-lighthouse',{isDemo:true})],local:[
    {id:'real-asset',projectId:'a',title:'真实项目图',source:'manual',type:'image'},
    {id:'removed-example',projectId:'demo-lighthouse',title:'已删示例',source:'example',previewKey:'cover'},
    {id:'demo-visible',projectId:'demo-lighthouse',title:'开场分镜 · 示例视觉',source:'example',previewKey:'storyboard',authorId:'R04',reviewStatus:'pending'}
  ],deleted:(kind,id)=>kind==='local_artifact'&&id==='removed-example'});
  h.state.decisions=[{id:'demo-direction',projectId:'demo-lighthouse',title:'示例方向',status:'pending',options:['探索解谜','分支叙事']}];
  const html=h.html(),showcase=html.slice(html.indexOf('<section class="home-showcase"'),html.indexOf('<section class="home-results"'));
  assert.match(showcase,/class="home-demo-delivery" data-action="review-asset" data-id="demo-visible"/);
  assert.ok(showcase.includes('示例 · 待审阅'));assert.ok(showcase.includes('沈知遥 · 示例岗位'));
  assert.ok(!showcase.includes('已删示例'));assert.ok(!showcase.includes('真实项目图'));assert.ok(!showcase.includes('已整理两种方案'));
});

test('three sample deliveries sit directly below the case before real results with live review routes',()=>{
  const demo=project('demo-lighthouse',{isDemo:true}),local=[
    {id:'demo-game-level',projectId:demo.id,title:'首关概念 · 示例视觉',source:'example',version:'v0.1',authorId:'G02',reviewStatus:'accepted'},
    {id:'demo-character',projectId:demo.id,title:'角色设定 · 示例视觉',source:'example',version:'v0.2',authorId:'R05',reviewStatus:'changes'},
    {id:'demo-storyboard',projectId:demo.id,title:'开场分镜 · 示例视觉',source:'example',version:'v0.3',authorId:'R04',reviewStatus:'pending'}
  ];
  const h=harness({projects:[project('a'),demo],local,jobs:[job('real-output')]}),before=JSON.stringify(h.state),html=h.html();
  const start=html.indexOf('<section class="home-recent-deliveries"'),end=html.indexOf('<section class="home-results"'),row=html.slice(start,end);
  assert.ok(start>html.indexOf('<section class="home-showcase"'));assert.ok(end>start);assert.equal((row.match(/class="home-recent-card"/g)||[]).length,3);
  assert.ok(row.includes('<h2>最近交付</h2>'));assert.ok(row.includes('data-action="home-project-tab" data-id="demo-lighthouse" data-project-tab="assets"'));
  for(const [index,id] of ['demo-storyboard','demo-character','demo-game-level'].entries()){
    assert.ok(row.includes('data-action="review-asset" data-id="'+id+'"'));
    if(index)assert.ok(row.indexOf('data-home-example-id="'+['demo-storyboard','demo-character','demo-game-level'][index-1]+'"')<row.indexOf('data-home-example-id="'+id+'"'));
  }
  for(const box of ['28 51 405 130','458 48 412 132','891 48 413 132'])assert.ok(row.includes('viewBox="'+box+'"'));
  assert.equal((row.match(/home-deliveries-reference\.png/g)||[]).length,3);assert.ok(row.includes('v0.3'));assert.ok(row.includes('v0.2'));assert.ok(row.includes('v0.1'));
  for(const status of ['待审阅','待调整','已认可'])assert.ok(row.includes('>'+status+'</button>'));
  assert.ok(!row.includes('小时前'));assert.ok(!row.includes('天前'));assert.ok(!row.includes('真实项目图'));assert.equal(JSON.stringify(h.state),before);
});

test('sample delivery row never resurrects deleted artifacts or projects or substitutes real documents',()=>{
  const demo=project('demo-lighthouse',{isDemo:true}),local=[
    {id:'sample-visible',projectId:demo.id,title:'可见角色',source:'example',previewKey:'character'},
    {id:'sample-removed',projectId:demo.id,title:'已删分镜',source:'example',previewKey:'storyboard'},
    {id:'real-document',projectId:demo.id,title:'实际登记',source:'manual',previewKey:'game'},
    {id:'other-demo-artifact',projectId:'other-demo',title:'其他示例图',source:'example',previewKey:'game'},
    {id:'orphan',projectId:'missing',title:'孤立示例',source:'example',previewKey:'game'},
    {id:'unsupported',projectId:demo.id,title:'资料不应变成图片',source:'example',previewKey:'cover'}
  ];
  const h=harness({projects:[project('a'),demo,project('other-demo',{isDemo:true})],local,deleted:(kind,id)=>kind==='local_artifact'&&id==='sample-removed'}),before=JSON.stringify(h.state),html=h.html(),row=html.slice(html.indexOf('<section class="home-recent-deliveries"'),html.indexOf('<section class="home-results"'));
  assert.equal((row.match(/class="home-recent-card"/g)||[]).length,1);assert.ok(row.includes('data-home-example-id="sample-visible"'));
  for(const id of ['sample-removed','real-document','other-demo-artifact','orphan','unsupported'])assert.ok(!row.includes('data-home-example-id="'+id+'"'));
  assert.equal(JSON.stringify(h.state),before);
  h.runtime.isDeleted=(kind,id)=>kind==='project'&&[demo.id,'other-demo'].includes(id);assert.ok(!h.html().includes('class="home-recent-deliveries"'));
  h.state.projects=[project('a')];assert.ok(!h.html().includes('class="home-recent-deliveries"'));
  const none=harness({projects:[demo],local,deleted:kind=>kind==='local_artifact'});assert.ok(!none.html().includes('class="home-recent-deliveries"'));
});
