'use strict';
(() => {
  const $ = id => document.getElementById(id), P = window.IslandPresentation, api = window.island?.settings, sessionApi = window.island?.sessions;
  const fields = ['panelDensity','contentFontSize','maxPanelHeight','expandOnHover','autoCollapseOnLeave','completionReveal','completionView','completionDwellMs','motionMode','settingsTheme','autoHideWhenIdle','autoHideFullscreen','autoStart','dshTimedQuestions','approvalHandoffSeconds'];
  const disposers = [];
  let saved = null, environment = { dark: true }, busy = false, previewReady = false;
  const status = (text, error = false) => { $('status').textContent = text; $('status').className = 'status' + (error ? ' error' : ''); };
  function values() {
    const value = {};
    for (const key of fields) { const el = $(key); value[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value; }
    return { ...value, updateUrl: $('updateUrl').value.trim(), autoCheckUpdates: $('autoCheck').checked };
  }
  function theme(value) { document.body.classList.toggle('light', value.settingsTheme === 'light' || value.settingsTheme === 'system' && !environment.dark); }
  function preview() {
    const value = values(); theme(value);
    $('fontValue').textContent = value.contentFontSize + 'px'; $('heightValue').textContent = value.maxPanelHeight + 'px'; $('dwellValue').textContent = Math.round(value.completionDwellMs / 1000) + ' 秒';
    if (previewReady) $('islandPreview').contentWindow.postMessage({ type: 'island-hud-preview', settings: value, scene: $('previewScene').value }, '*');
  }
  function fill(value) {
    saved = value;
    $('version').textContent = 'v' + value.version + (value.packaged ? '' : ' · dev');
    for (const key of fields) { const el = $(key), item = value[key] ?? P.DEFAULTS[key] ?? false; if (el.type === 'checkbox') el.checked = !!item; else el.value = item; }
    $('updateUrl').value = value.updateUrl || ''; $('autoCheck').checked = !!value.autoCheckUpdates;
    $('autoStart').disabled = !value.packaged;
    updateDsh(value.dsh); updateZcode(value.zcode); updateClaude(value.claude); updateCodex(value.codex); preview();
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
  function updateClaude(value) {
    if (!value) return;
    $('claudeStatus').textContent = value.connected ? '已连接' : value.installed ? '等待连接' : '未安装';
    $('claudeStatus').className = 'badge' + (value.connected ? ' ok' : '');
    $('claudeReason').textContent = (value.reason || '') + (value.conflict ? '\n注意：' + value.conflict : '');
    $('claudeVersions').textContent = '脚本版本：' + (value.version || '未安装') + '　最近活动：' + (value.lastSeen ? new Date(value.lastSeen).toLocaleTimeString() : '尚未连接');
  }
  function updateCodex(value) {
    if (!value) return;
    $('codexStatus').textContent = value.connected ? '已连接' : value.installed ? '等待连接' : '未安装';
    $('codexStatus').className = 'badge' + (value.connected ? ' ok' : '');
    $('codexReason').textContent = (value.reason || '') + (value.conflict ? '\n注意：' + value.conflict : '');
    $('codexVersions').textContent = '脚本版本：' + (value.version || '未安装') + '　最近活动：' + (value.lastSeen ? new Date(value.lastSeen).toLocaleTimeString() : '尚未连接');
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
    try { fill(await api.set(values())); status('已保存' + (saved.dshTimedQuestions !== saved.dsh?.configuredTimedQuestions ? ' · 问答模式需安装 / 修复后重启 DSH' : '')); }
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
  async function manageClaude(action) {
    if (busy) return; busy = true; $('claudeInstall').disabled = $('claudeRemove').disabled = true;
    $('claudeOutput').textContent = action === 'remove' ? '正在卸载集成…' : '正在写入 Claude Code hook 配置…';
    try {
      const result = await api.claudeManage(action); updateClaude(result);
      $('claudeOutput').textContent = result.summary + (result.backupDir ? '\n备份：' + result.backupDir : '');
      status(action === 'remove' ? 'Claude Code 集成卸载完成' : 'Claude Code 集成配置完成');
    } catch (error) { $('claudeOutput').textContent = error.message; status('Claude Code 集成操作失败', true); }
    finally { busy = false; $('claudeInstall').disabled = $('claudeRemove').disabled = false; }
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
  $('claudeInstall').addEventListener('click', () => manageClaude('install')); $('claudeRemove').addEventListener('click', () => manageClaude('remove'));
  $('codexInstall').addEventListener('click', () => manageCodex('install')); $('codexRemove').addEventListener('click', () => manageCodex('remove'));
  $('openLogs').addEventListener('click', () => api.openLogs());
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
  window.island.environment?.get().then(value => { environment = value; if (saved) preview(); }).catch(() => {});
  disposers.push(window.island.environment?.onChange(value => { environment = value; if (saved) preview(); }));
  const timer = setInterval(() => {
    if (busy || document.visibilityState === 'hidden') return;
    api.dshStatus().then(updateDsh).catch(() => {});
    api.zcodeStatus?.().then(updateZcode).catch(() => {});
    api.claudeStatus?.().then(updateClaude).catch(() => {});
    api.codexStatus?.().then(updateCodex).catch(() => {});
  }, 5000);
  window.addEventListener('pagehide', () => { clearInterval(timer); for (const dispose of disposers) dispose?.(); }, { once: true });
})();
