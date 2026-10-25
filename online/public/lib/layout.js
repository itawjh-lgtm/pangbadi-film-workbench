/* Layout preferences are independent of project records and task progress. */
(function (host) {
  'use strict';
  const KEY='creative-workbench-layout-v1';
  const definitions=[
    {key:'review',selector:'.project-review-layout:not(.is-canvas):not(.is-character-assets):not(.is-discussion-collapsed)',label:'作品与讨论区宽度',min:340,right:310},
    {key:'workstation',selector:'.collaboration-layout',label:'工作便笺与档案宽度',min:330,right:260,maxRight:440},
    {key:'overview',selector:'.overview-work-grid',label:'项目与待拍板区宽度',min:340,right:290},
    {key:'team',selector:'.team-directory',label:'伙伴列表与成员档案宽度',min:360,right:260,maxRight:480},
    {key:'connections',selector:'.connections-layout',label:'连接列表与能力说明宽度',min:330,right:260,maxRight:520}
  ];
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  function cleanPreferences(value) {
    const clean={};
    if(!value||typeof value!=='object'||Array.isArray(value))return clean;
    if(Number.isFinite(value.sidebar))clean.sidebar=clamp(value.sidebar,200,360);
    if(typeof value.discussionCollapsed==='boolean')clean.discussionCollapsed=value.discussionCollapsed;
    for(const {key} of definitions)if(Number.isFinite(value[key]))clean[key]=clamp(value[key],.05,.95);
    return clean;
  }
  function bounds(width,gap,min,right,maxRight=Infinity) {
    const available=Math.max(0,width-gap);
    min=Math.max(min,available-maxRight);
    return {available,min,max:Math.max(min,available-right),fits:available>=min+right};
  }
  function create(root) {
    const doc=root.ownerDocument,win=doc.defaultView;
    let prefs={};
    try{prefs=cleanPreferences(JSON.parse(window.StudioCloud.localStorage.getItem(KEY)));}catch{}
    let sections=[],drag=null,frame=0;
    const observedWidths=new WeakMap();
    const observer=win.ResizeObserver?new win.ResizeObserver(entries=>{
      for(const entry of entries){
        const width=entry.contentRect.width;
        if(observedWidths.get(entry.target)!==width){observedWidths.set(entry.target,width);schedule();}
      }
    }):null;
    function save(){try{window.StudioCloud.localStorage.setItem(KEY,JSON.stringify(prefs));}catch{}}
    function schedule(){if(!frame)frame=win.requestAnimationFrame(()=>{frame=0;sections.forEach(apply);});}
    function measure(section) {
      const {el,sidebar}=section,style=win.getComputedStyle(el);
      const paddingLeft=parseFloat(style.paddingLeft)||0,paddingRight=parseFloat(style.paddingRight)||0;
      const width=el.clientWidth-paddingLeft-paddingRight;
      const gap=sidebar?0:parseFloat(style.columnGap)||0;
      const limits=sidebar?{available:width,min:200,max:Math.max(200,Math.min(360,width-500)),fits:win.innerWidth>760}:bounds(width,gap,section.min,section.right,section.maxRight);
      return {...limits,gap,paddingLeft,enabled:sidebar?limits.fits:win.innerWidth>980&&limits.fits};
    }
    function apply(section) {
      const {el,handle,sidebar,key}=section,metrics=measure(section);
      section.metrics=metrics;
      handle.hidden=!metrics.enabled;
      if(!metrics.enabled){
        el.classList.remove(sidebar?'layout-sidebar-enabled':'layout-split-active');
        if(!sidebar)el.classList.add('layout-stacked');
        return;
      }
      el.classList.remove('layout-stacked');
      let desired=prefs[key];
      if(desired===undefined){
        el.classList.remove(sidebar?'layout-sidebar-enabled':'layout-split-active');
        desired=sidebar?parseFloat(win.getComputedStyle(root).getPropertyValue('--sidebar-width')):parseFloat(win.getComputedStyle(el).gridTemplateColumns);
      }else if(!sidebar)desired*=metrics.available;
      const width=clamp(Number.isFinite(desired)?desired:metrics.min,metrics.min,metrics.max);
      section.width=width;
      el.style.setProperty(sidebar?'--layout-sidebar-width':'--layout-first',width+'px');
      el.classList.add(sidebar?'layout-sidebar-enabled':'layout-split-active');
      handle.style.left=(metrics.paddingLeft+width+metrics.gap/2)+'px';
      handle.setAttribute('aria-valuemin',String(Math.round(metrics.min)));
      handle.setAttribute('aria-valuemax',String(Math.round(metrics.max)));
      handle.setAttribute('aria-valuenow',String(Math.round(width)));
      handle.setAttribute('aria-valuetext',sidebar?'侧栏 '+Math.round(width)+' 像素':'左区 '+Math.round(width)+' 像素，右区 '+Math.round(metrics.available-width)+' 像素');
    }
    function change(section,width,persist) {
      const metrics=measure(section);
      if(!metrics.enabled)return;
      const next=clamp(width,metrics.min,metrics.max);
      prefs[section.key]=section.sidebar?next:next/metrics.available;
      apply(section);
      if(section.sidebar)sections.filter(item=>!item.sidebar).forEach(apply);
      if(persist)save();
    }
    function reset(section){delete prefs[section.key];apply(section);if(section.sidebar)sections.filter(item=>!item.sidebar).forEach(apply);save();}
    function finish(cancel=false) {
      if(!drag)return;
      const current=drag;drag=null;
      if(cancel){
        if(current.previous===undefined)delete prefs[current.section.key];else prefs[current.section.key]=current.previous;
        sections.forEach(apply);
      }else save();
      current.section.handle.classList.remove('is-dragging');
      root.classList.remove('layout-is-resizing');
      if(current.section.handle.hasPointerCapture(current.id))current.section.handle.releasePointerCapture(current.id);
    }
    function add(el,config) {
      const section={...config,el},handle=doc.createElement('div');
      section.handle=handle;
      handle.id='layout-separator-'+config.key;
      handle.className='layout-separator'+(config.sidebar?' layout-sidebar-separator':'');
      handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');
      handle.setAttribute('aria-label',config.label);handle.tabIndex=0;
      handle.title='拖动调整宽度 · 双击恢复默认 · 方向键微调';
      const controlled=config.sidebar?el.querySelector('.studio-sidebar'):el.firstElementChild;
      if(controlled){if(!controlled.id)controlled.id='layout-panel-'+config.key;handle.setAttribute('aria-controls',controlled.id);}
      if(!config.sidebar)el.classList.add('layout-split');
      el.append(handle);sections.push(section);apply(section);observer?.observe(el);
      handle.addEventListener('pointerdown',event=>{
        if(event.button!==0||!section.metrics.enabled)return;
        event.preventDefault();handle.focus({preventScroll:true});
        drag={section,id:event.pointerId,start:event.clientX,width:section.width,previous:prefs[section.key]};
        handle.setPointerCapture(event.pointerId);handle.classList.add('is-dragging');root.classList.add('layout-is-resizing');
      });
      handle.addEventListener('pointermove',event=>{if(drag?.section===section&&drag.id===event.pointerId)change(section,drag.width+event.clientX-drag.start,false);});
      handle.addEventListener('pointerup',event=>{if(drag?.id===event.pointerId)finish();});
      handle.addEventListener('pointercancel',event=>{if(drag?.id===event.pointerId)finish(true);});
      handle.addEventListener('lostpointercapture',()=>{if(drag?.section===section)finish(true);});
      handle.addEventListener('dblclick',()=>reset(section));
      handle.addEventListener('keydown',event=>{
        if(!section.metrics.enabled)return;
        const step=event.shiftKey?40:10;
        const actions={ArrowLeft:()=>change(section,section.width-step,true),ArrowRight:()=>change(section,section.width+step,true),Home:()=>change(section,section.metrics.min,true),End:()=>change(section,section.metrics.max,true),Enter:()=>reset(section),Escape:()=>finish(true)};
        if(actions[event.key]){event.preventDefault();actions[event.key]();}
      });
    }
    function refresh() {
      finish(true);observer?.disconnect();
      sections.forEach(({handle})=>handle.remove());sections=[];
      add(root,{key:'sidebar',sidebar:true,label:'导航侧栏宽度'});
      for(const config of definitions){const el=root.querySelector(config.selector);if(el)add(el,config);}
    }
    win.addEventListener('resize',schedule);
    win.addEventListener('blur',()=>finish(true));
    return {refresh,isDiscussionCollapsed:()=>prefs.discussionCollapsed===true,setDiscussionCollapsed(value){prefs.discussionCollapsed=value===true;save();return prefs.discussionCollapsed;}};
  }
  const api={create,cleanPreferences,bounds};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else host.StudioLayout=api;
})(typeof window!=='undefined'?window:globalThis);
