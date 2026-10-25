const test=require('node:test');
const assert=require('node:assert/strict');
const {create,cleanPreferences,bounds}=require('../lib/layout.js');

test('损坏的布局偏好不会进入布局或覆盖项目数据',()=>{
  for(const value of [null,[],true,'invalid',42])assert.deepEqual(cleanPreferences(value),{});
  assert.deepEqual(cleanPreferences({sidebar:'300',review:NaN,team:Infinity,tasks:['done'],project:{title:'keep'}}),{});
});
test('异常宽度及比例受限，各页面偏好独立保留',()=>{
  const source={sidebar:900,review:-5,team:2,overview:.6,workstation:.7,connections:.55};
  assert.deepEqual(cleanPreferences(source),{sidebar:360,review:.05,team:.95,overview:.6,workstation:.7,connections:.55});
  assert.equal(source.sidebar,900);
  assert.equal(cleanPreferences({sidebar:-40}).sidebar,200);
});
test('扣除分隔间距后同时保护左右栏的最小阅读宽度',()=>{
  const sizing=bounds(1000,17,340,310);
  assert.deepEqual(sizing,{available:983,min:340,max:673,fits:true});
  assert.equal(sizing.available-sizing.max,310);
});
test('窄容器精确到边界时堆叠，不产生负宽度',()=>{
  assert.equal(bounds(667,17,340,310).fits,true);
  assert.equal(bounds(666,17,340,310).fits,false);
  assert.equal(bounds(0,17,340,310).available,0);
  assert.equal(bounds(0,17,340,310).fits,false);
});
test('宽屏档案栏保持合理上限，仍给列表保留阅读空间',()=>{
  const sizing=bounds(1608,20,360,260,480);
  assert.equal(sizing.available-sizing.min,480);
  assert.equal(sizing.available-sizing.max,260);
  assert.equal(bounds(600,20,360,260,480).fits,false);
});

test('协作栏折叠偏好只接受布尔值并与拖动宽度一起保留',()=>{
  assert.deepEqual(cleanPreferences({review:.65,discussionCollapsed:true}),{review:.65,discussionCollapsed:true});
  assert.deepEqual(cleanPreferences({discussionCollapsed:false}),{discussionCollapsed:false});
  for(const value of ['false','true',1,0,null,{}])assert.deepEqual(cleanPreferences({discussionCollapsed:value}),{});
});

test('收起和展开协作可跨实例恢复且不写入项目记录',()=>{
  const records=new Map([['creative-workbench-layout-v1',JSON.stringify({review:.64,sidebar:260})],['creative-workbench-v3','project records remain untouched']]);
  const win={localStorage:{getItem:key=>records.get(key)||null,setItem:(key,value)=>records.set(key,value)},addEventListener(){}};
  const root={ownerDocument:{defaultView:win}},first=create(root);
  assert.equal(first.isDiscussionCollapsed(),false);assert.equal(first.setDiscussionCollapsed(true),true);
  const restored=create(root);assert.equal(restored.isDiscussionCollapsed(),true);
  assert.deepEqual(JSON.parse(records.get('creative-workbench-layout-v1')),{sidebar:260,discussionCollapsed:true,review:.64});
  assert.equal(restored.setDiscussionCollapsed(false),false);assert.equal(create(root).isDiscussionCollapsed(),false);
  assert.equal(records.get('creative-workbench-v3'),'project records remain untouched');
});

test('单栏项目页不建立拖拽分隔线，展开的讨论布局仍可调整',()=>{
  const makeElement=(classes='')=>{
    const classNames=new Set(classes.split(' ').filter(Boolean)),element={clientWidth:1200,children:[],style:{setProperty(){}},classList:{add:name=>classNames.add(name),remove:name=>classNames.delete(name),contains:name=>classNames.has(name)},setAttribute(){},addEventListener(){},querySelector(){return null;},append(child){this.children.push(child);},remove(){},firstElementChild:{id:'main'}};
    return element;
  };
  for(const extra of ['','is-canvas','is-character-assets','is-discussion-collapsed']){
    const section=makeElement('project-review-layout '+extra),win={innerWidth:1400,localStorage:{getItem(){return null;},setItem(){}},addEventListener(){},getComputedStyle(){return {paddingLeft:'0',paddingRight:'0',columnGap:'17',gridTemplateColumns:'720px 463px',getPropertyValue(){return '240px';}};}};
    const root=makeElement(),doc={defaultView:win,createElement:()=>makeElement()};root.ownerDocument=doc;
    root.querySelector=selector=>{if(!selector.startsWith('.project-review-layout'))return null;const exclusions=[...selector.matchAll(/:not\(\.([\w-]+)\)/g)].map(match=>match[1]);return exclusions.some(name=>section.classList.contains(name))?null:section;};
    create(root).refresh();
    assert.equal(section.children.filter(child=>child.id==='layout-separator-review').length,extra?0:1,extra||'expanded discussion');
  }
});
