(() => {
  'use strict';
  const root = document.getElementById('creative-workbench-v2');
  if (!root) return;
  const employees = Array.isArray(window.TEAM_EMPLOYEES) ? window.TEAM_EMPLOYEES : [];
  const byId = new Map(employees.map(employee => [employee.id, employee]));
  const inline = root.dataset.inline === 'true';
  const storageKey = 'creative-workbench-v2';
  const defaults = {version:2,revision:0,view:'team',filter:'all',query:'',page:1,favorites:[],demoStep:0,direction:'探索解谜',approved:false,rework:false,task:'T01',records:[]};
  let state = {...defaults};
  let returnFocus = null;
  const one = selector => root.querySelector(selector);
  const all = selector => [...root.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function normalize(value) {
    if (!value || value.version !== 2) return null;
    const normalized = {...defaults,
      revision:Number.isInteger(value.revision) ? value.revision : 0,
      view:['team','project','activity'].includes(value.view) ? value.view : 'team',
      filter:['all','film','game','favorites'].includes(value.filter) ? value.filter : 'all',
      query:typeof value.query === 'string' ? value.query.slice(0,100) : '',
      page:Number.isInteger(value.page) && value.page > 0 ? value.page : 1,
      favorites:Array.isArray(value.favorites) ? value.favorites.filter(id => byId.has(id)) : [],
      demoStep:Number.isInteger(value.demoStep) ? Math.min(6,Math.max(0,value.demoStep)) : 0,
      direction:value.direction === '分支叙事' ? '分支叙事' : '探索解谜',
      approved:value.approved === true,
      rework:value.rework === true,
      task:/^T0[1-6]$/.test(value.task) ? value.task : 'T01',
      records:Array.isArray(value.records) ? value.records.filter(record => record && typeof record.label === 'string' && typeof record.time === 'number').slice(-24) : []
    };
    if (normalized.demoStep > 2 && !normalized.approved) normalized.demoStep = 2;
    return normalized;
  }
  try { state = normalize(JSON.parse(localStorage.getItem(storageKey))) || state; } catch {}
  const hostState = normalize(window.openai?.widgetState?.privateContent?.studioV2);
  if (hostState) state = hostState;
  if (state.demoStep > 2 && !state.approved) state.demoStep = 2;
  function persistenceNotice(saved) {
    let notice=one('#persistence-notice');
    if(!notice){notice=document.createElement('p');notice.id='persistence-notice';notice.className='save-notice';notice.setAttribute('role','status');root.prepend(notice);}
    notice.hidden=saved;
    notice.textContent=saved?'':'本次更改仅保留在当前预览，刷新后可能丢失。';
  }
  function save() {
    state.revision++;
    let localSaved=false;
    try { localStorage.setItem(storageKey,JSON.stringify(state)); localSaved=true; } catch {}
    if (typeof window.openai?.setWidgetState === 'function') {
      try {
        return Promise.resolve(window.openai.setWidgetState({modelContent:{kind:'可爱3D影视游戏团队工作台',simulated:true,view:state.view,filter:state.filter,demoStep:state.demoStep,direction:state.direction},privateContent:{studioV2:{...state}}})).then(()=>{persistenceNotice(true);return true;},()=>{persistenceNotice(localSaved);return localSaved;});
      } catch {}
    }
    persistenceNotice(localSaved);
    return Promise.resolve(localSaved);
  }
  function record(label,detail='') {
    state.records.push({label,detail,time:Date.now()});
    state.records = state.records.slice(-24);
  }
  function refreshIcons() {
    if (globalThis.lucide) globalThis.lucide.createIcons({attrs:{width:16,height:16}});
  }
  function switchView(view) {
    state.view = view;
    all('[data-page]').forEach(page => {page.hidden=page.dataset.page !== view;});
    all('[data-nav]').forEach(button => {
      const active=button.dataset.nav === view;
      button.classList.toggle('is-active',active);
      if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    if (view === 'project') renderProject();
    if (view === 'activity') renderActivity();
  }
  function filteredEmployees() {
    const query=state.query.trim().toLocaleLowerCase();
    return employees.filter(employee => {
      const team = state.filter === 'all' || state.filter === employee.team || (state.filter === 'favorites' && state.favorites.includes(employee.id));
      return team && (!query || [employee.id,employee.name,employee.title,employee.summary,...employee.tags].join(' ').toLocaleLowerCase().includes(query));
    });
  }
  function renderEmployees() {
    const list=filteredEmployees(), size=12, totalPages=Math.max(1,Math.ceil(list.length/size));
    state.page=Math.min(totalPages,state.page);
    const grid=one('#employee-grid');
    grid.replaceChildren();
    list.slice((state.page-1)*size,state.page*size).forEach(employee => {
      const fragment=one('#employee-card-template').content.cloneNode(true);
      const card=fragment.querySelector('.employee-card');
      card.dataset.employeeId=employee.id;
      const fields={id:employee.id,team:employee.team==='film'?'影视团队':'游戏团队',name:employee.name,role:employee.short,summary:employee.summary};
      Object.entries(fields).forEach(([key,value]) => {fragment.querySelector('[data-card-'+key+']').textContent=value;});
      const image=fragment.querySelector('[data-card-image]');
      image.src=employee.thumb || employee.portrait;
      image.alt=employee.id+' '+employee.name+'，'+employee.title+'，可爱Q版3D虚构员工形象';
      image.addEventListener('error',() => {if (!image.dataset.fallback) {image.dataset.fallback='true';image.src=employee.portrait;}},{once:true});
      const tags=fragment.querySelector('[data-card-tags]');
      employee.tags.forEach(tag => {const li=document.createElement('li');li.textContent=tag;tags.append(li);});
      const favorite=fragment.querySelector('[data-favorite]');
      favorite.dataset.id=employee.id;
      favorite.setAttribute('aria-pressed',String(state.favorites.includes(employee.id)));
      favorite.setAttribute('aria-label',(state.favorites.includes(employee.id)?'取消收藏':'收藏')+employee.name);
      const open=fragment.querySelector('[data-open-employee]');
      open.dataset.id=employee.id;
      open.setAttribute('aria-label','打开'+employee.name+'的工位，'+employee.title);
      grid.append(fragment);
    });
    one('#employee-count').textContent=(state.filter==='favorites'?'收藏伙伴':'找到伙伴')+' · '+list.length+' 位'+(list.length>12?' · 第 '+state.page+' / '+totalPages+' 页':'');
    one('#team-empty').hidden=list.length!==0;
    all('[data-filter]').forEach(button=>{const active=button.dataset.filter===state.filter;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});
    one('#search-input').value=state.query;
    const pagination=one('#employee-pagination');
    pagination.replaceChildren();
    if(totalPages>1){
      const add=(label,page,disabled=false,current=false)=>{const button=document.createElement('button');button.type='button';button.className='page-button cursor-interaction';button.dataset.listPage=String(page);button.textContent=label;button.disabled=disabled;if(current){button.classList.add('is-active');button.setAttribute('aria-current','page');}pagination.append(button);};
      add('上一页',state.page-1,state.page===1);
      for(let page=1;page<=totalPages;page++)add(String(page),page,false,page===state.page);
      add('下一页',state.page+1,state.page===totalPages);
    }
    refreshIcons();
  }
  function detailMarkup(employee) {
    const field=(label,value)=>'<div class="detail-field"><h3>'+label+'</h3><p>'+escape(value)+'</p></div>';
    return '<div class="detail-layout"><div class="detail-visual"><img class="detail-portrait" src="'+escape(employee.portrait)+'" alt="'+escape(employee.name)+'的完整3D人物图"><div class="portrait-badges"><span class="employee-id">'+employee.id+'</span><span class="team-badge">'+(employee.team==='film'?'影视团队':'游戏团队')+'</span></div><p class="detail-visual-note">原创虚构人物 · 可爱 Q 版 3D<br>岗位职责以现行角色提示词为依据。</p></div><div class="detail-copy"><p class="detail-code">独立工位 / '+employee.id+'</p><h2 class="detail-title">'+escape(employee.name)+'</h2><p class="detail-role">'+escape(employee.title)+'</p><p class="detail-summary">'+escape(employee.summary)+'</p><div class="detail-tags">'+employee.tags.map(tag=>'<span>'+escape(tag)+'</span>').join('')+'</div><div class="detail-fields">'+field('收到什么',employee.input)+field('负责什么',employee.task)+field('交付预期',employee.output)+field('复核安排',employee.review)+field('交给谁',employee.next)+'</div><p class="detail-boundary"><strong>职责边界</strong><br>'+escape(employee.boundary)+'</p><div class="detail-actions"><button class="button-primary cursor-interaction" type="button" data-role-project="'+employee.id+'">查看协作示例 ↗</button>'+(inline?'':'<a class="button-secondary" href="'+escape(employee.portrait)+'" download="'+employee.id+'_'+escape(employee.name)+'.png">保存人物原图 ↓</a>')+'</div><p class="inline-note">执行器未接入 · 当前工位展示不代表实际开始制作。</p></div></div>';
  }
  function openEmployee(id,trigger) {
    const employee=byId.get(id);if(!employee)return;
    returnFocus=trigger || document.activeElement;
    record('查看工位',employee.id+' '+employee.name+' · '+employee.title);
    if(inline){
      const panel=one('#employee-inline-panel');
      panel.innerHTML='<button class="icon-button cursor-interaction" type="button" data-close-employee aria-label="关闭员工工位">×</button>'+detailMarkup(employee);
      panel.hidden=false;
      requestAnimationFrame(()=>panel.scrollIntoView({block:'start',behavior:'instant'}));
    }else{
      one('#employee-detail').innerHTML=detailMarkup(employee);
      const dialog=one('#employee-dialog');
      if(!dialog.open)dialog.showModal();
    }
    refreshIcons();save();
  }
  function closeEmployee() {
    one('#employee-inline-panel').hidden=true;
    const dialog=one('#employee-dialog');
    if(dialog.open)dialog.close();
    if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
  }
  const tasks=[
    {id:'T01',name:'资料与权利核验',owner:'R02',input:'项目简报 · 示例 v0.1',output:'资料索引与权利待核表',review:'R13 版权与合规复核',next:'R03 编剧',check:'未清权素材不得进入实际制作或发布；改用原创或已获授权的素材。'},
    {id:'T02',name:'故事与世界设定',owner:'R03',input:'资料索引 · 示例 v0.1',output:'人物小传与故事节拍',review:'R04 叙事复核 / G01 玩法适配',next:'G02 / G04 / R04',check:'核心人物、冲突和世界设定一致；方向变更由你拍板。'},
    {id:'T03',name:'首关设计与视觉规格',owner:'G02',input:'确认设定 · 示例 v0.1',output:'关卡流程与 G04 美术规格',review:'G01 专业统筹',next:'G03 程序 / G04 美术',check:'关卡目标、动线、交互和资产规格可以接入实现。'},
    {id:'T04',name:'可玩构建与独立测试',owner:'G03',input:'确认关卡与资产规格 · 示例 v0.1',output:'构建候选与 G05 测试记录',review:'G05 独立测试执行',next:'G01 → 总协调 → 你',check:'关键路径实际可运行，阻断问题经过复测；自评不能代替独立复核。'},
    {id:'T05',name:'15 秒宣传片',owner:'R04',input:'故事与视觉基准 · 示例 v0.1',output:'镜头、剪辑候选与声音分轨',review:'R09 技术复核 / R11 统筹',next:'R11 → 总协调 → 你',check:'叙事与视觉一致，声音完整；成片须实际播放与技术验收。'},
    {id:'T06',name:'双线验收与发布准备',owner:'R11',input:'游戏与影视交付包 · 示例 v0.1',output:'验收候选与发布待办清单',review:'你最终验收 / R13 发布前核验',next:'你确认后 → R14 / R15',check:'正式版本、地区平台规则、素材授权与验证证据齐备。'}
  ];
  const stages=[
    {title:'总协调拆单，等待第一次派发',states:['queued','queued','queued','queued','queued','queued'],detail:'你确定方向与范围；总协调拆任务，R11 / G01 组织专业成员。'},
    {title:'R02 收集资料，R13 核验权利',states:['running','queued','queued','queued','queued','queued'],detail:'先明确事实、原作、素材来源与使用边界，再交给故事开发。'},
    {title:'故事方向，等待你拍板',states:['handoff','running','queued','queued','queued','queued'],detail:'R03 接收资料并形成故事方向。首关优先做哪一种玩家体验，由你决定。'},
    {title:'关卡与宣传片方案并行',states:['handoff','handoff','running','queued','running','queued'],detail:'G02 / G04 完成关卡与视觉规格；R04组织美术、影像、剪辑和声音配合。'},
    {title:'程序接入构建，影视线整理候选',states:['handoff','handoff','handoff','running','running','queued'],detail:'G03 使用确认的交互与资产版本，影视线共用相同故事和视觉基准。'},
    {title:'G05 测试，R09 复核技术质量',states:['handoff','handoff','handoff','review','review','queued'],detail:'游戏由独立执行者运行测试；影视按播放与技术标准复核，问题回原责任人。'},
    {title:'双线汇总，等待总策划验收',states:['handoff','handoff','handoff','handoff','handoff','await'],detail:'R11 与 G01 把交付清单交总协调汇总，由你验收或退回。发布还需渠道与合规核验。'}
  ];
  const statusNames={queued:'演示 · 待接力',running:'演示 · 协作中',review:'演示 · 待复核',handoff:'演示 · 已交接',await:'演示 · 待你验收'};
  const laneFor=status=>status==='queued'?'queued':['handoff','await'].includes(status)?'handoff':'working';
  function renderProject() {
    const stage=stages[state.demoStep], blocked=state.demoStep===2&&!state.approved;
    const selected=tasks.find(task=>task.id===state.task) || tasks[0];
    const lanes=[['queued','待接力'],['working','制作 / 复核'],['handoff','已交接 / 待验收']];
    let html='<section class="project-panel"><div class="project-head"><div><p class="eyebrow">原创联动项目 · 协作模拟</p><h2>《灯塔来信》</h2><p class="project-description">'+(state.approved?escape(state.direction)+'首关':'首关体验')+' + 15 秒宣传片</p></div><span class="status-pill is-demo">执行器未接入 · 真实制作未启动</span></div><div class="command-chain"><span><b>你 · 项目总策划</b>定方向 / 范围 / 验收</span><i aria-hidden="true">→</i><span><b>总协调</b>拆单 / 跨团队汇总</span><i aria-hidden="true">→</i><span><b>R11 / G01</b>影视 / 游戏专业统筹</span></div><div class="project-step"><span class="step-counter">'+state.demoStep+' / 6 次演示交接</span><h3 aria-live="polite">'+escape(state.rework&&state.demoStep===4?'首关退回 G03 返修，再交 G05 复测':stage.title)+'</h3><p>'+escape(stage.detail)+'</p></div><div class="project-controls"><button type="button" class="button-secondary cursor-interaction" data-demo="previous" '+(state.demoStep===0?'disabled':'')+'>上一步</button><button type="button" class="button-primary cursor-interaction" data-demo="next" '+(blocked||state.demoStep===6?'disabled':'')+'>'+(blocked?'等待演示拍板':state.demoStep===6?'演示到此，待你验收':'演示下一次交接 →')+'</button>'+(state.demoStep===6?'<button type="button" class="button-danger cursor-interaction" data-demo="rework">演示退回首关返修</button>':'')+'</div></section>';
    if(blocked){
      html+='<section class="decision-panel" aria-label="总策划的演示决策"><p class="eyebrow">等待你 · 演示拍板</p><h3>首关优先做哪种体验？</h3><div class="decision-options">'+[['探索解谜','围绕环境线索、探索和解谜设计第一关。'],['分支叙事','围绕人物选择、对话和故事分支设计第一关。']].map(([value,description])=>'<label class="decision-option"><input type="radio" name="demo-direction" value="'+value+'" '+(state.direction===value?'checked':'')+'><span><strong>'+value+'</strong>'+description+'</span></label>').join('')+'</div><div class="project-controls"><button class="button-primary cursor-interaction" type="button" data-demo="approve">演示拍板，进入设计 →</button></div></section>';
    }
    html+='<div class="project-board" aria-label="模拟任务看板">'+lanes.map(([lane,label])=>{
      const active=tasks.filter((task,index)=>laneFor(stage.states[index])===lane);
      return '<section class="task-lane"><div class="task-lane-head"><h3>'+label+'</h3><span>'+active.length+' 项</span></div><div class="task-list">'+(active.length?active.map(task=>{
        const employee=byId.get(task.owner),index=tasks.indexOf(task),status=stage.states[index];
        return '<button type="button" class="task-card cursor-interaction '+(selected.id===task.id?'is-selected':'')+'" data-task="'+task.id+'" aria-pressed="'+(selected.id===task.id)+'"><span class="detail-code">'+task.id+'</span><h3>'+task.name+'</h3><span class="task-meta"><span class="task-owner"><img src="'+escape(employee?.thumb)+'" alt="">'+task.owner+' '+escape(employee?.name)+'</span><span class="task-state">'+(state.rework&&state.demoStep===4&&task.id==='T04'?'演示 · 返修中':statusNames[status])+'</span></span></button>';
      }).join(''):'<p class="lane-empty">此时没有任务</p>')+'</div></section>';
    }).join('')+'</div>';
    html+='<section class="handoff-card"><div class="handoff-header"><h3>'+selected.id+' · '+selected.name+'</h3><span class="status-pill is-demo">交接卡 · 示例</span></div><dl class="handoff-fields">'+[['责任人',selected.owner+' '+(byId.get(selected.owner)?.name||'')],['输入版本',selected.input],['交付预期',selected.output],['复核人',selected.review],['交给谁',selected.next],['验收标准',selected.check]].map(([label,value])=>'<dt>'+label+'</dt><dd>'+escape(value)+'</dd>').join('')+'</dl></section><div class="reality-note"><strong>真实成果</strong><span>剧本：待制作</span><span>可玩构建：待制作 / 待验证</span><span>宣传片：待制作 / 待播放验收</span><span>上线：未执行</span></div>';
    one('#project-content').innerHTML=html;
    refreshIcons();
  }
  function renderActivity() {
    const host=one('#activity-list');
    if(!state.records.length){host.innerHTML='<div class="record-empty"><h2>协作记录，从第一次操作开始。</h2><p>打开一个工位，或在项目工作台演示一次交接。</p></div>';return;}
    host.innerHTML=[...state.records].reverse().map(entry=>'<article class="record-item" role="listitem"><time class="record-time">'+escape(new Date(entry.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Shanghai'}))+'</time><div><h2 class="record-label">'+escape(entry.label)+'</h2><p>'+escape(entry.detail)+'</p></div><span class="activity-kind">本地操作</span></article>').join('');
  }
  root.addEventListener('click',event=>{
    const control=event.target.closest('button,a');
    if(!control || !root.contains(control))return;
    if(control.dataset.nav){event.preventDefault();closeEmployee();switchView(control.dataset.nav);save();return;}
    if(control.hasAttribute('data-filter')){state.filter=control.dataset.filter;state.page=1;renderEmployees();save();const replacement=one('[data-filter="'+state.filter+'"]');replacement?.focus({preventScroll:true});return;}
    if(control.hasAttribute('data-list-page')){state.page=Number(control.dataset.listPage);renderEmployees();save();one('#employee-count').scrollIntoView({block:'start',behavior:'instant'});return;}
    if(control.hasAttribute('data-favorite')){
      const id=control.dataset.id;
      state.favorites=state.favorites.includes(id)?state.favorites.filter(value=>value!==id):[...state.favorites,id];
      renderEmployees();save();one('[data-favorite][data-id="'+id+'"]')?.focus({preventScroll:true});return;
    }
    if(control.hasAttribute('data-open-employee')){openEmployee(control.dataset.id,control);return;}
    if(control.hasAttribute('data-close-employee')){closeEmployee();return;}
    if(control.hasAttribute('data-role-project')){
      const role=control.dataset.roleProject;
      state.task=tasks.find(task=>task.owner===role)?.id || (role.startsWith('G')?'T04':'T05');
      closeEmployee();switchView('project');save();one('#project-title').scrollIntoView({block:'start',behavior:'instant'});return;
    }
    if(control.hasAttribute('data-task')){state.task=control.dataset.task;renderProject();save();one('[data-task="'+state.task+'"]')?.focus({preventScroll:true});return;}
    if(control.dataset.demo){
      const action=control.dataset.demo;
      if(action==='next'&&state.demoStep<6&&!(state.demoStep===2&&!state.approved)){state.demoStep++;state.task=['T01','T01','T02','T03','T04','T04','T06'][state.demoStep];}
      else if(action==='previous'&&state.demoStep>0){state.demoStep--;state.rework=false;}
      else if(action==='approve'){state.approved=true;state.demoStep=3;state.task='T03';record('总策划演示拍板','首关选择：'+state.direction);}
      else if(action==='rework'){state.demoStep=4;state.rework=true;state.task='T04';record('演示退回返修','T04 退回 G03，完成后交 G05 复测。');}
      else return;
      if(action!=='approve'&&action!=='rework')record('演示交接 '+state.demoStep+'/6',stages[state.demoStep].title);
      renderProject();save();one('[data-demo="'+(action==='approve'?'next':action)+'"]')?.focus({preventScroll:true});return;
    }
  });
  one('#search-input').addEventListener('input',event=>{state.query=event.target.value;state.page=1;renderEmployees();save();});
  root.addEventListener('change',event=>{if(event.target.name==='demo-direction'){state.direction=event.target.value;save();}});
  one('#employee-dialog').addEventListener('close',()=>{if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
  window.addEventListener('openai:set_globals',event=>{
    const next=normalize(event.detail?.globals?.widgetState?.privateContent?.studioV2);
    if(next&&next.revision>state.revision){state=next;renderEmployees();switchView(state.view);}
  });
  renderEmployees();switchView(state.view);
})();
