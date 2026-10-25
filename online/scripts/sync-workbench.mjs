import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.argv[2]?path.resolve(process.argv[2]):path.resolve(root,'../../AI团队工作台_v0.2');
const target=path.join(root,'public');
await mkdir(target,{recursive:true});
// Only reviewed presentation files are public. Runtime data and credentials never enter this tree.
for(const file of ['app.js','styles.css','data/employees.js','data/project-templates.js','assets/media-preview.html']) {
 await mkdir(path.dirname(path.join(target,file)),{recursive:true});await cp(path.join(source,file),path.join(target,file));
}
for(const dir of ['lib','styles','assets/employees','assets/thumbs','assets/projects','assets/scenes'])await cp(path.join(source,dir),path.join(target,dir),{recursive:true});
let html=await readFile(path.join(source,'index.html'),'utf8');
const scripts=[...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(m=>m[1]);
html=html.replace(/\s*<script src="[^"]+" defer><\/script>/g,'').replace('</head>','  <link rel="stylesheet" href="cloud/cloud.css">\n  <script src="cloud/bootstrap.js" defer></script>\n</head>');
html=html.replaceAll('本地协作功能','项目协作功能').replace('影视与游戏团队的本地创作协作工作台','影视与游戏团队的在线创作协作工作台').replace('class="app-shell"','class="app-shell" hidden').replace('<body>','<body>\n<section id="cloud-boot" class="cloud-boot" role="status"><div><span class="cloud-overline">庞巴迪影视工作台</span><h1>正在打开你的工作室</h1><p>验证账号并连接项目资料…</p></div></section>');
await writeFile(path.join(target,'workbench.html'),html);
await writeFile(path.join(target,'cloud/scripts.json'),JSON.stringify(scripts,null,2)+'\n');
let preview=await readFile(path.join(target,'assets/media-preview.html'),'utf8');
preview=preview.replaceAll('造梦工作室','庞巴迪影视工作台').replaceAll('本机工作台','在线工作台').replace('href="/"','href="/workbench.html"');
await writeFile(path.join(target,'assets/media-preview.html'),preview);
const sources=['app.js',...(await readdir(path.join(target,'lib'))).filter(f=>f.endsWith('.js')).map(f=>'lib/'+f)];
for(const file of sources){
 let code=await readFile(path.join(target,file),'utf8');
 // All storage access happens after authenticated boot; native storage is used only by the scoped facade.
 code=code.replace(/\b(?:global|root|win|window)\.(localStorage|sessionStorage)\b/g,'window.StudioCloud.$1').replace(/(?<![.\w])(localStorage|sessionStorage)\b/g,'window.StudioCloud.$1');
 code=code.replaceAll('本机数据库','云端项目数据库').replaceAll('本机服务','云端服务').replaceAll('本机工作台','云端工作台').replaceAll('本机执行服务','云端执行服务').replaceAll('保存到本机','保存到云端').replaceAll('本机服务端','当前账号的云端密钥库').replaceAll('当前 Codex 账户额度','你配置的文字模型 API').replaceAll('独立本地工作台','在线工作台').replaceAll('请使用新的启动工作台入口','请刷新页面或重新登录').replaceAll('创建本地项目','创建项目').replaceAll('创建本地任务','创建任务').replaceAll('本地项目','项目').replaceAll('本地任务','任务').replaceAll('本地手动任务','手动任务').replaceAll('本地便笺','项目便笺').replaceAll('本地登记','手动登记').replaceAll('请检查本地文件是否完整','请刷新页面或重新登录').replaceAll('进展已登记在本地。','进展已登记，云端同步状态见顶部提示。').replaceAll('审阅意见已保存在本地，任务复核状态保持独立。','审阅意见已登记，任务复核状态保持独立。').replaceAll('成果正文与版本已保存在本地。','成果正文与版本已登记，正在同步。').replaceAll('便笺已保存在本地；尚未发给员工执行器。','便笺已记录；尚未发给员工执行器。').replaceAll('造梦工作室_备份_','庞巴迪影视工作台_备份_');
 if(file==='lib/runtime.js')code=code.replace(': 15000;',': 210000;').replace("if (!response.ok) throw new Error(data.error", "if (response.status === 401) { window.StudioCloud.expire(); throw new Error('登录已过期，请重新登录。'); }\n        if (!response.ok) throw new Error(data.error");
 if(file==='lib/workspace-sync.js')code=code.replaceAll('造梦工作室','庞巴迪影视工作台');
 if(file==='lib/production.js')code=code.replace("resume:(id, expectedRevision) => action(id,'resume',{expectedRevision}),","resume:(id, expectedRevision, confirmUnknown=false) => action(id,'resume',{expectedRevision,...(confirmUnknown?{confirmUnknown:true}:{})}),");
 if(file==='app.js'){
  code=code.replace('create(employees,{isDeleted:', 'create(employees,{host:null,storage:window.StudioCloud.localStorage,isDeleted:');
  code=code.replace("const plan=production?.find(id);if(!plan)return;\n      try{const expectedRevision","const plan=production?.find(id);if(!plan)return;\n      let confirmUnknown=false;if(action==='production-resume'&&plan.outcomeUnknown){confirmUnknown=window.confirm('上次请求结果未知，可能已经计费。请先核对服务商任务记录；确认重新执行这个阶段吗？');if(!confirmUnknown)return;}\n      try{const expectedRevision").replace('production.resume(id,expectedRevision)','production.resume(id,expectedRevision,confirmUnknown)');
  code=code.replace('store.subscribe(render);',"window.addEventListener('studio-cloud-settings-saved',()=>{Promise.resolve(runtime?.connect()).then(()=>runtime?.refreshMedia()).catch(error=>toast(error.message));});\n  store.subscribe(render);");
 }
 if(file==='lib/views.js'){
  code=code.replace('+providerCosts()', '').replace('<option value="workflow_api">个人 API · 工作流生成</option>','');
  code=code.replace(/    function runtimeConnections\(\) \{[\s\S]*?\n    const field=/,'    function runtimeConnections() { return global.StudioCloudUI.settingsHTML(runtime); }\n    const field=');
  code=code.replace(/    function runninghubConnection\(\) \{[\s\S]*?\n    function mediaEstimateDetails/,`    function runninghubConnection() {
      const provider=runtime?.media?.providers?.find(p=>p.id==='runninghub'),models=provider?.models||[];
      return '<section class="surface cloud-media-summary"><div class="section-head"><div><h2>图像与视频</h2><p class="muted">RunningHub · 图像与视频模型</p></div>'+badge(provider?.modelConnection?.keyConfigured?'已保存模型密钥':'模型密钥待配置',provider?.modelConnection?.keyConfigured?'success':'demo')+'</div><p>在项目创作画布中编辑提示词、选择模型与生成作品。当前模型目录 '+models.length+' 个，实际可用性以你的账户与接口返回为准。</p><div class="detail-actions"><button type="button" class="button-primary" data-cloud-action="settings">配置我的模型</button>'+button('刷新模型与任务','media-refresh','','button-secondary')+'<a class="button-secondary" href="https://www.runninghub.cn/projects" target="_blank" rel="noopener noreferrer">打开 RunningHub ↗</a></div></section>';
    }
    function mediaEstimateDetails`);
  code=code.replaceAll('同一台 Mac 的网页与客户端共享项目；真实执行结果独立保存','按登录账号保存项目；真实执行记录与生成结果独立保存').replaceAll("header('本地工作台'","header('我的在线工作台'");
 }
 await writeFile(path.join(target,file),code);
}
console.log('Cloud workbench synced: '+scripts.length+' scripts; no runtime or private data copied.');
