'use strict';
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.IslandPresentation = value;
})(typeof window === 'object' ? window : globalThis, () => {
  const DEFAULTS = Object.freeze({ panelDensity: 'comfortable', contentFontSize: 13, maxPanelHeight: 560,
    expandOnHover: true, autoCollapseOnLeave: true, completionReveal: 'glance', completionView: 'markdown-summary',
    completionDwellMs: 5000, motionMode: 'system', settingsTheme: 'system', autoHideWhenIdle: false });
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
    return result;
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
  // This deliberately implements a small text-only Markdown vocabulary. No HTML
  // parser, scripts, image loads or plug-ins ever see the source text.
  function inline(source) {
    // Unclosed delimiters in huge command/log lines must not make the regular
    // expression backtrack quadratically. Preserve these lines verbatim.
    if (source.length > 4096) return escape(source);
    const regex = /(`[^`\n]+`|!\[[^\]\n]*\]\([^\s)]*\)|\[[^\]\n]+\]\([^\s)]*\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
    let out = '', at = 0, match;
    while ((match = regex.exec(source))) {
      out += escape(source.slice(at, match.index));
      const token = match[0];
      if (token[0] === '`') out += '<code>' + escape(token.slice(1, -1)) + '</code>';
      else if (token.startsWith('![')) out += '<span class="image-placeholder">' + escape(token.slice(2, token.indexOf(']')) || '图片') + '（图片未加载）</span>';
      else if (token[0] === '[') {
        const split = token.indexOf(']('), label = token.slice(1, split), url = safeLink(token.slice(split + 2, -1));
        out += url ? '<a href="' + escape(url) + '" data-external-url="' + escape(url) + '">' + escape(label) + '</a>' : escape(label);
      } else if (token.startsWith('**')) out += '<strong>' + escape(token.slice(2, -2)) + '</strong>';
      else out += '<em>' + escape(token.slice(1, -1)) + '</em>';
      at = regex.lastIndex;
    }
    return out + escape(source.slice(at));
  }
  function markdown(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let html = '', paragraph = [], code = null, language = '', list = null;
    const closeParagraph = () => { if (paragraph.length) { html += '<p>' + paragraph.map(inline).join('<br>') + '</p>'; paragraph = []; } };
    const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        closeParagraph(); closeList();
        if (code !== null) { html += '<pre><code' + (language ? ' data-language="' + escape(language) + '"' : '') + '>' + escape(code.join('\n')) + '</code></pre>'; code = null; }
        else { code = []; language = line.trim().slice(3).replace(/[^a-zA-Z0-9_+-]/g, '').slice(0, 24); }
        continue;
      }
      if (code !== null) { code.push(line); continue; }
      if (!line.trim()) { closeParagraph(); closeList(); continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line), item = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line), quote = /^>\s?(.*)$/.exec(line);
      if (heading) { closeParagraph(); closeList(); const n = Math.min(4, heading[1].length + 1); html += '<h' + n + '>' + inline(heading[2]) + '</h' + n + '>'; }
      else if (item) { closeParagraph(); const kind = item[1] ? 'ul' : 'ol'; if (list !== kind) { closeList(); html += '<' + kind + '>'; list = kind; } html += '<li>' + inline(item[2]) + '</li>'; }
      else if (quote) { closeParagraph(); closeList(); html += '<blockquote>' + inline(quote[1]) + '</blockquote>'; }
      else { closeList(); paragraph.push(line); }
    }
    closeParagraph(); closeList();
    if (code !== null) html += '<pre><code>' + escape(code.join('\n')) + '</code></pre>';
    return html;
  }
  const plain = text => String(text || '').replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, '').replace(/```[^\n]*\n?/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1（图片）').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  function summary(text, limit = 1200) { const chars = Array.from(String(text || '')); return { text: chars.slice(0, limit).join(''), truncated: chars.length > limit }; }
  const labels = { running: '运行中', waitingForApproval: '等待审批', waitingForAnswer: '等待回答', completed: '已完成', idle: '空闲' };
  function wave(phase = 'idle') {
    return '<span class="status-wave phase-' + escape(phase) + '" aria-hidden="true">' + [7, 13, 19, 11, 6].map((h, i) => '<i style="--bar:' + h + 'px;--delay:' + (-i * .17) + 's"></i>').join('') + '</span>';
  }
  function header(session = {}, options = {}) {
    const title = session.title || 'DSH 会话', project = session.project || session.cwd?.split(/[\\/]/).filter(Boolean).pop() || '当前会话';
    return '<header class="session-header">' + wave(session.phase || options.phase) + '<div class="session-heading"><h1 title="' + escape(project + ' · ' + title) + '">' + escape(project === title ? title : project + ' · ' + title) + '</h1><p>' + escape(session.lastUserText ? '你：' + session.lastUserText : options.subtitle || 'DeepSeek Harness') + '</p></div><span class="source-chip">DSH</span>' + (options.controls || '') + '</header>';
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
  return { DEFAULTS, normalize, geometry, escape, safeLink, markdown, plain, summary, labels, wave, header, DisplayPolicy };
});
