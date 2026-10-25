import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=source=>'data:text/javascript;base64,'+Buffer.from(source+'\n//# sourceURL=cloud-canvas-test-module.mjs').toString('base64');
const compile=async file=>ts.transpileModule(await readFile(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const coreURL=url(await compile('cloud/core.ts'));
const mediaURL=url(`import {APIError,uid,now} from ${JSON.stringify(coreURL)};
export const stats={quoted:0,submitted:0,polled:0,unknown:false};
const common=[{name:'prompt'},{name:'width'},{name:'height'}];
export function getModel(id){return{id,mediaKind:id.includes('video')?'video':'image',defaults:{},fields:[...common,...(id.includes('image-to-image')?[{name:'imageUrls'}]:[]),...(id.includes('image-to-video')?[{name:'firstFrameUrl'}]:[])]};}
export function normalizeParameters(model,parameters){if(!parameters.prompt)throw new APIError('prompt required');return structuredClone(parameters);}
export async function quoteMedia(ctx,request){stats.quoted++;const id=uid();const quote={...request,id,known:true,estimatedCost:2,budget:2,currency:'CNY',estimateToken:id,expiresAt:now()+300000};await ctx.store.create('media_quote',quote);return quote;}
export async function submitMedia(ctx,request){const previous=await ctx.store.byRequest('media',request.requestId);if(previous)return previous;stats.submitted++;const job={...request,id:uid(),createdAt:now(),status:stats.unknown?'unknown':'queued',outputs:[]};await ctx.store.create('media',job);return job;}
export async function pollMedia(ctx,job){stats.polled++;if(job.status==='queued')job={...job,status:'succeeded',outputs:[{url:'https://example.test/'+job.id+(job.mediaKind==='video'?'.mp4':'.png'),outputType:job.mediaKind}]};return ctx.store.put('media',job,job.revision);}
`);
const canvasURL=url((await compile('cloud/canvas.ts')).replace(/from ['"]\.\/core['"]/g,'from '+JSON.stringify(coreURL)).replace(/from ['"]\.\/media['"]/g,'from '+JSON.stringify(mediaURL)));
const {RecordStore}=await import(coreURL),{canvasRoute,advanceCanvasBatch}=await import(canvasURL),{stats}=await import(mediaURL);
const migrations=await Promise.all((await readdir(path.join(root,'drizzle'))).filter(f=>f.endsWith('.sql')).sort().map(f=>readFile(path.join(root,'drizzle',f),'utf8')));
async function setup({completed=true}={}){
 Object.assign(stats,{quoted:0,submitted:0,polled:0,unknown:false});
 const db=new DatabaseSync(':memory:');for(const m of migrations)db.exec(m);
 const DB={prepare(sql){const stmt=db.prepare(sql);return{bind(...args){return{async first(){return stmt.get(...args)||null;},async all(){return{results:stmt.all(...args)};},async run(){return{meta:{changes:Number(stmt.run(...args).changes)}};}};}};}};
 const deferred=[],ctx={user:{id:'a'},settings:{},store:new RecordStore(DB,'a'),waitUntil:promise=>deferred.push(promise)};
 await ctx.store.create('workspace',{id:'current',state:{version:3,projects:[{id:'p',title:'project'}]}});
 await ctx.store.create('production',{id:'prod',projectId:'p',status:completed?'completed':'running',reviewMode:'stepwise',createdAt:1,stages:[{id:'visual',status:'completed',outputArtifactIds:['visual'],review:{action:'approve',reviewer:'user'}},{id:'storyboard',status:'completed',outputArtifactIds:['storyboard']}]});
 await ctx.store.create('artifact',{id:'visual',projectId:'p',productionId:'prod',stageId:'visual',createdAt:2,structured:{characters:[{id:'hero',name:'人物',description:'人物设定',imagePrompt:'角色立绘，服装清晰，柔和布光'}]}});
 await ctx.store.create('artifact',{id:'storyboard',projectId:'p',productionId:'prod',stageId:'storyboard',createdAt:3,structured:{shots:[{id:'S01',title:'镜头一',imagePrompt:'人物进入房间',videoPrompt:'人物缓缓转头',characterIds:['hero']},{id:'S02',title:'空镜',imagePrompt:'窗外风景',videoPrompt:'云影移动',characterIds:[]}]}});
 const call=async(tail='',method='GET',data={})=>{const response=await canvasRoute(ctx,'/api/projects/p/canvas'+tail,method,data);assert.ok(response);return response.json();};
 const settle=async()=>{while(deferred.length)await Promise.all(deferred.splice(0));};
 const close=async()=>{await settle();db.close();};
 return{ctx,DB,call,settle,close};
}
async function canvas(run){return(await run.call()).canvas;}
async function quote(run,ids){const doc=await canvas(run);return(await run.call('/estimate','POST',{nodeIds:ids,expectedRevision:doc.revision})).estimate;}
async function generate(run,q,requestId='request-'+crypto.randomUUID()){const result=await run.call('/generate','POST',{estimateToken:q.estimateToken,requestId,confirmCost:true});await run.call('/batches');await run.settle();return result.batch;}
async function finish(run,batch){await advanceCanvasBatch(run.ctx,batch.id);await run.settle();return run.ctx.store.get('batch',batch.id);}
async function readyCharacter(run){let doc=await canvas(run);const node=doc.nodes.find(n=>n.nodeKind==='character');const batch=await generate(run,await quote(run,[node.id]));await finish(run,batch);doc=await canvas(run);const asset=doc.characterAssets[0];assert.equal(asset.status,'pending_review');const output=await run.call('/assets/'+asset.id+'/confirm','POST',{expectedRevision:doc.revision,jobId:asset.reviewCandidate.jobId,outputIndex:0});assert.equal(output.canvas.characterAssets[0].status,'ready');return output.canvas;}

test('GET imports characters and every confirmed image/video card without generating',async()=>{const run=await setup();try{const doc=await canvas(run);assert.equal(doc.nodes.length,5);assert.equal(doc.nodes.filter(n=>n.mediaKind==='video').length,2);assert.equal(doc.nodes.find(n=>n.shotId==='S01'&&n.mediaKind==='image').modelId,'seedream-v5-pro/image-to-image');assert.ok(doc.nodes.find(n=>n.mediaKind==='video').referenceNodeId);assert.equal(stats.submitted,0);assert.equal(stats.quoted,0);assert.equal((await canvas(run)).nodes.length,5);}finally{await run.close();}});
test('unapproved production imports no shot cards',async()=>{const run=await setup({completed:false});try{const doc=await canvas(run);assert.equal(doc.nodes.length,1);assert.equal(doc.storyboard.confirmed,false);assert.equal(stats.submitted,0);}finally{await run.close();}});
test('character to image to video uses confirmed images and real job outputs',async()=>{const run=await setup();try{
 let doc=await canvas(run);const image=doc.nodes.find(n=>n.shotId==='S01'&&n.mediaKind==='image'),video=doc.nodes.find(n=>n.shotId==='S01'&&n.mediaKind==='video');
 await assert.rejects(quote(run,[image.id]),{status:409});doc=await readyCharacter(run);await assert.rejects(quote(run,[video.id]),{status:409});
 const imageBatch=await generate(run,await quote(run,[image.id]));await finish(run,imageBatch);const imageJob=(await run.ctx.store.list('media')).find(j=>j.canvasNodeId===image.id);assert.ok(imageJob.parameters.imageUrls[0].endsWith('.png'));
 const videoQuote=await quote(run,[video.id]),internal=await run.ctx.store.get('estimate',videoQuote.id);assert.equal(internal.items[0].request.parameters.firstFrameUrl,imageJob.outputs[0].url);
 const videoBatch=await generate(run,videoQuote);await finish(run,videoBatch);const videoJob=(await run.ctx.store.list('media')).find(j=>j.canvasNodeId===video.id);assert.equal(videoJob.status,'succeeded');assert.ok(videoJob.outputs[0].url.endsWith('.mp4'));assert.equal(stats.submitted,3);
 }finally{await run.close();}});
test('quote requires current revision, then edits invalidate paid submission',async()=>{const run=await setup();try{const doc=await canvas(run),node=doc.nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image');await assert.rejects(run.call('/estimate','POST',{nodeIds:[node.id],expectedRevision:doc.revision-1}),{status:409});const q=await quote(run,[node.id]);node.prompt='新的提示词';await run.call('','POST',{nodes:doc.nodes,viewport:doc.viewport,expectedRevision:doc.revision});await assert.rejects(generate(run,q),{status:409});assert.equal(stats.submitted,0);}finally{await run.close();}});
test('same request replays one batch and cannot submit the same quote twice',async()=>{const run=await setup();try{const node=(await canvas(run)).nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image'),q=await quote(run,[node.id]);const payload={estimateToken:q.estimateToken,requestId:'same-request',confirmCost:true};const [a,b]=await Promise.all([run.call('/generate','POST',payload),run.call('/generate','POST',payload)]);await run.call('/batches');await run.settle();assert.equal(a.batch.id,b.batch.id);assert.equal(stats.submitted,1);await assert.rejects(run.call('/generate','POST',{...payload,requestId:'different-request'}),{status:409});assert.equal(stats.submitted,1);}finally{await run.close();}});
test('separate quotes cannot concurrently generate the same node',async()=>{const run=await setup();try{const node=(await canvas(run)).nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image'),q1=await quote(run,[node.id]),q2=await quote(run,[node.id]);await generate(run,q1);await assert.rejects(generate(run,q2),{status:409});assert.equal(stats.submitted,1);}finally{await run.close();}});
test('unknown submission is retained and cannot be retried by another quote',async()=>{const run=await setup();try{stats.unknown=true;const node=(await canvas(run)).nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image');const batch=await generate(run,await quote(run,[node.id]));assert.equal((await run.ctx.store.get('batch',batch.id)).status,'unknown');await finish(run,batch);assert.equal(stats.submitted,1);await assert.rejects(generate(run,await quote(run,[node.id])),{status:409});assert.equal(stats.submitted,1);}finally{await run.close();}});
test('cross-account canvas and output confirmation are denied',async()=>{const run=await setup();try{const foreign={...run.ctx,store:new RecordStore(run.DB,'b')};await assert.rejects(canvasRoute(foreign,'/api/projects/p/canvas','GET',{}),{status:404});let doc=await canvas(run);await run.ctx.store.create('media',{id:'other-job',projectId:'elsewhere',canvasNodeId:doc.nodes[0].id,status:'succeeded',mediaKind:'image',outputs:[{url:'https://example.test/x.png'}]});await assert.rejects(run.call('/assets/'+doc.characterAssets[0].id+'/confirm','POST',{expectedRevision:doc.revision,jobId:'other-job',outputIndex:0}),{status:409});}finally{await run.close();}});
test('generate returns queued without background work; a batches request advances it',async()=>{const run=await setup();try{const node=(await canvas(run)).nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image');const q=await quote(run,[node.id]);const result=await run.call('/generate','POST',{estimateToken:q.estimateToken,requestId:'poll-owned',confirmCost:true});assert.equal(result.batch.status,'queued');assert.equal(stats.submitted,0);const progress=await run.call('/batches');assert.equal(stats.submitted,1);assert.equal(progress.batches[0].items[0].status,'queued');}finally{await run.close();}});
test('only active stage artifacts are imported, never an unselected older revision',async()=>{const run=await setup();try{await run.ctx.store.create('artifact',{id:'unselected',projectId:'p',productionId:'prod',stageId:'storyboard',createdAt:999,structured:{shots:[{id:'WRONG',imagePrompt:'must not import'}]}});const doc=await canvas(run);assert.ok(doc.nodes.some(n=>n.shotId==='S01'));assert.ok(!doc.nodes.some(n=>n.shotId==='WRONG'));}finally{await run.close();}});
test('frontend prepareNode sends merged drafts and preset style through the actual canvas API',async()=>{const run=await setup();try{
 const sandbox=vm.createContext({URL,structuredClone});sandbox.window=sandbox;
 for(const file of ['canvas-controls.js','character-profile.js','runtime.js','canvas.js'])vm.runInContext(await readFile(path.join(root,'public/lib',file),'utf8'),sandbox);
 const doc=await canvas(run),node=doc.nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image');node.prompt='清晨的窗边';node.parameters={width:1024};node.parameterDraft={width:'2048',prompt:'obsolete field'};node.stylePreset='cinematic';
 const model={id:node.modelId,mediaKind:'image',fields:[{name:'prompt',type:'string',required:true},{name:'width',type:'integer'}]};
 node.parameters=structuredClone(sandbox.StudioCanvas.prepareNode(node,model,doc,[],sandbox.StudioRuntime));
 assert.equal(node.parameters.width,2048);assert.match(node.parameters.prompt,/清晨的窗边/);assert.match(node.parameters.prompt,/电影写实摄影/);assert.doesNotMatch(node.parameters.prompt,/obsolete/);
 await run.call('','POST',{nodes:doc.nodes,viewport:doc.viewport,expectedRevision:doc.revision});const q=await quote(run,[node.id]),saved=await run.ctx.store.get('estimate',q.id);assert.deepEqual(saved.items[0].request.parameters,node.parameters);
 }finally{await run.close();}});
test('real frontend fee rendering accepts the batch estimate contract and disables over-budget submission',async()=>{const run=await setup();try{
 const doc=await canvas(run),ids=[doc.nodes.find(n=>n.nodeKind==='character').id,doc.nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image').id];const q=await quote(run,ids);
 const source=await readFile(path.join(root,'public/lib/canvas.js'),'utf8'),start=source.indexOf('    function renderBatch(entry){'),end=source.indexOf('    function characterCandidates',start);const renderer=source.slice(start,end);
 const sandbox=vm.createContext({selected:entry=>entry.doc.nodes.filter(n=>ids.includes(n.id)),provider:()=>({modelConnection:{keyConfigured:true}}),esc:value=>String(value??''),node:(entry,id)=>entry.doc.nodes.find(n=>n.id===id)});vm.runInContext(renderer,sandbox);
 const footer={innerHTML:''},entry={doc,quote:q,mode:'canvas',ui:{},busy:'',host:{querySelector:()=>footer}};sandbox.renderBatch(entry);
 assert.match(footer.innerHTML,/4 CNY/);assert.match(footer.innerHTML,/2 个任务/);assert.match(footer.innerHTML,/确认预计 4 CNY，开始生成/);assert.match(footer.innerHTML,/人物/);assert.doesNotMatch(footer.innerHTML,/undefined|NaN/);
 entry.quote={...q,withinBudget:false};sandbox.renderBatch(entry);assert.match(footer.innerHTML,/预计费用超过所填预算/);assert.doesNotMatch(footer.innerHTML,/data-canvas-action="generate"/);
 }finally{await run.close();}});
test('real media and canvas implementations preserve official quote binding through create and query',async()=>{
 const catalog=JSON.parse(await readFile(path.join(root,'cloud/models.json'),'utf8'));
 const authStub=url('export async function persistSettings(){throw new Error("unexpected settings mutation");}');
 const actualMediaURL=url((await compile('cloud/media.ts')).replace(/import catalog from ['"]\.\/models\.json['"];?/, 'const catalog='+JSON.stringify(catalog)+';').replace(/from ['"]\.\/core['"]/g,'from '+JSON.stringify(coreURL)).replace(/from ['"]\.\/auth['"]/g,'from '+JSON.stringify(authStub)));
 const actualCanvasURL=url((await compile('cloud/canvas.ts')).replace(/from ['"]\.\/core['"]/g,'from '+JSON.stringify(coreURL)).replace(/from ['"]\.\/media['"]/g,'from '+JSON.stringify(actualMediaURL)));
 const actual=await import(actualCanvasURL),run=await setup(),calls=[],originalFetch=globalThis.fetch;run.ctx.settings.runninghubModelApiKey='mock-key-not-a-real-secret';
 const model=catalog.find(m=>m.id==='seedream-v5-pro/text-to-image');
 globalThis.fetch=async(address,options)=>{const endpoint=new URL(address).pathname,body=JSON.parse(options.body);calls.push({endpoint,body});let response;if(endpoint===model.priceEndpoint)response={estimatedPrice:2,currency:'CNY',isFreeThisCall:false};else if(endpoint===model.endpoint)response={taskId:'mock-provider-task',status:'RUNNING',results:[]};else if(endpoint==='/openapi/v2/query')response={taskId:'mock-provider-task',status:'SUCCESS',results:[{url:'https://example.test/real-contract.png',outputType:'image'}]};else throw new Error('unmocked provider endpoint');return Response.json(response);};
 const call=async(tail='',method='GET',data={})=>(await actual.canvasRoute(run.ctx,'/api/projects/p/canvas'+tail,method,data)).json();
 try{
  let doc=(await call()).canvas;const node=doc.nodes.find(n=>n.nodeKind==='character');assert.equal(node.parameters.width,2048);assert.equal(node.parameters.outputFormat,'png');
  const q=(await call('/estimate','POST',{nodeIds:[node.id],expectedRevision:doc.revision})).estimate;
  const created=await call('/generate','POST',{estimateToken:q.estimateToken,requestId:'actual-binding-request',confirmCost:true});assert.equal(created.batch.status,'queued');assert.equal(calls.length,1);
  await call('/batches');await call('/batches');doc=(await call()).canvas;assert.equal(doc.characterAssets[0].status,'pending_review');
  const adopted=await call('/assets/'+doc.characterAssets[0].id+'/confirm','POST',{expectedRevision:doc.revision,jobId:doc.characterAssets[0].reviewCandidate.jobId,outputIndex:0});assert.equal(adopted.canvas.characterAssets[0].referenceUrl,'https://example.test/real-contract.png');
  assert.deepEqual(calls.map(c=>c.endpoint),[model.priceEndpoint,model.endpoint,'/openapi/v2/query']);assert.equal(calls[1].body.prompt,'角色立绘，服装清晰，柔和布光');assert.equal(calls[1].body.width,2048);
 }finally{globalThis.fetch=originalFetch;await run.close();}
});
test('stopping an unsubmitted batch releases its node without any paid calls',async()=>{const run=await setup();try{const node=(await canvas(run)).nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image'),q=await quote(run,[node.id]);const {batch}=await run.call('/generate','POST',{estimateToken:q.estimateToken,requestId:'stop-before-submit',confirmCost:true});const stopped=await run.call('/batches/'+batch.id+'/stop','POST',{});assert.equal(stopped.batch.status,'stopped');assert.equal((await run.ctx.store.list('canvas_claim')).length,0);await run.call('/batches');assert.equal(stats.submitted,0);await generate(run,await quote(run,[node.id]));assert.equal(stats.submitted,1);}finally{await run.close();}});
test('a later verified result reconciles unknown batch without resubmitting',async()=>{const run=await setup();try{stats.unknown=true;const node=(await canvas(run)).nodes.find(n=>n.shotId==='S02'&&n.mediaKind==='image');const batch=await generate(run,await quote(run,[node.id]));const job=(await run.ctx.store.list('media'))[0];await run.ctx.store.put('media',{...job,status:'succeeded',outputs:[{url:'https://example.test/verified.png',outputType:'image'}]},job.revision);const doc=await canvas(run);assert.equal(doc.batches.find(b=>b.id===batch.id).status,'succeeded');assert.equal((await run.ctx.store.list('canvas_claim')).length,0);assert.equal(stats.submitted,1);}finally{await run.close();}});
