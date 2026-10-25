/* Interaction controller. No model calls, network calls, or automatic bot replies. */
(() => {
  'use strict';
  const root=document.getElementById('creative-workbench-v2');
  if(!root)return;
  const employees=window.TEAM_EMPLOYEES||[];
  if(!window.StudioStore||!window.StudioViews){root.querySelector('#view-content').textContent='工作台模块未能加载，请检查本地文件是否完整。';return;}
  const store=window.StudioStore.create(employees);
  const V=window.StudioViews.create(employees,store);
  const inline=root.dataset.inline==='true';
  const one=selector=>root.querySelector(selector);
  const all=selector=>[...root.querySelectorAll(selector)];
  const dialog=one('#studio-dialog'),panel=one('#inline-dialog');
  const drafts=new Map();
  let lastRevision=-1,returnFocus=null,returnTarget=null,toastTimer=null;
  const titles={overview:['工作室总览','总策划台'],project:['一起把作品做出来','项目协作'],tasks:['每一步，都有清楚的交接','任务看板'],team:['21 位创作伙伴','团队伙伴'],assets:['同一项目，共用一份成果','共享成果'],connections:['能力与工作记录','工具与连接']};
  const draftKey=s=>s.activePeerId?'peer:'+s.activePeerId:'project:'+s.activeProjectId;
  function icons(){window.lucide?.createIcons({attrs:{width:16,height:16}});}
  function toast(text){const el=one('#toast');el.textContent=text;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;},4200);}
  function saveNotice(){
    const p=store.persistence,notice=one('#save-notice');
    notice.hidden=!p.attempted||p.pending||p.local||p.host&&!p.hostTruncated;
    notice.textContent='本次记录仅保留在当前页面，刷新后可能丢失。请在「工具与连接」中导出备份。';
  }
  function restoreFocus(previous){
    if(!previous)return null;
    let element=previous.id?one('#'+CSS.escape(previous.id)):null;
    if(!element&&previous.action)element=all('[data-action]').find(el=>el.dataset.action===previous.action&&el.dataset.id===previous.entity);
    if(element){element.focus({preventScroll:true});if(typeof element.setSelectionRange==='function'&&previous.start!=null){try{element.setSelectionRange(previous.start,previous.end);}catch{}}}
    return element;
  }
  function captureFocus(){const e=document.activeElement;return root.contains(e)?{id:e.id,action:e.dataset?.action,entity:e.dataset?.id,start:e.selectionStart,end:e.selectionEnd}:null;}
  function render(){
    saveNotice();const s=store.getState();if(s.revision===lastRevision)return;
    const previous=captureFocus();lastRevision=s.revision;
    const sidebar=V.sidebar(s);one('#project-nav').innerHTML=sidebar.projects;one('#partner-nav').innerHTML=sidebar.partners;
    const [eyebrow,title]=titles[s.view]||titles.overview;
    one('#view-eyebrow').textContent=eyebrow;one('#view-title').textContent=s.view==='project'&&s.activePeerId?V.name(s.activePeerId)+'的工位':title;
    const p=V.project(s);one('#context-info').textContent=s.view==='project'&&s.activePeerId?'独立角色会话':p?p.title+(p.isDemo?' · 示例':' · 本地项目'):'影视与游戏，共同创作';
    all('[data-nav]').forEach(b=>{const active=b.dataset.nav===s.view;b.classList.toggle('is-active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    const renderers={overview:()=>V.overview(s),project:()=>V.collaboration(s,drafts.get(draftKey(s))||''),tasks:()=>V.board(s),team:()=>V.team(s),assets:()=>V.artifacts(s),connections:()=>V.connections(s)};
    one('#view-content').innerHTML=(renderers[s.view]||renderers.overview)();
    icons();restoreFocus(previous);
  }
  function dispatch(action,success){const result=store.dispatch(action);if(!result.ok)toast(result.error);else if(success)toast(success);return result;}
  function closeSidebar(){root.classList.remove('sidebar-open');one('[data-action="toggle-sidebar"]')?.setAttribute('aria-expanded','false');}
  function focusAfterDialog(){
    if(returnFocus?.isConnected){returnFocus.focus({preventScroll:true});return;}
    if(!restoreFocus(returnTarget))(one('.nav-item.is-active')||one('[data-action="new-project"]'))?.focus({preventScroll:true});
  }
  function closeDialog(){panel.hidden=true;panel.replaceChildren();if(dialog.open)dialog.close();focusAfterDialog();}
  function showDialog(markup,trigger){
    returnFocus=trigger||document.activeElement;
    returnTarget={id:returnFocus?.id,action:returnFocus?.dataset?.action,entity:returnFocus?.dataset?.id};
    if(inline){panel.innerHTML='<button type="button" class="icon-button modal-close cursor-interaction" data-action="close-dialog" aria-label="关闭">×</button>'+markup;panel.hidden=false;panel.scrollIntoView({block:'start',behavior:'instant'});}
    else{one('#dialog-body').innerHTML=markup;if(!dialog.open)dialog.showModal();}
    const host=inline?panel:one('#dialog-body');const heading=host.querySelector('h2');if(heading){heading.id='studio-modal-title';if(!inline)dialog.setAttribute('aria-labelledby',heading.id);}
    icons();requestAnimationFrame(()=>host.querySelector('input:not([type="hidden"]),textarea,select,button')?.focus({preventScroll:true}));
  }
  function openTask(id,trigger){const s=store.getState(),t=s.tasks.find(t=>t.id===id);if(t)showDialog(V.taskDetails(t,s),trigger);}
  function openSearch(trigger){const s=store.getState();showDialog('<h2>寻找伙伴与项目</h2><label class="field-label">搜索<input class="field" type="search" id="command-query" maxlength="100" placeholder="输入姓名、岗位或项目名称…"></label><div id="command-results">'+V.searchResults('',s)+'</div>',trigger);}
  function formError(form,text){const error=form.querySelector('.form-error');if(error){error.textContent=text;error.hidden=false;}else toast(text);}
  function setProjectKind(form,kind){
    const template=window.STUDIO_TEMPLATES[kind];if(!template||!form)return;
    form.querySelector('#new-project-kind').value=kind;
    form.querySelectorAll('[name="members"]').forEach(box=>{box.checked=template.members.includes(box.value);});
    form.querySelector('#template-hint').textContent=template.description+' 模板只建立待办，不会启动员工。';
  }
  function submitForm(form,action,success){const result=store.dispatch(action);if(!result.ok){formError(form,result.error);return false;}closeDialog();if(success)toast(success);return true;}
  root.addEventListener('click',event=>{
    const control=event.target.closest('button,a');if(!control||!root.contains(control))return;
    if(control.dataset.nav){event.preventDefault();closeDialog();closeSidebar();dispatch({type:'NAVIGATE',view:control.dataset.nav});return;}
    const action=control.dataset.action,id=control.dataset.id,s=store.getState(),p=V.project(s);
    if(!action)return;
    if(action==='close-sidebar'){closeSidebar();return;}
    if(action==='toggle-sidebar'){const open=root.classList.toggle('sidebar-open');control.setAttribute('aria-expanded',String(open));return;}
    if(action==='close-dialog'){closeDialog();return;}
    if(action==='new-project'){closeSidebar();showDialog(V.projectForm(),control);if(window.STUDIO_TEMPLATES[id])setProjectKind((inline?panel:dialog).querySelector('[data-form="new-project"]'),id);return;}
    if(action==='open-search'){closeSidebar();openSearch(control);return;}
    if(action==='select-project'||action==='search-project'){closeDialog();closeSidebar();dispatch({type:'SELECT_PROJECT',id});return;}
    if(action==='open-dm'||action==='search-person'){closeDialog();closeSidebar();dispatch({type:'OPEN_DM',id});return;}
    if(action==='open-employee'){const e=V.person(id);if(e)showDialog(V.employeeDetails(e,s,inline),control);return;}
    if(action==='open-task'){openTask(id,control);return;}
    if(action==='select-task'){dispatch({type:'SELECT_TASK',id});return;}
    if(action==='navigate-tasks'){dispatch({type:'NAVIGATE',view:'tasks'});return;}
    if(action==='new-task'){const target=s.projects.find(p=>p.id===(id||s.activeProjectId));if(target)showDialog(V.taskForm(target,s),control);return;}
    if(action==='new-artifact'){const target=s.projects.find(p=>p.id===(id||s.activeProjectId));if(target)showDialog(V.artifactForm(target,s),control);return;}
    if(action==='open-artifact'){const a=s.artifacts.find(a=>a.id===id);if(a)showDialog(V.artifactDetails(a,s),control);return;}
    if(action==='open-decision'){const d=s.decisions.find(d=>d.id===id);if(d)showDialog(V.decisionForm(d,s),control);return;}
    if(action==='rework-decision'){const form=control.closest('form');if(form)submitForm(form,{type:'REWORK_DECISION',id,reason:new FormData(form).get('reason')},'已记录退回要求，相关下游需重新复核。');return;}
    if(action==='handoff'){dispatch({type:'HANDOFF',taskId:id},'已记录交接意图；尚未发送给员工执行器。');return;}
    if(action==='favorite'){dispatch({type:'TOGGLE_FAVORITE',id});return;}
    if(action==='filter'){dispatch({type:'FILTER',filter:id});return;}
    if(action==='page'){dispatch({type:'PAGE',page:Number(id)});return;}
    if(action==='mention'){const input=one('#message-text');if(input){const prefix=input.value&&!input.value.endsWith(' ')?' ':'';input.value+=prefix+'@'+V.name(id)+' ';drafts.set(draftKey(s),input.value);input.focus();}return;}
    if(action==='export-state'){
      const snapshot=JSON.stringify({exportedAt:new Date().toISOString(),application:'造梦工作室',state:s},null,2);
      if(inline){showDialog('<h2>工作台 JSON 备份</h2><p class="muted">可复制以下完整快照。独立工作台支持下载 JSON 文件。</p><textarea class="textarea" rows="15" readonly aria-label="JSON备份正文">'+V.esc(snapshot)+'</textarea>',control);return;}
      const url=URL.createObjectURL(new Blob([snapshot],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='造梦工作室_备份_'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);toast('已请求下载当前本地数据快照。');return;
    }
  });
  root.addEventListener('submit',event=>{
    const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();const data=new FormData(form),fields=Object.fromEntries(data.entries()),s=store.getState();
    if(form.dataset.form==='new-project'){submitForm(form,{type:'CREATE_PROJECT',...fields,members:data.getAll('members'),useTemplate:data.has('useTemplate')},'已创建本地项目，任务尚未开始执行。');return;}
    if(form.dataset.form==='new-task'){submitForm(form,{type:'CREATE_TASK',...fields,dependencies:data.getAll('dependencies')},'已创建待安排任务。');return;}
    if(form.dataset.form==='update-task'){submitForm(form,{type:'UPDATE_TASK',...fields},'进展已登记在本地。');return;}
    if(form.dataset.form==='decision'){submitForm(form,{type:'DECIDE',...fields},'已记录你的拍板。');return;}
    if(form.dataset.form==='artifact'){submitForm(form,{type:'ADD_ARTIFACT',...fields},'成果正文与版本已保存在本地。');return;}
    if(form.dataset.form==='message'){
      const key=draftKey(s),text=String(data.get('text')||'');drafts.delete(key);
      const result=dispatch({type:'SEND_MESSAGE',text,...(s.activePeerId?{peerId:s.activePeerId}:{projectId:s.activeProjectId})});
      if(!result.ok){drafts.set(key,text);return;}
      toast('便笺已保存在本地；尚未发给员工执行器。');one('#message-text')?.focus({preventScroll:true});return;
    }
  });
  root.addEventListener('input',event=>{
    const input=event.target;
    if(input.id==='search-input'){dispatch({type:'SEARCH',query:input.value});return;}
    if(input.id==='message-text'){drafts.set(draftKey(store.getState()),input.value);return;}
    if(input.id==='command-query'){const target=one('#command-results');if(target)target.innerHTML=V.searchResults(input.value,store.getState());return;}
    if(input.closest('form')){const error=input.closest('form').querySelector('.form-error');if(error)error.hidden=true;}
  });
  root.addEventListener('change',event=>{
    const input=event.target;
    if(input.id==='project-picker'){const view=store.getState().view;dispatch({type:'SELECT_PROJECT',id:input.value});if(['tasks','assets'].includes(view))dispatch({type:'NAVIGATE',view});return;}
    if(input.id==='new-project-kind'){
      setProjectKind(input.closest('form'),input.value);
    }
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  dialog.addEventListener('close',focusAfterDialog);
  root.addEventListener('keydown',event=>{
    if(event.key==='Escape'){closeSidebar();if(inline&&!panel.hidden)closeDialog();}
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearch();}
    if(event.target.id==='message-text'&&(event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();event.target.closest('form').requestSubmit();}
  });
  store.subscribe(render);render();
})();
