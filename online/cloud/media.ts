import catalog from './models.json';
import {APIError,requireProject,requireId,uid,now,json,digest,stable,safeFetch,type Context} from './core';
import {persistSettings} from './auth';
export const models:any[]=catalog;
const BASE='https://www.runninghub.cn',QUERY='/openapi/v2/query',TTL=5*60*1000;
const active=new Set(['submitting','queued','running','unknown']);
const contextFields=['projectId','taskId','shotId','sourceArtifactId','promptArtifactId','productionId','canvasNodeId','canvasNodeHash','sourceVersion','characterReferenceSnapshot'];
const sensitiveFields=new Set(['apiKey','modelApiKey','headers','endpoint','url','webhookUrl','workflowId','nodeInfoList','instanceType','addMetadata']);
export function getModel(id:string){const model=models.find(m=>m.id===id);if(!model)throw new APIError('未找到模型，请刷新目录。');return model;}
export function safeMediaURL(value:any){
 if(typeof value!=='string'||value.length>12000||!/^https:\/\/[^\s"'<>@\\\u0000-\u001f\u007f]+$/.test(value))return '';
 try{const u=new URL(value),host=u.hostname.toLowerCase();if(u.port&&u.port!=='443'||u.username||u.password||host==='localhost'||host.endsWith('.local')||host.endsWith('.localhost')||host.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(host)&&(/^(0|10|127|169\.254|192\.168)\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host)))return '';return value;}catch{return '';}
}
function valid(schema:any,value:any,label:string,depth=0){
 if(depth>16)throw new APIError('模型参数嵌套过深。');if(value===null&&schema.nullable)return;
 if(schema.const!==undefined&&stable(schema.const)!==stable(value)||schema.enum&&!schema.enum.some((v:any)=>stable(v)===stable(value)))throw new APIError(label+' 的选项无效。');
 const kind=schema.type;
 if(kind==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new APIError(label+' 必须是对象。');
  for(const required of schema.required||[])if(value[required]===undefined)throw new APIError(label+' 缺少 '+required+'。');
  for(const [key,item] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw new APIError('不支持此模型参数。');const child=schema.properties?.[key];if(!child&&schema.additionalProperties===false)throw new APIError(label+' 不接受参数 '+key+'。');if(child)valid(child,item,label+'.'+key,depth+1);else if(typeof schema.additionalProperties==='object')valid(schema.additionalProperties,item,label+'.'+key,depth+1);}
  if(schema.minProperties!==undefined&&Object.keys(value).length<schema.minProperties||schema.maxProperties!==undefined&&Object.keys(value).length>schema.maxProperties)throw new APIError(label+' 字段数量无效。');
 }else if(kind==='array'){
  if(!Array.isArray(value)||schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems)throw new APIError(label+' 数量无效。');
  if(schema.uniqueItems&&new Set(value.map(stable)).size!==value.length)throw new APIError(label+' 不能有重复项。');for(const item of value)valid(schema.items||{},item,label,depth+1);
 }else if(kind==='string'){
  if(typeof value!=='string'||schema.minLength!==undefined&&value.length<schema.minLength||schema.maxLength!==undefined&&value.length>schema.maxLength)throw new APIError(label+' 文本长度无效。');
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))throw new APIError(label+' 格式无效。');
  if(['uri','url','https'].includes(schema.format)&&!safeMediaURL(value))throw new APIError(label+' 需要公开 HTTPS 链接。');
 }else if(kind==='integer'||kind==='number'){
  if(typeof value!=='number'||!Number.isFinite(value)||kind==='integer'&&!Number.isInteger(value)||schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum||schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum||schema.exclusiveMaximum!==undefined&&value>=schema.exclusiveMaximum)throw new APIError(label+' 数值无效。');
  if(schema.multipleOf&&Math.abs(value/schema.multipleOf-Math.round(value/schema.multipleOf))>1e-8)throw new APIError(label+' 数值步长无效。');
 }else if(kind==='boolean'&&typeof value!=='boolean')throw new APIError(label+' 必须为布尔值。');
}
export function normalizeParameters(model:any,parameters:any){
 requireAvailable(model);
 if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))throw new APIError('模型参数须为对象。');
 const merged={...structuredClone(model.defaults||{}),...structuredClone(parameters)};
 if(/^seedream-v5-pro\//.test(model.id)&&!Object.hasOwn(parameters,'resolution')&&(Object.hasOwn(parameters,'width')||Object.hasOwn(parameters,'height')))delete merged.resolution;
 if(new TextEncoder().encode(JSON.stringify(merged)).length>512*1024)throw new APIError('模型参数过大。');
 valid(model.schema,merged,'模型参数');
 if(model.id.startsWith('bytedance/seedance-')&&merged.draft===true&&merged.resolution!=='480p')throw new APIError('样片模式的清晰度必须选择 480p。');
 for(const [field,value] of Object.entries(merged))if(/(?:url|urls)$/i.test(field)){const values=Array.isArray(value)?value:[value];if(values.some(v=>v!==''&&v!==null&&!safeMediaURL(v)))throw new APIError(field+' 需要公开 HTTPS 链接。');}
 return merged;
}
function requireAvailable(model:any){if(model.disabled||model.deprecated||model.available===false||model.enabled===false)throw new APIError(model.disabledReason||'该模型已下线，不能提交。',409);}
function credentials(ctx:Context){const key=ctx.settings.runninghubModelApiKey;if(typeof key!=='string'||!key)throw new APIError('请先保存 RunningHub 模型 API Key。',409);return key;}
function redact(value:any,key:string){return String(value||'').split(key).join('[已隐藏]').replace(/Bearer\s+[^\s,;"']+/gi,'Bearer [已隐藏]').replace(/(api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*[^\s,;"']+/gi,'$1=[已隐藏]').slice(0,400);}
function finiteMoney(value:any,label:string){if(typeof value!=='number'&&typeof value!=='string'||value===''||!Number.isFinite(Number(value))||Number(value)<0)throw new APIError(label+'无效。');return Number(value);}
function endpointSafe(endpoint:string){if(!/^\/openapi\/v2\/[a-zA-Z0-9_./\[\]-]+$/.test(endpoint)||endpoint.includes('..'))throw new APIError('模型地址无效。');}
async function providerCall(ctx:Context,endpoint:string,body:any,submitting=false){
 endpointSafe(endpoint);const key=credentials(ctx);
 try{const response=await safeFetch(BASE+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)},45000);if(!response.ok)throw Object.assign(new Error('HTTP'),{httpStatus:response.status});const raw=await response.text();if(raw.length>2*1024*1024)throw new Error('OVERSIZE');const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID');return value;}
 catch(error:any){const unknown=submitting&&(!error.httpStatus||error.httpStatus>=500||[408,429].includes(error.httpStatus));throw Object.assign(new APIError(unknown?'提交结果未知，请先到 RunningHub 核对任务；系统不会自动重复扣费。':'RunningHub 未能完成请求，请检查密钥、权限或稍后重试。',502),{outcomeUnknown:unknown});}
}
async function requestContext(ctx:Context,request:any){
 if(request.provider!=='runninghub'||request.mode!=='model_api')throw new APIError('云端试用目前支持 RunningHub 模型直连。');
 if(Object.keys(request).some(k=>sensitiveFields.has(k)))throw new APIError('生成请求不能携带密钥、服务地址或工作流参数。');
 await requireProject(ctx,requireId(request.projectId));const model=getModel(request.modelId);requireAvailable(model);
 const retirement=await ctx.store.get('model_retirement',await digest(model.id));if(retirement)throw new APIError(retirement.reason,409);
 if(request.quantity!==undefined&&request.quantity!==1)throw new APIError('每次模型任务数量须为 1。');
 const parameters=normalizeParameters(model,request.parameters||{}),key=credentials(ctx);
 if(JSON.stringify(parameters).includes(key))throw new APIError('提示词和模型参数不能包含 API Key。');
 if(request.mediaKind&&request.mediaKind!==model.mediaKind)throw new APIError('模型与生成类型不匹配。');
 const context=Object.fromEntries(contextFields.filter(k=>request[k]!==undefined).map(k=>[k,request[k]]));
 for(const field of ['taskId','sourceArtifactId','promptArtifactId','productionId','canvasNodeId'])if(context[field]!=null)requireId(context[field]);
 if(new TextEncoder().encode(JSON.stringify(context)).length>150000)throw new APIError('生成关联内容过大。');
 return {model,parameters,key,context,credentialHash:await digest(key)};
}
function quoteBinding(info:any,budget:any,currency:any){return digest(stable({modelId:info.model.id,contractHash:info.model.contractHash,parameters:info.parameters,context:info.context,budget,currency,credentialHash:info.credentialHash}));}
function publicQuote(row:any){const {binding,credentialHash,...result}=row;return result;}
async function retirement(ctx:Context,model:any,response:any,key:string){
 const code=String(response.errorCode||''),message=redact(response.errorMessage,key);
 if(code==='40310'||/模型.{0,40}(?:下架|下线|停用)|(?:model|endpoint).{0,40}(?:retired|discontinued|deprecated)/i.test(message))await ctx.store.put('model_retirement',{id:await digest(model.id),modelId:model.id,reason:'RunningHub 中国站已拒绝此模型：'+(message||'模型下线'),createdAt:now()});
}
export async function quoteMedia(ctx:Context,request:any){
 const info=await requestContext(ctx,request),budget=request.budget==null?null:finiteMoney(request.budget,'预算');
 if(request.estimateToken){
  const row=await ctx.store.require('estimate',requireId(request.estimateToken));
  if(row.projectId!==request.projectId||row.kind!=='model'||row.expiresAt<=new Date().toISOString()||row.binding!==await quoteBinding(info,budget??row.budget,request.currency??row.currency))throw new APIError('模型报价已过期或参数、预算、密钥已变化，请重新估价。',409);
  return publicQuote(row);
 }
 const response=await providerCall(ctx,info.model.priceEndpoint,info.parameters);await retirement(ctx,info.model,response,info.key);
 if(response.errorCode&&String(response.errorCode)!=='0'||response.errorMessage||typeof response.currency!=='string'||!/^[A-Z][A-Z_]{1,15}$/.test(response.currency)||typeof response.isFreeThisCall!=='boolean')throw new APIError('RunningHub 未返回有效官方报价，请检查模型权限。',502);
 const price=finiteMoney(response.estimatedPrice,'官方估价');if(price===0&&!response.isFreeThisCall)throw new APIError('平台未确认免费，不能按零费用提交。',502);
 if(request.currency&&request.currency!==response.currency)throw new APIError('预算币种与报价不一致。');
 const cap=budget??price,token=uid(),row={id:token,kind:'model',projectId:request.projectId,provider:'runninghub',mode:'model_api',modelId:info.model.id,modelName:info.model.name,known:true,estimatedCost:price,unitPrice:price,quantity:1,currency:response.currency,unit:'次',budget:cap,withinBudget:price<=cap,pricingSource:'runninghub_price_preview',isFreeThisCall:response.isFreeThisCall,hardBudgetCap:false,budgetNotice:'官方报价为预估，实际费用由你的 RunningHub 账户按平台规则结算。',quotedAt:new Date().toISOString(),expiresAt:new Date(now()+TTL).toISOString(),estimateToken:token,binding:await quoteBinding(info,cap,response.currency),createdAt:now()};
 const saved=await ctx.store.create('estimate',row);if(!saved)throw new APIError('报价保存失败，请重新估价。',409);return publicQuote(saved);
}
function normalizedResult(response:any,taskId:string,key:string){
 if(response.taskId!=null&&String(response.taskId)!==taskId)throw new APIError('RunningHub 返回了不匹配的任务，结果未采用。',502);
 const status=({QUEUED:'queued',PENDING:'queued',RUNNING:'running',SUCCESS:'succeeded',SUCCEEDED:'succeeded',FAILED:'failed',FAILURE:'failed',CANCELLED:'cancelled',CANCELED:'cancelled'} as Record<string,string>)[String(response.status||'').toUpperCase()]||'unknown';
 const outputs=[],textOutputs=[];
 if(response.results!==undefined&&!Array.isArray(response.results))throw new APIError('平台结果格式异常，请继续查询原任务。',502);
 for(const item of (response.results||[]).slice(0,100)){
  if(!item||typeof item!=='object')continue;
  if(safeMediaURL(item.url)&&!item.url.includes(key))outputs.push({url:item.url,outputType:redact(item.outputType||'unknown',key),storage:'provider',downloaded:false});
  if(typeof item.text==='string'&&textOutputs.length<8)textOutputs.push({text:item.text.split(key).join('[已隐藏]').slice(0,20000),outputType:'text'});
 }
 const error=response.errorCode&&String(response.errorCode)!=='0'||response.errorMessage?{code:redact(response.errorCode||'PROVIDER_ERROR',key),message:redact(response.errorMessage||'平台任务失败',key)}:null;
 return {task_id:taskId,status,providerStatus:redact(response.status||'UNKNOWN',key),outputs,textOutputs,error,actualCost:null,billingUrl:BASE+'/call-api/bill-task',...(status==='succeeded'||status==='failed'?{finishedAt:now()}:{})};
}
export async function submitMedia(ctx:Context,request:any){
 requireId(request.requestId);const requestHash=await digest(stable(request)),prior=await ctx.store.byRequest('media',request.requestId);
 if(prior){if(prior.requestHash!==requestHash)throw new APIError('同一个请求编号不能改变生成参数。',409);await requireProject(ctx,prior.projectId);return prior;}
 if(request.confirmCost!==true)throw new APIError('请先确认本次费用。');
 const info=await requestContext(ctx,request),quote=await quoteMedia(ctx,request);
 if(!request.estimateToken||!quote.withinBudget)throw new APIError('请取得有效报价并确认预算。',409);
 // A unique quote claim and request record are committed before any billable call.
 const claim=await ctx.store.create('media_quote_claim',{id:quote.estimateToken,requestId:quote.estimateToken,mediaRequestId:request.requestId,requestHash,projectId:request.projectId,createdAt:now()});
 if(!claim){const saved=await ctx.store.byRequest('media',request.requestId);if(saved?.requestHash===requestHash)return saved;throw new APIError('此报价已提交过或正在受理，刷新原任务查看。',409);}
 let job=await ctx.store.create('media',{id:uid(),requestId:request.requestId,requestHash,...info.context,provider:'runninghub',mode:'model_api',modelId:info.model.id,name:info.model.name,mediaKind:info.model.mediaKind,parameters:info.parameters,estimate:quote,status:'submitting',outputs:[],createdAt:now(),credentialHash:info.credentialHash});
 if(!job){const saved=await ctx.store.byRequest('media',request.requestId);if(saved?.requestHash===requestHash)return saved;throw new APIError('任务受理中，请刷新。',409);}
 try{
  const response=await providerCall(ctx,info.model.endpoint,info.parameters,true);await retirement(ctx,info.model,response,info.key);
  if(!response.taskId&&(response.errorCode&&String(response.errorCode)!=='0'||response.errorMessage))job={...job,status:'failed',error:{code:redact(response.errorCode,info.key),message:redact(response.errorMessage||'RunningHub 拒绝任务',info.key)},finishedAt:now()};
  else if(!response.taskId||!/^[-\w]{1,160}$/.test(String(response.taskId))||String(response.taskId).includes(info.key))job={...job,status:'unknown',error:{code:'OUTCOME_UNKNOWN',message:'平台没有返回有效任务编号，请到平台核对；不会自动重试。'}};
  else{const taskId=String(response.taskId);try{job={...job,...normalizedResult(response,taskId,info.key)};}catch{job={...job,task_id:taskId,status:'unknown',error:{code:'INVALID_OUTPUTS',message:'已取得任务编号，等待查询结果。'}};}}
 }catch(error:any){job={...job,status:error.outcomeUnknown?'unknown':'failed',error:{code:error.outcomeUnknown?'OUTCOME_UNKNOWN':'PROVIDER_ERROR',message:error instanceof APIError?error.message:'请求未完成，请检查原任务。'}};}
 return ctx.store.put('media',job,job.revision);
}
export async function pollMedia(ctx:Context,job:any){
 await requireProject(ctx,job.projectId);const current=await ctx.store.require('media',job.id);if(!active.has(current.status)||!current.task_id)return current;
 const key=credentials(ctx);if(current.credentialHash&&current.credentialHash!==await digest(key))throw new APIError('该任务由另一版模型密钥创建，请恢复原密钥后查询。',409);
 const response=await providerCall(ctx,QUERY,{taskId:current.task_id}),result=normalizedResult(response,current.task_id,key);
 try{return await ctx.store.put('media',{...current,...result},current.revision);}catch(error:any){if(error.status===409)return ctx.store.require('media',job.id);throw error;}
}
function publicJob(job:any){const {credentialHash,requestHash,...safe}=job;return safe;}
async function publicModels(ctx:Context){const retired=await ctx.store.list('model_retirement');return models.map(m=>{const found=retired.find(r=>r.modelId===m.id);return found?{...m,available:false,enabled:false,disabled:true,status:'disabled',disabledReason:found.reason}:m;});}
async function connections(ctx:Context){
 const configured=Boolean(ctx.settings.runninghubModelApiKey),catalog=await publicModels(ctx);
 return {providers:[{id:'runninghub',label:'RunningHub',supportsApi:true,configured,keyConfigured:configured,available:configured,verified:false,platformUrl:BASE,apiKeyUrl:BASE+'/call-api/bill-task?tab=keys&type=shared',billingUrl:BASE+'/call-api/bill-task',reason:configured?'模型密钥已保存；调用费用使用你的个人账户。':'请配置模型 API Key。',config:{workflowId:'',currency:'CNY',unit:'次'},models:catalog,modelConnection:{keyConfigured:configured,available:configured,verified:false,reason:configured?'已保存；生成前读取官方报价。':'请配置模型 API Key。'}}],defaultProvider:'runninghub',scope:'account_configuration',budgetNotice:'所有生成费用由当前登录用户的 RunningHub 账号结算。'};
}
export async function mediaRoute(ctx:Context,path:string,method:string,data:any):Promise<Response|null>{
 if(method==='GET'&&(path==='/api/connections'||path==='/api/media/connections'))return json(await connections(ctx));
 if(method==='GET'&&path==='/api/media/models')return json({provider:'runninghub',models:await publicModels(ctx)});
 if(method==='POST'&&path==='/api/connections/runninghub'){
  const settings={...ctx.settings};for(const [input,key] of [['modelApiKey','runninghubModelApiKey'],['apiKey','runninghubApiKey']])if(data[input]){if(typeof data[input]!=='string'||data[input].length<12||data[input].length>1000||/\s/.test(data[input]))throw new APIError('API Key 格式无效。');settings[key]=data[input];}
  if(data.clearModelApiKey||data.clearModelKey)delete settings.runninghubModelApiKey;if(data.clearApiKey||data.clearKey)delete settings.runninghubApiKey;
  await persistSettings(ctx,settings);return json({connection:(await connections(ctx)).providers[0]});
 }
 if(method==='POST'&&path==='/api/connections/runninghub/verify'){
  if(data.mode&&data.mode!=='model_api')throw new APIError('云端请使用模型 API 连接。');
  const model=getModel('seedream-v5-pro/text-to-image');const response=await providerCall(ctx,model.priceEndpoint,normalizeParameters(model,{prompt:'连接验证，不提交生成'}));
  if(response.errorMessage||response.errorCode&&String(response.errorCode)!=='0'||response.estimatedPrice==null)throw new APIError('模型估价验证未通过，请核对密钥权限。',502);
  return json({verification:{verified:true,scope:'price_preview',checkedAt:new Date().toISOString()}});
 }
 if(method==='POST'&&path==='/api/media/estimate')return json({estimate:await quoteMedia(ctx,data)});
 if(method==='POST'&&path==='/api/media/jobs')return json({job:publicJob(await submitMedia(ctx,data))},202);
 if(method==='GET'&&path==='/api/media/jobs'){
  const trash=await ctx.store.list('trash');const rows=(await ctx.store.list('media')).filter(j=>!trash.some(t=>!t.restoredAt&&(t.kind==='media'&&t.targetId===j.id||t.kind==='project'&&t.targetId===j.projectId)));
  return json({jobs:rows.map(publicJob)});
 }
 const match=path.match(/^\/api\/media\/jobs\/([-\w]+)(?:\/(refresh))?$/);if(match){const job=await ctx.store.require('media',match[1]);await requireProject(ctx,job.projectId);return json({job:publicJob(method==='POST'&&match[2]?await pollMedia(ctx,job):job)});}
 return null;
}
