(function(){
 'use strict';
 const login='/signin-with-chatgpt?return_to=%2Fworkbench.html';
 const boot=document.getElementById('cloud-boot');
 function loadScript(src){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(new Error('工作台文件加载失败，请重新打开。'));document.head.append(script);});}
 async function start(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  let session;
  try{
   const response=await fetch('/api/cloud/session',{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal});
   if(response.status===401){window.location.replace(login);return;}
   if(!response.ok)throw new Error('工作室暂时无法连接，请稍后重试。');
   session=await response.json();
   if(!session.user?.id||!session.csrfToken||session.mode!=='cloud')throw new Error('账号验证未完成，请重新登录。');
  }finally{clearTimeout(timer);}
  await loadScript('cloud/storage.js');
  const cloud={user:session.user,configured:session.configured||{},csrfToken:session.csrfToken,textProvider:session.textProvider||'deepseek',textModel:session.textModel||'deepseek-chat',billing:'visitor',
   localStorage:window.StudioCloudStorage.createScopedStorage(window.localStorage,session.user.id),sessionStorage:window.StudioCloudStorage.createScopedStorage(window.sessionStorage,session.user.id),
   expire(){document.getElementById('creative-workbench-v2').hidden=true;window.location.replace(login);}};
  window.StudioCloud=cloud;
  await loadScript('cloud/settings.js');
  const response=await fetch('cloud/scripts.json',{cache:'no-store'});if(!response.ok)throw new Error('工作台文件清单加载失败。');
  const scripts=await response.json();
  if(!Array.isArray(scripts)||scripts.some(src=>typeof src!=='string'||!/^(?:lib\/|data\/|app\.js)/.test(src)))throw new Error('工作台文件清单无效。');
  for(const src of scripts)await loadScript(src);
  document.getElementById('creative-workbench-v2').hidden=false;
  boot.remove();
  window.StudioCloudUI.mountAccount();
 }
 start().catch(error=>{boot.setAttribute('role','alert');boot.replaceChildren();const card=document.createElement('div'),title=document.createElement('h1'),copy=document.createElement('p'),retry=document.createElement('button'),loginLink=document.createElement('a');title.textContent='暂时无法打开工作室';copy.textContent=error.name==='AbortError'?'连接超时，请重试。':error.message;retry.textContent='重新连接';retry.onclick=()=>window.location.reload();loginLink.href=login;loginLink.textContent='重新登录';card.append(title,copy,retry,loginLink);boot.append(card);});
})();
