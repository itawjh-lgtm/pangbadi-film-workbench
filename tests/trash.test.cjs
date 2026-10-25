'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const Trash=require('../lib/trash.js'),Runtime=require('../lib/runtime.js'),Production=require('../lib/production.js'),Store=require('../lib/store.js');
const entry=(kind,targetId,projectId)=>({id:'trash-'+targetId,kind,targetId,projectId,title:targetId,deletedAt:'2026-10-25T01:00:00Z'});
const raw={view:'project',activeProjectId:'p1',selectedTaskId:'t1',projects:[{id:'p1'},{id:'p2'},{id:'demo',isDemo:true}],tasks:[{id:'t1',projectId:'p1'},{id:'t2',projectId:'p2'}],decisions:[{id:'d1',projectId:'p1'}],artifacts:[{id:'a1',projectId:'p1'}],messages:[{id:'n1',projectId:'p1'},{id:'n2',peerId:'R04'}]};
test('project deletion hides descendants without changing the workspace snapshot; restoration keeps child tombstones',()=>{
 const before=JSON.stringify(raw),deleted=[entry('project','p1','p1'),entry('task','t1','p1')],visible=Trash.visibleState(raw,deleted);
 assert.equal(JSON.stringify(raw),before);assert.deepEqual(visible.projects.map(x=>x.id),['p2','demo']);assert.equal(visible.activeProjectId,'p2');assert.equal(visible.selectedTaskId,'t2');assert.deepEqual(visible.messages.map(x=>x.id),['n2']);assert.equal(visible.artifacts.length,0);
 const restored=Trash.visibleState(raw,[deleted[1]]);assert.equal(restored.projects.length,3);assert.deepEqual(restored.tasks.map(x=>x.id),['t2']);assert.equal(restored.artifacts.length,1);
 assert.equal(Trash.visibleState({...raw,projects:[raw.projects[0]]},deleted).view,'overview');
});
test('deleted dependencies are explained and cannot silently become ready',()=>{
 const state={tasks:[{id:'t2',projectId:'p1',dependencies:['t1'],decisionId:'d1'}]};
 const reasons=Trash.blockers(state,[entry('task','t1','p1'),entry('decision','d1','p1')],'t2',[]);
 assert.equal(reasons.length,2);assert.match(reasons.join(' '),/回收站/);
});
test('trash buttons and rows escape names, attributes and project labels',()=>{
 const malicious='\"><img src=x onerror=alert(1)>';
 const html=Trash.deleteButton('artifact',malicious,'p1',malicious)+Trash.render([{...entry('artifact','a1','p1'),title:malicious}],{projects:[{id:'p1',title:malicious}]} );
 assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.match(html,/data-action="trash-restore"/);assert.match(html,/data-action="trash-purge"/);assert.match(html,/data-action="trash-purge-selected" disabled/);
});
const json=(data,ok=true)=>({ok,status:ok?200:409,json:async()=>data});
function harness(){
 let items=[],tombstones=[],reject=false,rejectPurge=false,pendingRead=null,holdNextRead=false;const calls=[];
 const run={id:'r1',projectId:'p1',productionId:'prod1',status:'succeeded',prompt:'old',artifacts:[{id:'a1',body:'body',runId:'r1'}]};
 const runtime=Runtime.create({setTimeout:()=>1,clearTimeout(){},fetch:async(url,options)=>{
  calls.push({url,options});
  if(url==='/api/health')return json({ok:true,service:'dream-studio-runtime',csrfToken:'fake-csrf',provider:{available:true,authenticated:true}});
  if(url==='/api/roles')return json({roles:[]});
  if(url==='/api/trash'&&options.method==='GET'){
   const saved=items.slice(),savedTombstones=tombstones.slice();if(holdNextRead){holdNextRead=false;return new Promise(resolve=>{pendingRead=(fail=false)=>resolve(fail?json({error:'旧读取失败'},false):json({items:saved,tombstones:savedTombstones}));});}return json({items:saved,tombstones:savedTombstones});
  }
  if(url==='/api/trash'){
   if(reject)return json({error:'请等待执行完成'},false);
   items=items.concat(JSON.parse(options.body).items.map(x=>entry(x.kind,x.targetId,x.projectId)));return json({items,tombstones});
  }
  if(url==='/api/trash/purge'){
   if(rejectPurge)return json({error:'彻底删除失败'},false);
   const body=JSON.parse(options.body);assert.equal(body.confirmation,'permanent-delete');
   const ids=new Set(body.ids);tombstones.push(...items.filter(x=>ids.has(x.id)).map(x=>({...x,purgedAt:'2026-10-25T02:00:00Z'})));items=items.filter(x=>!ids.has(x.id));return json({items,tombstones});
  }
  if(url.endsWith('/restore')){items=items.filter(x=>x.id!==url.split('/')[3]);return json({items,tombstones});}
  if(url.startsWith('/api/runs?'))return json({runs:[run]});
  if(url==='/api/media/jobs')return json({jobs:[{id:'m1',projectId:'p1',status:'succeeded'}]});
  if(url==='/api/connections')return json({providers:[]});
  if(url.endsWith('/storyboard'))return json({projectId:'p1',shots:[{id:'S01',sourceArtifactId:'a1'}],sources:[{id:'a1'}]});
  throw new Error(url);
 }});
 return {runtime,calls,reject:()=>{reject=true;},rejectPurge:value=>{rejectPurge=value;},hold:()=>{holdNextRead=true;},release:fail=>pendingRead(fail),replace:(next,removed=[])=>{items=next;tombstones=removed;}};
}
test('runtime hides and restores jobs, runs, inherited artifacts and cached storyboards without destroying raw caches',async()=>{
 const {runtime:r,calls}=harness();await r.connect();await r.loadScope({projectId:'p1'});await r.refreshMedia();await r.loadStoryboard('p1');
 await r.trashItems([{kind:'media',targetId:'m1',projectId:'p1'}]);assert.equal(r.media.jobs.length,0);
 await r.trashItems([{kind:'run',targetId:'r1',projectId:'p1'}]);assert.equal(r.getRuns({projectId:'p1'}).length,0);assert.equal(r.artifacts({projectId:'p1'}).length,0);assert.equal(r.getStoryboard('p1').shots.length,0);
 await r.restoreTrash('trash-r1');assert.equal(r.getRuns({projectId:'p1'}).length,1);assert.equal(r.getStoryboard('p1').shots.length,1);assert.equal(r.media.jobs.length,0);
 await r.trashItems([{kind:'artifact',targetId:'a1',projectId:'p1'},{kind:'production',targetId:'prod1',projectId:'p1'}]);assert.equal(r.getRuns({projectId:'p1'}).length,0);
 await r.restoreTrash('trash-prod1');assert.equal(r.getRuns({projectId:'p1'}).length,1);assert.equal(r.artifacts({projectId:'p1'}).length,0);assert.equal(r.findArtifact('a1'),undefined);
 assert.ok(calls.filter(x=>x.options.method==='POST').every(x=>x.url.startsWith('/api/trash')));r.dispose();
});
test('failed deletion keeps item visible and does not invent a tombstone',async()=>{
 const h=harness();await h.runtime.connect();await h.runtime.loadScope({projectId:'p1'});h.reject();
 await assert.rejects(h.runtime.trashItems([{kind:'run',targetId:'r1',projectId:'p1'}]),/等待/);assert.equal(h.runtime.getRuns({projectId:'p1'}).length,1);assert.equal(h.runtime.trash.items.length,0);h.runtime.dispose();
});
test('late trash reads cannot resurrect a deletion and another window restore is visible after refresh',async()=>{
 const h=harness();await h.runtime.connect();h.hold();const stale=h.runtime.refreshTrash();
 await h.runtime.trashItems([{kind:'project',targetId:'p1'}]);h.release();await stale;assert.equal(h.runtime.isDeleted('project','p1'),true);
 h.replace([]);await h.runtime.refreshTrash();assert.equal(h.runtime.isDeleted('project','p1'),false);h.runtime.dispose();
});
test('production reads filter stage/attempt run and artifact tombstones while raw cache survives polling',async()=>{
 let deleted=[];const plan={id:'prod1',projectId:'p1',revision:2,status:'completed',stages:[{id:'script',runId:'r1',artifacts:[{id:'a1'}],history:[{runId:'old-run',artifacts:[{id:'old-a'}]}]}]};
 const p=Production.create({setTimeout:()=>1,clearTimeout(){},request:async()=>({productions:[plan]}),isDeleted:(...args)=>Trash.isDeleted(deleted,...args)});
 await p.refresh('p1');deleted=[entry('run','r1','p1')];assert.equal(p.getProductions('p1')[0].stages[0].artifacts.length,0);assert.equal(p.findArtifact('old-a').id,'old-a');
 await p.refresh('p1');deleted=[];assert.equal(p.findArtifact('a1').id,'a1');deleted=[entry('production','prod1','p1')];assert.equal(p.getProductions('p1').length,0);deleted=[];assert.equal(p.getProductions('p1').length,1);p.dispose();
});
function viewHarness(){const win={},ctx=vm.createContext({window:win,console});for(const file of ['data/employees.js','data/project-templates.js','lib/trash.js','lib/production-views.js','lib/views.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);return win;}
test('project, task, decision, note, manual artifact and completed run expose deletion actions on their cards',()=>{
 const w=viewHarness(),store=Store.create(w.TEAM_EMPLOYEES,{storage:{getItem(){return null},setItem(){}},host:null}),s=store.getState(),v=w.StudioViews.create(w.TEAM_EMPLOYEES,store);
 assert.match(v.sidebar(s).projects,/data-kind="project"/);assert.match(v.overview(s),/data-kind="project"/);assert.match(v.board(s),/data-kind="task"/);assert.match(v.board(s),/data-kind="decision"/);assert.match(v.collaboration(s),/data-kind="note"/);assert.match(v.artifacts(s),/data-kind="local_artifact"/);
 assert.match(v.runtimeRun({id:'r',status:'succeeded',createdAt:1,events:[]}),/data-kind="run"/);assert.ok(!v.runtimeRun({id:'r',status:'running',createdAt:1,events:[]}).includes('data-kind="run"'));
});
test('soft-deleted contents release active capacity but survive normalize, save and restore',()=>{
 const w=viewHarness(),deleted=new Set(),store=Store.create(w.TEAM_EMPLOYEES,{storage:{getItem(){return null},setItem(){}},host:null,isDeleted:(kind,id)=>deleted.has(kind+':'+id)});
 for(let i=store.getState().artifacts.length;i<40;i++)assert.equal(store.dispatch({type:'ADD_ARTIFACT',projectId:'demo-lighthouse',title:'草稿'+i,body:'正文'}).ok,true);
 assert.equal(store.dispatch({type:'ADD_ARTIFACT',projectId:'demo-lighthouse',title:'满了',body:'正文'}).ok,false);
 const id=store.getState().artifacts[0].id;deleted.add('local_artifact:'+id);assert.equal(store.dispatch({type:'ADD_ARTIFACT',projectId:'demo-lighthouse',title:'新的',body:'正文'}).ok,true);
 assert.equal(store.getState().artifacts.length,41);assert.equal(Store.normalize(store.getState(),w.TEAM_EMPLOYEES).artifacts.length,41);
 assert.equal(store.getState().artifacts.some(a=>a.id===id),true);
});

test('oversized imports are rejected before replacing existing records',()=>{
 const w=viewHarness(),store=Store.create(w.TEAM_EMPLOYEES,{storage:{getItem(){return null},setItem(){}},host:null}),before=store.getState(),oversized={...before,projects:Array.from({length:201},(_,i)=>({...before.projects[0],id:'p-'+i}))};
 assert.equal(Store.normalize(oversized,w.TEAM_EMPLOYEES),null);assert.throws(()=>store.restore(oversized));assert.deepEqual(store.getState(),before);
});

test('project-scoped node ids never hide a same-id node in another project',()=>{
 const items=[entry('canvas_node','shared-node-id','projectA')];
 assert.equal(Trash.isDeleted(items,'canvas_node','shared-node-id','projectA'),true);
 assert.equal(Trash.isDeleted(items,'canvas_node','shared-node-id','projectB'),false);
 assert.equal(Trash.isDeleted(items,'canvas_node','shared-node-id'),true);
 assert.equal(Trash.isDeleted([entry('project','projectA','projectA')],'canvas_node','shared-node-id','projectA'),true);
 assert.equal(Trash.isDeleted([entry('project','projectA','projectA')],'canvas_node','shared-node-id','projectB'),false);
});

test('permanently deleted tombstones stay effective but are absent from recoverable rows and selections',()=>{
 const project={...entry('project','p1','p1'),purgedAt:'2026-10-25T02:00:00Z'},live=entry('media','m2','p2'),restored={...entry('task','t2','p2'),restoredAt:'2026-10-25T02:00:00Z'},items=[project,live,restored];
 const before=JSON.stringify(items),html=Trash.render(items,raw,'',true,[project.id,live.id,restored.id,'missing']);
 assert.deepEqual(Trash.recoverable(items).map(x=>x.id),[live.id]);assert.deepEqual(Trash.selectedIds(items,new Set([project.id,live.id,restored.id,'missing'])),[live.id]);
 assert.equal(Trash.isDeleted(items,'project','p1'),true);assert.equal(Trash.isDeleted(items,'artifact','old-document','p1'),true);assert.equal(Trash.isDeleted(items,'project','p2'),false);
 assert.deepEqual(Trash.visibleState(raw,items).projects.map(x=>x.id),['p2','demo']);assert.equal(JSON.stringify(items),before);
 assert.match(html,/已选 1 \/ 1 项/);assert.match(html,/data-trash-select-all[^>]+ checked/);assert.ok(!html.includes('data-id="trash-p1"'));assert.ok(!html.includes('data-trash-select="trash-t2"'));
 const empty=Trash.render([project],raw);assert.match(empty,/回收站是空的/);assert.ok(!empty.includes('data-action="trash-empty"'));assert.ok(!empty.includes('data-action="trash-restore"'));
});

test('selected and all-item purge actions require a separate escaped irreversible confirmation',()=>{
 const one={...entry('artifact','a1','p1'),title:'<img src=x onerror=alert(1)>'},two=entry('media','m1','p1'),purged={...entry('project','old','old'),purgedAt:'now'};
 const html=Trash.render([one,two,purged],raw,'',true,[one.id]);
 assert.match(html,/data-action="trash-purge-selected">删除所选/);assert.match(html,/data-action="trash-empty">清空回收站/);assert.match(html,/已选 1 \/ 2 项/);assert.ok(!html.includes('data-trash-select-all aria-label="全选回收站内容" checked'));
 const confirmation=Trash.purgeConfirmation([one,two,purged],[one.id,purged.id,'missing']);
 assert.match(confirmation,/彻底删除这 1 项内容/);assert.match(confirmation,/无法从回收站恢复/);assert.match(confirmation,/不会删除 RunningHub 平台上的文件/);assert.match(confirmation,/data-action="close-dialog">取消/);assert.match(confirmation,/data-action="trash-purge-confirm">确认彻底删除 1 项/);
 assert.ok(!confirmation.includes('<img'));assert.ok(confirmation.includes('&lt;img'));assert.ok(!confirmation.includes('data-action="trash-purge"'));
});

test('runtime keeps purged project tombstones through refresh so stale local records and cached results cannot reappear',async()=>{
 const h=harness(),r=h.runtime;await r.connect();await r.loadScope({projectId:'p1'});await r.refreshMedia();
 await r.trashItems([{kind:'project',targetId:'p1',projectId:'p1'}]);await r.purgeTrash(['trash-p1']);
 const post=h.calls.find(call=>call.url==='/api/trash/purge');assert.equal(post.options.method,'POST');assert.equal(post.options.headers['X-Studio-Token'],'fake-csrf');assert.deepEqual(JSON.parse(post.options.body),{ids:['trash-p1'],confirmation:'permanent-delete'});
 assert.equal(Trash.recoverable(r.trash.items).length,0);assert.equal(r.trash.items.length,1);assert.ok(r.trash.items[0].purgedAt);
 await r.refreshTrash();await r.loadScope({projectId:'p1'},true);await r.refreshMedia();
 assert.equal(r.getRuns({projectId:'p1'}).length,0);assert.equal(r.artifacts({projectId:'p1'}).length,0);assert.equal(r.media.jobs.length,0);assert.deepEqual(r.visibleState(raw).projects.map(x=>x.id),['p2','demo']);r.dispose();
});

test('late pre-purge trash reads cannot reinsert permanently deleted rows',async()=>{
 const h=harness(),r=h.runtime;await r.connect();await r.trashItems([{kind:'media',targetId:'m1',projectId:'p1'}]);h.hold();const oldRead=r.refreshTrash();
 await r.purgeTrash(['trash-m1']);h.release();await oldRead;
 assert.equal(Trash.recoverable(r.trash.items).length,0);assert.equal(r.isDeleted('media','m1','p1'),true);assert.ok(r.trash.items[0].purgedAt);r.dispose();
});

test('a failed stale read does not replace the successful permanent deletion state with an old error',async()=>{
 const h=harness(),r=h.runtime;await r.connect();await r.trashItems([{kind:'media',targetId:'m1',projectId:'p1'}]);h.hold();const oldRead=r.refreshTrash();
 await r.purgeTrash(['trash-m1']);h.release(true);await oldRead;
 assert.equal(r.trash.error,'');assert.equal(Trash.recoverable(r.trash.items).length,0);assert.equal(r.isDeleted('media','m1','p1'),true);r.dispose();
});

test('purge rejection preserves recoverable entries, does not invent permanent tombstones and leaves subsequent writes usable',async()=>{
 const h=harness(),r=h.runtime;await r.connect();await r.trashItems([{kind:'media',targetId:'m1',projectId:'p1'}]);const before=r.trash.items;
 h.rejectPurge(true);await assert.rejects(r.purgeTrash(['trash-m1']),/彻底删除失败/);assert.deepEqual(r.trash.items,before);assert.equal(r.trash.items[0].purgedAt,undefined);
 h.rejectPurge(false);await r.purgeTrash(['trash-m1']);await r.trashItems([{kind:'task',targetId:'t2',projectId:'p2'}]);assert.equal(Trash.recoverable(r.trash.items).length,1);assert.equal(r.isDeleted('media','m1','p1'),true);r.dispose();
});

function appTrashHarness({items=[entry('media','one','p1'),entry('media','two','p1')],purge=async()=>{},refresh=async()=>{}}={}){
 const source=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
 const selection=source.slice(source.indexOf('  function syncTrashSelection(){'),source.indexOf("  root.addEventListener('change'",source.indexOf('  function syncTrashSelection(){')));
 const actions=source.slice(source.indexOf("    if(action==='trash-refresh')"),source.indexOf("    if(action==='trash-delete'||"));
 const calls=[],toasts=[],dialog={open:false,markup:''},error={isConnected:false,hidden:true,textContent:''},controls={count:{},all:{},selected:{}},boxes=[];
 const runtime={connection:{state:'online'},get trash(){return {items};},purgeTrash:async ids=>{calls.push([...ids]);await purge(ids);items=items.map(item=>ids.includes(item.id)?{...item,purgedAt:'now'}:item);},refreshMedia:refresh,loadScope:async()=>{},refreshTrash:async()=>{}};
 const workspaceSync={blocked:()=>false,status:{state:'synced'},retry:async()=>{}};
 const context=vm.createContext({window:{StudioTrash:Trash},runtime,workspaceSync,production:{refresh:async()=>{}},V:{project:()=>({id:'p1'})},runtimeScope:()=>({projectId:'p1'}),visibleState:()=>({activeProjectId:'p1'}),toast:text=>toasts.push(text),showDialog:markup=>{dialog.open=true;dialog.markup=markup;error.isConnected=true;error.hidden=true;},closeDialog:()=>{dialog.open=false;error.isConnected=false;},one:selector=>selector==='[data-trash-purge-error]'?error:selector==='[data-trash-select-all]'?controls.all:selector==='[data-trash-selection-count]'?controls.count:selector==='[data-action="trash-purge-selected"]'?controls.selected:null,all:()=>boxes,console});
 vm.runInContext('const trashSelection=new Set();let pendingTrashPurge=null,trashPurgeBusy=false;'+selection+'\nasync function act(control){const action=control.dataset.action,id=control.dataset.id;'+actions+'}\nthis.api={act,select:ids=>{trashSelection.clear();ids.forEach(id=>trashSelection.add(id));syncTrashSelection();},selected:()=>[...trashSelection],pending:()=>pendingTrashPurge,busy:()=>trashPurgeBusy,sync:syncTrashSelection};',context);
 function syncBoxes(){boxes.splice(0,boxes.length,...Trash.recoverable(items).map(item=>({dataset:{trashSelect:item.id},checked:false})));context.api.sync();}
 syncBoxes();
 const handle=(action,id)=>{const control={dataset:{action,id},textContent:'确认彻底删除',disabled:false,isConnected:true};return {control,promise:context.api.act(control)};};
 return {...context.api,handle,calls,toasts,dialog,error,controls,workspaceSync,runtime,syncBoxes,replace:next=>{items=next;syncBoxes();}};
}

test('app keeps an exact selection through confirmation and does not submit until the final button',async()=>{
 const h=appTrashHarness();h.select(['trash-one']);assert.equal(h.controls.all.indeterminate,true);assert.equal(h.controls.count.textContent,'已选 1 / 2 项');
 await h.handle('trash-purge-selected').promise;assert.equal(h.calls.length,0);assert.deepEqual(Array.from(h.pending()),['trash-one']);assert.match(h.dialog.markup,/确认彻底删除 1 项/);
 h.select(['trash-two']);await h.handle('trash-purge-confirm').promise;assert.deepEqual(h.calls,[['trash-one']]);assert.deepEqual(Array.from(h.selected()),['trash-two']);assert.equal(h.dialog.open,false);assert.equal(h.pending(),null);
});

test('app prevents repeat confirmation during an in-flight purge and retains selection after a failure for retry',async()=>{
 let reject;const h=appTrashHarness({purge:()=>new Promise((_resolve,fail)=>{reject=fail;})});h.select(['trash-one']);await h.handle('trash-purge-selected').promise;
 const first=h.handle('trash-purge-confirm');await h.handle('trash-purge-confirm').promise;assert.equal(h.calls.length,1);assert.equal(h.busy(),true);assert.equal(first.control.disabled,true);
 reject(new Error('磁盘忙，请重试'));await first.promise;assert.equal(h.busy(),false);assert.equal(first.control.disabled,false);assert.equal(h.dialog.open,true);assert.equal(h.error.hidden,false);assert.equal(h.error.textContent,'磁盘忙，请重试');assert.deepEqual(Array.from(h.selected()),['trash-one']);assert.deepEqual(Array.from(h.pending()),['trash-one']);
});

test('app prunes missing, restored and purged selections and exposes select-all state without selecting new rows',async()=>{
 const h=appTrashHarness();h.select(['trash-one','trash-two','not-found']);assert.equal(h.controls.all.checked,true);assert.equal(h.controls.all.indeterminate,false);
 h.replace([{...entry('media','one','p1'),purgedAt:'now'},entry('media','two','p1'),entry('media','new','p1')]);assert.deepEqual(Array.from(h.selected()),['trash-two']);assert.equal(h.controls.all.checked,false);assert.equal(h.controls.all.indeterminate,true);
 h.replace([{...entry('media','two','p1'),restoredAt:'now'}]);assert.deepEqual(Array.from(h.selected()),[]);assert.equal(h.controls.selected.disabled,true);assert.equal(h.controls.count.textContent,'已选 0 / 0 项');
});

test('app empty-trash confirmation snapshots only recoverable entries and respects offline or sync-blocked state',async()=>{
 const items=[entry('media','one','p1'),{...entry('media','purged','p1'),purgedAt:'now'},entry('task','two','p1')],h=appTrashHarness({items});
 h.runtime.connection.state='offline';await h.handle('trash-empty').promise;assert.equal(h.dialog.open,false);assert.equal(h.calls.length,0);
 h.runtime.connection.state='online';await h.handle('trash-empty').promise;assert.deepEqual(Array.from(h.pending()),['trash-one','trash-two']);
 h.workspaceSync.blocked=()=>true;await h.handle('trash-purge-confirm').promise;assert.equal(h.calls.length,0);assert.equal(h.dialog.open,true);assert.equal(h.error.hidden,false);assert.match(h.error.textContent,/项目同步/);
});

test('app reports completed deletion separately when a later list refresh fails',async()=>{
 const h=appTrashHarness({refresh:async()=>{throw new Error('列表读取失败');}});h.select(['trash-one']);await h.handle('trash-purge-selected').promise;await h.handle('trash-purge-confirm').promise;
 assert.deepEqual(h.calls,[['trash-one']]);assert.equal(h.dialog.open,false);assert.equal(h.pending(),null);assert.deepEqual(Array.from(h.selected()),[]);assert.equal(h.busy(),false);
 assert.match(h.toasts.at(-1),/彻底删除已完成，部分列表稍后刷新/);assert.ok(!h.toasts.includes('列表读取失败'));assert.equal(Trash.isDeleted(h.runtime.trash.items,'media','one','p1'),true);
});

test('app waits for workspace saving and preserves confirmation without sending purge if saving is unresolved',async()=>{
 const h=appTrashHarness();h.select(['trash-one']);await h.handle('trash-purge-selected').promise;h.workspaceSync.status.state='saving';
 await h.handle('trash-purge-confirm').promise;assert.equal(h.calls.length,0);assert.equal(h.dialog.open,true);assert.match(h.error.textContent,/项目仍在保存/);assert.deepEqual(Array.from(h.pending()),['trash-one']);
 h.workspaceSync.retry=async()=>{h.workspaceSync.status.state='synced';};await h.handle('trash-purge-confirm').promise;assert.deepEqual(h.calls,[['trash-one']]);assert.equal(h.dialog.open,false);
});

test('current refresh errors keep all permanent hiding markers and clear after a successful retry',async()=>{
 const h=harness(),r=h.runtime;await r.connect();await r.trashItems([{kind:'project',targetId:'p1',projectId:'p1'}]);await r.purgeTrash(['trash-p1']);
 h.hold();const failed=r.refreshTrash();h.release(true);await failed;assert.match(r.trash.error,/读取失败/);assert.equal(r.isDeleted('project','p1'),true);assert.equal(Trash.recoverable(r.trash.items).length,0);
 await r.refreshTrash();assert.equal(r.trash.error,'');assert.equal(r.isDeleted('project','p1'),true);r.dispose();
});
