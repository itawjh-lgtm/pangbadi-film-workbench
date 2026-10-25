(function (root, factory) {
  'use strict';
  const templates = typeof module === 'object' && module.exports ? require('../data/project-templates.js') : root.STUDIO_TEMPLATES;
  const api = factory(root, templates || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudioStore = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root, templates) {
  'use strict';
  const KEY = 'creative-workbench-v3', OLD_KEY = 'creative-workbench-v2';
  const LIMIT = {projects: 20, tasks: 120, decisions: 40, artifacts: 40, messages: 80, activity: 80};
  const RETAIN = {projects:200,tasks:1200,decisions:400,artifacts:400,messages:800,activity:80};
  const VIEWS = ['overview', 'project', 'tasks', 'team', 'assets', 'connections', 'trash'];
  const FILTERS = ['all', 'film', 'game', 'favorites'];
  const STATUSES = ['queued', 'in_progress', 'review', 'done', 'rework'];
  const ACTIVE = ['in_progress', 'review', 'done'];
  const PLAIN = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const list = value => Array.isArray(value) ? value : [];
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const copy = value => JSON.parse(JSON.stringify(value));
  // Preserve source text (including markup used as data). The view escapes it
  // when rendering; removing tags here would corrupt scripts and prompt fields.
  const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : '';
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value) ? value : '';
  const number = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  const showcase = value => PLAIN(value)&&id(value.jobId)&&Number.isSafeInteger(value.outputIndex)&&value.outputIndex>=0?{jobId:value.jobId,outputIndex:value.outputIndex,final:value.final===true}:null;
  const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000 ? value : 0;
  const unique = value => [...new Set(value)];
  const employeeIds = employees => new Set(list(employees).filter(PLAIN).map(employee => id(employee.id)).filter(Boolean));
  const choice = (value, choices, fallback) => choices.includes(value) ? value : fallback;
  function entities(values, max, mapper) {
    const seen = new Set(), result = [];
    for (const value of list(values).slice(0, max)) {
      if (!PLAIN(value) || !id(value.id) || seen.has(value.id)) continue;
      const item = mapper(value);
      if (item) {seen.add(item.id); result.push(item);}
    }
    return result;
  }
  function baseState() {
    return {version: 3, revision: 0, view: 'overview', filter: 'all', query: '', page: 1, favorites: [], activeProjectId: null, selectedTaskId: null, activePeerId: null, selectedEmployeeId: 'R04', projectTab: 'production', selectedShot: 'cover', taskFilter: 'all', presentationVersion: 0, projects: [], tasks: [], decisions: [], artifacts: [], messages: [], activity: []};
  }
  function reaches(tasks, from, target, visited = new Set()) {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    const task = tasks.find(item => item.id === from);
    return !!task && task.dependencies.some(next => reaches(tasks, next, target, visited));
  }
  function blockersFor(state, taskId) {
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) return ['任务不存在。'];
    const reasons = [];
    for (const dependency of task.dependencies) {
      const upstream = state.tasks.find(item => item.id === dependency);
      if (!upstream || upstream.projectId !== task.projectId) reasons.push('上游任务无效，需重新核对依赖。');
      else if (upstream.status !== 'done') reasons.push('等待上游「' + upstream.title + '」复核完成。');
    }
    if (task.decisionId) {
      const decision = state.decisions.find(item => item.id === task.decisionId && item.projectId === task.projectId);
      if (!decision || decision.status !== 'approved') reasons.push('等待你拍板「' + (decision ? decision.title : '项目方向') + '」。');
    }
    return reasons;
  }
  function reviewAgain(task, reason) {
    task.status = 'queued';
    task.reviewNote = text('需复核：' + reason + (task.reviewNote ? '\n原记录：' + task.reviewNote.replace(/^需复核：[\s\S]*?\n原记录：/, '') : ''), 2000);
    task.updatedAt = Date.now();
  }
  function downstream(state, initialIds, includeInitial, reason) {
    const affected = new Set(initialIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of state.tasks) if (!affected.has(task.id) && task.dependencies.some(dependency => affected.has(dependency))) {affected.add(task.id); changed = true;}
    }
    for (const task of state.tasks) if (affected.has(task.id) && (includeInitial || !initialIds.includes(task.id))) {
      if (ACTIVE.includes(task.status) || task.status === 'rework' || includeInitial && initialIds.includes(task.id)) reviewAgain(task, reason);
    }
  }
  function normalize(value, employees) {
    // Host pointers deliberately cannot be promoted to full state.
    if (!PLAIN(value) || value.version !== 3 || value.truncated === true || value.pointerOnly === true) return null;
    if (Object.entries(RETAIN).some(([key,max])=>Array.isArray(value[key])&&value[key].length>max)) return null;
    const state = baseState(), validEmployees = employeeIds(employees);
    state.revision = number(value.revision);
    state.view = choice(value.view, VIEWS, 'overview');
    state.filter = choice(value.filter, FILTERS, 'all');
    state.query = text(value.query, 100);
    state.selectedEmployeeId = validEmployees.has(value.selectedEmployeeId) ? value.selectedEmployeeId : validEmployees.has('R04') ? 'R04' : null;
    state.projectTab = choice(value.projectTab, ['production','overview','characters','storyboard','canvas','assets','tasks','versions'], 'production');
    state.selectedShot = choice(value.selectedShot, ['cover','storyboard','character','game'], 'cover');
    state.taskFilter = choice(value.taskFilter, ['all','ready','blocked'], 'all');
    state.presentationVersion = number(value.presentationVersion);
    state.page = Math.min(100, Math.max(1, number(value.page, 1)));
    state.favorites = unique(list(value.favorites).slice(0, 50).filter(member => validEmployees.has(member)));
    state.projects = entities(value.projects, RETAIN.projects, project => ({
      id: project.id, title: text(project.title, 120).trim() || '未命名项目', kind: choice(project.kind, ['hybrid', 'film', 'game'], 'hybrid'),
      brief: text(project.brief, 4000), members: unique(list(project.members).slice(0, 40).filter(member => validEmployees.has(member))),
      reviewMode: choice(project.reviewMode, ['stepwise', 'continuous'], 'stepwise'),
      isDemo: project.isDemo === true, createdAt: time(project.createdAt),resultShowcase:showcase(project.resultShowcase)
    }));
    const projects = new Map(state.projects.map(project => [project.id, project]));
    state.decisions = entities(value.decisions, RETAIN.decisions, decision => {
      if (!projects.has(decision.projectId)) return null;
      const options = unique(list(decision.options).slice(0, 8).map(option => text(option, 120).trim()).filter(Boolean));
      if (!options.length) return null;
      const selected = options.includes(decision.selected) ? decision.selected : null;
      let status = choice(decision.status, ['pending', 'approved', 'rework'], 'pending');
      if (status === 'approved' && !selected) status = 'pending';
      return {id: decision.id, projectId: decision.projectId, title: text(decision.title, 160).trim() || '待确认方向', options, selected, status, reason: text(decision.reason, 2000)};
    });
    state.tasks = entities(value.tasks, RETAIN.tasks, task => {
      const project = projects.get(task.projectId);
      if (!project || !project.members.includes(task.ownerId) || !project.members.includes(task.reviewerId) || task.ownerId === task.reviewerId) return null;
      const decision = state.decisions.find(item => item.id === task.decisionId && item.projectId === task.projectId);
      return {id: task.id, projectId: task.projectId, title: text(task.title, 160).trim() || '未命名任务', ownerId: task.ownerId, reviewerId: task.reviewerId,
        status: choice(task.status, STATUSES, 'queued'), dependencies: unique(list(task.dependencies).slice(0, 120).map(id).filter(Boolean)), decisionId: decision ? decision.id : null,
        deliverable: text(task.deliverable, 1500), acceptance: text(task.acceptance, 2000), evidence: text(task.evidence, 4000), reviewNote: text(task.reviewNote, 2000), updatedAt: time(task.updatedAt)};
    });
    // Missing references and cycles are repaired conservatively, then active states are guarded.
    const damaged = new Set();
    for (const task of state.tasks) {
      const original = list(value.tasks).find(item => PLAIN(item) && item.id === task.id);
      if (original && original.decisionId && !task.decisionId) damaged.add(task.id);
      task.dependencies = task.dependencies.filter(dependency => {
        const upstream = state.tasks.find(item => item.id === dependency);
        const valid = dependency !== task.id && upstream && upstream.projectId === task.projectId;
        if (!valid) damaged.add(task.id);
        return valid;
      });
    }
    const edges = state.tasks.map(task => [task, task.dependencies.slice()]);
    for (const task of state.tasks) task.dependencies = [];
    for (const [task, dependencies] of edges) for (const dependency of dependencies) {
      if (reaches(state.tasks, dependency, task.id)) damaged.add(task.id); else task.dependencies.push(dependency);
    }
    for (let pass = 0; pass <= state.tasks.length; pass++) {
      let changed = false;
      for (const task of state.tasks) if (ACTIVE.includes(task.status) && (damaged.has(task.id) || blockersFor(state, task.id).length || task.status === 'done' && (!task.evidence.trim() || !task.reviewNote.trim() || task.reviewNote.startsWith('需复核：')))) {
        reviewAgain(task, damaged.has(task.id) ? '恢复数据含无效依赖或决策，需重新确认。' : '恢复数据未满足依赖、决策或完成证据门禁。'); changed = true;
      }
      if (!changed) break;
    }
    state.artifacts = entities(value.artifacts, RETAIN.artifacts, artifact => {
      if (!projects.has(artifact.projectId)) return null;
      const task = state.tasks.find(item => item.id === artifact.taskId && item.projectId === artifact.projectId);
      const result = {id: artifact.id, projectId: artifact.projectId, taskId: task ? task.id : null, title: text(artifact.title, 160).trim() || '未命名成果',
        type: choice(artifact.type, ['document', 'image'], 'document'), body: text(artifact.body, 12000), version: text(artifact.version, 24) || 'v0.1', source: choice(artifact.source, ['example', 'manual'], 'manual'), createdAt: time(artifact.createdAt)};
      const demoImage = projects.get(artifact.projectId).isDemo && result.source === 'example' && /^assets\/projects\/(?:lighthouse-cover|storyboard|character-sheet|game-level)\.webp$/.test(artifact.url || '');
      if (typeof artifact.url === 'string' && (/^assets\/employees\/(?:R0[1-9]|R1[0-6]|G0[1-5])\.png$/.test(artifact.url) || demoImage)) result.url = artifact.url;
      else if (result.type === 'image') result.type = 'document';
      result.authorId = validEmployees.has(artifact.authorId) ? artifact.authorId : task?.ownerId || null;
      if (demoImage) result.previewKey = choice(artifact.previewKey, ['cover','storyboard','character','game'], 'cover');
      result.reviews = list(artifact.reviews).filter(PLAIN).filter(review => review.actorId === 'user' && ['pending','changes','accepted'].includes(review.status)).slice(-30).map(review => ({status: review.status, note: text(review.note, 2000), actorId: 'user', time: time(review.time)}));
      const lastReview = result.reviews.at(-1);
      result.reviewStatus = lastReview?.status || 'pending';
      result.reviewNote = lastReview?.note || '';
      result.reviewedAt = lastReview?.time || 0;
      return result;
    });
    state.messages = entities(value.messages, RETAIN.messages, message => {
      const projectId = projects.has(message.projectId) ? message.projectId : null;
      const peerId = validEmployees.has(message.peerId) ? message.peerId : null;
      const authorId = message.authorId === 'user' || message.authorId === 'system' || validEmployees.has(message.authorId) ? message.authorId : 'user';
      const isExample = message.isExample === true;
      // Professional-role messages can only survive as clearly labelled examples.
      if (authorId !== 'user' && !isExample) return null;
      const content = text(message.text, 2000).trim();
      if (!content) return null;
      return {id: message.id, projectId, peerId: projectId ? null : peerId, authorId, text: content, time: time(message.time), isExample};
    });
    state.activity = entities(value.activity, LIMIT.activity, entry => ({id: entry.id, label: text(entry.label, 120), detail: text(entry.detail, 2000), time: time(entry.time)}));
    state.activeProjectId = projects.has(value.activeProjectId) ? value.activeProjectId : state.projects[0]?.id || null;
    state.activePeerId = validEmployees.has(value.activePeerId) ? value.activePeerId : null;
    state.selectedTaskId = state.tasks.find(task => task.id === value.selectedTaskId && task.projectId === state.activeProjectId)?.id || state.tasks.find(task => task.projectId === state.activeProjectId)?.id || null;
    return state;
  }
  function instantiate(state, project, template, prefix, demo) {
    const now = Date.now(), taskIds = new Map(template.tasks.map(task => [task.key, prefix + '-' + task.key]));
    const decisionIds = new Map(list(template.decisions).map(decision => [decision.key, prefix + '-' + decision.key]));
    for (const decision of list(template.decisions)) state.decisions.push({id: decisionIds.get(decision.key), projectId: project.id, title: decision.title, options: decision.options.slice(), selected: null, status: 'pending', reason: ''});
    for (const [index, task] of template.tasks.entries()) state.tasks.push({id: taskIds.get(task.key), projectId: project.id, title: task.title, ownerId: task.ownerId, reviewerId: task.reviewerId,
      status: demo && index < 2 ? 'done' : 'queued', dependencies: task.dependencies.map(key => taskIds.get(key)), decisionId: decisionIds.get(task.decisionKey) || null,
      deliverable: task.deliverable, acceptance: task.acceptance, evidence: demo && index < 2 ? '【示例文本，未真实执行】用于展示资料到故事的交接关系。' : '', reviewNote: demo && index < 2 ? '【示例复核】此状态仅展示工作流，不表示员工实际执行或审核。' : '', updatedAt: now});
  }
  // Only the named built-in example gets visual samples. Never fill a user's project
  // with illustrative work or advance its tasks during a presentation upgrade.
  function addExampleVisuals(state) {
    if (state.presentationVersion >= 1) return state;
    const project = state.projects.find(project => project.id === 'demo-lighthouse' && project.isDemo);
    if (project) {
      const samples = [
        ['demo-storyboard', '开场分镜 · 示例视觉', 'storyboard', 'storyboard', 'R04', 'demo-storyboard'],
        ['demo-character', '角色设定 · 示例视觉', 'character-sheet', 'character', 'R05', null],
        ['demo-game-level', '首关概念 · 示例视觉', 'game-level', 'game', 'G02', 'demo-level']
      ];
      for (const [id, title, file, previewKey, authorId, taskId] of samples) {
        if (state.artifacts.length >= LIMIT.artifacts || state.artifacts.some(item => item.id === id)) continue;
        state.artifacts.push({id, projectId: project.id, title, taskId, authorId, previewKey, type: 'image', url: 'assets/projects/' + file + '.webp', source: 'example', version: 'v0.1', createdAt: project.createdAt,
          body: '【界面示例视觉】本图为工作台设计展示而生成；署名表示示例职责分工，不表示该员工执行或提交。\n这不是项目实拍、已实现游戏、定稿或审核证据。\n审阅只登记总策划的本地意见，不替代任务复核。', reviewStatus: 'pending', reviewNote: '', reviewedAt: 0, reviews: []});
      }
    }
    state.presentationVersion = 1;
    return state;
  }
  function initialState(employees) {
    const state = baseState(), validEmployees = employeeIds(employees), template = templates.hybrid;
    if (!template) return state;
    const now = Date.now();
    const project = {id: 'demo-lighthouse', title: '灯塔来信', kind: 'hybrid', brief: '【协作示例】首关探索原型 + 15 秒宣传片。用于说明依赖、拍板与复核；没有启动真实制作。', members: template.members.filter(member => validEmployees.has(member)), isDemo: true, createdAt: now};
    state.projects.push(project);
    instantiate(state, project, template, 'demo', true);
    state.activeProjectId = project.id;
    state.selectedTaskId = 'demo-level';
    state.artifacts = [
      {id: 'demo-research-note', projectId: project.id, taskId: 'demo-research', title: '资料索引与边界 · 示例', type: 'document', body: '【样本文档，非实际调研结果】\n创作设定：一封迟到的信引导玩家重返灯塔。\n待核实：航海设施、地方史与相关资料的真实出处。\n使用边界：本示例采用原创设定；未提供或宣称外部素材授权。', version: 'v0.1', source: 'example', createdAt: now},
      {id: 'demo-story-note', projectId: project.id, taskId: 'demo-story', title: '故事节拍 · 示例', type: 'document', body: '【样本文档，未进入实际制作】\n开端：主角收到一封没有署名的旧信。\n推进：灯塔中的三处线索揭示写信人的等待。\n选择：保存回忆，或把新的信送向远方。\n待总策划确认：首关采用探索解谜还是分支叙事。', version: 'v0.1', source: 'example', createdAt: now}
    ];
    state.messages = [
      {id: 'demo-message-research', projectId: project.id, peerId: null, authorId: 'R02', text: '【协作示例】资料索引已按事实、创作设定与待核实三类组织；请故事线沿用同一份边界。', time: now - 120000, isExample: true},
      {id: 'demo-message-story', projectId: project.id, peerId: null, authorId: 'R03', text: '【协作示例】故事节拍供关卡与分镜共用，核心人物目标保持一致。', time: now - 60000, isExample: true},
      {id: 'demo-message-lead', projectId: project.id, peerId: null, authorId: 'G01', text: '【协作示例】首关体验方向等待总策划拍板；确认后再进入关卡与原型环节。', time: now, isExample: true}
    ];
    state.activity.push({id: 'demo-activity', label: '载入协作示例', detail: '示例完成状态、文档与角色发言均为预置内容；没有对外派发或实际执行。', time: now});
    return normalize(addExampleVisuals(state), employees);
  }
  function migrate(value, employees) {
    if (!PLAIN(value) || value.version !== 2) return null;
    const state = initialState(employees), validEmployees = employeeIds(employees);
    state.revision = number(value.revision);
    state.view = value.view === 'team' ? 'team' : value.view === 'project' ? 'project' : 'overview';
    state.filter = choice(value.filter, FILTERS, 'all');
    state.query = text(value.query, 100);
    state.page = Math.min(100, Math.max(1, number(value.page, 1)));
    state.favorites = unique(list(value.favorites).slice(0, 50).filter(member => validEmployees.has(member)));
    const now = Date.now();
    const records = list(value.records).slice(-60).filter(record => PLAIN(record) && typeof record.label === 'string').map((record, index) => ({id: 'legacy-' + index, label: '旧版演示记录 · ' + text(record.label, 90), detail: '【旧版本地操作，不能作为完成证据】' + text(record.detail, 1800), time: time(record.time) || now}));
    state.activity = [...state.activity, ...records].slice(-LIMIT.activity);
    // demoStep/approved/rework never enter v3 execution or decision states.
    return state;
  }
  function utf8Size(value) {
    const serialized = JSON.stringify(value);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(serialized).length;
    return unescape(encodeURIComponent(serialized)).length;
  }
  function create(employees, options = {}) {
    const validEmployees = employeeIds(employees), subscribers = new Set();
    let storage = options.storage, host = options.host;
    if (!own(options, 'storage')) {try {storage = window.StudioCloud.localStorage;} catch {storage = null;}}
    if (!own(options, 'host')) {try {host = root.openai;} catch {host = null;}}
    let localAvailable = false;
    function readStorage(key, converter) {
      try {
        if (typeof storage?.getItem !== 'function') return null;
        const raw = storage.getItem(key);
        localAvailable = true;
        return converter(JSON.parse(raw || 'null'), employees);
      } catch {return null;}
    }
    const local = readStorage(KEY, normalize) || readStorage(OLD_KEY, migrate);
    const hostContent = host?.widgetState?.privateContent;
    const hostState = normalize(hostContent?.studioV3, employees) || migrate(hostContent?.studioV2, employees);
    let state = local && hostState ? hostState.revision > local.revision ? hostState : local : local || hostState || initialState(employees);
    state = addExampleVisuals(state);
    let serial = 0, saving = false, requested = false, writeBlock = '';
    const entityKinds={projects:'project',tasks:'task',decisions:'decision',artifacts:'local_artifact',messages:'note'};
    function capacity(target,key,additional=1){
      const total=target[key].length,visible=target[key].filter(item=>!options.isDeleted?.(entityKinds[key],item.id,item.projectId)).length;
      requireValue(visible+additional<=LIMIT[key],'工作区最多保留 '+LIMIT[key]+' 条此类内容，可将不需要的内容移入回收站后再创建。');
      requireValue(total+additional<=RETAIN[key],'含回收站的保存容量已达 '+RETAIN[key]+' 条，请先导出备份后扩容；现有内容不会被覆盖。');
    }
    // Before the first write, local means readable/available rather than saved.
    // attempted keeps a fresh page from announcing a failed save prematurely.
    const persistence = {local: localAvailable, host: !!hostState, pending: false, attempted: false, hostTruncated: false};
    const notify = () => {for (const subscriber of [...subscribers]) {try {subscriber(copy(state), {...persistence});} catch (error) {if (root.console?.error) root.console.error('工作台视图更新失败', error);}}};
    function makeId(prefix) {
      let result;
      do {result = prefix + '-' + Date.now().toString(36) + '-' + (++serial).toString(36);} while (['projects', 'tasks', 'decisions', 'messages', 'artifacts', 'activity'].some(key => state[key].some(item => item.id === result)));
      return result;
    }
    function activity(target, label, detail = '') {target.activity.push({id: makeId('act'), label, detail: text(detail, 2000), time: Date.now()}); target.activity = target.activity.slice(-LIMIT.activity);}
    async function persist() {
      if (saving) return;
      saving = true;
      while (requested) {
        requested = false;
        const snapshot = copy(state);
        persistence.attempted = true;
        let localSaved = false, hostSaved = false, truncated = false;
        try {if (storage && typeof storage.setItem === 'function') {storage.setItem(KEY, JSON.stringify(snapshot)); localSaved = true;}} catch {}
        if (typeof host?.setWidgetState === 'function') {
          try {
            let hostSnapshot = snapshot;
            if (utf8Size({privateContent: {studioV3: snapshot}}) > 15000) {
              truncated = true;
              hostSnapshot = {version: 3, revision: snapshot.revision, truncated: true, pointerOnly: true, view: snapshot.view, filter: snapshot.filter, query: snapshot.query, page: snapshot.page, favorites: snapshot.favorites, activeProjectId: snapshot.activeProjectId, selectedTaskId: snapshot.selectedTaskId, activePeerId: snapshot.activePeerId};
            }
            await host.setWidgetState({modelContent: {kind: '影视游戏团队工作台', simulated: true, version: 3, view: snapshot.view, projectId: snapshot.activeProjectId, persistence: truncated ? '宿主仅保存界面指针，完整数据以本地存储为准' : '完整本地工作台快照'}, privateContent: {studioV3: hostSnapshot}});
            hostSaved = true;
          } catch {}
        }
        persistence.local = localSaved;
        persistence.host = hostSaved;
        persistence.hostTruncated = truncated;
        notify();
      }
      saving = false;
      persistence.pending = false;
      notify();
    }
    function schedule() {
      requested = true;
      persistence.pending = true;
      Promise.resolve().then(persist).catch(() => {saving = false; persistence.pending = false; notify();});
    }
    function requireValue(condition, message) {if (!condition) throw new Error(message);}
    function projectFor(target, projectId) {const project = target.projects.find(item => item.id === projectId); requireValue(project, '项目不存在。'); requireValue(!options.isDeleted?.('project',project.id,project.id),'项目已移入回收站，请先恢复。'); return project;}
    function visibleBlockers(target,taskId){
      const reasons=blockersFor(target,taskId),task=target.tasks.find(item=>item.id===taskId);if(!task)return reasons;
      for(const id of task.dependencies)if(options.isDeleted?.('task',id,task.projectId))reasons.unshift('上游任务已移入回收站，请先恢复后继续。');
      if(task.decisionId&&options.isDeleted?.('decision',task.decisionId,task.projectId))reasons.unshift('关联决策已移入回收站，请先恢复后继续。');
      return [...new Set(reasons)];
    }
    function validateTask(target, task) {
      const project = projectFor(target, task.projectId);
      requireValue(project.members.includes(task.ownerId) && validEmployees.has(task.ownerId), '责任人必须是本项目的有效成员。');
      requireValue(project.members.includes(task.reviewerId) && validEmployees.has(task.reviewerId), '复核人必须是本项目的有效成员。');
      requireValue(task.ownerId !== task.reviewerId, '责任人与复核人必须不同，自检不能代替独立复核。');
      for (const dependency of task.dependencies) {
        requireValue(dependency !== task.id, '任务不能依赖自身。');
        requireValue(!options.isDeleted?.('task',dependency,task.projectId),'上游任务已移入回收站，请先恢复。');
        requireValue(target.tasks.some(item => item.id === dependency && item.projectId === task.projectId), '依赖必须是同一项目中已经存在的有效任务。');
        requireValue(!reaches(target.tasks, dependency, task.id), '这项依赖会形成循环，请调整后重试。');
      }
    }
    function dispatch(action) {
      if (writeBlock) return {ok: false, error: writeBlock};
      if (!PLAIN(action) || typeof action.type !== 'string') return {ok: false, error: '操作格式无效。'};
      const fields = PLAIN(action.payload) ? {...action.payload, ...action} : action;
      const target = copy(state);
      let entityId = null;
      try {
        switch (action.type) {
          case 'SET_UI': {
            if (own(fields, 'selectedEmployeeId')) {requireValue(validEmployees.has(fields.selectedEmployeeId), '员工不存在。'); target.selectedEmployeeId = fields.selectedEmployeeId;}
            if (own(fields, 'projectTab')) {requireValue(['production','overview','characters','storyboard','canvas','assets','tasks','versions'].includes(fields.projectTab), '项目视图不存在。'); target.projectTab = fields.projectTab;}
            if (own(fields, 'selectedShot')) {requireValue(['cover','storyboard','character','game'].includes(fields.selectedShot), '预览不存在。'); target.selectedShot = fields.selectedShot;}
            if (own(fields, 'taskFilter')) {requireValue(['all','ready','blocked'].includes(fields.taskFilter), '筛选不存在。'); target.taskFilter = fields.taskFilter;}
            break;
          }
          case 'NAVIGATE':
            requireValue(VIEWS.includes(fields.view), '页面不存在。'); target.view = fields.view; break;
          case 'SELECT_PROJECT': {
            const project = projectFor(target, fields.id); target.projectTab = project.kind === 'game' ? 'overview' : 'production'; target.activeProjectId = project.id; target.activePeerId = null; target.selectedTaskId = target.tasks.find(task => task.projectId === project.id)?.id || null; target.view = 'project'; break;
          }
          case 'OPEN_DM':
            requireValue(validEmployees.has(fields.id), '员工不存在。'); target.activePeerId = fields.id; target.view = 'project'; break;
          case 'SELECT_TASK': {
            const task = target.tasks.find(item => item.id === fields.id); requireValue(task, '任务不存在。'); target.selectedTaskId = task.id; target.activeProjectId = task.projectId; target.activePeerId = null; break;
          }
          case 'FILTER':
            requireValue(FILTERS.includes(fields.filter), '筛选条件无效。'); target.filter = fields.filter; target.page = 1; break;
          case 'SEARCH': target.query = text(fields.query, 100); target.page = 1; break;
          case 'PAGE': target.page = Math.min(100, Math.max(1, number(fields.page, 1))); break;
          case 'TOGGLE_FAVORITE':
            requireValue(validEmployees.has(fields.id), '员工不存在。'); target.favorites = target.favorites.includes(fields.id) ? target.favorites.filter(member => member !== fields.id) : [...target.favorites, fields.id]; break;
          case 'CREATE_PROJECT': {
            capacity(target,'projects');
            const title = text(fields.title, 120).trim(), kind = choice(fields.kind, ['hybrid', 'film', 'game'], 'hybrid');
            requireValue(title, '请填写项目名称。');
            const template = templates[kind], useTemplate = fields.useTemplate === true;
            const supplied = Array.isArray(fields.members) ? fields.members : useTemplate ? template?.members : [];
            requireValue(list(supplied).every(member => validEmployees.has(member)), '项目成员包含无效员工。');
            const members = unique(list(supplied));
            requireValue(members.length >= 2, '至少选择两位项目伙伴，分别承担制作与复核');
            if (useTemplate) {
              requireValue(template, '该项目模板不可用。');
              const missing = unique(template.tasks.flatMap(task => [task.ownerId, task.reviewerId])).filter(member => !members.includes(member));
              requireValue(!missing.length, '模板需要成员：' + missing.join('、') + '。请加入后再创建。');
              capacity(target,'tasks',template.tasks.length);
              capacity(target,'decisions',template.decisions.length);
            }
            const project = {id: makeId('project'), title, kind, brief: text(fields.brief, 4000), members, reviewMode: choice(fields.reviewMode, ['stepwise', 'continuous'], 'stepwise'), isDemo: false, createdAt: Date.now()};
            target.projects.push(project);
            if (useTemplate) instantiate(target, project, template, makeId('plan'), false);
            target.activeProjectId = project.id; target.activePeerId = null; target.selectedTaskId = target.tasks.find(task => task.projectId === project.id)?.id || null; target.view = 'project'; target.projectTab = project.kind === 'game' ? 'overview' : 'production'; entityId = project.id;
            activity(target, '创建项目', project.title + (useTemplate ? ' · 已建立待办模板，尚未执行。' : ' · 空白项目。')); break;
          }
          case 'SET_PROJECT_SHOWCASE': {
            const project=projectFor(target,fields.projectId);
            const selection=fields.resultShowcase===null?null:showcase(fields.resultShowcase);
            requireValue(fields.resultShowcase===null||(selection&&typeof fields.resultShowcase.final==='boolean'),'请选择有效的项目成果。');
            project.resultShowcase=selection;entityId=project.id;break;
          }
          case 'CREATE_TASK': {
            capacity(target,'tasks');
            const title = text(fields.title, 160).trim(); requireValue(title, '请填写任务名称。');
            requireValue(fields.dependencies == null || Array.isArray(fields.dependencies), '任务依赖格式无效。');
            const task = {id: makeId('task'), projectId: fields.projectId, title, ownerId: fields.ownerId, reviewerId: fields.reviewerId, status: 'queued', dependencies: unique(list(fields.dependencies)), decisionId: null,
              deliverable: text(fields.deliverable, 1500), acceptance: text(fields.acceptance, 2000), evidence: '', reviewNote: '', updatedAt: Date.now()};
            validateTask(target, task); target.tasks.push(task); target.selectedTaskId = task.id; entityId = task.id;
            activity(target, '创建任务', task.title + ' · 待安排，未向员工发送。'); break;
          }
          case 'UPDATE_TASK': {
            const task = target.tasks.find(item => item.id === fields.id); requireValue(task, '任务不存在。');
            const before = task.status;
            if (own(fields, 'status')) {requireValue(STATUSES.includes(fields.status), '任务状态无效。'); task.status = fields.status;}
            if (own(fields, 'evidence')) task.evidence = text(fields.evidence, 4000);
            if (own(fields, 'reviewNote')) task.reviewNote = text(fields.reviewNote, 2000);
            if (ACTIVE.includes(task.status)) requireValue(!visibleBlockers(target, task.id).length, visibleBlockers(target, task.id).join('\n'));
            if (task.status === 'done') {
              requireValue(task.evidence.trim(), '完成任务前，请填写可核对的成果或验证证据。');
              requireValue(task.reviewNote.trim() && !task.reviewNote.startsWith('需复核：'), '完成任务前，请填写本轮独立复核记录。');
            }
            task.updatedAt = Date.now();
            if (before === 'done' && task.status !== 'done' || task.status === 'rework') downstream(target, [task.id], false, '上游「' + task.title + '」已退回或重新打开。');
            activity(target, '手动更新任务', task.title + ' · ' + task.status + '（本地记录）'); break;
          }
          case 'DECIDE': {
            const decision = target.decisions.find(item => item.id === fields.id); requireValue(decision, '决策不存在。');
            requireValue(decision.options.includes(fields.choice), '请选择此决策提供的有效选项。');
            if (decision.status === 'approved' && decision.selected !== fields.choice) downstream(target, target.tasks.filter(task => task.decisionId === decision.id).map(task => task.id), true, '总策划修改了已确认方向，需要按新方向复核。');
            decision.selected = fields.choice; decision.status = 'approved'; decision.reason = text(fields.reason, 2000);
            activity(target, '你手动拍板', decision.title + ' → ' + decision.selected + (decision.reason ? '；' + decision.reason : '')); break;
          }
          case 'REWORK_DECISION': {
            const decision = target.decisions.find(item => item.id === fields.id); requireValue(decision, '决策不存在。');
            decision.status = 'rework'; decision.reason = text(fields.reason, 2000);
            downstream(target, target.tasks.filter(task => task.decisionId === decision.id).map(task => task.id), true, '方向「' + decision.title + '」已退回，等待重新拍板。');
            activity(target, '你退回方向', decision.title + (decision.reason ? '；' + decision.reason : '')); break;
          }
          case 'SEND_MESSAGE': {
            capacity(target,'messages');
            const content = text(fields.text, 2000).trim(); requireValue(content, '便笺内容不能为空。');
            let peerId = own(fields, 'peerId') ? fields.peerId : own(fields, 'projectId') ? null : target.activePeerId;
            let projectId = own(fields, 'projectId') ? fields.projectId : peerId ? null : target.activeProjectId;
            peerId = peerId || null; projectId = projectId || null;
            requireValue(!peerId || validEmployees.has(peerId), '员工不存在。');
            requireValue(!projectId || target.projects.some(project => project.id === projectId), '项目不存在。');
            requireValue(!(peerId && projectId), '一条便笺只能选择项目或员工工位。');
            const message = {id: makeId('note'), projectId, peerId, authorId: 'user', text: content, time: Date.now(), isExample: false};
            target.messages.push(message); entityId = message.id; activity(target, '保存项目便笺', '仅记录你的文字，未发给模型或员工执行器。'); break;
          }
          case 'HANDOFF': {
            const task = target.tasks.find(item => item.id === fields.taskId); requireValue(task, '任务不存在。');
            activity(target, '记录本地交接意图', task.title + ' → ' + task.reviewerId + '；尚未发送、接收或执行。'); break;
          }
          case 'REVIEW_ARTIFACT': {
            const artifact = target.artifacts.find(item => item.id === fields.id); requireValue(artifact, '成果不存在。');
            requireValue(['pending','changes','accepted'].includes(fields.choice), '请选择有效的审阅结论。');
            const note = text(fields.note, 2000).trim();
            requireValue(fields.choice !== 'changes' || note, '退回修改时，请写明需要调整的内容。');
            artifact.reviewStatus = fields.choice; artifact.reviewNote = note; artifact.reviewedAt = Date.now();
            artifact.reviews = [...list(artifact.reviews), {status: fields.choice, note, actorId: 'user', time: artifact.reviewedAt}].slice(-30);
            activity(target, '总策划手动审阅', artifact.title + ' · ' + ({pending:'暂存意见', changes:'提出修改', accepted:'方向认可'}[fields.choice]) + '；不替代任务的专业复核。'); break;
          }
          case 'ADD_ARTIFACT': {
            capacity(target,'artifacts'); projectFor(target, fields.projectId);
            const title = text(fields.title, 160).trim(); requireValue(title, '请填写成果名称。');
            const taskId = fields.taskId || null;
            requireValue(!taskId || target.tasks.some(task => task.id === taskId && task.projectId === fields.projectId), '成果关联任务必须属于同一项目。');
            const artifact = {id: makeId('artifact'), projectId: fields.projectId, taskId, title, type: 'document', body: text(fields.body, 12000), version: text(fields.version, 24) || 'v0.1', source: 'manual', createdAt: Date.now()};
            target.artifacts.push(artifact); entityId = artifact.id; activity(target, '保存手工成果', artifact.title + ' · 尚未代替任务复核。'); break;
          }
          default: throw new Error('不支持的操作。');
        }
        target.revision = Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1);
        state = target;
        schedule(); notify();
        return entityId ? {ok: true, id: entityId} : {ok: true};
      } catch (error) {return {ok: false, error: error instanceof Error ? error.message : '操作未完成。'};}
    }
    function adoptHost(event) {
      const widgetState = event?.detail?.globals?.widgetState || host?.widgetState;
      const content = widgetState?.privateContent;
      const incoming = normalize(content?.studioV3, employees) || migrate(content?.studioV2, employees);
      if (incoming && incoming.revision > state.revision) {
        state = incoming;
        persistence.host = true;
        persistence.hostTruncated = false;
        // Host events are restoration, never a request to echo the snapshot
        // back to the host. Cache locally when possible without scheduling it.
        try {
          if (typeof storage?.setItem === 'function') {
            persistence.attempted = true;
            storage.setItem(KEY, JSON.stringify(state));
            persistence.local = true;
          }
        } catch {persistence.local = false;}
        notify();
      }
    }
    if (typeof root.addEventListener === 'function') root.addEventListener('openai:set_globals', adoptHost);
    function restore(snapshot, {preserveUI = false} = {}) {
      let incoming = normalize(snapshot, employees);
      if (!incoming) throw new Error('备份必须是完整的 v3 工作台数据。');
      if (preserveUI) {
        for (const key of ['view','filter','query','page','activeProjectId','selectedTaskId','activePeerId','selectedEmployeeId','projectTab','selectedShot','taskFilter']) incoming[key] = state[key];
        incoming = normalize(incoming, employees);
      }
      incoming.revision = Math.max(state.revision, incoming.revision) + 1;
      state = incoming; schedule(); notify();
      return copy(state);
    }
    return {getState: () => copy(state), dispatch, restore, hadStoredState: !!(local || hostState), setWriteBlock(message) {writeBlock = message || '';}, subscribe(fn) {if (typeof fn !== 'function') return () => {}; subscribers.add(fn); return () => subscribers.delete(fn);}, blockers: taskId => visibleBlockers(state, taskId), persistence};
  }
  return {create, normalize, migrate, initialState};
});
