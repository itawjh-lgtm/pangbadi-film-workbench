import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const moduleURL=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function compile(file){return ts.transpileModule(await readFile(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;}
const coreURL=moduleURL(await compile('cloud/core.ts'));
const workspaceURL=moduleURL((await compile('cloud/workspace.ts')).replace(/from ['"]\.\/core['"]/g,'from '+JSON.stringify(coreURL)));
const {RecordStore}=await import(coreURL);
const {workspaceRoute}=await import(workspaceURL);
const migrations=await Promise.all((await readdir(path.join(root,'drizzle'))).filter(name=>name.endsWith('.sql')).sort().map(name=>readFile(path.join(root,'drizzle',name),'utf8')));
function context(){
 const db=new DatabaseSync(':memory:');for(const migration of migrations)db.exec(migration);
 const adapter={prepare(sql){const statement=db.prepare(sql);return{bind(...args){return{
  async first(){return statement.get(...args)||null;},
  async all(){return{results:statement.all(...args)};},
  async run(){return{meta:{changes:Number(statement.run(...args).changes)}};}
 };}};}};
 return{ctx:{store:new RecordStore(adapter,'workspace-regression-user')},close:()=>db.close()};
}
function initialState(){return{
 version:3,
 projects:[{id:'hidden-project',title:'待恢复项目'},{id:'other-project',title:'其他项目'}],
 tasks:[{id:'hidden-task',projectId:'hidden-project',title:'原始任务',status:'todo'},{id:'other-task',projectId:'other-project',title:'其他任务'}],
 decisions:[{id:'hidden-decision',projectId:'hidden-project',title:'原始决策'}],
 artifacts:[{id:'hidden-artifact',projectId:'hidden-project',body:'原始文稿'}],
 messages:[{id:'hidden-note',projectId:'hidden-project',body:'原始便笺'}],
 activity:[],favorites:[]
};}

test('a filtered snapshot cannot discard a recoverable project or any of its child content',async()=>{
 const {ctx,close}=context();
 try{
  const original=initialState(),workspace=await ctx.store.put('workspace',{id:'current',state:original},0);
  await workspaceRoute(ctx,'/api/trash','POST',{items:[{kind:'project',targetId:'hidden-project'}]});
  const {items}=await(await workspaceRoute(ctx,'/api/trash','GET',{})).json();
  assert.equal(items.length,1);
  // An older window synchronizes only the visible project, while editing an unrelated task.
  const visible=structuredClone(original);
  visible.projects=visible.projects.filter(p=>p.id!=='hidden-project');
  for(const key of ['tasks','decisions','artifacts','messages'])visible[key]=visible[key].filter(item=>item.projectId!=='hidden-project');
  visible.tasks[0].title='其他项目的新编辑';
  await workspaceRoute(ctx,'/api/workspace','POST',{state:visible,expectedRevision:workspace.revision});
  await workspaceRoute(ctx,'/api/trash/'+items[0].id+'/restore','POST',{});
  const restored=(await ctx.store.get('workspace','current')).state;
  assert.deepEqual(restored.projects.find(p=>p.id==='hidden-project'),original.projects[0]);
  for(const key of ['tasks','decisions','artifacts','messages'])assert.deepEqual(restored[key].filter(item=>item.projectId==='hidden-project'),original[key].filter(item=>item.projectId==='hidden-project'),key+' must survive restore');
  assert.equal(restored.tasks.find(task=>task.id==='other-task').title,'其他项目的新编辑');
  assert.equal((await(await workspaceRoute(ctx,'/api/trash','GET',{})).json()).items.length,0);
 }finally{close();}
});

for(const status of ['queued','running','submitting','stopping'])test('standalone role run cannot be deleted while '+status,async()=>{
 const {ctx,close}=context();
 try{
  await ctx.store.create('run',{id:'standalone-run',peerId:'R03',projectId:null,status});
  await assert.rejects(workspaceRoute(ctx,'/api/trash','POST',{items:[{kind:'run',targetId:'standalone-run'}]}),{status:409});
  assert.equal((await ctx.store.get('run','standalone-run')).status,status);
  assert.equal((await ctx.store.list('trash')).length,0);
 }finally{close();}
});

test('a completed standalone role run can still be deleted and restored',async()=>{
 const {ctx,close}=context();
 try{
  await ctx.store.create('run',{id:'finished-run',peerId:'R03',projectId:null,status:'succeeded'});
  const result=await(await workspaceRoute(ctx,'/api/trash','POST',{items:[{kind:'run',targetId:'finished-run'}]})).json();
  assert.equal(result.items.length,1);assert.equal(result.items[0].projectId,null);
  assert.ok(await ctx.store.get('run','finished-run'));
  await workspaceRoute(ctx,'/api/trash/'+result.items[0].id+'/restore','POST',{});
  assert.equal((await(await workspaceRoute(ctx,'/api/trash','GET',{})).json()).items.length,0);
  assert.equal((await ctx.store.get('run','finished-run')).status,'succeeded');
 }finally{close();}
});
