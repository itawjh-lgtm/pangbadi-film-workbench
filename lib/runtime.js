/* Same-origin execution client. Project records stay in StudioStore; runs stay on the server. */
(function (global) {
  'use strict';
  const trashAPI = global.StudioTrash || (typeof require === 'function' ? require('./trash.js') : null);
  const active = run => ['queued', 'running'].includes(run?.status);
  const scopeKey = scope => scope?.peerId ? 'peer:' + scope.peerId : scope?.projectId ? 'project:' + scope.projectId : '';
  const artifactURL = value => typeof value === 'string' && /^\/api\/artifacts\/[A-Za-z0-9_-]+$/.test(value) ? value : '';
  const modelAvailable = model => Boolean(model) && model.available !== false && model.enabled !== false && model.disabled !== true && model.deprecated !== true;
  function filterMediaModels(models, {kind, query = '', vendor = '', category = ''} = {}) {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return (models || []).filter(model => {
      const id=model.id||model.modelId||'',aliases=(id.startsWith('rhart-image')?'全能图片 ':id.startsWith('rhart-video')?'全能视频 ':'')+(id.startsWith('kling/')?'可灵 ':id.startsWith('bytedance/')?'字节 ':'');
      return (!kind || model.mediaKind === kind) && (!vendor || (model.vendor || model.family || 'RunningHub') === vendor) && (!category || (model.category || model.capability || '其他') === category) && words.every(word => [model.label,model.name,id,model.description,model.vendor,model.family,model.category,model.capability,aliases].join(' ').toLocaleLowerCase().includes(word));
    });
  }
  function validateModelValue(value, schema, label) {
    if (Array.isArray(schema.enum) && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) throw new Error(label + '不在当前模型支持的选项中。');
    if (Object.hasOwn(schema,'const') && JSON.stringify(schema.const)!==JSON.stringify(value))throw new Error(label+'需要模型指定的值。');
    if (value === null) { if (schema.nullable || schema.type === 'null' || Array.isArray(schema.type) && schema.type.includes('null')) return; throw new Error(label + '不能为 null。'); }
    const type = Array.isArray(schema.type) ? schema.type.find(type => type !== 'null') : schema.type;
    if (type === 'integer' || type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || type === 'integer' && !Number.isSafeInteger(value)) throw new Error(label + (type === 'integer' ? '需要可精确表示的整数。' : '需要有效数字。'));
      if (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum) throw new Error(label + '超出模型允许的数值范围。');
      const lower=typeof schema.exclusiveMinimum==='boolean'?(schema.exclusiveMinimum?schema.minimum:null):schema.exclusiveMinimum,upper=typeof schema.exclusiveMaximum==='boolean'?(schema.exclusiveMaximum?schema.maximum:null):schema.exclusiveMaximum;
      if(lower!=null&&value<=lower||upper!=null&&value>=upper)throw new Error(label+'超出模型允许的数值范围。');
      if(schema.multipleOf!=null&&Math.abs(value/schema.multipleOf-Math.round(value/schema.multipleOf))>1e-9)throw new Error(label+'不符合模型允许的步长。');
    } else if (type === 'boolean') { if (typeof value !== 'boolean') throw new Error(label + '需要 true 或 false。'); }
    else if (type === 'array') {
      if (!Array.isArray(value)) throw new Error(label + '需要 JSON 数组。');
      if (schema.minItems != null && value.length < schema.minItems || schema.maxItems != null && value.length > schema.maxItems) throw new Error(label + '的数量超出模型允许范围。');
      if(schema.uniqueItems&&new Set(value.map(item=>JSON.stringify(item))).size!==value.length)throw new Error(label+'不能包含重复项。');
      value.forEach((item,index) => validateModelValue(item,schema.items || {},label + '[' + index + ']'));
    } else if (type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '需要 JSON 对象。');
      if(schema.minProperties!=null&&Object.keys(value).length<schema.minProperties||schema.maxProperties!=null&&Object.keys(value).length>schema.maxProperties)throw new Error(label+'的字段数量超出模型允许范围。');
      for (const key of Array.isArray(schema.required) ? schema.required : []) if (!Object.hasOwn(value,key)) throw new Error(label + '缺少 ' + key + '。');
      for (const [key,item] of Object.entries(value)) {
        if (Object.hasOwn(schema.properties || {},key)) validateModelValue(item,schema.properties[key],label + '.' + key);
        else if (schema.additionalProperties === false) throw new Error(label + '包含未支持的字段 ' + key + '。');
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateModelValue(item,schema.additionalProperties,label + '.' + key);
      }
    } else if (type === 'string') {
      if (typeof value !== 'string') throw new Error(label + '需要文本。');
      if (schema.minLength != null && value.length < schema.minLength || schema.maxLength != null && value.length > schema.maxLength) throw new Error(label + '的长度超出模型允许范围。');
      if(schema.pattern&&!new RegExp(schema.pattern).test(value))throw new Error(label+'不符合模型要求的文本格式。');
      if (['https','uri','url'].includes(schema.format)) {
        let url; try { url = new URL(value); } catch { throw new Error(label + '需要完整的 HTTPS 地址。'); }
        if (url.protocol !== 'https:' || url.username || url.password || /[\s<>"'\\]/.test(value)) throw new Error(label + '需要完整的 HTTPS 地址。');
      }
    }
  }
  function modelParameters(model, values = {}) {
    if (!modelAvailable(model) || !Array.isArray(model.fields)) throw new Error(model?.disabledReason || '请先选择可用的生成模型。');
    // Seedream 5 Pro's resolution overrides custom dimensions at the provider.
    const explicitDimensions=['seedream-v5-pro/text-to-image','seedream-v5-pro/image-to-image'].includes(model.id||model.modelId)&&!Object.hasOwn(values,'resolution')&&(Object.hasOwn(values,'width')||Object.hasOwn(values,'height'));
    const entries = [];
    for (const field of model.fields) {
      if(explicitDimensions&&field.name==='resolution')continue;
      const raw = Object.hasOwn(values,field.name) ? values[field.name] : model.defaults?.[field.name] ?? field.default, label = field.label || field.name;
      let value;
      if (raw === undefined || raw === '') { if (field.required) throw new Error('请填写' + label + '。'); continue; }
      const schema = {...field,...(field.schema || {})}, type = field.type === 'urls' ? 'urls' : Array.isArray(schema.type) ? schema.type.find(type => type !== 'null') : schema.type;
      if (raw === null) value = null;
      else if (type === 'boolean') { if (![true,false,'true','false'].includes(raw)) throw new Error(label + '需要 true 或 false。'); value = raw === true || raw === 'true'; }
      else if (type === 'integer' || type === 'number') { if (!['string','number'].includes(typeof raw) || String(raw).trim() === '') throw new Error(label + '需要有效数字。'); value = Number(raw); }
      else if (type === 'array' || type === 'object') {
        try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error(label + '需要合法 JSON ' + (type === 'array' ? '数组' : '对象') + '。'); }
      } else if (field.type === 'urls') {
        value = (Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/)).map(item => String(item).trim()).filter(Boolean);
        if (field.required && !value.length) throw new Error('请填写' + label + '。');
        if (!value.length) continue;
        if (field.maxItems && value.length > field.maxItems) throw new Error(label + '最多允许 ' + field.maxItems + ' 个链接。');
        for (const item of value) {
          let url; try { url = new URL(item); } catch { throw new Error(label + '需要完整的 HTTPS 图片地址。'); }
          if (url.protocol !== 'https:' || url.username || url.password || /[\s<>"'\\]/.test(item)) throw new Error(label + '需要完整的 HTTPS 图片地址。');
        }
      } else {
        value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
        if (field.required && !value) throw new Error('请填写' + label + '。');
        if (!value) continue;
      }
      if (Array.isArray(field.options) && field.options.length) schema.enum = field.options.map(option => option && typeof option === 'object' && Object.hasOwn(option,'value') ? option.value : option);
      validateModelValue(value,schema,label);
      entries.push([field.name, value]);
    }
    return Object.fromEntries(entries);
  }
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
    const cache = new Map(), listeners = new Set(), loading = new Map(), errors = new Map(), storyboards = new Map(), storyboardLoading = new Map();
    let providers = [], mediaJobs = [], mediaError = '';
    let trashItemsCache = [], trashError = '', trashLoaded = false, trashLoading = null, trashEpoch = 0, trashWrite = Promise.resolve();
    const isDeleted = (kind,id,projectId) => {
      if(trashAPI?.isDeleted(trashItemsCache,kind,id,projectId))return true;
      if(kind==='run'&&id){const run=[...cache.values()].flat().find(run=>run.id===id);return Boolean(run?.productionId&&trashAPI?.isDeleted(trashItemsCache,'production',run.productionId,run.projectId));}
      if(kind==='artifact'&&id){const run=[...cache.values()].flat().find(run=>(run.artifacts||[]).some(a=>a.id===id));return Boolean(run&&isDeleted('run',run.id,run.projectId));}
      return false;
    };
    const visibleState = raw => trashAPI?.visibleState(raw,trashItemsCache) || raw;
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
    function acceptTrash(result) {
      if (!Array.isArray(result.items)) throw new Error('回收站返回格式无效，请刷新后重试。');
      const next=[...result.items,...(Array.isArray(result.tombstones)?result.tombstones:[])].filter(item=>item&&!item.restoredAt), changed=!trashLoaded||JSON.stringify(next)!==JSON.stringify(trashItemsCache)||trashError;
      trashItemsCache=next;trashError='';trashLoaded=true;if(changed)notify();return trashItemsCache;
    }
    async function refreshTrash() {
      if (state!=='online') return trashItemsCache;
      if(trashLoading)return trashLoading;
      const epoch=trashEpoch;
      trashLoading=request('/api/trash').then(result=>epoch===trashEpoch?acceptTrash(result):trashItemsCache).catch(error=>{if(epoch===trashEpoch&&trashError!==error.message){trashError=error.message;notify();}return trashItemsCache;}).finally(()=>{trashLoading=null;});
      return trashLoading;
    }
    function writeTrash(path,body) {
      const next=trashWrite.catch(()=>{}).then(async()=>{trashEpoch++;const result=await request(path,body);trashEpoch++;return acceptTrash(result);});
      trashWrite=next;return next;
    }
    function trashItems(items) { return writeTrash('/api/trash',{items}); }
    function restoreTrash(id) { return writeTrash('/api/trash/'+encodeURIComponent(id)+'/restore',{}); }
    function purgeTrash(ids) { return writeTrash('/api/trash/purge',{ids,confirmation:'permanent-delete'}); }
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
        await refreshTrash();
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
      notify();
    }
    function getStoryboard(projectId) {
      const board=storyboards.get(projectId) || {projectId,status:'idle',shots:[],sources:[],warnings:[],error:''};
      return {...board,shots:(board.shots||[]).filter(shot=>!isDeleted('artifact',shot.sourceArtifactId,projectId)&&!isDeleted('artifact',shot.promptArtifactId,projectId)),sources:(board.sources||[]).filter(source=>!isDeleted('artifact',source.id,projectId))};
    }
    async function loadStoryboard(projectId, force = false) {
      if (!projectId || state !== 'online') return getStoryboard(projectId);
      if (storyboardLoading.has(projectId)) return storyboardLoading.get(projectId);
      if (!force && storyboards.has(projectId)) return getStoryboard(projectId);
      storyboards.set(projectId,{...getStoryboard(projectId),status:'loading',error:''});
      const pending=request('/api/projects/'+encodeURIComponent(projectId)+'/storyboard').then(result=>{
        if (result.projectId !== projectId) throw new Error('分镜来源项目不匹配，请刷新后重试。');
        const value={projectId,status:'ready',shots:Array.isArray(result.shots)?result.shots:[],sources:Array.isArray(result.sources)?result.sources:[],warnings:Array.isArray(result.warnings)?result.warnings:[],error:''};
        storyboards.set(projectId,value);notify();return value;
      }).catch(error=>{
        const value={...getStoryboard(projectId),status:'error',error:error.message};storyboards.set(projectId,value);notify();return value;
      }).finally(()=>storyboardLoading.delete(projectId));
      storyboardLoading.set(projectId,pending);notify();return pending;
    }
    async function saveConnection(config) { const result=await request('/api/connections/runninghub',config); await refreshMedia(); return result; }
    async function verifyRunningHub(mode) { try { const result=await request('/api/connections/runninghub/verify',mode==='model_api'?{mode}: {}, {timeoutMs:55000}); return result.verification; } finally { await refreshMedia(); } }
    async function readRunningHubWorkflow(workflowId) { const result=await request('/api/connections/runninghub/workflow',{workflowId}, {timeoutMs:55000}); return result.workflow; }
    async function saveProvider(id,config) { const result=await request('/api/connections/'+encodeURIComponent(id),config); await refreshMedia(); return result; }
    async function estimateMedia(payload) { const result=await request('/api/media/estimate',payload,payload.mode==='model_api'?{timeoutMs:55000}:{}); return result.estimate; }
    async function submitMedia(payload) { const result=await request('/api/media/jobs',payload,{timeoutMs:55000}); await refreshMedia(); return result.job; }
    async function refreshMediaJob(id) { const result=await request('/api/media/jobs/'+encodeURIComponent(id)+'/refresh',{}, {timeoutMs:55000}); const index=mediaJobs.findIndex(job=>job.id===result.job?.id); if(index>=0)mediaJobs[index]=result.job; else if(result.job)mediaJobs.push(result.job); notify(); return result.job; }
    async function start(payload) {
      if (!ready()) throw new Error(reason || '执行器尚未就绪，请先在工具与连接检查。');
      if (!payload.prompt?.trim()) throw new Error('请填写工作要求。');
      if (!Array.isArray(payload.agentIds) || payload.agentIds.length < 1 || payload.agentIds.length > 4) throw new Error('每次请选择 1 至 4 位伙伴。');
      const result = await request('/api/runs', payload); if (!result.run?.id) throw new Error('服务未返回有效运行编号，请刷新记录后再试。');
      merge(result.run, payload.peerId ? {peerId:payload.peerId} : {projectId:payload.project?.id}); notify(); schedule(); return result.run;
    }
    async function cancel(id) { const result = await request('/api/runs/' + encodeURIComponent(id) + '/cancel', {}); merge(result.run); notify(); schedule(); return result.run; }
    const visibleRun = run => ({...run,artifacts:(run.artifacts||[]).filter(a=>!isDeleted('artifact',a.id,run.projectId))});
    const getRuns = scope => (cache.get(scopeKey(scope)) || []).filter(run=>!isDeleted('run',run.id,run.projectId)).map(visibleRun);
    const allRuns = () => [...cache.values()].flat().filter(run=>!isDeleted('run',run.id,run.projectId)).map(visibleRun);
    return {
      connect, loadScope, start, cancel, ready, scopeKey, active, artifactURL, refreshMedia, getStoryboard, loadStoryboard, saveConnection, verifyRunningHub, readRunningHubWorkflow, saveProvider, estimateMedia, submitMedia, refreshMediaJob, request, refreshTrash, trashItems, restoreTrash, purgeTrash, isDeleted, visibleState,
      get trash() { return {items:trashItemsCache.slice(),error:trashError,loaded:trashLoaded}; },
      get media() { return {providers,jobs:mediaJobs.filter(job=>!isDeleted('media',job.id,job.projectId)),error:mediaError}; },
      get revision() { return revision; },
      get connection() { return {state, reason, health, ready:ready()}; },
      get roles() { return roles; },
      getRuns, getError: scope => errors.get(scopeKey(scope)) || '',
      findRun: id => allRuns().find(run => run.id === id),
      findArtifact: id => allRuns().flatMap(run => (run.artifacts||[]).map(a=>({...a,projectId:run.projectId,runId:run.id}))).find(artifact => artifact.id === id),
      artifacts: scope => getRuns(scope).flatMap(run => (run.artifacts || []).map(artifact => ({...artifact, projectId:run.projectId, peerId:run.peerId, runId:run.id, taskId:run.taskId}))),
      role: id => roles.find(role => role.id === id),
      roleDetail: id => request('/api/roles/' + encodeURIComponent(id)),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      dispose() { disposed = true; clearDelay?.(timer); listeners.clear(); }
    };
  }
  const api = {create, active, scopeKey, artifactURL, mergeWorkflowFields, modelParameters, modelAvailable, filterMediaModels};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StudioRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis);
