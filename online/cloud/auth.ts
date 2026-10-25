import { APIError, RecordStore, digest, json, type Context } from './core';
const KEYS=['textApiKey','runninghubApiKey','runninghubModelApiKey'];
export const TEXT_PROVIDERS={deepseek:{label:'DeepSeek',endpoint:'https://api.deepseek.com/chat/completions',defaultModel:'deepseek-chat'},qwen:{label:'通义千问',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',defaultModel:'qwen-plus'},openai:{label:'OpenAI',endpoint:'https://api.openai.com/v1/chat/completions',defaultModel:'gpt-4.1-mini'}};
function base64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value: string) { return Uint8Array.from(atob(value),c=>c.charCodeAt(0)); }
async function cryptoKey(secret: string) {
  if(!secret||secret.length<40)throw new APIError('云端密钥保险箱尚未配置。',503);
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret)),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
export async function encrypt(value: any,secret: string,owner: string) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(owner)},await cryptoKey(secret),new TextEncoder().encode(JSON.stringify(value)));
  return base64(iv)+'.'+base64(new Uint8Array(bytes));
}
export async function decrypt(value: string,secret: string,owner: string) {
  try {const [iv,body]=value.split('.');return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(iv),additionalData:new TextEncoder().encode(owner)},await cryptoKey(secret),unbase64(body))));}
  catch {throw new APIError('无法解锁已保存的连接，请联系站点维护者。',503);}
}
export async function readSettings(env:any,owner:string) {const row=await env.DB.prepare('SELECT ciphertext FROM settings WHERE owner=?').bind(owner).first();return row?decrypt(row.ciphertext,env.VAULT_SECRET,owner):{};}
export async function persistSettings(ctx:Context,settings:any) {
  const ciphertext=await encrypt(settings,ctx.env.VAULT_SECRET,ctx.user.id);
  await ctx.env.DB.prepare('INSERT INTO settings (owner,ciphertext,updated_at) VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').bind(ctx.user.id,ciphertext,Date.now()).run();ctx.settings=settings;
}
export function publicSettings(settings:any) {return {billing:'visitor',configured:{text:Boolean(settings.textApiKey),runninghub:Boolean(settings.runninghubApiKey),runninghubModels:Boolean(settings.runninghubModelApiKey)},textProvider:settings.textProvider||'deepseek',textModel:settings.textModel||'deepseek-chat',providers:Object.entries(TEXT_PROVIDERS).map(([id,v])=>({id,label:v.label,defaultModel:v.defaultModel}))};}
export function identity(request:Request) {
  const id=request.headers.get('oai-authenticated-user-id'),email=request.headers.get('oai-authenticated-user-email');
  if(!id||!email)throw new APIError('请先登录，再使用个人工作台。',401);
  let name=email;try {name=decodeURIComponent(request.headers.get('oai-authenticated-user-full-name')||'')||email;}catch{}
  return {id,email,name};
}
export async function context(request:Request,env:any,waitUntil:Context['waitUntil']):Promise<Context> {
  const user=identity(request);if(!env.DB)throw new APIError('云数据库尚未连接。',503);
  if(!env.VAULT_SECRET)throw new APIError('云端密钥保险箱尚未配置。',503);
  const csrfToken=await digest(env.VAULT_SECRET+':csrf:'+user.id);
  if(!['GET','HEAD'].includes(request.method)) {
    const origin=request.headers.get('Origin');
    if(origin&&origin!==new URL(request.url).origin)throw new APIError('不允许跨站操作。',403);
    if(request.headers.get('Sec-Fetch-Site')==='cross-site'||request.headers.get('X-Studio-Token')!==csrfToken)throw new APIError('连接校验已失效，请刷新页面。',403);
  }
  const settings=await readSettings(env,user.id);
  return {request,env,user,store:new RecordStore(env.DB,user.id),settings,csrfToken,waitUntil};
}
export async function settingsRoute(ctx:Context,path:string,method:string,data:any) {
  if(path==='/api/cloud/session')return json({user:ctx.user,...publicSettings(ctx.settings),csrfToken:ctx.csrfToken,mode:'cloud'});
  if(path!=='/api/cloud/settings')return null;
  if(method==='POST') {
    const allowed=new Set([...KEYS,'textProvider','textModel','clearTextKey','clearRunninghubKey','clearRunninghubModelKey']);
    if(Object.keys(data).some(k=>!allowed.has(k)))throw new APIError('包含不支持的设置字段。');
    const next={...ctx.settings};
    if(data.textProvider!==undefined){if(!Object.hasOwn(TEXT_PROVIDERS,data.textProvider))throw new APIError('请选择支持的文字模型服务。');if(data.textProvider!==(ctx.settings.textProvider||'deepseek')){delete next.textApiKey;if(data.textModel===undefined)next.textModel=TEXT_PROVIDERS[data.textProvider as keyof typeof TEXT_PROVIDERS].defaultModel;}next.textProvider=data.textProvider;}
    if(data.textModel!==undefined){if(typeof data.textModel!=='string'||!/^[-A-Za-z0-9_./:]{1,100}$/.test(data.textModel))throw new APIError('模型名称无效。');next.textModel=data.textModel;}
    for(const key of KEYS)if(data[key]){if(typeof data[key]!=='string'||data[key].length<12||data[key].length>512||/[\s\x00-\x1f]/.test(data[key]))throw new APIError('API Key 格式无效。');next[key]=data[key];}
    for(const [flag,key] of [['clearTextKey','textApiKey'],['clearRunninghubKey','runninghubApiKey'],['clearRunninghubModelKey','runninghubModelApiKey']])if(data[flag]===true)delete next[key];
    next.textProvider??='deepseek';next.textModel??=TEXT_PROVIDERS[next.textProvider as keyof typeof TEXT_PROVIDERS].defaultModel;
    await persistSettings(ctx,next);
  }
  return json(publicSettings(ctx.settings));
}
