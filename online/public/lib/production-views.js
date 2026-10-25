/* Production views render server evidence; no timers or simulated progress. */
(function (global) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const statusLabels = {running:'团队正在制作',awaiting_review:'等你审阅',paused:'已暂停',failed:'需要处理',completed:'文稿流程已验收'};
  const stageLabels = {pending:'等待上游',running:'正在制作',awaiting_review:'等你审阅',completed:'本阶段已交付',failed:'执行失败',stale:'待按新版本重做',paused:'已暂停'};
  const fileURL = value => typeof value === 'string' && /^\/api\/artifacts\/[A-Za-z0-9_-]+$/.test(value) ? value : '';
  const date = value => value ? new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'}) : '';
  function create(employees, production) {
    const trashButton=(kind,id,pid='',label='删除')=>global.StudioTrash?.deleteButton(kind,id,pid,label)||'';
    const byId = new Map(employees.map(item => [item.id,item]));
    const name = id => byId.get(id)?.name || id || '未分配';
    const avatar = id => byId.has(id) ? '<img class="avatar tiny" src="'+esc(byId.get(id).thumb)+'" alt="'+esc(name(id))+'" loading="lazy">' : '';
    const button = (label, action, id = '', disabled = false, extra = '', cls = 'button-secondary') => '<button type="button" class="'+cls+'" data-action="'+action+'"'+(id?' data-id="'+esc(id)+'"':'')+(disabled?' disabled':'')+extra+'>'+label+'</button>';
    const badge = (label, status = '') => '<span class="pill'+(['failed','awaiting_review','stale'].includes(status)?' warn':status==='completed'?' success':'')+'">'+esc(label)+'</span>';
    const draft = (ui,key,field,fallback='') => ui?.getDraft?.(key)?.[field] ?? fallback;
    const artifactLink = artifact => '<div class="trash-mini-row"><button type="button" class="production-file" data-action="production-artifact" data-id="'+esc(artifact.id)+'"><span aria-hidden="true">▤</span><span><strong>'+esc(artifact.title||artifact.filename||'交付文稿')+'</strong><small>查看全文与下载</small></span><span aria-hidden="true">↗</span></button>'+trashButton('artifact',artifact.id,artifact.projectId)+'</div>';
    function startForm(project,ui,{newRound=false,reviewMode}={}) {
      const key='start:'+project.id,busy=production?.isStarting?.(project.id),ready=production?.ready?.(),prompt=String(draft(ui,key,'prompt',project.brief||'')),hasPrompt=Boolean(prompt.trim());
      const requestedMode=draft(ui,key,'reviewMode',reviewMode??project.reviewMode??'stepwise'),mode=['stepwise','continuous'].includes(requestedMode)?requestedMode:'stepwise',disabled=busy||!ready;
      const modePicker='<div class="production-collaboration-mode"><label class="field-label" for="production-mode-'+esc(project.id)+'">协作方式<select class="select" id="production-mode-'+esc(project.id)+'" name="reviewMode" aria-describedby="production-mode-help-'+esc(project.id)+'">'+[['continuous','团队连续完成 · 文稿完成后统一审核'],['stepwise','逐步审核 · 剧本、美术设定、最终交付']].map(([value,label])=>'<option value="'+value+'"'+(mode===value?' selected':'')+'>'+label+'</option>').join('')+'</select></label><p class="collaboration-mode-help" id="production-mode-help-'+esc(project.id)+'">两种方式都由总策划确认最终文稿；图片与视频在人物资产、创作画布中继续制作。</p></div>';
      return '<section class="production-launch'+(newRound?'':' surface')+'"><form class="form-stack" data-form="production-start" data-project-id="'+esc(project.id)+'" data-draft-key="'+esc(key)+'"><div class="production-launch-heading"><div><h3>'+(newRound?'新一轮协作':'开始本项目协作')+'</h3><p>'+(hasPrompt?'已有项目说明已带入，可以直接开始。':'项目尚未填写说明，补充本次目标即可开始。')+'</p></div><button type="submit" class="button-primary"'+(disabled?' disabled':'')+'>'+(busy?'正在提交…':newRound?'开始新一轮 →':hasPrompt?'按现有说明开始 →':'开始协作 →')+'</button></div>'+modePicker+'<details class="production-start-options" data-runtime-detail="production-start-options-'+esc(project.id)+'"'+(!hasPrompt?' open':'')+'><summary>'+(hasPrompt?'查看或调整项目说明':'补充项目说明')+'</summary><label class="field-label" for="production-prompt-'+esc(project.id)+'">协作说明<textarea class="textarea" id="production-prompt-'+esc(project.id)+'" name="prompt" rows="3" maxlength="12000" placeholder="写下作品目标、受众和交付要求…" required>'+esc(prompt)+'</textarea></label></details>'+(!ready?'<p class="production-connection-note">'+(production?.enabled?.()?'文字执行器尚未就绪。':'当前预览仅展示界面。请打开独立工作台。')+button('检查连接','runtime-connect','',false,'','button-quiet')+'</p>':'')+'<p class="form-error" role="alert" hidden></p></form></section>';
    }
    function reviewForm(stage,plan,ui,canApprove) {
      const key='review:'+plan.id+':'+stage.id,busy=production?.isBusy(plan.id);
      const revision=Number(draft(ui,key,'expectedRevision',plan.revision)),outdated=revision!==plan.revision;
      const notice=stage.id==='delivery'?'负责人将生成新的交付版本，旧成果继续保留。':'负责人将重做本阶段，后续阶段会按新版本重新制作；旧成果继续保留。';
      return '<form class="production-review form-stack" data-form="production-review" data-id="'+esc(plan.id)+'" data-stage-id="'+esc(stage.id)+'" data-draft-key="'+esc(key)+'">'+
        '<input type="hidden" name="expectedRevision" value="'+esc(revision)+'">'+
        '<div><h4>'+(canApprove?'这版交付符合你的方向吗？':'定点返修 · '+esc(stage.title||stage.id))+'</h4><p>'+(canApprove?(stage.id==='delivery'?'确认后，先进入人物资产页查看角色设定并生成定妆图。人物准备好后，先核对分镜，再进入创作画布制作镜头图片与视频。':stage.id==='visual'&&stage.agentId==='R05'&&plan.reviewMode==='stepwise'?'确认美术设定后立即进入人物资产，先准备定妆图；镜头文稿会继续在后台协作。':'先查看上方完整成果。确认后团队继续交接；需要调整时填写具体意见。'):notice)+'</p></div>'+
        '<label class="field-label" for="production-note-'+esc(plan.id)+'-'+esc(stage.id)+'">'+(canApprove?'审阅意见':'修改要求')+'<textarea class="textarea" id="production-note-'+esc(plan.id)+'-'+esc(stage.id)+'" name="note" rows="3" maxlength="2000" placeholder="说明想保留什么、调整哪里…">'+esc(draft(ui,key,'note'))+'</textarea></label>'+
        (canApprove?'<p>选择「交回修改」时，'+notice+'</p>':'')+
        (outdated?'<p class="runtime-error">协作已在另一窗口或后续阶段更新。请重新查看最新成果，再确认使用当前版本。'+button('已查看最新版本','production-review-current',plan.id,busy,' data-stage-id="'+esc(stage.id)+'"','button-quiet')+'</p>':'')+
        '<div class="form-actions"><button type="submit" name="reviewAction" value="revise" class="button-secondary"'+(busy||outdated?' disabled':'')+'>交回修改</button>'+
        (canApprove?'<button type="submit" name="reviewAction" value="approve" class="button-primary"'+(busy||outdated?' disabled':'')+'>'+(stage.id==='delivery'?'确认文稿并进入人物资产 →':stage.id==='visual'&&stage.agentId==='R05'&&plan.reviewMode==='stepwise'?'确认设定，进入人物资产 →':'认可这版，继续 →')+'</button>':'')+
        '</div><p class="form-error" role="alert" hidden></p></form>';
    }
    function stageCard(stage,index,plan,ui,historical=false) {
      const artifacts=Array.isArray(stage.artifacts)?stage.artifacts:[],history=Array.isArray(stage.history)?stage.history:[];
      const reviewable=!historical&&stage.status==='awaiting_review'&&plan.status==='awaiting_review';
      const canRevise=!historical&&artifacts.length>0;
      const hasDraft=Boolean(draft(ui,'review:'+plan.id+':'+stage.id,'note'));
      const revisionPanel=reviewable?reviewForm(stage,plan,ui,true):canRevise?'<details class="production-revise" data-runtime-detail="production-revise-'+esc(plan.id)+'-'+esc(stage.id)+'"'+(hasDraft?' open':'')+'><summary>修改这个阶段</summary>'+reviewForm(stage,plan,ui,false)+'</details>':'';
      return '<article class="production-stage is-'+esc(stage.status)+'" data-stage-id="'+esc(stage.id)+'"><div class="production-stage-main"><span class="production-stage-number">'+String(index+1).padStart(2,'0')+'</span><div class="production-stage-copy"><div class="production-stage-title"><h3>'+esc(stage.title||stage.id)+'</h3>'+badge(stageLabels[stage.status]||'状态待确认',stage.status)+'</div><div class="production-stage-owner">'+avatar(stage.agentId)+'<span>'+esc(name(stage.agentId))+'<small>'+esc(stage.agentId)+(stage.attempt?' · 第 '+esc(stage.attempt)+' 次制作':'')+'</small></span></div></div></div>'+
        (artifacts.length?'<div class="production-files">'+artifacts.map(artifactLink).join('')+'</div>':'')+
        (stage.status==='running'?'<p class="production-stage-note" role="status">正在读取上游成果并制作本阶段交付，收到真实结果后自动更新。</p>':'')+
        (stage.status==='stale'?'<p class="production-stage-note">上游已返修，后续将使用新版本重做。旧成果保留在历史版本中。</p>':'')+
        (stage.error?'<p class="runtime-error" role="alert">'+esc(typeof stage.error==='string'?stage.error:JSON.stringify(stage.error))+'</p>':'')+revisionPanel+
        (history.some(item=>item.artifacts?.length)?'<details class="production-history" data-runtime-detail="production-history-'+esc(plan.id)+'-'+esc(stage.id)+'"><summary>历史版本 · '+history.filter(item=>item.artifacts?.length).length+' 次</summary>'+history.filter(item=>item.artifacts?.length).slice().reverse().map(attempt=>'<div class="production-history-attempt"><p class="small muted">第 '+esc(attempt.attempt||1)+' 次制作 · '+esc(date(attempt.archivedAt))+'</p>'+attempt.artifacts.map(artifactLink).join('')+'</div>').join('')+'</details>':'')+'</article>';
    }
    function planView(plan, ui, historical=false) {
      const stages=Array.isArray(plan.stages)?plan.stages:[], busy=production?.isBusy(plan.id), count=stages.filter(stage=>stage.status==='completed').length;
      const next=stages.find(stage=>stage.id===plan.currentStageId)||stages.find(stage=>['running','awaiting_review','failed','paused'].includes(stage.status));
      const actions=historical?'':plan.status==='running'||plan.status==='awaiting_review'?button('暂停协作','production-pause',plan.id,busy,' data-revision="'+esc(plan.revision)+'"'):['paused','failed'].includes(plan.status)?button(plan.status==='failed'?'从本步继续':'继续协作','production-resume',plan.id,busy,' data-revision="'+esc(plan.revision)+'"','button-primary'):'';
      return '<section class="production-plan surface"><div class="production-section-heading"><div><p class="eyebrow">'+(historical?'历史协作':'本次自动协作')+' · '+esc(date(plan.createdAt))+'</p><h2>'+esc(statusLabels[plan.status]||'状态待确认')+'</h2></div><div class="production-toolbar">'+(!historical&&plan.status==='completed'?button('进入人物资产 →','production-tools','',false,'','button-primary'):'')+actions+(['completed','failed','paused','cancelled'].includes(plan.status)?trashButton('production',plan.id,plan.projectId,'删除本轮协作'):'')+button('刷新','production-refresh',plan.projectId,busy,'','button-quiet')+'</div></div><p class="production-brief">'+esc(plan.prompt)+'</p><div class="production-progress-summary"><span>'+count+' / '+stages.length+' 个阶段已交付</span><span>'+esc(plan.reviewMode==='continuous'?'连续协作 · 最终审阅':'逐步审阅')+'</span>'+(next?'<strong>当前 · '+esc(next.title||next.id)+'</strong>':'')+'</div><ol class="production-track" aria-label="真实制作进度">'+stages.map((stage,i)=>'<li class="is-'+esc(stage.status)+'"><span>'+String(i+1)+'</span><strong>'+esc(stage.title||stage.id)+'</strong><small>'+esc(stageLabels[stage.status]||'待确认')+'</small></li>').join('')+'</ol>'+(plan.status==='paused'?'<p class="context-note">协作已暂停。已产出的文件仍可查看，继续时会保留已有成果。</p>':'')+(plan.status==='failed'?'<p class="runtime-error" role="alert">'+esc(plan.error||'本阶段未完成。查看下方原因后，可从当前步骤继续。')+'</p>':'')+'<div class="production-stages">'+stages.map((stage,i)=>stageCard(stage,i,plan,ui,historical)).join('')+'</div><div class="production-media-note"><span aria-hidden="true">▧</span><div><strong>图片与视频制作</strong><p>'+esc(plan.status==='completed'?'文稿与美术设定已确认。先在人物资产页准备定妆图，再核对分镜，随后进入创作画布；提示词和模型参数会自动带入。':plan.mediaReadiness?.label||'团队正在准备逐镜画面和生成提示词。')+'</p>'+button(plan.status==='completed'?'进入人物资产':'查看人物资产','production-tools','',false,'','button-quiet')+'</div></div><details class="production-events" data-runtime-detail="production-events-'+esc(plan.id)+'"><summary>真实协作记录 · '+(plan.events||[]).length+' 条</summary><ol>'+(plan.events||[]).slice().reverse().map(event=>'<li><time>'+esc(date(event.at))+'</time><span>'+(event.agentId?esc(name(event.agentId))+' · ':'')+esc(event.text||event.type)+'</span></li>').join('')+'</ol></details></section>';
    }
    function workspace(project, ui={}) {
      if(project.kind==='game')return '<section class="production-start surface"><h2>影视自动协作</h2><p>当前流程面向剧本、分镜和生成输入。游戏项目可继续使用右侧的团队对话。</p></section>';
      const plans=production?.getProductions(project.id)||[], latest=plans[plans.length-1], error=production?.getError(project.id), ongoing=latest&&production.active(latest);
      const launcher=!latest?startForm(project,ui):!ongoing?'<details class="production-new-round" data-runtime-detail="production-new-round-'+esc(project.id)+'"><summary>发起新一轮协作</summary>'+startForm(project,ui,{newRound:true,reviewMode:latest.reviewMode})+'</details>':'';
      return '<div class="production-workspace">'+(error?'<div class="runtime-error" role="alert">'+esc(error)+' '+button('刷新协作记录','production-refresh',project.id,false,'','button-quiet')+'</div>':'')+(latest?planView(latest,ui):'')+(plans.length>1?'<details class="production-older" data-runtime-detail="production-older-'+esc(project.id)+'"><summary>此前协作 · '+(plans.length-1)+' 次</summary>'+plans.slice(0,-1).reverse().map(plan=>planView(plan,ui,true)).join('')+'</details>':'')+launcher+'</div>';
    }
    function artifactDetails(artifact) {
      const plan=production?.find(artifact.productionId), stage=plan?.stages?.find(item=>item.id===artifact.stageId), url=fileURL(artifact.url);
      return '<p class="eyebrow">自动协作成果 · '+esc(name(artifact.authorId||stage?.agentId))+(artifact.archived?' · 历史版本':'')+'</p><h2>'+esc(artifact.title||artifact.filename||'交付文稿')+'</h2><p class="small muted">'+esc(stage?.title||'')+' · '+esc(artifact.filename||'文稿')+'</p><pre class="runtime-full-text">'+esc(artifact.body||artifact.preview||'暂无文本预览，请下载查看。')+'</pre><p class="context-note">这是文字交付，媒体生成与实际播放验收单独记录。修改当前版本请回到相应阶段填写审阅意见。</p><div class="form-actions">'+(url?'<a class="button-secondary" href="'+esc(url)+'" download="'+esc(artifact.filename||'团队交付.md')+'">下载完整成果 ↓</a>':'')+trashButton('artifact',artifact.id,artifact.projectId)+button('返回协作','close-dialog')+'</div>';
    }
    return {workspace,artifactDetails};
  }
  const api={create,esc,fileURL};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else global.StudioProductionViews=api;
})(typeof window!=='undefined'?window:globalThis);
