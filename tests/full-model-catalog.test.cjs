'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Runtime = require('../lib/runtime.js');
const root = path.resolve(__dirname,'..');
const source = JSON.parse(fs.readFileSync(path.join(root,'docs/api/runninghub/runtime-model-catalog.json'),'utf8'));
const catalog = source.models.map(item=>({...item,mediaKind:item.mediaType,vendor:item.family,category:item.capability,disabled:!item.available}));

function model(properties, required = []) {
  return {id:'test-model',available:true,defaults:{},fields:Object.entries(properties).map(([name,schema])=>({name,label:name,...schema,required:required.includes(name),schema}))};
}
function views() {
  const win = {}, context = vm.createContext({window:win,console,URL});
  for(const file of ['data/employees.js','data/project-templates.js','lib/views.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  const store = require('../lib/store.js').create(win.TEAM_EMPLOYEES,{storage:{getItem(){return null;},setItem(){}},host:null});
  return win.StudioViews.create(win.TEAM_EMPLOYEES,store);
}

test('Seedream 5 Pro custom dimensions suppress only an implicit resolution default',()=>{
  for(const id of ['seedream-v5-pro/text-to-image','seedream-v5-pro/image-to-image']){
    const record=source.models.find(item=>item.id===id),spec={...model(record.schema.properties,record.schema.required),id,defaults:{resolution:'2k',width:1024,height:1024,outputFormat:'jpeg'}},input={prompt:'二维青春漫画人物定妆',width:1152,height:2048,outputFormat:'png',...(id.endsWith('/image-to-image')?{imageUrls:['https://cdn.example.invalid/hero.png']}:{})};
    const before=JSON.stringify(input),result=Runtime.modelParameters(spec,input);
    assert.equal(result.width,1152);assert.equal(result.height,2048);assert.equal(result.outputFormat,'png');assert.ok(!Object.hasOwn(result,'resolution'));assert.equal(JSON.stringify(input),before);
    const explicit=Runtime.modelParameters(spec,{...input,resolution:'1k'});assert.equal(explicit.resolution,'1k');assert.equal(explicit.width,1152);
    const {width,height,...automatic}=input;assert.equal(Runtime.modelParameters(spec,automatic).resolution,'2k');
    const oneDimension=Runtime.modelParameters(spec,{...automatic,width:1536});assert.equal(oneDimension.height,1024);assert.ok(!Object.hasOwn(oneDimension,'resolution'));
    assert.throws(()=>Runtime.modelParameters({...spec,available:false,disabledReason:'接口已下架'},input),/已下架/);
  }
});

test('resolution defaults remain intact for other models with width and height inputs',()=>{
  const spec={...model({prompt:{type:'string'},width:{type:'integer'},height:{type:'integer'},resolution:{type:'string',default:'2k'}}),id:'other-image-model'};
  assert.equal(Runtime.modelParameters(spec,{prompt:'test',width:1152,height:2048}).resolution,'2k');
});

test('the picker preserves all 311 operation IDs and visibly disables all four retired entries', () => {
  const html = views().mediaModelOptions(catalog);
  const options = [...html.matchAll(/<option\b([^>]*)value="([^"]+)"([^>]*)>/g)];
  assert.equal(options.length,311);
  assert.equal(new Set(options.map(match=>match[2])).size,311);
  for(const entry of catalog) {
    const option = options.find(match=>match[2]===entry.id);
    assert.ok(option,entry.id);
    assert.equal(/\bdisabled\b/.test(option[1]+option[3]),!entry.available,entry.id);
    assert.equal(Runtime.modelAvailable(entry),entry.available,entry.id);
  }
  assert.equal(options.filter(match=>/\bdisabled\b/.test(match[1]+match[3])).length,4);
});

test('catalog filtering supports media type, exact family, capability and multiple search terms', () => {
  assert.equal(Runtime.filterMediaModels(catalog,{kind:'image'}).length,99);
  assert.equal(Runtime.filterMediaModels(catalog,{kind:'video'}).length,212);
  const chosen = catalog.find(entry=>entry.available&&entry.id.includes('seedance'));
  const filtered = Runtime.filterMediaModels(catalog,{kind:chosen.mediaKind,vendor:chosen.vendor,category:chosen.category,query:'seedance '+chosen.id.split('/').at(-1)});
  assert.ok(filtered.some(entry=>entry.id===chosen.id));
  assert.ok(filtered.every(entry=>entry.mediaKind===chosen.mediaKind&&entry.vendor===chosen.vendor&&entry.category===chosen.category));
  assert.deepEqual(Runtime.filterMediaModels(catalog,{query:'no-such-model-abcxyz'}),[]);
});

test('empty optional values are omitted while explicit false, zero and numeric enum values retain their real types', () => {
  const spec = model({prompt:{type:'string'},enabled:{type:'boolean'},seed:{type:'integer',minimum:0},strength:{type:'number',minimum:0,maximum:1},count:{type:'integer',enum:[0,1,2]},optional:{type:'number'}},['enabled','seed','count']);
  assert.deepEqual(Runtime.modelParameters(spec,{prompt:'',enabled:'false',seed:'0',strength:0,count:'0',optional:''}),{enabled:false,seed:0,strength:0,count:0});
  assert.throws(()=>Runtime.modelParameters(spec,{enabled:'',seed:'0',count:'0'}),/enabled/);
  assert.throws(()=>Runtime.modelParameters(spec,{enabled:'no',seed:'0',count:'0'}),/true|false/);
  assert.throws(()=>Runtime.modelParameters(spec,{enabled:false,seed:'0',count:'3'}),/选项/);
});

test('complex JSON arrays and objects preserve nested values instead of flattening or stringifying them', () => {
  const spec = model({frames:{type:'array',minItems:1,items:{
    type:'object',additionalProperties:false,required:['name','weight','enabled'],
    properties:{name:{type:'string'},weight:{type:'number'},enabled:{type:'boolean'}}
  }}},['frames']);
  const input = '[{"name":"第一行\\n第二行","weight":0,"enabled":false}]';
  assert.deepEqual(Runtime.modelParameters(spec,{frames:input}),{frames:[{name:'第一行\n第二行',weight:0,enabled:false}]});
  assert.throws(()=>Runtime.modelParameters(spec,{frames:'[{bad json]'}),/合法 JSON/);
  assert.throws(()=>Runtime.modelParameters(spec,{frames:'{}'}),/数组/);
  assert.throws(()=>Runtime.modelParameters(spec,{frames:'[{"name":"x","weight":"0","enabled":false}]'}),/数字/);
  assert.throws(()=>Runtime.modelParameters(spec,{frames:'[{"name":"x","weight":0,"enabled":false,"extra":1}]'}),/未支持/);
  assert.throws(()=>Runtime.modelParameters(spec,{frames:'[]'}),/数量/);
});

test('all URI formats reject executable, local-file and credential URLs before a quote request', () => {
  for(const format of ['uri','url','https']) {
    const spec = model({'131##image':{type:'string',format},images:{type:'array',items:{type:'string',format}}});
    assert.deepEqual(Runtime.modelParameters(spec,{'131##image':'https://cdn.example.invalid/a.png',images:'["https://cdn.example.invalid/b.png"]'}),{'131##image':'https://cdn.example.invalid/a.png',images:['https://cdn.example.invalid/b.png']});
    for(const url of ['javascript:alert(1)','file:///tmp/a.png','data:image/png;base64,abc','https://user:pass@cdn.example.invalid/a.png']) {
      assert.throws(()=>Runtime.modelParameters(spec,{'131##image':url}),/HTTPS/);
      assert.throws(()=>Runtime.modelParameters(spec,{images:JSON.stringify([url])}),/HTTPS/);
    }
  }
});

test('numeric ranges, decimal steps, exclusive limits and integer precision match safe schema input', () => {
  const spec = model({strength:{type:'number',minimum:0,maximum:1,multipleOf:0.1},strict:{type:'number',exclusiveMinimum:0,exclusiveMaximum:1},seed:{type:'integer'}});
  assert.deepEqual(Runtime.modelParameters(spec,{strength:'0.3',strict:'0.5',seed:'0'}),{strength:0.3,strict:0.5,seed:0});
  for(const value of ['0.15','-0.1','1.1'])assert.throws(()=>Runtime.modelParameters(spec,{strength:value}));
  for(const value of [0,1])assert.throws(()=>Runtime.modelParameters(spec,{strict:value}));
  for(const value of ['1.2','9007199254740993','Infinity','NaN'])assert.throws(()=>Runtime.modelParameters(spec,{seed:value}));
});

test('array enums, uniqueness and nested required fields are enforced', () => {
  const spec = model({slots:{type:'array',minItems:1,maxItems:2,uniqueItems:true,items:{type:'string',enum:['image1','image2']}},settings:{type:'object',additionalProperties:false,required:['active'],properties:{active:{type:'boolean'}}}});
  assert.deepEqual(Runtime.modelParameters(spec,{slots:'["image1","image2"]',settings:'{"active":false}'}),{slots:['image1','image2'],settings:{active:false}});
  for(const value of ['["image1","image1"]','["video1"]','["image1","image2","image1"]'])assert.throws(()=>Runtime.modelParameters(spec,{slots:value}));
  assert.throws(()=>Runtime.modelParameters(spec,{settings:'{}'}),/active/);
});

test('nullable fields still respect enum and const rather than bypassing schema restrictions', () => {
  const allowed = model({setting:{type:'string',nullable:true,enum:[null,'a']}});
  assert.deepEqual(Runtime.modelParameters(allowed,{setting:null}),{setting:null});
  const enumBlocked = model({setting:{type:'string',nullable:true,enum:['a']}});
  assert.throws(()=>Runtime.modelParameters(enumBlocked,{setting:null}));
  const constBlocked = model({setting:{type:'string',nullable:true,const:'a'}});
  assert.throws(()=>Runtime.modelParameters(constBlocked,{setting:null}));
});

test('documentation examples are never inserted into generated parameters', () => {
  const spec = model({prompt:{type:'string',example:'不应进入请求的示例'},images:{type:'array',items:{type:'string',format:'uri'},examples:[['https://example.invalid/sample.png']]}});
  assert.deepEqual(Runtime.modelParameters(spec,{}),{});
  const html = views().mediaModelFields(spec);
  const fields = [...html.matchAll(/<(?:textarea|input|select)\b[^>]*data-model-param="([^"]+)"[^>]*>([\s\S]*?)<\/(?:textarea|select)>/g)];
  assert.ok(fields.length>=1);
  assert.ok(!fields.some(match=>match[2].includes('不应进入请求的示例')||match[2].includes('sample.png')));
});

test('generated controls support required false, numeric zero, JSON arrays and unchanged node keys', () => {
  const spec = model({enabled:{type:'boolean'},'227##value':{type:'integer',minimum:0,maximum:30},items:{type:'array',items:{type:'string'}}},['enabled']);
  const html = views().mediaModelFields(spec,{enabled:false,'227##value':0,items:['a','b']});
  assert.match(html,/<select\b[^>]*data-model-param="enabled"[^>]*required/);
  assert.match(html,/<option value="false" selected>/);
  assert.ok(!/<input\b[^>]*type="checkbox"[^>]*required/.test(html));
  assert.match(html,/<input\b(?=[^>]*type="number")(?=[^>]*data-model-param="227##value")(?=[^>]*value="0")/);
  assert.match(html,/<textarea\b[^>]*data-model-param="items"/);
  assert.deepEqual(Runtime.modelParameters(spec,{enabled:'false','227##value':'0',items:'["a","b"]'}),{enabled:false,'227##value':0,items:['a','b']});
});

test('retired or unavailable contracts cannot be normalized for submission', () => {
  for(const state of [{available:false},{enabled:false},{disabled:true},{deprecated:true}]) {
    assert.throws(()=>Runtime.modelParameters({...model({prompt:{type:'string'}}),...state,disabledReason:'接口已下架'},{prompt:'hello'}),/已下架/);
  }
});
