/* Viewing an image never navigates to its file or starts a generation task. */
(function(global){
  'use strict';
  function imageURL(value,base){
    try{
      const url=new URL(String(value||''),base);
      if(!value||url.username||url.password)return '';
      return url.protocol==='https:'||(url.origin===new URL(base).origin&&/^https?:$/.test(url.protocol))?url.href:'';
    }catch{return '';}
  }
  function fitScale(width,height,viewportWidth,viewportHeight){return Math.min(1,Math.max(1,viewportWidth-48)/width,Math.max(1,viewportHeight-48)/height);}
  function boundPan(value,imageSize,viewportSize,scale){const edge=Math.max(0,(imageSize*scale-viewportSize)/2);return Math.max(-edge,Math.min(edge,value));}
  function mount(doc){
    let dialog,stage,picture,title,status,zoomLabel,download,returnFocus,source='',ready=false,skipCloseEvents=0;
    let scale=1,fit=1,x=0,y=0,drag=null;
    function paint(){
      x=boundPan(x,picture.naturalWidth,stage.clientWidth,scale);y=boundPan(y,picture.naturalHeight,stage.clientHeight,scale);
      picture.style.transform='translate(-50%, -50%) translate('+x+'px, '+y+'px) scale('+scale+')';
      zoomLabel.textContent=ready?Math.round(scale*100)+'%':'—';stage.classList.toggle('can-pan',ready&&(picture.naturalWidth*scale>stage.clientWidth||picture.naturalHeight*scale>stage.clientHeight));
      for(const button of dialog.querySelectorAll('[data-image-zoom]'))button.disabled=!ready;
    }
    function resize(){if(!ready)return;const wasFit=Math.abs(scale-fit)<.001;fit=fitScale(picture.naturalWidth,picture.naturalHeight,stage.clientWidth,stage.clientHeight);if(wasFit){scale=fit;x=y=0;}paint();}
    function zoom(next,point){
      if(!ready)return;const previous=scale;scale=Math.max(Math.min(fit,.1),Math.min(8,next));
      if(point){x=point.x-(point.x-x)*scale/previous;y=point.y-(point.y-y)*scale/previous;}else{x*=scale/previous;y*=scale/previous;}
      paint();
    }
    function action(name){if(name==='fit'){scale=fit;x=y=0;paint();}else if(name==='actual'){scale=1;x=y=0;paint();}else zoom(scale*(name==='in'?1.25:.8));}
    function close(){if(dialog?.open)dialog.close();}
    function load(){
      ready=false;picture.hidden=true;status.hidden=false;status.textContent='正在加载原图…';dialog.querySelector('[data-image-retry]').hidden=true;paint();picture.src=source;
    }
    function create(){
      if(dialog)return;
      dialog=doc.createElement('dialog');dialog.className='studio-image-viewer';dialog.setAttribute('aria-labelledby','image-viewer-title');dialog.setAttribute('aria-describedby','image-viewer-help');
      dialog.innerHTML='<header class="image-viewer-header"><div><small>图片预览</small><h2 id="image-viewer-title"></h2></div><button type="button" data-image-close aria-label="关闭大图" autofocus>关闭 ×</button></header><div class="image-viewer-stage"><img class="image-viewer-picture" alt="" draggable="false" referrerpolicy="no-referrer" hidden><div class="image-viewer-message"><p role="status"></p><button type="button" data-image-retry hidden>重新加载</button></div></div><footer class="image-viewer-footer"><span id="image-viewer-help">滚轮缩放 · 放大后拖动查看 · Esc 关闭</span><div class="image-viewer-tools"><button type="button" data-image-zoom="out" aria-label="缩小图片">−</button><output aria-label="缩放比例"></output><button type="button" data-image-zoom="in" aria-label="放大图片">＋</button><button type="button" data-image-zoom="fit">适应窗口</button><button type="button" data-image-zoom="actual">原始尺寸</button></div><a class="image-viewer-download" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" download>下载原图 ↓</a></footer>';
      doc.body.append(dialog);stage=dialog.querySelector('.image-viewer-stage');picture=stage.querySelector('img');title=dialog.querySelector('h2');status=stage.querySelector('[role="status"]');zoomLabel=dialog.querySelector('output');download=dialog.querySelector('a');
      picture.addEventListener('load',()=>{
        ready=true;picture.hidden=false;picture.style.width=picture.naturalWidth+'px';picture.style.height=picture.naturalHeight+'px';status.hidden=true;dialog.querySelector('[data-image-retry]').hidden=true;
        fit=fitScale(picture.naturalWidth,picture.naturalHeight,stage.clientWidth,stage.clientHeight);scale=fit;x=y=0;paint();
      });
      picture.addEventListener('error',()=>{ready=false;picture.hidden=true;status.hidden=false;status.textContent='原图暂时无法加载，请重试。若链接已过期，请回到项目检查这份素材。';dialog.querySelector('[data-image-retry]').hidden=false;paint();});
      dialog.addEventListener('click',event=>{if(event.target.closest('[data-image-close]')||event.target===dialog)close();const control=event.target.closest('[data-image-zoom]');if(control)action(control.dataset.imageZoom);if(event.target.closest('[data-image-retry]'))load();});
      dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
      dialog.addEventListener('close',()=>{if(skipCloseEvents){skipCloseEvents--;return;}drag=null;stage.classList.remove('is-dragging');picture.removeAttribute('src');ready=false;if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
      stage.addEventListener('wheel',event=>{event.preventDefault();const box=stage.getBoundingClientRect();zoom(scale*Math.exp(-event.deltaY*.002),{x:event.clientX-box.left-box.width/2,y:event.clientY-box.top-box.height/2});},{passive:false});
      stage.addEventListener('dblclick',event=>{event.preventDefault();action(Math.abs(scale-fit)<.001?'actual':'fit');});
      stage.addEventListener('pointerdown',event=>{if(event.button!==0||!ready||event.target!==picture)return;drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,x,y};stage.setPointerCapture(event.pointerId);stage.classList.add('is-dragging');event.preventDefault();});
      stage.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;x=drag.x+event.clientX-drag.startX;y=drag.y+event.clientY-drag.startY;paint();});
      const end=event=>{if(!drag||event.pointerId!==drag.id)return;drag=null;stage.classList.remove('is-dragging');if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);};
      stage.addEventListener('pointerup',end);stage.addEventListener('pointercancel',end);global.addEventListener('resize',resize);
    }
    function open(trigger){
      const url=imageURL(trigger.dataset.imagePreview,doc.baseURI);if(!url)return;
      create();returnFocus=trigger;source=url;title.textContent=trigger.dataset.imageTitle||trigger.getAttribute('alt')||'图片预览';picture.alt=title.textContent;
      download.href=imageURL(trigger.dataset.imageDownload,doc.baseURI)||source;
      if(!dialog.open)dialog.showModal();load();
    }
    doc.addEventListener('click',event=>{const trigger=event.target.closest?.('[data-image-preview]');if(!trigger)return;event.preventDefault();event.stopPropagation();open(trigger);},true);
    doc.addEventListener('keydown',event=>{
      if(dialog?.open){
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
        if(['+','=','-','0','1'].includes(event.key)&&!event.metaKey&&!event.ctrlKey&&!event.altKey){event.preventDefault();event.stopPropagation();if(ready)action(event.key==='0'?'fit':event.key==='1'?'actual':event.key==='-'?'out':'in');}
        return;
      }
      const trigger=event.target.closest?.('[data-image-preview][role="button"]');
      if(trigger&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();open(trigger);}
    },true);
    // A rerender can reopen an underlying editor dialog. Keep its image preview on top.
    function restoreModal(){
      if(!dialog?.open)return;
      const box=dialog.querySelector('[data-image-close]').getBoundingClientRect();
      if(dialog.contains(doc.elementFromPoint(box.left+box.width/2,box.top+box.height/2)))return;
      const focus=doc.activeElement;skipCloseEvents++;dialog.close();dialog.showModal();
      if(dialog.contains(focus))focus.focus({preventScroll:true});
    }
    return {close,restoreModal};
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={imageURL,fitScale,boundPan};
  else global.StudioImageViewer=mount(global.document);
})(typeof window!=='undefined'?window:globalThis);
