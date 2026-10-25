'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Store=require('../lib/store.js');
const root=path.resolve(__dirname,'..');
const project=(id='a',extra={})=>({id,title:'项目 '+id,kind:'film',brief:'DO_NOT_REPEAT_PROJECT_BRIEF',members:['R03','R04'],isDemo:false,createdAt:1,...extra});
const job=(id,extra={})=>({id,projectId:'a',name:'产出 '+id,status:'succeeded',mediaKind:'image',createdAt:1,outputs:[{url:'https://cdn.example.invalid/'+id+'.png',outputType:'png'}],...extra});
const task=(id,extra={})=>({id,projectId:'a',title:'任务 '+id,ownerId:'R03',reviewerId:'R04',status:'done',updatedAt:1,dependencies:[],...extra});
const run=(id,extra={})=>({id,projectId:'a',mode:'produce',status:'succeeded',agentIds:['R03'],artifacts:[],steps:[],messages:[],events:[],createdAt:1,...extra});
const artifact=(id,extra={})=>({id,projectId:'a',authorId:'R03',title:'文稿 '+id,body:'HUGE_BODY_'+id,preview:'HUGE_PREVIEW_'+id,createdAt:1,...extra});
function harness({projects=[project(),project('b')],jobs=[],documents=[],local=[],tasks=[],runs=[],plans=[],deleted=()=>false}={}){
  const win={},context=vm.createContext({window:win,console,URL});
  for(const file of ['data/employees.js','data/project-templates.js','lib/views.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  const store=Store.create(win.TEAM_EMPLOYEES,{storage:{getItem(){return null;},setItem(){}},host:null});
  const state={...store.getState(),view:'project',activeProjectId:projects[0].id,activePeerId:null,projectTab:'overview',projects,tasks,artifacts:local,messages:[],activity:[],decisions:[]};
  const runtime={ready:()=>true,active:r=>['running','queued'].includes(r.status),connection:{state:'online',ready:true},media:{jobs},isDeleted:deleted,artifacts:()=>documents,getRuns:()=>runs,getError:()=>''};
  const production={getProductions:()=>plans};
  const views=win.StudioViews.create(win.TEAM_EMPLOYEES,{getState:()=>state,blockers:()=>[]},runtime,production);
  const html=()=>views.collaboration(state);
  const summary=()=>{const all=html();return all.slice(all.indexOf('<section class="project-stage project-results-summary'),all.indexOf('<aside class="project-discussion"'));};
  return {state,runtime,production,html,summary};
}

test('project summary is the last tab under the compatible overview key',()=>{
  const html=harness().html(),nav=html.match(/<nav class="project-tabs"[\s\S]*?<\/nav>/)[0];
  const ids=[...nav.matchAll(/data-id="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(ids,['production','characters','storyboard','canvas','assets','tasks','versions','overview']);
  assert.match(nav,/data-id="overview" aria-pressed="true">成果汇总<\/button><\/nav>$/);
  assert.ok(!nav.includes('>概览<'));
});

test('empty summary is brief, does not repeat the project brief and never starts work',()=>{
  const h=harness(),before=JSON.stringify(h.state);
  h.runtime.start=()=>assert.fail('must not start a run');h.runtime.submitMedia=()=>assert.fail('must not generate media');
  const html=h.summary();
  assert.match(html,/还没有已完成的任务或交付/);
  assert.match(html,/data-action="project-tab" data-id="production">继续制作/);
  for(const unwanted of ['DO_NOT_REPEAT_PROJECT_BRIEF','artwork-placeholder','stage-art','<img ','<video ','data-form='])assert.ok(!html.includes(unwanted),unwanted);
  assert.equal(JSON.stringify(h.state),before);
});

test('visual deliveries lead, documents follow and completed task records are collapsed by default',()=>{
  const html=harness({jobs:[job('first-visible')],documents:[artifact('script')],tasks:Array.from({length:7},(_,i)=>task('completed-'+i))}).summary();
  assert.ok(html.indexOf('data-result-media="first-visible"')<html.indexOf('data-result-document="script"'));
  assert.ok(html.indexOf('data-result-document="script"')<html.indexOf('<details class="project-result-tasks"'));
  assert.match(html,/<details class="project-result-tasks" data-runtime-detail="project-result-tasks-a"><summary><strong>已完成任务<\/strong><span>7<\/span>/);
  assert.ok(html.includes('7 项完成记录'));assert.equal((html.match(/data-result-task=/g)||[]).length,7);
  assert.ok(!harness().summary().includes('project-result-tasks'));
});

test('only the exact canvas assistant template receives a short task and document title while originals stay intact',()=>{
  const prefix='请只优化当前创作画布卡片的生成提示词，不改写剧本，不启动任何图片或视频生成。只返回可直接用于生成的提示词正文，不加标题、说明、Markdown围栏或审阅清单。\n\n';
  const first=artifact('optimized',{runId:'assistant',title:prefix+'LONG_ORIGINAL_TITLE'}),runOne=run('assistant',{agentIds:['R05'],prompt:prefix+'角色定妆说明',artifacts:[first]});
  const other=artifact('ordinary',{runId:'normal',title:'请优化人物说明，但这是一份普通文稿'}),runTwo=run('normal',{agentIds:['R05'],prompt:'请帮我优化提示词',artifacts:[other]});
  const wrongAgent=artifact('other-agent',{runId:'other-agent-run',title:'普通导演任务'}),runThree=run('other-agent-run',{agentIds:['R04'],prompt:prefix+'内容',artifacts:[wrongAgent]});
  const runs=[runOne,runTwo,runThree],documents=[first,other,wrongAgent],before=JSON.stringify({runs,documents}),html=harness({runs,documents}).summary();
  assert.equal((html.match(/<h4 title="提示词优化 · /g)||[]).length,2);
  assert.ok(!html.includes('LONG_ORIGINAL_TITLE'));assert.ok(html.includes('请优化人物说明，但这是一份普通文稿'));assert.ok(html.includes('普通导演任务'));
  assert.ok(html.includes('data-action="runtime-artifact" data-id="optimized"'));
  assert.equal(JSON.stringify({runs,documents}),before);
});

test('completed task list distinguishes stage, manual and runtime evidence without counting pending work or chat',()=>{
  const plans=[{id:'plan',projectId:'a',status:'running',stages:[{id:'script',title:'剧本交付',agentId:'R03',status:'completed',runId:'stage-run',artifacts:[artifact('script')]},{id:'visual',title:'美术进行中',agentId:'R04',status:'running'}]}];
  const tasks=[task('manual'),task('pending',{status:'queued'}),task('other',{projectId:'b'})];
  const runs=[run('stage-run',{productionId:'plan'}),run('linked',{taskId:'manual'}),run('standalone',{artifacts:[artifact('standalone-file')]}),run('chat',{mode:'chat'}),run('failed',{status:'failed'}),run('other-run',{projectId:'b'})];
  const html=harness({tasks,runs,plans}).summary();
  for(const id of ['plan:script','manual','standalone'])assert.ok(html.includes('data-result-task="'+id+'"'),id);
  assert.equal((html.match(/data-result-task=/g)||[]).length,3);
  assert.ok(html.includes('阶段已交付'));assert.ok(html.includes('手动登记完成'));assert.ok(html.includes('本轮已交付'));
  assert.ok(!html.includes('美术进行中'));
});

test('text delivery rows deduplicate production outputs, retain review state and use the correct open action',()=>{
  const shared=artifact('script',{runId:'stage-run'}),waiting=artifact('visual'),stale=artifact('stale',{runId:'stale-run'});
  const plans=[{id:'plan',projectId:'a',status:'awaiting_review',stages:[{id:'script',status:'completed',runId:'stage-run',artifacts:[shared]},{id:'visual',status:'awaiting_review',artifacts:[waiting]},{id:'stale',status:'stale',runId:'stale-run',artifacts:[stale]}]}];
  const h=harness({plans,documents:[shared,stale,artifact('free'),artifact('foreign',{projectId:'b'}),artifact('example',{source:'example'})],local:[artifact('local',{version:'v2',source:'manual',reviewStatus:'accepted'})]});
  const html=h.summary();
  assert.equal((html.match(/data-result-document=/g)||[]).length,4);
  assert.equal((html.match(/data-result-document="script"/g)||[]).length,1);
  for(const [action,id] of [['production-artifact','script'],['production-artifact','visual'],['runtime-artifact','free'],['review-asset','local']])assert.ok(html.includes('data-action="'+action+'" data-id="'+id+'"'));
  assert.ok(html.includes('待审阅'));assert.ok(html.includes('你已认可'));
  for(const bad of ['HUGE_BODY','HUGE_PREVIEW','文稿 stale','文稿 foreign','文稿 example'])assert.ok(!html.includes(bad),bad);
});

test('returned media has compact actual previews with explicit asset kinds and stable player identity',()=>{
  const jobs=[job('character',{canvasNodeId:'asset-abc'}),job('image',{shotId:'S01',createdAt:2}),job('video',{mediaKind:'video',shotId:'S01',createdAt:3,outputs:[{url:'https://cdn.example.invalid/video.mp4',outputType:'video/mp4'}]}),job('multiple',{outputs:[{url:'https://cdn.example.invalid/first.png',outputType:'png'},{url:'https://cdn.example.invalid/second.webp',outputType:'webp'}]})];
  const html=harness({jobs}).summary();
  for(const label of ['定妆图','生成图片','视频片段','结果已返回'])assert.ok(html.includes(label),label);
  assert.match(html,/<video controls preload="metadata" playsinline src="https:\/\/cdn.example.invalid\/video.mp4"/);
  assert.ok(html.includes('data-media-preview-key="summary:multiple:0:'));assert.ok(html.includes('data-media-preview-key="summary:multiple:1:'));
  assert.ok(html.includes('/assets/media-preview.html?job=video'));assert.ok(html.includes('data-action="media-focus-job" data-id="character"'));
  assert.equal((html.match(/data-result-media=/g)||[]).length,5);
  assert.ok(!html.includes('已验收成片'));assert.ok(!html.includes('autoplay'));
});

const showcaseHTML=html=>html.match(/<section class="project-result-showcase[\s\S]*?<\/section>/)?.[0]||'';
const videoJob=(id,extra={})=>job(id,{mediaKind:'video',outputs:[{url:'https://cdn.example.invalid/'+id+'.mp4',outputType:'video/mp4'}],...extra});

test('showcase leads the component results with the newest returned video, not a refreshed old video or newer image',()=>{
  const jobs=[videoJob('older',{createdAt:1,updatedAt:999}),videoJob('latest',{createdAt:5}),job('newer-image',{createdAt:9})];
  const h=harness({jobs,documents:[artifact('doc')],tasks:[task('done')]}),before=JSON.stringify(h.state),html=h.summary(),hero=showcaseHTML(html);
  assert.match(hero,/data-result-showcase="latest" data-output-index="0" aria-label="作品预览"/);assert.match(hero,/<h3>作品预览<\/h3>/);
  assert.match(hero,/<video controls preload="metadata" playsinline src="https:\/\/cdn.example.invalid\/latest.mp4"/);
  assert.ok(html.indexOf('data-result-showcase=')<html.indexOf('data-result-media='));assert.ok(html.indexOf('data-result-media=')<html.indexOf('data-result-document='));
  assert.equal((html.match(/data-result-media=/g)||[]).length,3);assert.ok(html.includes('<h3>生成结果<span>3</span>'));
  assert.ok(!hero.includes('<h3>最终成片</h3>'));assert.ok(!hero.includes('autoplay'));assert.equal(JSON.stringify(h.state),before);
});

test('image-only projects show the latest actual image while empty or document-only projects have no large placeholder',()=>{
  const hero=showcaseHTML(harness({jobs:[job('older',{createdAt:1}),job('latest-image',{createdAt:2})]}).summary());
  assert.match(hero,/class="project-result-showcase is-image" data-result-showcase="latest-image"/);assert.match(hero,/<img src="https:\/\/cdn.example.invalid\/latest-image.png"/);
  for(const h of [harness(),harness({documents:[artifact('doc')]}),harness({jobs:[job('pending',{status:'running'})]})]){
    const html=h.summary();assert.equal(showcaseHTML(html),'');assert.ok(!html.includes('artwork-placeholder'));assert.ok(!html.includes('data-action="project-showcase"'));
  }
});

test('an explicit selected image and exact output index override automatic video priority without inheriting final status',()=>{
  const outputs=[{url:'https://cdn.example.invalid/front.png',outputType:'png'},{url:'https://cdn.example.invalid/selected-portrait.png',outputType:'image/png'}];
  const p=project('a',{resultShowcase:{jobId:'portrait',outputIndex:1,final:true}}),html=harness({projects:[p],jobs:[videoJob('new-video',{createdAt:99}),job('portrait',{outputs})]}).summary(),hero=showcaseHTML(html);
  assert.match(hero,/data-result-showcase="portrait" data-output-index="1"/);assert.ok(hero.includes('selected-portrait.png'));assert.ok(!hero.includes('front.png'));assert.match(hero,/<h3>作品预览<\/h3>/);assert.ok(!hero.includes('<h3>最终成片</h3>'));
  assert.match(html,/data-action="project-showcase" data-id="portrait" data-output-index="1" aria-pressed="true">当前主展示/);
  assert.ok(!html.includes('data-action="project-final-video" data-id="portrait"'));
});

test('only an explicit final flag for the exact valid selected video marks the showcase as final',()=>{
  for(const final of [true,false,'true',1,undefined]){
    const p=project('a',{resultShowcase:{jobId:'selected',outputIndex:0,final}}),html=harness({projects:[p],jobs:[videoJob('latest',{createdAt:99}),videoJob('selected',{createdAt:1})]}).summary(),hero=showcaseHTML(html);
    assert.match(hero,/data-result-showcase="selected"/);
    assert.equal(hero.includes('<h3>最终成片</h3>'),final===true);assert.equal(hero.includes('<h3>作品预览</h3>'),final!==true);
    assert.ok(html.includes('data-action="project-final-video" data-id="selected" data-output-index="0" aria-pressed="'+(final===true)+'"'));
  }
  const named=showcaseHTML(harness({jobs:[videoJob('named',{name:'最终成片'})]}).summary());assert.match(named,/<h3>作品预览<\/h3>/);
});

test('invalid, foreign, deleted, unsuccessful or unsafe showcase choices fall back without claiming final delivery',()=>{
  const jobs=[videoJob('fallback'),videoJob('foreign',{projectId:'b',createdAt:99}),videoJob('deleted',{createdAt:100}),videoJob('failed',{status:'failed',createdAt:101}),job('unsafe',{outputs:[{url:'javascript:alert(1)',outputType:'video'}]}),job('text',{outputs:[],textOutputs:[{text:'JSON'}]})];
  const choices=[{jobId:'foreign',outputIndex:0},{jobId:'deleted',outputIndex:0},{jobId:'failed',outputIndex:0},{jobId:'unsafe',outputIndex:0},{jobId:'text',outputIndex:0},{jobId:'missing',outputIndex:0},{jobId:'fallback',outputIndex:-1},{jobId:'fallback',outputIndex:99},{jobId:'fallback',outputIndex:'0'},{jobId:'fallback',outputIndex:0.5},{jobId:'fallback'},null];
  for(const choice of choices){
    const p=project('a',{resultShowcase:choice?{...choice,final:true}:null}),hero=showcaseHTML(harness({projects:[p],jobs,deleted:(_kind,id)=>id==='deleted'}).summary());
    assert.match(hero,/data-result-showcase="fallback" data-output-index="0"/);assert.match(hero,/<h3>作品预览<\/h3>/);assert.ok(!hero.includes('<h3>最终成片</h3>'));
  }
  const noFallback=harness({projects:[project('a',{resultShowcase:{jobId:'foreign',outputIndex:0,final:true}})],jobs:[videoJob('foreign',{projectId:'b'})]}).summary();assert.equal(showcaseHTML(noFallback),'');
});

test('showcase and component players have distinct stable keys and per-output actions never turn images into final videos',()=>{
  const outputs=[{url:'https://cdn.example.invalid/image.png',outputType:'image/png'},{url:'https://cdn.example.invalid/clip.mp4',outputType:'video/mp4'}];
  const p=project('a',{resultShowcase:{jobId:'mixed',outputIndex:1,final:false}}),html=harness({projects:[p],jobs:[job('mixed',{name:'<script>unsafe title</script>',outputs})]}).summary();
  assert.ok(html.includes('data-media-preview-key="showcase:mixed:1:'));assert.ok(html.includes('data-media-preview-key="summary:mixed:1:'));
  assert.equal((html.match(/data-action="project-showcase"/g)||[]).length,2);assert.equal((html.match(/data-action="project-final-video"/g)||[]).length,1);
  assert.match(html,/data-action="project-final-video" data-id="mixed" data-output-index="1"/);assert.ok(!html.includes('<script>unsafe title</script>'));assert.ok(html.includes('&lt;script&gt;unsafe title&lt;/script&gt;'));
  assert.ok(showcaseHTML(html).includes('/assets/media-preview.html?job=mixed'));
});

test('summary excludes other projects, deleted entries and nonvisual or unsuccessful media but keeps returned media after source deletion',()=>{
  const jobs=[job('kept',{sourceArtifactId:'deleted-doc'}),job('other',{projectId:'b'}),job('demo',{projectId:'demo'}),job('deleted-media'),job('queued',{status:'queued'}),job('failed',{status:'failed'}),job('unknown',{status:'unknown'}),job('empty',{outputs:[]}),job('text',{outputs:[],textOutputs:[{text:'HUGE_MEDIA_TEXT'}]}),job('pdf',{outputs:[{url:'https://cdn.example.invalid/file.pdf',outputType:'pdf'}]})];
  const deleted=(_kind,id)=>id.startsWith('deleted-');
  const plans=[{id:'deleted-plan',projectId:'a',stages:[{id:'script',status:'completed',artifacts:[artifact('plan-file')]}]}];
  const html=harness({jobs,plans,deleted,tasks:[task('deleted-task')],documents:[artifact('deleted-doc'),artifact('run-file',{runId:'deleted-run'})],local:[artifact('deleted-local')],runs:[run('deleted-run'),run('plan-run',{productionId:'deleted-plan',artifacts:[artifact('plan-file')]})]}).summary();
  assert.equal((html.match(/data-result-media=/g)||[]).length,1);assert.ok(html.includes('data-result-media="kept"'));
  assert.ok(!html.includes('data-result-task='));assert.ok(!html.includes('data-result-document='));assert.ok(!html.includes('HUGE_MEDIA_TEXT'));
  assert.ok(!harness({jobs,deleted:kind=>kind==='project'}).summary().includes('data-result-media='));
});

test('summary rejects unsafe output URLs and escapes untrusted titles',()=>{
  const unsafe=['javascript:alert(1)','http://cdn.example.invalid/a.png','https://user:secret@cdn.example.invalid/a.png','https://cdn.example.invalid/a.png" onerror="alert(1)','data:image/png;base64,abc'];
  const jobs=unsafe.map((url,i)=>job('unsafe-'+i,{outputs:[{url,outputType:'png'}]}));
  jobs.push(job('safe',{name:'<script>bad</script>',outputs:[null,{url:'https://cdn.example.invalid/good.png?x=1&y=2',outputType:'png'}]}));
  const html=harness({jobs,documents:[artifact('safe-doc',{title:'<img src=x onerror=alert(1)>'})]}).summary();
  assert.equal((html.match(/data-result-media=/g)||[]).length,1);assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<script>bad</script>'));assert.ok(html.includes('good.png?x=1&amp;y=2'));
});

test('an unfinished project keeps returned deliverables visible while completed document flow points to character preparation',()=>{
  for(const status of ['running','paused','failed','awaiting_review','completed']){
    const plans=[{id:'plan',projectId:'a',status,stages:[]}],html=harness({plans,jobs:[job('available')]}).summary();
    assert.ok(html.includes('data-result-media="available"'));
    assert.ok(html.includes('data-action="project-tab" data-id="'+(status==='completed'?'characters':'production')+'">继续制作'));
  }
});

test('demo summary keeps labeled visual examples separate from real production results',()=>{
  const local=[artifact('demo-storyboard',{projectId:'demo',source:'example',previewKey:'storyboard'}),artifact('real-doc',{projectId:'demo',source:'manual'})];
  const h=harness({projects:[project('demo',{isDemo:true})],local,jobs:[job('real-image',{projectId:'demo'})],documents:[artifact('runtime-doc',{projectId:'demo'})],tasks:[task('example',{projectId:'demo'})]});
  const html=h.summary();
  assert.ok(html.includes('assets/projects/storyboard.webp'));assert.ok(html.includes('示例视觉 · 设计示意'));assert.ok(html.includes('示例完成记录'));
  for(const value of ['real-image','real-doc','runtime-doc','data-result-media='])assert.ok(!html.includes(value),value);
});

test('film opens automatic collaboration while saved overview links and game routing stay compatible',()=>{
  const employees=[{id:'R03'},{id:'R04'},{id:'G01'},{id:'G02'}],store=Store.create(employees,{storage:{getItem(){return null;},setItem(){}},host:null});
  for(const [kind,members,tab] of [['film',['R03','R04'],'production'],['game',['G01','G02'],'overview']]){
    const result=store.dispatch({type:'CREATE_PROJECT',title:kind,kind,members,useTemplate:false});assert.equal(result.ok,true,result.error);
    assert.equal(store.getState().projectTab,tab);
    assert.equal(store.dispatch({type:'SET_UI',projectTab:'overview'}).ok,true);
    const saved=Store.normalize(store.getState(),employees);assert.equal(saved.projectTab,'overview');
    assert.equal(store.dispatch({type:'SELECT_PROJECT',id:result.id}).ok,true);assert.equal(store.getState().projectTab,tab);
  }
  assert.ok(harness({projects:[project('game',{kind:'game'})]}).summary().includes('data-action="project-tab" data-id="tasks">继续制作'));
});

test('read-only media refresh covers project summary and keeps editor views outside the timer',()=>{
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8'),fn=source.match(/function mediaSurface\(state\)\{[^\n]+\}/)[0];
  const surface=vm.runInNewContext('('+fn+')');
  assert.equal(surface({view:'project',activeProjectId:'a',projectTab:'overview'}),'overview:a');
  assert.equal(surface({view:'overview',activeProjectId:'a'}),'overview');
  for(const projectTab of ['characters','canvas','production'])assert.equal(surface({view:'project',activeProjectId:'a',projectTab}),'');
  assert.equal(surface({view:'project',activeProjectId:'a',projectTab:'overview',activePeerId:'R03'}),'');
});
