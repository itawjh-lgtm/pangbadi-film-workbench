import {APIError,json} from './core';
import {context,settingsRoute,publicSettings} from './auth';
import {workspaceRoute} from './workspace';
import {textRoute} from './text';
import {productionRoute} from './productions';
import {mediaRoute} from './media';
import {canvasRoute} from './canvas';
export async function api(request:Request,env:any,waitUntil=(p:Promise<any>)=>{void p.catch(()=>{});}){
  let ctx:any;
  try{
    if(!['GET','POST'].includes(request.method))throw new APIError('不支持此请求方式。',405);
    ctx=await context(request,env,waitUntil);const path=new URL(request.url).pathname;
    let data:any={};if(request.method==='POST'){
      if(!request.headers.get('content-type')?.includes('application/json'))throw new APIError('请提交 JSON 数据。',415);
      if(Number(request.headers.get('content-length'))>1000000)throw new APIError('提交内容过大。',413);
      const reader=request.body?.getReader(),decoder=new TextDecoder();let body='',bytes=0;
      if(reader){while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1000000){await reader.cancel();throw new APIError('提交内容过大。',413);}body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();}
      try{data=JSON.parse(body);}catch{throw new APIError('JSON 格式无效。');}
      if(!data||typeof data!=='object'||Array.isArray(data))throw new APIError('请提交有效对象。');
    }
    if(path==='/api/health'||path==='/api/service-status')return json({ok:true,service:'dream-studio-runtime',version:'cloud-1.0',projectId:'cloud-'+ctx.user.id,workspaceSync:true,csrfToken:ctx.csrfToken,mode:'cloud',provider:{available:true,authenticated:Boolean(ctx.settings.textApiKey),name:'云端文字模型',reason:ctx.settings.textApiKey?'已保存个人模型连接，调用费用由你的模型账号结算。':'请在模型连接中填写自己的文字模型 API Key。'},capabilities:{text:Boolean(ctx.settings.textApiKey),files:true,images:Boolean(ctx.settings.runninghubModelApiKey),video:Boolean(ctx.settings.runninghubModelApiKey),mediaConfiguration:true,workspaceSync:true,automaticCollaboration:true},...publicSettings(ctx.settings)});
    for(const handler of [settingsRoute,workspaceRoute,textRoute,productionRoute,mediaRoute,canvasRoute]){const result=await handler(ctx,path,request.method,data);if(result)return result;}
    throw new APIError('接口不存在。',404);
  }catch(error:any){
    let message=error instanceof APIError?error.message:'云端服务暂时无法处理，请保留页面并稍后重试。';
    if(ctx)for(const key of ['textApiKey','runninghubApiKey','runninghubModelApiKey'])if(ctx.settings[key])message=message.split(ctx.settings[key]).join('[已隐藏]');
    return json({error:message},error instanceof APIError?error.status:500);
  }
}
