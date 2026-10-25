'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Canvas=require('../lib/canvas.js');
const person={id:'person-a',nodeKind:'character',mediaKind:'image',jobIds:['job-a']};
const success={id:'job-a',projectId:'project-a',status:'succeeded',createdAt:1,outputs:[{url:'https://example.com/portrait.png',outputType:'image'}]};

test('art preview only uses successful media belonging to the current project and node',()=>{
  const jobs=[{...success,projectId:'other'},{...success,status:'failed'},{...success,id:'other',canvasNodeId:'other'}];
  assert.equal(Canvas.previewFor(person,null,jobs,'project-a').url,'');
  assert.equal(Canvas.previewFor(person,null,[...jobs,success],'project-a').url,success.outputs[0].url);
  assert.equal(Canvas.previewFor(person,null,[{...success,outputs:[{url:'javascript:alert(1)',outputType:'image'}]}],'project-a').url,'');
  assert.equal(Canvas.previewFor(person,null,[],'project-a').label,'尚无人物定妆图');
});
test('the preview distinguishes the review candidate from an adopted character reference',()=>{
  const asset={referenceUrl:'https://example.com/adopted.png',reviewCandidate:{url:'https://example.com/candidate.png'}};
  assert.deepEqual(Canvas.previewFor(person,asset,[],'project-a'),{url:asset.reviewCandidate.url,video:false,label:'当前定妆候选'});
  delete asset.reviewCandidate;
  assert.deepEqual(Canvas.previewFor(person,asset,[],'project-a'),{url:asset.referenceUrl,video:false,label:'已采用定妆'});
  assert.equal(Canvas.previewFor({...person,nodeKind:'shot',mediaKind:'video'},null,[{...success,outputs:[{url:'https://example.com/shot.mp4',outputType:'video'}]}],'project-a').video,true);
});
test('closing and reopening editors retains per-character AI instruction drafts without crossing roles',()=>{
  const entry={};
  const first=Canvas.editorDraftFor(entry,'person-a');first.instruction='保留服装，优化人物表情';first.aiOpen=true;
  const second=Canvas.editorDraftFor(entry,'person-b');second.instruction='人物要更活泼';
  assert.equal(Canvas.editorDraftFor(entry,'person-a').instruction,'保留服装，优化人物表情');
  assert.equal(Canvas.editorDraftFor(entry,'person-b').instruction,'人物要更活泼');
  assert.equal(Canvas.editorDraftFor(entry,'person-b').aiOpen,false);
  assert.notEqual(first,second);
});
test('edited optimization recommendations survive updates only for their exact originating request',()=>{
  const draft={requestId:'request-a',suggestion:'已手改的建议'},result={requestId:'request-a',recommendation:'伙伴原始建议'};
  assert.equal(Canvas.suggestionValue(draft,result),'已手改的建议');
  assert.equal(Canvas.suggestionValue(draft,{...result,requestId:'request-b',recommendation:'新一轮建议'}),'新一轮建议');
  assert.equal(Canvas.suggestionValue({requestId:'request-a',suggestion:''},result),'');
  assert.equal(Canvas.suggestionValue(undefined,result),'伙伴原始建议');
});

test('a deleted or switched character cannot be edited through the previous editor binding',()=>{
  const entry={ui:{activeId:'person-a'},doc:{nodes:[{id:'person-a'},{id:'person-b'}]}};
  assert.equal(Canvas.editorContextMatches(entry,'person-a'),true);
  entry.doc.nodes=entry.doc.nodes.filter(item=>item.id!=='person-a');entry.ui.activeId='person-b';
  assert.equal(Canvas.editorContextMatches(entry,'person-a'),false);
  assert.equal(Canvas.editorContextMatches(entry,'person-b'),true);
  assert.equal(Canvas.editorContextMatches(entry,''),false);
  entry.ui.activeId='person-a';
  assert.equal(Canvas.editorContextMatches(entry,'person-a'),false);
});
test('a remounted dialog regains native modality while preserving the editor focus selection and scroll',()=>{
  const prompt={selectionStart:17,selectionEnd:24,selectionDirection:'backward',scrollTop:92,scrollLeft:0,focus(options){this.focusOptions=options;},setSelectionRange(...selection){this.selectionRestored=selection;}};
  const scroller={scrollTop:340,scrollLeft:0};let modal=true,closed=0,opened=0;
  const dialog={isConnected:true,open:true,contains:element=>[prompt,scroller].includes(element),querySelectorAll:()=>[scroller,prompt],matches:()=>modal,close(){this.open=false;closed++;},showModal(){this.open=true;modal=true;opened++;scroller.scrollTop=0;prompt.scrollTop=0;}};
  const view=Canvas.capturePromptDialogView(dialog,prompt,null);
  modal=false;
  assert.equal(Canvas.restorePromptDialogModal(dialog,view),true);
  assert.equal(closed,1);assert.equal(opened,1);assert.equal(dialog.open,true);
  assert.deepEqual(prompt.focusOptions,{preventScroll:true});assert.deepEqual(prompt.selectionRestored,[17,24,'backward']);
  assert.equal(scroller.scrollTop,340);assert.equal(prompt.scrollTop,92);
  assert.equal(Canvas.restorePromptDialogModal(dialog,view),false);assert.equal(opened,1);
  modal=false;dialog.isConnected=false;
  assert.equal(Canvas.restorePromptDialogModal(dialog,view),false);assert.equal(opened,1);
});
test('the remembered modal field is used when document focus was lost while detaching its host',()=>{
  const focus={selectionStart:3,selectionEnd:3,selectionDirection:'none',scrollTop:0,scrollLeft:0};
  const dialog={contains:element=>element===focus,querySelectorAll:()=>[focus]};
  assert.equal(Canvas.capturePromptDialogView(dialog,{},focus).focus,focus);
  assert.equal(Canvas.capturePromptDialogView(dialog,{},{}).focus,null);
});
