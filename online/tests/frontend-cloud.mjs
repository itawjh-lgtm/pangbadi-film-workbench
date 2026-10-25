import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),pub=path.join(root,'public');
const read=file=>readFile(path.join(pub,file),'utf8');
const storageCode=await read('cloud/storage.js'),bootCode=await read('cloud/bootstrap.js');
function memoryStorage(){const map=new Map();return{get length(){return map.size;},key:i=>[...map.keys()][i]??null,getItem:k=>map.get(String(k))??null,setItem:(k,v)=>map.set(String(k),String(v)),removeItem:k=>map.delete(String(k)),clear:()=>map.clear(),map};}
function scoped(){const context=vm.createContext({});vm.runInContext(storageCode,context);return context.StudioCloudStorage.createScopedStorage;}
test('account storage isolates projects, drafts, canvas preferences and clear()',()=>{
 const make=scoped(),native=memoryStorage(),alice=make(native,'alice'),bob=make(native,'bob');
 native.setItem('creative-workbench-v3','legacy user data');
 for(const key of ['creative-workbench-v3','creative-workbench-production-drafts-v1','dream-studio-canvas-ui:one','creative-workbench-layout-v1']){alice.setItem(key,'alice data');assert.equal(bob.getItem(key),null);bob.setItem(key,'bob data');assert.equal(alice.getItem(key),'alice data');}
 assert.equal(alice.length,4);assert.equal(alice.key(0),'creative-workbench-v3');alice.clear();assert.equal(alice.length,0);assert.equal(bob.length,4);assert.equal(native.getItem('creative-workbench-v3'),'legacy user data');
});
test('account prefix does not collide with separators and requires identity',()=>{const make=scoped(),native=memoryStorage();assert.throws(()=>make(native,''));const a=make(native,'a:b'),b=make(native,'a');a.setItem('x','private');assert.equal(b.getItem('b:x'),null);});
async function boot(status,session){
 const logs=[],nodes=new Map([['cloud-boot',{setAttribute(){},replaceChildren(){},append(){},remove(){logs.push('boot-removed');}}],['creative-workbench-v2',{hidden:true}]]);
 const window={localStorage:memoryStorage(),sessionStorage:memoryStorage(),location:{replace:url=>logs.push(['redirect',url]),reload(){}},StudioCloudUI:{mountAccount:()=>logs.push('account')}};
 let context;
 const document={getElementById:id=>nodes.get(id),createElement:()=>({append(){}}),head:{append(script){logs.push(['script',script.src]);if(script.src==='cloud/storage.js')vm.runInContext(storageCode,context);script.onload();}}};
 const fetch=async url=>{logs.push(['fetch',url]);if(url==='/api/cloud/session')return{status,ok:status===200,json:async()=>session};return{ok:true,json:async()=>['lib/store.js','app.js']};};
 context=vm.createContext({window,document,fetch,AbortController,setTimeout,clearTimeout});vm.runInContext(bootCode,context);await new Promise(r=>setTimeout(r,15));return{logs,nodes,window};
}
test('401 redirects before any workbench module or storage initialization',async()=>{const result=await boot(401);assert.equal(result.window.StudioCloud,undefined);assert.equal(result.logs.filter(x=>Array.isArray(x)&&x[0]==='script').length,0);assert.ok(result.logs.some(x=>Array.isArray(x)&&x[0]==='redirect'));assert.equal(result.nodes.get('creative-workbench-v2').hidden,true);});
test('unknown session fails closed',async()=>{const result=await boot(200,{user:{id:'u'},mode:'cloud'});assert.equal(result.window.StudioCloud,undefined);assert.equal(result.nodes.get('creative-workbench-v2').hidden,true);});
test('authenticated session completes before scripts initialize account-bound state',async()=>{const result=await boot(200,{user:{id:'u1'},mode:'cloud',csrfToken:'token',configured:{text:false}});assert.ok(result.window.StudioCloud);assert.deepEqual(result.logs.filter(x=>Array.isArray(x)&&x[0]==='script').map(x=>x[1]),['cloud/storage.js','cloud/settings.js','lib/store.js','app.js']);assert.equal(result.nodes.get('creative-workbench-v2').hidden,false);result.window.StudioCloud.localStorage.setItem('project','one');assert.equal(result.window.localStorage.getItem('project'),null);assert.equal(result.window.localStorage.getItem('pangbadi-cloud:u1:project'),'one');});
test('all storage use in copied application modules is account-scoped',async()=>{const files=['app.js',...(await readdir(path.join(pub,'lib'))).filter(f=>f.endsWith('.js')).map(f=>'lib/'+f)];for(const file of files){const source=await read(file);for(const line of source.split('\n').filter(l=>/localStorage|sessionStorage/.test(l)))assert.match(line,/StudioCloud\.(?:localStorage|sessionStorage)/,file);assert.doesNotMatch(source,/StudioCloud\.StudioCloud/);}});
test('cloud store cannot import host widget or legacy unscoped account data',async()=>{assert.match(await read('app.js'),/host:null,storage:window\.StudioCloud\.localStorage/);});
test('runtime supports a real long-running model call; workspace saves keep 12s deadline',async()=>{assert.match(await read('lib/runtime.js'),/: 210000;/);assert.match(await read('lib/workspace-sync.js'),/abort\(\), 12000/);assert.match(await read('lib/runtime.js'),/response.status === 401.*StudioCloud.expire/);});
test('HTML boots only through session gate and includes all referenced scripts/styles',async()=>{const html=await read('workbench.html');assert.equal([...html.matchAll(/<script src=/g)].length,1);assert.match(html,/app-shell" hidden/);assert.doesNotMatch(html,/data-inline/);for(const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css)(?:\?[^"#]+)?)"/g))await access(path.join(pub,match[1].split('?')[0]));const manifest=JSON.parse(await read('cloud/scripts.json'));assert.equal(manifest.at(-1).split('?')[0],'app.js');for(const src of manifest)await access(path.join(pub,src.split('?')[0]));await access(path.join(pub,'assets/scenes/studio-hero.webp'));});
test('public payload contains no runtime, local settings, source prompts or private data directories',async()=>{const top=await readdir(pub);for(const name of ['runtime','.data','data.sqlite','.env','.dev.vars','docs','qa','prompt-snapshots'])assert.ok(!top.includes(name));assert.deepEqual((await readdir(path.join(pub,'data'))).sort(),['employees.js','project-templates.js']);});
test('BYOK settings use authenticated endpoint, csrf, safe rendering and no browser persistence',async()=>{const source=await read('cloud/settings.js');assert.match(source,/\/api\/cloud\/settings/);assert.match(source,/'X-Studio-Token':cloud.csrfToken/);assert.doesNotMatch(source,/localStorage|sessionStorage|\.setItem\(/);for(const flag of ['clearTextKey','clearRunninghubKey','clearRunninghubModelKey'])assert.ok(source.includes(flag));assert.match(source,/input.value=''/);assert.match(source,/esc\(cloud.user.name/);assert.match(source,/studio-cloud-settings-saved/);assert.match(await read('app.js'),/addEventListener\('studio-cloud-settings-saved'/);assert.match(source,/signout-with-chatgpt\?return_to=%2F/);});
test('cloud connection UI cannot show or submit old local-only key forms',async()=>{const source=await read('lib/views.js');assert.doesNotMatch(source,/data-form="runninghub-model-config"|data-form="runninghub-config"/);assert.match(source,/StudioCloudUI.settingsHTML/);assert.doesNotMatch(source,/本机 Codex|同一台 Mac|仅保存于本机/);});
test('every employee portrait, thumb and public visual remains available',async()=>{const files=['data/employees.js','lib/views.js','lib/store.js','styles.css',...(await readdir(path.join(pub,'styles'))).filter(f=>f.endsWith('.css')).map(f=>'styles/'+f)];let count=0;for(const file of files){for(const match of (await read(file)).matchAll(/(?:\.\.\/)?(assets\/[\w/.-]+\.(?:png|webp|svg|jpg|html))/g)){await access(path.join(pub,match[1]));count++;}}assert.ok(count>45);});
test('saving keys sends one authenticated POST, clears secret input and dispatches reconnect',async()=>{
 const listeners={},calls=[],events=[],status={textContent:'',setAttribute(){}};
 const dialog={open:false,innerHTML:'',setAttribute(){},addEventListener(){},showModal(){this.open=true;},querySelector(){return{focus(){},...status};},close(){this.open=false;},replaceChildren(){}};
 const cloud={user:{id:'alice'},configured:{text:true},textProvider:'deepseek',textModel:'deepseek-chat',csrfToken:'csrf-one',expire(){throw new Error('unexpected expiration');}};
 const document={addEventListener:(type,fn)=>{listeners[type]=fn;},createElement:()=>dialog,body:{append(){}}};
 const fetch=async(url,options)=>{calls.push({url,options});return{ok:true,status:200,json:async()=>({configured:{text:true,runninghubModels:true},textProvider:options.method==='POST'?'qwen':'deepseek',textModel:options.method==='POST'?'qwen-plus':'deepseek-chat'})};};
 const context=vm.createContext({window:{StudioCloud:cloud,dispatchEvent:event=>events.push(event.type)},document,fetch,CustomEvent:class{constructor(type){this.type=type;}},FormData:class{constructor(form){this.data=form.values;}get(k){return this.data[k]??null;}has(k){return k in this.data;}}});
 vm.runInContext(await read('cloud/settings.js'),context);await context.window.StudioCloudUI.openSettings();
 const secret={value:'qwen-key-private-test',disabled:false},form={values:{textProvider:'qwen',textModel:'qwen-plus',textApiKey:'qwen-key-private-test',runninghubModelApiKey:'runninghub-private-test'},matches:()=>true,querySelector:()=>status,querySelectorAll:()=>[secret]};
 await listeners.submit({target:form,preventDefault(){},stopImmediatePropagation(){}});
 assert.equal(calls.length,2);assert.equal(calls[1].url,'/api/cloud/settings');assert.equal(calls[1].options.headers['X-Studio-Token'],'csrf-one');assert.equal(JSON.parse(calls[1].options.body).textApiKey,'qwen-key-private-test');assert.equal(secret.value,'');assert.deepEqual(events,['studio-cloud-settings-saved']);assert.equal(cloud.textApiKey,undefined);assert.equal(cloud.runninghubModelApiKey,undefined);
});
test('switching text service without replacement key explicitly clears the old key',async()=>{const source=await read('cloud/settings.js');assert.match(source,/payload.textProvider!==cloud.textProvider&&!payload.textApiKey\)payload.clearTextKey=true/);});
test('unsupported workflow and manual provider-price controls are absent from cloud UI',async()=>{const views=await read('lib/views.js'),settings=await read('cloud/settings.js');assert.doesNotMatch(views,/<option value="workflow_api">/);assert.doesNotMatch(views,/\+providerCosts\(\)/);assert.doesNotMatch(settings,/可选 · 个人工作流连接/);});
test('unknown production outcome requires explicit user confirmation and forwards it only on resume',async()=>{
 const source=await read('app.js'),productionSource=await read('lib/production.js');
 const segment=source.slice(source.indexOf("    if(action==='production-pause'||action==='production-resume'){"),source.indexOf("    if(action==='production-review-current'){"));
 async function scenario({unknown,action='production-resume',confirmed=true}){const calls=[],prompts=[];const context=vm.createContext({action,id:'plan',control:{dataset:{revision:'3'}},workspaceSync:{blocked:()=>false},production:{find:()=>({outcomeUnknown:unknown}),pause:async(...args)=>calls.push(['pause',...args]),resume:async(...args)=>calls.push(['resume',...args])},window:{confirm:message=>{prompts.push(message);return confirmed;}},toast(){}});await vm.runInContext('(async()=>{'+segment+'})()',context);return{calls,prompts};}
 let result=await scenario({unknown:true,confirmed:false});assert.equal(result.calls.length,0);assert.equal(result.prompts.length,1);
 result=await scenario({unknown:true,confirmed:true});assert.deepEqual(result.calls,[['resume','plan',3,true]]);assert.match(result.prompts[0],/可能已经计费/);
 result=await scenario({unknown:false});assert.deepEqual(result.calls,[['resume','plan',3,false]]);assert.equal(result.prompts.length,0);
 result=await scenario({unknown:true,action:'production-pause'});assert.equal(result.prompts.length,0);assert.deepEqual(result.calls,[['pause','plan',3]]);
 assert.match(productionSource,/confirmUnknown\?\{confirmUnknown:true\}:\{\}/);
 assert.match(await readFile(path.join(root,'scripts/sync-workbench.mjs'),'utf8'),/confirmUnknown/);
});
