'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {create,safeMediaURL,outputKind,statusLabel}=require('../lib/media-views.js');
const provider={id:'runninghub',keyConfigured:true,configured:true,config:{workflowId:'123456',currency:'CNY'}};
const job={id:'job-1',projectId:'project-1',title:'首帧',status:'succeeded',source:'api',mediaType:'image',task_id:'9988',createdAt:'2026-10-25T00:00:00Z',outputs:[{url:'https://cdn.example.com/result.png',outputType:'png'}]};
const project={id:'project-1',title:'可爱摩托车科普'};
const views=jobs=>create({connection:{state:'online'},media:{providers:[provider],jobs,error:''}});

test('remote media allows HTTPS public domain and disallows credentials, IP and local endpoints',()=>{
  assert.equal(safeMediaURL('https://cdn.example.com/result.png'),'https://cdn.example.com/result.png');
  for(const url of ['http://cdn.example.com/result.png','javascript:alert(1)','data:image/png;base64,ABC','https://user:secret@cdn.example.com/a.png','https://127.0.0.1/a.png','https://2130706433/a.png','https://[::1]/a.png','https://localhost/a.png','https://localhost./a.png','https://foo.localhost/a.png','https://foo.local/a.png','https://host.internal/a.png','https://localhost.localdomain/a.png','https://cdn.example.com:8080/a.png','https://cdn.example.com/a\nb.png','https://cdn.example.com\\@localhost/a.png'])assert.equal(safeMediaURL(url),'',url);
});
test('local preview paths are restricted to exact static asset syntax',()=>{
  assert.equal(safeMediaURL('/assets/qa-media/sample.png'),'/assets/qa-media/sample.png');
  assert.equal(safeMediaURL('/assets/qa-media/sample.mp4'),'/assets/qa-media/sample.mp4');
  for(const path of ['/api/secrets','/assets/../config.png','/assets//qa-media/sample.png','//example.com/sample.png','/assets/%2e%2e/config.png','/assets/sample.svg','/assets/sample.png?redirect=/api/config'])assert.equal(safeMediaURL(path),'',path);
  assert.equal(outputKind({url:'/assets/qa-media/sample.mp4'}),'video');
});
test('image and video classification handles typed signed URLs, but leaves unknown files unembedded',()=>{
  assert.equal(outputKind({url:'https://cdn.example.com/download?token=public',outputType:'image/png'}),'image');
  assert.equal(outputKind({url:'https://cdn.example.com/download',outputType:'video/mp4'}),'video');
  assert.equal(outputKind({url:'https://cdn.example.com/a.WEBM?download=true'}),'video');
  assert.equal(outputKind({url:'https://cdn.example.com/page.html'}),'');
});
test('project workspace cannot display another project media even if UI selection references it',()=>{
  const html=views([job,{...job,id:'private',projectId:'other-project',title:'Other project secret',outputs:[{url:'https://cdn.example.com/private.png'}]}]).workspace(project,{selectedJobId:'private'});
  assert.ok(html.includes('result.png'));
  assert.ok(!html.includes('private.png'));
  assert.ok(!html.includes('Other project secret'));
  assert.ok(html.includes('data-id="job-1"'));
});
test('media previews are escaped, stable and never auto-play',()=>{
  const html=views([]).preview({...job,title:'<img src=x onerror="alert(1)">',outputs:[{url:'https://cdn.example.com/result.mp4',outputType:'mp4'}]});
  assert.match(html,/<video controls preload="metadata" playsinline/);
  assert.match(html,/data-media-preview-key="job-1:0:https:/);
  assert.ok(!html.includes('autoplay'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.match(html,/data-media-fallback hidden/);
  assert.match(html,/referrerpolicy="no-referrer"/);
});
test('invalid URLs never become preview src or links and successful empty results remain truthful',()=>{
  const html=views([]).preview({...job,outputs:[{url:'javascript:alert(1)',outputType:'image'}]});
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('没有可预览的图片或视频链接'));
});
test('external registration has distinct label and no polling action',()=>{
  const external={...job,source:'external',sourceUrl:'https://www.runninghub.cn/projects'};
  const html=views([external]).workspace(project);
  assert.equal(statusLabel(external),'外部结果 · 已登记');
  assert.ok(html.includes('不自动同步平台进度'));
  assert.ok(!html.includes('data-action="media-refresh-job"'));
});
test('unknown result protects against accidental retry and displays received history only',()=>{
  const html=views([{...job,status:'unknown',outputs:[],lastRefreshError:'timeout',history:[{status:'queued',text:'平台已受理',at:job.createdAt}]}]).workspace(project);
  assert.ok(html.includes('不要重复提交'));
  assert.ok(html.includes('平台已受理'));
  assert.ok(html.includes('最近一次查询未成功'));
  assert.ok(!html.includes('data-action="media-retry"'));
  assert.ok(!html.includes('83%'));
});
test('settings retain existing estimate contract and expose opt-in source text',()=>{
  const html=views([]).workspace(project,{kind:'video'},[{id:'source-1',title:'R06 · 生成输入',body:'unrendered source'}]);
  for(const expected of ['data-form="media-estimate"','name="workflowId"','name="nodeInfoList"','name="budget"','name="mediaType" value="video"','name="quantity" value="1"','data-workflow-editor','data-media-source-text readonly hidden','data-action="media-copy-source"'])assert.ok(html.includes(expected),expected);
  assert.ok(!html.includes('unrendered source'));
  assert.ok(!html.includes('name="apiKey"'));
});
test('registration form is explicit about its evidence boundary and has required fields',()=>{
  const html=views([]).importForm(project);
  for(const field of ['title','mediaType','url','sourceUrl','taskId'])assert.ok(html.includes('name="'+field+'"'));
  assert.ok(html.includes('不自动同步平台进度'));
  assert.ok(html.includes('内容质量与视频完整播放需要另行检查'));
});
