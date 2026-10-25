/* Project-owned creation canvas. Loading, editing and saving never submit media. */
(function(global){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const activeBatch=batch=>['queued','running','submitting','stopping'].includes(batch?.status);
  const Controls=typeof module!=='undefined'&&module.exports?require('./canvas-controls.js'):global.StudioCanvasControls;
  const Profiles=typeof module!=='undefined'&&module.exports?require('./character-profile.js'):global.StudioCharacterProfile;
  const styles=Controls.styles;
  const safeURL=value=>typeof value==='string'&&/^https:\/\/[^\s"'<>@\\\u0000-\u001f\u007f]+$/.test(value)?value:'';
  const modelId=model=>model?.id||model?.modelId||'';
  const promptTarget=(node,model)=>node.promptField&&model?.fields?.some(field=>field.name===node.promptField)?node.promptField:model?.fields?.some(field=>field.name==='prompt')?'prompt':'';
  const matchesNodeJob=(item,job,projectId)=>job.projectId===projectId&&((item.jobIds||[]).includes(job.id)||job.canvasNodeId===item.id||job.nodeId===item.id||Boolean(item.shotId&&job.shotId===item.shotId&&job.sourceArtifactId===item.sourceArtifactId&&(job.promptArtifactId||null)===(item.promptArtifactId||null)&&job.mediaKind===item.mediaKind));
  const parameterValues=node=>({...node.parameters,...node.parameterDraft});
  function carryRatio(source,defaults,model){const values=parameterValues(source),ratio=values.aspectRatio||values.ratio,result=clone(defaults||{});if(typeof ratio!=='string'||!/^\d+:\d+$/.test(ratio))return result;const field=model?.fields?.find(field=>['aspectRatio','ratio'].includes(field.name)&&(!field.options?.length||field.options.includes(ratio)));if(field)result[field.name]=ratio;return result;}
  const optionalBudget=value=>value==null||String(value).trim()===''?null:Number(value);
  const executionVersion=entry=>entry.executionVersion??entry.version;
  function registerChange(entry,execution=true){const previous=executionVersion(entry);entry.version++;entry.executionVersion=previous+(execution?1:0);if(execution)entry.quote=null;}
  const currentCharacterAssets=doc=>(doc?.characterAssets||[]).filter(asset=>!asset.sourceVersion||asset.sourceVersion===doc.assetSourceVersion);
  const productionNodes=nodes=>(nodes||[]).filter(item=>item.nodeKind!=='character');
  const entryNodes=entry=>entry.mode==='assets'?entry.doc.nodes.filter(item=>currentCharacterAssets(entry.doc).some(asset=>asset.nodeId===item.id)):productionNodes(entry.doc.nodes);
  const selectedNodes=entry=>entry.doc.nodes.filter(item=>item.selected&&(entry.mode==='assets'?currentCharacterAssets(entry.doc).some(asset=>asset.nodeId===item.id):item.nodeKind!=='character'));
  function characterSummary(asset){return Profiles?.summary(asset)||'暂无人物介绍';}
  function editorDraftFor(entry,id){if(!entry.editorDrafts)entry.editorDrafts=new Map();if(!entry.editorDrafts.has(id))entry.editorDrafts.set(id,{instruction:undefined,suggestion:undefined,requestId:'',aiOpen:false});return entry.editorDrafts.get(id);}
  function suggestionValue(draft,pending){return draft?.requestId===pending?.requestId&&draft?.suggestion!==undefined?draft.suggestion:pending?.recommendation||'';}
  function editorContextMatches(entry,editorId){return Boolean(editorId&&entry?.ui?.activeId===editorId&&entry.doc?.nodes?.some(item=>item.id===editorId));}
  function capturePromptDialogView(dialog,activeElement,lastFocus){
    const focus=dialog.contains(activeElement)?activeElement:dialog.contains(lastFocus)?lastFocus:null;
    return {focus,selection:focus&&typeof focus.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd,focus.selectionDirection]:null,scrolls:[...dialog.querySelectorAll('.canvas-editor-scroll,.prompt-dialog-preview,textarea')].map(element=>({element,top:element.scrollTop,left:element.scrollLeft}))};
  }
  function restorePromptDialogModal(dialog,state){
    if(!dialog?.isConnected||dialog.matches(':modal'))return false;
    const view=state||capturePromptDialogView(dialog,null,null);
    if(dialog.open)dialog.close();dialog.showModal();
    if(view.focus&&dialog.contains(view.focus)){view.focus.focus({preventScroll:true});if(view.selection&&view.focus.setSelectionRange)view.focus.setSelectionRange(...view.selection);}
    for(const scroll of view.scrolls||[])if(dialog.contains(scroll.element)){scroll.element.scrollTop=scroll.top;scroll.element.scrollLeft=scroll.left;}
    return true;
  }
  function previewFor(item,asset,jobs,projectId){
    const ready=safeURL(asset?.referenceUrl),candidate=safeURL(asset?.reviewCandidate?.url);
    if(candidate||ready)return {url:candidate||ready,video:false,label:candidate?'当前定妆候选':'已采用定妆'};
    const successes=orderedJobs((jobs||[]).filter(job=>job.status==='succeeded'&&matchesNodeJob(item,job,projectId))).reverse();
    for(const job of successes)for(const output of job.outputs||[]){const url=safeURL(output.url),type=String(output.outputType||'').toLowerCase();if(url&&(/^(image|video|png|jpe?g|webp|gif|avif|mp4|webm)(?:$|\/)/.test(type)||/\.(png|jpe?g|webp|gif|avif|mp4|webm)(?:\?|$)/i.test(url)))return {url,video:item.mediaKind==='video'||/^(video|mp4|webm)/.test(type),label:'当前生成结果'};}
    return {url:'',video:false,label:item.nodeKind==='character'?'尚无人物定妆图':'尚无生成画面'};
  }
  function mergeLocalNodes(local,incoming,baseline,editableIds){
    const allowed=new Set(editableIds),before=new Map((baseline||[]).map(item=>[item.id,item])),drafts=new Map(local.map(item=>[item.id,item]));
    const fields=['title','prompt','parameters','parameterDraft','modelId','modelSelectionOrigin','stylePreset','promptField','referenceNodeId','position','selected','optimization'];
    const merged=incoming.map(item=>{const draft=drafts.get(item.id),prior=before.get(item.id);if(!draft||!prior||!allowed.has(item.id))return item;const result={...item};for(const key of fields)if(JSON.stringify(draft[key])!==JSON.stringify(prior[key])){if(Object.hasOwn(draft,key))result[key]=clone(draft[key]);else delete result[key];}return result;});
    const ids=new Set(incoming.map(item=>item.id));return [...merged,...local.filter(item=>allowed.has(item.id)&&!ids.has(item.id)&&!before.has(item.id))];
  }
  const quoteSnapshot=entry=>({version:executionVersion(entry),nodeIds:selectedNodes(entry).map(node=>node.id),budget:optionalBudget(entry.ui.budget)});
  const quoteSnapshotCurrent=(entry,snapshot)=>executionVersion(entry)===snapshot.version&&optionalBudget(entry.ui.budget)===snapshot.budget&&JSON.stringify(selectedNodes(entry).map(node=>node.id))===JSON.stringify(snapshot.nodeIds);
  function sceneGroups(nodes){
    const groups=new Map();
    for(const item of nodes||[]){
      if(!item.shotId)continue;
      const key=[item.sourceArtifactId||'',item.sourceVersion||'',item.shotId].join(':');
      if(!groups.has(key))groups.set(key,{id:key,shotId:item.shotId,title:String(item.title||item.shotId).replace(/\s*·\s*(图片|视频)\s*$/,''),nodes:[]});
      groups.get(key).nodes.push(item);
    }
    return [...groups.values()];
  }
  function modelSummary(item,model){
    const values={...model?.defaults,...parameterValues(item)};if(/^seedream-v5-pro\//.test(item.modelId)&&parameterValues(item).width&&parameterValues(item).height&&!parameterValues(item).resolution)delete values.resolution;const bits=[model?.label||'模型加载中'];
    const ratio=values.aspectRatio||values.ratio;if(ratio)bits.push(ratio==='adaptive'?'随参考图画幅':ratio);else if(values.width&&values.height)bits.push(values.width+' × '+values.height);
    const quality=values.resolution||values.size;if(quality)bits.push(values.resolution?Controls.resolutionLabel(quality,model):String(quality));
    if(item.mediaKind==='video'){
      const duration=values.duration??values.durationSeconds;
      if(duration)bits.push('生成 '+duration+' 秒');
      if(item.targetDuration&&Number(item.targetDuration)!==Number(duration))bits.push('分镜 '+item.targetDuration+' 秒');
    }
    return bits.join(' · ');
  }
  function combinedPrompt(node){return [String(node.prompt||'').trim(),styles.find(style=>style.id===node.stylePreset)?.prompt||''].filter(Boolean).join('\n\n');}
  function referenceImage(node,doc,jobs){
    const reference=doc.nodes.find(item=>item.id===node.referenceNodeId&&item.mediaKind==='image');
    if(!reference)return '';
    const matches=orderedJobs((jobs||[]).filter(job=>job.status==='succeeded'&&matchesNodeJob(reference,job,doc.projectId))).reverse();
    for(const job of matches)for(const output of job.outputs||[]){const url=safeURL(output.url);if(url&&(/^(image(?:\/.*)?|png|jpe?g|webp|gif|avif)$/.test(String(output.outputType||'').toLowerCase())||/\.(png|jpe?g|webp|gif|avif)(?:\?|$)/i.test(url)))return url;}
    return '';
  }
  const stamp=value=>typeof value==='number'?value:Date.parse(value)||0;
  const orderedJobs=jobs=>(jobs||[]).slice().sort((a,b)=>stamp(a.createdAt)-stamp(b.createdAt));
  const characterFor=(doc,item)=>(doc.characterAssets||[]).find(asset=>asset.id===item.assetId||asset.nodeId===item.id);
  function nodeBlocker(item,doc,jobs){
    const missing=(item.characterAssetIds||[]).map(id=>(doc.characterAssets||[]).find(asset=>asset.id===id)).filter(asset=>!asset||asset.status!=='ready'||!safeURL(asset.referenceUrl));
    if(missing.length)return '先确认人物定妆：'+missing.map(asset=>asset?.name||'缺失的角色').join('、');
    if(item.referenceNodeId&&!referenceImage(item,doc,jobs))return '参考图片尚未生成；先生成本镜图片，再以该图生成视频';
    return '';
  }
  function horizontalPositions(nodes){
    const positions={},characters=nodes.filter(item=>item.nodeKind==='character');let x=0;
    for(const item of characters){positions[item.id]={x,y:0};x+=340;}
    if(characters.length)x+=80;
    for(const group of sceneGroups(nodes)){
      group.nodes.forEach((item,index)=>{positions[item.id]={x:x+Math.floor(index/2)*330,y:item.mediaKind==='video'?440:0};});
      x+=Math.max(1,Math.ceil(group.nodes.length/2))*340;
    }
    for(const item of nodes)if(!positions[item.id]){positions[item.id]={x,y:0};x+=340;}
    return positions;
  }
  function progressSummary(nodes,jobs,projectId){
    const latest=nodes.map(item=>orderedJobs((jobs||[]).filter(job=>matchesNodeJob(item,job,projectId))).at(-1)).filter(Boolean);
    return {total:latest.length,active:latest.filter(job=>['submitting','queued','running'].includes(job.status)).length,succeeded:latest.filter(job=>job.status==='succeeded').length,failed:latest.filter(job=>['failed','unknown'].includes(job.status)).length,latest:orderedJobs(latest).at(-1)};
  }
  function prepareNode(node,model,doc,jobs,Runtime){
    if(!Runtime.modelAvailable(model))throw new Error(model?.disabledReason||'请选择可用模型');
    const blocker=nodeBlocker(node,doc,jobs);if(blocker)throw new Error(blocker);
    const values=parameterValues(node),target=promptTarget(node,model);
    if(node.mediaKind==='image'&&node.characterAssetIds?.length){const assets=node.characterAssetIds.map(id=>doc.characterAssets.find(asset=>asset.id===id));if(!model.fields.some(field=>field.name==='imageUrls'))throw new Error('当前模型不支持人物参考图，请选择图生图模型');values.imageUrls=[...new Set(assets.map(asset=>safeURL(asset.referenceUrl)))];}
    if(target)values[target]=combinedPrompt(node);
    if(node.referenceNodeId){
      const url=referenceImage(node,doc,jobs);
      if(!url)throw new Error('参考图片尚未生成成功，请先生成关联图片');
      const field=model.fields.find(field=>['firstFrameUrl','imageUrl','imageUrls'].includes(field.name));
      if(field)values[field.name]=field.name==='imageUrls'?[url]:url;
    }
    return Runtime.modelParameters(model,values);
  }
  function fitViewport(nodes,width,height){
    if(!nodes.length)return {x:50,y:50,scale:1};
    const points=nodes.map((node,index)=>node.position||{x:(index%4)*330,y:Math.floor(index/4)*330});
    const minX=Math.min(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxX=Math.max(...points.map(p=>p.x))+286,maxY=Math.max(...points.map(p=>p.y))+360;
    const scale=Math.min(1,Math.max(.18,Math.min((width-100)/(maxX-minX),(height-100)/(maxY-minY))));
    return {x:(width-(maxX-minX)*scale)/2-minX*scale,y:(height-(maxY-minY)*scale)/2-minY*scale,scale};
  }
  const statusLabel=status=>({draft:'待生成',queued:'排队中',submitting:'提交中',running:'生成中',succeeded:'已返回',failed:'失败',unknown:'待确认',cancelled:'已取消',stopped:'已停止',skipped:'未提交'})[status]||'待生成';
  function visibleCanvasNodes(nodes,runtime,projectId){return (nodes||[]).filter(item=>!runtime?.isDeleted?.('canvas_node',item.id,projectId));}
  function trashTargets(doc,ids){const wanted=new Set(ids);return (doc?.nodes||[]).filter(item=>wanted.has(item.id)).map(item=>({kind:'canvas_node',targetId:item.id,projectId:doc.projectId}));}
  function create(options={}){
    const runtime=options.runtime,V=options.views,Runtime=global.StudioRuntime,entries=new Map();
    let current=null,focusRequest=null;
    const models=()=>runtime?.media?.providers?.find(provider=>provider.id==='runninghub')?.models||[];
    const provider=()=>runtime?.media?.providers?.find(provider=>provider.id==='runninghub');
    const findModel=node=>models().find(model=>modelId(model)===node.modelId);
    const path=entry=>'/api/projects/'+encodeURIComponent(entry.project.id)+'/canvas';
    function readUI(id){try{return JSON.parse(window.StudioCloud.localStorage?.getItem('dream-studio-canvas-ui:'+id)||'{}');}catch{return {};}}
    function saveUI(entry){try{window.StudioCloud.localStorage?.setItem('dream-studio-canvas-ui:'+entry.project.id+(entry.mode==='assets'?':assets':''),JSON.stringify(entry.ui));}catch{}}
    function selected(entry){return entry.doc?selectedNodes(entry):[];}
    function node(entry,id=entry.ui.activeId){return entry.doc?.nodes?.find(item=>item.id===id);}
    function notifyError(entry,error){entry.error=error?.message||String(error);renderNotice(entry);}
    function touch(entry,{render=true,execution=true}={}){
      registerChange(entry,execution);entry.error='';entry.saveError='';entry.notice='';
      global.clearTimeout(entry.saveTimer);entry.saveTimer=global.setTimeout(()=>save(entry).catch(()=>{}),650);
      if(render){renderNodes(entry);renderBatch(entry);}renderNotice(entry);
    }
    function draftPayload(entry){return {expectedRevision:entry.doc.revision,nodes:entry.doc.nodes.map(item=>{const value=clone(item);for(const key of ['status','error','jobIds','outputs','textOutputs','lastJobId','stale','validationError'])delete value[key];return value;}),viewport:clone(entry.doc.viewport)};}
    function mergeDocument(entry,response,keepLocal=false){
      const value=clone(response.canvas||response);
      if(value.projectId!==entry.project.id||!Array.isArray(value.nodes))throw new Error('画布项目不匹配，请重新打开项目');
      if(entry.doc&&Number(value.revision)<Number(entry.doc.revision))return false;
      value.nodes=visibleCanvasNodes(value.nodes,runtime,entry.project.id);
      if(entry.doc)entry.doc.nodes=visibleCanvasNodes(entry.doc.nodes,runtime,entry.project.id);
      if(keepLocal&&entry.doc)entry.doc={...value,nodes:mergeLocalNodes(entry.doc.nodes,value.nodes,entry.syncedNodes,entryNodes(entry).map(item=>item.id)),viewport:entry.mode==='assets'?value.viewport:entry.doc.viewport};
      else entry.doc=value;
      entry.syncedNodes=clone(value.nodes);
      entry.doc.viewport={x:30,y:30,scale:.85,...entry.doc.viewport};
      for(const item of entry.doc.nodes)if(item.optimization?.requestId)entry.optimizing.set(item.id,item.optimization);
      if(!entryNodes(entry).some(item=>item.id===entry.ui.activeId))entry.ui.activeId=entryNodes(entry)[0]?.id||'';
    }
    async function save(entry){
      global.clearTimeout(entry.saveTimer);
      if(entry.saving){await entry.saving;if(entry.savedVersion<entry.version)return save(entry);return;}
      if(!entry.doc||entry.savedVersion===entry.version)return;
      const version=entry.version,payload=draftPayload(entry);entry.saveError='';
      entry.saving=(async()=>{try{const response=await runtime.request(path(entry),payload);mergeDocument(entry,response,entry.version!==version);entry.savedVersion=version;}catch(error){entry.saveError=error.message;throw error;}finally{entry.saving=null;renderNotice(entry);}})();
      renderNotice(entry);await entry.saving;
      if(entry.savedVersion<entry.version)return save(entry);
    }
    async function load(entry,force=false){
      if(entry.loading)return entry.loading;
      if(entry.doc&&!force)return;
      const readVersion=entry.version;
      entry.loading=(async()=>{try{const response=await runtime.request(path(entry));const merged=mergeDocument(entry,response,entry.version!==entry.savedVersion||entry.version!==readVersion);if(merged===false)return;entry.error='';renderAll(entry,editorContextMatches(entry,entry.host.querySelector('[data-canvas-editor]')?.dataset.editorNodeId)&&entry.host.querySelector('[data-canvas-editor]')?.contains(global.document.activeElement));if(!entry.initialSceneFramed){entry.initialSceneFramed=true;const asset=entry.doc.nodes.find(item=>item.nodeKind==='character');const first=sceneGroups(entry.doc.nodes)[0];if(entry.mode!=='assets'&&!entry.ui.sceneVisited&&first)focusScene(entry,first.id);}if(focusRequest?.projectId===entry.project.id){focusNode(entry,focusRequest);focusRequest=null;}schedulePoll(entry);}catch(error){notifyError(entry,error);}finally{entry.loading=null;renderNotice(entry);}})();renderNotice(entry);return entry.loading;
    }
    async function trashNodes(entry,ids){
      if(entry.busy||!entry.doc)return;
      const targets=trashTargets(entry.doc,ids);if(!targets.length)return;
      if(!runtime?.trashItems){notifyError(entry,new Error('删除服务尚未就绪，请刷新工作台后重试。'));return;}
      entry.busy='delete';entry.quote=null;entry.notice='';entry.error='';
      const zones=[...entry.host.querySelectorAll('.canvas-toolbar,.canvas-workspace,.canvas-batch-bar')];
      zones.forEach(zone=>{zone.inert=true;});renderBatch(entry);renderNotice(entry);
      try{
        await save(entry);
        await runtime.trashItems(targets);
        entry.doc.nodes=visibleCanvasNodes(entry.doc.nodes,runtime,entry.project.id);
        if(entry.loading)await entry.loading;
        await load(entry,true);
        entry.notice='已将 '+targets.length+' 个节点移入回收站，可随时恢复。';
      }catch(error){notifyError(entry,error);}
      finally{entry.busy='';zones.forEach(zone=>{zone.inert=false;});renderAll(entry);}
    }
    function shell(entry){
      return '<header class="canvas-toolbar"><div class="canvas-title"><span class="canvas-title-icon">⌘</span><div><strong>创作画布</strong><small>'+esc(entry.project.title)+'</small></div></div><div class="canvas-tools"><button type="button" data-action="project-tab" data-id="characters">人物资产表</button><button type="button" data-canvas-action="add-image">＋ 图片</button><button type="button" data-canvas-action="add-video">＋ 视频</button><span class="canvas-tool-divider"></span><button type="button" data-canvas-action="arrange-horizontal">横向排列</button><button type="button" data-canvas-action="fit">全览</button><button type="button" data-canvas-action="zoom-out" aria-label="缩小画布">−</button><span data-canvas-zoom>100%</span><button type="button" data-canvas-action="zoom-in" aria-label="放大画布">＋</button><button type="button" data-canvas-action="toggle-chat">团队对话</button><button type="button" data-canvas-action="toggle-editor">提示词</button><button type="button" data-canvas-action="open-trash">回收站</button><button type="button" data-canvas-action="toggle-focus" aria-pressed="false" title="铺满当前窗口，按 Escape 退出">专注画布 ↗</button></div></header><div class="canvas-notice" data-canvas-notice role="status"></div><div class="canvas-pipeline" data-canvas-pipeline></div><nav class="canvas-scene-nav" data-canvas-scenes aria-label="分镜导航"></nav><section class="canvas-progress" data-canvas-progress aria-live="polite"></section><div class="canvas-workspace"><div class="canvas-viewport" data-canvas-viewport tabindex="0" aria-label="创作画布，拖动空白处平移，按住 Control 或 Command 滚轮缩放"><div class="canvas-world" data-canvas-world><div class="canvas-scene-groups" data-canvas-groups></div><svg class="canvas-links" data-canvas-links aria-hidden="true"></svg><div data-canvas-nodes></div></div><div class="canvas-empty" data-canvas-empty hidden></div><div class="canvas-navigation-help">镜头从左向右排列 · 拖动空白处平移 · Ctrl / ⌘ + 滚轮缩放</div></div><aside class="canvas-editor" data-canvas-editor aria-label="节点参数编辑器"></aside><aside class="canvas-chat" data-canvas-chat hidden aria-label="画布团队对话"></aside></div><footer class="canvas-batch-bar" data-canvas-batch></footer><section class="canvas-batch-history" data-canvas-history></section>';
    }
    function assetShell(entry){
      return '<header class="character-page-header"><div><small>人物先行 · 分镜之前</small><h2>人物资产</h2><p>先把人物长相、发型和服装定下来，确认后自动供所有分镜复用。</p></div><div class="character-page-actions"><button type="button" data-canvas-action="add-character">＋ 新建人物</button><button type="button" data-canvas-action="refresh-progress">刷新状态</button><button type="button" data-action="project-tab" data-id="canvas">查看现有画布</button></div></header><div class="canvas-notice" data-canvas-notice role="status"></div><div class="character-page-summary" data-canvas-pipeline></div><section class="canvas-progress" data-canvas-progress aria-live="polite"></section><div class="character-page-workspace"><div class="character-table-wrap" data-character-table></div><aside class="canvas-editor" data-canvas-editor aria-label="人物设定编辑器"></aside></div><footer class="canvas-batch-bar" data-canvas-batch></footer><section class="canvas-batch-history" data-canvas-history></section>';
    }
    function renderAssetRows(entry){
      const rows=currentCharacterAssets(entry.doc),host=entry.host.querySelector('[data-character-table]');
      const markup=rows.length?'<table class="character-assets-table"><thead><tr><th>人物名字与介绍</th><th>定妆预览</th><th>状态与生成方案</th><th>操作</th></tr></thead><tbody>'+rows.map(asset=>{
        const item=node(entry,asset.nodeId);if(!item)return '';
        const jobs=nodeJobs(entry,item),job=jobs.at(-1),success=jobs.find(job=>job.id===asset.reviewCandidate?.jobId),outputs=asset.reviewCandidate&&safeURL(asset.reviewCandidate.url)?[{url:asset.reviewCandidate.url,index:asset.reviewCandidate.outputIndex}]:[],url=safeURL(asset.reviewCandidate?.url||asset.referenceUrl),busy=['queued','running','submitting','unknown'].includes(job?.status),model=findModel(item),available=Runtime.modelAvailable(model),modelChanged=Boolean(job?.modelId&&job.modelId!==item.modelId),label=asset.status==='ready'?'定妆已采用':busy?statusLabel(job.status):asset.status==='pending_review'?'图片已返回 · 待采用':asset.status==='stale'?'设定已改 · 需更新':job?.status==='failed'?(modelChanged?'模型已更新 · 待生成':'生成失败'):'待生成定妆';
        return '<tr data-character-row="'+esc(item.id)+'" class="'+(entry.ui.activeId===item.id?'is-active':'')+'"><td><label class="character-row-name"><input type="checkbox" data-canvas-select="'+esc(item.id)+'"'+(item.selected?' checked':'')+' aria-label="选择'+esc(asset.name)+'定妆"><strong>'+esc(asset.name)+'</strong></label><span class="character-source-label">'+(asset.sourceNature==='placeholder'?'占位人物 · 沿用当前稿设定':'作品人物')+'</span><p class="character-description">'+esc(characterSummary(asset))+'</p></td><td><div class="character-preview">'+(url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer"><img src="'+esc(url)+'" alt="'+esc(asset.name)+'定妆结果" loading="lazy" referrerpolicy="no-referrer"></a>':'<span>定妆图将在这里展示</span>')+'</div>'+(asset.status==='pending_review'?outputs.map(output=>'<button type="button" class="character-adopt" data-canvas-action="confirm-character" data-asset-id="'+esc(asset.id)+'" data-job-id="'+esc(asset.reviewCandidate.jobId)+'" data-output-index="'+output.index+'">采用'+(outputs.length>1?'第 '+(output.index+1)+' 张':'这张定妆')+'</button>').join(''):'')+'</td><td><span class="character-state is-'+esc(asset.status)+'">'+esc(label)+'</span><p class="character-model">'+esc(modelSummary(item,model))+'</p>'+(!available?'<p class="canvas-error">'+esc(model?.disabledReason||'模型信息尚未就绪')+'</p>':'')+(job?.error?(modelChanged?'<details><summary>上次失败记录 · 旧模型</summary><p class="canvas-error">':'<p class="canvas-error">')+esc(typeof job.error==='string'?job.error:JSON.stringify(job.error))+'</p>'+(modelChanged?'</details>':''):'')+(asset.status==='ready'?'<p class="character-ready">已绑定参考 · 版本 '+esc(asset.version)+'</p>':'')+'</td><td><div class="character-row-actions"><button type="button" data-canvas-action="generate-node" data-node-id="'+esc(item.id)+'"'+(busy||entry.busy||!available?' disabled':'')+'>'+(url?'重新生成':'生成定妆')+'</button><button type="button" data-canvas-action="select-node" data-node-id="'+esc(item.id)+'">画质 / 风格</button><button type="button" data-canvas-action="edit-prompt" data-node-id="'+esc(item.id)+'">提示词编辑</button><button type="button" data-canvas-action="asset-optimize" data-node-id="'+esc(item.id)+'">美术优化</button><button type="button" class="character-remove" data-canvas-action="remove-node" data-node-id="'+esc(item.id)+'">删除</button></div></td></tr>';
      }).join('')+'</tbody></table>':'<div class="character-list-empty"><h3>还没有人物资产</h3><p>确认美术设定后会自动整理人物，也可以添加需要锁定造型的角色。纯场景项目可直接进入分镜。</p><button type="button" data-canvas-action="add-character">＋ 新建人物</button></div>';
      if(host._markup!==markup){host.innerHTML=markup;host._markup=markup;}
    }
    function mount(host,project,mode='canvas'){
      if(!host||!project||project.isDemo)return;
      const entryKey=project.id+(mode==='assets'?':assets':'');let entry=entries.get(entryKey);
      if(!entry){entry={project,host,mode,ui:{budget:'',activeId:'',...readUI(entryKey),...(readUI(entryKey).workflowVersion===4?{}:{editorOpen:false,chatOpen:mode!=='assets',sceneVisited:'',workflowVersion:4})},doc:null,version:0,executionVersion:0,savedVersion:0,quote:null,error:'',saveError:'',busy:'',loading:null,saving:null,saveTimer:null,pollTimer:null,optimizing:new Map(),modelDrafts:new Map()};entries.set(entryKey,entry);host.innerHTML=mode==='assets'?assetShell(entry):shell(entry);bind(entry);}
      else if(host!==entry.host){host.replaceWith(entry.host);entry.project=project;}
      if(entry.editorDialog)restorePromptDialogModal(entry.editorDialog,entry.dialogView);
      current=entry;entry.host.classList.toggle('editor-collapsed',!entry.ui.editorOpen);renderConversation(entry);
      if(entry.mode!=='assets'&&entry.focused==null)setFocus(entry,entry.ui.preferredFocus!==false);
      if(!entry.doc)load(entry);else{update(entry);load(entry,true);schedulePoll(entry);if(focusRequest?.projectId===project.id){focusNode(entry,focusRequest);focusRequest=null;}}
    }
    function setTransform(entry){if(!entry.doc||entry.mode==='assets')return;const viewport=entry.doc.viewport,world=entry.host.querySelector('[data-canvas-world]'),surface=entry.host.querySelector('[data-canvas-viewport]');world.style.transform='translate('+viewport.x+'px,'+viewport.y+'px) scale('+viewport.scale+')';surface.style.backgroundPosition=viewport.x+'px '+viewport.y+'px';surface.style.backgroundSize=(24*viewport.scale)+'px '+(24*viewport.scale)+'px';entry.host.querySelector('[data-canvas-zoom]').textContent=Math.round(viewport.scale*100)+'%';}
    function renderNotice(entry){
      const element=entry.host.querySelector('[data-canvas-notice]');if(!element)return;
      const confirmed=entry.doc?.storyboard?.confirmed,warning=entry.doc&&!confirmed?'文稿尚未全部确认；可先编辑画布，确认后会自动导入正式分镜。':'';
      element.innerHTML=entry.saveError?'<span class="canvas-error">画布未保存：'+esc(entry.saveError)+'</span><button type="button" data-canvas-action="retry-save">重试保存</button>':entry.error?'<span class="canvas-error">'+esc(entry.error)+'</span>':entry.busy==='delete'?'<span>正在移入回收站…</span>':entry.notice?'<span>'+esc(entry.notice)+'</span>':entry.loading?'<span>正在读取项目画布…</span>':entry.saving?'<span>正在保存画布…</span>':warning?'<span>'+warning+'</span>':'<span>'+(!entry.doc?'准备创作画布':entry.version!==entry.savedVersion?'修改待保存':(entry.mode==='assets'?'人物资产已保存到云端':'画布已保存到云端'))+'</span>';
      element.classList.toggle('has-error',Boolean(entry.error||entry.saveError));
      const status=entry.host.querySelector('[data-prompt-save-status]');if(status){status.textContent=entry.saveError?'保存失败：'+entry.saveError:entry.saving?'正在保存修改…':entry.version!==entry.savedVersion?'正在保存修改…':'修改已保存到云端';status.classList.toggle('canvas-error',Boolean(entry.saveError));}
    }
    function nodeJobs(entry,item){return orderedJobs((runtime?.media?.jobs||[]).filter(job=>matchesNodeJob(item,job,entry.project.id)));}
    function renderNodes(entry){
      if(!entry.doc)return;if(entry.mode==='assets'){renderAssetRows(entry);return;}
      const visible=productionNodes(entry.doc.nodes),container=entry.host.querySelector('[data-canvas-nodes]'),ids=new Set(visible.map(item=>item.id));
      for(const element of container.children)if(!ids.has(element.dataset.canvasNode))element.remove();
      for(const [index,item] of visible.entries()){
        const position=item.position||{x:(index%4)*330,y:Math.floor(index/4)*340};item.position=position;
        let element=[...container.children].find(element=>element.dataset.canvasNode===item.id);
        if(!element){element=global.document.createElement('article');element.className='canvas-node';element.dataset.canvasNode=item.id;container.append(element);}
        const jobs=nodeJobs(entry,item),job=jobs.at(-1),asset=characterFor(entry.doc,item),success=jobs.slice().reverse().find(job=>job.status==='succeeded'&&(job.outputs||[]).some(output=>safeURL(output.url))),output=(asset?.status==='ready'&&safeURL(asset.referenceUrl)?{url:asset.referenceUrl,outputType:'image'}:success?.outputs?.find(output=>safeURL(output.url))),state=job?.status||item.status||'draft',blocker=nodeBlocker(item,entry.doc,runtime.media.jobs),error=item.validationError||item.error||job?.error;
        const url=safeURL(output?.url),video=url&&(item.mediaKind==='video'||/^(video|mp4|webm)/.test(output?.outputType||'')),label=item.nodeKind==='character'?'定妆图':item.mediaKind==='video'?'视频':'图片';
        const media=url?(video?'<video src="'+esc(url)+'" controls preload="metadata" playsinline aria-label="'+esc(item.title||item.shotId)+'视频结果"></video>':'<img src="'+esc(url)+'" loading="lazy" decoding="async" alt="'+esc(item.title||item.shotId)+'图片结果" referrerpolicy="no-referrer">'):'<div class="canvas-node-placeholder"><span>'+ (item.mediaKind==='video'?'▷':'▧')+'</span><small>'+esc(state==='running'?'正在生成…':state==='queued'?'等待服务商处理':'等待生成'+label)+'</small></div>';
        const markup='<header class="canvas-node-header" data-drag-node="'+esc(item.id)+'"><label class="canvas-node-select"><input type="checkbox" data-canvas-select="'+esc(item.id)+'"'+(item.selected?' checked':'')+' aria-label="选择'+esc(item.shotId||item.title||label)+' '+label+'加入批次"></label><button type="button" data-canvas-action="select-node" data-node-id="'+esc(item.id)+'"><small>'+esc(item.shotId||(asset?'人物定妆':'自由素材'))+' · '+label+(item.nodeKind==='character'?(asset?.sourceNature==='placeholder'?' · 占位人物':' · 人物资产'):'')+(item.stale?' · 旧源稿':'')+'</small><strong>'+esc(item.title||label)+'</strong></button><span class="canvas-node-status is-'+esc(state)+'">'+esc(asset?.status==='ready'?'定妆已确认':asset?.status==='stale'?'定妆需更新':asset?.status==='pending_review'?'待确认定妆':statusLabel(state))+'</span><button type="button" class="canvas-node-delete" data-canvas-action="remove-node" data-node-id="'+esc(item.id)+'" aria-label="删除'+esc(item.shotId||item.title||label)+' '+label+'节点" title="删除节点，可在回收站恢复"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button></header><div class="canvas-node-media">'+media+'</div><div class="canvas-node-copy"><p>'+esc(item.prompt||'点击编辑提示词与模型参数')+'</p><span>'+esc(modelSummary(item,findModel(item)))+'</span></div><div class="canvas-node-actions"><button type="button" data-canvas-action="select-node" data-node-id="'+esc(item.id)+'">画质 / 风格 / 提示词</button><button type="button" data-canvas-action="generate-node" data-node-id="'+esc(item.id)+'"'+(entry.busy||['queued','running','submitting','unknown'].includes(state)?' disabled':'')+'>生成'+label+'</button></div>'+(asset&&success&&asset.status==='pending_review'?'<button type="button" class="canvas-confirm-character" data-canvas-action="confirm-character" data-asset-id="'+esc(asset.id)+'" data-job-id="'+esc(success.id)+'" data-output-index="'+success.outputs.indexOf(output)+'">确认这张作为人物定妆</button>':'')+(asset?.status==='ready'?'<p class="canvas-asset-ready">已锁定参考 · 后续分镜自动引用</p>':'')+(blocker?'<p class="canvas-node-blocker">'+esc(blocker)+'</p>':'')+(url?'<a class="canvas-output-link" href="'+esc(video&&success?'/assets/media-preview.html?job='+encodeURIComponent(success.id):url)+'" target="_blank" rel="noopener noreferrer">打开'+(video?'视频':'图片')+'原片 ↗</a>':'')+(error&&error!==blocker?'<p class="canvas-node-error">'+esc(typeof error==='string'?error:JSON.stringify(error))+'</p>':'');
        if(element._markup!==markup){const previousVideo=element.querySelector('video'),time=previousVideo?.currentTime||0,playing=previousVideo&&!previousVideo.paused,src=previousVideo?.getAttribute('src');element.innerHTML=markup;element._markup=markup;const next=element.querySelector('video');if(next&&src===next.getAttribute('src')){next.currentTime=time;if(playing)next.play().catch(()=>{});}}
        element.style.transform='translate('+position.x+'px,'+position.y+'px)';element.classList.toggle('is-active',entry.ui.activeId===item.id);element.classList.toggle('is-selected',Boolean(item.selected));
      }
      const empty=entry.host.querySelector('[data-canvas-empty]');empty.hidden=Boolean(visible.length);empty.innerHTML='<span>你的画面，从一张卡片开始</span><p>确认团队文稿后，分镜会自动落到这里。也可以先新增图片或视频节点。</p><button type="button" data-canvas-action="add-image">＋ 新建图片节点</button>';
      renderScenes(entry);renderLinks(entry);setTransform(entry);
    }
    function renderScenes(entry){
      const groups=sceneGroups(entry.doc.nodes),nav=entry.host.querySelector('[data-canvas-scenes]');
      const currentGroup=groups.find(group=>group.nodes.some(item=>item.id===entry.ui.activeId));
      const characters=entry.doc.nodes.filter(item=>item.nodeKind==='character');
      const markup='<div class="canvas-scene-count"><strong>'+groups.length+' 镜</strong><span>'+characters.length+' 人物 · '+entry.doc.nodes.filter(item=>item.mediaKind==='image'&&item.nodeKind!=='character').length+' 镜头图 · '+entry.doc.nodes.filter(item=>item.mediaKind==='video').length+' 视频</span></div><div class="canvas-scene-tabs">'+[].map(item=>'<button type="button" data-canvas-action="focus-card" data-node-id="'+esc(item.id)+'" aria-pressed="'+String(entry.ui.activeId===item.id)+'"><span>人物</span>'+esc(characterFor(entry.doc,item)?.name||item.title)+'</button>').join('')+groups.map((group,index)=>'<button type="button" data-canvas-action="focus-scene" data-scene-id="'+esc(group.id)+'" aria-pressed="'+String(currentGroup?.id===group.id)+'" title="'+esc(group.title)+'"><span>'+String(index+1).padStart(2,'0')+'</span>'+esc(group.title.replace(new RegExp('^'+group.shotId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*[·/／-]?\\s*'),''))+'</button>').join('')+'</div>';
      if(nav._markup!==markup){nav.innerHTML=markup;nav._markup=markup;}
      entry.host.querySelector('[data-canvas-groups]').innerHTML=groups.map(group=>{
        const points=group.nodes.map(item=>item.position||{x:0,y:0}),x=Math.min(...points.map(p=>p.x))-14,y=Math.min(...points.map(p=>p.y))-42;
        const width=Math.max(...points.map(p=>p.x))-x+300,height=Math.max(...points.map(p=>p.y))-y+360;
        return '<div class="canvas-scene-group" style="transform:translate('+x+'px,'+y+'px);width:'+width+'px;height:'+height+'px"><strong>'+esc(group.title)+'</strong></div>';
      }).join('');
    }
    function focusScene(entry,id){
      const group=sceneGroups(entry.doc.nodes).find(item=>item.id===id);if(!group)return;
      entry.ui.activeId=group.nodes[0].id;entry.ui.sceneVisited=id;saveUI(entry);
      const rect=entry.host.querySelector('[data-canvas-viewport]').getBoundingClientRect();
      entry.doc.viewport=fitViewport([group.nodes.find(item=>item.mediaKind===(entry.ui.stage==='videos'?'video':'image'))||group.nodes[0]],rect.width,rect.height);
      renderNodes(entry);renderEditor(entry);touch(entry,{render:false,execution:false});
    }
    function renderLinks(entry){
      const svg=entry.host.querySelector('[data-canvas-links]');svg.innerHTML=entry.doc.nodes.filter(item=>item.mediaKind==='video').map(item=>{const from=entry.doc.nodes.find(candidate=>candidate.id===item.referenceNodeId)||entry.doc.nodes.find(candidate=>candidate.mediaKind==='image'&&candidate.shotId&&candidate.shotId===item.shotId&&candidate.sourceArtifactId===item.sourceArtifactId);if(!from?.position||!item.position)return '';const vertical=Math.abs(item.position.y-from.position.y)>Math.abs(item.position.x-from.position.x),a={x:from.position.x+(vertical?143:286),y:from.position.y+(vertical?350:140)},b={x:item.position.x+(vertical?143:0),y:item.position.y+(vertical?0:140)},bend=Math.max(40,Math.abs(vertical?b.y-a.y:b.x-a.x)/2),curve=vertical?' C '+a.x+' '+(a.y+bend)+' '+b.x+' '+(b.y-bend)+' '+b.x+' '+b.y:' C '+(a.x+bend)+' '+a.y+' '+(b.x-bend)+' '+b.y+' '+b.x+' '+b.y;return '<path d="M '+a.x+' '+a.y+curve+'"'+(item.referenceNodeId?' class="is-reference"':'')+'/>';}).join('');
    }
    function quickParameterModel(model,item){
      if(!model)return null;
      const labels={resolution:'分辨率',size:'输出尺寸',width:'宽度 · 像素',height:'高度 · 像素',duration:'视频时长 · 秒',durationSeconds:'视频时长 · 秒',aspectRatio:'画面比例',ratio:'画面比例',quality:'生成质量',generateAudio:'生成声音',bitrateMode:'视频码率',draft:'草稿模式 · 仅 480p'};
      return {...model,fields:model.fields.filter(field=>Controls.quickFieldNames(model).includes(field.name)&&!(item?.mediaKind==='image'&&(['width','height'].includes(field.name)||(Controls.imageAspectOptions(item,model).length&&['aspectRatio','ratio'].includes(field.name))))).map(field=>{
        const result={...field,label:labels[field.name]||field.label,description:'',schema:{...field.schema,description:''}};
        if(field.name==='resolution'&&field.options)result.options=field.options.map(option=>{const value=typeof option==='object'?option.value:option;return {value,label:Controls.resolutionLabel(value,model)};});
        if(field.name==='ratio'&&field.options?.length===1&&field.options[0]==='adaptive')result.options=[{value:'adaptive',label:'跟随首帧图片'}];
        if(field.name==='duration'&&field.options)result.options=field.options.map(option=>({value:option,label:String(option)==='-1'?'由模型决定':option+' 秒'}));
        if(field.name==='bitrateMode'&&field.options)result.options=field.options.map(value=>({value,label:({standard:'标准码率',high:'高码率'})[value]||value}));
        return result;
      })};
    }
    function qualityMarkup(entry,item,model,values){
      const presets=Controls.imageSizePresets(item,model),aspects=Controls.imageAspectOptions(item,model);
      const currentAspect=Controls.currentImageAspect(item,model),currentTier=Controls.currentImageSizeTier(item,model);
      const quick=quickParameterModel(model,item),names=quick?.fields||[];
      const aspectControl=aspects.length?'<label class="field-label">画面比例<select class="select" data-canvas-aspect>'+(!aspects.some(option=>option.value===currentAspect)?'<option value="custom" selected disabled>自定义比例</option>':'')+aspects.map(option=>'<option value="'+esc(option.value)+'"'+(currentAspect===option.value?' selected':'')+'>'+esc(option.label)+'</option>').join('')+'</select></label>':'';
      const sizeControl=presets.length?'<label class="field-label">清晰度<select class="select" data-canvas-size>'+(!presets.some(preset=>preset.id===currentTier)?'<option value="custom" selected disabled>自定义清晰度</option>':'')+presets.map(preset=>'<option value="'+esc(preset.id)+'"'+(currentTier===preset.id?' selected':'')+'>'+esc(preset.label)+'</option>').join('')+'</select></label>':'';
      return '<section class="canvas-quality" aria-label="画质与费用设置"><div class="canvas-section-title"><strong>画质与费用</strong><span>'+esc(item.mediaKind==='video'?'视频规格':'图片规格')+'</span></div>'+((aspectControl||sizeControl)?'<div class="canvas-simple-specs">'+aspectControl+sizeControl+'</div>':'')+'<div class="canvas-quick-parameters" data-canvas-parameters>'+V.mediaModelFields(quick,values)+'</div>'+(!names.length&&!aspects.length&&!presets.length?'<p>此模型未开放可调整的画质参数，可在下方更换模型。</p>':'')+'<p class="canvas-quality-note">先用较低清晰度试效果，满意后再提高。实际费用以生成前报价为准。</p><button type="button" class="canvas-apply-settings" data-canvas-action="apply-settings" data-settings-kind="quality">将画质应用到已勾选的同模型'+(item.mediaKind==='video'?'视频':'图片')+'</button><span class="canvas-apply-feedback" data-settings-feedback="quality" role="status"></span></section>';
    }
    function styleMarkup(item){
      const current=styles.find(style=>style.id===(item.stylePreset||'original'))||styles[0],groups=[...new Set(styles.map(style=>style.group||'其他'))];
      return '<section class="canvas-style-library" aria-label="风格库"><div class="canvas-section-title"><strong>风格库</strong><span>'+styles.filter(style=>style.id!=='original').length+' 种风格</span></div><label class="field-label">选择视觉风格<select class="select" data-canvas-field="stylePreset">'+groups.map(group=>'<optgroup label="'+esc(group)+'">'+styles.filter(style=>(style.group||'其他')===group).map(style=>'<option value="'+esc(style.id)+'"'+(current.id===style.id?' selected':'')+'>'+esc(style.name)+'</option>').join('')+'</optgroup>').join('')+'</select></label><p class="canvas-style-description">'+esc(current.description||current.prompt||'沿用已有提示词与人物设定。')+'</p><div class="canvas-style-shortcuts">'+['original','cute3d','anime','cinematic','ink','clay'].map(id=>{const style=styles.find(style=>style.id===id);return '<button type="button" data-canvas-action="choose-style" data-style-id="'+esc(id)+'" aria-pressed="'+String(current.id===id)+'">'+esc(style.name)+'</button>';}).join('')+'</div><button type="button" class="canvas-apply-settings" data-canvas-action="apply-settings" data-settings-kind="style">将风格应用到已勾选的'+(item.mediaKind==='video'?'视频':'图片')+'</button><span class="canvas-apply-feedback" data-settings-feedback="style" role="status"></span><p class="canvas-quality-note">可继续在提示词中补充风格细节；人物定妆与后续镜头请保持一致。</p></section>';
    }
    function renderEditor(entry,force=false){
      const item=node(entry),editor=entry.host.querySelector('[data-canvas-editor]');
      if(entry.editorDialog?.open&&editor.dataset.editorNodeId===item?.id&&!force){renderDialogPreview(entry);return;}
      if(entry.editorDialog?.open&&editor.dataset.editorNodeId!==item?.id)closeEditorDialog(entry);
      rememberEditorDraft(entry);editor.dataset.editorNodeId=item?.id||'';entry.host.classList.toggle('editor-collapsed',!entry.ui.editorOpen);
      if(!item){editor.innerHTML='<div class="canvas-editor-empty">选择一个节点，编辑提示词与生成参数。</div>';return;}
      const model=findModel(item),target=promptTarget(item,model),type=item.mediaKind==='video'?'视频':'图片',choices=models().filter(model=>model.mediaKind===item.mediaKind&&Runtime.modelAvailable(model)),filters=entry.filters||{},filtered=Runtime.filterMediaModels(choices,{kind:item.mediaKind,...filters});
      const quickNames=(quickParameterModel(model,item)?.fields||[]).map(field=>field.name),parameterModel=model?{...model,fields:model.fields.filter(field=>field.name!==target&&!quickNames.includes(field.name)&&!(/^seedream-v5-pro\//.test(item.modelId)&&field.name==='resolution'))}:null,values=parameterValues(item);if(/^seedream-v5-pro\//.test(item.modelId)&&values.width&&values.height&&!Object.hasOwn(values,'resolution'))values.resolution='';
      const candidates=(model?.fields||[]).filter(field=>field.type==='string'&&!field.options?.length&&!['https','uri','url'].includes(field.format));
      editor.innerHTML='<div class="canvas-editor-heading"><div><small>'+esc(item.shotId||(item.nodeKind==='character'?'人物资产':'自由素材'))+' · '+type+'</small><h3>'+esc(item.title||'编辑节点')+'</h3></div><button type="button" data-canvas-action="toggle-editor" aria-label="收起参数面板">›</button></div><div class="canvas-editor-scroll">'+qualityMarkup(entry,item,model,values)+styleMarkup(item)+'<div class="canvas-prompt-launchers"><button type="button" data-canvas-action="edit-prompt">提示词编辑 ↗</button><button type="button" data-canvas-action="asset-optimize">✧ 美术优化</button></div><label class="field-label canvas-node-name-field">'+esc(item.nodeKind==='character'?'人物名字 / 版本名称':'节点名称')+'<input class="field" data-canvas-field="title" maxlength="160" value="'+esc(item.title||'')+'"></label><section class="canvas-prompt-block"><label class="field-label"><span class="canvas-prompt-label"><span>'+esc(item.nodeKind==='character'?'人物定妆提示词':'画面与动作提示词')+'</span><button type="button" data-canvas-action="expand-prompt">放大编辑 ↗</button></span><textarea class="textarea canvas-prompt" data-canvas-field="prompt" rows="7" maxlength="20000" placeholder="描述这一个镜头…">'+esc(item.prompt||'')+'</textarea></label><div class="canvas-prompt-tools"><button type="button" data-canvas-action="open-ai">'+(item.nodeKind==='character'?'✧ 美术优化定妆':'✧ AI 优化提示词')+'</button><span>只修改画布草稿</span></div><div class="canvas-ai-panel" data-canvas-ai hidden></div><details class="canvas-combined-prompt"><summary>查看实际提交提示词</summary><pre data-canvas-combined>'+esc(combinedPrompt(item))+'</pre></details></section><div class="canvas-auto-config"><small>当前生成方案</small><strong data-canvas-current-config>'+esc(modelSummary(item,model))+'</strong><span>已按分镜填好，按需调整即可。</span></div><details class="canvas-advanced" data-canvas-advanced'+(entry.ui.advancedOpen?' open':'')+'><summary>高级设置 · 更换模型与参数</summary><div class="canvas-model-picker"><h4>生成模型</h4><input class="field" type="search" data-canvas-filter="query" value="'+esc(filters.query||'')+'" placeholder="搜索全能图片、可灵、Seedance…" aria-label="搜索生成模型"><div class="form-grid"><select class="select" data-canvas-filter="vendor" aria-label="按厂商筛选"><option value="">全部厂商 / 系列</option>'+[...new Set(choices.map(model=>model.vendor||model.family||'RunningHub'))].sort().map(value=>'<option value="'+esc(value)+'"'+(filters.vendor===value?' selected':'')+'>'+esc(value)+'</option>').join('')+'</select><select class="select" data-canvas-filter="category" aria-label="按用途筛选"><option value="">全部用途</option>'+[...new Set(choices.map(model=>model.category||model.capability||'其他'))].sort().map(value=>'<option value="'+esc(value)+'"'+(filters.category===value?' selected':'')+'>'+esc(V.mediaCategoryLabel(value))+'</option>').join('')+'</select></div><label class="field-label">模型与能力<select class="select" data-canvas-field="modelId" data-canvas-model-select>'+V.mediaModelOptions(filtered,item.modelId)+'</select></label><p class="small muted" data-canvas-model-count>'+filtered.filter(Runtime.modelAvailable).length+' 个可选接口</p></div>'+(candidates.length?'<label class="field-label">提示词写入字段<select class="select" data-canvas-field="promptField"><option value="">手动填写下方参数</option>'+candidates.map(field=>'<option value="'+esc(field.name)+'"'+(target===field.name?' selected':'')+'>'+esc(field.label||field.name)+' · '+esc(field.name)+'</option>').join('')+'</select></label>':'')+(item.mediaKind==='video'?'<label class="field-label">引用本画布图片<select class="select" data-canvas-field="referenceNodeId"><option value="">不引用，使用下方参数</option>'+(item.referenceNodeId&&!entry.doc.nodes.some(n=>n.id===item.referenceNodeId)?'<option value="'+esc(item.referenceNodeId)+'" selected disabled>参考图已在回收站</option>':'')+entry.doc.nodes.filter(candidate=>candidate.mediaKind==='image').map(candidate=>'<option value="'+esc(candidate.id)+'"'+(item.referenceNodeId===candidate.id?' selected':'')+'>'+esc((candidate.shotId?candidate.shotId+' · ':'')+candidate.title)+'</option>').join('')+'</select><span class="small muted">'+(item.referenceNodeId&&!entry.doc.nodes.some(n=>n.id===item.referenceNodeId)?'参考图片已移入回收站，请先恢复或选择其他图片。':'参考节点须已生成成功；报价前会读取真实图片地址。')+'</span></label>':'')+'<div class="canvas-model-parameters form-stack" data-canvas-parameters>'+V.mediaModelFields(parameterModel,values)+'</div></details><p class="canvas-editor-validation" data-canvas-validation>'+esc(item.validationError||'')+'</p><button type="button" class="button-primary" data-canvas-action="generate-node" data-node-id="'+esc(item.id)+'">生成当前'+type+'</button><button type="button" class="canvas-delete-node" data-canvas-action="remove-node">删除节点 · 可在回收站恢复</button></div>';
      if(editorDraftFor(entry,item.id).aiOpen)openAI(entry);
    }
    function renderBatch(entry){
      const footer=entry.host.querySelector('[data-canvas-batch]');if(!entry.doc){footer.innerHTML='';return;}
      const chosen=selected(entry),quote=entry.quote,configured=provider()?.modelConnection?.keyConfigured,expired=quote?.expiresAt&&new Date(quote.expiresAt).getTime()<=Date.now(),within=quote?.withinBudget===true&&!expired;
      const assetPage=entry.mode==='assets';const images=chosen.filter(item=>item.mediaKind==='image').length,videos=chosen.length-images,characters=chosen.filter(item=>item.nodeKind==='character').length;
      const summary=quote?'<div class="canvas-quote-summary"><strong>'+esc(quote.totalCost??quote.estimatedCost)+' '+esc(quote.currency)+'</strong><span>'+quote.items.length+' 个任务 · '+(expired?'报价已过期':within?'本批预计费用，请确认后开始':'预计费用超过所填预算')+'</span><details><summary>查看费用明细</summary><ul>'+quote.items.map(item=>'<li><span>'+esc(node(entry,item.nodeId)?.title||item.nodeId)+'</span><strong>'+esc(item.estimatedCost)+' '+esc(item.currency||quote.currency)+'</strong></li>').join('')+'</ul></details></div>':'<div class="canvas-batch-summary"><strong>已选 '+(assetPage?characters+' 组人物定妆':images+' 张图片 · '+videos+' 个视频')+'</strong><span>'+(assetPage?'先在本页完成定妆，再进入分镜与画布':'自动沿用人物资产表中已采用的定妆')+'</span></div>';
      footer.innerHTML='<div class="canvas-batch-selection">'+(assetPage?'<button type="button" data-canvas-action="select-characters">选择待做人物</button>':'<button type="button" data-canvas-action="select-images">分镜图片</button><button type="button" data-canvas-action="select-videos">分镜视频</button>')+'<button type="button" data-canvas-action="clear-selection">取消选择</button><button type="button" class="canvas-delete-selected" data-canvas-action="remove-selected"'+(!chosen.length||entry.busy?' disabled':'')+'>删除所选</button></div><div class="canvas-batch-main">'+summary+'<div class="canvas-batch-actions">'+(quote&&within?'<button type="button" class="button-primary" data-canvas-action="generate"'+(entry.busy?' disabled':'')+'>'+(entry.busy==='generate'?'正在提交…':'确认预计 '+esc(quote.totalCost??quote.estimatedCost)+' '+esc(quote.currency)+'，开始生成')+'</button>':'<button type="button" class="button-primary" data-canvas-action="estimate"'+(!chosen.length||!configured||entry.busy?' disabled':'')+'>'+(entry.busy==='estimate'?'正在准备本批费用…':quote?'重新计算费用':'生成所选 · '+chosen.length)+'</button>')+'</div></div><div class="canvas-batch-options"><p class="canvas-batch-note">'+(!configured?'请先在工具与连接配置模型 API。':quote?'实际扣费以 RunningHub 账单为准；结果回到对应镜头。':'点击后显示本批预计费用，一次确认后自动执行。')+'</p><details class="canvas-spend-options"'+(entry.ui.budgetOpen?' open':'')+'><summary>预算核对（可选）</summary><label class="canvas-budget">本批参考预算<input type="number" min="0.001" step="any" data-canvas-budget value="'+esc(entry.ui.budget||'')+'" placeholder="留空按报价确认"><small>'+(quote?esc(quote.currency):'以平台报价币种为准')+'</small></label></details></div>';
    }
    function characterCandidates(entry){return currentCharacterAssets(entry.doc).filter(asset=>asset.status==='pending_review'&&node(entry,asset.nodeId)&&safeURL(asset.reviewCandidate?.url)).map(asset=>({assetId:asset.id,jobId:asset.reviewCandidate.jobId,outputIndex:asset.reviewCandidate.outputIndex}));}
    function focusCharacters(entry){
      const items=entry.doc.nodes.filter(item=>item.nodeKind==='character');if(!items.length)return;
      const rect=entry.host.querySelector('[data-canvas-viewport]').getBoundingClientRect(),count=Math.max(1,Math.floor((rect.width-70)/340));entry.ui.activeId=items[0].id;entry.ui.stage='characters';entry.ui.sceneVisited=items[0].id;saveUI(entry);entry.doc.viewport=fitViewport(items.slice(0,count),rect.width,rect.height);renderNodes(entry);renderEditor(entry);renderPipeline(entry);touch(entry,{render:false,execution:false});
    }
    function focusCard(entry,id){
      const item=node(entry,id);if(!item||!entryNodes(entry).some(candidate=>candidate.id===id))return;if(entry.mode==='assets'){entry.ui.activeId=id;saveUI(entry);renderNodes(entry);renderEditor(entry);entry.host.querySelector('[data-character-row="'+id+'"]')?.scrollIntoView?.({block:'nearest'});return;}entry.ui.activeId=id;entry.ui.sceneVisited=id;saveUI(entry);
      const rect=entry.host.querySelector('[data-canvas-viewport]').getBoundingClientRect();entry.doc.viewport=fitViewport([item],rect.width,rect.height);renderNodes(entry);renderEditor(entry);touch(entry,{render:false,execution:false});
    }
    function renderPipeline(entry){
      const assets=currentCharacterAssets(entry.doc),ready=assets.filter(asset=>asset.status==='ready').length,shots=sceneGroups(entry.doc.nodes).length,candidates=characterCandidates(entry),host=entry.host.querySelector('[data-canvas-pipeline]');
      if(entry.mode==='assets'){host.innerHTML='<div><strong>'+assets.length+' 组人物</strong><span>'+ready+' 已采用 · '+(assets.length-ready)+' 待完成</span><p>文稿／美术设定 → 人物资产 → 分镜 → 创作画布</p></div><div class="character-page-actions">'+(candidates.length?'<button type="button" data-canvas-action="confirm-characters"'+(entry.busy?' disabled':'')+'>整组采用定妆 · '+candidates.length+'</button>':'')+'<button type="button" class="button-primary" data-action="characters-enter-storyboard">'+(ready===assets.length?'进入分镜 →':'完成定妆后进入分镜 →')+'</button></div>';return;}
      host.innerHTML='<button type="button" data-action="project-tab" data-id="characters"><b>✓</b><strong>人物资产表</strong><span>'+ready+' / '+assets.length+' 已采用 · 点击查看</span></button><i>→</i><button type="button" data-canvas-action="focus-stage" data-stage="images"><b>01</b><strong>分镜图片</strong><span>'+shots+' 镜 · 自动引用定妆</span></button><i>→</i><button type="button" data-canvas-action="focus-stage" data-stage="videos"><b>02</b><strong>镜头视频</strong><span>使用本镜图片作首帧</span></button>';
    }
    function renderProgress(entry){
      const jobs=(runtime?.media?.jobs||[]).filter(job=>job.projectId===entry.project.id),summary=progressSummary(entry.mode==='assets'?entry.doc.nodes.filter(item=>item.nodeKind==='character'):productionNodes(entry.doc.nodes),jobs,entry.project.id),host=entry.host.querySelector('[data-canvas-progress]');
      const latest=summary.latest,target=latest&&entry.doc.nodes.find(item=>matchesNodeJob(item,latest,entry.project.id)),at=latest?.updatedAt;
      const markup='<div class="canvas-progress-counts"><strong>'+ (summary.active?'生成中 · '+summary.active+' 项':'制作进展')+'</strong><span>'+summary.succeeded+' 已返回</span><span>'+summary.failed+' 失败 / 待核对</span></div>'+(latest?'<button type="button" data-canvas-action="focus-card" data-node-id="'+esc(target?.id||'')+'">'+esc(target?.title||latest.shotId||'最近任务')+' · '+esc(statusLabel(latest.status))+(at?' · '+esc(new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})):'')+(latest.status==='succeeded'?' · 查看结果 →':'')+'</button>':'<span>生成状态会自动更新，完成后可在对应卡片播放。</span>')+'<button type="button" data-canvas-action="refresh-progress" aria-label="刷新生成进展">刷新</button>';
      if(host._markup!==markup){host.innerHTML=markup;host._markup=markup;}
    }
    function renderConversation(entry){
      const host=entry.host.querySelector('[data-canvas-chat]');if(!host)return;
      const open=Boolean(entry.ui.chatOpen);host.hidden=!open;entry.host.classList.toggle('is-chat-open',open);entry.host.classList.toggle('editor-collapsed',!entry.ui.editorOpen);
      entry.host.querySelector('[data-canvas-action="toggle-chat"]')?.setAttribute('aria-pressed',String(open));
      if(!open||!options.conversationHTML)return;
      const markup=options.conversationHTML(entry.project),signature=entry.project.id+':'+markup,active=global.document.activeElement;
      if(host._signature===signature)return;
      const oldComposer=host.querySelector('[data-form="message"]'),oldInput=oldComposer?.querySelector('#message-text'),editing=oldComposer?.contains(active),selection=editing&&oldInput===active?[oldInput.selectionStart,oldInput.selectionEnd]:null;
      const scroll=host.querySelector('.conversation-stream'),top=scroll?.scrollTop||0,atBottom=scroll&&scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<60;
      const fresh=global.document.createElement('div');fresh.innerHTML='<div class="canvas-chat-title"><strong>团队对话</strong><span>共享当前角色、镜头与真实生成状态</span></div>'+markup;
      const newInput=fresh.querySelector('#message-text'),preserveInput=editing&&active===oldInput&&oldInput?.value===newInput?.value;if(preserveInput)newInput.replaceWith(oldInput);
      host.replaceChildren(...fresh.childNodes);host._signature=signature;
      if(editing){const nextActive=preserveInput?oldInput:[...host.querySelectorAll('[id]')].find(item=>item.id===active?.id);nextActive?.focus({preventScroll:true});if(selection&&preserveInput)oldInput.setSelectionRange(...selection);}
      const next=host.querySelector('.conversation-stream');if(next)next.scrollTop=atBottom?next.scrollHeight:top;
    }
    function openCharacterForm(entry){
      entry.ui.editorOpen=true;entry.ui.chatOpen=false;renderConversation(entry);const host=entry.host.querySelector('[data-canvas-editor]');entry.host.classList.remove('editor-collapsed');
      delete host.dataset.editorNodeId;host.innerHTML='<div class="canvas-editor-heading"><h3>新建作品人物</h3><button type="button" data-canvas-action="toggle-editor" aria-label="收起参数面板">›</button></div><form class="canvas-editor-scroll" data-canvas-character-form><label class="field-label">人物名字<input class="field" name="name" maxlength="80" required></label><label class="field-label">人物介绍<textarea class="textarea" name="description" rows="4" maxlength="2000" placeholder="身份、性格，以及在故事中的作用…"></textarea></label><label class="field-label">定妆提示词<textarea class="textarea" name="prompt" rows="10" maxlength="2000" placeholder="外貌、年龄、发型、服装、色彩、画风与全身定妆要求…" required></textarea></label><p class="small">先创建定妆卡片；生成并确认参考图后，再用于分镜。</p><p class="canvas-error" data-character-error></p><button class="button-primary" type="submit">创建人物卡片</button></form>';
    }
    function renderHistory(entry){
      const batches=entry.doc?.batches||[],host=entry.host.querySelector('[data-canvas-history]');host.innerHTML=batches.length?'<details'+(batches.some(activeBatch)?' open':'')+'><summary>批次记录 · '+batches.length+'</summary>'+batches.slice().reverse().map(batch=>'<article><div><strong>'+esc(({running:'正在执行',queued:'等待执行',completed:'批次完成',succeeded:'批次完成',partial:'部分完成',stopped:'已停止',failed:'批次失败',unknown:'状态待确认'})[batch.status]||batch.status)+'</strong><span>'+esc(batch.createdAt?new Date(batch.createdAt).toLocaleString('zh-CN'):'')+' · '+(batch.items||[]).length+' 个节点</span></div>'+(activeBatch(batch)?'<button type="button" data-canvas-action="stop-batch" data-batch-id="'+esc(batch.id)+'">停止未提交任务</button>':'')+'<ul>'+(batch.items||[]).map(item=>'<li>'+esc(node(entry,item.nodeId)?.shotId||node(entry,item.nodeId)?.title||item.nodeId)+' · '+esc(statusLabel(item.status))+(item.error?' · '+esc(typeof item.error==='string'?item.error:JSON.stringify(item.error)):'')+'</li>').join('')+'</ul></article>').join('')+'</details>':'';
    }
    function renderAll(entry,preserveEditor=false){renderNotice(entry);renderNodes(entry);if(!preserveEditor||!editorContextMatches(entry,entry.host.querySelector('[data-canvas-editor]')?.dataset.editorNodeId))renderEditor(entry);renderBatch(entry);renderHistory(entry);renderPipeline(entry);renderProgress(entry);renderConversation(entry);}
    function update(entry=current){
      if(!entry?.doc)return;
      const trashSignature=JSON.stringify(runtime?.trash?.items||[]);
      if(entry.trashSignature!==trashSignature){
        entry.trashSignature=trashSignature;entry.quote=null;
        const previous=node(entry);
        entry.doc.nodes=visibleCanvasNodes(entry.doc.nodes,runtime,entry.project.id);
        if(!entryNodes(entry).some(item=>item.id===entry.ui.activeId))entry.ui.activeId=entryNodes(entry)[0]?.id||'';
        const referenceRemoved=previous?.referenceNodeId&&!entry.doc.nodes.some(item=>item.id===previous.referenceNodeId);
        const editingUnchangedNode=previous?.id===node(entry)?.id&&!referenceRemoved&&entry.host.querySelector('[data-canvas-editor]')?.contains(global.document.activeElement);
        if(!editingUnchangedNode)renderEditor(entry);
        renderBatch(entry);
        if(!entry.busy&&entry.host.isConnected){
          if(entry.loading)entry.loading.finally(()=>{if(entry.host.isConnected)load(entry,true);});
          else load(entry,true);
        }
      }
      renderNodes(entry);renderHistory(entry);renderPipeline(entry);renderProgress(entry);renderConversation(entry);schedulePoll(entry);
      const signature=models().map(model=>model.id+':'+model.contractHash).join('|');
      if(entry.catalogSignature!==signature){entry.catalogSignature=signature;renderEditor(entry);renderBatch(entry);}
      checkOptimizations(entry);
    }
    function focusNode(entry,request){
      if(request.create){addNode(entry,request.mediaKind||'image');return;}
      const visible=entryNodes(entry);const match=visible.find(item=>item.id===request.nodeId)||visible.find(item=>item.shotId===request.shotId&&item.mediaKind===request.mediaKind&&(!request.sourceArtifactId||item.sourceArtifactId===request.sourceArtifactId))||visible.find(item=>item.mediaKind===request.mediaKind)||visible[0];
      if(!match){if(entry.mode!=='assets')addNode(entry,request.mediaKind||'image');return;}if(entry.mode==='assets'){focusCard(entry,match.id);return;}
      entry.ui.activeId=match.id;entry.ui.editorOpen=true;entry.ui.chatOpen=false;saveUI(entry);renderConversation(entry);renderEditor(entry);renderNodes(entry);
      const bounds=entry.host.querySelector('[data-canvas-viewport]').getBoundingClientRect();entry.doc.viewport={...entry.doc.viewport,x:bounds.width/2-(match.position.x+143)*entry.doc.viewport.scale,y:bounds.height/2-(match.position.y+130)*entry.doc.viewport.scale};setTransform(entry);touch(entry,{render:false,execution:false});
    }
    function addNode(entry,mediaKind){
      if(!entry.doc)return;
      const preferred=mediaKind==='video'?'bytedance/seedance-2.5-token/text-to-video':'seedream-v5-pro/text-to-image',model=models().find(model=>modelId(model)===preferred&&Runtime.modelAvailable(model))||models().find(model=>model.mediaKind===mediaKind&&Runtime.modelAvailable(model)),viewport=entry.doc.viewport;
      const item={id:'node-'+global.crypto.randomUUID(),mediaKind,title:mediaKind==='video'?'新视频':'新图片',prompt:'',modelId:modelId(model),parameters:{...clone(model?.defaults||{}),...(mediaKind==='image'?{width:2048,height:2048,resolution:'',outputFormat:'png'}:{})},parameterDraft:{...clone(model?.defaults||{}),...(mediaKind==='image'?{width:2048,height:2048,resolution:'',outputFormat:'png'}:{})},position:{x:(100-viewport.x)/viewport.scale,y:(90-viewport.y)/viewport.scale},selected:true,stylePreset:'original',promptField:model?.fields.some(field=>field.name==='prompt')?'prompt':'',jobIds:[]};
      entry.doc.nodes.push(item);entry.ui.activeId=item.id;entry.ui.editorOpen=true;entry.ui.chatOpen=false;entry.filters={};saveUI(entry);renderConversation(entry);touch(entry);renderEditor(entry);
    }
    function collectEditor(entry){
      const item=node(entry),editor=entry.host.querySelector('[data-canvas-editor]');if(!item||!editorContextMatches(entry,editor?.dataset.editorNodeId))return;
      const oldResolution=parameterValues(item).resolution;
      item.parameterDraft=Object.fromEntries([...entry.host.querySelectorAll('[data-canvas-parameters] [data-model-param]')].map(input=>[input.dataset.modelParam,input.type==='checkbox'?input.checked:input.value]));
      if(/^seedream-v5-pro\//.test(item.modelId))item.parameterDraft.resolution=oldResolution||'';
      try{item.parameters=prepareNode(item,findModel(item),entry.doc,runtime.media.jobs,Runtime);delete item.validationError;}catch(error){item.validationError=error.message;}
      const validation=entry.host.querySelector('[data-canvas-validation]');if(validation)validation.textContent=item.validationError||'';
      const combined=entry.host.querySelector('[data-canvas-combined]');if(combined)combined.textContent=combinedPrompt(item);
      const config=entry.host.querySelector('[data-canvas-current-config]');if(config)config.textContent=modelSummary(item,findModel(item));
    }
    function collectParameterEdit(entry,input){
      if(!ensureEditorContext(entry,input))return;const item=node(entry);if(!item)return;
      if(/^seedream-v5-pro\//.test(item.modelId)&&['width','height'].includes(input.dataset.modelParam)){
        item.parameters={...item.parameters,resolution:''};item.parameterDraft={...item.parameterDraft,resolution:''};
        const preset=entry.host.querySelector('[data-canvas-size]');if(preset)preset.value='';
      }
      if(/seedance.*2[.-]5/.test(item.modelId)){
        const draft=entry.host.querySelector('[data-model-param="draft"]'),resolution=entry.host.querySelector('[data-model-param="resolution"]');
        if(input.dataset.modelParam==='draft'&&input.value==='true'&&resolution)resolution.value='480p';
        if(input.dataset.modelParam==='resolution'&&input.value!=='480p'&&draft?.value==='true')draft.value='false';
      }
      collectEditor(entry);touch(entry);
      const model=findModel(item),aspect=entry.host.querySelector('[data-canvas-aspect]'),size=entry.host.querySelector('[data-canvas-size]');
      for(const [select,value,label] of [[aspect,Controls.currentImageAspect(item,model),'自定义比例'],[size,Controls.currentImageSizeTier(item,model),'自定义清晰度']]){
        if(!select)continue;
        if(![...select.options].some(option=>option.value===value)){const option=global.document.createElement('option');option.value=value;option.textContent=label;option.disabled=true;select.prepend(option);}
        select.value=value;
      }
    }
    async function estimate(entry){
      if(entry.busy||!entry.doc)return;
      const budget=optionalBudget(entry.ui.budget);if(budget!==null&&(!Number.isFinite(budget)||budget<=0)){notifyError(entry,'参考预算需大于零，也可以留空后按本批报价确认');return;}
      collectEditor(entry);const chosen=selected(entry);if(!chosen.length)return;
      let invalid=false;for(const item of chosen){try{item.parameters=prepareNode(item,findModel(item),entry.doc,runtime.media.jobs,Runtime);delete item.validationError;}catch(error){item.validationError=error.message;invalid=true;}}
      if(invalid){const failed=chosen.find(item=>item.validationError),blocked=nodeBlocker(failed,entry.doc,runtime.media.jobs);focusCard(entry,failed.id);if(!blocked){entry.ui.editorOpen=true;entry.ui.chatOpen=false;entry.ui.advancedOpen=true;renderConversation(entry);renderEditor(entry);}notifyError(entry,blocked||failed.validationError||'请补充生成信息');return;}
      registerChange(entry);entry.busy='estimate';entry.error='';const snapshot=quoteSnapshot(entry);renderBatch(entry);renderNotice(entry);
      try{await save(entry);if(!quoteSnapshotCurrent(entry,snapshot))throw new Error('保存期间预算或选择已修改，请重新生成');const result=await runtime.request(path(entry)+'/estimate',{nodeIds:snapshot.nodeIds,...(snapshot.budget===null?{}:{budget:snapshot.budget}),expectedRevision:entry.doc.revision},{timeoutMs:180000});if(!quoteSnapshotCurrent(entry,snapshot))throw new Error('计算费用期间画布已修改，请重新生成');entry.quote=result.estimate;entry.quote._version=snapshot.version;}catch(error){notifyError(entry,error);}finally{entry.busy='';renderBatch(entry);}
    }
    async function generate(entry){
      const quote=entry.quote;if(entry.busy||!quote||quote.withinBudget!==true)return;
      if(quote._version!==executionVersion(entry)){entry.quote=null;notifyError(entry,'画布已修改，请重新估价');renderBatch(entry);return;}
      if(quote.expiresAt&&new Date(quote.expiresAt).getTime()<=Date.now()){notifyError(entry,'报价已过期，请重新估价');renderBatch(entry);return;}
      entry.busy='generate';renderBatch(entry);
      const requestId=quote._requestId||(quote._requestId=global.crypto.randomUUID());
      try{const result=await runtime.request(path(entry)+'/generate',{estimateToken:quote.estimateToken,requestId,confirmCost:true},{timeoutMs:55000});if(!result.batch?.id)throw new Error('批次受理状态未确认，请刷新批次记录');entry.doc.batches=[...(entry.doc.batches||[]).filter(batch=>batch.id!==result.batch.id),result.batch];entry.quote=null;await runtime.refreshMedia();await load(entry,true);schedulePoll(entry);}catch(error){notifyError(entry,error);}finally{entry.busy='';renderBatch(entry);renderHistory(entry);}
    }
    function schedulePoll(entry){
      const pending=(runtime?.media?.jobs||[]).some(job=>job.projectId===entry.project.id&&['submitting','queued','running'].includes(job.status));
      if(!entry.host.isConnected||(!(entry.doc?.batches||[]).some(activeBatch)&&!pending)){global.clearTimeout(entry.pollTimer);entry.pollTimer=null;return;}
      if(entry.pollTimer)return;
      entry.pollTimer=global.setTimeout(async()=>{entry.pollTimer=null;try{const result=await runtime.request(path(entry)+'/batches');entry.doc.batches=result.batches||[];await runtime.refreshMedia();await load(entry,true);}catch(error){notifyError(entry,error);}finally{schedulePoll(entry);}},5000);
    }
    function openAI(entry){
      const item=node(entry),panel=entry.host.querySelector('[data-canvas-ai]');if(!item||!panel||entry.host.querySelector('[data-canvas-editor]')?.dataset.editorNodeId!==item.id)return;rememberEditorDraft(entry);const draft=editorDraftFor(entry,item.id);draft.aiOpen=true;panel.hidden=false;const running=entry.optimizing.get(item.id);
      const pending=running&&!['succeeded','failed','cancelled'].includes(running.status);
      panel.innerHTML='<div class="canvas-ai-heading"><strong>'+ (item.nodeKind==='character'?'美术总监 · R05':'AI 提示词助手 · R06')+'</strong><button type="button" data-canvas-action="close-ai" aria-label="关闭AI提示词助手">×</button></div><p>基于当前镜头与模型参数提出修改建议，确认应用后才改写画布。调用现有员工执行器，使用你配置的文字模型 API。</p><label class="field-label">优化方向<textarea class="textarea" rows="3" maxlength="3000" data-canvas-ai-instruction placeholder="例如：突出角色表情，镜头更有电影感，保留原有动作…">'+esc(draft.instruction??running?.instruction??'')+'</textarea></label><button type="button" data-canvas-action="optimize"'+(!runtime.ready()||pending?' disabled':'')+'>'+(pending?'伙伴正在优化…':'让伙伴优化提示词')+'</button>'+(pending?'<div class="canvas-ai-actions"><button type="button" data-canvas-action="refresh-ai">检查执行记录</button>'+(running.runId?'<button type="button" data-canvas-action="cancel-ai">停止优化</button>':'')+'</div>':'')+'<div data-canvas-ai-result></div>';
      if(!runtime.ready())panel.querySelector('[data-canvas-ai-result]').textContent='员工执行器尚未就绪，请在工具与连接检查。';checkOptimizations(entry);if(!entry.editorDialog?.open)panel.scrollIntoView?.({block:'nearest',behavior:'smooth'});
    }
    async function optimize(entry){
      if(!ensureEditorContext(entry))return;const item=node(entry),prior=item?.optimization;if(!item||prior&&!['succeeded','failed','cancelled'].includes(prior.status))return;
      const instruction=entry.host.querySelector('[data-canvas-ai-instruction]')?.value||'';rememberEditorDraft(entry);const uiDraft=editorDraftFor(entry,item.id);uiDraft.suggestion=undefined;uiDraft.requestId='';
      item.optimization={requestId:global.crypto.randomUUID(),runId:'',promptSnapshot:item.prompt,sourceVersion:item.sourceVersion||'',instruction,modelId:item.modelId,status:'submitting',recommendation:''};entry.optimizing.set(item.id,item.optimization);touch(entry);openAI(entry);
      const pending=item.optimization,snapshot=clone(item);
      try{await save(entry);const run=await options.onOptimize?.({project:entry.project,node:snapshot,model:findModel(snapshot),instruction,requestId:pending.requestId});if(!run?.id)throw new Error('提示词优化接口未返回运行记录');pending.runId=run.id;pending.status=run.status||'queued';}
      catch(error){await runtime.loadScope({projectId:entry.project.id},true);const run=runtime.getRuns({projectId:entry.project.id}).find(run=>run.requestId===pending.requestId);if(run){pending.runId=run.id;pending.status=run.status;}else{pending.status=/超时|未确认|未返回/.test(error.message)?'unknown':'failed';pending.error=error.message;}notifyError(entry,error);}
      const current=node(entry,snapshot.id);if(current?.optimization?.requestId===pending.requestId){current.optimization=pending;entry.optimizing.set(current.id,pending);touch(entry);if(entry.ui.activeId===snapshot.id)openAI(entry);}
    }
    function checkOptimizations(entry){
      let changed=false;
      for(const [id,pending] of entry.optimizing){const item=node(entry,id);if(!item)continue;const run=runtime.findRun(pending.runId)||runtime.getRuns({projectId:entry.project.id}).find(run=>run.requestId===pending.requestId);if(!run)continue;const recommendation=run.status==='succeeded'?((run.artifacts||[]).map(artifact=>artifact.body||'').filter(Boolean).join('\n\n')||(run.messages||[]).filter(message=>message.authorId===(item.nodeKind==='character'?'R05':'R06')).map(message=>message.content).join('\n\n')):'';if(pending.status!==run.status||pending.runId!==run.id||recommendation&&pending.recommendation!==recommendation){Object.assign(pending,{runId:run.id,status:run.status,recommendation,error:run.status==='failed'||run.status==='cancelled'?(run.error||'本次优化已停止'):''});item.optimization=pending;changed=true;}}
      if(changed)touch(entry,{render:false});
      const item=node(entry),pending=item&&entry.optimizing.get(item.id),host=entry.host.querySelector('[data-canvas-ai-result]');if(!host||!pending||entry.host.querySelector('[data-canvas-editor]')?.dataset.editorNodeId!==item.id)return;rememberEditorDraft(entry);const draft=editorDraftFor(entry,item.id);
      const signature=JSON.stringify([pending.requestId,pending.status,pending.recommendation,pending.error,item.prompt===pending.promptSnapshot]);if(host.dataset.signature===signature)return;host.dataset.signature=signature;host.dataset.requestId=pending.requestId;
      if(pending.status==='succeeded'){const stale=item.prompt!==pending.promptSnapshot;host.innerHTML=(stale?'<p class="canvas-error">你已改写当前草稿，以下建议基于上一版生成。当前草稿会保留，请复制需要的片段到提示词中。</p>':'')+'<label class="field-label">伙伴建议 · 应用前可修改<textarea class="textarea canvas-ai-suggestion" data-canvas-ai-suggestion rows="7">'+esc(suggestionValue(draft,pending))+'</textarea></label><button type="button" data-canvas-action="apply-ai"'+(stale||!pending.recommendation?' disabled':'')+'>应用到当前节点提示词</button>';}
      else if(pending.error)host.innerHTML='<p class="canvas-error">'+esc(pending.error)+(pending.status==='unknown'?'。先检查执行记录，避免重复提交。':'')+'</p>';
      else host.textContent='真实执行中，建议返回后会显示在这里。';
    }
    function ensureEditorContext(entry,source){
      const editor=entry.host.querySelector('[data-canvas-editor]'),owner=source?.closest?.('[data-canvas-editor]');
      if(editorContextMatches(entry,editor?.dataset.editorNodeId)&&(!owner||owner===editor))return true;
      renderEditor(entry,true);return false;
    }
    function rememberDialogView(entry){const dialog=entry.editorDialog;if(dialog?.isConnected)entry.dialogView=capturePromptDialogView(dialog,global.document.activeElement,entry.dialogView?.focus);}
    function rememberEditorDraft(entry){
      const editor=entry.host.querySelector('[data-canvas-editor]'),id=editor?.dataset.editorNodeId;if(!id)return;
      const draft=editorDraftFor(entry,id),instruction=editor.querySelector('[data-canvas-ai-instruction]'),suggestion=editor.querySelector('[data-canvas-ai-suggestion]');
      if(instruction)draft.instruction=instruction.value;
      if(suggestion){draft.suggestion=suggestion.value;draft.requestId=editor.querySelector('[data-canvas-ai-result]')?.dataset.requestId||'';}
    }
    function renderDialogPreview(entry){
      const dialog=entry.editorDialog,item=node(entry);if(!dialog?.open||!item)return;
      const host=dialog.querySelector('[data-prompt-preview]'),asset=characterFor(entry.doc,item),media=previewFor(item,asset,runtime.media.jobs,entry.project.id),title=asset?.name||item.title||'当前画面';
      const markup='<div class="prompt-dialog-preview-heading"><small>'+esc(media.label)+'</small><h3>'+esc(title)+'</h3></div><div class="prompt-dialog-image">'+(media.url?(media.video?'<video src="'+esc(media.url)+'" controls preload="metadata" playsinline aria-label="当前视频预览"></video>':'<img src="'+esc(media.url)+'" alt="'+esc(title)+'当前画面" referrerpolicy="no-referrer">'):'<div class="prompt-dialog-empty"><span>▧</span><strong>'+esc(media.label)+'</strong><p>生成成功后，画面会显示在这里。</p></div>')+'</div>'+(asset?'<p class="prompt-dialog-description">'+esc(characterSummary(asset))+'</p>':'')+'<p class="prompt-dialog-reference-note">'+(asset?.reviewCandidate?'此图为待采用候选，尚未锁定为分镜参考。':asset?.status==='ready'?'已采用为人物参考。':'可先编辑提示词与美术方向。')+'</p>';
      if(host._markup!==markup){host.innerHTML=markup;host._markup=markup;}
    }
    function openEditorDialog(entry,id,mode='prompt'){
      if(!node(entry,id))return;
      if(entry.editorDialog?.open){if(entry.ui.activeId===id){entry.editorDialog.dataset.mode=mode;entry.editorDialog.setAttribute('aria-label',mode==='art'?'美术优化':'提示词编辑');entry.editorDialog.querySelector('h2').textContent=mode==='art'?'美术优化':'提示词编辑';if(mode==='art')openAI(entry);const scroll=entry.editorDialog.querySelector('.canvas-editor-scroll');if(scroll)scroll.scrollTop=0;return;}closeEditorDialog(entry);}
      const opener=global.document.activeElement;entry.editorReturn={nodeId:id,action:opener?.dataset?.canvasAction||'edit-prompt'};
      rememberEditorDraft(entry);entry.ui.activeId=id;entry.filters={};saveUI(entry);renderNodes(entry);renderEditor(entry,true);
      const editor=entry.host.querySelector('[data-canvas-editor]');entry.editorHome=editor.parentNode;entry.editorNext=editor.nextSibling;entry.editorOpener=opener;
      const dialog=global.document.createElement('dialog');dialog.className='canvas-prompt-dialog';dialog.dataset.mode=mode;dialog.setAttribute('aria-label',mode==='art'?'美术优化':'提示词编辑');
      dialog.innerHTML='<header class="prompt-dialog-header"><div><small>画面与提示词工作室</small><h2>'+esc(mode==='art'?'美术优化':'提示词编辑')+'</h2></div><div class="prompt-dialog-window-actions"><button type="button" data-canvas-action="expand-prompt-dialog" aria-pressed="false">放大编辑 ↗</button><button type="button" data-canvas-action="close-prompt-dialog" aria-label="关闭编辑窗口">关闭 ×</button></div></header><div class="prompt-dialog-body"><aside class="prompt-dialog-preview" data-prompt-preview></aside><div class="prompt-dialog-editor-host" data-prompt-editor-host></div></div><footer class="prompt-dialog-footer"><span data-prompt-save-status role="status"></span><button type="button" data-canvas-action="close-prompt-dialog">完成编辑</button></footer>';
      entry.host.append(dialog);dialog.querySelector('[data-prompt-editor-host]').append(editor);entry.editorDialog=dialog;entry.host.classList.add('has-prompt-dialog');
      dialog.addEventListener('cancel',event=>{event.preventDefault();closeEditorDialog(entry);});for(const type of ['focusin','input','select','keyup','mouseup'])dialog.addEventListener(type,()=>rememberDialogView(entry));dialog.addEventListener('scroll',()=>rememberDialogView(entry),true);dialog.showModal();renderDialogPreview(entry);renderNotice(entry);
      if(mode==='art')openAI(entry);else {const panel=editor.querySelector('[data-canvas-ai]');if(panel)panel.hidden=true;}
      const scroll=editor.querySelector('.canvas-editor-scroll');if(scroll)scroll.scrollTop=0;
      editor.querySelector(mode==='art'?'[data-canvas-ai-instruction]':'[data-canvas-field="prompt"]')?.focus({preventScroll:true});rememberDialogView(entry);
    }
    function closeEditorDialog(entry){
      const dialog=entry.editorDialog;if(!dialog)return;rememberEditorDraft(entry);if(editorContextMatches(entry,dialog.querySelector('[data-canvas-editor]')?.dataset.editorNodeId))collectEditor(entry);
      const editor=dialog.querySelector('[data-canvas-editor]');if(editor&&entry.editorHome)entry.editorHome.insertBefore(editor,entry.editorNext?.parentNode===entry.editorHome?entry.editorNext:null);
      dialog.close();dialog.remove();entry.editorDialog=null;entry.dialogView=null;entry.host.classList.remove('has-prompt-dialog');
      const fallback=[...entry.host.querySelectorAll('[data-canvas-action]')].find(button=>button.dataset.canvasAction===entry.editorReturn?.action&&button.dataset.nodeId===entry.editorReturn?.nodeId)||[...entry.host.querySelectorAll('[data-canvas-action]')].find(button=>button.dataset.canvasAction==='edit-prompt'&&button.dataset.nodeId===entry.editorReturn?.nodeId);
      (entry.editorOpener?.isConnected?entry.editorOpener:fallback)?.focus({preventScroll:true});entry.editorOpener=null;entry.editorReturn=null;save(entry).catch(error=>notifyError(entry,error));
    }
    function setFocus(entry,focused){entry.focused=focused;entry.host.classList.toggle('is-focused',focused);const button=entry.host.querySelector('[data-canvas-action="toggle-focus"]');if(button){button.textContent=focused?'退出专注 ↙':'专注画布 ↗';button.setAttribute('aria-pressed',String(focused));button.focus({preventScroll:true});}}
    function bind(entry){
      entry.host.addEventListener('keydown',event=>{if(event.key==='Escape'&&entry.editorDialog?.open){event.preventDefault();event.stopPropagation();closeEditorDialog(entry);return;}if(event.key==='Escape'&&entry.focused){event.preventDefault();event.stopPropagation();setFocus(entry,false);}});
      entry.host.addEventListener('click',async event=>{
        const button=event.target.closest('[data-canvas-action]');if(!button)return;event.preventDefault();event.stopPropagation();const action=button.dataset.canvasAction;
        if(button.closest('[data-canvas-editor]')&&action!=='toggle-editor'&&!ensureEditorContext(entry,button))return;
        if(action==='choose-style'){
          const item=node(entry);if(!item||!styles.some(style=>style.id===button.dataset.styleId))return;
          collectEditor(entry);item.stylePreset=button.dataset.styleId;touch(entry);renderEditor(entry,true);return;
        }
        if(action==='apply-settings'){
          const item=node(entry);if(!item)return;collectEditor(entry);const kind=button.dataset.settingsKind,targets=selected(entry).filter(target=>target.id!==item.id);let applied=0;
          for(const target of targets)if(Controls.copySettings(item,target,findModel(item),findModel(target),kind))applied++;
          if(applied){touch(entry);renderEditor(entry,true);}
          const feedback=entry.host.querySelector('[data-settings-feedback="'+kind+'"]');if(feedback)feedback.textContent=applied?'已更新另外 '+applied+' 项'+(targets.length>applied?'，跳过 '+(targets.length-applied)+' 项不兼容设置':'')+'；生成前会重新报价。':'请先勾选其他'+(kind==='quality'?'相同模型的':'同类型的')+'节点。';return;
        }
        if(action==='asset-optimize'||action==='edit-prompt'||action==='expand-prompt'){openEditorDialog(entry,button.dataset.nodeId||entry.ui.activeId,action==='asset-optimize'?'art':'prompt');return;}
        if(action==='close-prompt-dialog'){closeEditorDialog(entry);return;}
        if(action==='expand-prompt-dialog'){const expanded=entry.editorDialog.classList.toggle('is-expanded');button.textContent=expanded?'还原窗口 ↙':'放大编辑 ↗';button.setAttribute('aria-pressed',String(expanded));return;}
        if(action==='toggle-chat'){entry.ui.chatOpen=!entry.ui.chatOpen;if(entry.ui.chatOpen)entry.ui.editorOpen=false;saveUI(entry);renderEditor(entry);renderConversation(entry);return;}
        if(action==='focus-card'){focusCard(entry,button.dataset.nodeId);return;}
        if(action==='focus-stage'){entry.ui.stage=button.dataset.stage;if(entry.ui.stage==='characters'){focusCharacters(entry);return;}const item=entry.doc.nodes.find(item=>entry.ui.stage==='characters'?item.nodeKind==='character':item.shotId&&item.mediaKind===(entry.ui.stage==='videos'?'video':'image'));if(item)focusCard(entry,item.id);renderPipeline(entry);return;}
        if(action==='arrange-horizontal'){const positions=horizontalPositions(productionNodes(entry.doc.nodes));for(const item of entry.doc.nodes)if(positions[item.id])item.position=positions[item.id];touch(entry,{execution:false});focusCard(entry,entry.ui.activeId||entry.doc.nodes[0]?.id);return;}
        if(action==='refresh-progress'){try{await runtime.refreshMedia();await load(entry,true);}catch(error){notifyError(entry,error);}return;}
        if(action==='add-character'){openCharacterForm(entry);return;}
        if(action==='confirm-characters'){if(entry.busy)return;entry.busy='confirm-characters';try{await save(entry);const items=characterCandidates(entry);if(!items.length)throw new Error('请先生成定妆图片，返回后可整组采用。');const result=await runtime.request(path(entry)+'/assets/confirm-batch',{items,expectedRevision:entry.doc.revision});mergeDocument(entry,result);entry.quote=null;entry.notice='已采用这组定妆，分镜会自动引用对应人物。';}catch(error){notifyError(entry,error);}finally{entry.busy='';renderAll(entry);}return;}
        if(action==='confirm-character'){if(entry.busy)return;entry.busy='confirm-character';try{await save(entry);const result=await runtime.request(path(entry)+'/assets/'+encodeURIComponent(button.dataset.assetId)+'/confirm',{jobId:button.dataset.jobId,outputIndex:Number(button.dataset.outputIndex),expectedRevision:entry.doc.revision});mergeDocument(entry,result);entry.quote=null;entry.notice='人物定妆已确认，关联镜头会自动使用这张参考图。';}catch(error){notifyError(entry,error);}finally{entry.busy='';renderAll(entry);}return;}
        if(action==='toggle-focus'){entry.ui.preferredFocus=!entry.focused;saveUI(entry);setFocus(entry,entry.ui.preferredFocus);return;}
        if(action==='focus-scene'){focusScene(entry,button.dataset.sceneId);return;}
        if(action==='add-image'||action==='add-video'){addNode(entry,action==='add-video'?'video':'image');return;}
        if(action==='select-node'){entry.ui.activeId=button.dataset.nodeId;entry.ui.editorOpen=true;entry.ui.chatOpen=false;entry.filters={};saveUI(entry);renderConversation(entry);renderNodes(entry);renderEditor(entry);return;}
        if(action==='toggle-editor'){entry.ui.editorOpen=!entry.ui.editorOpen;if(entry.ui.editorOpen)entry.ui.chatOpen=false;saveUI(entry);renderEditor(entry);renderConversation(entry);return;}
        if(action==='retry-save'){save(entry).catch(error=>notifyError(entry,error));return;}
        if(action==='fit'){const rect=entry.host.querySelector('[data-canvas-viewport]').getBoundingClientRect();entry.doc.viewport=fitViewport(productionNodes(entry.doc.nodes),rect.width,rect.height);setTransform(entry);touch(entry,{render:false,execution:false});return;}
        if(action==='zoom-in'||action==='zoom-out'){zoom(entry,action==='zoom-in'?1.2:1/1.2);return;}
        if(['select-characters','select-images','select-videos','select-all','clear-selection'].includes(action)){for(const item of entry.doc.nodes)item.selected=action==='select-all'||(action==='select-characters'?item.nodeKind==='character'&&characterFor(entry.doc,item)?.status!=='ready':action==='select-images'?item.nodeKind!=='character'&&item.mediaKind==='image':action==='select-videos'?item.mediaKind==='video':false);touch(entry);return;}
        if(action==='remove-node'){await trashNodes(entry,[button.dataset.nodeId||entry.ui.activeId]);return;}
        if(action==='remove-selected'){await trashNodes(entry,selected(entry).map(item=>item.id));return;}
        if(action==='open-trash'){await save(entry).catch(error=>notifyError(entry,error));setFocus(entry,false);options.onOpenTrash?.();return;}
        if(action==='generate-node'){if(entry.busy)return;for(const item of entry.doc.nodes)item.selected=item.id===button.dataset.nodeId;touch(entry);await estimate(entry);return;}
        if(action==='estimate'){await estimate(entry);return;}if(action==='generate'){await generate(entry);return;}
        if(action==='stop-batch'){try{await runtime.request(path(entry)+'/batches/'+encodeURIComponent(button.dataset.batchId)+'/stop',{});await load(entry,true);}catch(error){notifyError(entry,error);}return;}
        if(action==='open-ai'){openEditorDialog(entry,entry.ui.activeId,'art');return;}if(action==='close-ai'){rememberEditorDraft(entry);editorDraftFor(entry,entry.ui.activeId).aiOpen=false;entry.host.querySelector('[data-canvas-ai]').hidden=true;return;}if(action==='optimize'){await optimize(entry);return;}
        if(action==='refresh-ai'){try{await runtime.loadScope({projectId:entry.project.id},true);checkOptimizations(entry);openAI(entry);}catch(error){notifyError(entry,error);}return;}
        if(action==='cancel-ai'){const pending=node(entry)?.optimization;if(pending?.runId){try{await runtime.cancel(pending.runId);checkOptimizations(entry);openAI(entry);}catch(error){notifyError(entry,error);}}return;}
        if(action==='apply-ai'){const item=node(entry),text=entry.host.querySelector('[data-canvas-ai-suggestion]')?.value;if(item&&text&&item.prompt===item.optimization?.promptSnapshot){item.prompt=text;touch(entry);renderEditor(entry,true);}return;}
      });
      entry.host.addEventListener('submit',async event=>{
        const form=event.target;if(!form.matches('[data-canvas-character-form]'))return;event.preventDefault();event.stopPropagation();if(entry.busy)return;const fields=new FormData(form);entry.busy='create-character';
        try{await save(entry);const result=await runtime.request(path(entry)+'/assets',{name:String(fields.get('name')||''),prompt:String(fields.get('prompt')||''),description:String(fields.get('description')||''),expectedRevision:entry.doc.revision});mergeDocument(entry,result);entry.quote=null;const asset=entry.doc.characterAssets?.at(-1);if(asset)focusCard(entry,asset.nodeId);entry.ui.editorOpen=false;renderAll(entry);}catch(error){const errorBox=form.querySelector('[data-character-error]');if(errorBox)errorBox.textContent=error.message;else notifyError(entry,error);}finally{entry.busy='';}
      });
      entry.host.addEventListener('toggle',event=>{if(event.target.matches('[data-canvas-advanced]')){entry.ui.advancedOpen=event.target.open;saveUI(entry);}if(event.target.matches('.canvas-spend-options')){entry.ui.budgetOpen=event.target.open;saveUI(entry);}},true);
      entry.host.addEventListener('input',event=>{
        const input=event.target;if(input.closest('[data-canvas-editor]')&&!input.closest('[data-canvas-character-form]')&&!ensureEditorContext(entry,input))return;const item=node(entry);if(input.matches('[data-canvas-budget]')){entry.ui.budget=input.value;saveUI(entry);registerChange(entry);renderNotice(entry);return;}
        if(input.dataset.canvasFilter==='query'){entry.filters={...entry.filters,query:input.value};filterModels(entry);return;}
        if(!item)return;
        if(input.matches('[data-canvas-ai-instruction],[data-canvas-ai-suggestion]')){rememberEditorDraft(entry);return;}
        if(input.dataset.canvasField&&['title','prompt'].includes(input.dataset.canvasField)){item[input.dataset.canvasField]=input.value;collectEditor(entry);touch(entry);return;}
        if(input.matches('[data-model-param]'))collectParameterEdit(entry,input);
      });
      entry.host.addEventListener('change',event=>{
        const input=event.target;if(input.closest('[data-canvas-editor]')&&!input.closest('[data-canvas-character-form]')&&!ensureEditorContext(entry,input))return;const item=node(entry);if(input.dataset.canvasSelect){const target=node(entry,input.dataset.canvasSelect);if(target){target.selected=input.checked;touch(entry);}return;}
        if(input.matches('[data-canvas-budget]')){renderBatch(entry);return;}
        if(input.dataset.canvasFilter){entry.filters={...entry.filters,[input.dataset.canvasFilter]:input.value};filterModels(entry);return;}
        if(!item)return;
        if(input.matches('[data-canvas-aspect]')){collectEditor(entry);if(Controls.applyImageAspect(item,findModel(item),input.value)){touch(entry);renderEditor(entry,true);}return;}
        if(input.matches('[data-canvas-size]')){collectEditor(entry);if(Controls.applyImageSize(item,findModel(item),input.value)){touch(entry);renderEditor(entry,true);}return;}
        const field=input.dataset.canvasField;
        if(field&&!['title','prompt'].includes(field)){
          if(field==='modelId'){const previous=clone(item);entry.modelDrafts.set(item.id+':'+item.modelId,clone({parameters:item.parameters,parameterDraft:item.parameterDraft,promptField:item.promptField}));item.modelId=input.value;item.modelSelectionOrigin='user';const model=findModel(item),saved=entry.modelDrafts.get(item.id+':'+item.modelId);item.parameters=clone(saved?.parameters||carryRatio(previous,model?.defaults,model));item.parameterDraft=clone(saved?.parameterDraft||item.parameters);item.promptField=saved?.promptField||(model?.fields.some(field=>field.name==='prompt')?'prompt':'');}
          else item[field]=input.value;
          touch(entry);renderEditor(entry,true);return;
        }
        if(input.matches('[data-model-param]'))collectParameterEdit(entry,input);
      });
      const viewport=entry.host.querySelector('[data-canvas-viewport]');if(!viewport)return;let drag=null;
      viewport.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('input,video,select,textarea,a,button'))return;const handle=event.target.closest('[data-drag-node]');if(!handle&&event.target.closest('.canvas-node'))return;const item=handle?node(entry,handle.dataset.dragNode):null;if(item){entry.ui.activeId=item.id;saveUI(entry);renderEditor(entry);renderNodes(entry);}drag={pointer:event.pointerId,x:event.clientX,y:event.clientY,node:item,position:item?{...item.position}:{...entry.doc.viewport},moved:false};viewport.setPointerCapture(event.pointerId);viewport.classList.add('is-dragging');});
      viewport.addEventListener('pointermove',event=>{if(!drag||drag.pointer!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.moved=drag.moved||Math.abs(dx)+Math.abs(dy)>3;if(drag.node){drag.node.position={x:drag.position.x+dx/entry.doc.viewport.scale,y:drag.position.y+dy/entry.doc.viewport.scale};renderNodes(entry);}else{entry.doc.viewport.x=drag.position.x+dx;entry.doc.viewport.y=drag.position.y+dy;setTransform(entry);}});
      const end=event=>{if(!drag||drag.pointer!==event.pointerId)return;const moved=drag.moved;drag=null;viewport.classList.remove('is-dragging');if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);if(moved)touch(entry,{render:false,execution:false});};viewport.addEventListener('pointerup',end);viewport.addEventListener('pointercancel',end);
      viewport.addEventListener('wheel',event=>{if(!entry.doc||event.target.closest('video'))return;event.preventDefault();if(event.ctrlKey||event.metaKey){const rect=viewport.getBoundingClientRect();zoom(entry,Math.exp(-event.deltaY*.003),{x:event.clientX-rect.left,y:event.clientY-rect.top});}else{entry.doc.viewport.x-=event.deltaX;entry.doc.viewport.y-=event.deltaY;setTransform(entry);touch(entry,{render:false,execution:false});}},{passive:false});
    }
    function filterModels(entry){const item=node(entry);if(!item)return;const filtered=Runtime.filterMediaModels(models().filter(Runtime.modelAvailable),{kind:item.mediaKind,...entry.filters}),select=entry.host.querySelector('[data-canvas-model-select]');select.innerHTML='<option value="" disabled'+(!filtered.some(model=>modelId(model)===item.modelId)?' selected':'')+'>请选择模型（当前模型保留）</option>'+V.mediaModelOptions(filtered,item.modelId);entry.host.querySelector('[data-canvas-model-count]').textContent=filtered.filter(Runtime.modelAvailable).length+' 个可选接口';}
    function zoom(entry,factor,point){if(!entry.doc)return;const rect=entry.host.querySelector('[data-canvas-viewport]').getBoundingClientRect(),center=point||{x:rect.width/2,y:rect.height/2},prior=entry.doc.viewport,scale=Math.max(.18,Math.min(2,prior.scale*factor)),ratio=scale/prior.scale;entry.doc.viewport={x:center.x-(center.x-prior.x)*ratio,y:center.y-(center.y-prior.y)*ratio,scale};setTransform(entry);touch(entry,{render:false,execution:false});}
    function focus(context){focusRequest=context;const entry=entries.get(context.projectId);if(entry?.doc&&entry.host.isConnected){focusNode(entry,context);focusRequest=null;}}
    function dispose(){for(const entry of entries.values()){global.clearTimeout(entry.saveTimer);global.clearTimeout(entry.pollTimer);}entries.clear();}
    return {mount,mountAssets:(host,project)=>mount(host,project,'assets'),focusAssets:context=>{focusRequest=context;const entry=entries.get(context.projectId+':assets');if(entry?.doc&&entry.host.isConnected){focusNode(entry,context);focusRequest=null;}},update,focus,dispose,context:()=>current?.doc?{projectId:current.project.id,node:node(current),assets:current.doc.characterAssets||[],media:(runtime?.media?.jobs||[]).filter(job=>job.projectId===current.project.id)}:null,refresh:()=>current?load(current,true):Promise.resolve(),save:()=>current?save(current):Promise.resolve()};
  }
  const api={editorContextMatches,capturePromptDialogView,restorePromptDialogModal,previewFor,editorDraftFor,suggestionValue,characterSummary,mergeLocalNodes,entryNodes,currentCharacterAssets,productionNodes,selectedNodes,nodeBlocker,horizontalPositions,progressSummary,orderedJobs,registerChange,optionalBudget,sceneGroups,modelSummary,create,styles,combinedPrompt,prepareNode,referenceImage,fitViewport,activeBatch,parameterValues,carryRatio,matchesNodeJob,quoteSnapshot,quoteSnapshotCurrent,visibleCanvasNodes,trashTargets};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else global.StudioCanvas=api;
})(typeof window!=='undefined'?window:globalThis);
