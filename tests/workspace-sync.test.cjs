const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Store=require('../lib/store.js'),Sync=require('../lib/workspace-sync.js');
const win={};vm.runInNewContext(fs.readFileSync(require.resolve('../data/employees.js'),'utf8'),{window:win});
const employees=win.TEAM_EMPLOYEES,KEY='creative-workbench-v3',clone=x=>JSON.parse(JSON.stringify(x));
class Storage{constructor(){this.data=new Map();}getItem(k){return this.data.get(k)||null;}setItem(k,v){this.data.set(k,v);}}
const initial=()=>Store.initialState(employees);
function database(initialState=null){return {workspace:initialState?{revision:1,state:clone(initialState),updatedAt:1}:null,posts:[],online:true,
 async fetch(path,options){if(!this.online)throw new Error('断线');let result,status=200;
 if(path==='/api/health')result={service:'dream-studio-runtime',workspaceSync:true,projectId:'test-project-root',csrfToken:'token'};
 else if(options.method==='POST'){const body=JSON.parse(options.body);this.posts.push(body);assert.equal(options.headers['X-Studio-Token'],'token');
 if((this.workspace?.revision||0)!==body.expectedRevision){status=409;result={error:'版本冲突'};}
 else {this.workspace={revision:body.expectedRevision+1,state:body.state,updatedAt:2};result={workspace:this.workspace};}}
 else result={workspace:this.workspace};
 return {ok:status===200,status,json:async()=>clone(result)};}};}
function harness(db,storage=new Storage()){const store=Store.create(employees,{storage,host:null});const timers=new Map();let timer=0;
 const sync=Sync.create(store,{storage,fetch:db.fetch.bind(db),setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)});return {store,sync,storage};}
function add(store,title){const r=store.dispatch({type:'CREATE_PROJECT',title,kind:'film',members:['R03','R04']});assert.equal(r.ok,true);return r.id;}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function delayWorkspaceReads(db){const original=db.fetch.bind(db),pending=[];let enabled=false;
 db.fetch=async(path,options)=>{const response=await original(path,options);if(enabled&&path==='/api/workspace'&&options.method==='GET'){const gate=deferred();pending.push(gate);await gate.promise;}return response;};
 return {pending,enable(){enabled=true;},disable(){enabled=false;}};}

test('fresh WK client reads saved projects without uploading demo data',async()=>{const saved=initial();saved.projects.push({id:'real',title:'用户原项目',kind:'film',brief:'',members:['R03','R04'],isDemo:false,createdAt:3});const db=database(saved),h=harness(db);
 assert.equal(h.store.dispatch({type:'SEARCH',query:'during boot'}).ok,false);await h.sync.start();
 assert.ok(h.store.getState().projects.some(p=>p.id==='real'));assert.equal(db.posts.length,0);assert.equal(h.sync.blocked(),false);h.sync.dispose();});
test('empty database does not receive an untouched default example',async()=>{const db=database(),h=harness(db);await h.sync.start();assert.equal(db.posts.length,0);assert.equal(db.workspace,null);add(h.store,'第一个项目');await h.sync.retry();assert.equal(db.posts.length,1);assert.ok(db.workspace.state.projects.some(p=>p.title==='第一个项目'));h.sync.dispose();});
test('legacy browser migrates once and relaunch restores shared snapshot',async()=>{const storage=new Storage(),legacy=initial();legacy.projects.push({id:'legacy',title:'旧浏览器项目',kind:'film',brief:'',members:['R03','R04'],isDemo:false,createdAt:3});storage.setItem(KEY,JSON.stringify(legacy));const db=database(),h=harness(db,storage);await h.sync.start();assert.equal(db.posts.length,1);assert.equal(JSON.parse(storage.getItem(KEY)).projects.at(-1).id,'legacy');h.sync.dispose();const reopened=harness(db,storage);await reopened.sync.start();assert.equal(db.posts.length,1);assert.ok(reopened.store.getState().projects.some(p=>p.id==='legacy'));reopened.sync.dispose();});
test('navigation stays per window without triggering database writes',async()=>{const db=database(initial()),h=harness(db);await h.sync.start();h.store.dispatch({type:'NAVIGATE',view:'team'});await h.sync.retry();assert.equal(db.posts.length,0);assert.equal(h.store.getState().view,'team');h.sync.dispose();});
test('two clients preserve a concurrent local edit and require explicit conflict resolution',async()=>{const db=database(initial()),a=harness(db),b=harness(db);await a.sync.start();await b.sync.start();add(a.store,'客户端甲');add(b.store,'客户端乙');await a.sync.retry();await b.sync.retry();assert.equal(b.sync.status.state,'conflict');assert.ok(b.store.getState().projects.some(p=>p.title==='客户端乙'));assert.ok(!db.workspace.state.projects.some(p=>p.title==='客户端乙'));assert.ok(JSON.parse(b.storage.getItem(Sync.BACKUPS)).some(x=>x.state.projects.some(p=>p.title==='客户端乙')));await b.sync.useRemote();assert.ok(b.store.getState().projects.some(p=>p.title==='客户端甲'));assert.equal(b.sync.status.state,'synced');a.sync.dispose();b.sync.dispose();});
test('offline changes remain local and synchronize after recovery',async()=>{const db=database(initial()),h=harness(db);await h.sync.start();db.online=false;add(h.store,'离线稿');await h.sync.retry();await Promise.resolve();assert.equal(h.sync.status.state,'offline');assert.ok(JSON.parse(h.storage.getItem(KEY)).projects.some(p=>p.title==='离线稿'));db.online=true;await h.sync.retry();assert.ok(db.workspace.state.projects.some(p=>p.title==='离线稿'));h.sync.dispose();});
test('remote normalization still rejects forged employee messages and false task completion',async()=>{const saved=initial();saved.messages.push({id:'forged',projectId:'demo-lighthouse',authorId:'R03',text:'伪造的真实员工发言',isExample:false,time:1});saved.tasks[0].status='done';saved.tasks[0].evidence='';saved.tasks[0].reviewNote='';const h=harness(database(saved));await h.sync.start();assert.ok(!h.store.getState().messages.some(m=>m.id==='forged'));assert.notEqual(h.store.getState().tasks[0].status,'done');h.sync.dispose();});
test('restoring a JSON snapshot preserves the previous state before replacing it',async()=>{const db=database(initial()),h=harness(db);await h.sync.start();const id=add(h.store,'导入前项目');await h.sync.retry();await h.sync.importState(initial());assert.ok(!h.store.getState().projects.some(p=>p.id===id));assert.ok(h.sync.exportData().localBackups.some(b=>b.state.projects.some(p=>p.id===id)));h.sync.dispose();});
test('mismatched existing browser state never silently overwrites database',async()=>{const storage=new Storage(),saved=initial();saved.projects.push({id:'other',title:'另一浏览器',kind:'film',brief:'',members:['R03','R04'],isDemo:false,createdAt:3});storage.setItem(KEY,JSON.stringify(saved));const db=database(initial()),h=harness(db,storage);await h.sync.start();assert.equal(h.sync.status.state,'conflict');assert.equal(db.posts.length,0);assert.ok(h.store.getState().projects.some(p=>p.id==='other'));h.sync.dispose();});

test('duplicate restore clicks share synchronization exclusion and cannot overwrite later edits',async()=>{
 const db=database(initial()),reads=delayWorkspaceReads(db),h=harness(db);await h.sync.start();add(h.store,'恢复前本地稿');
 reads.enable();const first=h.sync.useRemote();await Promise.resolve();await Promise.resolve();
 assert.equal(h.sync.status.state,'loading');assert.equal(h.sync.blocked(),true);
 assert.equal(h.store.dispatch({type:'CREATE_PROJECT',title:'读取中不允许创建',kind:'film',members:['R03','R04']}).ok,false);
 assert.throws(()=>h.sync.importState(initial()),/正在同步/);
 await assert.rejects(h.sync.useRemote(),/正在同步/);await h.sync.retry();
 assert.equal(reads.pending.length,1,'a second restore or retry must not issue another GET');
 reads.disable();reads.pending[0].resolve();await first;
 const freshId=add(h.store,'首个响应后的新项目');await Promise.resolve();
 assert.ok(h.store.getState().projects.some(p=>p.id===freshId));
 assert.ok(h.sync.exportData().localBackups.some(b=>b.state.projects.some(p=>p.title==='恢复前本地稿')));
 await h.sync.retry();assert.ok(db.workspace.state.projects.some(p=>p.id===freshId));h.sync.dispose();
});
test('restore detects out-of-band local changes before applying a delayed response',async()=>{
 const db=database(initial()),reads=delayWorkspaceReads(db),h=harness(db);await h.sync.start();reads.enable();
 const restoring=h.sync.useRemote();await Promise.resolve();await Promise.resolve();
 const changed=h.store.getState();changed.projects.push({id:'host-change',title:'宿主恢复的新项目',kind:'film',brief:'',members:['R03','R04'],isDemo:false,createdAt:3});h.store.restore(changed);
 reads.disable();reads.pending[0].resolve();await assert.rejects(restoring,/本页数据发生变化/);
 assert.equal(h.sync.status.state,'conflict');assert.ok(h.store.getState().projects.some(p=>p.id==='host-change'));
 assert.ok(h.sync.exportData().localBackups.some(b=>b.state.projects.some(p=>p.id==='host-change')));
 await h.sync.useRemote();assert.equal(h.sync.status.state,'synced','a retry must work after the mutex is released');h.sync.dispose();
});
test('restore network errors recover to conflict and release the mutex',async()=>{
 const db=database(initial()),h=harness(db);await h.sync.start();const id=add(h.store,'网络失败要保留');db.online=false;
 await assert.rejects(h.sync.useRemote(),/断线/);assert.equal(h.sync.status.state,'conflict');assert.ok(h.store.getState().projects.some(p=>p.id===id));
 db.online=true;await h.sync.useRemote();assert.equal(h.sync.status.state,'synced');assert.equal(h.sync.blocked(),false);h.sync.dispose();
});
test('manual restore and imports cannot race an ordinary polling request',async()=>{
 const db=database(initial()),reads=delayWorkspaceReads(db),h=harness(db);await h.sync.start();reads.enable();
 const polling=h.sync.retry();await Promise.resolve();await Promise.resolve();
 await assert.rejects(h.sync.useRemote(),/正在同步/);assert.throws(()=>h.sync.importState(initial()),/正在同步/);
 assert.equal(reads.pending.length,1);reads.disable();reads.pending[0].resolve();await polling;h.sync.dispose();
});
test('unchanged remote data that normalizes differently never restores or rerenders on later polls',async()=>{
 const saved=initial();saved.messages.push({id:'forged',projectId:'demo-lighthouse',authorId:'R03',text:'伪造员工发言',isExample:false,time:1});
 saved.tasks[0].status='done';saved.tasks[0].evidence='';saved.tasks[0].reviewNote='';
 const db=database(saved),h=harness(db);await h.sync.start();const revision=h.store.getState().revision;
 assert.notEqual(Sync.contentKey(h.store.getState()),Sync.contentKey(saved));
 let changes=0;const off=h.store.subscribe(s=>{if(s.revision!==revision)changes++;});
 await h.sync.retry();await h.sync.retry();assert.equal(h.store.getState().revision,revision);assert.equal(changes,0);assert.equal(db.posts.length,0);
 const metadata=JSON.parse(h.storage.getItem(Sync.META));assert.equal(metadata.rawRemoteKey,Sync.contentKey(saved));assert.equal(metadata.normalizedLocalKey,Sync.contentKey(h.store.getState()));
 off();h.sync.dispose();await Promise.resolve();
 const reopened=harness(db,h.storage),reopenedRevision=reopened.store.getState().revision;await reopened.sync.start();
 assert.equal(reopened.store.getState().revision,reopenedRevision,'persisted normalization baselines must survive relaunch');
 db.workspace={revision:2,state:clone(saved),updatedAt:2};db.workspace.state.projects[0].title='真正的新远端标题';await reopened.sync.retry();
 assert.equal(reopened.store.getState().projects[0].title,'真正的新远端标题');assert.ok(reopened.store.getState().revision>reopenedRevision);reopened.sync.dispose();
});
