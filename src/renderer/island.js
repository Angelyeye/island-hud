'use strict';
(() => {
  const P = window.IslandPresentation, api = window.island;
  const params = new URLSearchParams(location.search), preview = params.has('preview'), isDemo = params.has('demo');
  const notch = document.getElementById('notch'), toast = document.getElementById('toast');
  const layers = Object.fromEntries([...document.querySelectorAll('.layer')].map(el => [el.dataset.layer, el]));
  let settings = { ...P.DEFAULTS }, environment = { workArea: { width: 1920, height: 1040 }, visible: true }, layout = P.geometry(settings, environment);
  const state = { scene: 'compact', sessions: [], syncingSessions: true };
  const policy = new P.DisplayPolicy({ settings });
  const disposers = [], contents = new Map(), rowNodes = new Map();
  let toastTimer, resultTimer, policyTimer, timeTimer, geometryFrame, geometryUntil = 0, lastBounds = '';
  let fullReply = null, loadingReply = '', fullGeneration = 0, completionFocus = null, appVisible = true, composing = false;
  const native = window.createNativeRequests({ layers, api: preview ? { reply: async () => ({ status: 'delivered' }) } : isDemo ? null : api?.native,
    keyboard: enabled => api?.keyboard?.(enabled), esc: P.escape, askIcon: () => '<span aria-hidden="true">▤</span>',
    sessionOf: request => state.sessions.find(s => s.provider === request.provider && s.rawId === request.sessionId),
    handoffSeconds: () => Number(settings.approvalHandoffSeconds) || 0,
    toast: showToast, changed: refresh, feedback: confirmed });
  const activeSessions = list => list.filter(s => s.phase !== 'idle');
  const relative = time => { const seconds = Math.max(0, Math.floor((Date.now() - (time || Date.now())) / 1000)); return seconds < 60 ? seconds + 's' : seconds < 3600 ? Math.floor(seconds / 60) + 'm' : Math.floor(seconds / 3600) + 'h'; };
  const esc = P.escape;
  function demoData() {
    const now = Date.now();
    return [
      { id: 'demo-running', rawId: 'demo-running', provider: 'dsh', project: 'Island HUD', title: '完善认证中间件', lastUserText: '修复认证流程，补充中文路径的回归验证', phase: 'running', turn: 3, updatedAt: now - 20000, currentTool: { name: 'Edit', detail: 'src/auth/middleware.ts', since: now - 4000 } },
      { id: 'demo-backend', rawId: 'demo-backend', provider: 'dsh', project: '后端服务', title: '优化订单查询', phase: 'running', updatedAt: now - 50000, turn: 2, currentTool: { name: 'pwsh', detail: 'npm test' } },
      { id: 'demo-question', rawId: 'demo-question', provider: 'dsh', project: '发布工具', title: '选择发布目标', phase: 'waitingForAnswer', updatedAt: now - 120000, pendingQuestion: { text: '这次发布使用哪个环境？', options: [{ label: '生产环境', description: '发布前先检查回滚预案' }, { label: '预发布环境', description: '让团队先完成验收' }, { label: '仅本机验证', description: '暂不部署到服务器' }] } },
      { id: 'demo-approval', rawId: 'demo-approval', provider: 'dsh', project: '发布工具', title: '更新配置文件', phase: 'waitingForApproval', updatedAt: now - 180000, currentTool: { name: 'write', detail: 'C:\\项目\\config.json' } },
      { id: 'demo-complete', rawId: 'demo-complete', provider: 'dsh', project: 'Island HUD', title: '回归测试已完成', phase: 'completed', turn: 1, updatedAt: now - 300000, completedAt: now - 300000, lastUserText: '检查本机问答、焦点和会话跳转', lastAssistantText: '## 验证完成\n\n- 中文问答保持原始值\n- 透明窗口边缘正确穿透\n- `56` 项回归检查通过\n\n```text\nDSH · 请求已完成\n```' },
      { id: 'demo-idle', rawId: 'demo-idle', provider: 'dsh', project: '维护任务', title: '整理构建缓存', phase: 'idle', updatedAt: now - 1800000 },
      { id: 'demo-zcode', rawId: 'demo-zcode', provider: 'zcode', project: 'Island HUD', title: '排查管道回退路径', lastUserText: '看看 pipe-host 断开时桥接的回退逻辑', phase: 'running', updatedAt: now - 8000, currentTool: { name: 'Bash', detail: 'npm test', since: now - 3000 } },
    ];
  }
  function setHTML(el, html) { if (contents.get(el) === html && el.childNodes.length) return; contents.set(el, html); el.innerHTML = html; }
  // DSH's own rows use an archive box; deleting is a separate, explicit action.
  const archiveIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
  const deleteIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
  const hideable = s => !!s && ['idle', 'completed'].includes(s.phase) && !(s.pendingRequests || []).length;
  const hideVerb = mode => mode === 'delete' ? '删除' : '归档';
  const hideBlockedReason = (s, mode) => (s?.pendingRequests || []).length
    ? '会话有待处理请求，暂不能' + hideVerb(mode) : '会话仍在进行，完成后再' + hideVerb(mode);
  function hideButton(s, mode, extra = '') {
    const blocked = !hideable(s);
    const label = blocked ? hideBlockedReason(s, mode) : hideVerb(mode);
    return '<button type="button" class="hide-button ' + mode + '-button ' + extra + (blocked ? ' is-blocked' : '') + '" data-act="hide" data-mode="' + mode + '" data-id="' + esc(s.id) + '" title="' + esc(label) + '" aria-label="' + esc(label) + '"' + (blocked ? ' aria-disabled="true"' : '') + '>' + (mode === 'delete' ? deleteIcon : archiveIcon) + '</button>';
  }
  function syncHideButton(button, s, mode) {
    const blocked = !hideable(s);
    const label = blocked ? hideBlockedReason(s, mode) : hideVerb(mode);
    button.title = label; button.setAttribute('aria-label', label);
    button.classList.toggle('is-blocked', blocked);
    if (blocked) button.setAttribute('aria-disabled', 'true'); else button.removeAttribute('aria-disabled');
  }
  function headerControls(session, { hide = true } = {}) {
    return (hide ? hideButton(session, 'archive') + hideButton(session, 'delete') : '') + '<button class="icon-button" data-act="settings" title="打开设置" aria-label="打开设置">⚙</button><button class="collapse-request" data-act="collapse" title="收起" aria-label="收起">−</button>';
  }
  function sessionHeader(session, { controls = true, hideActions = true } = {}) {
    return P.header(session, { controls: controls ? headerControls(session, { hide: hideActions }) : '' });
  }
  function rowHTML(s) {
    return P.wave(s.phase) + '<div class="row-copy"><strong>' + esc(s.title || s.project || '会话') + '</strong><small>' + esc(s.project || '当前项目') + (s.currentTool?.name ? ' · ' + esc(s.currentTool.name + ' ' + (s.currentTool.detail || '')) : '') + '</small></div><div class="row-tags">' + (s.model ? '<span class="source-chip">' + esc(s.model) + '</span>' : '') + '<span class="state-label phase-' + esc(s.phase) + '">' + esc(P.labels[s.phase] || s.phase) + '</span><time data-time="' + (s.updatedAt || Date.now()) + '">' + relative(s.updatedAt) + '</time><span class="row-arrow" aria-hidden="true">↗</span></div>';
  }
  function renderRows(container, list) {
    const live = new Set(list.map(s => s.id));
    for (const child of [...container.children]) if (!live.has(child.dataset.id)) child.remove();
    list.forEach((s, index) => {
      let shell = rowNodes.get(s.id);
      if (!shell) {
        shell = document.createElement('div'); shell.className = 'row-shell'; shell.dataset.id = s.id;
        const row = document.createElement('button'); row.type = 'button'; row.className = 'all-row session-row'; row.dataset.act = 'jump'; row.dataset.id = s.id;
        const archive = document.createElement('button'); archive.type = 'button'; archive.className = 'hide-button archive-button row-archive'; archive.dataset.act = 'hide'; archive.dataset.mode = 'archive'; archive.dataset.id = s.id; archive.innerHTML = archiveIcon;
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'hide-button delete-button row-delete'; remove.dataset.act = 'hide'; remove.dataset.mode = 'delete'; remove.dataset.id = s.id; remove.innerHTML = deleteIcon;
        shell.append(row, archive, remove); rowNodes.set(s.id, shell);
      }
      const row = shell.querySelector('.all-row');
      setHTML(row, rowHTML(s)); row.title = (s.project || '') + ' · ' + (s.title || '') + ' · 打开此会话';
      for (const button of shell.querySelectorAll('.hide-button')) syncHideButton(button, s, button.dataset.mode);
      if (container.children[index] !== shell) container.insertBefore(shell, container.children[index] || null);
    });
    for (const [id, shell] of rowNodes) if (!state.sessions.some(s => s.id === id)) { const row = shell.querySelector('.all-row'); if (row) contents.delete(row); rowNodes.delete(id); }
  }
  function renderCompact() {
    const request = native.summary(), waiting = state.sessions.find(s => ['waitingForApproval','waitingForAnswer'].includes(s.phase));
    const completion = !request && !waiting ? policy.completion?.session : null;
    const top = request || waiting || activeSessions(state.sessions)[0] || state.sessions[0];
    let phase = request?.phase || top?.phase || 'idle';
    let title = request?.text || (top?.currentTool?.name ? top.currentTool.name + ': ' + (top.currentTool.detail || top.title) : top?.title) || (state.syncingSessions ? '正在同步会话…' : '等待会话');
    if (completion) { phase = 'completed'; title = '已完成 · ' + P.plain(completion.lastAssistantText || completion.title).replace(/\s+/g, ' '); }
    const count = native.pending() ? apiRequestsCount() : state.sessions.filter(s => ['waitingForApproval','waitingForAnswer'].includes(s.phase)).length;
    setHTML(layers.compact, P.wave(phase) + '<span class="idle-text" title="' + esc(title) + '">' + esc(title) + '</span><span class="compact-counts">' + (count ? '<span class="pending-count">待处理 ' + count + '</span>' : '') + '<span class="idle-count">' + state.sessions.length + ' 会话</span></span>');
  }
  function apiRequestsCount() { return native.summary()?.count || 0; }
  function renderOverview() {
    const list = state.sessions, hero = list.find(s => ['waitingForApproval','waitingForAnswer'].includes(s.phase)) || activeSessions(list)[0] || list[0];
    if (!hero) { setHTML(layers.overview, '<div class="panel-top"><strong>会话</strong><button class="icon-button" data-act="settings" aria-label="设置">⚙</button><button class="collapse-request" data-act="collapse">−</button></div><div class="empty-state"><div class="empty-orbit">' + P.wave('idle') + '</div><h2>' + (state.syncingSessions ? '正在同步会话…' : '小岛等待中') + '</h2><p>开始一个本机任务，状态将在这里显示。</p></div>'); return; }
    const jump = ' data-act="jump" data-id="' + esc(hero.id) + '"';
    const heroHeader = sessionHeader(hero).replace('<header class="session-header"', '<header class="session-header hero-jump"' + jump);
    const prefix = heroHeader + '<div class="hero-context hero-jump"' + jump + '><span class="state-label phase-' + esc(hero.phase) + '">' + esc(P.labels[hero.phase]) + '</span>' + (hero.currentTool ? '<code>' + esc(hero.currentTool.name + ' ' + (hero.currentTool.detail || '')) + '</code>' : '<p>' + esc(P.plain(hero.lastAssistantText || '').slice(0, 180)) + '</p>') + '</div><div class="overview-list"></div><footer class="panel-footer"><button class="text-button" data-act="overview-more">' + overviewMoreText(list.length) + '</button><span>点击会话打开客户端 ↗</span></footer>';
    const existing = layers.overview.querySelector('.overview-list');
    if (!existing || layers.overview.dataset.hero !== hero.id) { setHTML(layers.overview, prefix); layers.overview.dataset.hero = hero.id; }
    else {
      setHTML(layers.overview.querySelector('.session-header'), P.header(hero).replace(/^<header[^>]*>|<\/header>$/g, '') + headerControls(hero));
      const heroContent = prefix.match(/<div class="hero-context hero-jump"[^>]*>([\s\S]*?)<\/div><div class="overview-list">/)?.[1] || '';
      setHTML(layers.overview.querySelector('.hero-context'), heroContent);
      layers.overview.querySelector('[data-act=overview-more]').textContent = overviewMoreText(list.length);
    }
    renderRows(layers.overview.querySelector('.overview-list'), list.filter(s => s.id !== hero.id).slice(0, 3));
  }
  const overviewMoreText = total => '显示全部 ' + total + ' 个会话' + (total >= 50 ? '（已满 50）' : '');
  function renderAllSessions() {
    const list = state.sessions;
    if (!layers.all.querySelector('.all-list')) setHTML(layers.all, '<div class="panel-top"><strong>全部会话</strong><span class="all-count"></span><button class="collapse-request" data-act="collapse" aria-label="收起">−</button></div><div class="all-list"></div><footer class="all-footer"></footer>');
    layers.all.querySelector('.all-count').textContent = '共 ' + list.length + ' 条' + (list.length >= 50 ? ' · 上限 50' : '');
    const container = layers.all.querySelector('.all-list');
    container.classList.toggle('dense', list.length > 10);
    const previous = container.scrollTop;
    renderRows(container, list);
    container.scrollTop = previous;
    setHTML(layers.all.querySelector('.all-footer'), '<span>待处理优先 · 最近活跃在前</span><span>' + list.length + ' / 50</span>');
  }
  function renderReadOnly(kind) {
    const target = kind === 'approval' ? layers.approval : layers.ask, phase = kind === 'approval' ? 'waitingForApproval' : 'waitingForAnswer';
    const s = state.sessions.find(item => item.phase === phase);
    if (!s) { setHTML(target, '<div class="panel-top"><strong>客户端</strong><button data-act="collapse" class="collapse-request">−</button></div><div class="empty-state">暂无待处理' + (kind === 'approval' ? '审批' : '问题') + '</div>'); return; }
    const question = s.pendingQuestion || {};
    setHTML(target, sessionHeader(s, { hideActions: false }) + '<div class="native-head">' + (kind === 'approval' ? '审批状态 · 只读预览' : '问题状态 · 只读预览') + '</div><div class="native-scroll readonly-card"><h2>' + esc(question.text || s.currentTool?.name || '客户端正在等待处理') + '</h2>' + (question.options || []).map((o, i) => '<div class="readonly-option"><span>' + (i + 1) + '</span><div><strong>' + esc(o.label) + '</strong><p>' + esc(o.description || '') + '</p></div></div>').join('') + '<p class="hint">当前只取得日志状态，回复由客户端原生界面处理。</p></div><footer class="native-buttons"><button class="btn-allow" data-act="jump" data-id="' + esc(s.id) + '">' + esc(P.meta(s.provider).focus) + (kind === 'approval' ? '审批' : '回答') + ' ↗</button></footer>');
  }
  function completionSession() { return state.sessions.find(s => s.id === completionFocus) || policy.completion?.session || state.sessions.find(s => s.phase === 'completed') || state.sessions[0]; }
  function renderCompletion() {
    const s = completionSession(); if (!s) { setHTML(layers.jump, '<div class="empty-state">暂无完成结果</div>'); return; }
    const key = JSON.stringify([s.id, s.turn || 0]);
    const full = settings.completionView === 'full';
    if (full && fullReply?.key !== key && loadingReply !== key) {
      loadingReply = key; const generation = ++fullGeneration;
      if (isDemo || preview) { fullReply = { key, status: 'ok', text: s.lastAssistantText || '', turn: s.turn }; loadingReply = ''; }
      else api?.completion?.({ id: s.id, turn: s.turn || 0 }).then(value => { if (generation !== fullGeneration) return; loadingReply = ''; fullReply = { ...value, key }; if (state.scene === 'jump') { renderCompletion(); measure(); } }).catch(() => { loadingReply = ''; fullReply = { key, status: 'unavailable', text: '' }; if (state.scene === 'jump') { renderCompletion(); measure(); } });
    }
    const reply = fullReply?.key === key ? fullReply : null;
    const source = full ? reply?.text || '' : P.summary(s.lastAssistantText || '').text;
    const html = settings.completionView === 'text-summary' ? '<p class="plain-reply">' + esc(P.plain(source)) + '</p>' : P.markdown(source);
    const content = full && loadingReply === key ? '<p class="hint">正在读取本回合完整回复…</p>' : full && reply?.status !== 'ok' ? '<p class="hint">本回合完整回复暂不可用，请在客户端查看。</p>' : html || '<p class="hint">客户端未提供结果正文。</p>';
    setHTML(layers.jump, sessionHeader(s) + '<div class="native-head completed-head">✓ 本回合已完成</div><div class="completion-body native-scroll ' + (full ? 'full-reply' : 'summary-reply') + '">' + content + '</div>' + (reply?.truncated || !full && Array.from(s.lastAssistantText || '').length >= 1200 ? '<p class="hint">内容已截断 · 在客户端查看完整回复</p>' : '') + '<footer class="appr-btns"><button data-act="copy-reply">复制内容</button><button class="btn-allow" data-act="jump" data-id="' + esc(s.id) + '">' + esc(P.meta(s.provider).view) + ' ↗</button></footer>');
  }
  function protectedState() { return native.protected() || composing || state.scene !== 'compact' && (!!window.getSelection()?.toString() || !!layers[state.scene]?.querySelector('details[open]') || document.activeElement?.tagName === 'TEXTAREA'); }
  function desiredScene() {
    if (native.scene()) return native.scene();
    if (state.scene === 'approved' && resultTimer) return 'approved';
    const manual = policy.scene();
    const waiting = state.sessions.find(s => ['waitingForApproval','waitingForAnswer'].includes(s.phase));
    if (waiting && !policy.manualScene) return waiting.phase === 'waitingForApproval' ? 'approval' : 'ask';
    return manual;
  }
  function renderScene(name) {
    if (name === 'compact') renderCompact();
    if (name === 'overview') renderOverview();
    if (name === 'all') renderAllSessions();
    if (name === 'jump') renderCompletion();
    if (['approval','ask'].includes(name) && !native.owns(name)) renderReadOnly(name === 'ask' ? 'question' : 'approval');
  }
  function applyScene(name, options = {}) {
    if (!layers[name]) return;
    const old = state.scene, changed = old !== name;
    state.scene = name;
    renderScene(name);
    const duration = layout.reduced ? 150 : name === 'compact' ? options.reason === 'leave' ? 440 : 560 : options.reason === 'hover' ? 420 : 300;
    notch.style.setProperty('--motion-duration', duration + 'ms');
    notch.style.setProperty('--motion-curve', options.reason === 'hover' && !layout.reduced ? 'cubic-bezier(.2,.8,.2,1.02)' : 'cubic-bezier(.2,.75,.25,1)');
    notch.className = 's-' + name;
    for (const [key, layer] of Object.entries(layers)) layer.classList.toggle('active', key === name);
    if (changed) { notch.dataset.direction = name === 'compact' ? 'collapse' : 'expand'; console.log('HUD_SCENE ' + name); }
    measure();
    api?.activity?.({ protected: protectedState(), expanded: ['overview','all'].includes(name) && !!policy.manualScene });
    if (changed) { geometryUntil = performance.now() + duration + 50; animateBounds(); }
    updateTimers();
  }
  function refresh() { policy.protected = protectedState(); applyScene(desiredScene()); }
  function measure() {
    const el = layers[state.scene];
    notch.style.setProperty('--expanded-width', layout.width + 'px');
    const width = state.scene === 'compact' || state.scene === 'approved' ? layout.compactWidth : layout.width;
    const height = state.scene === 'compact' ? 34 : state.scene === 'approved' ? 54 : Math.min(layout.maxHeight, Math.ceil(el?.scrollHeight || 180));
    notch.style.width = width + 'px'; notch.style.height = height + 'px';
    publishBounds(); positionToast();
  }
  function publishBounds() {
    const r = notch.getBoundingClientRect(), b = { x: r.x, y: r.y, w: r.width, h: r.height, r: state.scene === 'compact' ? 15 : 16 }, key = JSON.stringify(b);
    if (lastBounds === key) return; lastBounds = key; api?.setBounds?.(b);
  }
  function animateBounds() { if (geometryFrame) return; geometryFrame = requestAnimationFrame(() => { geometryFrame = null; publishBounds(); positionToast(); if (performance.now() < geometryUntil) animateBounds(); }); }
  const resizeObserver = new ResizeObserver(() => { publishBounds(); positionToast(); }); resizeObserver.observe(notch);
  function positionToast() { const bottom = notch.getBoundingClientRect().bottom; toast.style.top = Math.max(8, Math.min(bottom + 8, innerHeight - toast.offsetHeight - 8)) + 'px'; }
  function showToast(text, duration = 3200) { toast.textContent = text; toast.classList.add('on'); clearTimeout(toastTimer); positionToast(); toastTimer = setTimeout(() => toast.classList.remove('on'), duration); }
  function confirmed(message, outcome) {
    if (native.pending()) { showToast(message, 1200); return; }
    layers.approved.innerHTML = '<span class="result-icon ' + (outcome === 'rejected' ? 'rejected' : '') + '">' + (outcome === 'rejected' ? '−' : '✓') + '</span><span>' + esc(message) + '</span>';
    clearTimeout(resultTimer); resultTimer = setTimeout(() => { resultTimer = null; refresh(); }, 1200); applyScene('approved');
  }
  function configure(next, env = environment) {
    settings = { ...settings, ...next, ...P.normalize({ ...settings, ...next }) }; environment = env; layout = P.geometry(settings, environment); policy.configure(settings);
    document.documentElement.style.cssText = '--panel-width:' + layout.width + 'px;--max-height:' + layout.maxHeight + 'px;--body-size:' + layout.bodySize + 'px;--title-size:' + layout.titleSize + 'px;--secondary-size:' + layout.secondarySize + 'px;--panel-padding:' + layout.padding + 'px;--option-height:' + layout.optionHeight + 'px;--button-height:' + layout.buttonHeight + 'px;--expanded-width:' + layout.width + 'px';
    document.body.classList.toggle('reduced-motion', layout.reduced);
    document.body.classList.toggle('narrow', layout.width <= 440);
    appVisible = environment.visible !== false && document.visibilityState !== 'hidden'; document.body.classList.toggle('is-hidden', !appVisible);
    refresh();
  }
  function updateTimers() {
    clearTimeout(policyTimer); clearTimeout(timeTimer);
    if (!appVisible) return;
    if (policy.scheduled) policyTimer = setTimeout(() => {
      policy.protected = protectedState(); const hoverReady = policy.hovered && policy.hoverAt !== null && Date.now() - policy.hoverAt >= 150 && settings.expandOnHover;
      const leaveReady = !policy.hovered && policy.leaveAt !== null && Date.now() - policy.leaveAt >= 900 && settings.autoCollapseOnLeave && !policy.protected;
      const scene = policy.scene();
      if (native.pending()) {
        if (hoverReady && state.scene === 'compact') native.expand();
        else if (leaveReady && state.scene !== 'compact') native.collapse();
        renderCompact(); updateTimers();
      } else applyScene(scene, { reason: policy.hovered ? 'hover' : 'leave' });
    }, 100);
    if (state.scene !== 'compact' && state.sessions.length) timeTimer = setTimeout(() => { for (const time of layers[state.scene].querySelectorAll('[data-time]')) time.textContent = relative(Number(time.dataset.time)); updateTimers(); }, 1000);
  }
  function pointer(inside) {
    if (inside) policy.enter(); else { policy.leave(); if (!document.hasFocus()) native.releaseEditing(); }
    updateTimers();
  }
  function onSessions(list) {
    if (!Array.isArray(list)) list = [];
    const had = new Map(state.sessions.map(s => [s.id, s])); state.sessions = list; if (list.length) state.syncingSessions = false;
    for (const s of list) if (s.phase === 'completed' && (had.get(s.id)?.completedAt !== s.completedAt || had.get(s.id)?.turn !== s.turn)) policy.recordCompletion(s);
    if (fullReply && !list.some(s => JSON.stringify([s.id, s.turn || 0]) === fullReply.key)) { fullReply = null; fullGeneration++; }
    refresh();
  }
  async function focusTerminal(s) {
    if (!s) return { status: 'expired' };
    const result = preview || isDemo ? { status: 'navigated' } : await api?.focusSession?.(s.id);
    if (result?.status === 'navigated') showToast('已打开目标会话');
    else if (result?.status === 'expired') showToast('目标会话已失效，请在客户端查看');
    else showToast(result?.status === 'failed' && result.reason ? result.reason : '无法精确跳转，请在客户端手动打开');
    return result;
  }
  const hiding = new Set();
  async function hideSession(s, mode = 'archive') {
    if (!s || hiding.has(s.id)) return;
    const verb = hideVerb(mode);
    if (!hideable(s)) { showToast(hideBlockedReason(s, mode)); return; }
    hiding.add(s.id);
    try {
      const result = preview || isDemo ? { ok: true } : await api?.sessions?.hide?.(s.id, mode);
      if (!result?.ok) {
        const reason = result?.reason;
        showToast(reason === 'active' ? '会话仍在进行，完成后再' + verb : reason === 'pending' ? '会话有待处理请求，暂不能' + verb
          : reason === 'unknown' ? '该会话已不在当前列表' : verb + '失败：本地存储不可写');
        return;
      }
      state.sessions = state.sessions.filter(item => item.id !== s.id);
      if (fullReply) { fullReply = null; fullGeneration++; }
      showToast('已' + verb + '「' + (s.title || s.project || '会话') + '」· 可在设置中恢复');
      refresh();
    } catch { showToast(verb + '失败：请在设置中检查'); }
    finally { hiding.delete(s.id); }
  }
  function collapse(reason = 'manual') { if (native.pending()) native.collapse(); policy.manual('compact'); applyScene('compact', { reason }); }
  function openOverview() { policy.manual('overview'); applyScene('overview'); }
  function toggleOverview() { if (native.pending()) { if (state.scene === 'compact') native.expand(); else native.collapse(); return; } if (state.scene === 'compact' || state.scene === 'jump' || state.scene === 'approved') openOverview(); else collapse(); }
  function action(event) {
    const external = event.target.closest('[data-external-url]'); if (external) { event.preventDefault(); api?.openExternal?.(external.dataset.externalUrl); return; }
    if (native.click(event)) return;
    if (event.target.closest('[data-native=true]')) return;
    const element = event.target.closest('[data-act]');
    if (!element) { if (state.scene === 'compact') { if (!native.expand()) openOverview(); } return; }
    const act = element.dataset.act;
    if (act === 'collapse') collapse();
    if (act === 'settings') api?.settings?.open?.();
    if (act === 'hide') { void hideSession(state.sessions.find(s => s.id === element.dataset.id), element.dataset.mode === 'delete' ? 'delete' : 'archive'); return; }
    if (act === 'overview-more') { policy.manual('all'); applyScene('all'); }
    if (act === 'jump') void focusTerminal(state.sessions.find(s => s.id === element.dataset.id));
    if (act === 'copy-reply') { const s = completionSession(); const text = settings.completionView === 'full' && fullReply?.status === 'ok' ? fullReply.text : P.summary(s?.lastAssistantText || '').text; api?.settings?.copy?.(text).then(() => showToast('结果内容已复制')); }
  }
  notch.addEventListener('click', action);
  notch.addEventListener('mousedown', event => { if (event.button !== 0) return; const el = event.target.closest('[data-native-action]'); if (el && ['allow','deny','return','submit'].includes(el.dataset.nativeAction)) { event.preventDefault(); native.click(event); } }, true);
  // Desktop hit-testing and hover share the main process's sampled rounded
  // boundary. DOM enter/leave can race with its resizing transparent surface.
  if (preview || isDemo) { notch.addEventListener('pointerenter', () => pointer(true)); notch.addEventListener('pointerleave', () => pointer(false)); }
  notch.addEventListener('toggle', () => { policy.protected = protectedState(); measure(); updateTimers(); }, true);
  document.addEventListener('compositionstart', () => { composing = true; }); document.addEventListener('compositionend', () => { composing = false; });
  document.addEventListener('selectionchange', () => { policy.protected = protectedState(); });
  document.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape') { event.preventDefault(); collapse(); return; }
    if (state.scene === 'all' && ['PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
      const list = layers.all.querySelector('.all-list');
      if (list) {
        event.preventDefault();
        const page = Math.max(120, Math.floor(list.clientHeight * 0.9));
        list.scrollTop = event.key === 'Home' ? 0 : event.key === 'End' ? list.scrollHeight : list.scrollTop + (event.key === 'PageDown' ? page : -page);
      }
      return;
    }
    native.keydown(event);
  });
  window.addEventListener('blur', () => { native.releaseEditing(); policy.protected = protectedState(); updateTimers(); });
  document.addEventListener('visibilitychange', () => configure(settings, environment));
  window.addEventListener('resize', () => { measure(); publishBounds(); });
  if (preview) {
    const handlePreview = event => {
      if (event.source !== parent || event.data?.type !== 'island-hud-preview') return;
      configure(event.data.settings || {}, { workArea: { width: 1920, height: 1040 }, visible: true }); onSessions(demoData());
      const scene = event.data.scene || 'overview';
      if (['approval','single','multi'].includes(scene)) native.preview({ id: 'preview-' + scene, requestId: 'preview-' + scene, sessionId: 'demo-running', provider: 'dsh', state: 'pending', kind: scene === 'approval' ? 'approval' : 'question', receivedAt: Date.now(), timeoutMs: 600000, payload: { cwd: 'C:\\项目\\Island HUD', tool: { name: 'write', operation: '{ "ready": true }', target: 'C:\\项目\\config.json', reason: '更新发布前的本机验收配置。' }, questions: [{ id: 'preview-question', question: scene === 'multi' ? '发布前还需要完成哪些检查？' : '请选择这次发布的目标环境', multiSelect: scene === 'multi', options: [{ label: '回归测试', description: '单元测试与原生问答验证' }, { label: '监控就绪', description: '确认日志、内存和连接状态' }, { label: '回滚预案', description: '保留上一份可用的安装产物' }] }] } });
      else native.preview(null);
      const name = scene === 'single' || scene === 'multi' ? 'ask' : scene;
      policy.manual(name); applyScene(name);
    };
    window.addEventListener('message', handlePreview); state.sessions = demoData(); state.syncingSessions = false; configure(settings); openOverview();
  } else if (isDemo) { state.sessions = demoData(); state.syncingSessions = false; configure(settings); openOverview(); }
  else {
    configure(settings);
    disposers.push(api?.onUpdate?.(onSessions), api?.onPointer?.(pointer), api?.environment?.onChange?.(value => configure(settings, value)), api?.settings?.onChange?.(value => configure(value)));
    api?.snapshot?.().then(onSessions).catch(() => {});
    api?.settings?.get?.().then(value => configure(value)).catch(() => {});
    api?.environment?.get?.().then(value => configure(settings, value)).catch(() => {});
    native.connect();
    setTimeout(() => { if (state.syncingSessions) { state.syncingSessions = false; refresh(); } }, 10000);
  }
  window.addEventListener('beforeunload', () => { native.destroy(); resizeObserver.disconnect(); clearTimeout(policyTimer); clearTimeout(timeTimer); clearTimeout(toastTimer); clearTimeout(resultTimer); cancelAnimationFrame(geometryFrame); }, { once: true });
  window.__islandApp = { getState: () => ({ ...state, settings, layout }), getSessions: () => state.sessions,
    setScene(name) { if (name === 'jump') completionFocus = state.sessions.find(s => s.phase === 'completed')?.id; policy.manual(name); applyScene(name); },
    toggleOverview, openOverview, focusTerminal, hideSession, archiveSession: session => hideSession(session, 'archive'), deleteSession: session => hideSession(session, 'delete'), configure,
    setSessions: onSessions, pointer, protectedState, showToast };
})();
