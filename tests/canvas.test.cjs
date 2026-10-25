'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const Canvas=require('../lib/canvas.js'),Runtime=require('../lib/runtime.js'),Store=require('../lib/store.js');
const model={id:'image/model',mediaKind:'image',available:true,defaults:{seed:0,generateAudio:false},fields:[{name:'prompt',type:'string',required:true},{name:'seed',type:'integer',default:0},{name:'generateAudio',type:'boolean',default:false},{name:'images',type:'array',items:{type:'string',format:'https'}}]};
const draft=()=>({id:'one',mediaKind:'image',title:'镜头一',modelId:model.id,prompt:'红色小船在海面上',stylePreset:'cute3d',parameters:{},parameterDraft:{seed:'0',generateAudio:'false',images:'["https://example.com/ref.png"]'}});
test('canvas prompt styling produces a new submitted prompt while preserving the source draft',()=>{
 const node=draft(),source=JSON.stringify(node);const result=Canvas.prepareNode(node,model,{projectId:'a',nodes:[node]},[],Runtime);
 assert.ok(result.prompt.startsWith(node.prompt));assert.ok(result.prompt.includes('可爱的3D动画'));assert.equal(result.seed,0);assert.equal(result.generateAudio,false);assert.deepEqual(result.images,['https://example.com/ref.png']);assert.equal(JSON.stringify(node),source);
 assert.equal(Canvas.combinedPrompt({...node,stylePreset:'original'}),node.prompt);
});
test('node aliases require an explicit prompt binding instead of guessing a provider field',()=>{
 const aliasModel={id:'alias',mediaKind:'image',fields:[{name:'131##text',label:'提示词节点',type:'string',required:true}]};
 const node={...draft(),modelId:'alias',parameterDraft:{}};
 assert.throws(()=>Canvas.prepareNode(node,aliasModel,{nodes:[node]},[],Runtime),/提示词节点/);
 const result=Canvas.prepareNode({...node,promptField:'131##text'},aliasModel,{nodes:[node]},[],Runtime);assert.ok(result['131##text'].includes('红色小船'));assert.ok(!Object.hasOwn(result,'prompt'));
});
test('reference images must be successful outputs of the same project and linked node',()=>{
 const image={id:'image-one',mediaKind:'image',jobIds:['job-a']},video={id:'video-one',mediaKind:'video',prompt:'镜头缓缓推进',referenceNodeId:image.id,parameterDraft:{}},doc={projectId:'project-a',nodes:[image,video]},videoModel={fields:[{name:'prompt',type:'string'},{name:'firstFrameUrl',type:'string',format:'https',required:true}]};
 const wrong={id:'job-a',projectId:'other-project',status:'succeeded',outputs:[{url:'https://example.com/wrong.png',outputType:'png'}]};
 assert.throws(()=>Canvas.prepareNode(video,videoModel,doc,[wrong],Runtime),/参考图片尚未生成/);
 const failed={...wrong,projectId:'project-a',status:'failed'};assert.throws(()=>Canvas.prepareNode(video,videoModel,doc,[failed],Runtime),/参考图片尚未生成/);
 const correct={...failed,status:'succeeded',outputs:[{url:'https://example.com/result.png',outputType:'image'}]};
 assert.equal(Canvas.prepareNode(video,videoModel,doc,[wrong,correct],Runtime).firstFrameUrl,'https://example.com/result.png');
 assert.equal(Canvas.referenceImage(video,doc,[{...correct,outputs:[{url:'javascript:alert(1)',outputType:'image'}]}]),'');
});
test('fit view safely covers negative positions and clamps the zoom for large storyboards',()=>{
 const nodes=[{position:{x:-300,y:-100}},{position:{x:1800,y:800}}],view=Canvas.fitViewport(nodes,1000,700);
 assert.ok(view.scale>=.18&&view.scale<=1);for(const node of nodes){assert.ok(node.position.x*view.scale+view.x>=0);assert.ok(node.position.y*view.scale+view.y>=0);}
 assert.deepEqual(Canvas.fitViewport([],1000,700),{x:50,y:50,scale:1});
});
test('canvas tab is a persisted project UI choice, without changing production status',async()=>{
 const win={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../data/employees.js'),'utf8'),{window:win});
 let saved;const storage={getItem:()=>saved||null,setItem:(key,value)=>{saved=value;}};
 const store=Store.create(win.TEAM_EMPLOYEES,{storage,host:null}),prior=JSON.stringify(store.getState().tasks);assert.equal(store.dispatch({type:'SET_UI',projectTab:'canvas'}).ok,true);assert.equal(store.getState().projectTab,'canvas');assert.equal(JSON.stringify(store.getState().tasks),prior);await new Promise(resolve=>setImmediate(resolve));assert.equal(Store.create(win.TEAM_EMPLOYEES,{storage,host:null}).getState().projectTab,'canvas');
});
test('canvas models retain schema validation and never submit unavailable or malformed nodes',()=>{
 assert.throws(()=>Canvas.prepareNode(draft(),{...model,available:false,disabledReason:'已下架'},{nodes:[]},[],Runtime),/已下架/);
 assert.throws(()=>Canvas.prepareNode({...draft(),parameterDraft:{images:'not JSON'}},model,{nodes:[]},[],Runtime),/JSON/);
 assert.equal(Canvas.activeBatch({status:'running'}),true);assert.equal(Canvas.activeBatch({status:'needs_attention'}),false);
});

test('an empty parameter draft preserves source aspect ratio and supported model switches carry it',()=>{
 const wide={...model,defaults:{...model.defaults,aspectRatio:'16:9'},fields:[...model.fields,{name:'aspectRatio',type:'string',options:['16:9','9:16']}]},node={...draft(),parameters:{aspectRatio:'9:16'},parameterDraft:{}};
 assert.equal(Canvas.prepareNode(node,wide,{nodes:[node]},[],Runtime).aspectRatio,'9:16');
 assert.deepEqual(Canvas.carryRatio(node,{ratio:'16:9'},{fields:[{name:'ratio',options:['16:9','9:16']}]}),{ratio:'9:16'});
 assert.deepEqual(Canvas.carryRatio(node,{ratio:'adaptive'},{fields:[{name:'ratio',options:['adaptive']}]}),{ratio:'adaptive'});
});
test('legacy job mapping requires matching project, shot, source, prompt version and media kind',()=>{
 const node={id:'n1',shotId:'S01',sourceArtifactId:'source',promptArtifactId:'prompt',mediaKind:'video'},job={id:'j1',projectId:'a',shotId:'S01',sourceArtifactId:'source',promptArtifactId:'prompt',mediaKind:'video'};
 assert.equal(Canvas.matchesNodeJob(node,job,'a'),true);
 for(const change of [{projectId:'b'},{shotId:'S02'},{sourceArtifactId:'old'},{promptArtifactId:'old'},{mediaKind:'image'}])assert.equal(Canvas.matchesNodeJob(node,{...job,...change},'a'),false);
});
test('quote snapshots freeze selected nodes and budget before asynchronous saving',async()=>{
 const entry={version:1,ui:{budget:'10'},doc:{nodes:[{id:'A',selected:true},{id:'B',selected:false}]}};const captured=Canvas.quoteSnapshot(entry);
 let release;const saving=new Promise(resolve=>{release=resolve;});let called=false;
 const estimate=(async()=>{await saving;if(Canvas.quoteSnapshotCurrent(entry,captured))called=true;})();
 entry.version++;entry.ui.budget='1';entry.doc.nodes[0].selected=false;entry.doc.nodes[1].selected=true;release();await estimate;
 assert.equal(called,false);assert.deepEqual(captured,{version:1,nodeIds:['A'],budget:10});
 const stable=Canvas.quoteSnapshot(entry);assert.equal(Canvas.quoteSnapshotCurrent(entry,stable),true);entry.ui.budget='0.5';assert.equal(Canvas.quoteSnapshotCurrent(entry,stable),false);
});
test('canvas trash hides nodes without mutating their contents or erasing dependent references',()=>{
 const image={id:'image-one',mediaKind:'image',prompt:'保留原稿',position:{x:4,y:8}},video={id:'video-one',mediaKind:'video',referenceNodeId:'image-one'},nodes=[image,video],snapshot=JSON.stringify(nodes);
 const runtime={isDeleted:(kind,id,project)=>kind==='canvas_node'&&id==='image-one'&&project==='project-a'};
 assert.deepEqual(Canvas.visibleCanvasNodes(nodes,runtime,'project-a'),[video]);
 assert.deepEqual(Canvas.visibleCanvasNodes(nodes,runtime,'project-b'),nodes);
 assert.equal(JSON.stringify(nodes),snapshot);
 assert.equal(video.referenceNodeId,'image-one');
 assert.deepEqual(Canvas.visibleCanvasNodes(nodes,{isDeleted:()=>false},'project-a'),nodes);
});
test('batch deletion targets only selected existing nodes in this canvas and does not include media jobs',()=>{
 const doc={projectId:'project-a',nodes:[{id:'one',jobIds:['paid-job'],selected:true},{id:'two',selected:false}]};
 assert.deepEqual(Canvas.trashTargets(doc,['one','one','missing']),[{kind:'canvas_node',targetId:'one',projectId:'project-a'}]);
 assert.deepEqual(Canvas.trashTargets(doc,[]),[]);
 assert.equal(doc.nodes.length,2);
});
test('hierarchical shot ids remain independent image/video scene groups, preserving source versions',()=>{
 const nodes=[{id:'a',shotId:'S01-001',sourceArtifactId:'r4',sourceVersion:'one',mediaKind:'image',title:'S01-001 · 报名表 · 图片'},
  {id:'b',shotId:'S01-001',sourceArtifactId:'r4',sourceVersion:'one',mediaKind:'video'},
  {id:'c',shotId:'S01-002',sourceArtifactId:'r4',sourceVersion:'one',mediaKind:'image'},
  {id:'d',shotId:'S01-001',sourceArtifactId:'r4',sourceVersion:'two',mediaKind:'image'},
  {id:'free',mediaKind:'image'}],before=JSON.stringify(nodes),groups=Canvas.sceneGroups(nodes);
 assert.equal(groups.length,3);assert.deepEqual(groups[0].nodes.map(n=>n.id),['a','b']);assert.equal(groups[0].title,'S01-001 · 报名表');assert.equal(groups[1].shotId,'S01-002');assert.equal(JSON.stringify(nodes),before);
});
test('an omitted spending limit stays optional in the quote snapshot instead of becoming zero',()=>{
 const entry={version:1,ui:{budget:''},doc:{nodes:[{id:'one',selected:true}]}};
 assert.deepEqual(Canvas.quoteSnapshot(entry),{version:1,nodeIds:['one'],budget:null});
 assert.equal(Canvas.optionalBudget(' '),null);assert.equal(Canvas.optionalBudget('5.5'),5.5);
 const captured=Canvas.quoteSnapshot(entry);entry.ui.budget='10';assert.equal(Canvas.quoteSnapshotCurrent(entry,captured),false);
});
test('the visible model summary distinguishes target shot timing from supported media duration',()=>{
 const node={mediaKind:'video',targetDuration:2,parameters:{ratio:'9:16',duration:4,resolution:'720p'}};
 const summary=Canvas.modelSummary(node,{label:'Seedance',defaults:{duration:5}});
 assert.match(summary,/9:16/);assert.match(summary,/720p/);assert.match(summary,/生成 4 秒/);assert.match(summary,/分镜 2 秒/);
 assert.doesNotMatch(Canvas.modelSummary({...node,targetDuration:4},{label:'Seedance'}),/分镜/);
});

 test('browsing and arranging scenes preserve a quote, while execution edits invalidate it',()=>{
 const entry={version:1,executionVersion:1,quote:{estimateToken:'quoted'},ui:{budget:''},doc:{nodes:[{id:'A',selected:true,prompt:'初稿',position:{x:0,y:0}}],viewport:{x:0,y:0,scale:1}}};
 const captured=Canvas.quoteSnapshot(entry);
 entry.doc.viewport={x:100,y:-20,scale:.7};entry.doc.nodes[0].position.x=80;Canvas.registerChange(entry,false);
 assert.equal(entry.version,2);assert.equal(entry.executionVersion,1);assert.equal(Canvas.quoteSnapshotCurrent(entry,captured),true);assert.equal(entry.quote.estimateToken,'quoted');
 entry.doc.nodes[0].prompt='修改后的提示词';Canvas.registerChange(entry);
 assert.equal(entry.quote,null);assert.equal(Canvas.quoteSnapshotCurrent(entry,captured),false);
 const latest=Canvas.quoteSnapshot(entry);entry.doc.nodes[0].selected=false;Canvas.registerChange(entry);
 assert.equal(Canvas.quoteSnapshotCurrent(entry,latest),false);
});

test('horizontal production places characters first and each shots image above its video',()=>{
 const nodes=[{id:'i1',shotId:'S01-001',mediaKind:'image'},{id:'v1',shotId:'S01-001',mediaKind:'video'},{id:'i2',shotId:'S01-002',mediaKind:'image'},{id:'v2',shotId:'S01-002',mediaKind:'video'},{id:'c1',nodeKind:'character',mediaKind:'image'}],original=JSON.stringify(nodes),positions=Canvas.horizontalPositions(nodes);
 assert.ok(positions.c1.x<positions.i1.x);assert.ok(positions.i1.x<positions.i2.x);assert.equal(positions.i1.x,positions.v1.x);assert.ok(positions.v1.y>positions.i1.y);assert.equal(JSON.stringify(nodes),original);
});
test('shot images require confirmed character outputs and send their selected references',()=>{
 const m={id:'edit',mediaKind:'image',available:true,fields:[{name:'prompt',type:'string',required:true},{name:'imageUrls',type:'array',required:true,items:{type:'string',format:'https'}}]},n={id:'shot',mediaKind:'image',modelId:'edit',prompt:'少女走入走廊',characterAssetIds:['c1'],parameterDraft:{}},doc={projectId:'p',nodes:[n],characterAssets:[{id:'c1',name:'少女',status:'draft'}]};
 assert.throws(()=>Canvas.prepareNode(n,m,doc,[],Runtime),/先确认人物定妆：少女/);
 doc.characterAssets[0]={id:'c1',name:'少女',status:'ready',referenceUrl:'https://example.com/character.png'};
 assert.deepEqual(Canvas.prepareNode({...n,parameters:{imageUrls:['https://example.com/old.png']}},m,doc,[],Runtime).imageUrls,['https://example.com/character.png']);
 doc.characterAssets[0].status='stale';assert.throws(()=>Canvas.prepareNode(n,m,doc,[],Runtime),/先确认人物/);
});
test('generated result ordering is timestamp based and progress excludes unrelated projects',()=>{
 const nodes=[{id:'i',mediaKind:'image'},{id:'v',mediaKind:'video'}],jobs=[{id:'new',projectId:'p',canvasNodeId:'i',status:'succeeded',createdAt:30},{id:'old',projectId:'p',canvasNodeId:'i',status:'failed',createdAt:10},{id:'video',projectId:'p',canvasNodeId:'v',status:'running',createdAt:20},{id:'foreign',projectId:'other',canvasNodeId:'v',status:'failed',createdAt:40}];
 const summary=Canvas.progressSummary(nodes,jobs,'p');assert.equal(summary.succeeded,1);assert.equal(summary.active,1);assert.equal(summary.failed,0);assert.equal(summary.latest.id,'new');assert.equal(summary.total,2);
});

test('character dependent video uses a shot first frame without requiring an image model field',()=>{
 const image={id:'image-one',mediaKind:'image'},video={id:'video-one',mediaKind:'video',prompt:'少女抬头',referenceNodeId:image.id,characterAssetIds:['c1']},doc={projectId:'p',nodes:[image,video],characterAssets:[{id:'c1',name:'少女',status:'ready',referenceUrl:'https://example.com/character.png'}]},m={mediaKind:'video',fields:[{name:'prompt',type:'string',required:true},{name:'firstFrameUrl',type:'string',format:'https',required:true}]};
 const jobs=[{id:'j',projectId:'p',canvasNodeId:'image-one',status:'succeeded',outputs:[{url:'https://example.com/shot.png',outputType:'png'}]}];
 const result=Canvas.prepareNode(video,m,doc,jobs,Runtime);assert.equal(result.firstFrameUrl,'https://example.com/shot.png');assert.equal(Object.hasOwn(result,'imageUrls'),false);
 doc.characterAssets[0].status='stale';assert.throws(()=>Canvas.prepareNode(video,m,doc,jobs,Runtime),/先确认人物定妆/);
});

test('character and canvas pages isolate hidden selections while preserving the shared document',()=>{
 const doc={assetSourceVersion:'v2',characterAssets:[{nodeId:'old',sourceVersion:'v1'},{nodeId:'current',sourceVersion:'v2'},{nodeId:'manual'}],nodes:[{id:'old',nodeKind:'character',selected:true},{id:'current',nodeKind:'character',selected:true},{id:'manual',nodeKind:'character',selected:true},{id:'shot',nodeKind:'shot',selected:true}]},before=JSON.stringify(doc);
 const assets={doc,mode:'assets',version:1,ui:{budget:''}},canvas={...assets,mode:'canvas'};
 assert.deepEqual(Canvas.quoteSnapshot(assets).nodeIds,['current','manual']);assert.deepEqual(Canvas.quoteSnapshot(canvas).nodeIds,['shot']);assert.equal(JSON.stringify(doc),before);
 assert.deepEqual(Canvas.entryNodes(assets).map(n=>n.id),['current','manual']);assert.deepEqual(Canvas.entryNodes(canvas).map(n=>n.id),['shot']);
});

test('returning to a cached page keeps only fields edited here and never rolls back the other page',()=>{
 const baseline=[{id:'character',prompt:'旧人物',modelId:'old'},{id:'shot',prompt:'原镜头',modelId:'old',status:'draft'}];
 const local=[{...baseline[0]},{...baseline[1],prompt:'本地新镜头'}],incoming=[{id:'character',prompt:'刚保存的人物',modelId:'new'},{id:'shot',prompt:'原镜头',modelId:'new',status:'running'}];
 const result=Canvas.mergeLocalNodes(local,incoming,baseline,['shot']);
 assert.equal(result[0].prompt,'刚保存的人物');assert.equal(result[1].prompt,'本地新镜头');assert.equal(result[1].modelId,'new');assert.equal(result[1].status,'running');
 const reverse=Canvas.mergeLocalNodes([{...baseline[0],prompt:'本地人物'},baseline[1]],[incoming[0],{...incoming[1],prompt:'刚保存的镜头'}],baseline,['character']);
 assert.equal(reverse[0].prompt,'本地人物');assert.equal(reverse[1].prompt,'刚保存的镜头');
});
