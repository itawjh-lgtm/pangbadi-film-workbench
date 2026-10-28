'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {imageURL,fitScale,boundPan}=require('../lib/image-viewer.js');
test('image viewer accepts provider URLs and local assets but rejects executable and credential URLs',()=>{
  const base='http://127.0.0.1:8767/';
  assert.equal(imageURL('https://cdn.example.com/output?id=2',base),'https://cdn.example.com/output?id=2');
  assert.equal(imageURL('/assets/example.png',base),base+'assets/example.png');
  for(const value of ['', 'javascript:alert(1)','data:text/html,bad','file:///etc/passwd','https://user:secret@host.test/p.png','http://remote.test/p.png'])assert.equal(imageURL(value,base),'');
});
test('fit displays the entire portrait or landscape without enlarging small originals',()=>{
  assert.equal(fitScale(2000,1000,1048,648),.5);
  assert.equal(fitScale(1000,2000,1048,648),.3);
  assert.equal(fitScale(200,100,1048,648),1);
});
test('dragging enlarged images stays within bounds and fit images stay centered',()=>{
  assert.equal(boundPan(2000,2000,1000,1),500);
  assert.equal(boundPan(-2000,2000,1000,1),-500);
  assert.equal(boundPan(20,2000,1000,1),20);
  assert.equal(boundPan(500,2000,1000,.5),0);
});
