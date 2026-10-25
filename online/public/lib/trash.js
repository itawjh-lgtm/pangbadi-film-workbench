/* Reversible deletion is an overlay; never persist a filtered workspace snapshot. */
(function (global) {
  'use strict';
  const labels={project:'项目',task:'任务',decision:'决策',local_artifact:'手工成果',note:'项目便笺',run:'工作对话',artifact:'交付文稿',media:'图片 / 视频',production:'自动协作',canvas_node:'画布节点'};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const entries=items=>(Array.isArray(items)?items:[]).filter(item=>item&&!item.restoredAt);
  function isDeleted(items,kind,targetId,projectId){
    return entries(items).some(item=>item.kind===kind&&item.targetId===targetId&&(!projectId||item.projectId===projectId)||(kind!=='project'&&projectId&&item.kind==='project'&&item.targetId===projectId));
  }
  function visibleState(raw,items){
    const state={...raw};
    for(const [key,kind] of Object.entries({projects:'project',tasks:'task',decisions:'decision',artifacts:'local_artifact',messages:'note'}))state[key]=(raw[key]||[]).filter(item=>!isDeleted(items,kind,item.id,item.projectId));
    if(!state.projects.some(item=>item.id===state.activeProjectId)){
      state.activeProjectId=(state.projects.find(item=>!item.isDemo)||state.projects[0])?.id||null;
      if(!state.activeProjectId&&!state.activePeerId&&state.view==='project')state.view='overview';
    }
    if(!state.tasks.some(item=>item.id===state.selectedTaskId))state.selectedTaskId=state.tasks.find(item=>item.projectId===state.activeProjectId)?.id||null;
    return state;
  }
  function blockers(raw,items,taskId,original=[]){
    const task=(raw.tasks||[]).find(item=>item.id===taskId);if(!task)return original;
    const notices=[];
    for(const id of task.dependencies||[])if(isDeleted(items,'task',id,task.projectId))notices.push('上游任务已移入回收站，请先恢复后继续。');
    if(task.decisionId&&isDeleted(items,'decision',task.decisionId,task.projectId))notices.push('关联决策已移入回收站，请先恢复后继续。');
    return [...new Set([...notices,...original])];
  }
  function deleteButton(kind,id,projectId='',label='删除',disabled=false){
    return '<button type="button" class="trash-action cursor-interaction" data-action="trash-delete" data-kind="'+esc(kind)+'" data-id="'+esc(id)+'"'+(projectId?' data-project-id="'+esc(projectId)+'"':'')+' title="'+esc(disabled?'请先停止或等待当前执行完成':'移入回收站，可随时恢复')+'" aria-label="'+esc(label)+'"'+(disabled?' disabled':'')+'><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg><span>'+esc(label)+'</span></button>';
  }
  const recoverable=items=>entries(items).filter(item=>!item.purgedAt);
  function selectedIds(items,selected){const chosen=new Set(selected||[]);return recoverable(items).filter(item=>chosen.has(item.id)).map(item=>item.id);}
  function purgeConfirmation(items,ids){
    const chosen=new Set(ids),list=recoverable(items).filter(item=>chosen.has(item.id));
    return '<h2>彻底删除这 '+list.length+' 项内容？</h2><p class="trash-warning">彻底删除后无法从回收站恢复。</p><ul class="trash-confirm-list">'+list.map(item=>'<li>'+esc(item.title||'未命名内容')+'</li>').join('')+'</ul><p class="context-note">删除项目会同时清除其所属内容。仅清理本工作台的本地内容，不会删除 RunningHub 平台上的文件；已有导出备份仍保留。</p><p class="form-error" role="alert" data-trash-purge-error hidden></p><div class="form-actions"><button class="button-secondary" type="button" data-action="close-dialog">取消</button><button class="button-primary trash-danger" type="button" data-action="trash-purge-confirm">确认彻底删除 '+list.length+' 项</button></div>';
  }
  function render(items,raw,error='',loaded=true,selected=[]){
    const list=recoverable(items).slice().sort((a,b)=>String(b.deletedAt).localeCompare(String(a.deletedAt))),chosen=new Set(selectedIds(list,selected));
    const toolbar=list.length?'<div class="trash-toolbar"><label class="trash-select-all"><input type="checkbox" data-trash-select-all aria-label="全选回收站内容"'+(chosen.size===list.length?' checked':'')+'>全选</label><span data-trash-selection-count>已选 '+chosen.size+' / '+list.length+' 项</span><div class="trash-toolbar-actions"><button class="button-secondary trash-danger" type="button" data-action="trash-purge-selected"'+(!chosen.size?' disabled':'')+'>删除所选</button><button class="button-secondary trash-danger" type="button" data-action="trash-empty">清空回收站</button></div></div>':'';
    return '<div class="page-intro"><div><h2>回收站</h2><p>可恢复到原位置，也可选择不再需要的内容彻底删除。</p></div><button class="button-secondary" type="button" data-action="trash-refresh">刷新</button></div>'+(error?'<p class="runtime-error" role="alert">'+esc(error)+'</p>':'')+(!loaded?'<p class="context-note">正在读取回收站…</p>':'')+toolbar+'<section class="trash-list" aria-label="已删除内容">'+list.map(item=>{
      const project=(raw.projects||[]).find(p=>p.id===item.projectId),parentDeleted=item.kind!=='project'&&isDeleted(list,'project',item.projectId);
      return '<article class="trash-row"><input type="checkbox" class="trash-select" data-trash-select="'+esc(item.id)+'" aria-label="选择 '+esc(item.title||'未命名内容')+'"'+(chosen.has(item.id)?' checked':'')+'><span class="trash-kind">'+esc(labels[item.kind]||item.kind)+'</span><div class="trash-copy"><h3>'+esc(item.title||'未命名内容')+'</h3><p>'+esc(project?.title||item.projectTitle||'独立工位')+' · '+esc(new Date(item.deletedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))+'</p>'+(parentDeleted?'<small>所属项目也在回收站，恢复项目后可查看此内容。</small>':'')+'</div><div class="trash-row-actions"><button class="button-secondary" type="button" data-action="trash-restore" data-id="'+esc(item.id)+'">恢复</button><button class="button-secondary trash-danger" type="button" data-action="trash-purge" data-id="'+esc(item.id)+'">彻底删除</button></div></article>';
    }).join('')+(loaded&&!list.length?'<div class="empty-state"><h2>回收站是空的</h2><p>不想保留的项目、成果、对话或画布节点，都可以从原页面删除。</p></div>':'')+'</section>';
  }
  const api={labels,esc,isDeleted,visibleState,blockers,deleteButton,recoverable,selectedIds,purgeConfirmation,render};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else global.StudioTrash=api;
})(typeof window!=='undefined'?window:globalThis);
