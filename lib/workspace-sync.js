/* Local workspace sync: explicit CAS conflicts; the runtime's runs remain separate. */
(function (global) {
  'use strict';
  const META = 'creative-workbench-sync-v1', BACKUPS = 'creative-workbench-sync-backups-v1';
  const CONTENT = ['version','presentationVersion','favorites','projects','tasks','decisions','artifacts','messages','activity'];
  const contentKey = state => JSON.stringify(Object.fromEntries(CONTENT.map(key => [key, state[key]])));
  function create(store, options = {}) {
    const fetcher = options.fetch || global.fetch?.bind(global);
    const later = options.setTimeout || global.setTimeout?.bind(global), clear = options.clearTimeout || global.clearTimeout?.bind(global);
    let storage; try {storage = options.storage || global.localStorage;} catch {}
    const listeners = new Set();
    let health, meta = null, remote = null, busy = false, applying = false, stopped = false, timer = null, initial = true;
    let baseKey = '', seenKey = contentKey(store.getState()), locallyChanged = false;
    try {meta = JSON.parse(storage?.getItem(META) || 'null');} catch {}
    const status = {state: options.disabled ? 'disabled' : 'loading', message: '', revision: 0, backupSaved: false};
    const blocked = () => ['loading','conflict'].includes(status.state);
    function notify(state, message = '') {
      status.state = state; status.message = message;
      store.setWriteBlock(blocked() ? message || '正在读取工作台，请稍候。' : '');
      for (const fn of listeners) fn({...status});
    }
    function remember(workspace, key) {
      remote = workspace; baseKey = key; status.revision = workspace?.revision || 0;
      // Validation can remove forged/obsolete fields. Keep both representations:
      // an unchanged server snapshot must not reapply normalized local content.
      meta = {projectId: health.projectId, revision: status.revision, baseKey, normalizedLocalKey: key, rawRemoteKey: workspace ? contentKey(workspace.state) : null};
      try {storage?.setItem(META, JSON.stringify(meta));} catch {}
    }
    function backup(reason) {
      try {
        if (!storage?.setItem) throw new Error('本地存储不可用');
        const items = JSON.parse(storage.getItem(BACKUPS) || '[]');
        const snapshot = store.getState(), fingerprint = contentKey(snapshot);
        if (!items.some(item => contentKey(item.state) === fingerprint)) {
          items.push({savedAt: new Date().toISOString(), reason, state: snapshot});
          storage.setItem(BACKUPS, JSON.stringify(items));
        }
        status.backupSaved = true; return true;
      } catch {status.backupSaved = false; return false;}
    }
    function conflict(message) {
      backup(message);
      notify('conflict', message + (status.backupSaved ? ' 本页副本已保留。' : ' 本页仍保留原数据，请先导出备份。'));
    }
    async function request(path, data) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = controller && later ? later(() => controller.abort(), 12000) : null;
      try {
        const response = await fetcher(path, {method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: data === undefined ? {Accept:'application/json'} : {'Content-Type':'application/json','X-Studio-Token':health?.csrfToken || ''},
          ...(data === undefined ? {} : {body:JSON.stringify(data)}), ...(controller ? {signal:controller.signal} : {})});
        const result = await response.json();
        if (!response.ok) {const error = new Error(result.error || '工作台同步失败。'); error.status = response.status; throw error;}
        return result;
      } catch(error) {if (error.name === 'AbortError') throw new Error('工作台同步超时，本页修改保留在本地。'); throw error;}
      finally {if (timeout != null) clear?.(timeout);}
    }
    function apply(workspace, preserveUI) {
      applying = true;
      try {store.restore(workspace.state, {preserveUI}); seenKey = contentKey(store.getState()); locallyChanged = false; remember(workspace, seenKey);}
      finally {applying = false;}
      notify('synced', '项目已保存到本机数据库');
    }
    async function upload() {
      const snapshot = store.getState(), key = contentKey(snapshot);
      notify('saving', '正在保存到本机数据库…');
      const result = await request('/api/workspace', {expectedRevision: status.revision, state: snapshot});
      remember(result.workspace, key); locallyChanged = contentKey(store.getState()) !== key;
      notify(locallyChanged ? 'saving' : 'synced', locallyChanged ? '正在保存后续修改…' : '项目已保存到本机数据库');
    }
    async function reconcile() {
      const result = await request('/api/workspace'); remote = result.workspace;
      const localKey = contentKey(store.getState());
      if (!remote) {
        if (meta?.revision > 0) {conflict('数据库中暂未找到之前的项目版本，已停止自动覆盖。'); return;}
        remember(null, initial && !store.hadStoredState && !locallyChanged ? localKey : '');
        if (store.hadStoredState || locallyChanged) await upload();
        else notify('synced', '本机数据库已就绪；新项目会自动保存');
        return;
      }
      const remoteKey = contentKey(remote.state);
      if (localKey === remoteKey) {remember(remote, localKey); locallyChanged = false; notify('synced', '项目已保存到本机数据库'); return;}
      if (!store.hadStoredState && initial && !locallyChanged) {apply(remote, false); return;}
      if (meta?.projectId === health.projectId) {
        const dirty = localKey !== (meta.normalizedLocalKey ?? meta.baseKey);
        if (!dirty && meta.revision === remote.revision && meta.rawRemoteKey === remoteKey) {
          status.revision = remote.revision; locallyChanged = false;
          notify('synced', '项目已保存到本机数据库'); return;
        }
        if (!dirty) {apply(remote, true); return;}
        if (meta.revision === remote.revision) {status.revision = remote.revision; await upload(); return;}
      }
      conflict('其他窗口或客户端有不同的项目版本，请选择要继续使用的数据。');
    }
    function schedule() {
      if (stopped || options.disabled) return;
      clear?.(timer); timer = later?.(() => sync(), 4000);
    }
    async function sync() {
      if (busy || stopped || options.disabled || status.state === 'conflict') return;
      busy = true;
      try {
        if (!health || status.state === 'offline') {
          health = await request('/api/health');
          if (health.service !== 'dream-studio-runtime' || !health.workspaceSync || !health.projectId || !health.csrfToken) throw new Error('后台尚未支持客户端同步，本页数据仍保存在浏览器。');
        }
        await reconcile(); initial = false;
      } catch(error) {
        if (error.status === 409) conflict('其他窗口已更新项目，当前修改未覆盖数据库。');
        else {health = null; notify('offline', (error.message || '数据库暂时无法连接。') + ' 修改将先保存在本页，恢复连接后再同步。');}
      } finally {busy = false; schedule();}
    }
    const unsubscribe = store.subscribe(snapshot => {
      const key = contentKey(snapshot); if (applying || key === seenKey) return;
      seenKey = key; locallyChanged = true;
      if (!['loading','conflict','disabled'].includes(status.state)) {
        notify(status.state === 'offline' ? 'offline' : 'saving', status.state === 'offline' ? status.message : '正在保存到本机数据库…');
        clear?.(timer); timer = later?.(() => sync(), 180);
      }
    });
    async function useRemote() {
      if (busy) throw new Error('工作台正在同步，请等待本次操作完成。');
      if (stopped || options.disabled) throw new Error('当前页面未连接工作台同步服务。');
      busy = true; clear?.(timer);
      notify('loading', '正在恢复数据库版本，请稍候…');
      const localKey = contentKey(store.getState());
      try {
        if (!backup('用户选择数据库版本之前的完整本地副本')) throw new Error('本地副本保存失败，已保留当前页面，请先导出备份并释放本地存储空间。');
        const result = await request('/api/workspace');
        if (!result.workspace) throw new Error('数据库暂时没有可恢复的项目，请保留本地版本。');
        // Host restoration may bypass dispatch's write lock. Never replace a
        // snapshot that changed while this request was in flight.
        if (contentKey(store.getState()) !== localKey) throw new Error('恢复期间本页数据发生变化，已停止替换，请核对本地副本后重试。');
        apply(result.workspace, true); initial = false;
      } catch (error) {
        conflict(error.message || '数据库版本恢复失败，当前项目仍保留。');
        throw error;
      } finally {busy = false; schedule();}
    }
    function importState(snapshot) {
      if (busy) throw new Error('工作台正在同步，请等待本次操作完成后再导入。');
      if (blocked()) throw new Error('请先完成同步或处理版本冲突，再导入备份。');
      if (!backup('导入备份之前的完整本地副本')) throw new Error('旧版本备份失败，未导入任何数据。');
      store.restore(snapshot); locallyChanged = true;
      return sync();
    }
    if (!options.disabled) store.setWriteBlock('正在读取本机工作台，请稍候。');
    return {status, blocked, start: sync, retry() {if (status.state === 'conflict') {notify('loading', '正在重新核对两个版本…');} return sync();}, useRemote, importState,
      exportData() {let backups = []; try {backups = JSON.parse(storage?.getItem(BACKUPS) || '[]');} catch {} return {application:'造梦工作室', exportedAt:new Date().toISOString(), state:store.getState(), localBackups:backups};},
      subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}, dispose() {stopped = true; clear?.(timer); unsubscribe();}};
  }
  const api = {create, contentKey, META, BACKUPS};
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.StudioWorkspaceSync = api;
})(typeof window === 'undefined' ? globalThis : window);
