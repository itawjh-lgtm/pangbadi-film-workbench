/* Same-origin execution client. Project records stay in StudioStore; runs stay on the server. */
(function (global) {
  'use strict';
  const active = run => ['queued', 'running'].includes(run?.status);
  const scopeKey = scope => scope?.peerId ? 'peer:' + scope.peerId : scope?.projectId ? 'project:' + scope.projectId : '';
  const artifactURL = value => typeof value === 'string' && /^\/api\/artifacts\/[A-Za-z0-9_-]+$/.test(value) ? value : '';
  const mediaActive = job => job?.source !== 'external' && Boolean(job?.task_id) && ['queued','running','unknown'].includes(job?.status);
  function mergeWorkflowFields(workflow, selections, existing = []) {
    if (!Array.isArray(existing) || existing.some(node => !node || typeof node !== 'object' || Array.isArray(node) || !String(node.nodeId || '').trim() || !String(node.fieldName || '').trim() || node.fieldValue === undefined)) throw new Error('节点输入必须是包含 nodeId、fieldName 和 fieldValue 的 JSON 数组。');
    const merged = existing.map(node => ({...node}));
    for (const selected of selections) {
      const field = workflow?.fields?.[selected.index];
      if (!field) throw new Error('工作流字段已变更，请重新读取参数。');
      let value = selected.value;
      if (field.valueType === 'number') {
        if (String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(field.fieldName + ' 需要有效数字。');
        value = Number(value);
      } else if (field.valueType === 'boolean') {
        if (!['true','false',true,false].includes(value)) throw new Error(field.fieldName + ' 需要 true 或 false。');
        value = value === true || value === 'true';
      } else value = String(value ?? '');
      const node = {nodeId:String(field.nodeId),fieldName:field.fieldName,fieldValue:value};
      const index = merged.findIndex(item => String(item.nodeId) === node.nodeId && item.fieldName === node.fieldName);
      if (index < 0) merged.push(node); else merged[index] = node;
    }
    return merged;
  }
  function create(options = {}) {
    const fetcher = options.fetch || global.fetch?.bind(global);
    const delay = options.setTimeout || global.setTimeout?.bind(global);
    const clearDelay = options.clearTimeout || global.clearTimeout?.bind(global);
    const cache = new Map(), listeners = new Set(), loading = new Map(), errors = new Map();
    let providers = [], mediaJobs = [], mediaError = '';
    let mediaTimer = null, mediaPolling = false, mediaWatching = false, mediaProject = null;
    const mediaRequests = new Map(), mediaRetries = new Map(), now = options.now || Date.now;
    let health = null, roles = [], state = options.disabled ? 'offline' : 'checking', reason = options.disabled ? '对话内预览仅支持本地便笺；请打开独立工作台执行。' : '', revision = 0, timer = null, disposed = false, polling = false;
    const notify = () => { revision++; listeners.forEach(fn => fn()); };
    const ready = () => state === 'online' && health?.provider?.available === true && health?.provider?.authenticated === true && Boolean(health?.csrfToken);
    async function request(path, body, requestOptions = {}) {
      if (options.disabled || !fetcher) throw new Error('请在独立本地工作台中连接执行服务。');
      if (!path.startsWith('/api/')) throw new Error('只允许工作台同源接口。');
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutMs = Number.isFinite(requestOptions.timeoutMs) && requestOptions.timeoutMs > 0 ? requestOptions.timeoutMs : 15000;
      const timeout = controller && delay ? delay(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Studio-Token': health?.csrfToken || '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(controller ? { signal: controller.signal } : {}) });
        let data;
        try { data = await response.json(); } catch { throw new Error('当前服务没有返回执行接口，请使用新的启动工作台入口。'); }
        if (!response.ok) throw new Error(data.error || '请求失败（' + response.status + '）');
        return data;
      } catch (error) { throw new Error(error.name === 'AbortError' ? '执行服务响应超时，请刷新连接状态后查看运行记录。' : error.message || '无法连接执行服务。'); }
      finally { if (timeout !== null) clearDelay?.(timeout); }
    }
    function merge(run, fallbackScope) {
      if (!run?.id) return;
      const key = scopeKey(run) || scopeKey(fallbackScope);
      if (!key) return;
      const list = cache.get(key) || [];
      const index = list.findIndex(item => item.id === run.id);
      if (index === -1) list.push(run); else list[index] = run;
      list.sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      cache.set(key, list); errors.delete(key);
    }
    function schedule() {
      if (disposed || timer !== null || polling || ![...cache.values()].flat().some(active)) return;
      timer = delay?.(poll, 1200) ?? null;
    }
    async function poll() {
      timer = null; if (disposed) return;
      polling = true;
      const pending = [...cache.values()].flat().filter(active);
      await Promise.all(pending.map(async run => {
        try { const result = await request('/api/runs/' + encodeURIComponent(run.id)); merge(result.run, run); }
        catch (error) { errors.set(scopeKey(run), error.message + ' 运行状态尚未确认。'); }
      }));
      polling = false; notify(); schedule();
    }
    async function connect() {
      if (options.disabled) return false;
      state = 'checking'; reason = ''; notify();
      try {
        const result = await request('/api/health');
        if (result.service !== 'dream-studio-runtime' || result.ok !== true) throw new Error('当前端口不是工作台执行服务。');
        health = result; state = 'online'; reason = result.provider?.reason || '';
        const roleResult = await request('/api/roles'); roles = Array.isArray(roleResult.roles) ? roleResult.roles : [];
      } catch (error) { state = 'offline'; reason = error.message; }
      notify(); schedule(); return ready();
    }
    async function loadScope(scope, force = false) {
      const key = scopeKey(scope); if (!key || state !== 'online') return [];
      if (loading.has(key)) return loading.get(key);
      if (!force && cache.has(key)) return cache.get(key);
      const query = scope.peerId ? 'peerId=' + encodeURIComponent(scope.peerId) : 'projectId=' + encodeURIComponent(scope.projectId);
      const promise = request('/api/runs?' + query).then(result => {
        cache.set(key, Array.isArray(result.runs) ? result.runs : []); errors.delete(key); notify(); schedule(); return cache.get(key);
      }).catch(error => { errors.set(key, error.message); notify(); return cache.get(key) || []; }).finally(() => loading.delete(key));
      loading.set(key, promise); return promise;
    }
    async function refreshMedia() {
      if (state !== 'online') return;
      const results = await Promise.allSettled([request('/api/connections'),request('/api/media/jobs')]);
      mediaError = '';
      if(results[0].status==='fulfilled') providers=Array.isArray(results[0].value.providers)?results[0].value.providers:[];
      else mediaError=results[0].reason.message;
      if(results[1].status==='fulfilled') mediaJobs=Array.isArray(results[1].value.jobs)?results[1].value.jobs:[];
      else mediaError+=(mediaError?'；':'')+results[1].reason.message;
      notify(); scheduleMedia();
    }
    function watchMedia(projectId = null, enabled = true) {
      mediaWatching = enabled; mediaProject = projectId;
      if (!enabled) { clearDelay?.(mediaTimer); mediaTimer = null; }
      else scheduleMedia();
    }
    function pendingMedia() { return mediaJobs.filter(job => mediaActive(job) && (!mediaProject || job.projectId === mediaProject)); }
    function scheduleMedia() {
      if (disposed || !mediaWatching || state !== 'online' || mediaTimer !== null || mediaPolling || !pendingMedia().length) return;
      mediaTimer = delay?.(pollMedia, 10000) ?? null;
    }
    async function pollMedia() {
      mediaTimer = null;
      if (disposed || !mediaWatching) return;
      if (options.isVisible && !options.isVisible()) { scheduleMedia(); return; }
      mediaPolling = true;
      const jobs = pendingMedia().filter(job => (mediaRetries.get(job.id)?.after || 0) <= now()).slice(0,4);
      await Promise.all(jobs.map(async job => { try { await refreshMediaJob(job.id); } catch { /* The individual task retains the query error. Never resubmit. */ } }));
      mediaPolling = false; scheduleMedia();
    }
    async function saveConnection(config) { const result=await request('/api/connections/runninghub',config); await refreshMedia(); return result; }
    async function verifyRunningHub() { try { const result=await request('/api/connections/runninghub/verify',{}, {timeoutMs:55000}); return result.verification; } finally { await refreshMedia(); } }
    async function readRunningHubWorkflow(workflowId) { const result=await request('/api/connections/runninghub/workflow',{workflowId}, {timeoutMs:55000}); return result.workflow; }
    async function saveProvider(id,config) { const result=await request('/api/connections/'+encodeURIComponent(id),config); await refreshMedia(); return result; }
    async function estimateMedia(payload) { const result=await request('/api/media/estimate',payload); return result.estimate; }
    async function submitMedia(payload) { const result=await request('/api/media/jobs',payload,{timeoutMs:55000}); await refreshMedia(); return result.job; }
    async function importMedia(payload) { const result = await request('/api/media/import',payload); await refreshMedia(); return result.job; }
    async function refreshMediaJob(id) {
      if (mediaRequests.has(id)) return mediaRequests.get(id);
      const promise = (async () => {
        try {
          const result = await request('/api/media/jobs/'+encodeURIComponent(id)+'/refresh',{}, {timeoutMs:55000});
          if (!result.job?.id) throw new Error('查询未返回有效任务，原状态保留。');
          const index = mediaJobs.findIndex(job => job.id === result.job.id);
          if (index >= 0) mediaJobs[index] = result.job; else mediaJobs.push(result.job);
          mediaRetries.set(id,{failures:0,after:now()+10000}); notify(); return result.job;
        } catch (error) {
          const failures = (mediaRetries.get(id)?.failures || 0)+1;
          mediaRetries.set(id,{failures,after:now()+Math.min(60000,10000*2**Math.min(failures,3))});
          const job = mediaJobs.find(job => job.id === id);
          if (job) job.lastRefreshError = error.message + ' 原任务状态保留，将稍后再查询。';
          notify(); throw error;
        } finally { mediaRequests.delete(id); scheduleMedia(); }
      })();
      mediaRequests.set(id,promise); return promise;
    }
    async function start(payload) {
      if (!ready()) throw new Error(reason || '执行器尚未就绪，请先在工具与连接检查。');
      if (!payload.prompt?.trim()) throw new Error('请填写工作要求。');
      if (!Array.isArray(payload.agentIds) || payload.agentIds.length < 1 || payload.agentIds.length > 4) throw new Error('每次请选择 1 至 4 位伙伴。');
      const result = await request('/api/runs', payload); if (!result.run?.id) throw new Error('服务未返回有效运行编号，请刷新记录后再试。');
      merge(result.run, payload.peerId ? {peerId:payload.peerId} : {projectId:payload.project?.id}); notify(); schedule(); return result.run;
    }
    async function cancel(id) { const result = await request('/api/runs/' + encodeURIComponent(id) + '/cancel', {}); merge(result.run); notify(); schedule(); return result.run; }
    const getRuns = scope => cache.get(scopeKey(scope)) || [];
    const allRuns = () => [...cache.values()].flat();
    return {
      connect, loadScope, start, cancel, ready, scopeKey, active, artifactURL, refreshMedia, saveConnection, verifyRunningHub, readRunningHubWorkflow, saveProvider, estimateMedia, submitMedia, refreshMediaJob, importMedia, watchMedia, request,
      get media() { return {providers,jobs:mediaJobs,error:mediaError}; },
      get revision() { return revision; },
      get connection() { return {state, reason, health, ready:ready()}; },
      get roles() { return roles; },
      getRuns, getError: scope => errors.get(scopeKey(scope)) || '',
      findRun: id => allRuns().find(run => run.id === id),
      findArtifact: id => allRuns().flatMap(run => run.artifacts || []).find(artifact => artifact.id === id),
      artifacts: scope => getRuns(scope).flatMap(run => (run.artifacts || []).map(artifact => ({...artifact, projectId:run.projectId, peerId:run.peerId, runId:run.id, taskId:run.taskId}))),
      role: id => roles.find(role => role.id === id),
      roleDetail: id => request('/api/roles/' + encodeURIComponent(id)),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      dispose() { disposed = true; clearDelay?.(timer); clearDelay?.(mediaTimer); listeners.clear(); }
    };
  }
  const api = {create, active, mediaActive, scopeKey, artifactURL, mergeWorkflowFields};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StudioRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis);
