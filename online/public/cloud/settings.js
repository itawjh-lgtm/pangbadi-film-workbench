(function(global){
 'use strict';
 const cloud=global.StudioCloud;
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const defaults={deepseek:'deepseek-chat',qwen:'qwen-plus',openai:'gpt-4.1-mini'};
 let dialog=null,busy=false;
 async function requestSettings(body){
  const response=await fetch('/api/cloud/settings',{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','X-Studio-Token':cloud.csrfToken})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(response.status===401){cloud.expire();throw new Error('请重新登录。');}
  const result=await response.json();if(!response.ok)throw new Error(result.error||'模型配置暂时无法保存。');
  // Only these non-secret fields are retained in memory. Responses are never persisted.
  if(result.configured)cloud.configured=result.configured;
  if(result.textProvider)cloud.textProvider=result.textProvider;
  if(result.textModel)cloud.textModel=result.textModel;
  return result;
 }
 function settingsHTML(runtime){
  const configured=cloud.configured||{},online=runtime?.connection?.state==='online';
  return '<section class="runtime-connection surface cloud-connection"><div class="section-head"><div><h2>我的模型连接</h2><p class="muted">在线工作室 · 使用你自己的 API</p></div><span class="badge '+(online?'badge-success':'badge-demo')+'">'+(online?'服务已连接':'连接中')+'</span></div><div class="runtime-capabilities"><div><strong>文字创作</strong><span>'+esc(configured.text?cloud.textProvider+' · '+cloud.textModel:'待填写文字模型 API Key')+'</span></div><div><strong>图像与视频</strong><span>'+esc(configured.runninghubModels?'RunningHub 模型密钥已保存':'待填写 RunningHub 模型 API Key')+'</span></div><div><strong>费用结算</strong><span>使用你自己的模型账号</span></div><div><strong>当前账号</strong><span>'+esc(cloud.user.name||cloud.user.email||'已登录')+'</span></div></div><div class="detail-actions"><button type="button" class="button-primary" data-cloud-action="settings">配置我的模型</button><button type="button" class="button-secondary" data-action="runtime-connect">刷新连接状态</button></div><p class="context-note">文稿由你选择的文字模型执行，图片与视频通过 RunningHub 生成。调用费用由对应服务商向你的账号结算。密钥加密保存在你的账号下，不写入浏览器缓存。已保存密钥不代表已经通过实际生成验证。</p></section>';
 }
 function keyField(name,label,configured,flag){return '<label class="field-label">'+label+'<input class="field" type="password" name="'+name+'" autocomplete="new-password" maxlength="1000" placeholder="'+(configured?'已保存 · 留空保留':'粘贴你的 API Key')+'"></label>'+(configured?'<label class="check-item"><input type="checkbox" name="'+flag+'">移除此密钥</label>':'');}
 function formHTML(){
  const configured=cloud.configured||{};
  return '<form class="form-stack" data-cloud-settings><div class="cloud-dialog-heading"><div><p class="eyebrow">属于你的创作工作室</p><h2>配置我的模型</h2></div><button type="button" class="button-quiet" data-cloud-action="close" aria-label="关闭模型配置">×</button></div><p class="context-note">填写你自己的 API Key。保存只更新配置；点击创作或生成按钮后，才会向所选服务商发送对应任务。</p><section class="cloud-settings-section"><h3>文字创作</h3><div class="form-grid"><label class="field-label">服务商<select class="select" name="textProvider">'+[['deepseek','DeepSeek'],['qwen','通义千问'],['openai','OpenAI']].map(([id,label])=>'<option value="'+id+'"'+(cloud.textProvider===id?' selected':'')+'>'+label+'</option>').join('')+'</select></label><label class="field-label">模型名称<input class="field" name="textModel" value="'+esc(cloud.textModel)+'" maxlength="100" required></label></div>'+keyField('textApiKey','文字模型 API Key',configured.text,'clearTextKey')+'</section><section class="cloud-settings-section"><h3>图片与视频 · RunningHub</h3><p class="small muted">直接调用模型需使用 RunningHub 模型 API 对应的密钥。个人账号也可在 API 管理页选择「企业级-共享」类型；具体权限以平台为准。</p>'+keyField('runninghubModelApiKey','模型 API Key',configured.runninghubModels,'clearRunninghubModelKey')+'<a href="https://www.runninghub.cn/call-api/bill-task?tab=keys&type=shared" target="_blank" rel="noopener noreferrer">打开 RunningHub API 管理 ↗</a></section><p data-cloud-status role="status" class="cloud-settings-status"></p><div class="form-actions"><button class="button-primary" type="submit">保存配置</button><button class="button-secondary" type="button" data-cloud-action="close">完成</button></div></form>';
 }
 async function openSettings(){
  if(!dialog){dialog=document.createElement('dialog');dialog.className='cloud-settings-dialog';dialog.setAttribute('aria-label','配置我的模型');dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else dialog.replaceChildren();});document.body.append(dialog);}
  if(dialog.open)return;
  dialog.innerHTML='<p class="context-note" role="status">正在读取模型配置…</p>';dialog.showModal();
  try{await requestSettings();if(dialog.open){dialog.innerHTML=formHTML();dialog.querySelector('select').focus();}}catch(error){if(dialog.open)dialog.innerHTML='<p role="alert">'+esc(error.message)+'</p><button type="button" class="button-secondary" data-cloud-action="close">关闭</button>';}
 }
 function close(){if(busy||!dialog)return;dialog.close();dialog.replaceChildren();}
 function mountAccount(){
  const profile=document.querySelector('.planner-profile');
  if(profile){profile.querySelector('strong').textContent=cloud.user.name||'项目总策划';profile.querySelector('small').textContent='在线工作室 · 自有 API';}
  const version=document.querySelector('.sidebar-version');if(version){version.querySelector('span:nth-child(2)').textContent='在线试用版';}
  if(!document.querySelector('.cloud-account-actions')){const el=document.createElement('div');el.className='cloud-account-actions';el.innerHTML='<button type="button" data-cloud-action="settings">模型配置</button><a href="/signout-with-chatgpt?return_to=%2F" target="_top">退出登录</a>';document.querySelector('.sidebar-bottom')?.append(el);}
 }
 document.addEventListener('click',event=>{const button=event.target.closest('[data-cloud-action]');if(!button)return;event.preventDefault();if(button.dataset.cloudAction==='settings')void openSettings();if(button.dataset.cloudAction==='close')close();});
 document.addEventListener('change',event=>{if(event.target.matches('[data-cloud-settings] [name="textProvider"]')){event.target.form.elements.textModel.value=defaults[event.target.value];const key=event.target.form.elements.textApiKey;key.value='';key.placeholder=event.target.value===cloud.textProvider?'已保存 · 留空保留':'请输入新服务商密钥；留空会移除旧密钥';}});
 document.addEventListener('submit',async event=>{
  const form=event.target;if(!form.matches('[data-cloud-settings]'))return;event.preventDefault();event.stopImmediatePropagation();if(busy)return;
  const data=new FormData(form),payload={textProvider:String(data.get('textProvider')||''),textModel:String(data.get('textModel')||'').trim()};
  for(const key of ['textApiKey','runninghubApiKey','runninghubModelApiKey']){const value=String(data.get(key)||'').trim();if(value)payload[key]=value;}
  if(payload.textProvider!==cloud.textProvider&&!payload.textApiKey)payload.clearTextKey=true;
  for(const flag of ['clearTextKey','clearRunninghubKey','clearRunninghubModelKey'])if(data.has(flag))payload[flag]=true;
  const status=form.querySelector('[data-cloud-status]');
  if(!payload.textModel){status.textContent='请填写文字模型名称。';return;}
  busy=true;for(const el of form.querySelectorAll('input,select,button'))el.disabled=true;status.textContent='正在保存模型配置…';
  try{
   await requestSettings(payload);
   // Discard all secret-bearing fields immediately after a successful save.
   form.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';});
   global.dispatchEvent(new CustomEvent('studio-cloud-settings-saved'));
   dialog.innerHTML=formHTML();dialog.querySelector('[data-cloud-status]').textContent='配置已保存。可返回项目开始创作；实际可用性会以模型调用结果显示。';
  }catch(error){status.textContent=error.message;status.setAttribute('role','alert');}
  finally{busy=false;form.querySelectorAll('input,select,button').forEach(el=>{el.disabled=false;});}
 },true);
 global.StudioCloudUI={settingsHTML,mountAccount,openSettings};
})(window);
