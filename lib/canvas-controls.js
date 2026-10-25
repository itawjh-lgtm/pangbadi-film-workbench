/* Shared style and quality controls. These helpers never request or submit media. */
(function(global){
  'use strict';
  const styles=[
    {id:'original',name:'保持原稿风格',group:'通用',prompt:'',description:'沿用原提示词，不追加风格要求。'},
    {id:'cute3d',name:'可爱 3D 动画',group:'3D材质',prompt:'视觉风格：可爱的3D动画，圆润有辨识度的角色，细腻材质，柔和电影光线，统一角色与场景设计，画面干净。',description:'圆润造型、细腻材质与柔和电影光线。'},
    {id:'cinematic',name:'电影写实',group:'摄影影视',prompt:'视觉风格：电影写实摄影，自然可信的材质，精确光影，克制调色，清晰的主体与景深，保持角色一致性。',description:'自然材质、摄影景深与克制的电影调色。'},
    {id:'anime',name:'日系动画',group:'二维漫画',prompt:'视觉风格：精致二维动画，清晰线稿，细腻赛璐璐色块，富有层次的动画场景，保持人物造型一致。',description:'清晰线稿、赛璐璐色块与层次丰富的场景。'},
    {id:'ink',name:'水墨绘本',group:'绘画国风',prompt:'视觉风格：现代水墨绘本，纸张与墨色质感，疏密有致的留白，克制的矿物色点缀，叙事清晰。',description:'墨色变化、纸张质感和疏密有致的留白。'},
    {id:'clay',name:'黏土定格',group:'3D材质',prompt:'视觉风格：手作黏土定格动画，柔软可爱的造型，细微手工痕迹，温暖布景，真实微缩摄影光线。',description:'可见的手作痕迹与温暖微缩布景。'},
    {id:'youth_manga',name:'青春漫画',group:'二维漫画',prompt:'视觉风格：精修二维青春漫画，自然的年龄与人体比例，有辨识度的脸型和发型轮廓，轻盈细线、干净色块、层次清楚的服装剪裁，表情细腻，角色设计前后一致。',description:'细线、干净配色与重视角色差异的青春造型。'},
    {id:'manga_bw',name:'黑白网点漫画',group:'二维漫画',prompt:'视觉风格：黑白漫画，清楚的墨线粗细变化，以黑白块面和疏密网点区分材质与光影，主体轮廓明确，表情和动作易读，不添加对白框或文字。',description:'墨线、网点与黑白块面的清楚对比。'},
    {id:'clear_line',name:'清线平涂漫画',group:'二维漫画',prompt:'视觉风格：清线平涂漫画，均匀利落的轮廓线、结构明确的形体和干净平涂色块，减少多余纹理，以构图和色彩面积表达空间，保持人物五官与服装特征。',description:'利落轮廓、简洁平涂与明确的空间关系。'},
    {id:'retro_cel',name:'复古赛璐璐',group:'二维漫画',prompt:'视觉风格：复古手绘赛璐璐动画，略有手绘变化的轮廓线、有限而协调的色板、分层硬边阴影与手绘背景，保留细微胶片颗粒，人物比例和配色稳定。',description:'手绘线条、硬边阴影和克制的复古颗粒。'},
    {id:'watercolor_anime',name:'水彩动画',group:'二维漫画',prompt:'视觉风格：水彩质感二维动画，细致人物线稿结合透明水彩背景，色彩轻盈、边缘柔软，光色有空气感；关键五官和服装轮廓保持清晰，不让晕染遮住叙事动作。',description:'清楚人物线稿与轻盈的水彩空气感。'},
    {id:'flat_storybook',name:'扁平绘本',group:'二维漫画',prompt:'视觉风格：现代扁平绘本，概括但有辨识度的人物比例、简洁几何形、少量协调色块、清楚的前后层级和留白，使用细微纸纹，不添加标题或说明文字。',description:'概括造型、少量色块与清晰叙事。'},
    {id:'bold_comic',name:'厚线彩色漫画',group:'二维漫画',prompt:'视觉风格：厚线彩色漫画，富有粗细节奏的墨线、明确的明暗分组、饱满但有主次的色彩，动作轮廓有张力，保持原镜头构图与人物身份，不添加漫画文字。',description:'有力度的墨线、色块和动作轮廓。'},
    {id:'vector_graphic',name:'几何矢量插画',group:'二维漫画',prompt:'视觉风格：几何矢量插画，以整洁的几何形、精确边缘和有限配色构成主体，减少写实纹理，用色块叠压表达空间与光影，画面清楚，保留辨识所需的角色和道具特征。',description:'精确边缘、几何构成与有限配色。'},
    {id:'stylized3d',name:'风格化电影 3D',group:'3D材质',prompt:'视觉风格：风格化三维动画电影，经过设计的面部比例和剪影，可信但简化的材质，富有层次的灯光与细腻表情，服装结构清楚，避免过度光滑的塑料皮肤。',description:'有设计感的剪影、材质与电影灯光。'},
    {id:'miniature',name:'微缩模型',group:'3D材质',prompt:'视觉风格：精细微缩模型摄影，具有真实尺度关系的模型、可辨认的手工材质与小型布景，浅景深和柔和侧光，保留主体全貌与动作，不靠过强虚化掩盖细节。',description:'真实手工尺度、细节与微缩摄影感。'},
    {id:'paper_layers',name:'层叠纸艺',group:'3D材质',prompt:'视觉风格：层叠纸艺场景，以裁切纸片的边缘、厚度、叠层和柔和投影构成形体，配色协调，空间层次明确，人物关键特征以纸艺造型保留，不添加文字。',description:'裁切边缘、纸层厚度与柔和投影。'},
    {id:'felt',name:'毛毡定格',group:'3D材质',prompt:'视觉风格：手工毛毡定格动画，柔软纤维、针毡纹理和温暖布景，角色轮廓简洁但各有辨识度，五官与服装边界清楚，以微缩摄影光线呈现。',description:'柔软纤维、针毡纹理和温暖手作感。'},
    {id:'wooden_toy',name:'木制玩具',group:'3D材质',prompt:'视觉风格：木制玩具与木偶场景，保留木纹、圆角、涂装边界和关节结构，用简洁形体表达角色，颜色克制协调，柔和棚灯呈现材料与尺度，避免杂乱装饰。',description:'木纹、涂装边界与清楚的玩具结构。'},
    {id:'low_poly',name:'低多边形',group:'3D材质',prompt:'视觉风格：精致低多边形三维场景，以有计划的切面和块状形体概括人物与环境，限制材质噪点，用清楚的光色关系表现体积，保持角色剪影和动作可读。',description:'清楚的切面形体与克制的光色。'},
    {id:'gongbi',name:'工笔淡彩',group:'绘画国风',prompt:'视觉风格：工笔淡彩绘画，细密而有节奏的勾线、薄层罩染与细致衣纹，色彩清雅，面部结构和道具工艺可辨，留白与构图服务原场景，不随意改变人物时代和服装身份。',description:'细致勾线、薄层罩染与清雅配色。'},
    {id:'mineral_color',name:'矿物重彩',group:'绘画国风',prompt:'视觉风格：矿物重彩绘画，石青石绿与暖色形成有主次的配色，颗粒质感、层层罩染和清楚的形体轮廓，装饰节奏适量，保持人物肤色、表情和原有服装设定。',description:'矿物色颗粒、层层罩染和装饰节奏。'},
    {id:'bluegreen_landscape',name:'青绿山水',group:'绘画国风',prompt:'视觉风格：青绿山水绘画，以石青石绿层染和细线勾勒山石树木，疏密与远近层次清楚，人物作为原叙事主体保留可辨识造型，不添加题字、印章或无关亭台。',description:'青绿层染、山石勾勒与远近层次。'},
    {id:'watercolor',name:'透明水彩',group:'绘画国风',prompt:'视觉风格：透明水彩插画，纸白、薄层叠色、自然水痕与软硬边相互配合，光线通透，主体关键结构清楚，以留白和色彩层次组织画面，不添加说明文字。',description:'纸白、水痕、透明叠色与通透光线。'},
    {id:'gouache',name:'水粉绘画',group:'绘画国风',prompt:'视觉风格：水粉绘画，柔和不透明色层、可见但有节制的笔触、明确的明度分组与冷暖关系，轮廓有虚实变化，人物表情和服装设计保持一致。',description:'哑光色层、笔触和明确的冷暖关系。'},
    {id:'oil_brush',name:'油画笔触',group:'绘画国风',prompt:'视觉风格：具象油画，以顺应形体的笔触、厚薄变化的颜料和有层次的明暗表现体积，色彩有主次，关键五官与动作可读，避免用杂乱纹理替代结构。',description:'顺应形体的油彩笔触和厚薄层次。'},
    {id:'woodcut',name:'木刻版画',group:'绘画国风',prompt:'视觉风格：木刻版画，清楚的刀痕方向、黑白块面与少量套色，利用线面节奏表达体积和材质，人物剪影有辨识度，构图简洁，不加入题字和印章。',description:'刀痕、黑白块面与少量套色。'},
    {id:'film_grain',name:'胶片摄影',group:'摄影影视',prompt:'视觉风格：胶片摄影，可信的曝光与肤色、细腻自然的颗粒、柔和高光过渡和克制饱和度，保留暗部层次，景深服从主体关系，避免滤镜遮盖服装与面部细节。',description:'自然颗粒、柔和高光与克制饱和度。'},
    {id:'documentary',name:'自然光纪实',group:'摄影影视',prompt:'视觉风格：自然光纪实摄影，真实空间和环境光方向，质朴可信的材质与肤色，适度景深，捕捉自然表情与动作，保持现场生活痕迹，避免夸张棚拍效果。',description:'可信环境光、生活痕迹和自然表情。'},
    {id:'studio_portrait',name:'精细棚拍人像',group:'摄影影视',prompt:'视觉风格：精细棚拍人像，具有辨识度且符合原年龄的真实面部结构，细腻皮肤纹理，服装剪裁和材质清楚，柔和主光与适量轮廓光，干净背景，避免过度磨皮。',description:'真实面部结构、服装质感与干净棚灯。'},
    {id:'noir',name:'黑色电影',group:'摄影影视',prompt:'视觉风格：黑色电影摄影，以有依据的硬光、深色背景、局部高光和清楚的阴影形状组织构图，黑白或克制低饱和配色，保留人物身份与原场景信息，不以过暗画面掩盖动作。',description:'有依据的硬光、阴影形状与克制色彩。'},
    {id:'product_still',name:'产品静物摄影',group:'摄影影视',prompt:'视觉风格：精致产品静物摄影，材质纹理和轮廓清楚，反射、高光与柔和阴影有控制，背景简洁，色彩准确，构图突出原有物件与使用关系，不添加品牌标识或宣传文字。',description:'准确材质、受控反射与简洁构图。'}
  ];
  const imageAspects=[
    {value:'9:16',label:'9:16 · 竖屏'},
    {value:'16:9',label:'16:9 · 横屏'},
    {value:'1:1',label:'1:1 · 方形'},
    {value:'3:4',label:'3:4 · 人像'},
    {value:'4:3',label:'4:3 · 横图'},
    {value:'2:3',label:'2:3 · 竖图'},
    {value:'3:2',label:'3:2 · 横图'}
  ];
  const seedreamIds=new Set(['seedream-v5-pro/text-to-image','seedream-v5-pro/image-to-image']);
  const names=['resolution','size','width','height','duration','durationSeconds','aspectRatio','ratio','quality','generateAudio','bitrateMode','draft'];
  const own=(object,key)=>Object.hasOwn(object||{},key);
  const modelId=model=>model?.id||model?.modelId||'';
  const isSeedream=model=>seedreamIds.has(modelId(model));
  const values=node=>({...node?.parameters,...node?.parameterDraft});
  const field=(model,name)=>model?.fields?.find(item=>item.name===name);
  const schema=(model,name)=>{const item=field(model,name);return item?{...item,...item.schema}:null;};
  function quickFieldNames(model){return names.filter(name=>field(model,name)&&!(name==='resolution'&&isSeedream(model)));}
  function effective(node,model,name){const input=values(node);return own(input,name)?input[name]:own(model?.defaults,name)?model.defaults[name]:schema(model,name)?.default;}
  const gcd=(a,b)=>{while(b){const next=a%b;a=b;b=next;}return Math.abs(a);};
  function integerStep(value){if(value==null)return 1;const number=Number(value);if(!(number>0&&Number.isFinite(number)))return null;const scale=1e6,numerator=Math.round(number*scale);return numerator/gcd(numerator,scale);}
  function numberLimits(spec){
    if(!spec||!['integer','number'].includes(Array.isArray(spec.type)?spec.type.find(type=>type!=='null'):spec.type))return null;
    let min=Math.max(1,Math.ceil(spec.minimum??1)),max=Math.floor(spec.maximum??8192);
    if(typeof spec.exclusiveMinimum==='number')min=Math.max(min,Math.floor(spec.exclusiveMinimum)+1);else if(spec.exclusiveMinimum===true&&spec.minimum!=null)min=Math.max(min,Math.floor(spec.minimum)+1);
    if(typeof spec.exclusiveMaximum==='number')max=Math.min(max,Math.ceil(spec.exclusiveMaximum)-1);else if(spec.exclusiveMaximum===true&&spec.maximum!=null)max=Math.min(max,Math.ceil(spec.maximum)-1);
    const step=integerStep(spec.multipleOf);return step&&min<=max?{min,max,step}:null;
  }
  const INVALID=Symbol('invalid');
  function validValue(raw,spec){
    if(!spec||raw===undefined||raw===null||raw==='')return INVALID;
    const type=Array.isArray(spec.type)?spec.type.find(item=>item!=='null'):spec.type;
    let value=raw;
    if(type==='integer'||type==='number'){
      if(!['string','number'].includes(typeof raw)||String(raw).trim()==='')return INVALID;
      value=Number(raw);if(!Number.isFinite(value)||type==='integer'&&!Number.isSafeInteger(value))return INVALID;
      if(spec.minimum!=null&&value<spec.minimum||spec.maximum!=null&&value>spec.maximum)return INVALID;
      const low=typeof spec.exclusiveMinimum==='boolean'?(spec.exclusiveMinimum?spec.minimum:null):spec.exclusiveMinimum,high=typeof spec.exclusiveMaximum==='boolean'?(spec.exclusiveMaximum?spec.maximum:null):spec.exclusiveMaximum;
      if(low!=null&&value<=low||high!=null&&value>=high)return INVALID;
      if(spec.multipleOf!=null&&Math.abs(value/spec.multipleOf-Math.round(value/spec.multipleOf))>1e-8)return INVALID;
    }else if(type==='boolean'){if(![true,false,'true','false'].includes(raw))return INVALID;value=raw===true||raw==='true';}
    else if(type==='string'){if(!['string','number','boolean'].includes(typeof raw))return INVALID;value=String(raw);if(spec.minLength!=null&&value.length<spec.minLength||spec.maxLength!=null&&value.length>spec.maxLength)return INVALID;}
    else if(typeof raw==='object')return INVALID;
    const choices=spec.options||spec.enum;if(Array.isArray(choices)&&choices.length&&!choices.some(option=>(option&&typeof option==='object'&&own(option,'value')?option.value:option)===value))return INVALID;
    if(own(spec,'const')&&spec.const!==value)return INVALID;
    return value;
  }
  function ratioFor(node,model,fallback=1){
    const input=values(node),width=Number(input.width),height=Number(input.height);
    if(Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0)return width/height;
    for(const raw of [input.aspectRatio,input.ratio,model?.defaults?.aspectRatio,model?.defaults?.ratio]){const match=typeof raw==='string'&&raw.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);if(match&&Number(match[1])>0&&Number(match[2])>0)return Number(match[1])/Number(match[2]);}
    const fallbackWidth=Number(effective({},model,'width')),fallbackHeight=Number(effective({},model,'height'));
    return Number.isFinite(fallbackWidth)&&Number.isFinite(fallbackHeight)&&fallbackWidth>0&&fallbackHeight>0?fallbackWidth/fallbackHeight:fallback;
  }
  function sizeFor(edge,ratio,widthSchema,heightSchema){
    const w=numberLimits(widthSchema),h=numberLimits(heightSchema);if(!w||!h||!(ratio>0&&Number.isFinite(ratio)))return null;
    const desiredHeight=edge/Math.max(1,ratio),desiredWidth=desiredHeight*ratio;
    const candidates=(desired,limits,spec)=>{
      const choices=spec.options||spec.enum,raw=Array.isArray(choices)?choices.map(item=>item&&typeof item==='object'?item.value:item):own(spec,'const')?[spec.const]:[Math.floor(desired/limits.step)*limits.step,Math.ceil(desired/limits.step)*limits.step];
      return [...new Set(raw)].filter(value=>Number.isSafeInteger(value)&&value>=limits.min&&value<=limits.max&&value<=edge&&validValue(value,spec)!==INVALID);
    };
    let best=null;
    for(const width of candidates(desiredWidth,w,widthSchema))for(const height of candidates(desiredHeight,h,heightSchema)){
      const ratioError=Math.abs((width/height)/ratio-1),edgeError=Math.abs(Math.max(width,height)/edge-1);if(ratioError>.01||edgeError>.01)continue;
      const score=ratioError+Math.abs(width-desiredWidth)/edge*.01+Math.abs(height-desiredHeight)/edge*.01;
      if(!best||score<best.score)best={width,height,score};
    }
    return best?{width:best.width,height:best.height}:null;
  }
  const aspectRatio=value=>{const [width,height]=value.split(':').map(Number);return width/height;};
  const nearestAspect=ratio=>imageAspects.find(item=>Math.abs(aspectRatio(item.value)-ratio)<.003)?.value||'custom';
  function imageModelMatches(node,model){return !!(node&&typeof node==='object'&&modelId(model)&&(!node.modelId||node.modelId===modelId(model))&&(!node.mediaKind||node.mediaKind==='image')&&(!model?.mediaKind||model.mediaKind==='image'));}
  function aspectFields(model){
    return ['aspectRatio','ratio'].flatMap(name=>{
      const spec=schema(model,name),choices=spec?.options?.length?spec.options:spec?.enum;
      const options=Array.isArray(choices)?choices.map(item=>item&&typeof item==='object'?item.value:item):spec&&own(spec,'const')?[spec.const]:[];
      return options.length?[{name,spec,options}]:[];
    });
  }
  function currentImageAspect(node,model){
    if(!imageModelMatches(node,model))return 'custom';
    if(isSeedream(model)){
      if(!numberLimits(schema(model,'width'))||!numberLimits(schema(model,'height')))return 'custom';
      return nearestAspect(ratioFor(node,model,NaN));
    }
    const fields=aspectFields(model),configured=fields.map(({name,spec})=>validValue(effective(node,model,name),spec)).filter(value=>value!==INVALID);
    const unique=[...new Set(configured)],value=unique[0];
    return unique.length===1&&imageAspects.some(item=>item.value===value)&&fields.every(item=>item.options.includes(value))?value:'custom';
  }
  function canonicalRatio(node,model){
    const ratio=ratioFor(node,model,NaN),aspect=nearestAspect(ratio);
    // Only snap a known near-standard framing. Repeated tier changes then use
    // the exact ratio instead of magnifying a previous one-pixel rounding.
    return aspect==='custom'?ratio:aspectRatio(aspect);
  }
  function imageAspectOptions(node,model){
    if(!imageModelMatches(node,model))return [];
    if(isSeedream(model)){
      const edge=qualityLongEdge(node,model);
      return edge?imageAspects.filter(item=>sizeFor(edge,aspectRatio(item.value),schema(model,'width'),schema(model,'height'))).map(item=>({...item})):[];
    }
    const fields=aspectFields(model);
    return fields.length?imageAspects.filter(item=>fields.every(({options,spec})=>options.includes(item.value)&&validValue(item.value,spec)!==INVALID)).map(item=>({...item})):[];
  }
  function imageSizePresets(node,model){
    if(!imageModelMatches(node,model)||!isSeedream(model))return [];
    const ratio=canonicalRatio(node,model),widthSchema=schema(model,'width'),heightSchema=schema(model,'height');
    return [['1024','1K'],['2048','2K']].flatMap(([id,label])=>{const size=sizeFor(Number(id),ratio,widthSchema,heightSchema);return size?[{id,label,...size}]:[];});
  }
  function writeParameters(node,settings){node.parameters={...node.parameters,...settings};node.parameterDraft={...node.parameterDraft,...settings};}
  function applyImageSize(node,model,id){if(!imageModelMatches(node,model))return false;const preset=imageSizePresets(node,model).find(item=>item.id===String(id));if(!preset)return false;writeParameters(node,{width:preset.width,height:preset.height,resolution:''});return true;}
  function applyImageAspect(node,model,value){
    if(!imageAspectOptions(node,model).some(item=>item.value===value))return false;
    if(isSeedream(model)){
      const size=sizeFor(qualityLongEdge(node,model),aspectRatio(value),schema(model,'width'),schema(model,'height'));
      if(!size)return false;
      writeParameters(node,{...size,resolution:''});
    }else writeParameters(node,Object.fromEntries(aspectFields(model).map(({name})=>[name,value])));
    return true;
  }
  function qualityLongEdge(node,model){
    const input=values(node),tiers={'1k':1024,'2k':2048};
    if(isSeedream(model)){
      if(input.resolution!=null&&input.resolution!=='')return tiers[input.resolution]||null;
      const hasDimension=['width','height'].some(name=>own(input,name)&&input[name]!=null&&input[name]!=='');
      if(!hasDimension){const resolution=model?.defaults?.resolution??schema(model,'resolution')?.default;if(resolution!=null&&resolution!=='')return tiers[resolution]||null;}
    }
    const widthSchema=schema(model,'width'),heightSchema=schema(model,'height');
    if(!numberLimits(widthSchema)||!numberLimits(heightSchema))return null;
    const width=validValue(effective(node,model,'width'),widthSchema),height=validValue(effective(node,model,'height'),heightSchema);
    return width!==INVALID&&height!==INVALID&&width>0&&height>0?Math.max(width,height):null;
  }
  function currentImageSizeTier(node,model){
    if(!imageModelMatches(node,model))return 'custom';
    const edge=qualityLongEdge(node,model);
    return edge===1024||edge===2048?String(edge):'custom';
  }
  function copySettings(source,target,sourceModel,targetModel,kind='quality'){
    if(!source||!target||!source.mediaKind||source.mediaKind!==target.mediaKind||(source.nodeKind==='character')!==(target.nodeKind==='character'))return false;
    if(kind==='style'){target.stylePreset=typeof source.stylePreset==='string'&&source.stylePreset?source.stylePreset:'original';return true;}
    if(kind!=='quality')return false;
    const from=source.modelId||modelId(sourceModel),to=target.modelId||modelId(targetModel);
    if(!from||from!==to||modelId(sourceModel)!==from||modelId(targetModel)!==to)return false;
    const allowed=new Set(quickFieldNames(targetModel)),settings={};
    for(const name of quickFieldNames(sourceModel)){
      if(!allowed.has(name)||['width','height','ratio','aspectRatio'].includes(name))continue;
      const value=validValue(effective(source,sourceModel,name),schema(targetModel,name));
      if(value===INVALID||name==='size'&&typeof value==='string'&&/^\s*\d+\s*[x×]\s*\d+\s*$/i.test(value))continue;
      settings[name]=value;
    }
    if(allowed.has('width')&&allowed.has('height')){
      const edge=qualityLongEdge(source,sourceModel),ratio=ratioFor(target,targetModel,null);
      const size=edge&&ratio?sizeFor(edge,ratio,schema(targetModel,'width'),schema(targetModel,'height')):null;
      if(size){Object.assign(settings,size);if(isSeedream(targetModel))settings.resolution='';}
    }
    if(!Object.keys(settings).length)return false;
    writeParameters(target,settings);return true;
  }
  function resolutionLabel(value,model){
    const text=String(value??'');if(!/(?:^|\/)seedance-2\.5(?:[-/]|$)/.test(modelId(model)))return text;
    return ({'480p':'480p · 试样','720p':'720p · 常用','native1080p':'原生 1080p','1080p':'超分 1080p','2k':'超分 2K','4k':'超分 4K'})[text]||text;
  }
  const api={styles,quickFieldNames,imageAspectOptions,currentImageAspect,applyImageAspect,currentImageSizeTier,imageSizePresets,applyImageSize,copySettings,resolutionLabel};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else global.StudioCanvasControls=api;
})(typeof window!=='undefined'?window:globalThis);
