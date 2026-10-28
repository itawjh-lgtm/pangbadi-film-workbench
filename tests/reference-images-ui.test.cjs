'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Canvas=require('../lib/canvas.js'),Runtime=require('../lib/runtime.js');
const fields=[{name:'prompt',type:'string',required:true},{name:'width',type:'integer',minimum:240,maximum:8192},{name:'height',type:'integer',minimum:240,maximum:8192},{name:'resolution',type:'string',options:['1k','2k','4k']},{name:'quality',type:'string',options:['low','medium','high']},{name:'seed',type:'integer'}];
const text={id:'seedream-v5-pro/text-to-image',mediaKind:'image',available:true,defaults:{resolution:'2k',quality:'medium',width:2048,height:2048},fields};
const edit={...text,id:'seedream-v5-pro/image-to-image',fields:[...fields,{name:'imageUrls',type:'array',required:true,minItems:1,maxItems:10,items:{type:'string',format:'https'}}]};
const reference=(id='ref-a')=>({id,name:'造型参考.png',purpose:'appearance',note:'保留发型，修改背景'});
const node=(patch={})=>({id:'node-a',mediaKind:'image',nodeKind:'character',modelId:text.id,prompt:'人物定妆',parameters:{width:576,height:1024,quality:'low',seed:0},parameterDraft:{},referenceImages:[reference()],...patch});

test('references choose the available sibling image route and preserve low-cost framing and zero-valued inputs',()=>{
 const item=node(),originalRefs=structuredClone(item.referenceImages);
 assert.equal(Canvas.applyReferenceModel(item,[text,edit],Runtime),true);
 assert.equal(item.modelId,edit.id);assert.equal(item.modelSelectionOrigin,'user');
 assert.deepEqual([item.parameters.width,item.parameters.height,item.parameters.quality,item.parameters.seed],[576,1024,'low',0]);
 assert.equal(Object.hasOwn(item.parameters,'resolution'),false);
 assert.deepEqual(item.referenceImages,originalRefs);assert.equal(item.prompt,'人物定妆');
 assert.equal(Canvas.applyReferenceModel(item,[text,edit],Runtime),false);
});
test('automatic pairing never substitutes an unrelated or unavailable provider operation',()=>{
 const item=node(),before=structuredClone(item),other={...edit,id:'other/image-to-image'};
 assert.throws(()=>Canvas.applyReferenceModel(item,[text,{...edit,available:false},other],Runtime),/同系列/);
 assert.deepEqual(item,before);
 assert.throws(()=>Canvas.referenceModelFor({...item,mediaKind:'video'},[text,edit],Runtime),/仅用于图片/);
 const n={...text,id:'rhart-image-n-pro-official/text-to-image'},nedit={...edit,id:'rhart-image-n-pro-official/edit'};
 assert.equal(Canvas.referenceModelFor(node({modelId:n.id}),[n,nedit],Runtime),nedit);
});
test('local images satisfy required reference validation without persisting placeholder addresses or changing user prompt',()=>{
 const item=node({modelId:edit.id}),before=structuredClone(item),doc={nodes:[item],projectId:'p'};
 const result=Canvas.prepareNode(item,edit,doc,[],Runtime);
 assert.equal(result.prompt,'人物定妆');assert.equal(Object.hasOwn(result,'imageUrls'),false);
 assert.equal(JSON.stringify(result).includes('reference.invalid'),false);
 assert.deepEqual(item,before);
});
test('adopted character images remain present alongside locally uploaded references',()=>{
 const item=node({nodeKind:'shot',modelId:edit.id,characterAssetIds:['person']}),doc={projectId:'p',nodes:[item],characterAssets:[{id:'person',status:'ready',referenceUrl:'https://example.com/adopted.png'}]};
 const result=Canvas.prepareNode(item,edit,doc,[],Runtime);
 assert.deepEqual(result.imageUrls,['https://example.com/adopted.png']);
 assert.equal(JSON.stringify(result).includes('reference.invalid'),false);
 const limit={...edit,fields:[...fields,{...edit.fields.at(-1),maxItems:1}]};
 assert.throws(()=>Canvas.prepareNode(item,limit,doc,[],Runtime),/数量/);
});
test('reference validation respects combined model capacity and rejects malformed local ids',()=>{
 const item=node({modelId:edit.id,referenceImages:Array.from({length:11},(_,i)=>reference('ref-'+i))});
 assert.throws(()=>Canvas.prepareNode(item,edit,{nodes:[item]},[],Runtime),/最多/);
 assert.throws(()=>Canvas.prepareNode(node({modelId:edit.id,referenceImages:[reference('../other')]}),edit,{nodes:[]},[],Runtime),/无效/);
 assert.throws(()=>Canvas.prepareNode(node(),text,{nodes:[]},[],Runtime),/不支持参考图/);
});
test('removing the final uploaded reference restores matching text generation without dropping low resolution',()=>{
 const item=node();Canvas.applyReferenceModel(item,[text,edit],Runtime);item.referenceImages=[];
 assert.equal(Canvas.restoreTextModel(item,[text,edit],Runtime),true);assert.equal(item.modelId,text.id);
 const result=Canvas.prepareNode(item,text,{nodes:[item]},[],Runtime);assert.deepEqual([result.width,result.height],[576,1024]);
 const emptyJson=node({modelId:edit.id,referenceImages:[],parameterDraft:{imageUrls:'[]'}});assert.equal(Canvas.restoreTextModel(emptyJson,[text,edit],Runtime),true);
 const withCharacter=node({modelId:edit.id,referenceImages:[],characterAssetIds:['p']});assert.equal(Canvas.restoreTextModel(withCharacter,[text,edit],Runtime),false);
 const explicit=node({modelId:edit.id,referenceImages:[],parameters:{imageUrls:['https://example.com/a.png']}});assert.equal(Canvas.restoreTextModel(explicit,[text,edit],Runtime),false);
});
test('local-reference edits survive concurrent server refresh only for the page-owned node',()=>{
 const baseline=[node(),node({id:'other',referenceImages:[]})],local=structuredClone(baseline),incoming=structuredClone(baseline);
 local[0].referenceImages[0].note='新说明';incoming[1].referenceImages=[reference('ref-other')];incoming[0].status='running';
 const merged=Canvas.mergeLocalNodes(local,incoming,baseline,['node-a']);
 assert.equal(merged[0].referenceImages[0].note,'新说明');assert.equal(merged[0].status,'running');assert.equal(merged[1].referenceImages[0].id,'ref-other');
});
test('a repeated local upload preserves the existing reference metadata instead of adding a duplicate id',()=>{
 const item=node(),before=structuredClone(item.referenceImages),original=item.referenceImages[0];
 assert.equal(Canvas.appendUploadedReference(item,{id:original.id,name:'重复上传新名字.png',previewUrl:'/api/projects/p/reference-images/ref-a'}),false);
 assert.deepEqual(item.referenceImages,before);assert.equal(item.referenceImages[0],original);
 assert.equal(Canvas.appendUploadedReference(item,{id:'ref-b',name:'新参考.png',previewUrl:'/api/projects/p/reference-images/ref-b'}),true);
 assert.deepEqual(item.referenceImages,[...before,{id:'ref-b',name:'新参考.png',purpose:'general',note:''}]);
 assert.equal(Canvas.appendUploadedReference(item,{id:'ref-b',name:'新参考.png'}),false);assert.equal(item.referenceImages.length,2);
});
test('reference purpose choices cover the backend allowlist without duplicate values',()=>{
 assert.deepEqual(Canvas.referencePurposes.map(([value])=>value),['general','appearance','clothing','composition','style']);
 assert.ok(Canvas.referencePurposes.every(([,label])=>typeof label==='string'&&label.length>0));
});
test('reference preview uses a scoped same-origin route and rejects path traversal ids',()=>{
 assert.equal(Canvas.referencePreviewURL('p one','ref-a'),'/api/projects/p%20one/reference-images/ref-a');
 assert.equal(Canvas.referencePreviewURL('p','../ref-a'),'');assert.equal(Canvas.referencePreviewURL('p','a?x=1'),'');
});
class Reader {readAsDataURL(file){this.result='data:'+file.type+';base64,aGVsbG8=';this.onload();}}
const png={name:'参考.png',type:'image/png',size:5};
test('image reading rejects unsupported types and large files before accessing their contents',async()=>{
 let reads=0;class FailReader {constructor(){reads++;}}
 await assert.rejects(Runtime.referenceFileData({...png,type:'image/svg+xml'},FailReader),/只支持/);
 await assert.rejects(Runtime.referenceFileData({...png,size:Runtime.MAX_REFERENCE_BYTES+1},FailReader),/10 MB/);
 await assert.rejects(Runtime.referenceFileData({...png,size:0},FailReader),/0 字节/);assert.equal(reads,0);
 assert.deepEqual(await Runtime.referenceFileData(png,Reader),{name:png.name,contentBase64:'aGVsbG8='});
});
test('upload sends only to the project local endpoint with CSRF and never triggers estimate or generation',async()=>{
 const requests=[],old=global.FileReader;global.FileReader=Reader;
 const runtime=Runtime.create({fetch:async(url,options)=>{
  requests.push({url,options});const data=url==='/api/health'?{ok:true,service:'dream-studio-runtime',csrfToken:'test-local-token',provider:{available:true,authenticated:true}}:url.includes('/reference-images')?{reference:{id:'ref-new',name:png.name,previewUrl:'/api/projects/p/reference-images/ref-new'}}:{};
  return {ok:true,json:async()=>data};
 }});
 try{
  assert.equal(await runtime.connect(),true);requests.length=0;
  const ref=await runtime.uploadReferenceImage('project-a','node-a',png);
  assert.equal(ref.id,'ref-new');assert.equal(requests.length,1);
  assert.equal(requests[0].url,'/api/projects/project-a/reference-images');
  assert.equal(requests[0].options.headers['X-Studio-Token'],'test-local-token');
  assert.deepEqual(JSON.parse(requests[0].options.body),{nodeId:'node-a',name:png.name,contentBase64:'aGVsbG8='});
 }finally{runtime.dispose();if(old===undefined)delete global.FileReader;else global.FileReader=old;}
});
