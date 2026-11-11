'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/renderer/presentation');
test('the materialization boundary drops inline handlers and non-http(s) URLs even if a tree carried them', () => {
  const seen = [];
  const track = kind => { const node = { kind, kids: [], attrs: {} }; seen.push(node); node.append = child => node.kids.push(child); node.setAttribute = (name, value) => { node.attrs[name] = value; }; return node; };
  const doc = {
    createTextNode: value => { const node = track('text'); node.text = value; return node; },
    createElement: tag => { const node = track('element'); node.tag = tag; return node; },
    createElementNS: (ns, tag) => { const node = track('element'); node.ns = ns; node.tag = tag; return node; },
    createDocumentFragment: () => track('fragment'),
  };
  P.material({ tag: 'a', attrs: { href: 'https://example.com/ok', 'data-external-url': 'https://example.com/ok',
    onclick: 'alert(1)', onerror: 'alert(1)', title: '示例', style: '--bar:13px' },
    kids: ['正文', { tag: 'img', attrs: { src: 'data:image/png;base64,AAAA' } }] }, doc);
  const anchor = seen.find(n => n.tag === 'a');
  assert.equal(anchor.attrs.href, 'https://example.com/ok');
  assert.equal(anchor.attrs['data-external-url'], 'https://example.com/ok');
  assert.equal(anchor.attrs.title, '示例');
  assert.equal(anchor.attrs.style, '--bar:13px', 'static style from view code still applies');
  assert.equal(anchor.attrs.onclick, undefined, 'inline handlers never reach setAttribute');
  assert.equal(anchor.attrs.onerror, undefined);
  const img = seen.find(n => n.tag === 'img');
  assert.equal(img.attrs.src, undefined, 'data: URLs are dropped at the boundary');
});
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
  const handoff = P.normalize({ approvalHandoffSeconds: 999 });
  assert.equal(handoff.approvalHandoffSeconds, 120);
  assert.equal(P.normalize({}).approvalHandoffSeconds, 0);
  assert.equal(P.normalize({ approvalHandoffSeconds: 0 }).approvalHandoffSeconds, 0);
  assert.equal(P.normalize({ approvalHandoffSeconds: 7.6 }).approvalHandoffSeconds, 8);
});
test('display targeting keeps a connected choice and falls back to the primary display', () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const secondary = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } };
  assert.equal(P.selectDisplay([primary, secondary], 2, primary), secondary);
  assert.equal(P.selectDisplay([primary, secondary], 99, primary), primary);
  assert.equal(P.selectDisplay([primary, secondary], null, primary), primary);
  assert.equal(P.selectDisplay([], 2, primary), primary);
  assert.equal(P.selectDisplay('not-a-list', 2, primary), primary);
  assert.equal(P.normalize({ displayId: 2 }).displayId, 2);
  assert.equal(P.normalize({ displayId: -1 }).displayId, -1);
  assert.equal(P.normalize({ displayId: 2.5 }).displayId, null);
  assert.equal(P.normalize({ displayId: '2' }).displayId, null);
  assert.equal(P.normalize({}).displayId, null);
});
test('DSH repair status is requested only after the managed plugin is installed', () => {
  assert.equal(P.dshRepairPending({ dshTimedQuestions: false }), false);
  assert.equal(P.dshRepairPending({
    dshTimedQuestions: true,
    dsh: { installed: false, configuredTimedQuestions: false },
  }), false);
  assert.equal(P.dshRepairPending({
    dshTimedQuestions: true,
    dsh: { installed: true, configuredTimedQuestions: false },
  }), true);
  assert.equal(P.dshRepairPending({
    dshTimedQuestions: true,
    dsh: { installed: true, configuredTimedQuestions: true },
  }), false);
});
test('local Markdown builds a node tree: text is escaped by construction, dangerous links stripped, never emits images and preserves code', () => {
  const walk = (node, out = { tags: [], hrefs: [], text: [] }) => {
    if (node === null || node === undefined || node === false || node === '') return out;
    if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out; }
    if (Array.isArray(node)) { for (const kid of node) walk(kid, out); return out; }
    out.tags.push(node.tag); if (node.attrs?.href) out.hrefs.push(node.attrs.href);
    for (const kid of node.kids || []) walk(kid, out);
    return out;
  };
  const tree = P.markdown('# 中文标题\n\n- **清单**\n- `inline`\n\n> 引用\n\n<script>alert(1)</script>\n\n![remote](https://example.com/a.png)\n\n[bad](javascript:alert) [ok](https://example.com/test)\n\n```html\n<img src=x onerror=alert(1)>\n```');
  const seen = walk(tree);
  assert.ok(seen.tags.includes('h2')); assert.ok(seen.tags.includes('ul')); assert.ok(seen.tags.includes('blockquote')); assert.ok(seen.tags.includes('pre'));
  assert.ok(!seen.tags.some(tag => ['script', 'img', 'iframe', 'style', 'onerror'].includes(tag)), 'no executable tags in the tree');
  assert.deepEqual(seen.hrefs, ['https://example.com/test']);
  assert.ok(seen.text.some(value => value.includes('<script>alert(1)</script>')), 'script source only survives as inert text');
  assert.ok(seen.text.some(value => value.includes('img src=x onerror=alert(1)')), 'code fence content only survives as inert text');
  const anchors = (function collect(node) { if (Array.isArray(node)) return node.flatMap(collect); if (node?.tag === 'a') return [node]; return node?.kids ? node.kids.flatMap(collect) : []; })(tree);
  assert.equal(anchors.length, 1); assert.equal(anchors[0].attrs['data-external-url'], 'https://example.com/test');
  assert.equal(Array.from(P.summary('中😀'.repeat(1000)).text).length, 1200);
});
