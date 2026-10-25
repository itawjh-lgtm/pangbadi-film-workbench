/* Interaction controller. Explicit user requests call the same-origin runtime. */
(() => {
  'use strict';
  const root=document.getElementById('creative-workbench-v2');
  if(!root)return;
  const employees=window.TEAM_EMPLOYEES||[];
  if(!window.StudioStore||!window.StudioViews){root.querySelector('#view-content').textContent='工作台模块未能加载，请检查本地文件是否完整。';return;}
  const store=window.StudioStore.create(employees,{isDeleted:(...args)=>runtime?.isDeleted(...args)});
  const inline=root.dataset.inline==='true';
  const runtime=window.StudioRuntime?.create({disabled:inline||!/^https?:$/.test(location.protocol)});
  const visibleState=()=>runtime?.visibleState(store.getState())||store.getState();
  const viewStore={...store,getState:visibleState,blockers:id=>window.StudioTrash?.blockers(store.getState(),runtime?.trash.items||[],id,store.blockers(id))||store.blockers(id)};
  const workspaceSync=window.StudioWorkspaceSync?.create(store,{disabled:inline||!/^https?:$/.test(location.protocol)});
  const production=window.StudioProduction?.create({request:runtime?.request,isDeleted:runtime?.isDeleted,ready:()=>Boolean(runtime?.ready()),isConnected:()=>runtime?.connection.state==='online',disabled:inline||!/^https?:$/.test(location.protocol)});
  const productionRunSync=window.StudioProduction?.createRunSynchronizer(runtime);
  function readSessionMap(key){try{const value=JSON.parse(sessionStorage.getItem(key)||'[]');return new Map(Array.isArray(value)?value.filter(item=>Array.isArray(item)&&item.length===2&&typeof item[0]==='string').slice(-100):[]);}catch{return new Map();}}
  const productionDrafts=readSessionMap('creative-workbench-production-drafts-v1'),productionRequests=readSessionMap('creative-workbench-production-requests-v1');
  const canvasHandoffHandled=readSessionMap('creative-workbench-canvas-handoffs-v1'),canvasHandoffPending=new Map();
  const canvasHandoffTracker=window.StudioProduction?.createCanvasHandoffTracker({handled:canvasHandoffHandled,onHandled:items=>{try{sessionStorage.setItem('creative-workbench-canvas-handoffs-v1',JSON.stringify([...items]));}catch{}}});
  function saveProductionSession(){try{sessionStorage.setItem('creative-workbench-production-drafts-v1',JSON.stringify([...productionDrafts].slice(-100)));sessionStorage.setItem('creative-workbench-production-requests-v1',JSON.stringify([...productionRequests].slice(-100)));}catch{}}
  function productionDraft(key,patch){productionDrafts.set(key,{...(productionDrafts.get(key)||{}),...patch});saveProductionSession();}
  const V=window.StudioViews.create(employees,viewStore,runtime,production,{getDraft:key=>productionDrafts.get(key)});
  const canvas=window.StudioCanvas?.create({runtime,views:V,onOptimize:optimizeCanvasPrompt,onOpenTrash:()=>dispatch({type:'NAVIGATE',view:'trash'}),conversationHTML:project=>{const state={...visibleState(),activeProjectId:project.id,activePeerId:null};return V.projectConversation(state,drafts.get('project:'+project.id)||'',composerUI(state));}});
  const layout=window.StudioLayout?.create(root);
  let projectDiscussionCollapsed=layout?.isDiscussionCollapsed?.()===true;
  const one=selector=>root.querySelector(selector);
  const all=selector=>[...root.querySelectorAll(selector)];
  const dialog=one('#studio-dialog'),panel=one('#inline-dialog');
  const drafts=new Map(),composerPrefs=new Map(),pendingRequests=new Map();
  const mediaBusy=new Set(),mediaComposers=new Map();
  const trashSelection=new Set();
  let pendingTrashPurge=null,trashPurgeBusy=false;
  let mediaVerificationError='',modelVerificationError='';
  let lastProductionRevision=-1;
  let lastMediaSurface='',mediaSurfacePending=null;
  let canvasNavigationEpoch=0,canvasNavigationScope='',canvasEditingEpoch=0;
  let lastRuntimeRevision=-1,mediaDraftsDirty=false,pendingEstimate=null,lastViewScope="";
  let lastRevision=-1,returnFocus=null,returnTarget=null,toastTimer=null;
  const titles={overview:['工作室总览','总策划台'],project:['一起把作品做出来','项目协作'],tasks:['每一步，都有清楚的交接','任务看板'],team:['21 位创作伙伴','团队伙伴'],assets:['同一项目，共用一份成果','共享成果'],connections:['能力与工作记录','工具与连接'],trash:['删除后，还能找回来','回收站']};
  const draftKey=s=>s.activePeerId?'peer:'+s.activePeerId:'project:'+s.activeProjectId;
  function icons(){window.lucide?.createIcons({attrs:{width:16,height:16}});}
  function toast(text,undoId=null){const el=one('#toast');el.textContent=text;if(undoId){const undo=document.createElement('button');undo.type='button';undo.dataset.action='trash-restore';undo.dataset.id=undoId;undo.className='toast-undo';undo.textContent='撤销';el.append(undo);}el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;},4200);}
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
  const runtimeScope=s=>s.view==='project'&&s.activePeerId?{peerId:s.activePeerId}:{projectId:(s.view==='overview'&&V.homeProject?V.homeProject(s):V.project(s))?.id};
  const composerUI=s=>composerPrefs.get(draftKey(s))||{mode:inline?'note':'chat',agentIds:s.activePeerId?[s.activePeerId]:[V.project(s)?.kind==='game'?'G01':'R11']};
  function mediaModelValues(form){return Object.fromEntries([...form.querySelectorAll('[data-model-param]')].map(input=>[input.dataset.modelParam,input.type==='checkbox'?input.checked:input.value]));}
  function syncModelSelection(form,force=false){
    if(!form)return;
    const provider=runtime?.media.providers.find(item=>item.id==='runninghub'),models=provider?.models||[],kind=form.querySelector('[name="mediaKind"]')?.value||'image',select=form.querySelector('[name="modelId"]'),host=form.querySelector('[data-model-parameters]');
    if(!select||!host)return;
    const prior=form._selectedModel,values=mediaModelValues(form);form._modelDrafts ||= new Map();form._modelChoices ||= {};
    if(prior)form._modelDrafts.set(prior,values);
    const catalog=models.filter(model=>model.mediaKind===kind),signature=JSON.stringify(catalog.map(model=>[model.id,model.contractHash,model.available,model.disabled]));
    const query=form.querySelector('[name="modelQuery"]'),vendor=form.querySelector('[name="modelVendor"]'),category=form.querySelector('[name="modelCategory"]');
    if(form._modelKind!==kind||form._modelCatalog!==signature){
      for(const [control,key,label] of [[vendor,model=>model.vendor||model.family||'RunningHub','全部厂商 / 系列'],[category,model=>model.category||model.capability||'其他','全部用途']])if(control){const saved=control.value,choices=[...new Set(catalog.map(key))].sort((a,b)=>a.localeCompare(b,'zh-CN'));control.innerHTML='<option value="">'+label+'</option>'+choices.map(value=>'<option value="'+V.esc(value)+'">'+V.esc(control===category?V.mediaCategoryLabel(value):value)+'</option>').join('');if(choices.includes(saved))control.value=saved;}
      force=true;
    }
    const filters={kind,query:query?.value||'',vendor:vendor?.value||'',category:category?.value||''},available=window.StudioRuntime.filterMediaModels(catalog,filters),filterKey=JSON.stringify(filters);
    if(force||form._modelFilters!==filterKey){
      const wanted=form._modelKind!==kind?form._modelChoices[kind]||select.value:select.value;
      const selected=available.find(model=>(model.id||model.modelId)===wanted&&window.StudioRuntime.modelAvailable(model))||available.find(window.StudioRuntime.modelAvailable);
      select.innerHTML=V.mediaModelOptions(available,selected?.id||selected?.modelId||'');select.value=selected?.id||selected?.modelId||'';
    }
    const selected=available.find(model=>(model.id||model.modelId)===select.value);
    if(force||prior!==select.value){let saved=form._modelDrafts.get(select.value);if(!saved)saved={prompt:typeof values.prompt==='string'?values.prompt:form._mediaContext?.initialPrompt||''};host.innerHTML=V.mediaModelFields(selected,saved||{});}
    const count=form.querySelector('[data-model-count]');if(count)count.textContent=available.filter(window.StudioRuntime.modelAvailable).length+' 个可选接口 · '+available.length+' 个匹配 / '+catalog.length+' 个目录记录';
    const detail=form.querySelector('[data-model-description]');if(detail){const source=selected?.sourceUrl||selected?.docUrl,official=typeof source==='string'&&/^https:\/\/www\.runninghub\.cn\//.test(source);detail.innerHTML=selected?'<div class="media-selected-model"><strong>'+V.esc(selected.label||selected.name||selected.id)+'</strong><span class="small muted">'+V.esc(selected.id||selected.modelId)+'</span>'+(official?'<a class="small" href="'+V.esc(source)+'" target="_blank" rel="noopener noreferrer">官方参数说明 ↗</a>':'')+'</div>':'<p class="context-note">没有可提交的匹配模型；下架记录已禁用，请调整筛选条件。</p>';}
    form._selectedModel=select.value;form._modelKind=kind;if(select.value)form._modelChoices[kind]=select.value;form._modelCatalog=signature;form._modelFilters=filterKey;
  }
  function syncMediaControls(){
    const provider=runtime?.media.providers.find(item=>item.id==='runninghub'),online=runtime?.connection.state==='online',modelConnection=provider?.modelConnection||{};
    const configForm=one('[data-form="runninghub-config"]'),modelForm=one('[data-form="runninghub-model-config"]'),estimateForm=one('[data-form="media-estimate"]');
    const verify=one('[data-action="media-verify"]'),modelVerify=one('[data-action="media-model-verify"]'),read=one('[data-action="media-workflow-read"]');
    const verificationError=one('[data-runninghub-verification-error]');if(verificationError){verificationError.textContent=mediaVerificationError;verificationError.hidden=!mediaVerificationError;}
    const modelError=one('[data-model-verification-error]');if(modelError){modelError.textContent=modelVerificationError;modelError.hidden=!modelVerificationError;}
    const workflowStatus=one('[data-workflow-verification-status]');if(workflowStatus)workflowStatus.textContent=provider?.verified?'账户已验证':provider?.keyConfigured?'个人密钥已保存 · 待验证':'工作流账户待配置';
    const workflowMeta=one('[data-workflow-verification-meta]');if(workflowMeta){const checkedAt=provider?.verification?.checkedAt;workflowMeta.textContent=(provider?.verified&&checkedAt?'验证时间：'+new Date(checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'。':'')+'只检查账户权限，不创建生成任务；工作流能否运行需单独验证。';}
    const modelStatus=one('[data-model-verification-status]');if(modelStatus)modelStatus.textContent=modelConnection.verified?'模型连接已验证':modelConnection.keyConfigured?'密钥已保存，可测试连接':'尚未配置模型密钥';
    if(verify){verify.disabled=!online||!provider?.keyConfigured||mediaBusy.has('verify');verify.textContent=mediaBusy.has('verify')?'正在验证…':'测试账户连接';}
    if(modelVerify){modelVerify.disabled=!online||!modelConnection.keyConfigured||mediaBusy.has('model-verify');modelVerify.textContent=mediaBusy.has('model-verify')?'正在验证…':'测试模型连接';}
    if(read){read.disabled=!online||!provider?.keyConfigured||mediaBusy.has('workflow');read.textContent=mediaBusy.has('workflow')?'正在读取…':'读取工作流参数';}
    const submit=configForm?.querySelector('[type="submit"]');if(submit)submit.disabled=!online||mediaBusy.has('config');
    const modelSave=modelForm?.querySelector('[type="submit"]');if(modelSave)modelSave.disabled=!online||mediaBusy.has('model-config');
    syncModelSelection(estimateForm);
    const direct=estimateForm?.querySelector('[name="mode"]')?.value!=='workflow_api';
    const modelFields=estimateForm?.querySelector('[data-model-fields]'),workflowFields=estimateForm?.querySelector('[data-workflow-fields]');
    if(modelFields){modelFields.hidden=!direct;modelFields.disabled=!direct;}if(workflowFields){workflowFields.hidden=direct;workflowFields.disabled=direct;}
    const estimate=estimateForm?.querySelector('[type="submit"]');if(estimate){estimate.disabled=!online||!(direct?modelConnection.keyConfigured:provider?.keyConfigured)||direct&&!estimateForm.querySelector('[name="modelId"]').value||mediaBusy.has('estimate');estimate.textContent=mediaBusy.has('estimate')?'正在查询…':direct?'查询报价与预览参数':'预览工作流估价与参数';}
    const currency=estimateForm?.querySelector('[data-media-currency]');if(currency)currency.textContent=direct?'按官方报价币种核算':provider?.config?.currency||'CNY';
    const pricingNote=estimateForm?.querySelector('[data-media-pricing-note]');if(pricingNote)pricingNote.textContent=direct?(modelConnection.keyConfigured?'查询官方报价不创建生成任务；确认页会显示金额与币种，请核对后提交。':'模型接口需要个人账户下的「企业级-共享」API Key；这是密钥类型，无需企业账户。在工具与连接中保存后即可查询报价。'):'工作流使用人工参考单价，先计算估价，再由你确认提交。';
    const context=estimateForm?._mediaContext,current=visibleState().projects.find(p=>p.id===context?.projectId),projectLabel=estimateForm?.querySelector('[data-media-project]');if(projectLabel)projectLabel.textContent='关联项目：'+(current?.title||'项目已不可用')+(context?.shotId?' · 镜头 '+context.shotId:' · 项目素材');
  }
  function trackCanvasNavigation(state){
    const scope=JSON.stringify([state.view,state.activeProjectId,state.activePeerId,state.projectTab]);
    if(scope!==canvasNavigationScope){canvasNavigationScope=scope;canvasNavigationEpoch++;}
  }
  function trackCanvasEditing(input){if(input?.matches?.('input,textarea,select,[contenteditable="true"]'))canvasEditingEpoch++;}
  function mediaSurface(state){return state.view==='overview'?'overview':state.activePeerId?'':state.view==='assets'?'assets:'+state.activeProjectId:state.view==='project'&&['assets','tasks','overview'].includes(state.projectTab)?state.projectTab+':'+state.activeProjectId:'';}
  async function refreshVisibleMedia(){
    if(document.hidden||!mediaSurface(visibleState())||runtime?.connection?.state!=='online')return;
    if(mediaSurfacePending)return mediaSurfacePending;
    const pending=runtime.refreshMedia();mediaSurfacePending=pending;
    try{await pending;}finally{mediaSurfacePending=null;}
  }
  function canvasHandoffAllowed(plan,automatic=false){
    const state=visibleState(),latest=production?.getProductions(plan.projectId)?.at(-1);
    if(state.view!=='project'||state.activePeerId||state.activeProjectId!==plan.projectId||state.projectTab!=='production'||workspaceSync?.blocked()||latest?.id!==plan.id||window.StudioProduction.canvasApprovalKey(latest)!==window.StudioProduction.canvasApprovalKey(plan))return false;
    if(!automatic)return true;
    return !dialog.open&&panel.hidden&&!document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')&&!production?.isBusy(plan.id)&&!String(drafts.get('project:'+plan.projectId)||'').trim()&&![...productionDrafts].some(([key,value])=>key.startsWith('review:'+plan.id+':')&&String(value.note||'').trim());
  }
  async function openProductionCanvas(plan,{automatic=false}={}){
    if(!plan||!window.StudioProduction.canvasApprovalKey(plan)||!canvasHandoffAllowed(plan,automatic))return;
    if(canvasHandoffPending.has(plan.id))return canvasHandoffPending.get(plan.id);
    const navigationEpoch=canvasNavigationEpoch,editingEpoch=canvasEditingEpoch;
    canvasHandoffTracker?.claim(plan);toast('正在整理已确认文稿中的人物资产与分镜…');
    const pending=(async()=>{
      const response=await runtime.request('/api/projects/'+encodeURIComponent(plan.projectId)+'/canvas/sync',{}),doc=response.canvas||response;
      if(doc.projectId!==plan.projectId||!Array.isArray(doc.nodes)||!doc.nodes.length)throw new Error('文稿已确认，但还没有可用的画面节点。请查看逐镜稿，或点击「进入人物资产」重试。');
      if(navigationEpoch!==canvasNavigationEpoch||editingEpoch!==canvasEditingEpoch||dialog.open||!panel.hidden||!canvasHandoffAllowed(plan,automatic))return;
      dispatch({type:'SET_UI',projectTab:'characters'});
      const count=new Set(doc.nodes.filter(node=>!node.stale&&node.shotId).map(node=>node.shotId)).size;
      toast('已进入人物资产'+(count?'，'+count+' 个镜头的提示词已准备好':'')+'。先完成人物定妆，再核对分镜，随后进入创作画布。');
    })();canvasHandoffPending.set(plan.id,pending);
    try{return await pending;}finally{canvasHandoffPending.delete(plan.id);}
  }
  function visualApprovalKey(plan){
    const stage=plan?.stages?.find(item=>item.id==='visual'&&item.agentId==='R05'),review=stage?.review;
    if(plan?.reviewMode!=='stepwise'||stage?.status!=='completed'||review?.action!=='approve'||review.reviewer!=='user'||!review.at||!Array.isArray(review.artifactIds)||!review.artifactIds.length)return '';
    const ids=stage.outputArtifactIds||stage.artifacts?.map(item=>item.id)||[];
    if(!ids.length||ids.length!==review.artifactIds.length||ids.some(id=>!review.artifactIds.includes(id)))return '';
    return JSON.stringify([plan.id,review.at,review.artifactIds]);
  }
  async function openVisualAssets(plan,position={navigationEpoch:canvasNavigationEpoch,editingEpoch:canvasEditingEpoch}){
    const key=visualApprovalKey(plan);if(!key)return;
    const canEnter=()=>{const state=visibleState(),latest=production?.getProductions(plan.projectId)?.at(-1);return position.navigationEpoch===canvasNavigationEpoch&&position.editingEpoch===canvasEditingEpoch&&state.view==='project'&&!state.activePeerId&&state.activeProjectId===plan.projectId&&state.projectTab==='production'&&!dialog.open&&panel.hidden&&!workspaceSync?.blocked()&&latest?.id===plan.id&&visualApprovalKey(latest)===key;};
    if(!canEnter())return;
    const response=await runtime.request('/api/projects/'+encodeURIComponent(plan.projectId)+'/canvas'),doc=response.canvas||response;
    if(doc.projectId!==plan.projectId||!Array.isArray(doc.characterAssets))throw new Error('人物资产暂时未能读取，可点击「人物资产」重试。');
    if(!canEnter())return;
    dispatch({type:'SET_UI',projectTab:'characters'});toast('美术设定已确认，已进入人物资产。镜头文稿继续在后台协作，可先准备人物定妆。');
  }
  async function saveProjectSurface(){
    const state=visibleState();if(state.view==='project'&&!state.activePeerId&&['canvas','characters'].includes(state.projectTab))await canvas?.save?.();
  }
  async function switchProjectTab(tab){
    const intent=(switchProjectTab.intent||0)+1;switchProjectTab.intent=intent;
    const navigationEpoch=canvasNavigationEpoch;
    await saveProjectSurface();
    if(intent!==switchProjectTab.intent||navigationEpoch!==canvasNavigationEpoch)return;
    dispatch({type:'SET_UI',projectTab:tab});
  }
  async function openProjectCanvas(project,context=null,nextTab='canvas'){
    if(!project||project.isDemo)return;
    const destination=nextTab==='storyboard'?'storyboard':'canvas',destinationLabel=destination==='storyboard'?'分镜':'创作画布';
    const navigationEpoch=canvasNavigationEpoch,editingEpoch=canvasEditingEpoch;
    await saveProjectSurface();
    if(navigationEpoch!==canvasNavigationEpoch||editingEpoch!==canvasEditingEpoch)return;
    const response=await runtime.request('/api/projects/'+encodeURIComponent(project.id)+'/canvas'),doc=response.canvas||response;
    if(doc.projectId!==project.id||!Array.isArray(doc.nodes)||!Array.isArray(doc.characterAssets))throw new Error('人物资产状态暂时无法读取，请刷新后再进入'+destinationLabel+'。');
    const state=visibleState();
    if(navigationEpoch!==canvasNavigationEpoch||editingEpoch!==canvasEditingEpoch||state.view!=='project'||state.activePeerId||state.activeProjectId!==project.id||dialog.open||!panel.hidden)return;
    const assets=doc.characterAssets.filter(asset=>asset.manual||!asset.sourceVersion||asset.sourceVersion===doc.assetSourceVersion),pending=assets.filter(asset=>asset.status!=='ready');
    if(pending.length){dispatch({type:'SET_UI',projectTab:'characters'});toast('还有 '+pending.length+' 位人物待完成定妆。确认人物资产后，先核对分镜，再进入画布制作；已有结果仍可从「创作画布」查看。');return;}
    if(context)canvas?.focus(context);
    dispatch({type:'SET_UI',projectTab:destination});
  }
  async function focusMediaJob(job){
    const navigationEpoch=canvasNavigationEpoch,editingEpoch=canvasEditingEpoch;
    await saveProjectSurface();
    if(navigationEpoch!==canvasNavigationEpoch||editingEpoch!==canvasEditingEpoch)return;
    const response=await runtime.request('/api/projects/'+encodeURIComponent(job.projectId)+'/canvas'),doc=response.canvas||response;
    if(doc.projectId!==job.projectId||!Array.isArray(doc.nodes))throw new Error('对应项目的制作记录暂时无法读取。');
    if(navigationEpoch!==canvasNavigationEpoch||editingEpoch!==canvasEditingEpoch||dialog.open||!panel.hidden)return;
    const target=doc.nodes.find(item=>item.id===job.canvasNodeId||(item.jobIds||[]).includes(job.id))||doc.nodes.find(item=>job.shotId&&item.shotId===job.shotId&&item.sourceArtifactId===job.sourceArtifactId&&(item.promptArtifactId||null)===(job.promptArtifactId||null)&&item.mediaKind===job.mediaKind);
    if(!target){toast('这份素材没有对应的可用画布节点，可在素材页查看原结果。');return;}
    const context={projectId:job.projectId,nodeId:target.id,shotId:target.shotId||'',sourceArtifactId:target.sourceArtifactId||null,promptArtifactId:target.promptArtifactId||null,mediaKind:target.mediaKind,create:false};
    const state=visibleState();if(state.view!=='project'||state.activePeerId||state.activeProjectId!==job.projectId)dispatch({type:'SELECT_PROJECT',id:job.projectId});
    if(target.nodeKind==='character'){canvas?.focusAssets?.(context);dispatch({type:'SET_UI',projectTab:'characters'});}
    else{canvas?.focus(context);dispatch({type:'SET_UI',projectTab:'canvas'});}
  }
  function render(){
    saveNotice();const s=visibleState();trackCanvasNavigation(s);production?.setProject(s.activePeerId?null:V.project(s)?.id);if(!s.activePeerId&&V.project(s)){const plans=production?.getProductions(V.project(s).id)||[];productionRunSync?.sync(V.project(s).id,plans);const latest=plans.at(-1),handoff=canvasHandoffTracker?.observe(plans,Boolean(latest&&canvasHandoffAllowed(latest,true)));if(handoff)Promise.resolve().then(()=>openProductionCanvas(handoff,{automatic:true})).catch(error=>toast(error.message));}if(s.revision===lastRevision&&lastRuntimeRevision===(runtime?.revision||0)&&lastProductionRevision===(production?.revision||0))return;
    const mediaTarget=mediaSurface(s);if(mediaTarget!==lastMediaSurface){lastMediaSurface=mediaTarget;if(mediaTarget)Promise.resolve().then(refreshVisibleMedia).catch(()=>{});}
    const viewScope=s.view+':'+draftKey(s),detailStates=viewScope===lastViewScope?new Map(all('[data-runtime-detail]').map(el=>[el.dataset.runtimeDetail,el.open])):new Map();lastViewScope=viewScope;
    const mediaForms=s.view==='connections'&&mediaDraftsDirty?all('form[data-form="runninghub-config"],form[data-form="runninghub-model-config"],form[data-form="media-diagnostic"]'):[];
    const mediaPreviews=new Map(all('#view-content [data-media-preview-key]').map(el=>[el.dataset.mediaPreviewKey,el]));
    const previous=captureFocus(),streamPositions=all('.conversation-stream').map(el=>({top:el.scrollTop,atEnd:el.scrollHeight-el.clientHeight-el.scrollTop<48}));lastRevision=s.revision;lastRuntimeRevision=runtime?.revision||0;lastProductionRevision=production?.revision||0;
    const sidebar=V.sidebar(s);one('#project-nav').innerHTML=sidebar.projects;one('#partner-nav').innerHTML=sidebar.partners;
    const [eyebrow,title]=titles[s.view]||titles.overview;
    one('#view-eyebrow').textContent=eyebrow;one('#view-title').textContent=s.view==='project'&&s.activePeerId?V.name(s.activePeerId)+'的工位':title;
    const p=V.project(s);one('#context-info').textContent=s.view==='project'&&s.activePeerId?'独立角色会话':p?p.title+(p.isDemo?' · 示例':' · 本地项目'):'影视与游戏，共同创作';
    all('[data-nav]').forEach(b=>{const active=b.dataset.nav===s.view;b.classList.toggle('is-active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    const renderers={overview:()=>V.overview(s),project:()=>V.collaboration(s,drafts.get(draftKey(s))||'',{...composerUI(s),discussionCollapsed:projectDiscussionCollapsed}),tasks:()=>V.board(s),team:()=>V.team(s),assets:()=>V.artifacts(s),connections:()=>V.connections(s),trash:()=>window.StudioTrash.render(runtime?.trash.items||[],store.getState(),runtime?.trash.error||'',runtime?.trash.loaded,trashSelection)};
    one('#view-content').innerHTML=(renderers[s.view]||renderers.overview)();
    if(s.view==='trash')syncTrashSelection();
    all('[data-runtime-detail]').forEach(el=>{if(detailStates.has(el.dataset.runtimeDetail))el.open=detailStates.get(el.dataset.runtimeDetail);});
    mediaForms.forEach(form=>{const replacement=one('form[data-form="'+form.dataset.form+'"]');replacement?.replaceWith(form);});
    for(const replacement of all('#view-content [data-media-preview-key]')){const saved=mediaPreviews.get(replacement.dataset.mediaPreviewKey);if(saved){replacement.replaceWith(saved);if(saved.hidden){const fallback=saved.closest('[data-media-result]')?.querySelector('[data-media-fallback]');if(fallback)fallback.hidden=false;}}}
    syncMediaControls();
    layout?.refresh();
    const connection=runtime?.connection,status=one('.executor-status');
    if(status){status.textContent=connection?.state==='checking'?'正在连接执行器':connection?.ready?'执行器已连接':connection?.state==='online'?'模型未就绪':'便笺模式';status.classList.toggle('success',Boolean(connection?.ready));}
    icons();
    if(runtime&&['overview','project','assets','tasks'].includes(s.view))runtime.loadScope(runtimeScope(s));
    if(runtime&&s.view==='project'&&!s.activePeerId&&s.projectTab==='storyboard'&&p&&!p.isDemo)runtime.loadStoryboard(p.id);
    if(s.view==='project'&&!s.activePeerId&&s.projectTab==='characters'&&p&&!p.isDemo)canvas?.mountAssets?.(one('[data-character-assets-root]'),p);
    if(s.view==='project'&&!s.activePeerId&&s.projectTab==='canvas'&&p&&!p.isDemo)canvas?.mount(one('[data-canvas-root]'),p);
    all('.conversation-stream').forEach((el,i)=>{const position=streamPositions[i];if(position)el.scrollTop=position.atEnd?el.scrollHeight:position.top;});
    restoreFocus(previous);
  }
  function dispatch(action,success){const result=store.dispatch(action);if(!result.ok)toast(result.error);else if(success)toast(success);return result;}
  function closeSidebar(){root.classList.remove('sidebar-open');one('[data-action="toggle-sidebar"]')?.setAttribute('aria-expanded','false');}
  function focusAfterDialog(){
    if(returnFocus?.isConnected){returnFocus.focus({preventScroll:true});return;}
    if(!restoreFocus(returnTarget))(one('.nav-item.is-active')||one('[data-action="new-project"]'))?.focus({preventScroll:true});
  }
  function rememberMediaComposer(){const form=one('[data-form="media-estimate"]');if(form?._mediaContext)mediaComposers.set(form._composerKey,form);}
  function closeDialog(){rememberMediaComposer();panel.hidden=true;panel.replaceChildren();if(dialog.open)dialog.close();one('#dialog-body').replaceChildren();focusAfterDialog();}
  function showDialog(markup,trigger){
    rememberMediaComposer();
    returnFocus=trigger||document.activeElement;
    returnTarget={id:returnFocus?.id,action:returnFocus?.dataset?.action,entity:returnFocus?.dataset?.id};
    if(inline){panel.innerHTML='<button type="button" class="icon-button modal-close cursor-interaction" data-action="close-dialog" aria-label="关闭">×</button>'+markup;panel.hidden=false;panel.scrollIntoView({block:'start',behavior:'instant'});}
    else{one('#dialog-body').innerHTML=markup;if(!dialog.open)dialog.showModal();}
    const host=inline?panel:one('#dialog-body');const heading=host.querySelector('h2');if(heading){heading.id='studio-modal-title';if(!inline)dialog.setAttribute('aria-labelledby',heading.id);}
    icons();requestAnimationFrame(()=>host.querySelector('input:not([type="hidden"]),textarea,select,button')?.focus({preventScroll:true}));
  }
  function mediaComposerKey(context){return JSON.stringify([context.projectId,context.shotId||'',context.sourceArtifactId||'',context.promptArtifactId||'',context.mediaKind]);}
  function openMediaComposer(context,trigger,existingKey=null){
    const p=visibleState().projects.find(p=>p.id===context.projectId);if(!p||p.isDemo){toast('请先选择真实项目。');return;}
    const key=existingKey||mediaComposerKey(context),saved=mediaComposers.get(key);
    showDialog(V.projectMediaComposer(p,context,context.initialPrompt||''),trigger);
    let form=one('[data-form="media-estimate"]');if(saved){form.replaceWith(saved);form=saved;}
    form._mediaContext=Object.freeze({...context});form._composerKey=key;mediaComposers.set(key,form);syncMediaControls();
  }
  function workflowPromptBinding(workflow){
    return '<label class="field-label">把上方提示词写入哪个字段<select class="select" name="workflowPromptTarget"><option value="">请选择接收提示词的字段</option>'+(workflow.fields||[]).map((field,index)=>field.valueType==='string'?'<option value="'+index+'">'+V.esc((field.nodeTitle||field.classType||'节点')+' · '+field.nodeId+' / '+field.fieldName)+'</option>':'').join('')+'</select></label>';
  }
  function openTask(id,trigger){const s=visibleState(),t=s.tasks.find(t=>t.id===id);if(t)showDialog(V.taskDetails(t,s),trigger);}
  function openSearch(trigger){const s=visibleState();showDialog('<h2>寻找项目、成果与伙伴</h2><label class="field-label">搜索<input class="field" type="search" id="command-query" maxlength="100" placeholder="输入项目、成果、姓名或岗位…"></label><div id="command-results">'+V.searchResults('',s)+'</div>',trigger);}
  function formError(form,text){const error=form.querySelector('.form-error');if(error){error.textContent=text;error.hidden=false;}else toast(text);}
  function setProjectKind(form,kind){
    const template=window.STUDIO_TEMPLATES[kind];if(!template||!form)return;
    form.querySelector('#new-project-kind').value=kind;
    const reviewModes=form.querySelector('#project-review-mode-options');
    if(reviewModes){reviewModes.hidden=kind==='game';reviewModes.disabled=kind==='game';}
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
  function canvasContextText(context,projectId){
    if(!context||context.projectId!==projectId)return '';
    const pick=(source,limits)=>{const result={};if(!source||typeof source!=='object')return result;for(const [key,limit] of Object.entries(limits))if(typeof source[key]==='string'||typeof source[key]==='number'||typeof source[key]==='boolean')result[key]=String(source[key]).slice(0,limit);return result;};
    const sameProject=item=>item&&(!item.projectId||item.projectId===projectId);
    const summary={projectId,node:pick(context.node||context.activeNode,{id:100,shotId:100,title:160,mediaKind:20,prompt:1800,modelId:200,sourceArtifactId:100,promptArtifactId:100,status:30}),assets:(Array.isArray(context.assets)?context.assets:[]).filter(sameProject).slice(0,8).map(item=>pick(item,{id:100,nodeId:100,type:30,name:100,status:30,description:300,prompt:600,version:30,referenceJobId:100,referenceMediaId:100})),media:(Array.isArray(context.media)?context.media:[]).filter(sameProject).slice(0,8).map(item=>pick(item,{id:100,shotId:100,status:30,modelId:120,error:200}))};
    return JSON.stringify(summary).slice(0,6500);
  }
  function payloadFor(s,{prompt,mode='chat',agentIds,task=null,inputArtifacts=[],scope=null}){
    const peerId=scope?scope.peerId:s.activePeerId;
    const p=peerId?null:scope?.projectId?s.projects.find(p=>p.id===scope.projectId):V.project(s);
    if(!peerId&&!p)throw new Error('请先创建或选择一个项目。');
    const target=peerId?{peerId}:{projectId:p.id};
    const runs=runtime.getRuns(target),history=runs.flatMap(run=>[{runId:run.id,authorId:'user',content:run.prompt},...(run.messages||[]).map(m=>({runId:run.id,authorId:m.authorId,content:m.content}))]).slice(-24);
    const sourceArtifacts=inputArtifacts.length?inputArtifacts:p?s.artifacts.filter(a=>a.projectId===p.id).slice(-8).map(a=>({id:a.id,title:a.title,body:a.body})):[];
    const context=!peerId&&p&&s.view==='project'&&s.projectTab==='canvas'?canvasContextText(canvas?.context?.(),p.id):'';
    const requestPrompt=context?prompt+'\n\n【当前画布上下文，仅供讨论；生成仍由用户在画布确认】\n'+context:prompt;
    return {requestId:crypto.randomUUID(),mode,project:p?{id:p.id,title:p.title,kind:p.kind,brief:p.brief,members:p.members,isDemo:p.isDemo}:null,peerId:peerId||null,task,tasks:p?s.tasks.filter(t=>t.projectId===p.id):[],decisions:p?s.decisions.filter(d=>d.projectId===p.id):[],agentIds,prompt:requestPrompt,history,inputArtifacts:sourceArtifacts};
  }
  async function optimizeCanvasPrompt({project,node,model,instruction,requestId}){
    if(!runtime?.ready())throw new Error('员工执行器尚未就绪，请在工具与连接检查。');
    const character=node.nodeKind==='character',agentId=character?'R05':'R06';
    const plans=production?.getProductions(project.id)||[],plan=plans.at(-1),members=[...new Set([...(plan?.project?.members||project.members||[]),agentId])];
    const prompt=['请只优化当前创作画布卡片的生成提示词，不改写剧本，不启动任何图片或视频生成。只返回可直接用于生成的提示词正文，不加标题、说明、Markdown围栏或审阅清单。',
      ...(character?['依据执行器完整加载的 R05 美术指导兼视觉资产设计原岗位正文与团队共享指令，完成高品质二维青春漫画人物定妆的美术优化。',
        '保留角色身份、年龄、关键服装和原有设定；精修脸型结构、发型轮廓、服装剪裁、配色关系与材质表达，建立贴合身份和性格的辨识度。用清晰而有变化的线稿、自然的人体比例、干净克制的明暗和有层次的用色呈现精致漫画质感；避免土气、廉价感、粗糙模板服装和塑料质感，不用统一脸型抹去人物差异。',
        '生成目标为同一角色的无字定妆参考板：正面、侧面、背面全身立绘与头像特写，脸型、发型、服装结构、配色和年龄在各视图一致；背景简洁、留白清楚，不混入其他角色、剧情场景或说明文字。',
        '本轮仅交付生成 prompt；禁止伪造人物参考图已生成、已检查或已审核，不得将美术方案表述为实际图像成果。']:[]),
      '卡片：'+(node.shotId||'自由素材')+' · '+node.mediaKind+' · '+node.title,
      '所选模型：'+(model?.label||node.modelId)+'；保留角色身份、镜头内容和当前叙事约束。',
      '用户优化要求：'+(instruction||(character?'提升人物定妆的造型品质和辨识度，保留既有身份与设定。':'改善表达的精确度、镜头与光影层次，保留原意。')),
      '当前提示词：\n'+node.prompt].join('\n\n');
    if(prompt.length>20000)throw new Error('当前提示词与优化要求合计过长，请缩短后再提交。');
    return runtime.start({requestId:requestId||crypto.randomUUID(),mode:'produce',project:{id:project.id,title:project.title,kind:project.kind,brief:project.brief,members},agentIds:[agentId],prompt,inputArtifacts:[node.sourceArtifactId,node.promptArtifactId].filter(Boolean).map(id=>({id}))});
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
    const s=visibleState(),task=s.tasks.find(t=>t.id===id);if(!task)return;
    const blockers=viewStore.blockers(id);if(blockers.length){toast('请先满足：'+blockers.join('；'));return;}
    if(!runtime?.ready()){toast('请先在工具与连接确认执行器可用。');return;}
    const owner=review?task.reviewerId:task.ownerId;
    const prompt=review?'请针对本任务已有成果提供复核意见，逐项对照验收标准，明确实际检查范围、问题和待验证项。不要把建议标成独立复核通过。':'请完成任务“'+task.title+'”。\n交付预期：'+(task.deliverable||'请按岗位职责给出可用文稿')+'\n验收标准：'+(task.acceptance||'明确假设、来源与待验证事项');
    showDialog('<h2>'+V.esc(review?'请求复核意见':'交给伙伴制作')+'</h2><p>'+V.esc(V.name(owner))+' · '+V.esc(task.title)+'</p><form class="form-stack" data-form="runtime-task"><input type="hidden" name="taskId" value="'+V.esc(id)+'"><input type="hidden" name="review" value="'+(review?'yes':'no')+'"><label class="field-label">本轮要求<textarea class="textarea" name="prompt" rows="7" maxlength="12000" required>'+V.esc(prompt)+'</textarea></label><p class="context-note">生成结果另存为可审阅成果，不自动更改任务完成或复核状态。</p><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button-primary" type="submit">开始真实执行</button><button class="button-secondary" type="button" data-action="close-dialog">取消</button></div></form>',trigger);
  }
  function syncTrashSelection(){
    const active=window.StudioTrash.selectedIds(runtime?.trash.items||[],trashSelection);
    trashSelection.clear();active.forEach(id=>trashSelection.add(id));
    const boxes=all('[data-trash-select]');boxes.forEach(box=>{box.checked=trashSelection.has(box.dataset.trashSelect);});
    const selectAll=one('[data-trash-select-all]');if(selectAll){selectAll.checked=boxes.length>0&&active.length===boxes.length;selectAll.indeterminate=active.length>0&&active.length<boxes.length;}
    const count=one('[data-trash-selection-count]');if(count)count.textContent='已选 '+active.length+' / '+boxes.length+' 项';
    const remove=one('[data-action="trash-purge-selected"]');if(remove)remove.disabled=!active.length||trashPurgeBusy;
  }
  root.addEventListener('change',event=>{
    const input=event.target;
    if(input.matches('[data-trash-select]')){input.checked?trashSelection.add(input.dataset.trashSelect):trashSelection.delete(input.dataset.trashSelect);syncTrashSelection();}
    if(input.matches('[data-trash-select-all]')){trashSelection.clear();if(input.checked)window.StudioTrash.recoverable(runtime?.trash.items||[]).forEach(item=>trashSelection.add(item.id));syncTrashSelection();}
  });
  root.addEventListener('click',async event=>{
    const control=event.target.closest('button,a');if(!control||!root.contains(control))return;
    if(control.dataset.nav){event.preventDefault();closeDialog();closeSidebar();dispatch({type:'NAVIGATE',view:control.dataset.nav});if(control.dataset.nav==='trash')await runtime?.refreshTrash();return;}
    const action=control.dataset.action,id=control.dataset.id,s=visibleState(),p=V.project(s);
    if(!action)return;
    if(action==='project-showcase'||action==='project-final-video'){
      if(!p||workspaceSync?.blocked()){toast('请先完成项目同步，再设置展示作品。');return;}
      const index=Number(control.dataset.outputIndex),job=runtime?.media.jobs.find(item=>item.id===id&&item.projectId===p.id&&item.status==='succeeded'),output=Number.isSafeInteger(index)&&index>=0?job?.outputs?.[index]:null,info=V.mediaOutputInfo(output),final=action==='project-final-video';
      if(!info||!info.video&&!info.image||final&&!info.video){toast('这份成果已不可用，请刷新后重新选择。');return;}
      dispatch({type:'SET_PROJECT_SHOWCASE',projectId:p.id,resultShowcase:{jobId:id,outputIndex:index,final}},final?'已标记为最终成片，并放到主展示位。':'已放到项目主展示位。');return;
    }
    if(action==='trash-refresh'){await runtime?.refreshTrash();return;}
    if(['trash-purge','trash-purge-selected','trash-empty'].includes(action)){
      if(trashPurgeBusy)return;
      if(runtime?.connection.state!=='online'){toast('请先连接本机服务，再清理回收站。');return;}
      const items=window.StudioTrash.recoverable(runtime.trash.items),ids=action==='trash-empty'?items.map(item=>item.id):window.StudioTrash.selectedIds(items,action==='trash-purge'?[id]:trashSelection);
      if(!ids.length){toast('请先选择要彻底删除的内容。');return;}
      pendingTrashPurge=ids.slice();showDialog(window.StudioTrash.purgeConfirmation(items,ids),control);return;
    }
    if(action==='trash-purge-confirm'){
      if(trashPurgeBusy||!pendingTrashPurge?.length)return;
      const ids=pendingTrashPurge.slice(),errorNode=one('[data-trash-purge-error]'),originalLabel=control.textContent;
      if(workspaceSync?.blocked()){if(errorNode){errorNode.textContent='请先完成项目同步，再清理回收站。';errorNode.hidden=false;}return;}
      trashPurgeBusy=true;control.disabled=true;control.textContent='正在删除…';
      try{
        if(workspaceSync?.status.state==='saving'){await workspaceSync.retry();if(workspaceSync.status.state!=='synced')throw new Error('项目仍在保存，请稍后重试。');}
        await runtime.purgeTrash(ids);ids.forEach(id=>trashSelection.delete(id));pendingTrashPurge=null;closeDialog();toast('已彻底删除所选 '+ids.length+' 项内容。');
        const refreshed=await Promise.allSettled([workspaceSync?.retry(),runtime.refreshMedia(),runtime.loadScope(runtimeScope(visibleState()),true),production?.refresh(V.project(visibleState())?.id)]);
        if(refreshed.some(result=>result.status==='rejected'))toast('彻底删除已完成，部分列表稍后刷新。');
      }catch(error){if(errorNode?.isConnected){errorNode.textContent=error.message;errorNode.hidden=false;}else toast(error.message);}
      finally{trashPurgeBusy=false;if(control.isConnected){control.disabled=false;control.textContent=originalLabel;}syncTrashSelection();}return;
    }
    if(action==='trash-restore'){
      control.disabled=true;
      try{await runtime.restoreTrash(id);closeDialog();toast('已恢复，可回到原页面查看。');await runtime.refreshMedia();await runtime.loadScope(runtimeScope(visibleState()),true);await production?.refresh(V.project(visibleState())?.id);}
      catch(error){toast(error.message);control.disabled=false;}return;
    }
    if(action==='trash-delete'||action==='trash-confirm-project'){
      const kind=control.dataset.kind||'project',projectId=control.dataset.projectId||(kind==='project'?id:'');
      if(!runtime||runtime.connection.state!=='online'){toast('请先连接本机服务，再删除内容。');return;}
      if(workspaceSync?.blocked()){toast('请先完成项目同步，再删除内容。');return;}
      if(workspaceSync?.status.state==='saving'){await workspaceSync.retry();if(workspaceSync.status.state!=='synced'){toast('项目正在保存，请保存完成后再删除。');return;}}
      if(kind==='project'&&action!=='trash-confirm-project'){
        const target=s.projects.find(item=>item.id===id);if(!target){toast('这个项目已移入回收站。');return;}
        const count=(key)=>(s[key]||[]).filter(item=>item.projectId===id).length;
        showDialog('<h2>将项目移入回收站？</h2><p><strong>'+V.esc(target.title)+'</strong></p><p class="context-note">项目及其任务、便笺、文稿、图片视频、自动协作和画布将一起从工作区隐藏。恢复项目后可继续查看；此前单独删除的内容仍留在回收站。</p><p class="small muted">当前项目中：'+count('tasks')+' 项任务 · '+count('artifacts')+' 份手工成果 · '+count('messages')+' 条便笺。正在执行的工作需先停止或等待结束。</p><div class="form-actions"><button class="button-secondary" type="button" data-action="close-dialog">保留项目</button><button class="button-primary" type="button" data-action="trash-confirm-project" data-kind="project" data-id="'+V.esc(id)+'">移入回收站</button></div>',control);return;
      }
      control.disabled=true;
      try{const items=await runtime.trashItems([{kind,targetId:id,...(projectId?{projectId}:{})}]);const entry=items.find(item=>item.kind===kind&&item.targetId===id);closeDialog();toast('已移入回收站，随时可以恢复。',entry?.id);}
      catch(error){toast(error.message);control.disabled=false;}return;
    }
    if(action==='workspace-retry'){await workspaceSync?.retry();return;}
    if(action==='workspace-use-remote'){try{await workspaceSync.useRemote();toast('已恢复数据库版本，原本页副本仍保留在备份中。');}catch(error){toast(error.message);}return;}
    if(action==='workspace-data'){
      showDialog('<h2>工作台数据</h2><p>'+V.esc(workspaceSync?.status.message||'当前使用本地浏览器存储。')+'</p><p class="context-note">项目、任务、便笺和手工成果共用本机数据库。真实执行记录和生成文件由后台单独保留。导出的 JSON 包含当前项目与冲突副本，不含 API Key。</p><div class="form-actions"><button type="button" class="button-primary" data-action="export-state">导出 JSON 备份</button></div><form class="form-stack" data-form="workspace-import"><label class="field-label">恢复 JSON 备份<input class="field" type="file" name="backup" accept="application/json,.json" required></label><p class="context-note">导入会更新备份中的项目与记录，并保留当前已有内容；导入前自动保留本页副本。删除内容请使用回收站。真实运行记录与 API 配置保持独立。</p><p class="form-error" role="alert" hidden></p><button type="submit" class="button-secondary">导入并恢复</button></form>',control);return;
    }
    if(action==='production-refresh'){await production?.refresh(id||p?.id);return;}
    if(action==='production-tools'){const plan=production?.getProductions(p?.id)?.at(-1);if(window.StudioProduction.canvasApprovalKey(plan)){try{await openProductionCanvas(plan);}catch(error){toast(error.message);}}else dispatch({type:'SET_UI',projectTab:'characters'});return;}
    if(action==='characters-enter-storyboard'||action==='characters-enter-canvas'){control.disabled=true;try{await openProjectCanvas(p,null,action==='characters-enter-storyboard'?'storyboard':'canvas');}catch(error){toast(error.message);}finally{if(control.isConnected)control.disabled=false;}return;}
    if(action==='production-artifact'){const artifact=production?.findArtifact(id);if(artifact)showDialog(V.productionArtifactDetails(artifact),control);else toast('这份成果可能已删除，请到回收站查看，或刷新协作记录。');return;}
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
    if(action==='runtime-connect'){await runtime?.connect();await runtime?.loadScope(runtimeScope(visibleState()),true);await runtime?.refreshMedia();toast(runtime?.ready()?'执行器已就绪，可以发送工作要求。':runtime?.connection.reason||'执行器尚未就绪。');return;}
    if(action==='media-price'){const provider=runtime?.media.providers.find(p=>p.id===id);if(provider)showDialog(V.providerPriceForm(provider),control);return;}
    if(action==='media-refresh'){await runtime?.refreshMedia();return;}
    if(['media-view-result','media-view-task','media-focus-job','media-prepare-retry'].includes(action)){
      const job=runtime?.media.jobs.find(item=>item.id===id),target=s.projects.find(item=>item.id===job?.projectId);
      if(!job||!target){toast('这条任务已不可用，请刷新后重试。');return;}
      if(action==='media-prepare-retry'){
        if(!['failed','cancelled'].includes(job.status)){toast('请先查询当前状态；结果尚未明确时不能重新提交。');return;}
        showDialog('<h2>调整后重新生成</h2><p>'+V.esc(job.name||'媒体任务')+'</p><p class="context-note">先回到对应画布检查提示词、模型和参数。再次生成会重新计算预计费用，由你确认后提交；本次失败记录保留。</p>'+(job.error?'<p class="runtime-error">'+V.esc(typeof job.error==='string'?job.error:JSON.stringify(job.error))+'</p>':'')+'<div class="form-actions"><button type="button" class="button-primary" data-action="media-focus-job" data-id="'+V.esc(job.id)+'">回画布调整</button><button type="button" class="button-secondary" data-action="close-dialog">暂不处理</button></div>',control);return;
      }
      closeDialog();
      if(action==='media-focus-job'){
        try{await focusMediaJob(job);}catch(error){toast(error.message);}return;
      }
      if(action==='media-view-result'&&job.status!=='succeeded'){toast('任务还没有成功返回结果，请在执行队列查看状态。');return;}
      dispatch({type:'SELECT_PROJECT',id:job.projectId});dispatch({type:'SET_UI',projectTab:action==='media-view-result'?'assets':'tasks'});
      requestAnimationFrame(()=>{const entry=one('['+(action==='media-view-result'?'data-media-asset-id':'data-media-task-id')+'="'+CSS.escape(job.id)+'"]');entry?.scrollIntoView({block:'center',behavior:'smooth'});entry?.focus({preventScroll:true});});return;
    }
    if(action==='media-open-project'){closeDialog();dispatch({type:'SELECT_PROJECT',id});dispatch({type:'SET_UI',projectTab:'canvas'});runtime?.refreshMedia();return;}
    if(action==='storyboard-refresh'){await runtime?.loadStoryboard(id,true);return;}
    if(action==='media-compose'){
      const target=s.projects.find(item=>item.id===id);if(!target||target.isDemo){toast('请先选择真实项目。');return;}
      const shotId=control.dataset.shotId,mediaKind=control.dataset.kind==='video'?'video':'image';
      const shot=shotId?runtime?.getStoryboard(id).shots.find(item=>item.id===shotId):null;
      if(shotId&&!shot){toast('镜头来源已变化，请刷新分镜后再试。');return;}
      const context={projectId:id,mediaKind,...(shot?{shotId:shot.id,sourceArtifactId:shot.sourceArtifactId,promptArtifactId:shot.promptArtifactId||null,initialPrompt:mediaKind==='video'?shot.videoPrompt:shot.imagePrompt,name:shot.id+' · '+(shot.title||'镜头')+' · '+(mediaKind==='video'?'视频':'图片')}:{})};
      if(s.view!=='project'||s.activePeerId||s.activeProjectId!==id)dispatch({type:'SELECT_PROJECT',id});
      try{await openProjectCanvas(target,{...context,create:!shot});}catch(error){toast(error.message);}return;
    }
    if(action==='media-back-compose'){const pending=pendingEstimate;if(pending?.context)openMediaComposer(pending.context,control,pending.composerKey);else toast('草稿已不可用，请从项目重新打开。');return;}

    if(action==='media-model-verify'){
      const secret=one('[data-form="runninghub-model-config"] [name="modelApiKey"]');
      if(secret?.value.trim()){toast('请先保存填写的模型密钥，再测试连接。');return;}
      if(mediaBusy.has('model-verify'))return;
      mediaDraftsDirty=true;mediaBusy.add('model-verify');modelVerificationError='';syncMediaControls();
      try{const result=await runtime.verifyRunningHub('model_api');if(!result?.verified)throw new Error('模型连接验证尚未通过，请检查企业共享密钥。');toast('RunningHub 模型连接验证通过；没有创建生成任务。');}
      catch(error){modelVerificationError=error.message;toast(error.message);}
      finally{mediaBusy.delete('model-verify');syncMediaControls();}return;
    }
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
      try{const workflow=await runtime.readRunningHubWorkflow(requested);if(!workflow?.workflowId||!Array.isArray(workflow.fields))throw new Error('未收到可读取的工作流参数。');if(input.value.trim()!==requested)throw new Error('工作流输入已修改，请重新读取。');form._runninghubWorkflow=workflow;input.value=workflow.workflowId;form.querySelector('[data-workflow-editor]').innerHTML=V.runninghubWorkflowFields(workflow);const binding=form.querySelector('[data-workflow-prompt-binding]');if(binding)binding.innerHTML=workflowPromptBinding(workflow);const error=form.querySelector('.form-error');if(error)error.hidden=true;toast('工作流参数已读取，勾选要修改的字段后应用到 JSON。');}
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
    if(action==='runtime-artifact'){const a=runtime?.findArtifact(id);if(a)showDialog(V.runtimeArtifactDetails(a,runtime.findRun(a.runId)),control);else toast('这份成果已不可见，可到回收站查看。');return;}
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
    if(action==='project-tab'){if(s.view!=='project'&&p)dispatch({type:'SELECT_PROJECT',id:p.id});try{await switchProjectTab(id);}catch(error){toast('当前修改尚未保存，已保留本页。'+error.message);}return;}
    if(action==='home-project-tab'){
      const target=s.projects.find(item=>item.id===id&&!item.isDemo),tab=control.dataset.projectTab;
      if(!target||!['assets','tasks'].includes(tab))return;
      dispatch({type:'SELECT_PROJECT',id:target.id});dispatch({type:'SET_UI',projectTab:tab});return;
    }
    if(action==='project-discussion-toggle'){
      projectDiscussionCollapsed=!projectDiscussionCollapsed;layout?.setDiscussionCollapsed?.(projectDiscussionCollapsed);
      rerender();one('[data-action="project-discussion-toggle"]')?.focus({preventScroll:true});return;
    }
    if(action==='select-shot'){dispatch({type:'SET_UI',selectedShot:id});return;}
    if(action==='task-filter'){dispatch({type:'SET_UI',taskFilter:id});return;}
    if(action==='navigate-artifacts'){dispatch({type:'NAVIGATE',view:'assets'});return;}
    if(action==='navigate-team'){dispatch({type:'NAVIGATE',view:'team'});return;}
    if(action==='navigate-tasks'){dispatch({type:'NAVIGATE',view:'tasks'});return;}
    if(action==='new-task'){const target=s.projects.find(p=>p.id===(id||s.activeProjectId));if(target)showDialog(V.taskForm(target,s),control);return;}
    if(action==='new-artifact'){const target=s.projects.find(p=>p.id===(id||s.activeProjectId));if(target)showDialog(V.artifactForm(target,s),control);return;}
    if(action==='open-artifact'||action==='review-asset'){const a=s.artifacts.find(a=>a.id===id);if(a)showDialog(V.artifactDetails(a,s),control);else toast('这份成果已移入回收站。');return;}
    if(action==='open-decision'){const d=s.decisions.find(d=>d.id===id);if(d)showDialog(V.decisionForm(d,s),control);else toast('这项决策已移入回收站。');return;}
    if(action==='rework-decision'){const form=control.closest('form');if(form)submitForm(form,{type:'REWORK_DECISION',id,reason:new FormData(form).get('reason')},'已记录退回要求，相关下游需重新复核。');return;}
    if(action==='handoff'){dispatch({type:'HANDOFF',taskId:id},'已记录交接意图；尚未发送给员工执行器。');return;}
    if(action==='favorite'){dispatch({type:'TOGGLE_FAVORITE',id});return;}
    if(action==='filter'){dispatch({type:'FILTER',filter:id});return;}
    if(action==='page'){dispatch({type:'PAGE',page:Number(id)});return;}
    if(action==='mention'){const input=one('#message-text');if(input){const prefix=input.value&&!input.value.endsWith(' ')?' ':'';input.value+=prefix+'@'+V.name(id)+' ';drafts.set(draftKey(s),input.value);input.focus();}return;}
    if(action==='export-state'){
      const snapshot=JSON.stringify(workspaceSync?.exportData()||{exportedAt:new Date().toISOString(),application:'造梦工作室',state:store.getState()},null,2);
      if(inline){showDialog('<h2>工作台 JSON 备份</h2><p class="muted">可复制以下完整快照。独立工作台支持下载 JSON 文件。</p><textarea class="textarea" rows="15" readonly aria-label="JSON备份正文">'+V.esc(snapshot)+'</textarea>',control);return;}
      const url=URL.createObjectURL(new Blob([snapshot],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='造梦工作室_备份_'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);toast('已请求下载当前本地数据快照。');return;
    }
  });
  root.addEventListener('submit',async event=>{
    const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();const data=new FormData(form),fields=Object.fromEntries(data.entries()),s=visibleState();
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
      const approvalPosition={navigationEpoch:canvasNavigationEpoch,editingEpoch:canvasEditingEpoch};
      try{const updated=await production.review(id,{expectedRevision,stageId,action,note});productionDrafts.delete(key);saveProductionSession();rerender();const approved=updated||production.find(id);if(action==='approve'&&stageId==='visual'&&visualApprovalKey(approved)){try{await openVisualAssets(approved,approvalPosition);}catch(error){toast('美术设定已确认。'+error.message);}}else if(action==='approve'&&(updated?.status==='completed'||production.find(id)?.status==='completed')){try{await openProductionCanvas(approved);}catch(error){toast('文稿已确认。'+error.message);}}else toast(action==='revise'?'修改意见已交回，旧版本保留。':'已记录你的认可，团队按流程继续交接。');}
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
    if(form.dataset.form==='runninghub-model-config'){
      const secret=form.querySelector('[name="modelApiKey"]'),clear=form.querySelector('[name="clearModelApiKey"]'),config={};
      if(secret.value.trim())config.modelApiKey=secret.value.trim();
      if(clear.checked)config.clearModelApiKey=true;
      if(config.modelApiKey&&config.clearModelApiKey){formError(form,'填写新密钥与移除密钥不能同时选择。');return;}
      if(!config.modelApiKey&&!config.clearModelApiKey){formError(form,'请填写模型密钥，或勾选移除已保存密钥。');return;}
      mediaDraftsDirty=true;mediaBusy.add('model-config');syncMediaControls();
      try{await runtime.saveConnection(config);if(secret.value.trim()===config.modelApiKey)secret.value='';clear.checked=false;modelVerificationError='';secret.placeholder=config.clearModelApiKey?'仅保存于本机服务端':'已保存 · 留空保留';toast(config.clearModelApiKey?'模型密钥已移除。':'模型密钥已保存在本机服务端，可以测试连接。');}
      catch(error){formError(form,error.message);}
      finally{config.modelApiKey=undefined;mediaBusy.delete('model-config');syncMediaControls();}return;
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
    if(form.dataset.form==='media-diagnostic')return;
    if(form.dataset.form==='media-estimate'){
      if(mediaBusy.has('estimate'))return;
      const budget=Number(fields.budget);if(!Number.isFinite(budget)||budget<=0){formError(form,'请填写大于零的本次预算。');return;}
      const provider=runtime.media.providers.find(p=>p.id==='runninghub'),config=provider?.config||{},context=form._mediaContext,linkedProject=s.projects.find(p=>p.id===context?.projectId),mode=fields.mode==='workflow_api'?'workflow_api':'model_api';
      if(!linkedProject||linkedProject.isDemo){formError(form,'原项目已不可用，请重新选择项目。');return;}
      const name=String(fields.name||'').trim(),taskId=String(fields.taskId||'');if(!name||name.length>160){formError(form,'请填写160字以内的作品名称。');return;}
      if(taskId&&!s.tasks.some(t=>t.id===taskId&&t.projectId===linkedProject.id)){formError(form,'关联任务必须属于当前作品项目。');return;}
      let payload={provider:'runninghub',mode,projectId:context.projectId,mediaKind:context.mediaKind,name,...(taskId?{taskId}:{}),...(context.shotId?{shotId:context.shotId,sourceArtifactId:context.sourceArtifactId,promptArtifactId:context.promptArtifactId}:{}),quantity:1,budget};
      if(mode==='model_api'){
        if(one('[data-form="runninghub-model-config"] [name="modelApiKey"]')?.value.trim()){formError(form,'请先保存填写的模型密钥，再查询报价。');return;}
        const model=(provider?.models||[]).find(item=>(item.id||item.modelId)===fields.modelId);
        try{payload={...payload,modelId:fields.modelId,parameters:window.StudioRuntime.modelParameters(model,mediaModelValues(form))};}
        catch(error){formError(form,error.message);return;}
      }else{
        let nodeInfoList;try{nodeInfoList=JSON.parse(fields.nodeInfoList||'[]');}catch{formError(form,'节点输入必须是合法 JSON 数组。');return;}
        if(!Array.isArray(nodeInfoList)||nodeInfoList.some(node=>!node||typeof node!=='object'||Array.isArray(node)||!String(node.nodeId||'').trim()||!String(node.fieldName||'').trim()||node.fieldValue===undefined)){formError(form,'每个节点需要 nodeId、fieldName 与 fieldValue。');return;}
        if(!data.has('useManualNodeJSON')){
          const workflow=form._runninghubWorkflow,target=String(fields.workflowPromptTarget??''),prompt=String(fields.promptDraft||'');
          if(!prompt.trim()){formError(form,'请填写本次提示词，或明确选择使用已核对的高级 JSON。');return;}
          if(!workflow||String(fields.workflowId||'').trim()!==workflow.workflowId){formError(form,'请先读取当前工作流，并选择接收提示词的字段。');return;}
          const index=Number(target);if(!target||!Number.isInteger(index)||workflow.fields[index]?.valueType!=='string'){formError(form,'请选择要写入提示词的文本字段，避免覆盖错误节点。');return;}
          try{nodeInfoList=window.StudioRuntime.mergeWorkflowFields(workflow,[{index,value:prompt}],nodeInfoList);}catch(error){formError(form,error.message);return;}
        }
        payload={...payload,workflowId:String(fields.workflowId||'').trim(),nodeInfoList,unitPrice:config.unitPrice,unit:config.unit||'次',currency:config.currency||'CNY'};
      }
      const submit=form.querySelector('[type="submit"]'),quoteRevision=form._mediaRevision||0;submit.disabled=true;
      mediaDraftsDirty=true;mediaBusy.add('estimate');syncMediaControls();
      try{const estimate=await runtime.estimateMedia(payload);if(!form.isConnected){toast('估价已返回，草稿已保留。请重新打开原项目窗口继续。');return;}if((form._mediaRevision||0)!==quoteRevision){formError(form,'参数已修改，请重新查询本次报价。');return;}pendingEstimate={payload,estimate,requestId:crypto.randomUUID(),context,composerKey:form._composerKey};showDialog(V.mediaEstimateDetails(payload,estimate),submit);}
      catch(error){formError(form,error.message);if(!form.isConnected)toast(error.message);}finally{mediaBusy.delete('estimate');syncMediaControls();}return;
    }
    if(form.dataset.form==='media-submit'){
      if(mediaBusy.has('submit'))return;
      const pending=pendingEstimate;if(!pending||!data.has('confirmCost')){formError(form,'请重新预览费用并勾选本次调用确认。');return;}
      if(!pending.estimate.known||pending.estimate.withinBudget!==true){formError(form,'费用未知或超过预算，不能提交。');return;}
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;submit.textContent='正在提交…';mediaBusy.add('submit');
      try{const job=await runtime.submitMedia({...pending.payload,confirmCost:true,estimateToken:pending.estimate.estimateToken,requestId:pending.requestId});if(!job?.id)throw new Error('提交结果尚未确认，请保留本次请求并查询任务记录。');if(pendingEstimate===pending)pendingEstimate=null;mediaComposers.delete(pending.composerKey);if(form.isConnected){closeDialog();dispatch({type:'SELECT_PROJECT',id:pending.payload.projectId});dispatch({type:'SET_UI',projectTab:'tasks'});}toast(job.status==='unknown'?'服务商受理状态尚未确认。请先查询该任务，不要重复提交。':job.status==='failed'?'该次请求已失败，请查看媒体任务中的实际错误。':job.status==='succeeded'?'服务商已返回结果，可打开查看。':'已提交一次 RunningHub 任务，请查询真实状态。');}
      catch(error){formError(form,error.message);if(!form.isConnected)toast(error.message);}finally{mediaBusy.delete('submit');if(submit.isConnected){submit.disabled=false;submit.textContent='确认费用并提交一次生成';}}return;
    }
    if(form.dataset.form==='runtime-task'){
      const task=s.tasks.find(t=>t.id===fields.taskId);if(!task){formError(form,'任务已不存在。');return;}
      const reasons=viewStore.blockers(task.id);if(reasons.length){formError(form,'条件未满足：'+reasons.join('；'));return;}
      const review=fields.review==='yes',input=runtime.artifacts({projectId:task.projectId}).filter(a=>a.taskId===task.id).slice(-4);
      if(review&&!input.length&&!s.artifacts.some(a=>a.taskId===task.id)){formError(form,'请先产出或登记这项任务的成果，再请求复核意见。');return;}
      await submitRuntime(form,payloadFor(s,{prompt:fields.prompt,mode:review?'review':'produce',agentIds:[review?task.reviewerId:task.ownerId],task,inputArtifacts:input.map(a=>({id:a.id,title:a.title,body:a.body||a.preview||''})),scope:{projectId:task.projectId}}),()=>{closeDialog();dispatch({type:'SELECT_PROJECT',id:task.projectId});});return;
    }
    if(form.dataset.form==='runtime-revise'){
      const a=runtime.findArtifact(fields.artifactId),run=a&&runtime.findRun(a.runId);if(!a||!run){formError(form,'原成果不可用，请重新打开。');return;}
      const task=run.taskId?s.tasks.find(t=>t.id===run.taskId):null;
      if(task&&viewStore.blockers(task.id).length){formError(form,'关联任务的上游或决策已变更，请先处理门禁条件。');return;}
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
    trackCanvasEditing(input);
    if(input.closest('[data-form="runninghub-config"],[data-form="runninghub-model-config"],[data-form="media-estimate"],[data-form="media-diagnostic"]'))mediaDraftsDirty=true;
    const mediaForm=input.closest('[data-form="media-estimate"]');if(mediaForm){mediaForm._mediaRevision=(mediaForm._mediaRevision||0)+1;pendingEstimate=null;if(input.matches('[data-model-filter]'))syncMediaControls();}
    const productionForm=input.closest('[data-form="production-start"],[data-form="production-review"]');
    if(productionForm&&input.name){const patch={[input.name]:input.value};if(productionForm.dataset.form==='production-review')patch.expectedRevision=Number(productionForm.querySelector('[name="expectedRevision"]').value);productionDraft(productionForm.dataset.draftKey,patch);}

    if(input.id==='search-input'){dispatch({type:'SEARCH',query:input.value});return;}
    if(input.id==='message-text'){drafts.set(draftKey(visibleState()),input.value);return;}
    if(input.id==='command-query'){const target=one('#command-results');if(target)target.innerHTML=V.searchResults(input.value,visibleState());return;}
    if(input.closest('form')){const error=input.closest('form').querySelector('.form-error');if(error)error.hidden=true;}
  });
  root.addEventListener('change',event=>{
    const input=event.target;
    trackCanvasEditing(input);
    const mediaForm=input.closest('[data-form="media-estimate"]');if(mediaForm){mediaForm._mediaRevision=(mediaForm._mediaRevision||0)+1;pendingEstimate=null;}
    if(mediaForm&&(['mode','mediaKind','modelId'].includes(input.name)||input.matches('[data-model-filter]'))){mediaDraftsDirty=true;syncMediaControls();return;}
    if(input.name==='reviewMode'&&input.closest('[data-form="production-start"]')){productionDraft(input.closest('form').dataset.draftKey,{reviewMode:input.value});return;}
    if(input.id==='runtime-mode'){
      const s=visibleState(),ui=composerUI(s);composerPrefs.set(draftKey(s),{...ui,mode:input.value});rerender();return;
    }
    if(input.name==='runtimeAgents'){
      const s=visibleState(),ui=composerUI(s),ids=[...(ui.agentIds||[])];
      if(input.checked){if(ids.length>=4){input.checked=false;toast('每轮最多 4 位伙伴；可完成后继续交接。');return;}ids.push(input.value);}else{const index=ids.indexOf(input.value);if(index>=0)ids.splice(index,1);}
      composerPrefs.set(draftKey(s),{...ui,agentIds:ids});rerender();return;
    }
    if(input.id==='project-picker'){closeDialog();const view=visibleState().view;dispatch({type:'SELECT_PROJECT',id:input.value});if(['tasks','assets'].includes(view))dispatch({type:'NAVIGATE',view});return;}
    if(input.id==='new-project-kind'){
      setProjectKind(input.closest('form'),input.value);
    }
  });
  root.addEventListener('error',event=>{const target=event.target;if(!target.matches?.('[data-media-preview-key]'))return;target.hidden=true;const fallback=target.closest('[data-media-result]')?.querySelector('[data-media-fallback]');if(fallback)fallback.hidden=false;},true);
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  dialog.addEventListener('close',focusAfterDialog);
  root.addEventListener('keydown',event=>{
    if(workspaceSync?.blocked())return;
    if(event.key==='Escape'){closeSidebar();if(inline&&!panel.hidden)closeDialog();}
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearch();}
    if(event.target.id==='message-text'&&(event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();event.target.closest('form').requestSubmit();}
  });
  store.subscribe(render);runtime?.subscribe(render);production?.subscribe(render);workspaceSync?.subscribe(syncNotice);render();syncNotice();
  Promise.resolve(workspaceSync?.start()).then(()=>runtime?.connect()).then(async()=>{await runtime?.loadScope(runtimeScope(visibleState()),true);await runtime?.refreshMedia();await production?.refresh(V.project(visibleState())?.id);});
  window.addEventListener('focus',()=>runtime?.refreshTrash());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)runtime?.refreshTrash();});
  const trashSyncTimer=setInterval(()=>{if(!document.hidden)runtime?.refreshTrash();},5000);
  const mediaSurfaceTimer=setInterval(()=>refreshVisibleMedia().catch(()=>{}),5000);
  window.addEventListener('pagehide',()=>{clearInterval(trashSyncTimer);clearInterval(mediaSurfaceTimer);});
  window.addEventListener('beforeunload',event=>{if(workspaceSync?.status.state==='saving'){event.preventDefault();event.returnValue='项目仍在保存，请稍候。';}});
})();
