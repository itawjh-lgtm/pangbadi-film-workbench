(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudioPromptPresets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Style directions are editable starting points, not model guarantees.
  const presets = [
    {
      id: 'cinematic-realism', name: '电影写实', tag: '电影质感', icon: '◒',
      description: '真实材质与克制光影，让画面像一帧电影。',
      prompt: '采用写实电影画面语言，呈现可信的物体比例与空间关系；材质保留细微纹理、合理反射和自然磨损，皮肤或有机表面不过度磨皮；以柔和主光、克制的轮廓光和自然阴影塑造体积，保留高光层次；使用低饱和中性色与少量暖色重点，景深服务主体识别，不遮蔽用户指定的关键细节；保持用户描述的主体身份、数量、动作与场景信息。',
      negative: '塑料般的皮肤、过度磨皮、失真的透视、爆白高光、夸张锐化、非需求中的水印或文字',
      colors: ['#6F7778', '#B39375', '#D7D0C4']
    },
    {
      id: 'cute-3d', name: '可爱3D', tag: '柔软立体', icon: '◕',
      description: '圆润造型、柔软材质和温暖的动画光线。',
      prompt: '采用可爱三维动画表现，轮廓简洁圆润，适度概括形体，同时保留用户指定主体的辨识特征与功能结构；表面以细腻哑光、柔软织物或温润涂层呈现，避免廉价塑料反光；使用大面积柔光、轻盈接触阴影和柔和环境光；配色以奶油白、浅青绿和柔暖杏色为基调，重要部位用清晰色差区分；画面亲和、有秩序，保留用户描述的主体数量、动作及场景信息。',
      negative: '尖锐恐怖表情、杂乱高饱和配色、油腻塑料高光、无意义装饰、功能结构混淆、非需求中的水印或文字',
      colors: ['#D8E7DE', '#F1D6BC', '#F7F3E8']
    },
    {
      id: 'anime', name: '日系动画', tag: '清晰线稿', icon: '✧',
      description: '干净线条、赛璐璐色块与通透的背景。',
      prompt: '采用原创二维动画视觉，线稿干净且粗细有层次，轮廓准确，使用清晰的赛璐璐明暗分区；表面以简洁色块和少量手绘纹理表达材质，背景细节服从主体；以清透日光、柔和背光和明确投影建立空间，避免满屏光斑；使用浅蓝、暖白与低饱和珊瑚色的协调配色；保留用户描述的主体辨识特征、数量、动作与场景，不引用特定作品或角色造型。',
      negative: '线条断裂、轮廓糊化、明暗分区混乱、过量闪光特效、复制现成角色造型、非需求中的水印或文字',
      colors: ['#BCD7EB', '#F3EFE4', '#DCA6A0']
    },
    {
      id: 'clay-stop-motion', name: '黏土定格', tag: '手作微缩', icon: '●',
      description: '看得到手作纹理的温暖微缩世界。',
      prompt: '采用手工黏土定格动画的视觉，主体以有重量感的圆润块面塑造，保留用户要求的结构与辨识特征；材质可见轻微指压、细小接缝和真实哑光颗粒，背景采用手工纸板或微缩布景质感；用温暖柔和的棚拍主光和真实接触阴影表现体积；配色以陶土橙、苔藓绿和米白为主，控制颜色数量；保留主体身份、数量、动作和场景，不因风格额外增加角色。',
      negative: '光滑金属般的黏土、无重力悬浮、过量指纹、布景比例混乱、过度写实皮肤、非需求中的水印或文字',
      colors: ['#CB9274', '#A2AE8C', '#E9E0CD']
    },
    {
      id: 'watercolor', name: '水彩绘本', tag: '纸感叙事', icon: '◌',
      description: '透明水色、柔和笔触与有呼吸的留白。',
      prompt: '采用原创水彩绘本插画，保留纸张纤维、透明叠色、自然水痕与轻微颗粒，主体边缘在清晰线条与柔和晕染之间取得平衡；光线以柔和自然亮部和轻薄冷暖色影呈现，不用写实硬高光；使用雾蓝、鼠尾草绿和暖米色，留出适量呼吸空间；主体轮廓与重要动作清楚可读，保留用户指定的身份、数量、功能结构和场景信息。',
      negative: '大面积污浊混色、关键轮廓被水痕遮住、厚重油画堆叠、过锐数字边缘、非需求中的水印或文字',
      colors: ['#B2CCD5', '#A8BAA1', '#E8DCC5']
    },
    {
      id: 'ink-wash', name: '水墨国风', tag: '墨色留白', icon: '≋',
      description: '墨色浓淡、宣纸肌理与疏密有致的构图。',
      prompt: '采用水墨与淡彩结合的原创画面，运用浓淡墨层、干湿笔触和宣纸纤维表现主体的体积及材质；以留白、墨色层次和轻薄色晕表现光线与空气感，避免写实镜面高光；主色使用墨黑、纸白、淡赭与少量青绿，构图疏密有致；保留用户指定的现代或古代主体及其结构，不因风格擅自改成年代服饰或古建筑；主体身份、数量、动作与重要场景信息保持清楚。',
      negative: '主体被浓墨吞没、墨色脏灰、装饰性书法遮挡主体、擅自添加古装或亭台、非需求中的水印或文字',
      colors: ['#505B59', '#C7D0BA', '#EDE8DD']
    },
    {
      id: 'pixel-art', name: '像素游戏', tag: '整齐像素', icon: '▦',
      description: '有限色板、明确轮廓与统一像素尺度。',
      prompt: '采用精细二维像素艺术，像素网格尺度统一，以清晰阶梯轮廓和有限色阶表现造型，不使用平滑抗锯齿或混合分辨率；不同材质用有节制的像素纹理和明暗块区分；光线方向统一，高光与阴影采用少量色阶；使用深海蓝、灰青与暖沙色的有限色板，主体与背景保持可辨色差；保留用户描述的主体身份、数量、动作与场景，可在像素尺度内概括细节但不更换主体。',
      negative: '混合像素尺度、模糊抗锯齿、写实照片贴图、无规律像素噪点、主体与背景粘连、非需求中的水印或文字',
      colors: ['#4B6376', '#91B6AC', '#DBBF87']
    },
    {
      id: 'flat-explainer', name: '扁平科普', tag: '清楚易懂', icon: '◇',
      description: '简洁形状与清晰层级，适合表达科普内容。',
      prompt: '采用现代扁平科普插画，使用简洁几何形与统一线宽，保留讲解所需的真实结构和对象关系；材质主要以纯净色块表达，只用少量柔和明暗分层，不堆叠复杂纹理；光线简明一致，空间前后关系清楚；使用青绿、暖白、石墨灰与少量橙色强调，重要对象靠色差和留白区分；保留用户指定主体、数量与动作，图例、文字或箭头仅在用户明确要求时加入。',
      negative: '视觉层级混乱、复杂写实纹理、过量渐变、结构比例误导、无依据标注、非需求中的水印或文字',
      colors: ['#78A398', '#EDEDE3', '#D3A06C']
    },
    {
      id: 'future-sci-fi', name: '未来科幻', tag: '精密空间', icon: '⌘',
      description: '精密材质、克制的发光细节与未来空间感。',
      prompt: '采用具有可信物理结构的原创未来科幻视觉，以精密造型和有秩序的空间层次表现科技感；材质使用细磨金属、磨砂复合材料与透明玻璃，接缝、反射和透射符合物体结构；以柔和冷光和局部暖光形成重点，发光细节克制，不让霓虹淹没主体；配色以石墨灰、银白和灰蓝为基调；保留用户指定主体身份、数量、用途和动作，不擅自增加武器、机械肢体或全息界面。',
      negative: '满屏霓虹、任意堆叠机械零件、悬浮结构不合理、玻璃反射混乱、过多光污染、非需求中的水印或文字',
      colors: ['#526471', '#B5C6CF', '#DBDCD6']
    },
    {
      id: 'clear-photography', name: '清透摄影', tag: '自然光感', icon: '☼',
      description: '通透自然光、干净背景和真实的细节。',
      prompt: '采用清透自然的真实摄影视觉，构图简洁，主体比例、透视与空间尺度可信；材质保留自然纹理、柔和反射和细微色彩变化，避免过度磨皮或塑料化；以窗边漫射日光或柔和户外自然光表现明亮层次，白色区域保留细节，阴影通透；配色以暖白、浅灰、浅青与主体本色为主，背景简洁但保留用户指定的场景内容；保持主体身份、数量和动作不变，景深适度。',
      negative: '过曝丢失细节、过度美颜、重度色偏、夸张滤镜、背景虚化吞没关键内容、非需求中的水印或文字',
      colors: ['#E6E7E1', '#CCDCD5', '#B8C2C2']
    }
  ].map(function (preset) {
    Object.freeze(preset.colors);
    return Object.freeze(preset);
  });
  Object.freeze(presets);

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function getPreset(id) {
    return presets.find(function (preset) { return preset.id === text(id); }) || null;
  }

  function compose(input) {
    const source = input && typeof input === 'object' ? input : {};
    const subject = text(source.subject);
    const style = text(source.stylePrompt);
    const ratio = text(source.ratio);
    const motion = text(source.motion);
    const parts = [];
    if (subject) parts.push(subject);
    if (style) parts.push('视觉风格：' + style);
    if (ratio) parts.push('画幅意图：' + ratio + '（最终尺寸以生成参数为准）');
    if (text(source.kind) === 'video' && motion) parts.push('动态与镜头：' + motion);
    return { positive: parts.join('\n\n'), negative: text(source.negative) };
  }

  return Object.freeze({ presets: presets, getPreset: getPreset, compose: compose });
});
