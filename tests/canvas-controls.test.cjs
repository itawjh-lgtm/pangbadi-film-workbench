'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const Controls=require('../lib/canvas-controls.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const dimensionFields=[{name:'width',type:'integer',minimum:240,maximum:8192,default:1024},{name:'height',type:'integer',minimum:240,maximum:8192,default:1024},{name:'resolution',type:'string',options:['1k','2k'],default:'2k'}];
const seedream={id:'seedream-v5-pro/text-to-image',mediaKind:'image',defaults:{width:1024,height:1024,resolution:'2k'},fields:dimensionFields};
const image=(patch={})=>({nodeKind:'character',mediaKind:'image',modelId:seedream.id,parameters:{width:1536,height:2048},parameterDraft:{},prompt:'保留原人物提示词',stylePreset:'youth_manga',referenceNodeId:'original-reference',...patch});

test('the helper exports the same API to CommonJS and a browser without requiring a DOM',()=>{
  const context={window:{}};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/canvas-controls.js'),'utf8'),context);
  assert.deepEqual(Object.keys(context.window.StudioCanvasControls).sort(),Object.keys(Controls).sort());
  assert.equal(context.window.StudioCanvasControls.imageSizePresets(image(),seedream)[0].width,768);
});

test('the grouped library has at least 24 actual styles and preserves all six original contracts',()=>{
  assert.ok(Controls.styles.filter(style=>style.id!=='original').length>=24);assert.equal(new Set(Controls.styles.map(style=>style.id)).size,Controls.styles.length);
  for(const style of Controls.styles){for(const key of ['id','name','group','description'])assert.ok(typeof style[key]==='string'&&style[key].length);assert.equal(typeof style.prompt,'string');if(style.id!=='original')assert.ok(style.prompt.length>20);}
  const originals={original:'',cute3d:'视觉风格：可爱的3D动画，圆润有辨识度的角色，细腻材质，柔和电影光线，统一角色与场景设计，画面干净。',cinematic:'视觉风格：电影写实摄影，自然可信的材质，精确光影，克制调色，清晰的主体与景深，保持角色一致性。',anime:'视觉风格：精致二维动画，清晰线稿，细腻赛璐璐色块，富有层次的动画场景，保持人物造型一致。',ink:'视觉风格：现代水墨绘本，纸张与墨色质感，疏密有致的留白，克制的矿物色点缀，叙事清晰。',clay:'视觉风格：手作黏土定格动画，柔软可爱的造型，细微手工痕迹，温暖布景，真实微缩摄影光线。'};
  for(const [id,prompt] of Object.entries(originals))assert.equal(Controls.styles.find(style=>style.id===id)?.prompt,prompt);
  for(const group of ['二维漫画','3D材质','绘画国风','摄影影视'])assert.ok(Controls.styles.some(style=>style.group===group));
});

test('quick fields come only from model fields and omit Seedream resolution without affecting other models',()=>{
  const names=['prompt','resolution','size','width','height','duration','durationSeconds','aspectRatio','ratio','quality','generateAudio','bitrateMode','draft','seed','imageUrls'];
  const model={id:'other-model',fields:names.map(name=>({name}))};
  assert.deepEqual(Controls.quickFieldNames(model),names.filter(name=>!['prompt','seed','imageUrls'].includes(name)));
  assert.deepEqual(Controls.quickFieldNames(seedream),['width','height']);assert.deepEqual(Controls.quickFieldNames({}),[]);
  assert.deepEqual(Controls.quickFieldNames({...seedream,id:'seedream-v5-pro/image-to-image'}),['width','height']);
});

test('image presets preserve portrait and landscape ratios without changing existing resolution or the node',()=>{
  const node=image({parameters:{width:1024,height:1024,resolution:'1k'},parameterDraft:{width:'1536',height:'2048'}}),before=clone(node);
  assert.deepEqual(Controls.imageSizePresets(node,seedream),[{id:'1024',label:'1K',width:768,height:1024},{id:'2048',label:'2K',width:1536,height:2048}]);assert.deepEqual(node,before);
  assert.deepEqual(Controls.imageSizePresets(image({parameters:{},parameterDraft:{aspectRatio:'9:16'}}),seedream).map(({width,height})=>[width,height]),[[576,1024],[1152,2048]]);
  assert.deepEqual(Controls.imageSizePresets(image({parameters:{ratio:'16:9'}}),seedream).map(({width,height})=>[width,height]),[[1024,576],[2048,1152]]);
});

test('image presets respect numeric schema bounds and steps and never invent an unsupported tier',()=>{
  const model={...seedream,fields:dimensionFields.map(field=>field.name==='resolution'?field:{...field,schema:{type:'integer',minimum:256,maximum:2048,multipleOf:16}})};
  for(const preset of Controls.imageSizePresets(image({parameters:{width:1000,height:1500}}),model)){assert.equal(preset.width%16,0);assert.equal(preset.height%16,0);assert.ok(preset.width>=256&&preset.height<=2048);assert.ok(Math.abs((preset.width/preset.height)/(2/3)-1)<=.01);}
  const capped={...seedream,fields:dimensionFields.map(field=>({...field,maximum:1024}))};assert.deepEqual(Controls.imageSizePresets(image(),capped).map(item=>item.id),['1024']);
  const enumerated={...seedream,fields:dimensionFields.map(field=>field.name==='resolution'?field:{...field,enum:[512,1024]})};assert.deepEqual(Controls.imageSizePresets(image({parameters:{width:1024,height:1024}}),enumerated).map(item=>item.id),['1024']);
  assert.deepEqual(Controls.imageSizePresets(image({parameters:{width:100,height:2000}}),model),[]);
  assert.deepEqual(Controls.imageSizePresets(image(),{...seedream,id:'another-image-model'}),[]);assert.deepEqual(Controls.imageSizePresets(image(),{...seedream,fields:[]}),[]);
});

test('applying an image tier updates both parameter layers and clears resolution without touching content or references',()=>{
  const node=image({parameters:{width:1536,height:2048,resolution:'2k',imageUrls:['https://example.invalid/a.png'],seed:7},parameterDraft:{resolution:'2k',quality:'high'}}),before=clone(node);
  assert.equal(Controls.applyImageSize(node,seedream,'1024'),true);
  for(const layer of [node.parameters,node.parameterDraft]){assert.equal(layer.width,768);assert.equal(layer.height,1024);assert.equal(layer.resolution,'');}
  for(const key of ['prompt','stylePreset','referenceNodeId'])assert.equal(node[key],before[key]);assert.deepEqual(node.parameters.imageUrls,before.parameters.imageUrls);assert.equal(node.parameters.seed,7);assert.equal(node.parameterDraft.quality,'high');
  const after=clone(node);assert.equal(Controls.applyImageSize(node,seedream,'4096'),false);assert.deepEqual(node,after);
});

test('quality copy uses explicit draft values before defaults and preserves false and zero without copying prompt or references',()=>{
  const model={id:'video-model',fields:[{name:'duration',type:'integer',minimum:0,maximum:15,default:5},{name:'generateAudio',type:'boolean',default:true},{name:'resolution',type:'string',options:['480p','720p'],default:'720p'},{name:'draft',type:'boolean',default:true},{name:'seed',type:'integer'},{name:'firstFrameUrl',type:'string'}]};
  const source={nodeKind:'shot',mediaKind:'video',modelId:model.id,parameters:{duration:10,generateAudio:true,seed:99,firstFrameUrl:'https://example.invalid/source.png'},parameterDraft:{duration:'0',generateAudio:'false',draft:false},prompt:'源提示词',referenceNodeId:'source-reference'};
  const target={nodeKind:'free',mediaKind:'video',modelId:model.id,parameters:{duration:8,seed:123,firstFrameUrl:'https://example.invalid/target.png'},parameterDraft:{seed:456},prompt:'目标提示词',referenceNodeId:'target-reference'};
  assert.equal(Controls.copySettings(source,target,model,model),true);
  for(const layer of [target.parameters,target.parameterDraft]){assert.equal(layer.duration,0);assert.equal(layer.generateAudio,false);assert.equal(layer.draft,false);assert.equal(layer.resolution,'720p');}
  assert.equal(target.parameters.seed,123);assert.equal(target.parameterDraft.seed,456);assert.equal(target.parameters.firstFrameUrl,'https://example.invalid/target.png');assert.equal(target.referenceNodeId,'target-reference');assert.equal(target.prompt,'目标提示词');
});

test('quality copy skips missing or unsupported target fields and refuses another model or a character/shot mismatch',()=>{
  const sourceModel={id:'same',fields:[{name:'resolution',type:'string',options:['1k','2k'],default:'2k'},{name:'quality',type:'string',default:'high'},{name:'duration',type:'integer',minimum:0,default:5}]},targetModel={id:'same',fields:[{name:'resolution',type:'string',options:['1k']},{name:'duration',type:'integer',minimum:0,maximum:4}]};
  const source=image({modelId:'same'}),target=image({modelId:'same'}),before=clone(target);assert.equal(Controls.copySettings(source,target,sourceModel,targetModel),false);assert.deepEqual(target,before);
  assert.equal(Controls.copySettings(source,{...target,nodeKind:'shot'},sourceModel,sourceModel),false);assert.equal(Controls.copySettings(source,{...target,mediaKind:'video'},sourceModel,sourceModel),false);assert.equal(Controls.copySettings(source,{...target,modelId:'different'},sourceModel,{...sourceModel,id:'different'}),false);
});

test('Seedream quality copy clears stale resolution in both target layers and preserves reference images',()=>{
  const source=image({parameterDraft:{width:'768',height:'1024'}}),target=image({parameters:{width:2048,height:2048,resolution:'2k',imageUrls:['https://example.invalid/keep.png']},parameterDraft:{resolution:'1k'}});
  assert.equal(Controls.copySettings(source,target,seedream,seedream),true);
  for(const layer of [target.parameters,target.parameterDraft]){assert.equal(layer.width,1024);assert.equal(layer.height,1024);assert.equal(layer.resolution,'');}
  assert.deepEqual(target.parameters.imageUrls,['https://example.invalid/keep.png']);
});

test('Seedream quality copy follows an explicit resolution tier instead of stale dimensions without editing the source',()=>{
  const source=image({parameters:{width:768,height:1024,resolution:'2k'}}),target=image({parameters:{width:1024,height:1024}}),before=clone(source);
  assert.equal(Controls.copySettings(source,target,seedream,seedream),true);
  for(const layer of [target.parameters,target.parameterDraft]){assert.equal(layer.width,2048);assert.equal(layer.height,2048);assert.equal(layer.resolution,'');}
  assert.deepEqual(source,before);
  const small=image({parameters:{width:1536,height:2048},parameterDraft:{resolution:'1k'}});assert.equal(Controls.copySettings(small,target,seedream,seedream),true);assert.equal(target.parameters.width,1024);assert.equal(target.parameters.height,1024);
});

test('Seedream quality copy uses the source long edge while preserving each target orientation and ratio fields',()=>{
  const model={...seedream,fields:[...dimensionFields,{name:'ratio',type:'string',options:['16:9','9:16']},{name:'aspectRatio',type:'string',options:['16:9','9:16']}]};
  const source=image({parameters:{width:1024,height:576,ratio:'16:9',aspectRatio:'16:9'}}),before=clone(source);
  const target=image({parameters:{width:1152,height:2048,ratio:'9:16',aspectRatio:'9:16'},parameterDraft:{ratio:'9:16',aspectRatio:'9:16'}});
  assert.equal(Controls.copySettings(source,target,model,model),true);
  for(const layer of [target.parameters,target.parameterDraft]){assert.equal(layer.width,576);assert.equal(layer.height,1024);assert.equal(layer.ratio,'9:16');assert.equal(layer.aspectRatio,'9:16');}
  assert.deepEqual(source,before);
});

test('Seedream quality copy uses the backend default tier only when explicit dimensions and resolution are absent',()=>{
  const source=image({parameters:{}}),before=clone(source),target=image({parameters:{width:768,height:1024}});
  assert.equal(Controls.copySettings(source,target,seedream,seedream),true);assert.equal(target.parameters.width,1536);assert.equal(target.parameters.height,2048);assert.deepEqual(source,before);
  const explicit=image({parameters:{width:1024,height:576,resolution:''}});
  assert.equal(Controls.copySettings(explicit,target,seedream,seedream),true);assert.equal(target.parameters.width,768);assert.equal(target.parameters.height,1024);
});

test('generic width and height schemas scale the source quality to the target ratio without copying orientation',()=>{
  const model={id:'generic-image',fields:[...dimensionFields.filter(field=>field.name!=='resolution'),{name:'aspectRatio',type:'string',options:['16:9','9:16']}]};
  const source=image({modelId:model.id,parameters:{width:1024,height:576,aspectRatio:'16:9'}}),before=clone(source),target=image({modelId:model.id,parameters:{width:1152,height:2048,aspectRatio:'9:16'}});
  assert.equal(Controls.copySettings(source,target,model,model),true);assert.equal(target.parameters.width,576);assert.equal(target.parameters.height,1024);assert.equal(target.parameters.aspectRatio,'9:16');assert.deepEqual(source,before);
});

test('invalid target sizes are skipped as a pair while independent quality fields still copy',()=>{
  const sourceModel={...seedream,fields:[...dimensionFields,{name:'quality',type:'string',options:['standard','high']}]};
  const targetModel={...sourceModel,fields:sourceModel.fields.map(field=>['width','height'].includes(field.name)?{...field,minimum:768}:field)};
  const source=image({parameters:{width:1024,height:576,quality:'high'}}),target=image({parameters:{width:1152,height:2048,resolution:'2k',quality:'standard'},parameterDraft:{width:'1152',height:'2048',resolution:'2k'}}),before=clone(target);
  assert.equal(Controls.copySettings(source,target,sourceModel,targetModel),true);
  for(const key of ['width','height','resolution']){assert.equal(target.parameters[key],before.parameters[key]);assert.equal(target.parameterDraft[key],before.parameterDraft[key]);}assert.equal(target.parameters.quality,'high');assert.equal(target.parameterDraft.quality,'high');
  const noQualityTarget=image({parameters:{width:1152,height:2048,resolution:'2k'}}),unchanged=clone(noQualityTarget);
  assert.equal(Controls.copySettings(image({parameters:{width:1024,height:576}}),noQualityTarget,seedream,{...seedream,fields:targetModel.fields.filter(field=>field.name!=='quality')}),false);assert.deepEqual(noQualityTarget,unchanged);
});

test('video quality copying keeps target ratio and copies resolution duration and audio',()=>{
  const model={id:'video',fields:[{name:'ratio',type:'string',options:['16:9','9:16']},{name:'aspectRatio',type:'string',options:['16:9','9:16']},{name:'resolution',type:'string',options:['480p','720p']},{name:'duration',type:'integer',minimum:1,maximum:10},{name:'generateAudio',type:'boolean'}]};
  const source={nodeKind:'shot',mediaKind:'video',modelId:model.id,parameters:{ratio:'16:9',aspectRatio:'16:9',resolution:'480p',duration:5,generateAudio:false}},before=clone(source);
  const target={nodeKind:'shot',mediaKind:'video',modelId:model.id,parameters:{ratio:'9:16',aspectRatio:'9:16',resolution:'720p',duration:10,generateAudio:true},parameterDraft:{ratio:'9:16',aspectRatio:'9:16'}};
  assert.equal(Controls.copySettings(source,target,model,model),true);
  for(const layer of [target.parameters,target.parameterDraft]){assert.equal(layer.ratio,'9:16');assert.equal(layer.aspectRatio,'9:16');assert.equal(layer.resolution,'480p');assert.equal(layer.duration,5);assert.equal(layer.generateAudio,false);}assert.deepEqual(source,before);
});

test('quality copying skips size strings that encode orientation but allows resolution-only size tiers',()=>{
  const model={id:'sized-image',fields:[{name:'size',type:'string'},{name:'quality',type:'string',options:['standard','high']}]};
  for(const size of ['1024x1536','1024×1536','1024 X 1536']){
    const source=image({modelId:model.id,parameters:{size,quality:'high'}}),before=clone(source),target=image({modelId:model.id,parameters:{size:'1536x1024',quality:'standard'},parameterDraft:{size:'1536x1024'}});
    assert.equal(Controls.copySettings(source,target,model,model),true);assert.equal(target.parameters.size,'1536x1024');assert.equal(target.parameterDraft.size,'1536x1024');assert.equal(target.parameters.quality,'high');assert.deepEqual(source,before);
  }
  for(const size of ['1K','2K']){
    const source=image({modelId:model.id,parameters:{size}}),target=image({modelId:model.id,parameters:{size:'1K'}});
    assert.equal(Controls.copySettings(source,target,model,model),true);assert.equal(target.parameters.size,size);assert.equal(target.parameterDraft.size,size);
  }
});

test('style copy can cross models of the same media and character class and changes only stylePreset',()=>{
  const source=image(),target=image({modelId:'another',stylePreset:'original'}),before=clone(target);
  assert.equal(Controls.copySettings(source,target,seedream,{id:'another'},'style'),true);assert.deepEqual(target,{...before,stylePreset:'youth_manga'});
  assert.equal(Controls.copySettings(source,{...target,mediaKind:'video'},seedream,{},'style'),false);assert.equal(Controls.copySettings(source,{...target,nodeKind:'shot'},seedream,{},'style'),false);
  assert.equal(Controls.copySettings(source,target,seedream,{},'not-a-kind'),false);
});

test('Seedance 2.5 labels distinguish native and upscaled resolutions without relabeling other models',()=>{
  const model={id:'bytedance/seedance-2.5-pro/image-to-video'};
  for(const [value,label] of Object.entries({'480p':'480p · 试样','720p':'720p · 常用',native1080p:'原生 1080p','1080p':'超分 1080p','2k':'超分 2K','4k':'超分 4K'}))assert.equal(Controls.resolutionLabel(value,model),label);
  assert.equal(Controls.resolutionLabel('1080p',{id:'other/video'}),'1080p');assert.equal(Controls.resolutionLabel('8k',model),'8k');assert.equal(Controls.resolutionLabel('native1080p',{id:'bytedance/seedance-2.0/image-to-video'}),'native1080p');
});

test('Seedream offers seven feasible named ratios without mutating the image or exposing pixel labels',()=>{
  const node=image(),before=clone(node);
  assert.deepEqual(Controls.imageAspectOptions(node,seedream),[
    {value:'9:16',label:'9:16 · 竖屏'},{value:'16:9',label:'16:9 · 横屏'},{value:'1:1',label:'1:1 · 方形'},
    {value:'3:4',label:'3:4 · 人像'},{value:'4:3',label:'4:3 · 横图'},{value:'2:3',label:'2:3 · 竖图'},{value:'3:2',label:'3:2 · 横图'}
  ]);
  assert.equal(Controls.currentImageAspect(node,seedream),'3:4');assert.equal(Controls.currentImageSizeTier(node,seedream),'2048');
  assert.deepEqual(Controls.imageSizePresets(node,seedream).map(item=>[item.id,item.label]),[['1024','1K'],['2048','2K']]);assert.deepEqual(node,before);
  const constrained={...seedream,fields:dimensionFields.map(item=>['width','height'].includes(item.name)?{...item,minimum:1024,maximum:2048}:item)};
  const options=Controls.imageAspectOptions(image({parameters:{width:1024,height:1024}}),constrained);
  assert.deepEqual(options,[{value:'1:1',label:'1:1 · 方形'}]);
});

test('image aspect and quality switches retain the current tier and both parameter layers',()=>{
  const node=image({parameters:{width:1536,height:2048,resolution:'1k',imageUrls:['https://example.invalid/ref.png']},parameterDraft:{quality:'high'}}),before=clone(node);
  assert.equal(Controls.currentImageSizeTier(node,seedream),'1024');
  for(const [aspect,tier,size] of [['9:16','1024',[576,1024]],['16:9','1024',[1024,576]],['16:9','2048',[2048,1152]],['9:16','2048',[1152,2048]]]){
    assert.equal(Controls.applyImageSize(node,seedream,tier),true);assert.equal(Controls.applyImageAspect(node,seedream,aspect),true);
    assert.equal(Controls.currentImageAspect(node,seedream),aspect);assert.equal(Controls.currentImageSizeTier(node,seedream),tier);
    for(const layer of [node.parameters,node.parameterDraft]){assert.deepEqual([layer.width,layer.height],size);assert.equal(layer.resolution,'');}
  }
  assert.equal(node.prompt,before.prompt);assert.equal(node.stylePreset,before.stylePreset);assert.equal(node.referenceNodeId,before.referenceNodeId);assert.deepEqual(node.parameters.imageUrls,before.parameters.imageUrls);assert.equal(node.parameterDraft.quality,'high');
});

test('near-standard sizes snap for tier calculations and never accumulate one-pixel drift',()=>{
  for(const [start,aspect,small,large] of [[[769,1024],'3:4',[768,1024],[1536,2048]],[[1024,769],'4:3',[1024,768],[2048,1536]],[[577,1024],'9:16',[576,1024],[1152,2048]]]){
    const node=image({parameters:{width:start[0],height:start[1]}}),before=clone(node);
    assert.equal(Controls.currentImageAspect(node,seedream),aspect);assert.deepEqual(node,before);
    for(let round=0;round<20;round++){
      assert.equal(Controls.applyImageSize(node,seedream,'1024'),true);assert.deepEqual([node.parameters.width,node.parameters.height],small);
      assert.equal(Controls.applyImageSize(node,seedream,'2048'),true);assert.deepEqual([node.parameters.width,node.parameters.height],large);
    }
  }
});

test('nonstandard ratios stay custom on read and preserve their shape when only quality changes',()=>{
  const node=image({parameters:{width:800,height:1000}}),before=clone(node);
  assert.equal(Controls.currentImageAspect(node,seedream),'custom');assert.equal(Controls.currentImageSizeTier(node,seedream),'custom');
  Controls.imageAspectOptions(node,seedream);Controls.imageSizePresets(node,seedream);assert.deepEqual(node,before);
  assert.equal(Controls.applyImageSize(node,seedream,'2048'),true);assert.ok(Math.abs(node.parameters.width/node.parameters.height-.8)<.001);assert.equal(Controls.currentImageAspect(node,seedream),'custom');
  const nearButOutside=image({parameters:{width:772,height:1024}});assert.equal(Controls.currentImageAspect(nearButOutside,seedream),'custom');
  const bad=clone(node);assert.equal(Controls.applyImageAspect(node,seedream,'4:5'),false);assert.deepEqual(node,bad);
});

test('ratio enum models expose only the declared intersection and update only declared fields',()=>{
  const model={id:'enum-image',mediaKind:'image',fields:[{name:'aspectRatio',type:'string',options:['9:16','16:9','1:1','adaptive'],default:'1:1'},{name:'resolution',type:'string',options:['1k','2k'],default:'2k'}]};
  const node=image({modelId:model.id,parameters:{aspectRatio:'9:16',resolution:'1k',imageUrls:['https://example.invalid/ref.png']}}),before=clone(node);
  assert.deepEqual(Controls.imageAspectOptions(node,model).map(item=>item.value),['9:16','16:9','1:1']);assert.equal(Controls.currentImageAspect(node,model),'9:16');
  assert.equal(Controls.applyImageAspect(node,model,'16:9'),true);
  for(const layer of [node.parameters,node.parameterDraft]){assert.equal(layer.aspectRatio,'16:9');assert.equal(Object.hasOwn(layer,'width'),false);assert.equal(Object.hasOwn(layer,'height'),false);assert.equal(Object.hasOwn(layer,'ratio'),false);}
  assert.equal(node.parameters.resolution,'1k');assert.deepEqual(node.parameters.imageUrls,before.parameters.imageUrls);
  const ratioModel={id:'ratio-image',fields:[{name:'ratio',type:'string',schema:{enum:['3:4','4:3']}}]},ratioNode=image({modelId:ratioModel.id,parameters:{ratio:'3:4'}});
  assert.deepEqual(Controls.imageAspectOptions(ratioNode,ratioModel).map(item=>item.value),['3:4','4:3']);assert.equal(Controls.currentImageAspect(ratioNode,ratioModel),'3:4');assert.equal(Controls.applyImageAspect(ratioNode,ratioModel,'4:3'),true);assert.equal(ratioNode.parameters.ratio,'4:3');assert.equal(Object.hasOwn(ratioNode.parameters,'aspectRatio'),false);
  const both={...model,fields:[...model.fields,{name:'ratio',type:'string',enum:['1:1','3:4']}]};assert.deepEqual(Controls.imageAspectOptions(node,both).map(item=>item.value),['1:1']);
  const after=clone(node);assert.equal(Controls.applyImageAspect(node,model,'3:4'),false);assert.deepEqual(node,after);
});

test('unknown models, model mismatches and video nodes cannot advertise or apply image aspect controls',()=>{
  for(const [node,model] of [[image(),{}],[image(),{id:'unknown',fields:[]}],[image({modelId:'dimensions-only'}),{id:'dimensions-only',fields:dimensionFields}],[image(),{...seedream,id:'other'}],[image({mediaKind:'video'}),seedream],[image(),{...seedream,fields:[]}]]){
    const before=clone(node);assert.deepEqual(Controls.imageAspectOptions(node,model),[]);assert.equal(Controls.currentImageAspect(node,model),'custom');assert.equal(Controls.applyImageAspect(node,model,'9:16'),false);assert.deepEqual(node,before);
  }
  assert.deepEqual(Controls.imageSizePresets(image(),{...seedream,id:'other'}),[]);assert.equal(Controls.currentImageSizeTier(image(),{}),'custom');
});

test('explicit Seedream resolution wins over stale dimensions when applying an aspect',()=>{
  const node=image({parameters:{width:768,height:1024,resolution:'1k'},parameterDraft:{resolution:'2k'}});
  assert.equal(Controls.currentImageSizeTier(node,seedream),'2048');assert.equal(Controls.applyImageAspect(node,seedream,'16:9'),true);
  for(const layer of [node.parameters,node.parameterDraft]){assert.deepEqual([layer.width,layer.height],[2048,1152]);assert.equal(layer.resolution,'');}
  const unsupported=image({parameters:{width:768,height:1024,resolution:'4k'}}),before=clone(unsupported);assert.equal(Controls.currentImageSizeTier(unsupported,seedream),'custom');assert.deepEqual(Controls.imageAspectOptions(unsupported,seedream),[]);assert.equal(Controls.applyImageAspect(unsupported,seedream,'9:16'),false);assert.deepEqual(unsupported,before);
});

test('conflicting declared ratio fields are shown as custom until explicitly selected',()=>{
  const model={id:'both-ratios',fields:['ratio','aspectRatio'].map(name=>({name,type:'string',enum:['9:16','16:9']}))};
  const node=image({modelId:model.id,parameters:{ratio:'9:16',aspectRatio:'16:9'}}),before=clone(node);
  assert.equal(Controls.currentImageAspect(node,model),'custom');assert.deepEqual(node,before);
  assert.equal(Controls.applyImageAspect(node,model,'9:16'),true);assert.equal(node.parameters.ratio,'9:16');assert.equal(node.parameters.aspectRatio,'9:16');assert.equal(Controls.currentImageAspect(node,model),'9:16');
});
