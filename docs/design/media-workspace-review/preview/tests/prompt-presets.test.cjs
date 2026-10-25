'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const library = require('../lib/prompt-presets.js');

test('ten distinct built-in styles provide editable visual directions', () => {
  assert.equal(library.presets.length, 10);
  assert.equal(new Set(library.presets.map(p => p.id)).size, 10);
  assert.equal(new Set(library.presets.map(p => p.prompt)).size, 10);
  for (const p of library.presets) {
    for (const field of ['id', 'name', 'tag', 'description', 'prompt', 'negative', 'icon']) {
      assert.equal(typeof p[field], 'string');
      assert.ok(p[field].trim().length, `${p.id}.${field} is populated`);
    }
    assert.equal(p.colors.length, 3);
    assert.ok(p.colors.every(color => /^#[0-9A-F]{6}$/i.test(color)));
    assert.equal(library.getPreset(p.id), p);
  }
  assert.equal(library.getPreset('custom'), null);
  assert.equal(library.getPreset(null), null);
});

test('composition preserves the complete subject including internal spacing and text requirements', () => {
  const subject = '两位摩托车骑手\n  画面右上角写“倾斜与平衡”；第一位穿蓝色衣服，第二位穿白色衣服。';
  const result = library.compose({ subject: `  ${subject}\n`, stylePrompt: '柔和水彩' });
  assert.equal(result.positive, `${subject}\n\n视觉风格：柔和水彩`);
  assert.equal(result.negative, '');
});

test('changing style replaces the current style instead of accumulating previous styles', () => {
  const subject = '一只蓝色折纸小船';
  const original = { subject, stylePrompt: library.getPreset('cute-3d').prompt };
  const first = library.compose(original);
  const second = library.compose({ ...original, stylePrompt: library.getPreset('ink-wash').prompt });
  assert.ok(first.positive.includes(library.getPreset('cute-3d').prompt));
  assert.ok(second.positive.includes(library.getPreset('ink-wash').prompt));
  assert.ok(!second.positive.includes(library.getPreset('cute-3d').prompt));
  assert.equal(library.compose({ subject, stylePrompt: '' }).positive, subject);
});

test('negative instructions stay separate from positive composition', () => {
  const result = library.compose({ subject: '清楚的结构示意图', negative: '  不要重复的车轮\n避免脏灰色  ' });
  assert.equal(result.positive, '清楚的结构示意图');
  assert.equal(result.negative, '不要重复的车轮\n避免脏灰色');
  assert.ok(!result.positive.includes('不要重复的车轮'));
});

test('motion is included only for video and ratio remains an explicit visual intention', () => {
  const input = { subject: '平静的湖面', motion: '固定机位，波纹缓慢扩散', ratio: '16:9' };
  const image = library.compose({ ...input, kind: 'image' });
  const video = library.compose({ ...input, kind: 'video' });
  assert.ok(!image.positive.includes(input.motion));
  assert.ok(video.positive.endsWith(`动态与镜头：${input.motion}`));
  assert.ok(video.positive.includes('画幅意图：16:9（最终尺寸以生成参数为准）'));
  assert.ok(!library.compose(input).positive.includes(input.motion));
});

test('empty and unsupported values produce no undefined text or empty labels', () => {
  for (const input of [undefined, null, '', 4, {}, { subject: null, stylePrompt: undefined, negative: false, ratio: {}, motion: [], kind: 'video' }]) {
    assert.deepEqual(library.compose(input), { positive: '', negative: '' });
  }
  assert.deepEqual(library.compose({ subject: '  ', stylePrompt: '\n', ratio: '\t', motion: '\n', negative: ' ', kind: 'video' }), { positive: '', negative: '' });
});

test('text is not executed and inputs or presets are not mutated', () => {
  const subject = '<script>throw new Error("not executable")</script> ${unsafe}';
  const input = Object.freeze({ subject, stylePrompt: library.getPreset('cute-3d').prompt, negative: 'blur', motion: 'slow', ratio: '1:1', kind: 'video' });
  const before = JSON.stringify(input);
  const result = library.compose(input);
  assert.ok(result.positive.startsWith(subject));
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(library.presets));
  assert.ok(Object.isFrozen(library.getPreset('cute-3d')));
  assert.ok(Object.isFrozen(library.getPreset('cute-3d').colors));
});

test('browser export works without CommonJS globals', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/prompt-presets.js'), 'utf8'), context);
  assert.equal(context.StudioPromptPresets.presets.length, 10);
  assert.equal(context.StudioPromptPresets.compose({ subject: '测试' }).positive, '测试');
});
