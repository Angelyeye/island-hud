'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/renderer/presentation');
test('display policy separates hover, manual collapse, protected editing and completion deduplication', () => {
  let now = 10000; const policy = new P.DisplayPolicy({ now: () => now });
  policy.enter(); now += 149; assert.equal(policy.scene(), 'compact'); now++;
  assert.equal(policy.scene(), 'overview'); policy.protected = true; policy.leave(); now += 1000; assert.equal(policy.scene(), 'overview');
  policy.protected = false; assert.equal(policy.scene(), 'compact');
  policy.manual(null); const session = { id: 'S', turn: 3, completedAt: now };
  assert.equal(policy.recordCompletion(session), true); assert.equal(policy.recordCompletion(session), false);
  assert.equal(policy.scene(), 'compact'); policy.configure({ completionReveal: 'expanded' }); assert.equal(policy.scene(), 'jump');
  policy.enter(); now += 4000; policy.scene(); assert.ok(policy.completion);
  policy.manual('compact'); assert.equal(policy.scene(), 'compact');
  policy.leave(); now += 5001; policy.scene(); assert.equal(policy.completion, null);
});
test('layout uses logical pixels and bounds both density modes inside a small work area', () => {
  assert.equal(P.geometry().width, 520); assert.equal(P.geometry({ panelDensity: 'compact' }).width, 440);
  const small = P.geometry({}, { workArea: { width: 360, height: 500 }, reducedMotion: true });
  assert.equal(small.width, 328); assert.equal(small.maxHeight, 436); assert.equal(small.reduced, true);
  assert.equal(P.normalize({ panelDensity: 'bad', contentFontSize: 100, completionDwellMs: -1 }).contentFontSize, 16);
});
test('local Markdown escapes HTML, strips dangerous links, never emits images and preserves code', () => {
  const html = P.markdown('# 中文标题\n\n- **清单**\n- `inline`\n\n> 引用\n\n<script>alert(1)</script>\n\n![remote](https://example.com/a.png)\n\n[bad](javascript:alert) [ok](https://example.com/test)\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.ok(html.includes('<h2>中文标题</h2>')); assert.ok(html.includes('<ul>')); assert.ok(html.includes('<blockquote>'));
  assert.doesNotMatch(html, /<script|<img|href="javascript:|onerror="/i);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('data-external-url="https://example.com/test"'));
  assert.equal(Array.from(P.summary('中😀'.repeat(1000)).text).length, 1200);
});
