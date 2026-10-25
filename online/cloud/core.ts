export class APIError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const now = () => Date.now();
export const uid = () => crypto.randomUUID().replaceAll('-', '');
export function validId(value: any): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value); }
export function requireId(value: any) { if (!validId(value)) throw new APIError('编号无效。'); return value; }
export function json(data: any, status = 200) { return Response.json(data, {status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}}); }
export async function digest(text: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(v=>v.toString(16).padStart(2,'0')).join(''); }
export function stable(value: any): string { return JSON.stringify(value, (_key,val) => val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a],[b])=>a.localeCompare(b))) : val); }
export class RecordStore {
  constructor(public db: D1Database, public owner: string) {}
  async get(kind: string,id: string) { const row = await this.db.prepare('SELECT body, revision FROM records WHERE owner=? AND kind=? AND id=?').bind(this.owner,kind,id).first<any>(); return row ? {...JSON.parse(row.body), revision:row.revision} : null; }
  async require(kind: string,id: string) { const item = await this.get(kind,id); if (!item) throw new APIError('记录不存在或不属于当前账号。',404); return item; }
  async list(kind: string) { const result = await this.db.prepare('SELECT body,revision FROM records WHERE owner=? AND kind=? ORDER BY updated_at').bind(this.owner,kind).all<any>(); return result.results.map(row=>({...JSON.parse(row.body),revision:row.revision})); }
  async byRequest(kind: string,requestId: string) { const row = await this.db.prepare('SELECT body,revision FROM records WHERE owner=? AND kind=? AND request_id=?').bind(this.owner,kind,requestId).first<any>(); return row ? {...JSON.parse(row.body),revision:row.revision} : null; }
  async create(kind: string, value: any) {
    const item={...value,id:requireId(value.id),revision:1,updatedAt:now()};
    const result=await this.db.prepare('INSERT OR IGNORE INTO records (owner,kind,id,body,revision,request_id,updated_at) VALUES (?,?,?,?,1,?,?)').bind(this.owner,kind,item.id,JSON.stringify(item),item.requestId||null,item.updatedAt).run();
    if (!result.meta.changes) return null;
    return item;
  }
  async put(kind: string,value: any,expectedRevision?: number) {
    const old=await this.get(kind,requireId(value.id));
    const expected=expectedRevision ?? old?.revision ?? 0;
    if(!old) { if(expected!==0) throw new APIError('记录版本已变化，请刷新。',409);const created=await this.create(kind,value);if(!created)throw new APIError('相同请求正在处理，请刷新。',409);return created; }
    const item={...value,revision:expected+1,updatedAt:now()};
    const result=await this.db.prepare('UPDATE records SET body=?,revision=revision+1,updated_at=? WHERE owner=? AND kind=? AND id=? AND revision=?').bind(JSON.stringify(item),item.updatedAt,this.owner,kind,item.id,expected).run();
    if(!result.meta.changes)throw new APIError('其他窗口已修改此记录，请刷新后重试。',409);
    return item;
  }
  async remove(kind: string,id: string) { await this.db.prepare('DELETE FROM records WHERE owner=? AND kind=? AND id=?').bind(this.owner,kind,id).run(); }
}
export interface Context { request:Request; env:any; user:{id:string,email:string,name:string}; store:RecordStore; settings:any; csrfToken:string; waitUntil:(p:Promise<any>)=>void; }
export async function requireProject(ctx: Context,id: string) {
  requireId(id);const workspace=await ctx.store.get('workspace','current');
  const project=workspace?.state?.projects?.find((p:any)=>p.id===id&&!p.isDemo);
  if(!project)throw new APIError('请先创建并保存一个真实项目。',404);
  if((await ctx.store.list('trash')).some((t:any)=>t.kind==='project'&&t.targetId===id&&!t.restoredAt))throw new APIError('此项目已在回收站。',409);
  return project;
}
export async function safeFetch(url: string, init: RequestInit, timeoutMs=180000) { return fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(timeoutMs)}); }
