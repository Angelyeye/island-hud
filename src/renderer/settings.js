'use strict';
(() => {
  const $ = id => document.getElementById(id), P = window.IslandPresentation, api = window.island?.settings, sessionApi = window.island?.sessions;
  const fields = ['panelDensity','contentFontSize','maxPanelHeight','expandOnHover','autoCollapseOnLeave','completionReveal','completionView','completionDwellMs','motionMode','notificationSound','settingsTheme','autoHideWhenIdle','autoHideFullscreen','autoStart','dshTimedQuestions','codexAppServer','approvalHandoffSeconds','autoRepairMode'];
  const disposers = [];
  let saved = null, environment = { dark: true }, busy = false, previewReady = false;
  const status = (text, error = false) => { $('status').textContent = text; $('status').className = 'status' + (error ? ' error' : ''); };
  function displayValue() {
    const selected = $('displayId').value;
    if (selected === 'auto' || !selected) return null;
    const id = Number(selected);
    return Number.isInteger(id) ? id : null;
  }
  function values() {
    const value = {};
    for (const key of fields) { const el = $(key); value[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value; }
    const displayId = displayValue();
    const selected = $('displayId').selectedOptions?.[0];
    return { ...value, displayId, displayFingerprint: displayId === null ? null : selected?.dataset.fingerprint || null,
      updateUrl: $('updateUrl').value.trim(), autoCheckUpdates: $('autoCheck').checked };
  }
  function renderDisplays(value, selected = $('displayId').value, fingerprint = value.displayFingerprint || saved?.displayFingerprint) {
    const select = $('displayId'), options = Array.isArray(value.displayOptions) ? value.displayOptions : [];
    select.textContent = '';
    select.append(new Option('跟随主显示器', 'auto'));
    for (const display of options) {
      const scale = display.scaleFactor && display.scaleFactor !== 1 ? ' · ' + Math.round(display.scaleFactor * 100) + '%' : '';
      const prefix = display.index ? display.index + '. ' : '';
      const bounds = display.bounds || {}, position = Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? ` · (${bounds.x}, ${bounds.y})` : '';
      const rotation = display.rotation ? ' · 旋转 ' + display.rotation + '°' : '';
      const label = `${prefix}${display.label || '显示器'} · ${display.width}×${display.height}${position}${scale}${rotation}${display.primary ? ' · 主显示器' : ''}`;
      const option = new Option(label, String(display.id));
      if (display.fingerprint) option.dataset.fingerprint = display.fingerprint;
      select.append(option);
    }
    if (selected && selected !== 'auto' && !options.some(display => String(display.id) === selected)) {
      const option = new Option('已断开的显示器（临时使用主显示器）', selected);
      if (fingerprint) option.dataset.fingerprint = fingerprint;
      select.append(option);
    }
    select.value = [...select.options].some(option => option.value === selected) ? selected : 'auto';
  }
  function theme(value) {
    document.body.classList.toggle('light', value.settingsTheme === 'light' || value.settingsTheme === 'system' && !environment.dark);
    document.body.classList.toggle('reduced-motion', value.motionMode === 'reduced');
  }
  function preview() {
    const value = values(); theme(value);
    $('fontValue').textContent = value.contentFontSize + 'px'; $('heightValue').textContent = value.maxPanelHeight + 'px'; $('dwellValue').textContent = Math.round(value.completionDwellMs / 1000) + ' 秒';
    if (previewReady) $('islandPreview').contentWindow.postMessage({ type: 'island-hud-preview', settings: value, scene: $('previewScene').value }, '*');
  }
  function fill(value) {
    saved = value;
    $('version').textContent = 'v' + value.version + (value.packaged ? '' : ' · dev');
    $('aboutVersion').textContent = 'v' + (value.version || '未知');
    $('aboutElectron').textContent = value.electronVersion || '未知';
    for (const key of fields) { const el = $(key), item = value[key] ?? P.DEFAULTS[key] ?? false; if (el.type === 'checkbox') el.checked = !!item; else el.value = item; }
    $('updateUrl').value = value.updateUrl || ''; $('autoCheck').checked = !!value.autoCheckUpdates;
    $('autoStart').disabled = !value.packaged;
    renderDisplays(value, value.displayId == null ? 'auto' : String(value.displayId), value.displayFingerprint);
    updateDsh(value.dsh); updateZcode(value.zcode); updateCodex(value.codex); updateClaude(value.claude); updateChatGpt(value.chatgptMcp); renderUsage(value.usage); updateHealthSummary(value); preview();
  }
  function updateDsh(value) {
    if (!value) return;
    $('dshStatus').textContent = value.connected ? '已连接' : value.installed ? '等待连接' : '未安装';
    $('dshStatus').className = 'badge' + (value.connected ? ' ok' : '');
    $('dshReason').textContent = value.reason || '';
    $('dshVersions').textContent = '配置版本：' + (value.version || '未安装') + '　运行版本：' + (value.hostVersion || '尚未连接');
  }
  function updateZcode(value) {
    if (!value) return;
    $('zcodeStatus').textContent = value.connected ? '已连接' : value.installed ? '等待连接' : '未安装';
    $('zcodeStatus').className = 'badge' + (value.connected ? ' ok' : '');
    $('zcodeReason').textContent = (value.reason || '') + (value.conflict ? '\n注意：' + value.conflict : '');
    $('zcodeVersions').textContent = '脚本版本：' + (value.version || '未安装') + '　最近活动：' + (value.lastSeen ? new Date(value.lastSeen).toLocaleTimeString() : '尚未连接');
  }
  function updateCodex(value) {
    if (!value) return;
    $('codexStatus').textContent = value.connected ? '已连接' : value.installed ? '等待连接' : '未安装';
    $('codexStatus').className = 'badge' + (value.connected ? ' ok' : '');
    $('codexReason').textContent = (value.reason || '') + (value.conflict ? '\n注意：' + value.conflict : '');
    $('codexVersions').textContent = '脚本版本：' + (value.version || '未安装') + '　surface：' + (value.surface || 'codex-desktop/unknown') + '　最近活动：' + (value.lastSeen ? new Date(value.lastSeen).toLocaleTimeString() : '尚未连接');
  }
  function updateClaude(value) {
    if (!value) return;
    $('claudeStatus').textContent = value.connected ? '已连接' : value.installed ? '等待连接' : '未安装';
    $('claudeStatus').className = 'badge' + (value.connected ? ' ok' : '');
    $('claudeReason').textContent = (value.reason || '') + (value.conflict ? '\n注意：' + value.conflict : '');
    $('claudeVersions').textContent = '脚本版本：' + (value.version || '未安装') + '　最近活动：' + (value.lastSeen ? new Date(value.lastSeen).toLocaleTimeString() : '尚未连接');
  }
  function updateChatGpt(value) {
    if (!value) return;
    const running = value.server?.running === true, enabled = value.enabled === true;
    $('chatgptMcpStatus').textContent = running ? '已连接' : enabled ? '等待连接' : '未启用';
    $('chatgptMcpStatus').className = 'badge' + (running ? ' ok' : '');
    $('chatgptMcpEnable').checked = enabled;
    $('chatgptMcpEndpoint').textContent = value.endpoint || value.server?.endpoint || '尚未启动本地 MCP 服务';
    $('chatgptMcpReason').textContent = running ? 'MCP bridge 已启动；ChatGPT Chat/Work 需要主动调用 Island HUD 工具。' : enabled ? '已启用但尚未建立连接，请检查 endpoint 和 ChatGPT 工作区权限。' : '默认关闭；启用后才会启动本机 MCP bridge。';
    $('chatgptMcpCopy').disabled = !running;
  }
  function updateHealthSummary(value = {}) {
    const statuses = [value.dsh, value.zcode, value.codex, value.claude].filter(Boolean);
    const connected = statuses.filter(item => item.connected === true).length;
    const needsAction = statuses.filter(item => item.installed && (!item.connected || item.conflict || /修复|不完整|不匹配/.test(item.reason || ''))).length;
    const mcp = value.chatgptMcp, mcpState = mcp?.server?.running ? 'ChatGPT MCP 已连接' : mcp?.enabled ? 'ChatGPT MCP 待连接' : 'ChatGPT MCP 未启用';
    const repairState = value.autoRepairMode === 'manual' ? '自动修复：手动' : '自动修复：启动/打开设置时检查';
    const lastRepair = Array.isArray(value.repairHistory) && value.repairHistory.length ? value.repairHistory[value.repairHistory.length - 1] : null;
    const repairText = lastRepair ? ` · 最近修复：${lastRepair.provider} ${lastRepair.result}` : '';
    $('integrationHealthStatus').textContent = needsAction ? '需要处理' : '运行正常';
    $('integrationHealthStatus').className = 'badge' + (needsAction ? '' : ' ok');
    $('integrationHealthSummary').textContent = `已连接 ${connected}/${statuses.length} · 需要处理 ${needsAction} · ${mcpState} · ${repairState}${repairText}`;
  }
  function renderUsage(value = {}) {
    const since = $('usageSince'), summary = $('usageSummary'); if (!since || !summary) return;
    const totals = value.totals || {}, number = n => new Intl.NumberFormat('zh-CN').format(Number(n) || 0);
    since.textContent = value.since ? '自 ' + new Date(value.since).toLocaleDateString() : '尚未统计';
    summary.textContent = '';
    for (const [label, key] of [['事件', 'events'], ['审批', 'approvals'], ['问答', 'questions'], ['完成', 'completed']]) {
      const item = document.createElement('div'); item.className = 'usage-metric';
      const valueNode = document.createElement('strong'); valueNode.textContent = number(totals[key]);
      const labelNode = document.createElement('small'); labelNode.textContent = label;
      item.append(valueNode, labelNode); summary.append(item);
    }
    const providerList = $('usageProviders'); if (!providerList) return;
    providerList.textContent = '';
    const logos = { dsh: 'assets/providers/dsh.svg', zcode: 'assets/providers/zcode.png', codex: 'assets/providers/codex.svg' };
    const labels = { dsh: 'DSH', zcode: 'ZCode', codex: 'Codex', claude: 'Claude', chatgpt: 'ChatGPT' };
    for (const provider of ['dsh', 'zcode', 'codex', 'claude', 'chatgpt']) {
      const data = value.providers?.[provider] || {}, row = document.createElement('div'); row.className = 'usage-provider';
      const logo = document.createElement(logos[provider] ? 'img' : 'span'); logo.className = 'usage-provider-logo';
      if (logos[provider]) { logo.src = logos[provider]; logo.alt = ''; } else { logo.textContent = provider === 'claude' ? 'A' : 'G'; logo.setAttribute('aria-hidden', 'true'); }
      const name = document.createElement('strong'); name.textContent = labels[provider];
      const counts = document.createElement('small'); counts.textContent = `事件 ${number(data.events)} · 审批 ${number(data.approvals)} · 问答 ${number(data.questions)} · 完成 ${number(data.completed)}`;
      row.append(logo, name, counts); providerList.append(row);
    }
  }
  const changeLabels = { highlights: '亮点', features: '新功能', improvements: '改进', fixes: '修复' };
  function renderUpdateInfo(result) {
    const statusEl = $('updateStatus'), summaryEl = $('updateSummary'), list = $('updateChanges');
    if (!statusEl || !summaryEl || !list) return;
    const status = result?.status || 'error';
    statusEl.textContent = status === 'available' ? '有新版本' : status === 'up-to-date' ? '已是最新' : status === 'unconfigured' ? '未配置' : '检查失败';
    statusEl.className = 'badge' + (status === 'available' || status === 'up-to-date' ? ' ok' : '');
    $('updateOpen').disabled = !result?.info;
    if (status === 'available') summaryEl.textContent = `发现 ${result.info.latestVersion}（当前 ${result.info.currentVersion}）`;
    else if (status === 'up-to-date') summaryEl.textContent = `当前 ${result.info.latestVersion}，已经是最新版本。`;
    else if (status === 'unconfigured') summaryEl.textContent = '请在高级设置中配置公开 HTTPS 更新源。';
    else summaryEl.textContent = result?.error || '更新检查失败，请稍后重试。';
    list.textContent = '';
    for (const [key, label] of Object.entries(changeLabels)) {
      const entries = result?.info?.changes?.[key]; if (!Array.isArray(entries) || !entries.length) continue;
      const group = document.createElement('section'); group.className = 'update-group';
      const title = document.createElement('strong'); title.textContent = label; group.append(title);
      const ul = document.createElement('ul'); for (const entry of entries) { const li = document.createElement('li'); li.textContent = entry; ul.append(li); }
      group.append(ul); list.append(group);
    }
  }
  async function checkUpdates() {
    const button = $('updateCheck'); if (!button || !api?.checkUpdates) return;
    button.disabled = true; button.textContent = '检查中…';
    try { renderUpdateInfo(await api.checkUpdates()); status('更新信息已刷新'); }
    catch (error) { renderUpdateInfo({ status: 'error', error: error.message }); status('更新检查失败', true); }
    finally { button.disabled = false; button.textContent = '检查更新'; }
  }
  const hiddenTargets = {
    archive: { list: 'archiveList', count: 'archiveCount', restoreAll: 'archiveRestoreAll', empty: '没有归档的会话', label: '归档' },
    delete: { list: 'deletedList', count: 'deletedCount', restoreAll: 'deletedRestoreAll', empty: '没有删除的会话', label: '删除' },
  };
  const hiddenRelative = at => {
    const minutes = Math.max(0, Math.floor((Date.now() - (at || Date.now())) / 60000));
    return minutes < 60 ? minutes + ' 分钟前' : minutes < 1440 ? Math.floor(minutes / 60) + ' 小时前' : Math.floor(minutes / 1440) + ' 天前';
  };
  async function loadHidden(mode) {
    const target = hiddenTargets[mode];
    if (!sessionApi || !target) return;
    try {
      const data = await sessionApi.list(mode);
      const count = data?.count || 0;
      $(target.count).textContent = String(count);
      $(target.restoreAll).disabled = !count;
      const list = $(target.list);
      list.textContent = '';
      if (!count) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = target.empty; list.append(empty); return; }
      for (const entry of data.entries || []) {
        const row = document.createElement('div'); row.className = 'archive-entry';
        const copy = document.createElement('div'); copy.className = 'archive-copy';
        const title = document.createElement('strong'); title.textContent = entry.title || entry.rawId;
        const meta = document.createElement('small'); meta.textContent = (entry.project ? entry.project + ' · ' : '') + hiddenRelative(entry.hiddenAt);
        copy.append(title, meta);
        const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'btn'; restore.textContent = '恢复';
        restore.dataset.hiddenMode = mode; restore.dataset.hiddenKey = entry.key;
        row.append(copy, restore); list.append(row);
      }
      if (data.truncated) { const more = document.createElement('p'); more.className = 'hint'; more.textContent = '仅显示最近 ' + (data.entries || []).length + ' 条，共 ' + count + ' 条'; list.append(more); }
    } catch (error) { status(target.label + '列表读取失败：' + error.message, true); }
  }
  async function restoreHidden(mode, key) {
    if (!sessionApi) return;
    try {
      const result = await sessionApi.restore(mode, key);
      if (!result?.ok) throw new Error(result?.reason === 'missing' ? '该记录已不存在' : '恢复失败');
      await loadHidden(mode); status('已恢复会话');
    } catch (error) { status('恢复失败：' + error.message, true); }
  }
  async function restoreAllHidden(mode) {
    if (!sessionApi) return;
    try { const result = await sessionApi.restoreAll(mode); await loadHidden(mode); status('已恢复 ' + (result?.removed || 0) + ' 个' + hiddenTargets[mode].label + '会话'); }
    catch (error) { status('恢复失败：' + error.message, true); }
  }
  async function save() {
    try { fill(await api.set(values())); status('已保存' + (P.dshRepairPending(saved) ? ' · 问答模式需安装 / 修复后重启 DSH' : '')); }
    catch (error) { status('保存失败：' + error.message, true); }
  }
  async function manageDsh(action) {
    if (busy) return; busy = true; $('dshInstall').disabled = $('dshRemove').disabled = true;
    $('dshOutput').textContent = action === 'remove' ? '正在卸载集成…' : '正在应用受管插件配置…';
    try {
      // Explicit install/repair applies only this integration selection. Other
      // draft appearance changes remain unsaved until the Save button is used.
      if (action !== 'remove') saved = await api.set({ dshTimedQuestions: $('dshTimedQuestions').checked });
      const result = await api.dshManage(action); updateDsh(result);
      $('dshOutput').textContent = result.summary + (result.backupDir ? '\n备份：' + result.backupDir : '');
      status(action === 'remove' ? 'DSH 集成卸载完成' : 'DSH 集成配置完成');
    } catch (error) { $('dshOutput').textContent = error.message; status('DSH 集成操作失败', true); }
    finally { busy = false; $('dshInstall').disabled = $('dshRemove').disabled = false; }
  }
  async function manageZcode(action) {
    if (busy) return; busy = true; $('zcodeInstall').disabled = $('zcodeRemove').disabled = true;
    $('zcodeOutput').textContent = action === 'remove' ? '正在卸载集成…' : '正在写入 ZCode hook 配置…';
    try {
      const result = await api.zcodeManage(action); updateZcode(result);
      $('zcodeOutput').textContent = result.summary + (result.backupDir ? '\n备份：' + result.backupDir : '');
      status(action === 'remove' ? 'ZCode 集成卸载完成' : 'ZCode 集成配置完成');
    } catch (error) { $('zcodeOutput').textContent = error.message; status('ZCode 集成操作失败', true); }
    finally { busy = false; $('zcodeInstall').disabled = $('zcodeRemove').disabled = false; }
  }
  async function manageCodex(action) {
    if (busy) return; busy = true; $('codexInstall').disabled = $('codexRemove').disabled = true;
    $('codexOutput').textContent = action === 'remove' ? '正在卸载集成…' : '正在写入 Codex hook 配置…';
    try {
      const result = await api.codexManage(action); updateCodex(result);
      $('codexOutput').textContent = result.summary + (result.backupDir ? '\n备份：' + result.backupDir : '');
      status(action === 'remove' ? 'Codex 集成卸载完成' : 'Codex 集成配置完成');
    } catch (error) { $('codexOutput').textContent = error.message; status('Codex 集成操作失败', true); }
    finally { busy = false; $('codexInstall').disabled = $('codexRemove').disabled = false; }
  }
  async function manageClaude(action) {
    if (busy) return; busy = true; $('claudeInstall').disabled = $('claudeRemove').disabled = true;
    $('claudeOutput').textContent = action === 'remove' ? '正在卸载集成…' : '正在写入 Claude Code hook 配置…';
    try {
      const result = await api.claudeManage(action); updateClaude(result); $('claudeOutput').textContent = result.summary + (result.backupDir ? '\n备份：' + result.backupDir : '');
      status(action === 'remove' ? 'Claude 集成卸载完成' : 'Claude 集成配置完成');
    } catch (error) { $('claudeOutput').textContent = error.message; status('Claude 集成操作失败', true); }
    finally { busy = false; $('claudeInstall').disabled = $('claudeRemove').disabled = false; }
  }
  async function refreshChatGpt() {
    try { const value = await api.chatgptMcpStatus?.(); updateChatGpt(value); updateHealthSummary({ ...saved, chatgptMcp: value }); }
    catch (error) { status('ChatGPT bridge 状态读取失败：' + error.message, true); }
  }
  for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => {
    for (const tab of document.querySelectorAll('[data-tab]')) tab.classList.toggle('selected', tab === button);
    for (const page of document.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== button.dataset.tab;
    document.querySelector('main').scrollTop = 0; preview();
    if (button.dataset.tab === 'about') { loadHidden('archive'); loadHidden('delete'); }
  });
  $('islandPreview').addEventListener('load', () => { previewReady = true; if (saved) preview(); });
  for (const id of fields) $(id).addEventListener('input', preview);
  $('previewScene').addEventListener('change', preview);
  $('save').addEventListener('click', save); $('close').addEventListener('click', () => window.close());
  $('dshInstall').addEventListener('click', () => manageDsh('install')); $('dshRemove').addEventListener('click', () => manageDsh('remove'));
  $('zcodeInstall').addEventListener('click', () => manageZcode('install')); $('zcodeRemove').addEventListener('click', () => manageZcode('remove'));
  $('codexInstall').addEventListener('click', () => manageCodex('install')); $('codexRemove').addEventListener('click', () => manageCodex('remove'));
  $('claudeInstall').addEventListener('click', () => manageClaude('install')); $('claudeRemove').addEventListener('click', () => manageClaude('remove'));
  $('chatgptMcpEnable').addEventListener('change', async event => { try { updateChatGpt(await api.chatgptMcpSet?.({ enabled: event.target.checked })); status(event.target.checked ? 'ChatGPT MCP bridge 已启用' : 'ChatGPT MCP bridge 已关闭'); } catch (error) { event.target.checked = !event.target.checked; status('ChatGPT MCP 设置失败：' + error.message, true); } });
  $('chatgptMcpCheck').addEventListener('click', refreshChatGpt);
  $('chatgptMcpCopy').addEventListener('click', async () => { const value = await api.chatgptMcpStatus?.(); const server = value?.server || {}; try { await api.copy(JSON.stringify({ endpoint: server.endpoint || value.endpoint || '', token: server.token || '', transport: value.transport || 'streamable-http' }, null, 2)); status('ChatGPT MCP 连接信息已复制'); } catch (error) { status('复制连接信息失败：' + error.message, true); } });
  $('openLogs').addEventListener('click', () => api.openLogs());
  $('updateCheck').addEventListener('click', checkUpdates);
  $('updateOpen').addEventListener('click', () => api.openUpdates?.());
  $('usageReset').addEventListener('click', async () => { const cleared = await api.resetUsage?.(); if (cleared) { renderUsage({ since: Date.now(), totals: { events: 0, approvals: 0, questions: 0, completed: 0 }, providers: {} }); status('使用统计已清除'); } });
  $('copyDiag').addEventListener('click', async () => { try { await api.copy(await api.diagnostics()); status('诊断信息已复制'); } catch (e) { status(e.message, true); } });
  for (const mode of Object.keys(hiddenTargets)) {
    $(hiddenTargets[mode].restoreAll).addEventListener('click', () => restoreAllHidden(mode));
    $(hiddenTargets[mode].list).addEventListener('click', event => {
      const button = event.target.closest('[data-hidden-key]');
      if (button) restoreHidden(button.dataset.hiddenMode, button.dataset.hiddenKey);
    });
  }
  if (!api) { status('本机设置服务不可用', true); return; }
  api.get().then(fill).catch(error => status(error.message, true));
  if (sessionApi) {
    loadHidden('archive'); loadHidden('delete');
    disposers.push(sessionApi.onChange(() => { loadHidden('archive'); loadHidden('delete'); }));
  }
  const applyEnvironment = value => {
    environment = value;
    if (saved) preview();
    if (value?.displayOptions) renderDisplays(value);
  };
  window.island.environment?.get().then(applyEnvironment).catch(() => {});
  disposers.push(window.island.environment?.onChange(applyEnvironment));
  const timer = setInterval(() => {
    if (busy || document.visibilityState === 'hidden') return;
    api.dshStatus().then(updateDsh).catch(() => {});
    api.zcodeStatus?.().then(updateZcode).catch(() => {});
    api.codexStatus?.().then(updateCodex).catch(() => {});
    api.claudeStatus?.().then(updateClaude).catch(() => {});
    api.chatgptMcpStatus?.().then(value => { updateChatGpt(value); updateHealthSummary({ ...saved, chatgptMcp: value }); }).catch(() => {});
  }, 5000);
  window.addEventListener('pagehide', () => { clearInterval(timer); for (const dispose of disposers) dispose?.(); }, { once: true });
})();
