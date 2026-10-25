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
  const VIEWS = ['overview', 'project', 'tasks', 'team', 'assets', 'connections'];
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
    return {version: 3, revision: 0, view: 'overview', filter: 'all', query: '', page: 1, favorites: [], activeProjectId: null, selectedTaskId: null, activePeerId: null, projects: [], tasks: [], decisions: [], artifacts: [], messages: [], activity: []};
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
    const state = baseState(), validEmployees = employeeIds(employees);
    state.revision = number(value.revision);
    state.view = choice(value.view, VIEWS, 'overview');
    state.filter = choice(value.filter, FILTERS, 'all');
    state.query = text(value.query, 100);
    state.page = Math.min(100, Math.max(1, number(value.page, 1)));
    state.favorites = unique(list(value.favorites).slice(0, 50).filter(member => validEmployees.has(member)));
    state.projects = entities(value.projects, LIMIT.projects, project => ({
      id: project.id, title: text(project.title, 120).trim() || '未命名项目', kind: choice(project.kind, ['hybrid', 'film', 'game'], 'hybrid'),
      brief: text(project.brief, 4000), members: unique(list(project.members).slice(0, 40).filter(member => validEmployees.has(member))),
      isDemo: project.isDemo === true, createdAt: time(project.createdAt)
    }));
    const projects = new Map(state.projects.map(project => [project.id, project]));
    state.decisions = entities(value.decisions, LIMIT.decisions, decision => {
      if (!projects.has(decision.projectId)) return null;
      const options = unique(list(decision.options).slice(0, 8).map(option => text(option, 120).trim()).filter(Boolean));
      if (!options.length) return null;
      const selected = options.includes(decision.selected) ? decision.selected : null;
      let status = choice(decision.status, ['pending', 'approved', 'rework'], 'pending');
      if (status === 'approved' && !selected) status = 'pending';
      return {id: decision.id, projectId: decision.projectId, title: text(decision.title, 160).trim() || '待确认方向', options, selected, status, reason: text(decision.reason, 2000)};
    });
    state.tasks = entities(value.tasks, LIMIT.tasks, task => {
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
    state.artifacts = entities(value.artifacts, LIMIT.artifacts, artifact => {
      if (!projects.has(artifact.projectId)) return null;
      const task = state.tasks.find(item => item.id === artifact.taskId && item.projectId === artifact.projectId);
      const result = {id: artifact.id, projectId: artifact.projectId, taskId: task ? task.id : null, title: text(artifact.title, 160).trim() || '未命名成果',
        type: choice(artifact.type, ['document', 'image'], 'document'), body: text(artifact.body, 12000), version: text(artifact.version, 24) || 'v0.1', source: choice(artifact.source, ['example', 'manual'], 'manual'), createdAt: time(artifact.createdAt)};
      if (typeof artifact.url === 'string' && /^assets\/employees\/(?:R0[1-9]|R1[0-6]|G0[1-5])\.png$/.test(artifact.url)) result.url = artifact.url;
      else if (result.type === 'image') result.type = 'document';
      return result;
    });
    state.messages = entities(value.messages, LIMIT.messages, message => {
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
    return normalize(state, employees);
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
    if (!own(options, 'storage')) {try {storage = root.localStorage;} catch {storage = null;}}
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
    let serial = 0, saving = false, requested = false;
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
    function projectFor(target, projectId) {const project = target.projects.find(item => item.id === projectId); requireValue(project, '项目不存在。'); return project;}
    function validateTask(target, task) {
      const project = projectFor(target, task.projectId);
      requireValue(project.members.includes(task.ownerId) && validEmployees.has(task.ownerId), '责任人必须是本项目的有效成员。');
      requireValue(project.members.includes(task.reviewerId) && validEmployees.has(task.reviewerId), '复核人必须是本项目的有效成员。');
      requireValue(task.ownerId !== task.reviewerId, '责任人与复核人必须不同，自检不能代替独立复核。');
      for (const dependency of task.dependencies) {
        requireValue(dependency !== task.id, '任务不能依赖自身。');
        requireValue(target.tasks.some(item => item.id === dependency && item.projectId === task.projectId), '依赖必须是同一项目中已经存在的有效任务。');
        requireValue(!reaches(target.tasks, dependency, task.id), '这项依赖会形成循环，请调整后重试。');
      }
    }
    function dispatch(action) {
      if (!PLAIN(action) || typeof action.type !== 'string') return {ok: false, error: '操作格式无效。'};
      const fields = PLAIN(action.payload) ? {...action.payload, ...action} : action;
      const target = copy(state);
      let entityId = null;
      try {
        switch (action.type) {
          case 'NAVIGATE':
            requireValue(VIEWS.includes(fields.view), '页面不存在。'); target.view = fields.view; break;
          case 'SELECT_PROJECT': {
            const project = projectFor(target, fields.id); target.activeProjectId = project.id; target.activePeerId = null; target.selectedTaskId = target.tasks.find(task => task.projectId === project.id)?.id || null; target.view = 'project'; break;
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
            requireValue(target.projects.length < LIMIT.projects, '最多保存 20 个项目，请先整理现有项目。');
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
              requireValue(target.tasks.length + template.tasks.length <= LIMIT.tasks, '任务总数不能超过 120 项。');
              requireValue(target.decisions.length + template.decisions.length <= LIMIT.decisions, '决策总数不能超过 40 项。');
            }
            const project = {id: makeId('project'), title, kind, brief: text(fields.brief, 4000), members, isDemo: false, createdAt: Date.now()};
            target.projects.push(project);
            if (useTemplate) instantiate(target, project, template, makeId('plan'), false);
            target.activeProjectId = project.id; target.activePeerId = null; target.selectedTaskId = target.tasks.find(task => task.projectId === project.id)?.id || null; target.view = 'project'; entityId = project.id;
            activity(target, '创建本地项目', project.title + (useTemplate ? ' · 已建立待办模板，尚未执行。' : ' · 空白项目。')); break;
          }
          case 'CREATE_TASK': {
            requireValue(target.tasks.length < LIMIT.tasks, '任务总数不能超过 120 项。');
            const title = text(fields.title, 160).trim(); requireValue(title, '请填写任务名称。');
            requireValue(fields.dependencies == null || Array.isArray(fields.dependencies), '任务依赖格式无效。');
            const task = {id: makeId('task'), projectId: fields.projectId, title, ownerId: fields.ownerId, reviewerId: fields.reviewerId, status: 'queued', dependencies: unique(list(fields.dependencies)), decisionId: null,
              deliverable: text(fields.deliverable, 1500), acceptance: text(fields.acceptance, 2000), evidence: '', reviewNote: '', updatedAt: Date.now()};
            validateTask(target, task); target.tasks.push(task); target.selectedTaskId = task.id; entityId = task.id;
            activity(target, '创建本地任务', task.title + ' · 待安排，未向员工发送。'); break;
          }
          case 'UPDATE_TASK': {
            const task = target.tasks.find(item => item.id === fields.id); requireValue(task, '任务不存在。');
            const before = task.status;
            if (own(fields, 'status')) {requireValue(STATUSES.includes(fields.status), '任务状态无效。'); task.status = fields.status;}
            if (own(fields, 'evidence')) task.evidence = text(fields.evidence, 4000);
            if (own(fields, 'reviewNote')) task.reviewNote = text(fields.reviewNote, 2000);
            if (ACTIVE.includes(task.status)) requireValue(!blockersFor(target, task.id).length, blockersFor(target, task.id).join('\n'));
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
            requireValue(target.messages.length < LIMIT.messages, '本地便笺最多保存 80 条，当前已达上限。');
            const content = text(fields.text, 2000).trim(); requireValue(content, '便笺内容不能为空。');
            let peerId = own(fields, 'peerId') ? fields.peerId : own(fields, 'projectId') ? null : target.activePeerId;
            let projectId = own(fields, 'projectId') ? fields.projectId : peerId ? null : target.activeProjectId;
            peerId = peerId || null; projectId = projectId || null;
            requireValue(!peerId || validEmployees.has(peerId), '员工不存在。');
            requireValue(!projectId || target.projects.some(project => project.id === projectId), '项目不存在。');
            requireValue(!(peerId && projectId), '一条便笺只能选择项目或员工工位。');
            const message = {id: makeId('note'), projectId, peerId, authorId: 'user', text: content, time: Date.now(), isExample: false};
            target.messages.push(message); entityId = message.id; activity(target, '保存本地便笺', '仅记录你的文字，未发给模型或员工执行器。'); break;
          }
          case 'HANDOFF': {
            const task = target.tasks.find(item => item.id === fields.taskId); requireValue(task, '任务不存在。');
            activity(target, '记录本地交接意图', task.title + ' → ' + task.reviewerId + '；尚未发送、接收或执行。'); break;
          }
          case 'ADD_ARTIFACT': {
            requireValue(target.artifacts.length < LIMIT.artifacts, '成果总数不能超过 40 份。'); projectFor(target, fields.projectId);
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
    return {getState: () => copy(state), dispatch, subscribe(fn) {if (typeof fn !== 'function') return () => {}; subscribers.add(fn); return () => subscribers.delete(fn);}, blockers: taskId => blockersFor(state, taskId), persistence};
  }
  return {create, normalize, migrate, initialState};
});
