(function(root){
 'use strict';
 function createScopedStorage(storage,userId){
  if(typeof userId!=='string'||!userId.trim())throw new Error('需要有效账号才能访问工作台缓存。');
  const prefix='pangbadi-cloud:'+encodeURIComponent(userId)+':';
  const keys=()=>{const result=[];for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith(prefix))result.push(key);}return result;};
  return Object.freeze({get length(){return keys().length;},key(index){return keys()[Number(index)]?.slice(prefix.length)??null;},getItem(key){return storage.getItem(prefix+String(key));},setItem(key,value){storage.setItem(prefix+String(key),String(value));},removeItem(key){storage.removeItem(prefix+String(key));},clear(){for(const key of keys())storage.removeItem(key);}});
 }
 root.StudioCloudStorage={createScopedStorage};
 if(typeof module==='object'&&module.exports)module.exports=root.StudioCloudStorage;
})(typeof window!=='undefined'?window:globalThis);
