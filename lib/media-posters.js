/* Sample home video covers with a separate decoder; never seek the user's player. */
(function (global) {
  'use strict';
  const selector='video[data-home-video-poster]';
  function safeVideoURL(value) {
    if(typeof value!=='string'||!/^https:\/\/[^\s"'<>@\\\u0000-\u001f\u007f]+$/.test(value))return '';
    try{const url=new URL(value);return url.protocol==='https:'&&url.hostname&&!url.username&&!url.password?value:'';}catch{return '';}
  }
  function sampleTimes(duration,count=8) {
    if(!Number.isFinite(duration)||duration<=0)return [];
    const size=Math.max(1,Math.min(12,Math.floor(count)||8));
    return Array.from({length:size},(_,index)=>duration*(size===1?.475:.10+.75*index/(size-1)));
  }
  function scoreFrame(data,width,height) {
    const pixels=data?.data||data,count=width*height;
    if(!pixels||!Number.isInteger(width)||!Number.isInteger(height)||width<3||height<3||pixels.length<count*4)return {score:-Infinity};
    const light=new Float32Array(count);let sum=0,squared=0,dark=0,clipped=0,detail=0;
    for(let i=0;i<count;i++){
      const offset=i*4,y=.2126*pixels[offset]+.7152*pixels[offset+1]+.0722*pixels[offset+2];
      light[i]=y;sum+=y;squared+=y*y;if(y<30)dark++;if(y>245)clipped++;
    }
    const brightness=sum/count,contrast=Math.sqrt(Math.max(0,squared/count-brightness*brightness));
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
      const i=y*width+x;detail+=Math.abs(light[i]*4-light[i-1]-light[i+1]-light[i-width]-light[i+width]);
    }
    const sharpness=detail/((width-2)*(height-2)),darkRatio=dark/count,clippedRatio=clipped/count;
    // Reward visible detail and readable midtones; black/fade/white frames lose decisively.
    const exposure=Math.max(0,1-Math.abs(brightness-132)/132);
    const score=exposure*42+Math.min(contrast/60,1)*21+Math.min(sharpness/48,1)*28-darkRatio*70-clippedRatio*60;
    return {score,brightness,contrast,sharpness,darkRatio,clippedRatio};
  }
  const abortError=()=>Object.assign(new Error('Poster sampling no longer visible'),{name:'AbortError'});
  function waitFor(target,event,{setTimeout,clearTimeout,timeoutMs,signal},ready=()=>false) {
    if(signal?.aborted)return Promise.reject(abortError());
    if(ready())return Promise.resolve();
    return new Promise((resolve,reject)=>{
      let timer;
      const finish=error=>{clearTimeout(timer);target.removeEventListener(event,done);target.removeEventListener('error',failed);signal?.removeEventListener('abort',aborted);error?reject(error):resolve();};
      const done=()=>finish(),failed=()=>finish(new Error('Video frame unavailable')),aborted=()=>finish(abortError());
      target.addEventListener(event,done,{once:true});target.addEventListener('error',failed,{once:true});signal?.addEventListener('abort',aborted,{once:true});
      timer=setTimeout(()=>finish(new Error('Video poster sampling timed out')),timeoutMs);
    });
  }
  async function extractPoster(src,options) {
    const {document,isRelevant=()=>true,signal}=options,video=document.createElement('video'),sample=document.createElement('canvas'),output=document.createElement('canvas');
    const check=()=>{if(signal?.aborted||!isRelevant())throw abortError();};
    let result=null;
    video.crossOrigin='anonymous';video.preload='auto';video.muted=true;video.playsInline=true;
    sample.width=160;sample.height=90;
    try{
      check();const loaded=waitFor(video,'loadedmetadata',options,()=>video.readyState>=1);video.src=src;video.load();await loaded;
      const times=sampleTimes(video.duration);if(!times.length||!video.videoWidth||!video.videoHeight)return null;
      const context=sample.getContext('2d',{willReadFrequently:true}),out=output.getContext('2d');if(!context||!out)return null;
      const scale=Math.min(1,1280/video.videoWidth);output.width=Math.max(1,Math.round(video.videoWidth*scale));output.height=Math.max(1,Math.round(video.videoHeight*scale));
      let best=-Infinity;
      for(const at of times){
        check();const sought=waitFor(video,'seeked',options);video.currentTime=at;await sought;
        await waitFor(video,'loadeddata',options,()=>video.readyState>=2);check();
        context.drawImage(video,0,0,sample.width,sample.height);
        const metrics=scoreFrame(context.getImageData(0,0,sample.width,sample.height),sample.width,sample.height);
        if(metrics.score>best){
          best=metrics.score;out.drawImage(video,0,0,output.width,output.height);
          result={url:output.toDataURL('image/jpeg',.84),width:output.width,height:output.height,at,metrics};
        }
      }
      return result;
    }finally{
      video.pause();video.removeAttribute('src');video.load();sample.width=sample.height=0;output.width=output.height=0;
    }
  }
  function create(deps={}) {
    const document=deps.document||global.document,view=document?.defaultView||global;
    const setTimer=deps.setTimeout||global.setTimeout.bind(global),clearTimer=deps.clearTimeout||global.clearTimeout.bind(global);
    const extract=deps.extractPoster||extractPoster,Observer=deps.IntersectionObserver===null?null:(deps.IntersectionObserver||view.IntersectionObserver);
    const maxEntries=deps.maxEntries??8,maxBytes=deps.maxBytes??5*1024*1024,timeoutMs=deps.timeoutMs??25000;
    const states=new Map(),jobs=new Map(),queue=[],cache=new Map(),idleWaiters=[];
    let active=null,disposed=false,cacheBytes=0;
    const pageVisible=()=>document?.visibilityState!=='hidden';
    const connected=state=>state.video.isConnected!==false&&states.get(state.video)===state;
    const relevant=state=>connected(state)&&state.visible&&pageVisible();
    const idle=()=>{if(!active&&!queue.length)while(idleWaiters.length)idleWaiters.shift()();};
    function cacheGet(key){const value=cache.get(key);if(value){cache.delete(key);cache.set(key,value);}return value;}
    function cachePut(key,value){
      const bytes=value.url.length*2;if(bytes>maxBytes||maxEntries<1)return;
      if(cache.has(key))cacheBytes-=cache.get(key).url.length*2;cache.delete(key);cache.set(key,value);cacheBytes+=bytes;
      while(cache.size>maxEntries||cacheBytes>maxBytes){const oldest=cache.keys().next().value;cacheBytes-=cache.get(oldest).url.length*2;cache.delete(oldest);}
    }
    const canCover=video=>video.ended||(video.paused!==false&&!(Number(video.currentTime)>0));
    function showCover(state){if(state.button)state.button.hidden=!state.poster||!canCover(state.video);}
    function apply(state,poster){
      if(!connected(state))return;
      state.poster=poster;state.video.poster=poster.url;
      if(state.image)state.image.src=poster.url;showCover(state);
    }
    function bindOverlay(state){
      const stage=state.video.closest?.('.media-poster-stage'),button=stage?.querySelector('[data-media-poster-play]'),image=button?.querySelector('[data-media-poster-image]');
      if(state.button!==button){state.button?.removeEventListener('click',state.click);state.button=button;button?.addEventListener('click',state.click);}
      state.image=image;
      if(state.poster)apply(state,state.poster);
    }
    function detach(state){
      observer?.unobserve(state.video);state.button?.removeEventListener('click',state.click);
      state.video.removeEventListener('playing',state.playing);state.video.removeEventListener('ended',state.ended);states.delete(state.video);
    }
    function inViewport(video){
      if(!video.getBoundingClientRect)return true;
      const rect=video.getBoundingClientRect(),height=view.innerHeight||document?.documentElement?.clientHeight||0,width=view.innerWidth||document?.documentElement?.clientWidth||0;
      return rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<height&&rect.left<width;
    }
    function enqueue(state){
      if(disposed||!relevant(state)||state.attempted)return;
      const cached=cacheGet(state.key);if(cached){apply(state,cached);return;}
      let job=jobs.get(state.key);
      if(!job){job={key:state.key,src:state.src,states:new Set(),cancelled:false};jobs.set(job.key,job);queue.push(job);}
      job.states.add(state);pump();
    }
    const jobRelevant=job=>!disposed&&!job.cancelled&&[...job.states].some(state=>state.key===job.key&&relevant(state));
    function cancelInvisible(){if(active&&!jobRelevant(active))active.controller?.abort();}
    function pump(){
      if(disposed||active)return idle();
      let job;while(queue.length){const candidate=queue.shift();if(jobRelevant(candidate)){job=candidate;break;}if(jobs.get(candidate.key)===candidate)jobs.delete(candidate.key);}
      if(!job)return idle();active=job;
      const Controller=deps.AbortController||global.AbortController;job.controller=Controller?new Controller():null;
      const deadline=setTimer(()=>job.controller?.abort(),timeoutMs);
      Promise.resolve().then(()=>extract(job.src,{document,setTimeout:setTimer,clearTimeout:clearTimer,timeoutMs,signal:job.controller?.signal,isRelevant:()=>jobRelevant(job)})).then(poster=>{
        if(job.cancelled||disposed)return;
        const valid=poster&&typeof poster.url==='string'&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(poster.url);
        if(valid)cachePut(job.key,poster);
        for(const state of job.states)if(state.key===job.key){state.attempted=true;if(valid)apply(state,poster);}
      }).catch(error=>{
        if(error?.name!=='AbortError')for(const state of job.states)if(state.key===job.key)state.attempted=true;
      }).finally(()=>{clearTimer(deadline);if(jobs.get(job.key)===job)jobs.delete(job.key);active=null;pump();});
    }
    const observer=Observer?new Observer(entries=>{
      for(const entry of entries){const state=states.get(entry.target);if(!state)continue;state.visible=entry.isIntersecting&&entry.intersectionRatio!==0;if(state.visible)enqueue(state);}
      cancelInvisible();
    },{threshold:0.01}):null;
    function refreshVisibility(){
      for(const state of states.values()){if(!connected(state)){detach(state);continue;}if(!observer)state.visible=inViewport(state.video);if(relevant(state))enqueue(state);}
      cancelInvisible();pump();
    }
    function hydrate(root){
      if(disposed||!root)return;
      for(const state of states.values())if(!connected(state))detach(state);
      const videos=[...(root.matches?.(selector)?[root]:[]),...(root.querySelectorAll?.(selector)||[])];
      for(const video of videos){
        const src=safeVideoURL(video.getAttribute('src')),key=(video.getAttribute('data-media-preview-key')||'')+'\n'+src;
        let state=states.get(video);
        if(!src){if(state)detach(state);continue;}
        if(!state){
          state={video,src,key,visible:!observer&&inViewport(video),attempted:false,poster:null};
          state.click=event=>{event.preventDefault();event.stopPropagation();if(state.button)state.button.hidden=true;try{const playback=video.play();playback?.catch?.(()=>showCover(state));}catch{showCover(state);}};
          state.playing=()=>{if(state.button)state.button.hidden=true;};state.ended=()=>showCover(state);
          video.addEventListener('playing',state.playing);video.addEventListener('ended',state.ended);states.set(video,state);observer?.observe(video);
        }else if(state.key!==key){state.src=src;state.key=key;state.attempted=false;state.poster=null;video.removeAttribute('poster');if(state.button)state.button.hidden=true;}
        bindOverlay(state);const cached=cacheGet(key);if(cached)apply(state,cached);else enqueue(state);
      }
      cancelInvisible();pump();
    }
    function invalidate(value){
      const matches=(key,src)=>value===undefined||value===key||value===src;
      for(const [key,poster] of cache)if(matches(key,key.slice(key.indexOf('\n')+1))){cacheBytes-=poster.url.length*2;cache.delete(key);}
      for(const job of jobs.values())if(matches(job.key,job.src)){job.cancelled=true;job.controller?.abort();jobs.delete(job.key);}
      for(const state of states.values())if(matches(state.key,state.src)){state.attempted=false;state.poster=null;state.video.removeAttribute('poster');if(state.button)state.button.hidden=true;}
    }
    function dispose(){
      disposed=true;active?.controller?.abort();for(const state of states.values())detach(state);observer?.disconnect();queue.length=0;jobs.clear();cache.clear();cacheBytes=0;
      document?.removeEventListener?.('visibilitychange',refreshVisibility);view.removeEventListener?.('scroll',refreshVisibility,true);view.removeEventListener?.('resize',refreshVisibility);idle();
    }
    document?.addEventListener?.('visibilitychange',refreshVisibility);if(!observer){view.addEventListener?.('scroll',refreshVisibility,true);view.addEventListener?.('resize',refreshVisibility);}
    return {hydrate,invalidate,dispose,whenIdle:()=>!active&&!queue.length?Promise.resolve():new Promise(resolve=>idleWaiters.push(resolve))};
  }
  let singleton;
  const api={create,safeVideoURL,sampleTimes,scoreFrame,extractPoster,hydrate:root=>(singleton||(singleton=create({document:root?.ownerDocument||global.document}))).hydrate(root),invalidate:value=>singleton?.invalidate(value),dispose:()=>{singleton?.dispose();singleton=null;}};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else global.StudioMediaPosters=api;
})(typeof window!=='undefined'?window:globalThis);
