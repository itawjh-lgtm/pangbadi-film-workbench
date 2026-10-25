import {APIError,requireProject,requireId,uid,now,json,digest,stable,type Context} from './core';
import {getModel,normalizeParameters,quoteMedia,submitMedia,pollMedia} from './media';
const ACTIVE=new Set(['pending','queued','running','submitting','stopping']);
const IMAGE='seedream-v5-pro/text-to-image',EDIT='seedream-v5-pro/image-to-image',VIDEO='bytedance/seedance-2.5-token/image-to-video';
const text=(v:any,max=20000)=>typeof v==='string'?v.slice(0,max):'';
const safeURL=(v:any)=>typeof v==='string'&&/^https:\/\/[^\s"'<>@\\]+$/.test(v)?v:'';
const clone=(v:any)=>structuredClone(v);
const cleanError=(e:any)=>e instanceof APIError?e.message:'生成受理状态待核对，请刷新已有任务；不会自动重复提交。';
const deleted=(trash:any[],kind:string,id:string,pid?:string)=>trash.some(t=>!t.restoredAt&&((t.kind===kind&&t.targetId===id)||(pid&&t.kind==='project'&&t.targetId===pid)));
const revision=(doc:any,value:any)=>{if(!Number.isInteger(value)||value!==doc.revision)throw new APIError('画布已在其他窗口更新，请刷新后再操作。',409);};
const execution=(n:any)=>Object.fromEntries(['id','mediaKind','nodeKind','shotId','sourceVersion','sourceArtifactId','promptArtifactId','prompt','modelId','parameters','parameterDraft','stylePreset','referenceNodeId','characterAssetIds','promptField'].filter(k=>n[k]!==undefined).map(k=>[k,n[k]]));
const nodeHash=(n:any)=>digest(stable(execution(n)));
function modelDefaults(id:string){const m=getModel(id),defaults={...clone(m.defaults||{})};if(id===IMAGE||id===EDIT){defaults.width=2048;defaults.height=2048;defaults.outputFormat='png';delete defaults.resolution;}return defaults;}
function imageOutput(job:any,index?:number){if(job?.status!=='succeeded'||job.mediaKind==='video')return null;const outputs=job.outputs||[];const found=index===undefined?outputs.find((o:any)=>safeURL(o.url)):outputs[index];return found&&safeURL(found.url)?found:null;}
async function sources(ctx:Context,pid:string){
 const trash=await ctx.store.list('trash');
 const plans=(await ctx.store.list('production')).filter(p=>p.projectId===pid&&!deleted(trash,'production',p.id,pid)).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
 const plan=plans[0];
 const allArtifacts=(await ctx.store.list('artifact')).filter(a=>a.projectId===pid&&!deleted(trash,'artifact',a.id,pid)&&a.productionId===plan?.id);
 const activeStage=(id:string)=>plan?.stages?.find((s:any)=>s.id===id);
 const stageArtifact=(id:string,field:string)=>{const stage=activeStage(id);if(stage?.status!=='completed')return null;const ids=stage.outputArtifactIds||stage.artifacts?.map((a:any)=>a.id)||[];return allArtifacts.filter(a=>a.stageId===id&&ids.includes(a.id)&&Array.isArray(a.structured?.[field])).at(-1)||null;};
 const visualStage=activeStage('visual');
 const visual=plan?.reviewMode==='stepwise'&&!(visualStage?.review?.action==='approve'&&visualStage?.review?.reviewer==='user')?null:stageArtifact('visual','characters');
 const board=stageArtifact('storyboard','shots'),prompts=stageArtifact('prompts','shots');
 const confirmed=Boolean(plan?.status==='completed');
 const shotSource=prompts||board;
 const chars=visual?.structured.characters||[];
 const rawShots=board?.structured.shots||shotSource?.structured.shots||[];
 const shots=confirmed?rawShots.map((shot:any)=>({...shot,...(prompts?.structured.shots.find((s:any)=>s.id===shot.id)||{}),sourceArtifactId:board?.id||shotSource?.id,promptArtifactId:prompts?.id||null})):[];
 return{trash,plan,visual,board,prompts,chars,shots,confirmed,assetVersion:visual?await digest(stable([visual.id,visual.structured])):'',version:confirmed&&shotSource?await digest(stable([plan.id,board?.id,shotSource.id,rawShots,prompts?.structured])):'',warnings:confirmed?[]:['文稿尚未最终确认；确认后全部分镜会自动进入画布。']};
}
export async function ensureCanvas(ctx:Context,pid:string){
 await requireProject(ctx,pid);const source=await sources(ctx,pid);
 let doc=await ctx.store.get('canvas',pid),changed=false;
 if(!doc){doc={id:pid,projectId:pid,revision:0,nodes:[],characterAssets:[],viewport:{x:30,y:30,scale:.85},sourceRevision:'',assetSourceVersion:''};changed=true;}
 for(const [index,character] of source.chars.entries()){
  const characterId=text(character.id,120)||'character-'+index;
  const id='char-'+(await digest(source.assetVersion+':'+characterId)).slice(0,24);
  if(doc.nodes.some((n:any)=>n.id===id)||deleted(source.trash,'canvas_node',id,pid))continue;
  const prompt=text(character.imagePrompt||character.description);if(!prompt)continue;
  const assetId='asset-'+id.slice(5),name=text(character.name,120)||'人物 '+(index+1);
  doc.nodes.push({id,nodeKind:'character',assetId,mediaKind:'image',title:name,prompt,modelId:IMAGE,modelSelectionOrigin:'automatic',parameters:modelDefaults(IMAGE),position:{x:index*340,y:-460},selected:true,stylePreset:'original',promptField:'prompt',sourceArtifactId:source.visual.id,sourceVersion:source.assetVersion,characterAssetIds:[]});
  doc.characterAssets.push({...clone(character),id:assetId,characterId,nodeId:id,name,prompt,description:text(character.description),status:'draft',sourceNature:'document',sourceVersion:source.assetVersion,sourceArtifactId:source.visual.id,version:1});changed=true;
 }
 const activeAssets=doc.characterAssets.filter((a:any)=>!a.sourceVersion||a.sourceVersion===source.assetVersion);
 for(const [index,shot] of source.shots.entries()){
  const shotId=text(shot.id,120)||'S'+String(index+1).padStart(3,'0');
  const imageId='shot-'+(await digest(source.version+':'+shotId+':image')).slice(0,24),videoId='shot-'+(await digest(source.version+':'+shotId+':video')).slice(0,24);
  const assetIds=(shot.characterIds||[]).map((id:string)=>activeAssets.find((a:any)=>a.characterId===id||a.name===id)?.id||'missing-character-'+text(id,120));
  for(const mediaKind of ['image','video']){
   const id=mediaKind==='image'?imageId:videoId;if(doc.nodes.some((n:any)=>n.id===id)||deleted(source.trash,'canvas_node',id,pid))continue;
   const modelId=mediaKind==='video'?VIDEO:assetIds.length?EDIT:IMAGE;
   doc.nodes.push({id,nodeKind:'shot',mediaKind,shotId,title:text(shot.title||shotId,160)+' · '+(mediaKind==='image'?'图片':'视频'),prompt:text(mediaKind==='image'?shot.imagePrompt||shot.description:shot.videoPrompt||shot.description),modelId,modelSelectionOrigin:'automatic',parameters:modelDefaults(modelId),position:{x:index*340,y:mediaKind==='image'?0:440},selected:mediaKind==='image',stylePreset:'original',promptField:'prompt',sourceArtifactId:shot.sourceArtifactId,promptArtifactId:shot.promptArtifactId,sourceVersion:source.version,characterAssetIds:assetIds,...(mediaKind==='video'?{referenceNodeId:imageId}:{})});changed=true;
  }
 }
 if(doc.sourceRevision!==source.version||doc.assetSourceVersion!==source.assetVersion){doc.sourceRevision=source.version;doc.assetSourceVersion=source.assetVersion;changed=true;}
 if(changed){try{doc=await ctx.store.put('canvas',doc,doc.revision);}catch(e:any){if(e.status!==409)throw e;doc=await ctx.store.require('canvas',pid);}}
 return{doc,source};
}
async function visible(ctx:Context,pid:string){
 const {doc,source}=await ensureCanvas(ctx,pid);const result=clone(doc);
 const jobs=(await ctx.store.list('media')).filter(j=>j.projectId===pid&&!deleted(source.trash,'media',j.id,pid));
 result.nodes=result.nodes.filter((n:any)=>!deleted(source.trash,'canvas_node',n.id,pid));
 result.characterAssets=result.characterAssets.filter((a:any)=>result.nodes.some((n:any)=>n.id===a.nodeId));
 for(const node of result.nodes){const matches=jobs.filter(j=>j.canvasNodeId===node.id).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));node.jobIds=matches.map(j=>j.id);const last=matches.at(-1);if(last)Object.assign(node,{status:last.status,error:last.error,outputs:last.outputs||[],lastJobId:last.id});node.stale=Boolean(node.sourceVersion&&node.sourceVersion!==(node.nodeKind==='character'?result.assetSourceVersion:result.sourceRevision));}
 for(const asset of result.characterAssets){
  const node=result.nodes.find((n:any)=>n.id===asset.nodeId);if(!node)continue;
  const hash=await nodeHash(node),reference=jobs.find(j=>j.id===asset.referenceJobId);
  if(asset.confirmedAt&&(asset.nodeHash!==hash||!imageOutput(reference,asset.outputIndex)))asset.status='stale';
  if(asset.sourceVersion&&asset.sourceVersion!==result.assetSourceVersion){asset.status='stale';continue;}
  const candidates=jobs.filter(j=>j.canvasNodeId===node.id&&j.canvasNodeHash===hash&&imageOutput(j));const baseline=candidates.findIndex(j=>j.id===asset.referenceJobId);const candidate=candidates.slice(baseline+1).at(-1);
  if(candidate){asset.status='pending_review';asset.reviewCandidate={jobId:candidate.id,outputIndex:0,url:imageOutput(candidate)!.url};}
 }
 result.batches=(await reconcileStoredBatches(ctx,pid)).map(publicBatch);
 result.storyboard={projectId:pid,shots:source.shots,sources:[source.visual,source.board,source.prompts].filter(Boolean).map(a=>({id:a.id,title:a.title,stageId:a.stageId})),warnings:source.warnings,confirmed:source.confirmed,sourceRevision:source.version,productionId:source.plan?.id||null};return result;
}
function position(value:any,viewport=false){if(!value||!Number.isFinite(value.x)||!Number.isFinite(value.y)||Math.abs(value.x)>1e7||Math.abs(value.y)>1e7)throw new APIError('画布坐标无效。');return{x:value.x,y:value.y,...(viewport?{scale:Math.max(.18,Math.min(2,Number(value.scale)||1))}:{})};}
async function save(ctx:Context,pid:string,data:any){
 const {doc,source}=await ensureCanvas(ctx,pid);revision(doc,data.expectedRevision);
 if(!Array.isArray(data.nodes)||data.nodes.length>1000)throw new APIError('画布节点数量无效。');
 const seen=new Set(),old=new Map(doc.nodes.map((n:any)=>[n.id,n]));
 const editable=['title','prompt','modelId','parameters','parameterDraft','selected','stylePreset','referenceNodeId','promptField','optimization','modelSelectionOrigin'];
 const nodes=data.nodes.map((value:any)=>{const id=requireId(value?.id);if(seen.has(id))throw new APIError('画布节点编号重复。');seen.add(id);if(deleted(source.trash,'canvas_node',id,pid))return null;const previous:any=old.get(id);const node:any=previous?clone(previous):{id,mediaKind:value.mediaKind,nodeKind:'free',characterAssetIds:[]};if(!['image','video'].includes(node.mediaKind))throw new APIError('请选择图片或视频节点。');for(const key of editable)if(Object.hasOwn(value,key))node[key]=clone(value[key]);node.title=text(node.title,160);node.prompt=text(node.prompt);node.position=position(value.position||{x:0,y:0});if(node.modelId&&getModel(node.modelId).mediaKind!==node.mediaKind)throw new APIError('模型与节点类型不一致。');return node;}).filter(Boolean);
 // Hidden nodes are restored only through the recycle bin, never erased by a filtered autosave.
 for(const previous of doc.nodes)if(!seen.has(previous.id))nodes.push(previous);
 doc.nodes=nodes;doc.viewport=position(data.viewport||doc.viewport,true);await ctx.store.put('canvas',doc,data.expectedRevision);return visible(ctx,pid);
}
async function nodeRequest(ctx:Context,pid:string,doc:any,node:any){
 const source=await sources(ctx,pid);if(deleted(source.trash,'canvas_node',node.id,pid))throw new APIError('节点已在回收站。',409);
 if(node.sourceVersion&&node.sourceVersion!==(node.nodeKind==='character'?source.assetVersion:source.version))throw new APIError('源稿版本已更新，请使用当前已确认的画布节点。',409);
 for(const key of ['sourceArtifactId','promptArtifactId'])if(node[key]&&deleted(source.trash,'artifact',node[key],pid))throw new APIError('来源文稿已在回收站。',409);
 const model=getModel(node.modelId),fields=new Set((model.fields||[]).map((f:any)=>f.name));if(model.mediaKind!==node.mediaKind)throw new APIError('模型与节点类型不一致。');
 const parameters={...clone(node.parameters||{})};const promptField=fields.has(node.promptField)?node.promptField:fields.has('prompt')?'prompt':null;
 if(promptField&&!parameters[promptField])parameters[promptField]=node.prompt;
 const jobs=(await ctx.store.list('media')).filter(j=>j.projectId===pid&&!deleted(source.trash,'media',j.id,pid));const snapshots=[];
 for(const id of node.characterAssetIds||[]){const asset=doc.characterAssets.find((a:any)=>a.id===id),character=doc.nodes.find((n:any)=>n.id===asset?.nodeId),job=jobs.find(j=>j.id===asset?.referenceJobId);if(!asset||!character||deleted(source.trash,'canvas_node',character.id,pid)||asset.status!=='ready'||asset.nodeHash!==await nodeHash(character)||!imageOutput(job,asset.outputIndex))throw new APIError('请先确认当前人物定妆，再生成分镜。',409);snapshots.push({assetId:id,version:asset.version,jobId:job.id,url:imageOutput(job,asset.outputIndex)!.url});}
 if(node.mediaKind==='image'&&snapshots.length){if(!fields.has('imageUrls'))throw new APIError('此镜头需要支持人物参考图的模型。');parameters.imageUrls=snapshots.map(s=>s.url);}
 if(node.referenceNodeId||node.nodeKind==='shot'&&node.mediaKind==='video'){
  const image=doc.nodes.find((n:any)=>n.id===node.referenceNodeId&&n.mediaKind==='image');if(!image||deleted(source.trash,'canvas_node',image.id,pid))throw new APIError('参考图片节点不存在或已删除。',409);
  if(node.nodeKind==='shot'&&(image.shotId!==node.shotId||image.sourceVersion!==node.sourceVersion))throw new APIError('视频必须使用本镜头当前版本图片。');
  const hash=await nodeHash(image),job=jobs.filter(j=>j.canvasNodeId===image.id&&j.canvasNodeHash===hash&&imageOutput(j)).at(-1);if(!job)throw new APIError('请先生成本镜头当前版本的图片。',409);
  if(snapshots.length&&stable(job.characterReferenceSnapshot||[])!==stable(snapshots))throw new APIError('人物定妆已变更，请先更新分镜图片。',409);
  const field=['firstFrameUrl','imageUrl','imageUrls'].find(f=>fields.has(f));if(!field)throw new APIError('请选择支持首帧图片的视频模型。');parameters[field]=field==='imageUrls'?[imageOutput(job)!.url]:imageOutput(job)!.url;
 }
 return{provider:'runninghub',mode:'model_api',projectId:pid,modelId:node.modelId,mediaKind:node.mediaKind,name:node.title,quantity:1,parameters:normalizeParameters(model,parameters),canvasNodeId:node.id,canvasNodeHash:await nodeHash(node),characterReferenceSnapshot:snapshots,shotId:node.shotId,sourceArtifactId:node.sourceArtifactId,promptArtifactId:node.promptArtifactId};
}
function publicEstimate(value:any){return{...value,items:value.items.map((item:any)=>{const {request,nodeHash,...rest}=item;return rest;})};}
function publicBatch(value:any){const {requestHash,leaseAt,...publicValue}=value;return{...publicValue,items:(value.items||[]).map((item:any)=>{const {request,nodeHash,...rest}=item;return rest;})};}
async function estimate(ctx:Context,pid:string,data:any){
 const {doc}=await ensureCanvas(ctx,pid);revision(doc,data.expectedRevision);
 if(!Array.isArray(data.nodeIds)||data.nodeIds.length<1||data.nodeIds.length>24||new Set(data.nodeIds).size!==data.nodeIds.length)throw new APIError('请选择 1–24 个不同节点。');
 const items=[];for(const id of data.nodeIds){const node=doc.nodes.find((n:any)=>n.id===id);if(!node)throw new APIError('画布节点不存在。');const request:any=await nodeRequest(ctx,pid,doc,node);const quote:any=await quoteMedia(ctx,request);if(!quote.known||!Number.isFinite(Number(quote.estimatedCost)))throw new APIError('无法取得当前模型的正式报价。',409);items.push({nodeId:id,nodeHash:await nodeHash(node),estimatedCost:Number(quote.estimatedCost),currency:quote.currency,expiresAt:quote.expiresAt,request:{...request,budget:quote.budget??quote.estimatedCost,currency:quote.currency,estimateToken:quote.estimateToken}});}
 const currencies=new Set(items.map(i=>i.currency));if(currencies.size!==1)throw new APIError('本批报价币种不同，请分批生成。');
 const totalCost=items.reduce((sum,i)=>sum+i.estimatedCost,0),budget=data.budget==null?totalCost:Number(data.budget);if(!Number.isFinite(budget)||budget<0)throw new APIError('预算无效。');
 const id=uid(),value={id,projectId:pid,estimateToken:id,status:'quoted',nodeIds:data.nodeIds,items,totalCost,estimatedCost:totalCost,budget,currency:items[0].currency,withinBudget:totalCost<=budget,createdAt:now(),expiresAt:Math.min(now()+300000,...items.map(i=>typeof i.expiresAt==='number'?i.expiresAt:Date.parse(i.expiresAt)||now()+300000))};await ctx.store.create('estimate',value);return publicEstimate(value);
}
async function updateBatch(ctx:Context,id:string,change:(b:any)=>void){for(let retry=0;retry<3;retry++){const current=await ctx.store.require('batch',id);change(current);try{return await ctx.store.put('batch',current,current.revision);}catch(e:any){if(e.status!==409||retry===2)throw e;}}}
function batchStatus(batch:any){const states=batch.items.map((i:any)=>i.status);return states.includes('unknown')?'unknown':states.some((s:string)=>ACTIVE.has(s))?'running':states.every((s:string)=>s==='succeeded')?'succeeded':states.every((s:string)=>s==='cancelled')?'stopped':states.some((s:string)=>s==='succeeded')?'partial':'failed';}
async function releaseClaims(ctx:Context,batch:any){for(const item of batch.items)if(!ACTIVE.has(item.status)&&item.status!=='unknown'){const claimId='node-'+(await digest(batch.projectId+':'+item.nodeId)).slice(0,32),claim=await ctx.store.get('canvas_claim',claimId);if(claim?.batchId===batch.id)await ctx.store.remove('canvas_claim',claimId);}}
async function reconcileStoredBatches(ctx:Context,pid:string){
 const batches=(await ctx.store.list('batch')).filter(b=>b.projectId===pid);
 for(let index=0;index<batches.length;index++){const batch=batches[index];if(batch.leaseAt&&now()-batch.leaseAt<240000)continue;let changed=false;
  for(const item of batch.items){if(!item.jobId||!ACTIVE.has(item.status)&&item.status!=='unknown')continue;const job=await ctx.store.get('media',item.jobId);if(job&&job.projectId===pid&&job.status!==item.status){item.status=job.status;item.error=job.error||null;changed=true;}}
  if(changed){batch.status=batchStatus(batch);try{batches[index]=await ctx.store.put('batch',batch,batch.revision);await releaseClaims(ctx,batches[index]);}catch(e:any){if(e.status!==409)throw e;batches[index]=await ctx.store.require('batch',batch.id);}}
 }
 return batches;
}

export async function advanceCanvasBatch(ctx:Context,id:string){
 let batch=await ctx.store.require('batch',id);if(!ACTIVE.has(batch.status)||batch.leaseAt&&now()-batch.leaseAt<240000)return;
 try{batch=await ctx.store.put('batch',{...batch,leaseAt:now()},batch.revision);}catch(e:any){if(e.status===409)return;throw e;}
 try{
  await requireProject(ctx,batch.projectId);
  let pollCount=0;
  for(const item of batch.items){
   if(!ACTIVE.has(item.status))continue;
   let job=item.jobId?await ctx.store.get('media',item.jobId):await ctx.store.byRequest('media',item.request.requestId);
   if(!job&&item.status==='submitting'){item.status='unknown';item.error='受理状态未确认，已停止重复提交。';continue;}
   if(job){if(['queued','running','submitting'].includes(job.status)&&pollCount<2){job=await pollMedia(ctx,job);pollCount++;}item.jobId=job.id;item.status=job.status;item.error=job.error||null;}
  }
  const latest=await ctx.store.require('batch',id);if(latest.stopRequested){batch.stopRequested=true;for(const item of batch.items)if(item.status==='pending')item.status='cancelled';}
  if(batch.items.some((i:any)=>i.status==='unknown')){for(const i of batch.items)if(i.status==='pending'){i.status='cancelled';i.error='上游受理状态待核对，未继续提交。';}}
  const item=!batch.stopRequested?batch.items.find((i:any)=>i.status==='pending'):null;
  if(item){
   const {doc}=await ensureCanvas(ctx,batch.projectId),node=doc.nodes.find((n:any)=>n.id===item.nodeId);
   if(!node||await nodeHash(node)!==item.nodeHash){item.status='failed';item.error='画布已修改，请重新报价。';}
   else{
    const current=await nodeRequest(ctx,batch.projectId,doc,node);const original={...item.request};for(const key of ['budget','currency','estimateToken','requestId','confirmCost'])delete original[key];
    if(stable(current)!==stable(original)){item.status='failed';item.error='引用素材已变化，请重新报价。';}
    else{
     item.status='submitting';const claimed=await updateBatch(ctx,id,b=>{if(!b.stopRequested){b.items=batch.items;b.status='running';}});
     if(claimed.stopRequested)item.status='cancelled';else try{const job=await submitMedia(ctx,item.request);item.jobId=job.id;item.status=job.status;item.error=job.error||null;}catch(e:any){item.status=e instanceof APIError&&e.status<500?'failed':'unknown';item.error=cleanError(e);}
    }
   }
  }
  await updateBatch(ctx,id,b=>{b.items=batch.items;if(b.stopRequested)for(const i of b.items)if(i.status==='pending')i.status='cancelled';b.status=batchStatus(b);b.leaseAt=0;});
 }catch(error:any){await updateBatch(ctx,id,b=>{for(const item of b.items)if(item.status==='pending'){item.status='failed';item.error=cleanError(error);}b.status=batchStatus(b);b.leaseAt=0;});}
 finally{await releaseClaims(ctx,await ctx.store.require('batch',id));}
}
async function generate(ctx:Context,pid:string,data:any){
 requireId(data.requestId);requireId(data.estimateToken);if(data.confirmCost!==true)throw new APIError('请先确认本批报价。');
 const hash=await digest(stable({projectId:pid,...data})),previous=await ctx.store.byRequest('batch',data.requestId);if(previous){if(previous.projectId!==pid||previous.requestHash!==hash)throw new APIError('请求编号已用于其他批次。',409);return publicBatch(previous);}
 const quote=await ctx.store.require('estimate',data.estimateToken);if(quote.projectId!==pid||!quote.nodeIds)throw new APIError('报价不属于当前画布。',404);if(!quote.withinBudget||quote.expiresAt<=now())throw new APIError('报价已过期或超出预算，请重新报价。',409);
 const {doc}=await ensureCanvas(ctx,pid);for(const item of quote.items){const node=doc.nodes.find((n:any)=>n.id===item.nodeId);if(!node||await nodeHash(node)!==item.nodeHash)throw new APIError('画布已修改，请重新报价。',409);}
 const id='batch-'+(await digest(pid+':'+quote.id)).slice(0,32),batch={id,projectId:pid,requestId:data.requestId,requestHash:hash,estimateId:quote.id,status:'queued',createdAt:now(),stopRequested:false,items:quote.items.map((item:any,index:number)=>({...clone(item),status:'pending',jobId:null,request:{...item.request,confirmCost:true,requestId:'canvas-'+id+'-'+index}}))};
 if(!await ctx.store.create('batch',batch)){const replay=await ctx.store.byRequest('batch',data.requestId);if(replay?.requestHash===hash)return publicBatch(replay);throw new APIError('本批报价已经提交，请查看已有批次。',409);}
 const claimed=[];
 try{for(const item of batch.items){const claimId='node-'+(await digest(pid+':'+item.nodeId)).slice(0,32);if(!await ctx.store.create('canvas_claim',{id:claimId,projectId:pid,batchId:id,nodeId:item.nodeId}))throw new APIError('节点已有执行中或状态待核对任务，请查看已有结果。',409);claimed.push(claimId);}}
 catch(error){for(const claim of claimed)await ctx.store.remove('canvas_claim',claim);await updateBatch(ctx,id,b=>{b.status='failed';for(const i of b.items){i.status='failed';i.error=cleanError(error);}});throw error;}
 return publicBatch(await ctx.store.require('batch',id));
}
async function confirmAssets(ctx:Context,pid:string,data:any){
 const {doc,source}=await ensureCanvas(ctx,pid);revision(doc,data.expectedRevision);if(!Array.isArray(data.items)||!data.items.length||data.items.length>100)throw new APIError('请选择人物定妆。');
 for(const item of data.items){const asset=doc.characterAssets.find((a:any)=>a.id===item.assetId),node=doc.nodes.find((n:any)=>n.id===asset?.nodeId);if(!asset||!node||deleted(source.trash,'canvas_node',node.id,pid))throw new APIError('人物资产不存在。',404);if(!Number.isInteger(item.outputIndex)||item.outputIndex<0)throw new APIError('请选择有效的输出图片。');const job=await ctx.store.require('media',requireId(item.jobId)),output=imageOutput(job,item.outputIndex);if(job.projectId!==pid||job.canvasNodeId!==node.id||deleted(source.trash,'media',job.id,pid)||!output||job.canvasNodeHash!==await nodeHash(node))throw new APIError('请选择本人物当前版本生成成功的图片。',409);Object.assign(asset,{status:'ready',referenceUrl:output.url,referenceJobId:job.id,outputIndex:item.outputIndex,nodeHash:await nodeHash(node),confirmedAt:now(),version:(asset.version||0)+1});}
 await ctx.store.put('canvas',doc,doc.revision);return visible(ctx,pid);
}
export async function canvasRoute(ctx:Context,path:string,method:string,data:any):Promise<Response|null>{
 const match=path.match(/^\/api\/projects\/([-\w]+)\/(canvas|storyboard)(.*)$/);if(!match)return null;const pid=match[1],tail=match[3];await requireProject(ctx,pid);
 if(match[2]==='storyboard'&&method==='GET')return json((await visible(ctx,pid)).storyboard);
 if(match[2]!=='canvas')return null;
 if(!tail&&method==='GET')return json({canvas:await visible(ctx,pid)});
 if((!tail||tail==='/save')&&method==='POST')return json({canvas:await save(ctx,pid,data)});
 if(tail==='/estimate'&&method==='POST')return json({estimate:await estimate(ctx,pid,data)});
 if(tail==='/generate'&&method==='POST')return json({batch:await generate(ctx,pid,data)});
 if(tail==='/batches'&&method==='GET'){const batches=(await ctx.store.list('batch')).filter(b=>b.projectId===pid);const next=batches.find(b=>ACTIVE.has(b.status));if(next)await advanceCanvasBatch(ctx,next.id);return json({batches:(await ctx.store.list('batch')).filter(b=>b.projectId===pid).map(publicBatch)});}
 const stop=tail.match(/^\/batches\/([-\w]+)\/stop$/);if(stop&&method==='POST'){const batch=await ctx.store.require('batch',stop[1]);if(batch.projectId!==pid)throw new APIError('批次不属于此项目。',404);const result=await updateBatch(ctx,batch.id,b=>{b.stopRequested=true;for(const i of b.items)if(i.status==='pending')i.status='cancelled';b.status=batchStatus(b);});for(const item of result.items)if(item.status==='cancelled'){const claimId='node-'+(await digest(pid+':'+item.nodeId)).slice(0,32),claim=await ctx.store.get('canvas_claim',claimId);if(claim?.batchId===result.id)await ctx.store.remove('canvas_claim',claimId);}return json({batch:publicBatch(result)});}
 if(tail==='/assets'&&method==='POST'){const {doc}=await ensureCanvas(ctx,pid);revision(doc,data.expectedRevision);const name=text(data.name,120).trim(),prompt=text(data.prompt).trim();if(!name||!prompt)throw new APIError('请填写人物名称与定妆提示词。');const id='char-'+uid(),assetId='asset-'+uid();doc.nodes.push({id,nodeKind:'character',assetId,mediaKind:'image',title:name,prompt,modelId:IMAGE,parameters:modelDefaults(IMAGE),position:{x:doc.characterAssets.length*340,y:-460},selected:true,stylePreset:'original',promptField:'prompt',characterAssetIds:[]});doc.characterAssets.push({id:assetId,nodeId:id,name,prompt,description:text(data.description),status:'draft',sourceNature:'manual',version:1});await ctx.store.put('canvas',doc,doc.revision);return json({canvas:await visible(ctx,pid)});}
 const confirm=tail.match(/^\/assets\/([-\w]+)\/confirm$/);if(confirm&&method==='POST')return json({canvas:await confirmAssets(ctx,pid,{...data,items:[{assetId:confirm[1],jobId:data.jobId,outputIndex:data.outputIndex}]})});
 if(tail==='/assets/confirm-batch'&&method==='POST')return json({canvas:await confirmAssets(ctx,pid,data)});
 return null;
}
