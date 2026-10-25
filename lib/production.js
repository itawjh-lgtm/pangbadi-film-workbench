/* Server-owned production plans. This client never starts work while loading. */
(function (global) {
  'use strict';
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const active = item => ['running','awaiting_review','paused','failed'].includes(item?.status);
  function canvasApprovalKey(plan) {
    const delivery=plan?.stages?.find(stage=>stage.id==='delivery');
    if(!validId(plan?.id)||!validId(plan?.projectId)||plan.status!=='completed'||delivery?.status!=='completed'||delivery.review?.action!=='approve')return '';
    return JSON.stringify([plan.id,delivery.review.at||'',delivery.review.artifactIds||delivery.outputArtifactIds||[]]);
  }
  // Observe transitions, not the fact that an old plan is complete. Returning to
  // its document view must never send the user back to the canvas again.
  function createCanvasHandoffTracker(options={}) {
    const observed=new Map(),handled=options.handled||new Map();
    function claim(plan){const key=canvasApprovalKey(plan);if(key){handled.set(key,true);while(handled.size>100)handled.delete(handled.keys().next().value);options.onHandled?.(handled);}return key;}
    function observe(plans,eligible=true){
      const latest=Array.isArray(plans)?plans[plans.length-1]:null;if(!latest)return null;
      const key=canvasApprovalKey(latest),previous=observed.get(latest.id);observed.set(latest.id,key);
      if(!key||previous===undefined||previous===key||handled.has(key))return null;
      claim(latest);return eligible?latest:null;
    }
    return {observe,claim};
  }
  // A production can create new runs after the normal runtime cache was loaded.
  // Drain an existing read before forcing a fresh one, with one trailing refresh
  // when a newer production revision arrives during the request.
  function createRunSynchronizer(runtime) {
    const scopes = new Map();
    function sync(projectId, productions) {
      if (!validId(projectId) || !Array.isArray(productions) || !productions.length || !runtime?.loadScope) return Promise.resolve();
      const wanted = JSON.stringify(productions.map(item => [item.id,item.revision]));
      let entry = scopes.get(projectId);
      if (!entry) { entry = {wanted,synced:null,promise:null}; scopes.set(projectId,entry); }
      entry.wanted = wanted;
      if (entry.promise) return entry.promise;
      if (entry.synced === wanted) return Promise.resolve();
      entry.promise = (async () => {
        while (entry.synced !== entry.wanted) {
          const target = entry.wanted;
          await runtime.loadScope({projectId});
          await runtime.loadScope({projectId},true);
          entry.synced = target;
        }
      })().catch(() => { entry.synced = entry.wanted; }).finally(() => { entry.promise = null; });
      return entry.promise;
    }
    return {sync};
  }
  function create(options = {}) {
    const request = options.request;
    const delay = options.setTimeout || global.setTimeout?.bind(global);
    const clear = options.clearTimeout || global.clearTimeout?.bind(global);
    const cache = new Map(), errors = new Map(), loads = new Map(), pending = new Map(), listeners = new Set();
    let projectId = null, timer = null, disposed = false, revision = 0;
    const enabled = () => !options.disabled && typeof request === 'function';
    const connected = () => enabled() && (options.isConnected ? options.isConnected() : true);
    const ready = () => connected() && (options.ready ? options.ready() : true);
    const notify = () => { revision++; for (const fn of listeners) fn(); };
    const visible = (kind,id,pid) => !options.isDeleted?.(kind,id,pid);
    const visiblePlan = item => ({...item,stages:(item.stages||[]).map(stage=>({...stage,artifacts:(stage.artifacts||[]).filter(a=>visible('run',stage.runId,item.projectId)&&visible('artifact',a.id,item.projectId)),history:(stage.history||[]).map(attempt=>({...attempt,artifacts:(attempt.artifacts||[]).filter(a=>visible('run',attempt.runId,item.projectId)&&visible('artifact',a.id,item.projectId))}))}))});
    const getProductions = id => (cache.get(id) || []).filter(item=>visible('production',item.id,item.projectId)).map(visiblePlan);
    const find = id => [...cache.values()].flat().filter(item=>visible('production',item.id,item.projectId)).map(visiblePlan).find(item => item.id === id);
    function path(id, action = '') {
      if (!validId(id)) throw new Error('自动协作编号无效。');
      if (action && !['pause','resume','review'].includes(action)) throw new Error('协作操作无效。');
      return '/api/productions/' + encodeURIComponent(id) + (action ? '/' + action : '');
    }
    async function api(url, body) {
      if (!enabled()) throw new Error('请在独立工作台中使用自动协作。');
      if (!/^\/api\/productions(?:\?projectId=[A-Za-z0-9_%.-]+|\/[A-Za-z0-9_-]+(?:\/(?:pause|resume|review))?)?$/.test(url)) throw new Error('只允许自动协作同源接口。');
      return request(url, body);
    }
    function merge(item) {
      if (!item || !validId(item.id) || !validId(item.projectId)) return false;
      const list = cache.get(item.projectId)||[], existing = list.find(value => value.id === item.id);
      if (existing && Number(existing.revision) > Number(item.revision)) return false;
      if (existing && JSON.stringify(existing) === JSON.stringify(item)) return false;
      const next = list.filter(value => value.id !== item.id).concat([clone(item)]);
      next.sort((a,b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      cache.set(item.projectId, next); return true;
    }
    function schedule() {
      if (disposed || timer !== null || !connected() || !projectId) return;
      timer = delay?.(async () => { timer = null; if (disposed) return; await refresh(projectId); schedule(); }, 3000) ?? null;
    }
    async function refresh(id = projectId) {
      if (!validId(id) || !connected()) return getProductions(id);
      if (loads.has(id)) return loads.get(id);
      const load = api('/api/productions?projectId=' + encodeURIComponent(id)).then(result => {
        if (!Array.isArray(result.productions)) throw new Error('服务未返回有效协作记录。');
        let changed = !cache.has(id); if (!cache.has(id)) cache.set(id, []);
        for (const item of result.productions) if (item?.projectId === id) changed = merge(item) || changed;
        changed = errors.delete(id) || changed; if (changed) notify();
        return getProductions(id);
      }).catch(error => {
        const message = error.message || '协作记录暂时无法读取。';
        if (errors.get(id) !== message) { errors.set(id, message); notify(); }
        return getProductions(id);
      }).finally(() => { loads.delete(id); schedule(); });
      loads.set(id, load); return load;
    }
    function setProject(id) {
      const next = validId(id) ? id : null;
      if (next !== projectId) { clear?.(timer); timer = null; projectId = next; }
      if (projectId && connected()) { if (!cache.has(projectId) && !loads.has(projectId)) refresh(projectId); schedule(); }
    }
    async function mutate(key, id, body, scope) {
      if (pending.has(key)) return pending.get(key);
      const promise = (async () => {
        try {
          const result = await api(id, body);
          if (!result.production?.id || result.production.projectId !== scope) throw new Error('提交结果尚未确认，请先刷新协作记录。');
          merge(result.production); errors.delete(scope); return result.production;
        } catch (error) {
          errors.set(scope, error.message || '协作操作未完成。');
          await refresh(scope); errors.set(scope, error.message || '协作操作未完成。'); throw error;
        } finally { pending.delete(key); notify(); schedule(); }
      })();
      pending.set(key, promise); notify(); return promise;
    }
    async function start(payload) {
      if (!ready()) throw new Error('请先在工具与连接中确认文字执行器已就绪。');
      if (!validId(payload?.project?.id) || payload.project.kind === 'game') throw new Error('自动影视协作需要选择一个影视项目。');
      if (!String(payload.prompt || '').trim()) throw new Error('请填写这次作品的目标。');
      if (!validId(payload.requestId)) throw new Error('缺少本次提交编号，请重新打开项目。');
      if (!['stepwise','continuous'].includes(payload.reviewMode)) throw new Error('请选择审阅方式。');
      return mutate('start:' + payload.project.id, '/api/productions', payload, payload.project.id);
    }
    function action(id, name, body = {}) {
      const item = find(id); if (!item) return Promise.reject(new Error('协作记录尚未载入，请刷新后再试。'));
      const expectedRevision = body.expectedRevision ?? item.revision;
      if (!Number.isSafeInteger(expectedRevision)) return Promise.reject(new Error('协作版本无效，请刷新后再试。'));
      return mutate(id, path(id, name), {...body, expectedRevision}, item.projectId);
    }
    function allArtifacts() {
      return [...cache.values()].flat().filter(item=>visible('production',item.id,item.projectId)).map(visiblePlan).flatMap(item => (item.stages || []).flatMap(stage => [
        ...(stage.artifacts || []).map(artifact => ({...artifact,productionId:item.id,stageId:stage.id,projectId:item.projectId})),
        ...(stage.history || []).flatMap(attempt => (attempt.artifacts || []).map(artifact => ({...artifact,productionId:item.id,stageId:stage.id,projectId:item.projectId,archived:true})))
      ]));
    }
    return {
      ready, enabled, active, setProject, refresh, start,
      pause:(id, expectedRevision) => action(id,'pause',{expectedRevision}),
      resume:(id, expectedRevision) => action(id,'resume',{expectedRevision}),
      review:(id, body) => action(id,'review',body),
      getProductions, find, findArtifact:id => allArtifacts().find(item => item.id === id),
      getError:id => errors.get(id) || '', isLoading:id => loads.has(id),
      isBusy:id => pending.has(id), isStarting:id => pending.has('start:' + id),
      get revision() { return revision; },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      dispose() { disposed = true; clear?.(timer); timer = null; listeners.clear(); }
    };
  }
  const api = {create, active, createRunSynchronizer, canvasApprovalKey, createCanvasHandoffTracker};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StudioProduction = api;
})(typeof window !== 'undefined' ? window : globalThis);
