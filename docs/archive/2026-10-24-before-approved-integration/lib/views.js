/* Presentation only. Project state and task rules live in store.js. */
(function (global) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {queued:'待安排',in_progress:'手动推进中',review:'待复核',done:'手动登记完成',rework:'需返修'};
  const kinds = {hybrid:'影视 × 游戏',film:'影视项目',game:'游戏项目'};
  function create(employees, store) {
    const byId = new Map(employees.map(e => [e.id,e]));
    const person = id => byId.get(id);
    const name = id => person(id)?.name || id || '未分配';
    const avatar = (id,cls='',full=false) => {const e=person(id);return e?'<img class="avatar '+cls+'" src="'+esc(full?e.portrait:e.thumb)+'" alt="'+esc(e.name)+'" loading="lazy">':'<span class="avatar '+cls+' planner-avatar">你</span>';};
    const button = (label,action,id='',cls='button-secondary') => '<button type="button" class="'+cls+' cursor-interaction" data-action="'+action+'"'+(id?' data-id="'+esc(id)+'"':'')+'>'+label+'</button>';
    const badge = (text,cls='') => '<span class="pill '+cls+'">'+esc(text)+'</span>';
    const project = state => state.projects.find(p=>p.id===state.activeProjectId) || state.projects[0];
    const tasks = (state,pid) => state.tasks.filter(t=>t.projectId===pid);
    const blocked = t => t.status!=='done' && store.blockers(t.id).length>0;
    const status = t => blocked(t)?'等待依赖 / 拍板':labels[t.status];
    const statusBadge = t => badge(status(t),blocked(t)?'warn':t.status==='done'?'success':t.status==='rework'?'warn':'');
    const empty = (title,text,action='') => '<div class="empty-state"><h2>'+esc(title)+'</h2><p>'+esc(text)+'</p>'+action+'</div>';
    const selectProject = state => '<label class="field-label">当前项目<select class="select" id="project-picker" aria-label="切换当前项目">'+state.projects.map(p=>'<option value="'+esc(p.id)+'"'+(p.id===state.activeProjectId?' selected':'')+'>'+esc(p.title)+(p.isDemo?' · 示例':'')+'</option>').join('')+'</select></label>';
    const header = (title,description,action='') => '<div class="section-head"><div><h2>'+esc(title)+'</h2>'+(description?'<p class="muted">'+esc(description)+'</p>':'')+'</div>'+action+'</div>';
    function sidebar(state) {
      const projects=state.projects.map(p=>'<button type="button" class="sidebar-project cursor-interaction'+(p.id===state.activeProjectId&&state.view==='project'&&!state.activePeerId?' is-active':'')+'" data-action="select-project" data-id="'+esc(p.id)+'"><span class="project-symbol" aria-hidden="true">▧</span><span class="sidebar-item-title">'+esc(p.title)+'</span>'+(p.isDemo?'<span class="sidebar-item-subtitle">示例</span>':'')+'</button>').join('');
      const ids=[...new Set([...state.favorites,'R11','G01','R03','R04','G03','R08'])].slice(0,6);
      const partners=ids.map(id=>{const e=person(id);return '<button type="button" class="sidebar-person cursor-interaction'+(state.activePeerId===id&&state.view==='project'?' is-active':'')+'" data-action="open-dm" data-id="'+id+'">'+avatar(id)+'<span class="sidebar-person-copy"><span class="sidebar-item-title">'+esc(e.name)+'</span><span class="sidebar-item-subtitle">'+esc(e.short)+'</span></span></button>';}).join('');
      return {projects,partners};
    }
    function decisionCard(d,state,compact=false) {
      const p=state.projects.find(p=>p.id===d.projectId);
      return '<article class="decision-card">'+badge(d.status==='approved'?'已记录拍板':d.status==='rework'?'已退回调整':'等你拍板',d.status==='approved'?'success':'warn')+'<h3>'+esc(d.title)+'</h3><p class="small muted">'+esc(p?.title||'')+(p?.isDemo?' · 协作示例':'')+'</p><div class="decision-options">'+d.options.map(o=>'<span>'+esc(o)+'</span>').join('<span aria-hidden="true">/</span>')+'</div>'+(d.selected?'<p class="small">已选：'+esc(d.selected)+'</p>':'')+button(d.status==='approved'?'查看 / 调整决定':'查看选项与影响','open-decision',d.id,compact?'button-quiet':'button-secondary')+'</article>';
    }
    function overview(state) {
      const p=project(state), pending=state.decisions.filter(d=>d.status!=='approved');
      const waiting=state.tasks.filter(blocked), ready=state.tasks.filter(t=>t.status==='queued'&&!blocked(t));
      const projectCards=state.projects.map(item=>'<article class="project-card home-project-card"><div class="home-project-top"><span class="project-kind-symbol '+esc(item.kind)+'" aria-hidden="true">'+(item.kind==='game'?'✦':item.kind==='film'?'▰':'◈')+'</span><div class="project-card-meta">'+badge(kinds[item.kind])+(item.isDemo?badge('协作示例','demo'):badge('本地手动项目'))+'</div><span class="project-card-arrow" aria-hidden="true">↗</span></div><h3 class="project-card-title">'+esc(item.title)+'</h3><p class="muted home-project-brief">'+esc(item.brief)+'</p><div class="project-card-members"><span class="avatar-stack">'+item.members.slice(0,4).map(id=>avatar(id,'tiny')).join('')+'</span><span class="small muted">'+item.members.length+' 位伙伴 · '+tasks(state,item.id).length+' 项任务</span>'+button('继续创作 ↗','select-project',item.id,'button-quiet')+'</div></article>').join('');
      const readyCards=ready.length?ready.slice(0,3).map(t=>'<button class="task-mini cursor-interaction" type="button" data-action="open-task" data-id="'+esc(t.id)+'">'+avatar(t.ownerId,'tiny')+'<span><strong>'+esc(t.title)+'</strong><small>'+esc(name(t.ownerId))+' <span aria-hidden="true">→</span> '+esc(name(t.reviewerId))+'</small></span>'+statusBadge(t)+'</button>').join(''):'<p class="context-note">先完成上游交付，或处理待决策事项，再继续安排。</p>';
      return `
        <section class="studio-home-hero" aria-labelledby="home-hero-title">
          <div class="studio-hero-copy">
            <p class="studio-hero-kicker"><span class="studio-spark" aria-hidden="true">✳</span> 总策划，欢迎回到你的工作室</p>
            <h2 id="home-hero-title">下一部好作品，<br><span>从这里开场。</span></h2>
            <p class="studio-hero-description">把一句想法变成清楚的项目，<br>和合适的伙伴，一起走到作品完成。</p>
            <div class="studio-hero-actions">${button('＋ 发起新项目','new-project','','button-primary')}${p?button('回到创作现场 ↗','select-project',p.id,'button-quiet'):''}</div>
            <div class="studio-color-notes" aria-hidden="true"><i></i><i></i><i></i><span>MAKE SOMETHING WONDERFUL</span></div>
          </div>
          <div class="studio-hero-visual">
            <img class="studio-scene-image" src="assets/scenes/studio-hero.webp" alt="可爱的3D影视与游戏伙伴，在微型创作工作室里共同讨论作品" fetchpriority="high" decoding="async">
            <span class="studio-scene-caption"><span aria-hidden="true">✦</span> 灵感，在这里汇合</span>
            <span class="studio-sticker"><span>影视 × 游戏</span><strong>${employees.length} 位创作伙伴</strong><i aria-hidden="true">↗</i></span>
          </div>
        </section>
        <div class="studio-home-meta">
          <div class="creative-process" aria-label="创作流程示意，不代表实际进度"><span>创意</span><i aria-hidden="true">→</i><span>故事</span><i aria-hidden="true">→</i><span>镜头 / 玩法</span><i aria-hidden="true">→</i><span>交付</span></div>
          <div class="studio-live-context"><span><b>${state.projects.length}</b> 个本地项目</span><span><b>${pending.length}</b> 项等你拍板</span><span><b>${waiting.length}</b> 项等待依赖</span></div>
        </div>
        <section class="creation-gates" aria-label="选择新的创作方向">
          <article class="creation-gate film-gate">
            <div class="creation-gate-copy"><p class="creation-gate-kicker">FILM & ANIMATION <span aria-hidden="true">01</span></p><h2>把故事，拍成画面。</h2><p>短片 · 宣传片 · 动画 · 漫剧</p>${button('开始影视项目 ↗','new-project','film','creation-gate-button')}</div>
            <img src="assets/scenes/film-world.webp" alt="杏桃色微型电影工作室，电影机、胶片与摄影棚道具" loading="eager" decoding="async">
            <span class="gate-doodle" aria-hidden="true">✳</span>
          </article>
          <article class="creation-gate game-gate">
            <div class="creation-gate-copy"><p class="creation-gate-kicker">GAMES & PLAY <span aria-hidden="true">02</span></p><h2>让想象，变得好玩。</h2><p>玩法 · 关卡 · 美术 · 交互体验</p>${button('开始游戏项目 ↗','new-project','game','creation-gate-button')}</div>
            <img src="assets/scenes/game-world.webp" alt="淡紫色的游戏创作小世界，手柄与悬浮游戏小岛" loading="eager" decoding="async">
            <span class="gate-doodle" aria-hidden="true">✧</span>
          </article>
        </section>
        <div class="overview-columns studio-desk-columns">
          <section class="studio-project-desk">
            ${header('创作桌上','项目、任务和成果，接着上一次往下做。',button('全部任务 ↗','navigate-tasks','','button-quiet'))}
            <div class="project-list">${projectCards||empty('第一部作品，从一个想法开始','选择影视或游戏方向，建立你的第一个本地项目。',button('发起新项目','new-project','','button-primary'))}</div>
            <section class="home-ready-section">${header('下一步，做这些','按依赖筛选的本地待办，尚未开始执行。')}<div class="next-actions overview-ready-list">${readyCards}</div></section>
          </section>
          <aside class="studio-attention-desk">
            <section class="desk-inbox"><div class="desk-inbox-heading"><span class="desk-inbox-symbol" aria-hidden="true">✦</span><div><h2>等你定方向</h2><p>把关键取舍，留给总策划。</p></div><span class="desk-count">${pending.length}</span></div>${pending.length?pending.slice(0,3).map(d=>decisionCard(d,state,true)).join(''):empty('方向清楚，可以接着走','暂时没有待拍板事项，已记录的决定可在项目中查看。')}</section>
            <section class="home-records">${header('工作室手记','留下每一次决定与交接。')}${activity(state,5)}</section>
          </aside>
        </div>`;
    }
    function activity(state,limit=12) {
      return '<div class="activity-list">'+(state.activity.length?[...state.activity].reverse().slice(0,limit).map(a=>'<article class="activity-item"><span class="activity-time">'+esc(new Date(a.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'}))+'</span><div><strong>'+esc(a.label)+'</strong><p>'+esc(a.detail)+'</p></div></article>').join(''):'<p class="muted small">创建项目、登记任务或保存便笺后，这里会留下记录。</p>')+'</div>';
    }
    function taskSummary(t,state) {
      return '<button class="task-mini cursor-interaction'+(state.selectedTaskId===t.id?' is-selected':'')+'" type="button" data-action="select-task" data-id="'+esc(t.id)+'">'+avatar(t.ownerId,'tiny')+'<span><strong>'+esc(t.title)+'</strong><small>'+esc(name(t.ownerId))+' · '+esc(status(t))+'</small></span></button>';
    }
    function inspector(state,p) {
      const list=tasks(state,p.id), t=list.find(t=>t.id===state.selectedTaskId)||list[0];
      return '<aside class="inspector"><section class="inspector-section">'+header('项目上下文','同一版目标，交给同一组伙伴。')+'<p class="context-note">'+esc(p.brief||'项目简报尚未补充。')+'</p><div class="participant-row">'+p.members.map(id=>'<button type="button" class="button-quiet cursor-interaction" data-action="open-employee" data-id="'+id+'" aria-label="查看'+esc(name(id))+'工位">'+avatar(id,'tiny')+'</button>').join('')+'</div></section><section class="inspector-section">'+header('任务与交接',list.length+' 项本地任务',button('＋','new-task',p.id,'icon-button'))+'<div class="task-summary">'+list.map(item=>taskSummary(item,state)).join('')+'</div></section>'+(t?'<section class="inspector-section"><h3 class="inspector-title">'+esc(t.title)+'</h3>'+statusBadge(t)+'<p class="small">负责 '+esc(name(t.ownerId))+' → 复核 '+esc(name(t.reviewerId))+'</p><p class="context-note">'+esc(t.deliverable||'交付预期尚未填写。')+'</p>'+(store.blockers(t.id).length?'<ul class="dependency-list">'+store.blockers(t.id).map(b=>'<li>'+esc(b)+'</li>').join(''):'<p class="small muted">上游与决策条件已满足，可以安排。</p>')+button('查看与登记进展','open-task',t.id)+'</section>':'')+'<section class="inspector-section">'+header('共享成果','来源、版本与正文可回看。',button('＋','new-artifact',p.id,'icon-button'))+state.artifacts.filter(a=>a.projectId===p.id).map(a=>'<button type="button" class="artifact-mini cursor-interaction" data-action="open-artifact" data-id="'+esc(a.id)+'"><span aria-hidden="true">▤</span><span><strong>'+esc(a.title)+'</strong><small>'+esc(a.version)+' · '+(a.source==='example'?'示例文稿':'手动登记')+'</small></span><span aria-hidden="true">↗</span></button>').join('')+'</section></aside>';
    }
    function collaboration(state,draft='') {
      const peer=person(state.activePeerId),p=project(state);
      if(!peer&&!p)return empty('先发起一个项目','选择目标和伙伴，建立你的创作空间。',button('发起项目','new-project','','button-primary'));
      const messages=state.messages.filter(m=>peer?m.peerId===peer.id:m.projectId===p.id&&!m.peerId);
      const title=peer?peer.name:p.title;
      const subtitle=peer?peer.title:(p.isDemo?'协作示例 · '+kinds[p.kind]:'本地项目 · '+kinds[p.kind]);
      const stream=messages.length?messages.map(m=>'<article class="message'+(m.authorId==='user'?' user':'')+'"><div class="message-avatar">'+avatar(m.authorId,'')+'</div><div class="message-content"><div class="message-meta"><strong>'+esc(m.authorId==='user'?'你 · 总策划':m.authorId==='system'?'工作台':name(m.authorId))+'</strong>'+badge(m.isExample?'示例对话':'本地便笺',m.isExample?'demo':'')+'<time>'+esc(new Date(m.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'}))+'</time></div><p class="message-text">'+esc(m.text)+'</p></div></article>').join(''):empty(peer?'给 '+peer.name+' 留一条工作便笺':'从一份清楚的项目简报开始','写下目标、参考和交付要求；当前内容只保存在本地。');
      const mentions=(peer?[peer.id]:p.members).slice(0,7).map(id=>'<button class="mention-chip cursor-interaction" type="button" data-action="mention" data-id="'+id+'">@'+esc(name(id))+'</button>').join('');
      const rail=peer?'<aside class="inspector"><section class="inspector-section">'+avatar(peer.id,'large')+'<h2>'+esc(peer.name)+'</h2><p>'+esc(peer.title)+'</p><p class="context-note">'+esc(peer.summary)+'</p>'+button('查看完整工位','open-employee',peer.id)+'</section><section class="inspector-section">'+header('参与的本地任务','职责与交付均关联项目。')+(state.tasks.filter(t=>t.ownerId===peer.id||t.reviewerId===peer.id).map(t=>taskSummary(t,state)).join('')||'<p class="muted small">还没有分配任务。</p>')+'</section></aside>':inspector(state,p);
      return '<div class="board-toolbar">'+selectProject(state)+(peer?button('返回项目群组','select-project',p?.id):button('＋ 新建任务','new-task',p.id))+'</div><div class="collaboration-layout"><section class="conversation-panel"><header class="conversation-header"><div class="participant-row">'+(peer?avatar(peer.id):'<span class="avatar-stack">'+p.members.slice(0,4).map(id=>avatar(id,'tiny')).join('')+'</span>')+'<div><h2>'+esc(title)+'</h2><p class="small muted">'+esc(subtitle)+'</p></div></div>'+(peer?badge('独立工位'):badge(p.members.length+' 位伙伴'))+'</header>'+(!peer&&p.isDemo?'<p class="context-note">下方角色发言为预设协作示例。你的新便笺仅在本地保存，不会触发员工执行。</p>':'')+'<div class="conversation-stream">'+stream+'</div><form class="composer" data-form="message"><label class="composer-label" for="message-text">'+(peer?'给 '+esc(peer.name)+' 的工作便笺':'给项目组的工作便笺')+'</label><div class="mention-row">'+mentions+'</div><textarea class="composer-input" id="message-text" name="text" rows="3" maxlength="2000" placeholder="写下任务、参考资料，或需要调整的方向…" required>'+esc(draft)+'</textarea><div class="composer-footer"><span class="small muted">仅保存本地 · 执行器未接入</span><button class="button-primary cursor-interaction" type="submit">保存便笺 ↑</button></div></form></section>'+rail+'</div>';
    }
    function board(state) {
      const p=project(state);if(!p)return empty('还没有项目','先创建项目，再按依赖组织任务。',button('发起项目','new-project'));
      const columns=[['queued','待安排'],['in_progress','推进 / 返修'],['review','待复核'],['done','已登记完成']];
      return '<div class="board-toolbar">'+selectProject(state)+'<span class="small muted">'+(p.isDemo?'示例状态':'所有状态由你手动登记')+' · 不代表真实自动执行</span>'+button('＋ 新建任务','new-task',p.id,'button-primary')+'</div><div class="kanban-board">'+columns.map(([key,label])=>{const list=tasks(state,p.id).filter(t=>key==='in_progress'?['in_progress','rework'].includes(t.status):t.status===key);return '<section class="kanban-column"><header class="kanban-heading"><h2>'+label+'</h2><span>'+list.length+'</span></header><div class="kanban-list">'+list.map(t=>'<button type="button" class="task-card cursor-interaction" data-action="open-task" data-id="'+esc(t.id)+'"><div class="task-card-header">'+badge(t.id.startsWith('demo-')?'示例任务':'手动任务',t.id.startsWith('demo-')?'demo':'')+'<span aria-hidden="true">↗</span></div><h3 class="task-card-title">'+esc(t.title)+'</h3><p>'+esc(t.deliverable)+'</p>'+(blocked(t)?'<p class="blocked-note">'+esc(store.blockers(t.id)[0])+'</p>':'')+'<div class="task-card-footer">'+avatar(t.ownerId,'tiny')+'<span>'+esc(name(t.ownerId))+'</span><small>复核 '+esc(name(t.reviewerId))+'</small></div></button>').join('')+(!list.length?'<p class="small muted">暂无任务</p>':'')+'</div></section>';}).join('')+'</div>'+header('项目决策','调整方向后，受影响的下游会回到待安排。')+'<div class="artifact-grid">'+state.decisions.filter(d=>d.projectId===p.id).map(d=>decisionCard(d,state)).join('')+'</div>';
    }
    function team(state) {
      const q=state.query.trim().toLocaleLowerCase();
      const list=employees.filter(e=>(state.filter==='all'||e.team===state.filter||state.filter==='favorites'&&state.favorites.includes(e.id))&&(!q||[e.id,e.name,e.title,e.summary,...e.tags].join(' ').toLocaleLowerCase().includes(q)));
      const page=Math.min(state.page,Math.max(1,Math.ceil(list.length/12)));
      const filters=[['all','全部 · 21'],['film','影视 · 16'],['game','游戏 · 5'],['favorites','收藏伙伴']];
      return header('每位伙伴，都有自己的专长','独立职责与会话，共用项目事实和成果。')+'<div class="team-toolbar"><div class="filter-group">'+filters.map(([id,label])=>'<button type="button" class="filter-button cursor-interaction'+(id===state.filter?' is-active':'')+'" data-action="filter" data-id="'+id+'" aria-pressed="'+(id===state.filter)+'">'+label+'</button>').join('')+'</div><label class="search-field"><span class="sr-only">搜索伙伴</span><input id="search-input" type="search" value="'+esc(state.query)+'" maxlength="100" placeholder="搜索姓名、岗位、职责"></label></div><div class="directory-meta"><p id="employee-count">找到 '+list.length+' 位伙伴</p><span class="small muted">人物均为原创虚构设定</span></div><div class="employee-grid">'+list.slice((page-1)*12,page*12).map(e=>'<article class="employee-card"><div class="employee-portrait"><img src="'+esc(e.thumb)+'" alt="'+esc(e.name)+'的可爱3D全身人物图" loading="lazy"><span class="employee-code">'+e.id+'</span><button type="button" class="favorite-button cursor-interaction'+(state.favorites.includes(e.id)?' is-active':'')+'" data-action="favorite" data-id="'+e.id+'" aria-label="'+(state.favorites.includes(e.id)?'取消收藏':'收藏')+esc(e.name)+'" aria-pressed="'+state.favorites.includes(e.id)+'">'+(state.favorites.includes(e.id)?'★':'☆')+'</button></div><div class="employee-info"><div class="employee-heading"><h3 class="employee-name">'+esc(e.name)+'</h3><span class="small muted">'+(e.team==='film'?'影视':'游戏')+'</span></div><p class="employee-role">'+esc(e.short)+'</p><p class="employee-summary">'+esc(e.summary)+'</p><div class="employee-tags">'+e.tags.map(t=>'<span>'+esc(t)+'</span>').join('')+'</div><div class="detail-actions">'+button('进入会话 ↗','open-dm',e.id,'open-workstation')+button('岗位详情','open-employee',e.id,'button-quiet')+'</div></div></article>').join('')+'</div>'+(!list.length?empty('还没有找到伙伴','换个关键词，或试试其他团队筛选。'):'')+'<nav class="pagination" aria-label="团队分页">'+(list.length>12?Array.from({length:Math.ceil(list.length/12)},(_,i)=>'<button type="button" class="page-button cursor-interaction'+(page===i+1?' is-active':'')+'" data-action="page" data-id="'+(i+1)+'"'+(page===i+1?' aria-current="page"':'')+'>'+(i+1)+'</button>').join(''):'')+'</nav>';
    }
    function artifacts(state) {
      const p=project(state), list=state.artifacts.filter(a=>a.projectId===p?.id);
      return '<div class="board-toolbar">'+selectProject(state)+(p?button('＋ 登记成果','new-artifact',p.id,'button-primary'):'')+'</div>'+header('一个项目，一份共享成果','保留来源、版本和任务关系，方便伙伴接着做。')+'<div class="artifact-grid">'+list.map(a=>'<article class="artifact-card"><div class="project-card-meta">'+badge(a.source==='example'?'示例文稿':'手动登记',a.source==='example'?'demo':'')+'<span class="small muted">'+esc(a.version)+'</span></div><h3>'+esc(a.title)+'</h3><p class="artifact-body">'+esc(a.body.slice(0,140))+'</p><p class="small muted">'+esc(state.tasks.find(t=>t.id===a.taskId)?.title||'项目共享资料')+'</p>'+button('打开正文 ↗','open-artifact',a.id,'button-quiet')+'</article>').join('')+'</div>'+(!list.length?empty('这里还没有成果','把文稿或交付说明登记到项目中，让下一位伙伴找得到。'):'')+header('人物资产','21 张最新可爱3D人物图已保留。')+'<div class="avatar-stack">'+employees.map(e=>'<button type="button" class="button-quiet cursor-interaction" data-action="open-employee" data-id="'+e.id+'" aria-label="查看'+esc(e.name)+'人物图">'+avatar(e.id)+'</button>').join('')+'</div>';
    }
    function connections() {
      return header('把能力接到工作流里','当前可以组织工作、保存本地记录；执行与外部服务尚未连接。')+'<div class="connection-grid">'+[['◈','模型与员工执行器','独立会话、任务上下文和结果事件接口已分层；尚未调用任何模型。'],['▤','知识与素材来源','预留 Obsidian / 飞书来源关系；当前未自动读取、同步或上传。'],['▷','图像、视频与游戏工具','当前可查看已有21张人物图；没有自动生成、渲染、构建或发布。']].map(([icon,title,text])=>'<article class="connection-card"><span class="connection-icon" aria-hidden="true">'+icon+'</span><h3>'+title+'</h3>'+badge('未接入','demo')+'<p>'+text+'</p></article>').join('')+'</div><section class="surface">'+header('本地工作台能力','数据保存在当前浏览器；可导出快照留存。',button('导出 JSON 备份','export-state'))+'<div class="capability-table"><div><strong>已可用</strong><span>项目 / 任务 / 便笺 / 依赖与决策 / 成果正文 / 收藏 / 旧版迁移</span></div><div><strong>尚未实现</strong><span>真实 Agent 回复、后台持续执行、多人同步、外部通知与发布</span></div><div><strong>你的权限</strong><span>项目总策划，决定方向与验收；手动记录不替代实际执行证据</span></div></div></section>'+header('协作记录','操作来源与交接意图可以追溯。')+activity(store.getState(),20);
    }
    const field=(label,value)=>'<div class="detail-field"><h3>'+label+'</h3><p>'+esc(value)+'</p></div>';
    function employeeDetails(e,state,inline) {
      return '<div class="employee-detail-layout"><div><img class="detail-portrait" src="'+esc(e.portrait)+'" alt="'+esc(e.name)+'完整人物图">'+badge('原创虚构人物','demo')+'</div><div><p class="eyebrow">独立工位 · '+e.id+'</p><h2>'+esc(e.name)+'</h2><p>'+esc(e.title)+'</p><p class="muted">'+esc(e.summary)+'</p><div class="detail-fields">'+field('收到什么',e.input)+field('负责什么',e.task)+field('交付什么',e.output)+field('专业复核',e.review)+field('交给谁',e.next)+field('职责边界',e.boundary)+'</div><div class="detail-actions">'+button('进入独立会话','open-dm',e.id,'button-primary')+(!inline?'<a class="button-secondary" href="'+esc(e.portrait)+'" download="'+e.id+'_'+esc(e.name)+'.png">保存人物图 ↓</a>':'')+'</div></div></div>';
    }
    function projectForm() {
      const template=global.STUDIO_TEMPLATES.hybrid;
      return '<h2>发起新项目</h2><p class="muted">先定目标，再让合适的伙伴一起进入项目。</p><form class="form-stack" data-form="new-project"><label class="field-label">项目名称<input class="field" name="title" maxlength="120" placeholder="例如：一支关于城市夜归人的短片" required></label><label class="field-label">项目简报<textarea class="textarea" name="brief" rows="3" maxlength="4000" placeholder="想表达什么？做给谁看？希望交付什么？"></textarea></label><label class="field-label">项目类型<select class="select" name="kind" id="new-project-kind">'+Object.values(global.STUDIO_TEMPLATES).map(t=>'<option value="'+t.id+'">'+esc(t.title)+'</option>').join('')+'</select></label><label class="check-item"><input type="checkbox" name="useTemplate" checked>按类型建立待办模板与决策节点</label><p class="context-note" id="template-hint">'+esc(template.description)+' 模板只建立待办，不会启动员工。</p><fieldset><legend>选择项目伙伴</legend><div class="check-grid">'+employees.map(e=>'<label class="check-item">'+avatar(e.id,'tiny')+'<input type="checkbox" name="members" value="'+e.id+'"'+(template.members.includes(e.id)?' checked':'')+'><span>'+esc(e.name)+'<small>'+esc(e.short)+'</small></span></label>').join('')+'</div></fieldset><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button-primary" type="submit">创建本地项目</button>'+button('取消','close-dialog')+'</div></form>';
    }
    function taskForm(p,state) {
      const options=p.members.map(id=>'<option value="'+id+'">'+esc(name(id))+' · '+esc(person(id).short)+'</option>');
      return '<h2>为 '+esc(p.title)+' 新建任务</h2><form class="form-stack" data-form="new-task"><input type="hidden" name="projectId" value="'+esc(p.id)+'"><label class="field-label">任务名称<input class="field" name="title" maxlength="160" required></label><div class="form-grid"><label class="field-label">负责人<select class="select" name="ownerId">'+options.join('')+'</select></label><label class="field-label">复核人<select class="select" name="reviewerId">'+p.members.map((id,i)=>'<option value="'+id+'"'+(i===1?' selected':'')+'>'+esc(name(id))+' · '+esc(person(id).short)+'</option>').join('')+'</select></label></div><label class="field-label">交付预期<textarea class="textarea" name="deliverable" rows="2" maxlength="1500"></textarea></label><label class="field-label">验收标准<textarea class="textarea" name="acceptance" rows="2" maxlength="2000"></textarea></label><fieldset><legend>依赖的上游任务</legend>'+tasks(state,p.id).map(t=>'<label class="check-item"><input type="checkbox" name="dependencies" value="'+esc(t.id)+'">'+esc(t.title)+'</label>').join('')+'</fieldset><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button-primary" type="submit">创建本地任务</button>'+button('取消','close-dialog')+'</div></form>';
    }
    function taskDetails(t,state) {
      const reasons=store.blockers(t.id), p=state.projects.find(p=>p.id===t.projectId);
      return '<p class="eyebrow">'+esc(p?.title)+(p?.isDemo?' · 示例任务':' · 本地手动任务')+'</p><h2>'+esc(t.title)+'</h2>'+statusBadge(t)+'<div class="participant-row">'+avatar(t.ownerId)+'<p>负责 '+esc(name(t.ownerId))+' → 复核 '+esc(name(t.reviewerId))+'</p></div><div class="detail-fields">'+field('交付预期',t.deliverable)+field('验收标准',t.acceptance)+'</div>'+(reasons.length?'<ul class="dependency-list">'+reasons.map(r=>'<li>'+esc(r)+'</li>').join(''):'')+'<form class="form-stack" data-form="update-task"><input type="hidden" name="id" value="'+esc(t.id)+'"><label class="field-label">登记状态<select class="select" name="status">'+Object.entries(labels).map(([key,label])=>'<option value="'+key+'"'+(t.status===key?' selected':'')+'>'+label+'</option>').join('')+'</select></label><label class="field-label">成果与验证依据<textarea class="textarea" name="evidence" rows="3" maxlength="4000" placeholder="文件名、版本、来源链接、实际检查范围…">'+esc(t.evidence)+'</textarea></label><label class="field-label">本轮复核记录<textarea class="textarea" name="reviewNote" rows="3" maxlength="2000" placeholder="填写谁检查了哪个版本、发现与结论；没有执行请写待验证。">'+esc(t.reviewNote)+'</textarea></label><p class="context-note">这里保存你手动填写的记录，不会自动执行任务或独立复核。标为完成前必须有依据与复核记录。</p><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button-primary" type="submit">保存进展记录</button>'+button('记录交接意图','handoff',t.id,'button-secondary')+'</div></form>';
    }
    function decisionForm(d,state) {
      const bound=state.tasks.filter(t=>t.decisionId===d.id);
      return '<p class="eyebrow">总策划决策</p><h2>'+esc(d.title)+'</h2><p class="muted">你的选择会更新项目方向，并解除关联任务的决策等待。</p><form class="form-stack" data-form="decision"><input type="hidden" name="id" value="'+esc(d.id)+'"><fieldset><legend>选择方向</legend>'+d.options.map(o=>'<label class="check-item"><input type="radio" name="choice" value="'+esc(o)+'"'+(d.selected===o?' checked':'')+' required>'+esc(o)+'</label>').join('')+'</fieldset><label class="field-label">决定说明 / 调整要求<textarea class="textarea" name="reason" rows="3" maxlength="2000">'+esc(d.reason)+'</textarea></label><p class="context-note">影响任务：'+bound.map(t=>esc(t.title)).join('、')+'。已推进的下游在方向变更后需重新复核。</p><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button-primary" type="submit">记录我的拍板</button>'+button('退回调整','rework-decision',d.id)+'</div></form>';
    }
    function artifactForm(p,state) {
      return '<h2>登记共享成果</h2><p class="muted">'+esc(p.title)+' · 保存可回看的正文与版本。</p><form class="form-stack" data-form="artifact"><input type="hidden" name="projectId" value="'+esc(p.id)+'"><label class="field-label">成果名称<input class="field" name="title" maxlength="160" required></label><div class="form-grid"><label class="field-label">版本<input class="field" name="version" value="v0.1" maxlength="24"></label><label class="field-label">关联任务<select class="select" name="taskId"><option value="">项目共享资料</option>'+tasks(state,p.id).map(t=>'<option value="'+esc(t.id)+'">'+esc(t.title)+'</option>').join('')+'</select></label></div><label class="field-label">成果正文<textarea class="textarea" name="body" rows="10" maxlength="12000" required placeholder="粘贴文稿、交付说明、来源和待验证事项…"></textarea></label><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button-primary" type="submit">保存到共享成果</button>'+button('取消','close-dialog')+'</div></form>';
    }
    function artifactDetails(a,state) {
      return '<p class="eyebrow">'+esc(state.projects.find(p=>p.id===a.projectId)?.title)+' · '+esc(a.version)+'</p><h2>'+esc(a.title)+'</h2>'+badge(a.source==='example'?'示例文稿':'手动登记',a.source==='example'?'demo':'')+'<div class="artifact-preview">'+esc(a.body)+'</div><p class="context-note">'+esc(state.tasks.find(t=>t.id===a.taskId)?.title||'项目共享资料')+' · 正文仅保存在本地，登记不代表通过专业复核。</p>';
    }
    function searchResults(query,state) {
      const q=query.trim().toLocaleLowerCase();
      return '<div class="search-results">'+state.projects.filter(p=>!q||p.title.toLocaleLowerCase().includes(q)).slice(0,5).map(p=>button('▧ '+esc(p.title),'search-project',p.id,'task-mini')).join('')+employees.filter(e=>!q||[e.id,e.name,e.title].join(' ').toLocaleLowerCase().includes(q)).slice(0,8).map(e=>'<button type="button" class="sidebar-person cursor-interaction" data-action="search-person" data-id="'+e.id+'">'+avatar(e.id)+'<span class="sidebar-person-copy"><strong>'+esc(e.name)+'</strong><span class="small muted">'+esc(e.title)+'</span></span></button>').join('')+'</div>';
    }
    return {esc,person,name,avatar,project,tasks,status,statusBadge,sidebar,overview,collaboration,board,team,artifacts,connections,employeeDetails,projectForm,taskForm,taskDetails,decisionForm,artifactForm,artifactDetails,searchResults};
  }
  global.StudioViews={create};
})(window);
