'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const presets = require('../lib/prompt-presets.js');
const source = fs.readFileSync(path.join(__dirname, '../lib/prompt-studio.js'), 'utf8');
const KEY = 'dream-studio-media-design-prompts-v1';

// Minimal event/element doubles exercise editor state without a browser or network.
function setup(storage = new Map(), initialKind = 'image') {
  const handlers = {};
  const classes = new Set();
  const body = { innerHTML: '' };
  const output = { value: '', focus() {}, select() {} };
  const dialog = {
    open: false,
    classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    showModal() { this.open = true; }
  };
  const document = {
    activeElement: null,
    addEventListener: (name, handler) => { handlers[name] = handler; },
    querySelector: selector => selector === '#preview-dialog' ? dialog : selector === '#dialog-body' ? body : selector === '.prompt-final' ? output : null
  };
  const context = vm.createContext({ document, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, StudioPromptPresets: presets });
  context.window = context;
  vm.runInContext(source, context);
  const editor = context.StudioPromptStudio.create({ getKind: () => initialKind });
  function click(action) {
    const target = { dataset: { promptAction: action }, closest: selector => selector === '[data-prompt-action]' ? target : null };
    handlers.click({ target });
  }
  return { editor, storage, click, body };
}

test('manual text survives a quick style change and both display contexts expose the pending merge', () => {
  const saved = { version: 1, states: { image: { manual: true, manualPositive: '我亲自写的完整提示词', ratio: '16:9' } } };
  const { editor } = setup(new Map([[KEY, JSON.stringify(saved)]]));
  editor.choose('watercolor', 'image');
  assert.equal(editor.final('image').positive, '我亲自写的完整提示词');
  assert.equal(editor.get('image').manualStale, true);
  assert.match(editor.inline('image'), /手动全文 · 新设置尚未合并/);
  assert.match(editor.manualNotice('image'), /data-prompt-action="open"/);
  assert.match(editor.manualNotice('image'), /将继续使用保留的手动稿/);
  assert.equal(editor.manualNotice('video'), '');
});

test('image and video ratio choices remain independent through save and reload', () => {
  const first = setup();
  first.editor.setRatio('image', '9:16');
  first.editor.setRatio('video', '1:1');
  first.editor.setRatio('video', '<invalid>');
  const restored = setup(first.storage).editor;
  assert.equal(restored.get('image').ratio, '9:16');
  assert.equal(restored.get('video').ratio, '1:1');
  assert.match(restored.final('image').positive, /画幅意图：9:16/);
  assert.match(restored.final('video').positive, /画幅意图：1:1/);
  assert.ok(!restored.final('image').positive.includes('画幅意图：1:1'));
});

test('ratio edits mark only their own manual draft as pending', () => {
  const saved = { version: 1, states: {
    image: { manual: true, manualPositive: '图片手动稿', ratio: '16:9' },
    video: { manual: true, manualPositive: '视频手动稿', ratio: '16:9' }
  } };
  const { editor } = setup(new Map([[KEY, JSON.stringify(saved)]]));
  editor.setRatio('video', '9:16');
  assert.equal(editor.get('image').manualStale, false);
  assert.equal(editor.get('video').manualStale, true);
  assert.equal(editor.final('video').positive, '视频手动稿');
});

test('older manual drafts without a saved ratio are retained and flagged for review', () => {
  const saved = { version: 1, states: { image: { manual: true, manualPositive: '旧稿指定9:16画面' } } };
  const { editor } = setup(new Map([[KEY, JSON.stringify(saved)]]));
  assert.equal(editor.final('image').positive, '旧稿指定9:16画面');
  assert.equal(editor.get('image').ratio, '16:9');
  assert.equal(editor.get('image').manualStale, true);
});

test('a legal long video composition survives manual editing and storage reload intact', () => {
  const saved = { version: 1, states: { video: { subject: '主体'.repeat(8000), stylePrompt: '风格'.repeat(8000), motion: '动作'.repeat(3000), ratio: '9:16' } } };
  const first = setup(new Map([[KEY, JSON.stringify(saved)]]), 'video');
  const expected = first.editor.final('video').positive;
  assert.ok(expected.length > 38000);
  first.click('open');
  first.click('manual');
  assert.equal(first.editor.final('video').positive, expected);
  assert.match(first.body.innerHTML, /maxlength="40000"/);
  first.click('recompose');
  const restored = setup(first.storage).editor;
  assert.equal(restored.get('video').manualPositive, expected);
  assert.equal(restored.get('video').previousManual, expected);
  assert.equal(restored.final('video').positive, expected);
});

test('restoring existing text never silently truncates a saved custom style or hand-written draft', () => {
  const manual = '手动稿'.repeat(14000) + '结尾必须保留';
  const style = '风格'.repeat(9000) + '风格结尾';
  const saved = { version: 1, custom: [{ id: 'custom-old', name: '旧风格', prompt: style, negative: '' }], states: { image: { manual: true, manualPositive: manual, previousManual: manual, ratio: '16:9' } } };
  const first = setup(new Map([[KEY, JSON.stringify(saved)]]));
  first.editor.choose('custom-old', 'image');
  const restored = setup(first.storage).editor;
  assert.equal(restored.final('image').positive, manual);
  assert.equal(restored.get('image').previousManual, manual);
  assert.equal(restored.get('image').stylePrompt, style);
});
