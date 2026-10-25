'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Runtime=require('../lib/runtime.js');
const image={id:'rhart-image-g-2-official/text-to-image',label:'G2 官方 · 文生图',mediaKind:'image',defaults:{aspectRatio:'16:9',resolution:'2k',quality:'medium'},fields:[{name:'prompt',label:'画面提示词',type:'string',required:true,maxLength:20000},{name:'aspectRatio',label:'画幅',type:'string',options:['16:9','9:16','1:1'],default:'16:9'},{name:'resolution',label:'清晰度',type:'string',options:['1k','2k','4k'],default:'2k',required:true},{name:'quality',label:'画质',type:'string',options:['low','medium','high'],default:'medium',required:true}]};
const video={id:'bytedance/seedance-2.5-token/image-to-video',label:'Seedance 2.5 · 图生视频',mediaKind:'video',defaults:{ratio:'adaptive',duration:'5',generateAudio:true},fields:[{name:'prompt',label:'提示词',type:'string'},{name:'firstFrameUrl',label:'首帧图片',type:'string',format:'https',required:true},{name:'ratio',label:'比例',type:'string',options:['adaptive'],default:'adaptive'},{name:'duration',label:'时长',type:'string',options:['-1','5','10'],default:'5'},{name:'generateAudio',label:'生成声音',type:'boolean',default:true}]};
function views(provider={},jobs=[]){
  const win={},context=vm.createContext({window:win,console});
  for(const name of ['data/employees.js','data/project-templates.js','lib/views.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',name),'utf8'),context);
  const store=require('../lib/store.js').create(win.TEAM_EMPLOYEES,{storage:{getItem(){return null},setItem(){}},host:null});
  const runtime={artifacts:()=>[],ready:()=>false,roles:[],connection:{state:'online'},media:{providers:[{id:'runninghub',label:'RunningHub',config:{},models:[image,video],...provider}],jobs}};
  return win.StudioViews.create(win.TEAM_EMPLOYEES,store,runtime);
}

test('direct models are the clear default while personal workflow access remains optional',()=>{
  for(const modelConnection of [{},{keyConfigured:true,verified:true}]){
    const V=views({keyConfigured:true,modelConnection}),html=V.projectMediaComposer({id:'test-project',title:'测试项目',isDemo:false},{mediaKind:'image'}),connection=V.connections();
    assert.match(html,/<option value="model_api" selected>模型 API/);
    assert.match(html,/<option value="workflow_api">个人 API/);
    assert.match(html,/<fieldset[^>]+data-model-fields>/);
    assert.match(html,/<fieldset[^>]+data-workflow-fields hidden disabled>/);
    assert.ok(connection.indexOf('data-form="runninghub-model-config"')<connection.indexOf('data-form="runninghub-config"'));
    assert.match(connection,/<details class="media-workflow-settings"><summary>可选 · 个人工作流 API 连接/);
    assert.ok(connection.includes('个人账户可以使用，无需企业账户'));
    if(!modelConnection.keyConfigured)assert.match(html,/<button class="button-primary" type="submit" disabled>查询报价/);
  }
});

test('model-only credentials make model mode available without a text executor or workflow ID',()=>{
  const html=views({keyConfigured:false,modelConnection:{keyConfigured:true}}).projectMediaComposer({id:'test-project',title:'测试项目',isDemo:false},{mediaKind:'image'});
  assert.match(html,/<option value="model_api" selected>/);
  assert.match(html,/<fieldset[^>]+data-workflow-fields hidden disabled>/);
  assert.match(html,/<button class="button-primary" type="submit">查询报价与预览参数/);
  assert.ok(!html.includes('name="modelApiKey" value='));
});

test('creative tool status reflects configured interfaces without claiming a successful generation',()=>{
  for(const [provider,label] of [
    [{keyConfigured:true},'接口已接 · 待选工作流'],
    [{keyConfigured:true,config:{workflowId:'chosen-workflow'}},'已接入 · 需确认生成'],
    [{modelConnection:{keyConfigured:true}},'已接入 · 需确认生成'],
    [{keyConfigured:false},'接口已接 · 待配置']
  ]){
    const html=views(provider).connections(),row=html.split('<h3>图像与视频工具</h3>')[1].split('</article>')[0];
    assert.ok(row.includes(label));assert.ok(!row.includes('生成已通过'));
  }
  const html=views({keyConfigured:true,verified:true,verification:{checkedAt:'2026-10-25T02:00:00Z'}}).connections();
  assert.match(html,/<strong data-workflow-verification-status>账户已验证<\/strong>/);
  assert.match(html,/data-workflow-verification-meta>验证时间：/);
});

test('model parameters retain text, schema defaults and booleans without injecting workflow fields',()=>{
  const prompt='一艘小船\n  保留红色船帆';
  const result=Runtime.modelParameters(image,{prompt,workflowId:'not-used',nodeInfoList:'not-used'});
  assert.deepEqual(result,{prompt,aspectRatio:'16:9',resolution:'2k',quality:'medium'});
  assert.deepEqual(Runtime.modelParameters(video,{firstFrameUrl:'https://cdn.example.com/frame.png',generateAudio:false}),{firstFrameUrl:'https://cdn.example.com/frame.png',ratio:'adaptive',duration:'5',generateAudio:false});
  assert.throws(()=>Runtime.modelParameters(video,{firstFrameUrl:'https://cdn.example.com/frame.png',ratio:'16:9'}),/不在当前模型支持/);
  assert.throws(()=>Runtime.modelParameters(image,{prompt:'x',resolution:'1080p'}),/不在当前模型支持/);
  assert.throws(()=>Runtime.modelParameters(image,{prompt:''}),/画面提示词/);
});

test('reference URL arrays and first frames require HTTPS and respect schema limits',()=>{
  const model={...image,fields:[...image.fields,{name:'imageUrls',label:'参考图',type:'urls',required:true,maxItems:2}]};
  assert.deepEqual(Runtime.modelParameters(model,{prompt:'hello',imageUrls:'https://cdn.example.com/a.png\nhttps://cdn.example.com/b.png'}).imageUrls,['https://cdn.example.com/a.png','https://cdn.example.com/b.png']);
  assert.throws(()=>Runtime.modelParameters(model,{prompt:'x',imageUrls:'https://cdn.example.com/a.png\nhttps://cdn.example.com/b.png\nhttps://cdn.example.com/c.png'}),/最多允许 2/);
  for(const url of ['file:///tmp/a.png','javascript:alert(1)','https://user:pass@cdn.example.com/a.png'])assert.throws(()=>Runtime.modelParameters(video,{firstFrameUrl:url}),/HTTPS/);
});

test('schema fields render escaped values and only supported ratio and resolution options',()=>{
  const V=views(),malicious='</textarea><img src=x onerror=alert(1)>';
  const fields=V.mediaModelFields(image,{prompt:malicious});
  assert.ok(fields.includes('&lt;/textarea&gt;'));assert.ok(!fields.includes(malicious));
  assert.ok(fields.includes('<option value="2k" selected>2k</option>'));
  assert.ok(!fields.includes('1080p'));
  const videoFields=V.mediaModelFields(video);
  assert.ok(videoFields.includes('<option value="adaptive" selected>adaptive</option>'));
  assert.ok(!videoFields.includes('<option value="16:9"'));
  assert.ok(videoFields.includes('type="url"'));
});

test('result cards include real media controls and safe links, but no autoplay or fabricated progress',()=>{
  const jobs=[{id:'job-1',projectId:'test-project',mode:'model_api',modelId:image.id,status:'succeeded',outputs:[{url:'https://cdn.example.com/a.png',outputType:'image'},{url:'https://cdn.example.com/b.mp4',outputType:'video'},{url:'javascript:alert(1)',outputType:'image'}]}];
  const html=views({keyConfigured:true},jobs).artifacts({projects:[{id:'test-project',title:'测试项目',isDemo:false}],activeProjectId:'test-project',artifacts:[]});
  assert.match(html,/<img src="https:\/\/cdn.example.com\/a.png" data-media-preview-key=/);
  assert.match(html,/<video controls preload="metadata" playsinline src="https:\/\/cdn.example.com\/b.mp4"/);
  assert.ok(html.includes('data-media-fallback hidden'));assert.ok(!html.includes('javascript:'));assert.ok(!html.includes('autoplay'));
});

test('official quote preview does not create a job and model credentials remain separate',async()=>{
  const calls=[],durations=[],quote={known:true,estimatedCost:0.12,currency:'USD',withinBudget:true,pricingSource:'runninghub_price_preview',estimateToken:'test-token'};
  const runtime=Runtime.create({setTimeout:(fn,ms)=>(durations.push(ms),durations.length),clearTimeout(){},fetch:async(url,options)=>{calls.push({url,options,timeout:durations.at(-1)});return {ok:true,json:async()=>url==='/api/health'?{ok:true,service:'dream-studio-runtime',csrfToken:'test-csrf',provider:{available:false,authenticated:false}}:url==='/api/roles'?{roles:[]}:url==='/api/connections'?{providers:[{id:'runninghub',keyConfigured:true,modelConnection:{keyConfigured:true}}]}:url==='/api/media/jobs'?{jobs:[]}:url.endsWith('/verify')?{verification:{verified:true}}:url==='/api/media/estimate'?{estimate:quote}:{ok:true}};}});
  await runtime.connect();assert.equal(runtime.ready(),false);assert.equal(runtime.connection.state,'online');
  await runtime.saveConnection({modelApiKey:'FAKE-MODEL-KEY'});
  await runtime.verifyRunningHub('model_api');
  const payload={provider:'runninghub',mode:'model_api',modelId:image.id,parameters:Runtime.modelParameters(image,{prompt:'船'}),projectId:null,quantity:1,budget:1};
  assert.deepEqual(await runtime.estimateMedia(payload),quote);
  assert.ok(!calls.some(call=>call.url==='/api/media/jobs'&&call.options.method==='POST'));
  const saved=JSON.parse(calls.find(call=>call.url==='/api/connections/runninghub').options.body);assert.deepEqual(saved,{modelApiKey:'FAKE-MODEL-KEY'});assert.ok(!JSON.stringify(runtime.media).includes('FAKE-MODEL-KEY'));
  assert.deepEqual(JSON.parse(calls.find(call=>call.url.endsWith('/verify')).options.body),{mode:'model_api'});
  const estimate=calls.find(call=>call.url==='/api/media/estimate');assert.equal(estimate.timeout,55000);assert.deepEqual(JSON.parse(estimate.options.body),payload);assert.equal(estimate.options.headers['X-Studio-Token'],'test-csrf');
});

test('provider text and JSON results render as inert expandable text in their own project only',()=>{
  const attack='</pre><img src=x onerror=alert(1)>\n<script>alert(2)</script>\nhttps://example.invalid/result';
  const textJob={id:'text-job-a',projectId:'text-project-a',status:'succeeded',outputs:[{url:'https://cdn.example.com/kept.png',outputType:'image'}],textOutputs:[{text:attack,outputType:'text</summary><script>alert(3)</script>'},{text:'{"elementId":"element-17","score":0.8}',outputType:'json',truncated:true},{text:{unsafe:'object'},outputType:'text'}]};
  const otherJob={id:'text-job-b',projectId:'text-project-b',status:'succeeded',outputs:[],textOutputs:[{text:'OTHER-PROJECT-TEXT',outputType:'text'}]};
  const V=views({keyConfigured:true},[textJob,otherJob]);
  const state={projects:[{id:'text-project-a',title:'甲项目',isDemo:false},{id:'text-project-b',title:'乙项目',isDemo:false}],activeProjectId:'text-project-a',artifacts:[]};
  const html=V.artifacts(state);
  assert.match(html,/<details class="media-text-result" data-runtime-detail="media-text-text-job-a-0">/);
  assert.ok(html.includes('&lt;/pre&gt;&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;elementId&quot;:&quot;element-17&quot;'));
  assert.ok(html.includes('当前显示服务端保留的截取部分'));
  assert.ok(!html.includes(attack));assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="https://example.invalid/result"'));assert.ok(!html.includes('[object Object]'));
  assert.ok(!html.includes('OTHER-PROJECT-TEXT'));
  assert.match(html,/<img src="https:\/\/cdn.example.com\/kept.png" data-media-preview-key=/);
  const other=V.artifacts({...state,activeProjectId:'text-project-b'});
  assert.ok(other.includes('OTHER-PROJECT-TEXT'));assert.ok(!other.includes('element-17'));assert.ok(!other.includes('kept.png'));
});

test('provider cost table reports model and workflow verification independently',()=>{
  for(const [provider,label] of [
    [{keyConfigured:true,verified:false,modelConnection:{keyConfigured:true,verified:true}},'模型已验证 · 工作流待验证'],
    [{keyConfigured:false,modelConnection:{keyConfigured:true,verified:true}},'模型已验证 · 工作流待配置'],
    [{keyConfigured:true,verified:true,modelConnection:{keyConfigured:true,verified:false}},'模型待验证 · 工作流已验证'],
    [{keyConfigured:false,modelConnection:{}},'模型待配置 · 工作流待配置']
  ]){
    const table=views(provider).connections().split('<section class="provider-costs surface">')[1].split('</section>')[0];
    assert.ok(table.includes(label));
  }
});
