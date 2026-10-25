/* Interaction controller. Explicit user requests call the same-origin runtime. */
(() => {
  'use strict';
  const root=document.getElementById('creative-workbench-v2');
  if(!root)return;
  const employees=window.TEAM_EMPLOYEES||[];
  if(!window.StudioStore||!window.StudioViews){root.querySelector('#view-content').textContent='工作台模块未能加载，请检查本地文件是否完整。';return;}
  const store=window.StudioStore.create(employees);
  const inline=root.dataset.inline==='true';
  const runtime=window.StudioRuntime?.create({disabled:inline||!/^https?:$/.test(location.protocol),isVisible:()=>!document.hidden});
  const workspaceSync=window.StudioWorkspaceSync?.create(store,{disabled:inline||!/^https?:$/.test(location.protocol)});
  const production=window.StudioProduction?.create({request:runtime?.request,ready:()=>Boolean(runtime?.ready()),isConnected:()=>runtime?.connection.state==='online',disabled:inline||!/^https?:$/.test(location.protocol)});
  const productionRunSync=window.StudioProduction?.createRunSynchronizer(runtime);
  function readSessionMap(key){try{const value=JSON.parse(sessionStorage.getItem(key)||'[]');return new Map(Array.isArray(value)?value.filter(item=>Array.isArray(item)&&item.length===2&&typeof item[0]==='string').slice(-100):[]);}catch{return new Map();}}
  const productionDrafts=readSessionMap('creative-workbench-production-drafts-v1'),productionRequests=readSessionMap('creative-workbench-production-requests-v1');
  function saveProductionSession(){try{sessionStorage.setItem('creative-workbench-production-drafts-v1',JSON.stringify([...productionDrafts].slice(-100)));sessionStorage.setItem('creative-workbench-production-requests-v1',JSON.stringify([...productionRequests].slice(-100)));}catch{}}
  function productionDraft(key,patch){productionDrafts.set(key,{...(productionDrafts.get(key)||{}),...patch});saveProductionSession();}
  const mediaSelections=new Map(),mediaFormCache=new Map();
  const mediaUI=id=>mediaSelections.get(id)||{kind:'image',outputIndex:0};
  const V=window.StudioViews.create(employees,store,runtime,production,{getDraft:key=>productionDrafts.get(key),getMediaUI:mediaUI});
  const layout=window.StudioLayout?.create(root);
  const one=selector=>root.querySelector(selector);
  const all=selector=>[...root.querySelectorAll(selector)];
  const dialog=one('#studio-dialog'),panel=one('#inline-dialog');
  const drafts=new Map(),composerPrefs=new Map(),pendingRequests=new Map();
  const mediaBusy=new Set();
  let mediaVerificationError='';
  let lastProductionRevision=-1;
  let lastRuntimeRevision=-1,mediaDraftsDirty=false,pendingEstimate=null,lastViewScope="";
  let lastRevision=-1,returnFocus=null,returnTarget=null,toastTimer=null,lastMediaFormScope='';
  const titles={overview:['工作室总览','总策划台'],project:['一起把作品做出来','项目协作'],tasks:['每一步，都有清楚的交接','任务看板'],team:['21 位创作伙伴','团队伙伴'],assets:['同一项目，共用一份成果','共享成果'],connections:['能力与工作记录','工具与连接']};
  const draftKey=s=>s.activePeerId?'peer:'+s.activePeerId:'project:'+s.activeProjectId;
  function icons(){window.lucide?.createIcons({attrs:{width:16,height:16}});}
  function toast(text){const el=one('#toast');el.textContent=text;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;},4200);}
  function saveNotice(){
    const p=store.persistence,notice=one('#save-notice');
    notice.hidden=!p.attempted||p.pending||p.local||p.host&&!p.hostTruncated;
    notice.textContent='本次记录仅保留在当前页面，刷新后可能丢失。请在「工具与连接」中导出备份。';
  }
  function syncNotice(){
    if(!workspaceSync)return;
    const status=workspaceSync.status,notice=one('#workspace-sync-notice'),blocked=workspaceSync.blocked();
    for(const el of [one('#studio-sidebar'),one('.workspace-topbar'),one('#main-content'),dialog])if(el)el.inert=blocked;
    notice.hidden=!['loading','offline','conflict'].includes(status.state);
    notice.replaceChildren();
    const label=document.createElement('span');label.textContent=status.message||'正在读取本机数据库，项目加载完成后即可使用。';notice.append(label);
    const button=(text,action)=>{const b=document.createElement('button');b.type='button';b.className='button-secondary';b.style.margin='6px';b.dataset.action=action;b.textContent=text;notice.append(b);};
    if(status.state==='offline'||status.state==='conflict'){button('重新连接','workspace-retry');button('导出本页副本','export-state');}
    if(status.state==='conflict')button('使用数据库版本','workspace-use-remote');
  }
  function restoreFocus(previous){
    if(!previous)return null;
    let element=previous.id?one('#'+CSS.escape(previous.id)):null;
    if(!element&&previous.action)element=all('[data-action]').find(el=>el.dataset.action===previous.action&&el.dataset.id===previous.entity);
    if(element){element.focus({preventScroll:true});if(typeof element.setSelectionRange==='function'&&previous.start!=null){try{element.setSelectionRange(previous.start,previous.end);}catch{}}}
    return element;
  }
  function captureFocus(){const e=document.activeElement;return root.contains(e)?{id:e.id,action:e.dataset?.action,entity:e.dataset?.id,start:e.selectionStart,end:e.selectionEnd}:null;}
  const runtimeScope=s=>s.activePeerId?{peerId:s.activePeerId}:{projectId:V.project(s)?.id};
  const composerUI=s=>composerPrefs.get(draftKey(s))||{mode:inline?'note':'chat',agentIds:s.activePeerId?[s.activePeerId]:[V.project(s)?.kind==='game'?'G01':'R11']};
  function syncMediaControls(){
    const provider=runtime?.media.providers.find(item=>item.id==='runninghub'),online=runtime?.connection.state==='online';
    const configForm=one('[data-form="runninghub-config"]'),estimateForm=one('[data-form="media-estimate"]');
    const verify=one('[data-action="media-verify"]'),read=estimateForm?.querySelector('[data-action="media-workflow-read"]');
    const verificationError=one('[data-runninghub-verification-error]');if(verificationError){verificationError.textContent=mediaVerificationError;verificationError.hidden=!mediaVerificationError;}
    if(verify){verify.disabled=!online||!provider?.keyConfigured||mediaBusy.has('verify');verify.textContent=mediaBusy.has('verify')?'正在验证…':'测试账户连接';}
    if(read){read.disabled=!online||!provider?.keyConfigured||mediaBusy.has('workflow');read.textContent=mediaBusy.has('workflow')?'正在读取…':'读取工作流参数';}
    const submit=configForm?.querySelector('[type="submit"]');if(submit)submit.disabled=!online||mediaBusy.has('config');
    const estimate=estimateForm?.querySelector('[type="submit"]');if(estimate)estimate.disabled=!online||!provider?.keyConfigured||mediaBusy.has('estimate');
    const currency=estimateForm?.querySelector('[data-media-currency]');if(currency)currency.textContent=provider?.config?.currency||'CNY';
    const current=V.project(store.getState()),projectLabel=estimateForm?.querySelector('[data-media-project]');if(projectLabel)projectLabel.textContent=current&&!current.isDemo?'关联项目：'+current.title:'当前没有选中真实项目，本次任务将独立保存。';
  }
  function render(){
    saveNotice();const s=store.getState();production?.setProject(s.activePeerId?null:V.project(s)?.id);runtime?.watchMedia(s.view==='connections'?null:s.activeProjectId,s.view==='connections'||s.view==='project'&&!s.activePeerId&&s.projectTab==='media');if(!s.activePeerId&&V.project(s))productionRunSync?.sync(V.project(s).id,production?.getProductions(V.project(s).id)||[]);if(s.revision===lastRevision&&lastRuntimeRevision===(runtime?.revision||0)&&lastProductionRevision===(production?.revision||0))return;
    const viewScope=s.view+':'+draftKey(s),detailStates=viewScope===lastViewScope?new Map(all('[data-runtime-detail]').map(el=>[el.dataset.runtimeDetail,el.open])):new Map();lastViewScope=viewScope;
    // Keep live form and player nodes: progress updates must not discard inputs or restart a video.
    for(const form of all('#view-content form[data-form="runninghub-config"],#view-content form[data-form="media-estimate"]'))mediaFormCache.set(lastMediaFormScope+':'+form.dataset.form,form);
    const mediaFormScope=s.view+':'+draftKey(s)+':'+s.projectTab+':'+mediaUI(s.activeProjectId).kind;
    const previews=new Map(all('#view-content [data-media-preview-key]').map(el=>[el.dataset.mediaPreviewKey,el]));
    const mediaScroll=new Map(all('[data-media-scroll]').map(el=>[el.dataset.mediaScroll,{top:el.scrollTop,left:el.scrollLeft}]));
    const previous=captureFocus(),streamPositions=all('.conversation-stream').map(el=>({top:el.scrollTop,atEnd:el.scrollHeight-el.clientHeight-el.scrollTop<48}));lastRevision=s.revision;lastRuntimeRevision=runtime?.revision||0;lastProductionRevision=production?.revision||0;
    const sidebar=V.sidebar(s);one('#project-nav').innerHTML=sidebar.projects;one('#partner-nav').innerHTML=sidebar.partners;
    const [eyebrow,title]=titles[s.view]||titles.overview;
    one('#view-eyebrow').textContent=eyebrow;one('#view-title').textContent=s.view==='project'&&s.activePeerId?V.name(s.activePeerId)+'的工位':title;
    const p=V.project(s);one('#context-info').textContent=s.view==='project'&&s.activePeerId?'独立角色会话':p?p.title+(p.isDemo?' · 示例':' · 本地项目'):'影视与游戏，共同创作';
    all('[data-nav]').forEach(b=>{const active=b.dataset.nav===s.view;b.classList.toggle('is-active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    const renderers={overview:()=>V.overview(s),project:()=>V.collaboration(s,drafts.get(draftKey(s))||'',composerUI(s)),tasks:()=>V.board(s),team:()=>V.team(s),assets:()=>V.artifacts(s),connections:()=>V.connections(s)};
    one('#view-content').innerHTML=(renderers[s.view]||renderers.overview)();
    all('[data-runtime-detail]').forEach(el=>{if(detailStates.has(el.dataset.runtimeDetail))el.open=detailStates.get(el.dataset.runtimeDetail);});
    for(const replacement of all('#view-content form[data-form="runninghub-config"],#view-content form[data-form="media-estimate"]')){const saved=mediaFormCache.get(mediaFormScope+':'+replacement.dataset.form);if(saved)replacement.replaceWith(saved);}
    lastMediaFormScope=mediaFormScope;
    for(const replacement of all('#view-content [data-media-preview-key]')){const saved=previews.get(replacement.dataset.mediaPreviewKey);if(saved)replacement.replaceWith(saved);}
    for(const el of all('[data-media-scroll]')){const position=mediaScroll.get(el.dataset.mediaScroll);if(position){el.scrollTop=position.top;el.scrollLeft=position.left;}}
    syncMediaControls();
    layout?.refresh();
    const connection=runtime?.connection,status=one('.executor-status');
    if(status){status.textContent=connection?.state==='checking'?'正在连接执行器':connection?.ready?'执行器已连接':connection?.state==='online'?'模型未就绪':'便笺模式';status.classList.toggle('success',Boolean(connection?.ready));}
    all('.conversation-stream').forEach((el,i)=>{const previous=streamPositions[i];if(previous)el.scrollTop=previous.atEnd?el.scrollHeight:previous.top;});
    icons();restoreFocus(previous);
    if(runtime&&['overview','project','assets','tasks'].includes(s.view))runtime.loadScope(runtimeScope(s));
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
  function openSearch(trigger){const s=store.getState();showDialog('<h2>寻找项目、成果与伙伴</h2><label class="field-label">搜索<input class="field" type="search" id="command-query" maxlength="100" placeholder="输入项目、成果、姓名或岗位…"></label><div id="command-results">'+V.searchResults('',s)+'</div>',trigger);}
  function formError(form,text){const error=form.querySelector('.form-error');if(error){error.textContent=text;error.hidden=false;}else toast(text);}
  function setProjectKind(form,kind){
    const template=window.STUDIO_TEMPLATES[kind];if(!template||!form)return;
    form.querySelector('#new-project-kind').value=kind;
    form.querySelectorAll('[name="members"]').forEach(box=>{box.checked=template.members.includes(box.value);});
    form.querySelector('#template-hint').textContent=template.description+' 模板只建立待办，不会启动员工。';
  }
  function submitForm(form,action,success){const result=store.dispatch(action);if(!result.ok){formError(form,result.error);return false;}closeDialog();if(success)toast(success);return true;}
  function rerender(){lastRuntimeRevision=-1;render();}
  function requestedAgents(text,s,ui){
    if(s.activePeerId)return [s.activePeerId];
    const p=V.project(s),allowed=new Set([p?.kind==='game'?'G01':'R11',...(p?.members||[])]),hits=[];
    for(const e of employees){const patterns=['@'+e.id,'@'+e.name];for(const value of patterns){const position=text.indexOf(value);if(position>=0&&allowed.has(e.id))hits.push({id:e.id,position});}}
    const found=[...new Set(hits.sort((a,b)=>a.position-b.position).map(hit=>hit.id))];
    return found.length?found:[...(ui.agentIds||[])];
  }
  function payloadFor(s,{prompt,mode='chat',agentIds,task=null,inputArtifacts=[],scope=null}){
    const peerId=scope?scope.peerId:s.activePeerId;
    const p=peerId?null:scope?.projectId?s.projects.find(p=>p.id===scope.projectId):V.project(s);
    if(!peerId&&!p)throw new Error('请先创建或选择一个项目。');
    const target=peerId?{peerId}:{projectId:p.id};
    const runs=runtime.getRuns(target),history=runs.flatMap(run=>[{authorId:'user',content:run.prompt},...(run.messages||[]).map(m=>({authorId:m.authorId,content:m.content}))]).slice(-24);
    const sourceArtifacts=inputArtifacts.length?inputArtifacts:p?s.artifacts.filter(a=>a.projectId===p.id).slice(-8).map(a=>({id:a.id,title:a.title,body:a.body})):[];
    return {requestId:crypto.randomUUID(),mode,project:p?{id:p.id,title:p.title,kind:p.kind,brief:p.brief,members:p.members,isDemo:p.isDemo}:null,peerId:peerId||null,task,tasks:p?s.tasks.filter(t=>t.projectId===p.id):[],decisions:p?s.decisions.filter(d=>d.projectId===p.id):[],agentIds,prompt,history,inputArtifacts:sourceArtifacts};
  }
  async function submitRuntime(form,payload,onSuccess){
    const fingerprint=JSON.stringify({...payload,requestId:null});
    if(pendingRequests.has(fingerprint))payload.requestId=pendingRequests.get(fingerprint);else pendingRequests.set(fingerprint,payload.requestId);
    const submit=form.querySelector('[type="submit"]');if(submit){submit.disabled=true;submit.textContent='正在提交…';}
    try{const run=await runtime.start(payload);pendingRequests.delete(fingerprint);onSuccess?.(run);toast('已提交真实执行，进展与交付会自动更新。');}
    catch(error){formError(form,error.message);if(!form.isConnected)toast(error.message);}
    finally{if(submit?.isConnected){submit.disabled=false;submit.textContent='发送 / 执行 ↑';}}
  }
  function openRuntimeTask(id,review,trigger){
    const s=store.getState(),task=s.tasks.find(t=>t.id===id);if(!task)return;
    const blockers=store.blockers(id);if(blockers.length){toast('请先满足：'+blockers.join('；'));return;}
    if(!runtime?.ready()){toast('请先在工具与连接确认执行器可用。');return;}
    const owner=review?task.reviewerId:task.ownerId;
    const prompt=review?'请针对本任务已有成果提供复核意见，逐项对照验收标准，明确实际检查范围、问题和待验证项。不要把建议标成独立复核通过。':'请完成任务“'+task.title+'”。\n交付预期：'+(task.deliverable||'请按岗位职责给出可用文稿')+'\n验收标准：'+(task.acceptance||'明确假设、来源与待验证事项');
    showDialog('<h2>'+V.esc(review?'请求复核意见':'交给伙伴制作')+'</h2><p>'+V.esc(V.name(owner))+' · '+V.esc(task.title)+'</p><form class="form-stack" data-form="runtime-task"><input type="hidden" name="taskId" value="'+V.esc(id)+'"><input type="hidden" name="review" value="'+(review?'yes':'no')+'"><label class="field-label">本轮要求<textarea class="textarea" name="prompt" rows="7" maxlength="12000" required>'+V.esc(prompt)+'</textarea></label><p class="context-note">生成结果另存为可审阅成果，不自动更改任务完成或复核状态。</p><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button-primary" type="submit">开始真实执行</button><button class="button-secondary" type="button" data-action="close-dialog">取消</button></div></form>',trigger);
  }
  root.addEventListener('click',async event=>{
    const control=event.target.closest('button,a');if(!control||!root.contains(control))return;
    if(control.dataset.nav){event.preventDefault();closeDialog();closeSidebar();dispatch({type:'NAVIGATE',view:control.dataset.nav});return;}
    const action=control.dataset.action,id=control.dataset.id,s=store.getState(),p=V.project(s);
    if(!action)return;
    if(action==='workspace-retry'){await workspaceSync?.retry();return;}
    if(action==='workspace-use-remote'){try{await workspaceSync.useRemote();toast('已恢复数据库版本，原本页副本仍保留在备份中。');}catch(error){toast(error.message);}return;}
    if(action==='workspace-data'){
      showDialog('<h2>工作台数据</h2><p>'+V.esc(workspaceSync?.status.message||'当前使用本地浏览器存储。')+'</p><p class="context-note">项目、任务、便笺和手工成果共用本机数据库。真实执行记录和生成文件由后台单独保留。导出的 JSON 包含当前项目与冲突副本，不含 API Key。</p><div class="form-actions"><button type="button" class="button-primary" data-action="export-state">导出 JSON 备份</button></div><form class="form-stack" data-form="workspace-import"><label class="field-label">恢复 JSON 备份<input class="field" type="file" name="backup" accept="application/json,.json" required></label><p class="context-note">导入会替换当前项目快照；替换前自动保留本页副本。真实运行记录与 API 配置保持独立。</p><p class="form-error" role="alert" hidden></p><button type="submit" class="button-secondary">导入并恢复</button></form>',control);return;
    }
    if(action==='production-refresh'){await production?.refresh(id||p?.id);return;}
    if(action==='production-tools'){dispatch({type:'SET_UI',projectTab:'media'});runtime?.refreshMedia();return;}
    if(action==='media-open-connections'){dispatch({type:'NAVIGATE',view:'connections'});return;}
    if(action==='media-select-job'){mediaSelections.set(p.id,{...mediaUI(p.id),selectedJobId:id,outputIndex:0});rerender();return;}
    if(action==='media-select-output'){mediaSelections.set(p.id,{...mediaUI(p.id),outputIndex:Number(control.dataset.index)||0});rerender();return;}
    if(action==='media-kind'){mediaSelections.set(p.id,{...mediaUI(p.id),kind:id==='video'?'video':'image'});rerender();return;}
    if(action==='media-open-import'){if(p?.isDemo){toast('请在真实项目中登记外部结果。');return;}showDialog(V.mediaImportForm(p),control);return;}
    if(action==='media-preview-open'){const job=runtime.media.jobs.find(job=>job.id===id&&job.projectId===p?.id);if(job)showDialog(V.mediaPreview(job,Number(control.dataset.index)||0),control);return;}
    if(action==='media-copy-source'){
      const form=control.closest('form'),source=V.mediaSources(s).find(item=>item.id===form?.querySelector('[name="mediaSource"]')?.value);
      if(!source){toast('请先选择一份输入文稿。');return;}
      const target=form.querySelector('[data-media-source-text]');if(target){target.value=source.body;target.hidden=false;target.focus();target.select();}
      toast('已展开文稿，请将对应提示词填写到工作流参数中。');return;
    }
    if(action==='production-artifact'){const artifact=production?.findArtifact(id);if(artifact)showDialog(V.productionArtifactDetails(artifact),control);else toast('这份成果暂未载入，请刷新协作记录。');return;}
    if(action==='production-pause'||action==='production-resume'){
      if(workspaceSync?.blocked()){toast('请先完成项目同步，再操作协作流程。');return;}
      const plan=production?.find(id);if(!plan)return;
      try{const expectedRevision=Number(control.dataset.revision);await (action==='production-pause'?production.pause(id,expectedRevision):production.resume(id,expectedRevision));toast(action==='production-pause'?'已提交暂停，已交付文件保留。':'已恢复协作，团队会从当前阶段继续。');}
      catch(error){toast(error.message);}return;
    }
    if(action==='production-review-current'){
      const plan=production?.find(id),stageId=control.dataset.stageId;if(!plan||!stageId)return;
      productionDraft('review:'+id+':'+stageId,{expectedRevision:plan.revision});rerender();return;
    }
    if(action==='runtime-connect'){await runtime?.connect();await runtime?.loadScope(runtimeScope(store.getState()),true);await runtime?.refreshMedia();toast(runtime?.ready()?'执行器已就绪，可以发送工作要求。':runtime?.connection.reason||'执行器尚未就绪。');return;}
    if(action==='media-price'){const provider=runtime?.media.providers.find(p=>p.id===id);if(provider)showDialog(V.providerPriceForm(provider),control);return;}
    if(action==='media-refresh'){await runtime?.refreshMedia();return;}
    if(action==='media-verify'){
      const secret=one('[data-form="runninghub-config"] [name="apiKey"]');
      if(secret?.value.trim()){toast('请先保存填写的密钥，再测试连接。');return;}
      if(mediaBusy.has('verify'))return;
      mediaDraftsDirty=true;mediaBusy.add('verify');mediaVerificationError='';syncMediaControls();
      try{const result=await runtime.verifyRunningHub();if(!result?.verified)throw new Error('账户验证尚未通过，请检查密钥后重试。');toast('RunningHub 账户验证通过；没有创建生成任务。');}
      catch(e){mediaVerificationError=e.message;toast(e.message);}
      finally{mediaBusy.delete('verify');syncMediaControls();}return;
    }
    if(action==='media-workflow-read'){
      const form=control.closest('form'),input=form.querySelector('[name="workflowId"]'),requested=input.value.trim();
      if(!requested){formError(form,'请先粘贴工作流链接或 ID。');return;}
      if(one('[data-form="runninghub-config"] [name="apiKey"]')?.value.trim()){formError(form,'请先保存填写的密钥，再读取工作流。');return;}
      if(mediaBusy.has('workflow'))return;
      mediaDraftsDirty=true;mediaBusy.add('workflow');syncMediaControls();
      try{const workflow=await runtime.readRunningHubWorkflow(requested);if(!workflow?.workflowId||!Array.isArray(workflow.fields))throw new Error('未收到可读取的工作流参数。');if(input.value.trim()!==requested)throw new Error('工作流输入已修改，请重新读取。');form._runninghubWorkflow=workflow;input.value=workflow.workflowId;form.querySelector('[data-workflow-editor]').innerHTML=V.runninghubWorkflowFields(workflow);const error=form.querySelector('.form-error');if(error)error.hidden=true;toast('工作流参数已读取，勾选要修改的字段后应用到 JSON。');}
      catch(error){formError(form,error.message);if(!form.isConnected)toast(error.message);}
      finally{mediaBusy.delete('workflow');syncMediaControls();}return;
    }
    if(action==='media-workflow-apply'){
      const form=control.closest('form'),workflow=form._runninghubWorkflow;
      if(!workflow||form.querySelector('[name="workflowId"]').value.trim()!==workflow.workflowId){formError(form,'工作流已变更，请重新读取参数后再应用。');return;}
      const selections=[...form.querySelectorAll('[data-workflow-index]')].filter(row=>row.querySelector('[data-workflow-select]').checked).map(row=>({index:Number(row.dataset.workflowIndex),value:row.querySelector('[data-workflow-value]').value}));
      if(!selections.length){formError(form,'请先勾选至少一个要修改的字段。');return;}
      try{const target=form.querySelector('[name="nodeInfoList"]'),existing=JSON.parse(target.value||'[]');target.value=JSON.stringify(window.StudioRuntime.mergeWorkflowFields(workflow,selections,existing),null,2);mediaDraftsDirty=true;const error=form.querySelector('.form-error');if(error)error.hidden=true;toast('已将 '+selections.length+' 个字段应用到 JSON，其余输入保留。');}
      catch(error){formError(form,error instanceof SyntaxError?'现有节点 JSON 格式有误，请修正后再应用字段。':error.message);}return;
    }
    if(action==='media-refresh-job'){control.disabled=true;try{await runtime.refreshMediaJob(id);toast('已查询服务商返回的最新状态。');}catch(error){toast(error.message);control.disabled=false;}return;}
    if(action==='runtime-refresh'){await runtime?.loadScope(runtimeScope(s),true);return;}
    if(action==='runtime-cancel'){control.disabled=true;try{await runtime.cancel(id);toast('已请求停止，运行记录保留。');}catch(error){toast(error.message);control.disabled=false;}return;}
    if(action==='runtime-artifact'){const a=runtime?.findArtifact(id);if(a)showDialog(V.runtimeArtifactDetails(a,runtime.findRun(a.runId)),control);return;}
    if(action==='runtime-task'){openRuntimeTask(id,false,control);return;}
    if(action==='runtime-task-review'){openRuntimeTask(id,true,control);return;}
    if(action==='runtime-role'){try{const result=await runtime.roleDetail(id);showDialog('<p class="eyebrow">'+V.esc(result.role?.version||'岗位原文')+'</p><h2>'+V.esc(V.name(id))+' · 能力指令</h2><p class="small muted">'+V.esc(result.role?.source)+'</p><pre class="runtime-full-text">'+V.esc(result.instructions)+'</pre>',control);}catch(error){toast(error.message);}return;}
    if(action==='runtime-revise'){
      const a=runtime?.findArtifact(id),run=a&&runtime.findRun(a.runId);if(!a||!run){toast('这份成果的执行记录暂不可用。');return;}
      showDialog('<h2>继续修改 · '+V.esc(a.title||a.filename)+'</h2><form class="form-stack" data-form="runtime-revise"><input type="hidden" name="artifactId" value="'+V.esc(id)+'"><label class="field-label">修改要求<textarea class="textarea" name="prompt" rows="6" maxlength="12000" placeholder="说明要保留什么、调整哪里、希望达到什么效果…" required></textarea></label><p class="context-note">'+V.esc(V.name(a.authorId))+' 将读取当前成果并产生新版本，保留旧文件。</p><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button-primary" type="submit">生成修改版</button><button type="button" class="button-secondary" data-action="close-dialog">取消</button></div></form>',control);return;
    }
    if(action==='close-sidebar'){closeSidebar();return;}
    if(action==='toggle-sidebar'){const open=root.classList.toggle('sidebar-open');control.setAttribute('aria-expanded',String(open));return;}
    if(action==='close-dialog'){closeDialog();return;}
    if(action==='new-project'){closeSidebar();showDialog(V.projectForm(),control);if(window.STUDIO_TEMPLATES[id])setProjectKind((inline?panel:dialog).querySelector('[data-form="new-project"]'),id);return;}
    if(action==='open-search'){closeSidebar();openSearch(control);return;}
    if(action==='select-project'||action==='search-project'){closeDialog();closeSidebar();dispatch({type:'SELECT_PROJECT',id});runtime?.loadScope({projectId:id},true);return;}
    if(action==='open-dm'||action==='search-person'){closeDialog();closeSidebar();dispatch({type:'OPEN_DM',id});runtime?.loadScope({peerId:id},true);return;}
    if(action==='open-employee'){const e=V.person(id);if(e)showDialog(V.employeeDetails(e,s,inline),control);return;}
    if(action==='open-task'){openTask(id,control);return;}
    if(action==='select-task'){dispatch({type:'SELECT_TASK',id});return;}
    if(action==='team-select'){dispatch({type:'SET_UI',selectedEmployeeId:id});return;}
    if(action==='project-tab'){dispatch({type:'SET_UI',projectTab:id});if(id==='media')runtime?.refreshMedia();return;}
    if(action==='select-shot'){dispatch({type:'SET_UI',selectedShot:id});return;}
    if(action==='task-filter'){dispatch({type:'SET_UI',taskFilter:id});return;}
    if(action==='navigate-artifacts'){dispatch({type:'NAVIGATE',view:'assets'});return;}
    if(action==='navigate-team'){dispatch({type:'NAVIGATE',view:'team'});return;}
    if(action==='navigate-tasks'){dispatch({type:'NAVIGATE',view:'tasks'});return;}
    if(action==='new-task'){const target=s.projects.find(p=>p.id===(id||s.activeProjectId));if(target)showDialog(V.taskForm(target,s),control);return;}
    if(action==='new-artifact'){const target=s.projects.find(p=>p.id===(id||s.activeProjectId));if(target)showDialog(V.artifactForm(target,s),control);return;}
    if(action==='open-artifact'||action==='review-asset'){const a=s.artifacts.find(a=>a.id===id);if(a)showDialog(V.artifactDetails(a,s),control);return;}
    if(action==='open-decision'){const d=s.decisions.find(d=>d.id===id);if(d)showDialog(V.decisionForm(d,s),control);return;}
    if(action==='rework-decision'){const form=control.closest('form');if(form)submitForm(form,{type:'REWORK_DECISION',id,reason:new FormData(form).get('reason')},'已记录退回要求，相关下游需重新复核。');return;}
    if(action==='handoff'){dispatch({type:'HANDOFF',taskId:id},'已记录交接意图；尚未发送给员工执行器。');return;}
    if(action==='favorite'){dispatch({type:'TOGGLE_FAVORITE',id});return;}
    if(action==='filter'){dispatch({type:'FILTER',filter:id});return;}
    if(action==='page'){dispatch({type:'PAGE',page:Number(id)});return;}
    if(action==='mention'){const input=one('#message-text');if(input){const prefix=input.value&&!input.value.endsWith(' ')?' ':'';input.value+=prefix+'@'+V.name(id)+' ';drafts.set(draftKey(s),input.value);input.focus();}return;}
    if(action==='export-state'){
      const snapshot=JSON.stringify(workspaceSync?.exportData()||{exportedAt:new Date().toISOString(),application:'造梦工作室',state:s},null,2);
      if(inline){showDialog('<h2>工作台 JSON 备份</h2><p class="muted">可复制以下完整快照。独立工作台支持下载 JSON 文件。</p><textarea class="textarea" rows="15" readonly aria-label="JSON备份正文">'+V.esc(snapshot)+'</textarea>',control);return;}
      const url=URL.createObjectURL(new Blob([snapshot],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='造梦工作室_备份_'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);toast('已请求下载当前本地数据快照。');return;
    }
  });
  root.addEventListener('submit',async event=>{
    const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();const data=new FormData(form),fields=Object.fromEntries(data.entries()),s=store.getState();
    if(workspaceSync?.blocked()){formError(form,'请先完成项目同步或处理版本冲突。');return;}
    if(form.dataset.form==='workspace-import'){
      try{const file=data.get('backup');if(!file||file.size>5_000_000)throw new Error('请选择不超过 5 MB 的 JSON 工作台备份。');const parsed=JSON.parse(await file.text());await workspaceSync.importState(parsed.state||parsed);closeDialog();toast('已恢复备份；数据库保存状态显示在工作台中。');}catch(error){formError(form,error.message);}return;
    }
    if(event.submitter?.name)fields[event.submitter.name]=event.submitter.value;
    if(form.dataset.form==='production-start'){
      const project=s.projects.find(item=>item.id===form.dataset.projectId);if(!project||!production){formError(form,'当前项目不可用，请重新打开。');return;}
      const prompt=String(fields.prompt||'').trim(),reviewMode=fields.reviewMode==='continuous'?'continuous':'stepwise',key='start:'+project.id;
      if(!prompt){formError(form,'请填写这次作品的目标。');return;}
      productionDraft(key,{prompt,reviewMode});
      const payload={project:{id:project.id,title:project.title,kind:project.kind,brief:project.brief,members:project.members},prompt,reviewMode};
      const fingerprint=JSON.stringify(payload);let requestId=productionRequests.get(fingerprint);
      if(typeof requestId!=='string'){requestId=crypto.randomUUID();productionRequests.set(fingerprint,requestId);saveProductionSession();}
      try{await production.start({...payload,requestId});productionRequests.delete(fingerprint);productionDrafts.delete(key);saveProductionSession();rerender();toast('团队已开始自动协作，真实进展与交付会自动更新。');}
      catch(error){formError(form,error.message);toast(error.message);}return;
    }
    if(form.dataset.form==='production-review'){
      const id=form.dataset.id,stageId=form.dataset.stageId,action=fields.reviewAction,note=String(fields.note||'').trim(),expectedRevision=Number(fields.expectedRevision),key='review:'+id+':'+stageId;
      if(!['approve','revise'].includes(action)){formError(form,'请选择确认继续或交回修改。');return;}
      if(note.length>2000){formError(form,'审阅意见请控制在 2000 字以内。');return;}
      if(action==='revise'&&!note){formError(form,'请写下需要调整的地方，再交给伙伴修改。');return;}
      productionDraft(key,{note,expectedRevision});
      try{await production.review(id,{expectedRevision,stageId,action,note});productionDrafts.delete(key);saveProductionSession();rerender();toast(action==='revise'?'修改意见已交回，旧版本保留。':'已记录你的认可，团队按流程继续交接。');}
      catch(error){formError(form,error.message);toast(error.message);}return;
    }
    if(form.dataset.form==='new-project'){submitForm(form,{type:'CREATE_PROJECT',...fields,members:data.getAll('members'),useTemplate:data.has('useTemplate')},'已创建本地项目，任务尚未开始执行。');return;}
    if(form.dataset.form==='new-task'){submitForm(form,{type:'CREATE_TASK',...fields,dependencies:data.getAll('dependencies')},'已创建待安排任务。');return;}
    if(form.dataset.form==='update-task'){submitForm(form,{type:'UPDATE_TASK',...fields},'进展已登记在本地。');return;}
    if(form.dataset.form==='decision'){submitForm(form,{type:'DECIDE',...fields},'已记录你的拍板。');return;}
    if(form.dataset.form==='artifact-review'){submitForm(form,{type:'REVIEW_ARTIFACT',...fields},'审阅意见已保存在本地，任务复核状态保持独立。');return;}
    if(form.dataset.form==='artifact'){submitForm(form,{type:'ADD_ARTIFACT',...fields},'成果正文与版本已保存在本地。');return;}
    if(form.dataset.form==='media-price'){
      const unitPrice=fields.unitPrice===''?null:Number(fields.unitPrice),platformUrl=String(fields.platformUrl||'').trim();
      if(unitPrice!==null&&(!Number.isFinite(unitPrice)||unitPrice<0)){formError(form,'请填写有效的非负价格，未知可留空。');return;}
      if(platformUrl&&!/^https:\/\//.test(platformUrl)){formError(form,'平台入口必须是已核对的 HTTPS 地址。');return;}
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;
      try{await runtime.saveProvider(fields.providerId,{unitPrice,unit:String(fields.unit||'次'),currency:fields.currency,...(platformUrl?{platformUrl}:{})});closeDialog();toast('已登记人工参考单价；API 状态保持不变。');}
      catch(error){formError(form,error.message);}finally{if(submit.isConnected)submit.disabled=false;}return;
    }
    if(form.dataset.form==='runninghub-config'){
      const config={workflowId:String(fields.workflowId||'').trim(),unitPrice:fields.unitPrice===''?null:Number(fields.unitPrice),unit:'次',currency:fields.currency};
      if(fields.apiKey?.trim())config.apiKey=fields.apiKey.trim();
      if(config.unitPrice!==null&&(!Number.isFinite(config.unitPrice)||config.unitPrice<0)){formError(form,'单价必须是有效的非负数字。');return;}
      const secret=form.querySelector('[name="apiKey"]');
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;
      mediaDraftsDirty=true;mediaBusy.add('config');
      try{await runtime.saveConnection(config);if(secret&&secret.value.trim()===config.apiKey)secret.value='';if(secret)secret.placeholder='已保存 · 留空保留原密钥';mediaVerificationError='';const saved=runtime.media.providers.find(item=>item.id==='runninghub')?.config||{},workflowInput=form.querySelector('[name="workflowId"]'),preparedInput=one('[data-form="media-estimate"] [name="workflowId"]');if(workflowInput?.value.trim()===config.workflowId)workflowInput.value=saved.workflowId||'';if(preparedInput&&!preparedInput.value.trim())preparedInput.value=saved.workflowId||'';toast('连接配置已保存在本机服务端；可以测试账户连接。');}
      catch(error){formError(form,error.message);if(!form.isConnected)toast(error.message);}
      finally{mediaBusy.delete('config');syncMediaControls();config.apiKey=undefined;}return;
    }
    if(form.dataset.form==='media-estimate'){
      let nodeInfoList;try{nodeInfoList=JSON.parse(fields.nodeInfoList||'[]');}catch{formError(form,'节点输入必须是合法 JSON 数组。');return;}
      if(!Array.isArray(nodeInfoList)||nodeInfoList.some(node=>!node||typeof node!=='object'||Array.isArray(node)||!String(node.nodeId||'').trim()||!String(node.fieldName||'').trim()||node.fieldValue===undefined)){formError(form,'每个节点需要 nodeId、fieldName 与 fieldValue。');return;}
      const budget=Number(fields.budget);if(!Number.isFinite(budget)||budget<=0){formError(form,'请填写大于零的本次预算。');return;}
      const config=runtime.media.providers.find(p=>p.id==='runninghub')?.config||{};
      const linkedProject=V.project(s);
      const payload={provider:'runninghub',projectId:linkedProject&&!linkedProject.isDemo?linkedProject.id:null,title:String(fields.title||'').trim(),mediaType:fields.mediaType==='video'?'video':'image',workflowId:String(fields.workflowId||'').trim(),nodeInfoList,quantity:1,unitPrice:config.unitPrice,unit:config.unit||'次',currency:config.currency||'CNY',budget};
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;
      mediaDraftsDirty=true;mediaBusy.add('estimate');
      try{const estimate=await runtime.estimateMedia(payload);pendingEstimate={payload,estimate,requestId:crypto.randomUUID()};showDialog(V.mediaEstimateDetails(payload,estimate),submit);}
      catch(error){formError(form,error.message);if(!form.isConnected)toast(error.message);}finally{mediaBusy.delete('estimate');syncMediaControls();}return;
    }
    if(form.dataset.form==='media-submit'){
      const pending=pendingEstimate;if(!pending||!data.has('confirmCost')){formError(form,'请重新预览费用并勾选本次调用确认。');return;}
      if(!pending.estimate.known||pending.estimate.withinBudget!==true){formError(form,'费用未知或超过预算，不能提交。');return;}
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;submit.textContent='正在提交…';
      try{const job=await runtime.submitMedia({...pending.payload,confirmCost:true,estimateToken:pending.estimate.estimateToken,requestId:pending.requestId});if(!job?.id)throw new Error('提交结果尚未确认，请保留本次请求并查询任务记录。');pendingEstimate=null;closeDialog();if(job.projectId){mediaSelections.set(job.projectId,{...mediaUI(job.projectId),selectedJobId:job.id,outputIndex:0});dispatch({type:'SELECT_PROJECT',id:job.projectId});dispatch({type:'SET_UI',projectTab:'media'});}toast(job.status==='unknown'?'服务商受理状态尚未确认。请先查询该任务，不要重复提交。':job.status==='failed'?'该次请求已失败，请查看媒体任务中的实际错误。':job.status==='succeeded'?'服务商已返回结果，可在影像制作中预览。':'已提交一次 RunningHub 任务，影像制作页将自动查询状态。');}
      catch(error){formError(form,error.message);if(!form.isConnected)toast(error.message);}finally{if(submit.isConnected){submit.disabled=false;submit.textContent='确认费用并提交一次生成';}}return;
    }
    if(form.dataset.form==='media-import'){
      const projectId=form.dataset.projectId;
      if(!s.projects.some(project=>project.id===projectId&&!project.isDemo)){formError(form,'请在真实项目中登记结果。');return;}
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;
      form._requestId ||= crypto.randomUUID();
      try{const job=await runtime.importMedia({requestId:form._requestId,projectId,title:fields.title,mediaType:fields.mediaType,url:fields.url,sourceUrl:fields.sourceUrl,taskId:fields.taskId});if(!job?.id)throw new Error('登记结果尚未确认，请刷新任务后查看。');mediaSelections.set(projectId,{...mediaUI(projectId),selectedJobId:job.id,outputIndex:0});closeDialog();dispatch({type:'SELECT_PROJECT',id:projectId});dispatch({type:'SET_UI',projectTab:'media'});toast('外部结果已登记，可在项目中预览。');}
      catch(error){formError(form,error.message);}finally{submit.disabled=false;}return;
    }
    if(form.dataset.form==='runtime-task'){
      const task=s.tasks.find(t=>t.id===fields.taskId);if(!task){formError(form,'任务已不存在。');return;}
      const reasons=store.blockers(task.id);if(reasons.length){formError(form,'条件未满足：'+reasons.join('；'));return;}
      const review=fields.review==='yes',input=runtime.artifacts({projectId:task.projectId}).filter(a=>a.taskId===task.id).slice(-4);
      if(review&&!input.length&&!s.artifacts.some(a=>a.taskId===task.id)){formError(form,'请先产出或登记这项任务的成果，再请求复核意见。');return;}
      await submitRuntime(form,payloadFor(s,{prompt:fields.prompt,mode:review?'review':'produce',agentIds:[review?task.reviewerId:task.ownerId],task,inputArtifacts:input.map(a=>({id:a.id,title:a.title,body:a.body||a.preview||''})),scope:{projectId:task.projectId}}),()=>{closeDialog();dispatch({type:'SELECT_PROJECT',id:task.projectId});});return;
    }
    if(form.dataset.form==='runtime-revise'){
      const a=runtime.findArtifact(fields.artifactId),run=a&&runtime.findRun(a.runId);if(!a||!run){formError(form,'原成果不可用，请重新打开。');return;}
      const task=run.taskId?s.tasks.find(t=>t.id===run.taskId):null;
      if(task&&store.blockers(task.id).length){formError(form,'关联任务的上游或决策已变更，请先处理门禁条件。');return;}
      await submitRuntime(form,payloadFor(s,{prompt:fields.prompt,mode:'produce',agentIds:[a.authorId],task,inputArtifacts:[{id:a.id,title:a.title,body:a.body||a.preview||''}],scope:run.peerId?{peerId:run.peerId}:{projectId:run.projectId}}),()=>{closeDialog();dispatch(run.peerId?{type:'OPEN_DM',id:run.peerId}:{type:'SELECT_PROJECT',id:run.projectId});});return;
    }
    if(form.dataset.form==='message'){
      const ui=composerUI(s),text=String(data.get('text')||'');
      if(runtime&&(fields.runtimeMode||ui.mode)!=='note'){
        const agentIds=requestedAgents(text,s,ui);if(!agentIds.length||agentIds.length>4){formError(form,'请选择或 @ 1 至 4 位伙伴。');return;}
        const mode=agentIds.length>1?'team':fields.runtimeMode==='team'?'produce':fields.runtimeMode||'chat';
        try{await submitRuntime(form,payloadFor(s,{prompt:text,mode,agentIds}),()=>{drafts.delete(draftKey(s));rerender();one('#message-text')?.focus({preventScroll:true});});}catch(error){formError(form,error.message);}return;
      }

      const key=draftKey(s);drafts.delete(key);
      const result=dispatch({type:'SEND_MESSAGE',text,...(s.activePeerId?{peerId:s.activePeerId}:{projectId:s.activeProjectId})});
      if(!result.ok){drafts.set(key,text);return;}
      toast('便笺已保存在本地；尚未发给员工执行器。');one('#message-text')?.focus({preventScroll:true});return;
    }
  });
  root.addEventListener('input',event=>{
    const input=event.target;
    if(input.closest('[data-form="runninghub-config"],[data-form="media-estimate"]'))mediaDraftsDirty=true;
    const productionForm=input.closest('[data-form="production-start"],[data-form="production-review"]');
    if(productionForm&&input.name){const patch={[input.name]:input.value};if(productionForm.dataset.form==='production-review')patch.expectedRevision=Number(productionForm.querySelector('[name="expectedRevision"]').value);productionDraft(productionForm.dataset.draftKey,patch);}

    if(input.id==='search-input'){dispatch({type:'SEARCH',query:input.value});return;}
    if(input.id==='message-text'){drafts.set(draftKey(store.getState()),input.value);return;}
    if(input.id==='command-query'){const target=one('#command-results');if(target)target.innerHTML=V.searchResults(input.value,store.getState());return;}
    if(input.closest('form')){const error=input.closest('form').querySelector('.form-error');if(error)error.hidden=true;}
  });
  root.addEventListener('error',event=>{
    const target=event.target;if(!target.matches?.('img[data-media-preview-key],video[data-media-preview-key]'))return;
    const host=target.closest('[data-media-preview]');if(host){const fallback=host.querySelector('[data-media-fallback]');if(fallback)fallback.hidden=false;}
  },true);
  root.addEventListener('change',event=>{
    const input=event.target;
    if(input.name==='reviewMode'&&input.closest('[data-form="production-start"]')){productionDraft(input.closest('form').dataset.draftKey,{reviewMode:input.value});return;}
    if(input.id==='runtime-mode'){
      const s=store.getState(),ui=composerUI(s);composerPrefs.set(draftKey(s),{...ui,mode:input.value});rerender();return;
    }
    if(input.name==='runtimeAgents'){
      const s=store.getState(),ui=composerUI(s),ids=[...(ui.agentIds||[])];
      if(input.checked){if(ids.length>=4){input.checked=false;toast('每轮最多 4 位伙伴；可完成后继续交接。');return;}ids.push(input.value);}else{const index=ids.indexOf(input.value);if(index>=0)ids.splice(index,1);}
      composerPrefs.set(draftKey(s),{...ui,agentIds:ids});rerender();return;
    }
    if(input.id==='project-picker'){const view=store.getState().view;dispatch({type:'SELECT_PROJECT',id:input.value});if(['tasks','assets'].includes(view))dispatch({type:'NAVIGATE',view});return;}
    if(input.id==='new-project-kind'){
      setProjectKind(input.closest('form'),input.value);
    }
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  dialog.addEventListener('close',focusAfterDialog);
  root.addEventListener('keydown',event=>{
    if(workspaceSync?.blocked())return;
    if(event.key==='Escape'){closeSidebar();if(inline&&!panel.hidden)closeDialog();}
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearch();}
    if(event.target.id==='message-text'&&(event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();event.target.closest('form').requestSubmit();}
  });
  store.subscribe(render);runtime?.subscribe(render);production?.subscribe(render);workspaceSync?.subscribe(syncNotice);render();syncNotice();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){const s=store.getState();if(s.view==='connections'||s.view==='project'&&s.projectTab==='media')runtime?.refreshMedia();}});
  Promise.resolve(workspaceSync?.start()).then(()=>runtime?.connect()).then(async()=>{await runtime?.loadScope(runtimeScope(store.getState()),true);await runtime?.refreshMedia();await production?.refresh(V.project(store.getState())?.id);});
  window.addEventListener('beforeunload',event=>{if(workspaceSync?.status.state==='saving'){event.preventDefault();event.returnValue='项目仍在保存，请稍候。';}});
})();
