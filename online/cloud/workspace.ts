import {APIError,json,uid,now,requireId,type Context} from './core';
const fields:Record<string,string>={project:'projects',task:'tasks',decision:'decisions',local_artifact:'artifacts',note:'messages'};
const kinds=new Set([...Object.keys(fields),'run','artifact','media','production','canvas_node']);
function cleanState(state:any,markers:any[]){const projects=new Set(markers.filter(t=>t.kind==='project').map(t=>t.targetId));const copy=structuredClone(state);for(const [kind,key] of Object.entries(fields))copy[key]=(copy[key]||[]).filter((item:any)=>!projects.has(item.projectId)&&!(kind==='project'&&projects.has(item.id))&&!markers.some(t=>t.kind===kind&&t.targetId===item.id));return copy;}
async function snapshot(ctx:Context){const all=(await ctx.store.list('trash')).filter(t=>!t.restoredAt);return {items:all.filter(t=>!t.purgedAt),tombstones:all.filter(t=>t.purgedAt)};}
async function activeProject(ctx:Context,pid:string){for(const kind of ['run','media','production','batch'])if((await ctx.store.list(kind)).some(r=>r.projectId===pid&&['queued','running','submitting','stopping'].includes(r.status)))throw new APIError('项目仍有任务执行，请停止或等待完成后再删除。',409);}
async function resolve(ctx:Context,item:any){
  if(!item||!kinds.has(item.kind))throw new APIError('删除类型无效。');requireId(item.targetId);
  const ws=await ctx.store.get('workspace','current');let entity:any;
  if(fields[item.kind])entity=ws?.state?.[fields[item.kind]]?.find((r:any)=>r.id===item.targetId);
  else if(item.kind==='canvas_node'){const doc=await ctx.store.get('canvas',requireId(item.projectId));entity=doc?.nodes?.find((n:any)=>n.id===item.targetId);}
  else entity=await ctx.store.get(item.kind,item.targetId);
  if(!entity)throw new APIError('没有找到属于当前账号的内容。',404);
  const projectId=item.kind==='project'?entity.id:entity.projectId||item.projectId||null;
  if(['queued','running','submitting','stopping'].includes(entity.status))throw new APIError('此内容仍在执行，请等待完成后再删除。',409);
  if(item.kind==='artifact'&&entity.runId){const run=await ctx.store.get('run',entity.runId);if(run&&['queued','running','submitting'].includes(run.status))throw new APIError('文稿仍在执行，请等待完成后再删除。',409);}
  if(projectId)await activeProject(ctx,projectId);
  return {id:await uid(),kind:item.kind,targetId:item.targetId,projectId,title:String(entity.title||entity.name||entity.id).slice(0,200),deletedAt:now()};
}
async function purge(ctx:Context,entry:any){
  const pid=entry.kind==='project'?entry.targetId:null;
  if(entry.projectId)await activeProject(ctx,entry.projectId);
  if(pid){for(const kind of ['run','artifact','media','production','canvas','canvas_batch','canvas_claim','batch','estimate'])for(const row of await ctx.store.list(kind))if(row.projectId===pid||kind==='canvas'&&row.id===pid)await ctx.store.remove(kind,row.id);}
  else if(!fields[entry.kind]){
    if(entry.kind==='canvas_node'){const doc=await ctx.store.get('canvas',entry.projectId);if(doc){doc.nodes=doc.nodes.filter((n:any)=>n.id!==entry.targetId);doc.characterAssets=(doc.characterAssets||[]).filter((a:any)=>a.nodeId!==entry.targetId);await ctx.store.put('canvas',doc);}}
    else{if(entry.kind==='production'){for(const run of await ctx.store.list('run'))if(run.productionId===entry.targetId){for(const a of await ctx.store.list('artifact'))if(a.runId===run.id)await ctx.store.remove('artifact',a.id);await ctx.store.remove('run',run.id);}}await ctx.store.remove(entry.kind,entry.targetId);if(entry.kind==='run')for(const a of await ctx.store.list('artifact'))if(a.runId===entry.targetId)await ctx.store.remove('artifact',a.id);}
  }
  await ctx.store.put('trash',{...entry,purgedAt:now()});
}
export async function workspaceRoute(ctx:Context,path:string,method:string,data:any){
  if(path==='/api/workspace'){
    let current=await ctx.store.get('workspace','current');
    if(method==='POST'){
      if(!Number.isInteger(data.expectedRevision)||data.expectedRevision<0||data.state?.version!==3||data.state.truncated||data.state.pointerOnly)throw new APIError('请提供完整工作台快照和正确版本。');
      for(const key of ['projects','tasks','decisions','artifacts','messages','activity','favorites'])if(!Array.isArray(data.state[key])||data.state[key].length>1200)throw new APIError('工作台数据格式或数量无效。');
      if(new TextEncoder().encode(JSON.stringify(data.state)).length>950000)throw new APIError('项目列表超过云端单次保存容量，请导出并整理历史内容。',413);
      const trash=await ctx.store.list('trash');const state=cleanState(data.state,trash.filter(t=>t.purgedAt));
      // Preserve recoverable originals when an older tab sends a filtered view.
      if(current){
        const hidden=trash.filter(t=>!t.restoredAt&&!t.purgedAt),hiddenProjects=new Set(hidden.filter(t=>t.kind==='project').map(t=>t.targetId));
        for(const [kind,key] of Object.entries(fields))for(const previous of current.state[key]||[]){
          const preserve=hiddenProjects.has(previous.projectId)||hidden.some(t=>t.kind===kind&&t.targetId===previous.id);
          if(preserve&&!state[key].some((r:any)=>r.id===previous.id))state[key].push(previous);
        }
      }
      if(JSON.stringify(current?.state)!==JSON.stringify(state))current=await ctx.store.put('workspace',{id:'current',state},data.expectedRevision);
    }
    return json({workspace:current});
  }
  if(!path.startsWith('/api/trash'))return null;
  if(path==='/api/trash'&&method==='POST'){
    if(!Array.isArray(data.items)||!data.items.length||data.items.length>100)throw new APIError('请选择 1–100 项内容。');
    const resolved=[];for(const item of data.items)resolved.push(await resolve(ctx,item));
    const old=await ctx.store.list('trash');for(const item of resolved){const existing=old.find(t=>t.kind===item.kind&&t.targetId===item.targetId&&t.projectId===item.projectId);if(existing?.purgedAt)throw new APIError('内容已彻底删除。',409);if(!existing?.deletedAt||existing.restoredAt)await ctx.store.put('trash',{...item,id:existing?.id||item.id});}
  }else if(method==='POST'&&path==='/api/trash/purge'){
    if(data.confirmation!=='permanent-delete'||!Array.isArray(data.ids)||!data.ids.length||data.ids.length>100)throw new APIError('请选择要彻底删除的内容并确认。');
    const entries=[];for(const id of data.ids){const row=await ctx.store.require('trash',requireId(id));if(row.restoredAt)throw new APIError('已恢复的内容不能直接彻底删除。');entries.push(row);}
    for(const entry of entries)await purge(ctx,entry);
    const ws=await ctx.store.get('workspace','current');if(ws)await ctx.store.put('workspace',{...ws,state:cleanState(ws.state,(await ctx.store.list('trash')).filter(t=>t.purgedAt))});
  }else if(method==='POST'&&/^\/api\/trash\/[-\w]+\/restore$/.test(path)){
    const entry=await ctx.store.require('trash',path.split('/')[3]);if(entry.purgedAt)throw new APIError('已彻底删除，无法恢复。',409);await ctx.store.put('trash',{...entry,restoredAt:now()});
  }else if(!(method==='GET'&&path==='/api/trash'))return null;
  return json(await snapshot(ctx));
}
