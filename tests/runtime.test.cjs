const test=require('node:test');
const assert=require('node:assert/strict');
const Runtime=require('../lib/runtime.js');
const health={ok:true,service:'dream-studio-runtime',version:'0.4',csrfToken:'test-csrf',provider:{available:true,authenticated:true}};
const json=(data,ok=true,status=200)=>({ok,status,json:async()=>data});
function harness(handler){const calls=[],timers=[];const runtime=Runtime.create({fetch:async(path,options)=>{calls.push({path,options});return handler(path,options);},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}});return {runtime,calls,timers};}
test('inline preview does not call execution API',async()=>{let calls=0;const r=Runtime.create({disabled:true,fetch:()=>{calls++;}});assert.equal(await r.connect(),false);await assert.rejects(r.start({prompt:'x',agentIds:['R11']}));assert.equal(calls,0);});
test('only the identified same-origin runtime becomes ready',async()=>{const {runtime}=harness(async()=>json({ok:true,service:'other-app'}));assert.equal(await runtime.connect(),false);assert.equal(runtime.connection.state,'offline');});
test('personal and project histories remain separate; CSRF is sent on explicit generation only',async()=>{
 const peerRun={id:'peer-run',peerId:'R04',projectId:null,status:'succeeded',messages:[],artifacts:[]};
 const projectRun={id:'project-run',projectId:'p1',peerId:null,status:'succeeded',messages:[],artifacts:[{id:'asset-1',title:'story',body:'body',url:'/api/artifacts/asset-1'}]};
 const {runtime,calls}=harness(async(path,options)=>{
  if(path==='/api/health')return json(health);
  if(path==='/api/roles')return json({roles:[{id:'R04',available:true}]});
  if(path==='/api/runs?peerId=R04')return json({runs:[peerRun]});
  if(path==='/api/runs?projectId=p1')return json({runs:[projectRun]});
  if(path==='/api/runs')return json({run:{...peerRun,id:'new-run'}});
  throw new Error(path);
 });
 assert.equal(await runtime.connect(),true);
 await runtime.loadScope({peerId:'R04'});await runtime.loadScope({projectId:'p1'});
 assert.deepEqual(runtime.getRuns({peerId:'R04'}).map(r=>r.id),['peer-run']);
 assert.deepEqual(runtime.getRuns({projectId:'p1'}).map(r=>r.id),['project-run']);
 assert.equal(runtime.artifacts({peerId:'R04'}).length,0);assert.equal(runtime.artifacts({projectId:'p1'}).length,1);
 assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
 await runtime.start({requestId:'test-request',mode:'chat',project:null,peerId:'R04',prompt:'工作要求',agentIds:['R04']});
 const post=calls.find(c=>c.options.method==='POST');assert.equal(post.options.headers['X-Studio-Token'],'test-csrf');assert.equal(JSON.parse(post.options.body).project,null);assert.equal(post.options.redirect,'error');
 assert.equal(runtime.getRuns({projectId:'p1'}).length,1);runtime.dispose();
});
test('server rejection is surfaced and no success result is fabricated',async()=>{const {runtime}=harness(async(path)=>path==='/api/health'?json(health):path==='/api/roles'?json({roles:[]}):json({error:'依赖未完成'},false,409));await runtime.connect();await assert.rejects(runtime.start({prompt:'make',agentIds:['R04'],project:{id:'p1'}}),/依赖未完成/);assert.deepEqual(runtime.getRuns({projectId:'p1'}),[]);});
test('artifact links allow attachment routes only',()=>{assert.equal(Runtime.artifactURL('/api/artifacts/abc-123'),'/api/artifacts/abc-123');for(const value of ['https://evil.test/a','javascript:alert(1)','//evil.test','/api/artifacts/../secret','/api/artifacts/a?redirect=evil'])assert.equal(Runtime.artifactURL(value),'');});
test('execution polling stops when every run is terminal',async()=>{const run={id:'r1',projectId:'p1',status:'running',createdAt:'2026-10-24T00:00:00Z'};const timers=[];let polls=0;const r=Runtime.create({setTimeout:(fn,ms)=>{if(ms===1200)timers.push(fn);return timers.length+1;},clearTimeout(){},fetch:async path=>path==='/api/health'?json(health):path==='/api/roles'?json({roles:[]}):path==='/api/trash'?json({items:[]}):path==='/api/runs?projectId=p1'?json({runs:[run]}):(polls++,json({run:{...run,status:'succeeded'}}))});await r.connect();await r.loadScope({projectId:'p1'});assert.equal(timers.length,1);await timers.shift()();assert.equal(polls,1);assert.equal(timers.length,0);assert.equal(r.getRuns({projectId:'p1'})[0].status,'succeeded');r.dispose();});
test('model output and role sources are escaped, generated HTML stays inert',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),win={};const ctx=vm.createContext({window:win,console});
 for(const file of ['data/employees.js','data/project-templates.js','lib/views.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
 const Store=require('../lib/store.js'),store=Store.create(win.TEAM_EMPLOYEES,{storage:{getItem(){return null},setItem(){}},host:null});
 const malicious='<img src=x onerror=alert(1)>';
 const runtime={active:Runtime.active,artifactURL:Runtime.artifactURL,ready:()=>true,getRuns:()=>[],getError:()=>'',artifacts:()=>[],roles:[],role:()=>({available:true,source:malicious,outputs:[malicious],permissions:[malicious]}),connection:{ready:true,state:'online'}};
 const views=win.StudioViews.create(win.TEAM_EMPLOYEES,store,runtime);
 const html=views.runtimeArtifactDetails({id:'a1',title:malicious,body:'<script>alert(1)</script>',url:'javascript:alert(1)',authorId:'R04'});
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('&lt;script&gt;'));
 const role=views.employeeDetails(win.TEAM_EMPLOYEES[0],store.getState(),false);assert.ok(role.includes('&lt;img'));assert.ok(!role.includes(malicious));
 const run=views.runtimeRun({id:'r',status:'failed',prompt:malicious,error:malicious,createdAt:new Date().toISOString(),steps:[],messages:[{authorId:'R04',content:malicious}],events:[]});assert.ok(!run.includes(malicious));
});
test('loading media connections and histories never submits a paid job',async()=>{const {runtime,calls}=harness(async path=>path==='/api/health'?json(health):path==='/api/roles'?json({roles:[]}):path==='/api/connections'?json({providers:[{id:'runninghub',configured:false,config:{unitPrice:null}}]}):json({jobs:[]}));await runtime.connect();await runtime.refreshMedia();assert.equal(runtime.media.providers[0].configured,false);assert.equal(calls.filter(c=>c.options.method==='POST').length,0);});
test('media config secrets only enter the explicit same-origin POST, never the displayed catalog',async()=>{const {runtime,calls}=harness(async(path,options)=>path==='/api/health'?json(health):path==='/api/roles'?json({roles:[]}):path==='/api/connections'?json({providers:[{id:'runninghub',keyConfigured:true,config:{workflowId:'123'}}]}):path==='/api/media/jobs'?json({jobs:[]}):json({ok:true}));await runtime.connect();await runtime.saveConnection({apiKey:'TEST-NOT-A-REAL-KEY',workflowId:'123'});const write=calls.find(c=>c.path==='/api/connections/runninghub');assert.equal(write.options.headers['X-Studio-Token'],'test-csrf');assert.ok(!JSON.stringify(runtime.media).includes('TEST-NOT-A-REAL-KEY'));assert.equal(calls.some(c=>c.path==='/api/media/jobs'&&c.options.method==='POST'),false);});
test('account verification and workflow inspection use separate read-only contracts without submitting media',async()=>{
 const verification={verified:true,checkedAt:'2026-10-25T01:00:00Z',scope:'account'};
 const workflow={workflowId:'123',nodeCount:1,fields:[{nodeId:'6',fieldName:'text',fieldValue:'original',valueType:'string'}],nodeInfoList:[]};
 const {runtime,calls}=harness(async path=>{
  if(path==='/api/health')return json(health);
  if(path==='/api/roles')return json({roles:[]});
  if(path==='/api/connections/runninghub/verify')return json({verification});
  if(path==='/api/connections/runninghub/workflow')return json({workflow});
  if(path==='/api/connections')return json({providers:[{id:'runninghub',keyConfigured:true,verified:true,verification}]});
  if(path==='/api/media/jobs')return json({jobs:[]});
  throw new Error(path);
 });
 await runtime.connect();assert.deepEqual(await runtime.verifyRunningHub(),verification);
 assert.equal(runtime.media.providers[0].verified,true);
 const link='https://www.runninghub.cn/workflow/123';assert.deepEqual(await runtime.readRunningHubWorkflow(link),workflow);
 const posts=calls.filter(call=>call.options.method==='POST');
 assert.deepEqual(posts.map(call=>call.path),['/api/connections/runninghub/verify','/api/connections/runninghub/workflow']);
 assert.deepEqual(JSON.parse(posts[0].options.body),{});assert.deepEqual(JSON.parse(posts[1].options.body),{workflowId:link});
 assert.ok(posts.every(call=>call.options.headers['X-Studio-Token']==='test-csrf'));
});
test('rejected account verification does not fabricate a verified catalog',async()=>{
 const {runtime}=harness(async path=>path==='/api/health'?json(health):path==='/api/roles'?json({roles:[]}):path==='/api/connections'?json({providers:[{id:'runninghub',verified:false}]}):path==='/api/media/jobs'?json({jobs:[]}):json({error:'密钥不可用'},false,400));
 await runtime.connect();await runtime.refreshMedia();await assert.rejects(runtime.verifyRunningHub(),/密钥不可用/);assert.equal(runtime.media.providers[0].verified,false);
});
test('RunningHub network operations allow 55 seconds while ordinary requests retain 15 seconds',async()=>{
 const calls=[],durations=[];
 const runtime=Runtime.create({setTimeout:(fn,ms)=>{durations.push(ms);return durations.length;},clearTimeout(){},fetch:async(path,options)=>{
  calls.push({path,method:options.method,body:options.body,timeout:durations.at(-1)});
  if(path==='/api/health')return json(health);if(path==='/api/roles')return json({roles:[]});
  if(path==='/api/connections')return json({providers:[]});
  if(path==='/api/connections/runninghub/verify')return json({verification:{verified:true}});
  if(path==='/api/connections/runninghub/workflow')return json({workflow:{workflowId:'123',fields:[]}});
  if(path==='/api/media/jobs'&&options.method==='GET')return json({jobs:[]});
  return json({job:{id:'media-1',projectId:'real-project',status:'running'}});
 }});
 await runtime.connect();await runtime.verifyRunningHub();await runtime.readRunningHubWorkflow('123');
 await runtime.submitMedia({projectId:'real-project',requestId:'one-request',estimateToken:'estimate-token',confirmCost:true});await runtime.refreshMediaJob('media-1');
 for(const call of calls)assert.equal(call.timeout,call.path.includes('/verify')||call.path.includes('/workflow')||call.path.endsWith('/refresh')||call.path==='/api/media/jobs'&&call.method==='POST'?55000:15000);
 assert.equal(calls.filter(call=>call.timeout===55000).length,4);
 assert.deepEqual(JSON.parse(calls.find(call=>call.path==='/api/media/jobs'&&call.method==='POST').body),{projectId:'real-project',requestId:'one-request',estimateToken:'estimate-token',confirmCost:true});
});
test('only selected workflow fields are merged and typed; unrelated JSON inputs survive',()=>{
 const workflow={fields:[{nodeId:'6',fieldName:'text',valueType:'string'},{nodeId:'3',fieldName:'seed',valueType:'number'},{nodeId:'8',fieldName:'enabled',valueType:'boolean'}]};
 const existing=[{nodeId:'6',fieldName:'text',fieldValue:'old'},{nodeId:'9',fieldName:'image',fieldValue:'reference.png'}];
 assert.deepEqual(Runtime.mergeWorkflowFields(workflow,[],existing),existing);
 const result=Runtime.mergeWorkflowFields(workflow,[{index:0,value:'new prompt'},{index:2,value:'false'}],existing);
 assert.deepEqual(result,[{nodeId:'6',fieldName:'text',fieldValue:'new prompt'},{nodeId:'9',fieldName:'image',fieldValue:'reference.png'},{nodeId:'8',fieldName:'enabled',fieldValue:false}]);
 assert.equal(existing[0].fieldValue,'old');assert.equal(result.some(field=>field.fieldName==='seed'),false);
 assert.equal(Runtime.mergeWorkflowFields(workflow,[{index:1,value:'42'}])[0].fieldValue,42);
 assert.throws(()=>Runtime.mergeWorkflowFields(workflow,[{index:1,value:''}]),/有效数字/);
 assert.throws(()=>Runtime.mergeWorkflowFields(workflow,[{index:2,value:'maybe'}]),/true 或 false/);
 assert.throws(()=>Runtime.mergeWorkflowFields(workflow,[],[null]),/JSON 数组/);
});
test('workflow fields render inert content and start unselected; account verification needs no workflow',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),win={};const ctx=vm.createContext({window:win,console});
 for(const file of ['data/employees.js','data/project-templates.js','lib/views.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
 const store=require('../lib/store.js').create(win.TEAM_EMPLOYEES,{storage:{getItem(){return null},setItem(){}},host:null});
 const runtime={ready:()=>true,roles:[],connection:{state:'online'},media:{providers:[{id:'runninghub',label:'RunningHub',keyConfigured:true,configured:false,verified:true,verification:{checkedAt:'2026-10-25T01:00:00Z'},apiKeyUrl:'https://www.runninghub.cn/',config:{}}],jobs:[]}};
 const views=win.StudioViews.create(win.TEAM_EMPLOYEES,store,runtime),malicious='</textarea><img src=x onerror=alert(1)>';
 const fields=views.runninghubWorkflowFields({nodeCount:1,fields:[{nodeId:'6',nodeTitle:malicious,fieldName:'text',fieldValue:malicious,valueType:'string'}]});
 assert.ok(!fields.includes(malicious));assert.ok(fields.includes('&lt;/textarea&gt;'));assert.ok(!fields.includes(' checked'));
 const html=views.connections();assert.ok(html.includes('账户已验证'));assert.ok(html.includes('验证时间：'));assert.match(html,/data-action="media-verify">/);assert.match(html,/data-action="media-workflow-read">/);
 assert.ok(html.includes('只检查账户权限，不创建生成任务'));
});
