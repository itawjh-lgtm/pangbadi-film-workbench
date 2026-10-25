const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const win={}; const ctx=vm.createContext({window:win,console});
for(const file of ['data/employees.js','data/project-templates.js','lib/production-views.js','lib/media-views.js','lib/views.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx,{filename:file});
const Store=require(path.join(root,'lib/store.js'));
const storage={getItem(){return null},setItem(){}};
const store=Store.create(win.TEAM_EMPLOYEES,{storage,host:null}),V=win.StudioViews.create(win.TEAM_EMPLOYEES,store);
const state=store.getState(), outputs=[];
function check(label,fn){const html=fn();assert.equal(typeof html,'string',label);assert.ok(html.length>0,label);assert.ok(!html.includes('[object Object]'),label);outputs.push({label,html});}
for(const [name,func] of Object.entries({overview:V.overview,project:V.collaboration,tasks:V.board,team:V.team,assets:V.artifacts,connections:V.connections}))check(name,()=>func(state));
for(const projectTab of ['production','media','overview','storyboard','assets','tasks','versions'])check('project/'+projectTab,()=>V.collaboration({...state,projectTab}));
for(const selectedShot of ['cover','storyboard','character','game'])check('shot/'+selectedShot,()=>V.collaboration({...state,projectTab:'storyboard',selectedShot}));
for(const filter of ['all','film','game','favorites'])check('team/'+filter,()=>V.team({...state,filter}));
check('team/no-results',()=>V.team({...state,query:'NOT-A-MEMBER'}));
check('team/page2',()=>V.team({...state,page:2}));
for(const e of win.TEAM_EMPLOYEES)check('member/'+e.id,()=>V.employeeDetails(e,state,false));
check('personal workbench',()=>V.collaboration({...state,activePeerId:'R04'}));
check('new project',()=>V.projectForm());
const p=state.projects[0];
check('new task',()=>V.taskForm(p,state));
check('new artifact',()=>V.artifactForm(p,state));
for(const t of state.tasks)check('task/'+t.id,()=>V.taskDetails(t,state));
for(const d of state.decisions)check('decision/'+d.id,()=>V.decisionForm(d,state));
for(const a of state.artifacts)check('review/'+a.id,()=>V.artifactDetails(a,state));
for(const q of ['','分镜','灯塔','R04','来源','nothing-match'])check('search/'+q,()=>V.searchResults(q,state));
const empty={...state,activeProjectId:null,projects:[],tasks:[],artifacts:[],decisions:[],messages:[],activity:[]};
for(const [name,func] of Object.entries({overview:V.overview,project:V.collaboration,tasks:V.board,assets:V.artifacts,connections:V.connections}))check('empty/'+name,()=>func(empty));
check('empty/personal',()=>V.collaboration({...empty,activePeerId:'R04'}));
const manual={...state,activeProjectId:'manual-project',projects:[{...p,id:'manual-project',isDemo:false}],tasks:[],artifacts:[],decisions:[],messages:[]};
for(const [name,func] of Object.entries({overview:V.overview,project:V.collaboration,tasks:V.board,assets:V.artifacts})){
  const html=func(manual);assert.ok(!html.includes('assets/projects/'),name+' must not show example images on a new manual project');check('manual/'+name,()=>html);
}
const autoArtifact={id:'auto-a1',title:'真实剧本文稿',body:'全文',url:'/api/artifacts/auto-a1',filename:'script.md',authorId:'R03'};
const autoStage={id:'script',title:'剧本',agentId:'R03',status:'awaiting_review',attempt:1,artifacts:[autoArtifact],history:[{attempt:1,artifacts:[{...autoArtifact,id:'auto-old'}]}]};
for(const status of ['running','awaiting_review','paused','failed','completed']){
  const plan={id:'auto-prod',projectId:p.id,prompt:'真实项目需求',status,revision:3,reviewMode:'continuous',stages:[{...autoStage,status:status==='completed'?'completed':'awaiting_review'}],events:[]};
  const client={getProductions:()=>[plan],getError:()=>'',active:item=>item.status!=='completed',isBusy:()=>false,isStarting:()=>false,ready:()=>true,enabled:()=>true,find:()=>plan};
  const liveViews=win.StudioViews.create(win.TEAM_EMPLOYEES,store,null,client,{getDraft:()=>({note:'未提交意见',expectedRevision:2})});
  check('auto/'+status,()=>liveViews.collaboration({...state,projectTab:'production'}));
  if(status==='awaiting_review')check('auto/artifact',()=>liveViews.productionArtifactDetails({...autoArtifact,productionId:plan.id,stageId:'script'}));
}
const actions=[...new Set(outputs.flatMap(o=>[...o.html.matchAll(/data-action="([^"]+)"/g)].map(m=>m[1])))];
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
for(const action of actions)assert.ok(app.includes("action==='"+action+"'"), 'Missing controller for '+action);
const forms=[...new Set(outputs.flatMap(o=>[...o.html.matchAll(/data-form="([^"]+)"/g)].map(m=>m[1])))];
for(const form of forms)assert.ok(app.includes("form.dataset.form==='"+form+"'"),'Missing submit handler for '+form);
const art=state.artifacts.find(a=>a.id==='demo-storyboard');assert.ok(art,'seeded visual artifact exists');
assert.match(V.artifactDetails(art,state),/记录人为你/);
assert.match(V.searchResults('开场分镜',state),/data-action="review-asset"/);
const generatedImgPaths=[...new Set(outputs.flatMap(o=>[...o.html.matchAll(/<img[^>]*src="([^"]+)"/g)].map(m=>m[1])))];
for(const rel of generatedImgPaths)assert.ok(fs.existsSync(path.join(root,rel)),'Missing image '+rel);
console.log(JSON.stringify({renderCases:outputs.length,actions:actions.sort(),forms:forms.sort(),imagePaths:generatedImgPaths.length,manualProjectImageIsolation:'passed',searchArtifacts:'passed',result:'passed',browserValidation:'not performed'},null,2));
