'use strict';
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.IslandPresentation = value;
})(typeof window === 'object' ? window : globalThis, () => {
  const DEFAULTS = Object.freeze({ panelDensity: 'comfortable', contentFontSize: 13, maxPanelHeight: 560,
    expandOnHover: true, autoCollapseOnLeave: true, completionReveal: 'glance', completionView: 'markdown-summary',
    completionDwellMs: 5000, motionMode: 'system', settingsTheme: 'system', autoHideWhenIdle: false,
    approvalHandoffSeconds: 0, displayId: null });
  const choices = { panelDensity: ['comfortable', 'compact'], completionReveal: ['glance', 'expanded'],
    completionView: ['markdown-summary', 'text-summary', 'full'], motionMode: ['system', 'reduced', 'full'],
    settingsTheme: ['system', 'dark', 'light'] };
  function normalize(input = {}) {
    const result = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const value = input[key];
      result[key] = choices[key] ? choices[key].includes(value) ? value : fallback
        : typeof fallback === 'boolean' ? typeof value === 'boolean' ? value : fallback
        : Number.isFinite(value) ? value : fallback;
    }
    result.contentFontSize = Math.round(Math.max(11, Math.min(16, result.contentFontSize)));
    result.maxPanelHeight = Math.round(Math.max(320, Math.min(640, result.maxPanelHeight)));
    result.completionDwellMs = Math.round(Math.max(2000, Math.min(15000, result.completionDwellMs)));
    // Opt-in handoff: 0 keeps the island waiting (default); otherwise the
    // card counts down and returns the request to the client's native UI.
    result.approvalHandoffSeconds = Math.round(Math.max(0, Math.min(120, result.approvalHandoffSeconds)));
    result.displayId = Number.isInteger(result.displayId) ? result.displayId : null;
    return result;
  }
  function dshRepairPending(value = {}) {
    return value.dsh?.installed === true
      && value.dshTimedQuestions !== value.dsh.configuredTimedQuestions;
  }
  // Display IDs are runtime identifiers, not stable across reconnects. Keep the
  // chosen ID while it exists, then fall back to the primary display.
  function selectDisplay(displays, id, primary) {
    const list = Array.isArray(displays) ? displays : [];
    if (Number.isInteger(id)) {
      const selected = list.find(display => display.id === id);
      if (selected) return selected;
    }
    return primary || list[0] || null;
  }
  function geometry(input = {}, environment = {}) {
    const settings = normalize(input), compact = settings.panelDensity === 'compact';
    const work = environment.workArea || { width: 1920, height: 1040 };
    const width = Math.max(200, Math.min(compact ? 440 : 520, work.width - 32));
    const height = Math.max(160, Math.min(settings.maxPanelHeight, work.height - 64));
    return { width, maxHeight: height, compactWidth: Math.min(width, compact ? 280 : 320), compactHeight: 34,
      titleSize: compact ? 14 : 15, bodySize: compact ? Math.max(11, settings.contentFontSize - 1) : settings.contentFontSize,
      secondarySize: compact ? 11 : 12, padding: compact ? 16 : 20, optionHeight: compact ? 40 : 44,
      buttonHeight: compact ? 32 : 34, windowWidth: Math.ceil(width + 48), windowHeight: Math.ceil(height + 64),
      reduced: settings.motionMode === 'reduced' || settings.motionMode === 'system' && !!environment.reducedMotion };
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function safeLink(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  }
  // Views are described as plain node trees — {tag, attrs, kids}, a bare array
  // as fragment, a string/number as text — and materialized exactly once at the
  // DOM boundary. No view code ever concatenates untrusted strings into HTML,
  // so there is no escaping step to forget. The boundary also enforces what the
  // view vocabulary only promises: inline handlers are dropped, and URL-bearing
  // attributes accept only http(s)/mailto (link hrefs already pass safeLink;
  // this holds for every call site regardless of where the tree was built).
  const URL_ATTR = /^(?:href|src|xlink:href|formaction|action|poster)$/i;
  const SAFE_URL = /^(?:https?:|mailto:)[^\s]*$/i;
  function material(node, doc = globalThis.document, ns = null) {
    if (node === null || node === undefined || node === false || node === '') return null;
    if (typeof node === 'string' || typeof node === 'number') return doc.createTextNode(String(node));
    if (Array.isArray(node)) {
      const frag = doc.createDocumentFragment();
      for (const kid of node) { const child = material(kid, doc, ns); if (child) frag.append(child); }
      return frag;
    }
    const scope = node.ns || ns;
    const el = scope ? doc.createElementNS(scope, node.tag) : doc.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (/^on/i.test(name)) continue;
      const text = String(value);
      if (URL_ATTR.test(name) && !SAFE_URL.test(text)) continue;
      el.setAttribute(name, value === true ? '' : text);
    }
    for (const kid of node.kids || []) { const child = material(kid, doc, scope); if (child) el.append(child); }
    return el;
  }
  // This deliberately implements a small text-only Markdown vocabulary. No HTML
  // parser, scripts, image loads or plug-ins ever see the source text.
  function inlineKids(source) {
    // Unclosed delimiters in huge command/log lines must not make the regular
    // expression backtrack quadratically. Preserve these lines verbatim.
    if (source.length > 4096) return [source];
    const regex = /(`[^`\n]+`|!\[[^\]\n]*\]\([^\s)]*\)|\[[^\]\n]+\]\([^\s)]*\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
    const kids = [], text = value => { if (value) kids.push(value); };
    let at = 0, match;
    while ((match = regex.exec(source))) {
      text(source.slice(at, match.index));
      const token = match[0];
      if (token[0] === '`') kids.push({ tag: 'code', kids: [token.slice(1, -1)] });
      else if (token.startsWith('![')) kids.push({ tag: 'span', attrs: { class: 'image-placeholder' }, kids: [token.slice(2, token.indexOf(']')) || '图片', '（图片未加载）'] });
      else if (token[0] === '[') {
        const split = token.indexOf(']('), label = token.slice(1, split), url = safeLink(token.slice(split + 2, -1));
        kids.push(url ? { tag: 'a', attrs: { href: url, 'data-external-url': url }, kids: [label] } : label);
      } else if (token.startsWith('**')) kids.push({ tag: 'strong', kids: [token.slice(2, -2)] });
      else kids.push({ tag: 'em', kids: [token.slice(1, -1)] });
      at = regex.lastIndex;
    }
    text(source.slice(at));
    return kids;
  }
  function markdown(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = []; let paragraph = [], code = null, language = '', list = null;
    const closeParagraph = () => {
      if (!paragraph.length) return;
      const kids = [];
      for (const segment of paragraph) { if (kids.length) kids.push({ tag: 'br' }); kids.push(...inlineKids(segment)); }
      blocks.push({ tag: 'p', kids }); paragraph = [];
    };
    const closeList = () => { if (list) { blocks.push(list); list = null; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        closeParagraph(); closeList();
        if (code !== null) { blocks.push({ tag: 'pre', kids: [{ tag: 'code', attrs: language ? { 'data-language': language } : {}, kids: [code.join('\n')] }] }); code = null; }
        else { code = []; language = line.trim().slice(3).replace(/[^a-zA-Z0-9_+-]/g, '').slice(0, 24); }
        continue;
      }
      if (code !== null) { code.push(line); continue; }
      if (!line.trim()) { closeParagraph(); closeList(); continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line), item = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line), quote = /^>\s?(.*)$/.exec(line);
      if (heading) { closeParagraph(); closeList(); blocks.push({ tag: 'h' + Math.min(4, heading[1].length + 1), kids: inlineKids(heading[2]) }); }
      else if (item) { closeParagraph(); const kind = item[1] ? 'ul' : 'ol'; if (!list || list.tag !== kind) { closeList(); list = { tag: kind, kids: [] }; } list.kids.push({ tag: 'li', kids: inlineKids(item[2]) }); }
      else if (quote) { closeParagraph(); closeList(); blocks.push({ tag: 'blockquote', kids: inlineKids(quote[1]) }); }
      else { closeList(); paragraph.push(line); }
    }
    closeParagraph(); closeList();
    if (code !== null) blocks.push({ tag: 'pre', kids: [{ tag: 'code', kids: [code.join('\n')] }] });
    return blocks;
  }
  const plain = text => String(text || '').replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, '').replace(/```[^\n]*\n?/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1（图片）').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  function summary(text, limit = 1200) { const chars = Array.from(String(text || '')); return { text: chars.slice(0, limit).join(''), truncated: chars.length > limit }; }
  const labels = { running: '运行中', waitingForApproval: '等待审批', waitingForAnswer: '等待回答', completed: '已完成', idle: '空闲' };
  const providers = {
    dsh: { chip: 'DSH', title: 'DSH 会话', subtitle: 'DeepSeek Harness', focus: '在 DSH 中', view: '在 DSH 查看' },
    zcode: { chip: 'ZCode', title: 'ZCode 会话', subtitle: 'ZCode', focus: '在 ZCode 中', view: '在 ZCode 查看' },
    claude: { chip: 'Claude', title: 'Claude Code 会话', subtitle: 'Claude Code', focus: '在 Claude Code 中', view: '在 Claude Code 查看' },
    codex: { chip: 'Codex', title: 'Codex 会话', subtitle: 'OpenAI Codex', focus: '在 Codex 中', view: '在 Codex 查看' },
  };
  const meta = provider => providers[provider] || { chip: provider ? String(provider).toUpperCase() : 'HUD', title: '会话', subtitle: provider || '', focus: '在客户端', view: '在客户端查看' };
  function wave(phase = 'idle') {
    return { tag: 'span', attrs: { class: 'status-wave phase-' + (phase || 'idle'), 'aria-hidden': 'true' },
      kids: [7, 13, 19, 11, 6].map((h, i) => ({ tag: 'i', attrs: { style: '--bar:' + h + 'px;--delay:' + (-i * .17) + 's' } })) };
  }
  function header(session = {}, options = {}) {
    const pm = meta(session.provider);
    const title = session.title || pm.title, project = session.project || session.cwd?.split(/[\\/]/).filter(Boolean).pop() || '当前会话';
    const controls = Array.isArray(options.controls) ? options.controls : options.controls ? [options.controls] : [];
    return { tag: 'header', attrs: { class: 'session-header' }, kids: [
      wave(session.phase || options.phase),
      { tag: 'div', attrs: { class: 'session-heading' }, kids: [
        { tag: 'h1', attrs: { title: project + ' · ' + title }, kids: [project === title ? title : project + ' · ' + title] },
        { tag: 'p', kids: [session.lastUserText ? '你：' + session.lastUserText : options.subtitle || pm.subtitle] },
      ] },
      { tag: 'span', attrs: { class: 'source-chip' }, kids: [pm.chip] },
      ...controls,
    ] };
  }
  class DisplayPolicy {
    constructor({ now = Date.now, settings = {} } = {}) { this.now = now; this.settings = normalize(settings); this.manualScene = null; this.hovered = false; this.hoverAt = null; this.leaveAt = null; this.protected = false; this.completion = null; this.seen = new Map(); }
    configure(settings) { this.settings = normalize(settings); }
    enter() { this.hovered = true; this.hoverAt = this.now(); this.leaveAt = null; }
    leave() { this.hovered = false; this.hoverAt = null; this.leaveAt = this.now(); }
    manual(scene) { this.manualScene = scene; this.hoverAt = null; this.leaveAt = null; }
    recordCompletion(session) {
      const key = JSON.stringify([session.id, session.turn || 0, session.completedAt || 0]);
      if (!session.completedAt || this.seen.has(key)) return false;
      this.seen.set(key, true); while (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value);
      // Startup restoration is not a new completion notification.
      if (this.now() - session.completedAt > 5000) return false;
      if (this.manualScene === 'compact' && !this.protected) this.manualScene = null;
      this.completion = { session, until: this.now() + this.settings.completionDwellMs, remaining: this.settings.completionDwellMs, last: this.now() };
      return true;
    }
    scene() {
      const time = this.now();
      if (this.hovered && this.hoverAt !== null && time - this.hoverAt >= 150 && this.settings.expandOnHover && !this.protected) { this.manualScene = this.manualScene === 'all' || this.manualScene === 'jump' ? this.manualScene : 'overview'; this.hoverAt = null; }
      if (!this.hovered && this.leaveAt !== null && time - this.leaveAt >= 900 && this.settings.autoCollapseOnLeave && !this.protected) { this.manualScene = 'compact'; this.leaveAt = null; }
      if (this.completion) {
        const delta = time - this.completion.last; this.completion.last = time;
        if (!this.hovered && !this.protected) this.completion.remaining -= delta;
        if (this.completion.remaining <= 0) this.completion = null;
      }
      if (this.manualScene) return this.manualScene;
      return this.completion && this.settings.completionReveal === 'expanded' ? 'jump' : 'compact';
    }
    get scheduled() { return this.hoverAt !== null || this.leaveAt !== null || !!this.completion; }
  }
  return { DEFAULTS, normalize, dshRepairPending, geometry, selectDisplay, escape, safeLink, material, markdown, plain, summary, labels, providers, meta, wave, header, DisplayPolicy };
});
