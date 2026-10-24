'use strict';
// Native requests share the reference notch's layers, colors and scene transitions.
// A mounted question survives session refreshes and later request arrivals.
(() => {
  window.createNativeRequests = ({ layers, api, keyboard, changed, toast, esc, askIcon, sessionOf = () => null, feedback = toast }) => {
    let requests = [], active = null, collapsed = false, submitting = false;
    let page = 0, reviewing = false, revision = 0;
    let expiryTimer = null, expiryNotice = '';
    let editing = false, composing = false, uncertain = false;
    const disposers = [];
    let storage;
    try { storage = window.localStorage; } catch { /* In-memory drafts remain available. */ }
    const drafts = window.createQuestionDraftCache({ storage });
    window.addEventListener('pagehide', () => { save(); drafts.flush(); });
    const submitted = new Map();
    const source = request => window.IslandPresentation.meta(request?.provider).chip;
    const layerName = request => request?.kind === 'approval' ? 'approval' : 'ask';
    const layer = () => active ? layers[layerName(active)] : null;
    const answers = request => drafts.get(request);
    const remainingMs = request => request && Number.isFinite(request.receivedAt) && Number.isFinite(request.timeoutMs)
      ? Math.max(0, request.receivedAt + request.timeoutMs - Date.now()) : Infinity;
    const expired = request => request?.state !== 'pending' || remainingMs(request) <= 0;
    const expiryText = request => {
      const remaining = remainingMs(request);
      if (!Number.isFinite(remaining)) return '';
      if (remaining <= 0) return '已过期';
      const seconds = Math.ceil(remaining / 1000);
      return `剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    function tickExpiry() {
      if (!active) return;
      const marker = layer()?.querySelector('[data-native-expiry]');
      if (marker) marker.textContent = expiryText(active);
      if (active.state === 'pending' && expired(active)) {
        active.state = 'expired';
        submitting = false;
        updateControls();
        if (expiryNotice !== active.id) {
          expiryNotice = active.id;
          toast('请求已过期，请返回客户端处理');
        }
      }
    }
    const save = () => {
      if (!active || active.kind !== 'question') return;
      const field = layer().querySelector('fieldset');
      if (!field) return;
      const answer = answers(active).find(a => a.id === field.dataset.id);
      if (!answer) return;
      answer.selected = [...field.querySelectorAll('input:checked')].map(input => input.value);
      answer.custom = field.querySelector('textarea').value;
      drafts.touch(active);
    };
    const action = (name, text, css = 'btn-deny') => `<button class="${css}" data-native-action="${name}">${text}</button>`;
    const metadata = request => {
      const cwd = request.payload.cwd || '';
      const project = cwd.split(/[\\/]/).filter(Boolean).pop() || (request.sessionId ? '当前会话' : '未关联会话');
      const full = `来源：${source(request)}\n项目：${cwd || '未提供'}\n请求：${request.requestId}\n会话：${request.sessionId || '未关联（不推断会话）'}`;
      return `<details class="request-meta"><summary>请求详情${!request.sessionId ? ' · 未关联会话' : ''}</summary><pre>${esc(full)}</pre></details>`;
    };
    const head = request => window.IslandPresentation.header(sessionOf(request) || { title: request.payload.sessionTitle || '当前请求', cwd: request.payload.cwd, phase: request.kind === 'approval' ? 'waitingForApproval' : 'waitingForAnswer' }, {
      controls: `<button class="collapse-request" data-native-action="collapse" aria-label="收起卡片" title="收起卡片，保留待处理请求">−</button>` }) + `<div class="${request.kind === 'approval' ? 'appr-head' : 'ask-head'} native-head">
      ${request.kind === 'approval' ? '<span class="appr-dot"></span>' : askIcon()}
      <span>${source(request)} · ${request.kind === 'approval' ? '权限请求' : request.blocking === false ? '可继续工作 · 待回答' : '需要回答后继续'}</span>
      <span class="request-expiry" data-native-expiry>${esc(expiryText(request))}</span>
      <span class="appr-queue" data-native-queue>${requests.length > 1 ? `1 / ${requests.length} 待处理` : ''}</span></div>`;
    function updateControls() {
      if (!active) return;
      const disabled = uncertain || submitting || active.state !== 'pending' || expired(active);
      const queue = layer().querySelector('[data-native-queue]');
      if (queue) queue.textContent = requests.length > 1 ? `1 / ${requests.length} 待处理` : '';
      for (const el of layer().querySelectorAll('button,input,textarea')) {
        el.disabled = el.dataset.nativeAction === 'collapse' ? false : disabled;
      }
      layer().setAttribute('aria-busy', String(disabled));
    }
    function draw() {
      if (!active) return;
      const request = active, target = layer();
      target.dataset.native = 'true';
      let body;
      if (request.kind === 'approval') {
        const tool = request.payload.tool || {};
        body = `<div class="native-scroll approval-content"><div class="appr-tool"><span class="appr-icon">⚠</span><span class="appr-name">${esc(tool.name || '工具操作')}</span></div>
          ${tool.target ? `<p class="detail-label">目标</p><pre class="native-detail">${esc(tool.target)}</pre>` : ''}
          <p class="detail-label">操作内容</p><pre class="native-detail">${esc(tool.operation || tool.inputSummary || '客户端未提供操作详情')}</pre>
          <p class="detail-label">申请理由</p><p class="approval-reason">${esc(tool.reason || tool.detail || '客户端未提供理由')}</p>${metadata(request)}</div>
          <div class="appr-btns native-buttons">${action('return', '返回客户端')}${action('deny', '拒绝')}${action('allow', '允许一次', 'btn-allow')}</div>`;
      } else if (reviewing) {
        body = `<div class="native-scroll native-review"><div class="ask-q">检查答案 · 共 ${answers(request).length} 题</div>${answers(request).map((a, i) =>
          `<div class="answer-review"><h3>${i + 1}. ${esc(request.payload.questions[i].question)}</h3><p>${esc([...a.selected, a.custom].filter(Boolean).join('；') || '未填写（将跳过此题）')}</p></div>`).join('')}${metadata(request)}</div>
          <div class="appr-btns native-buttons">${action('edit', '返回修改')}${action('submit', '确认提交', 'btn-allow')}</div>`;
      } else {
        const question = request.payload.questions[page];
        const draft = answers(request).find(a => a.id === question.id);
        const options = question.options.map((option, i) => `<label class="ask-opt native-option" title="${esc(option.description)}">
          <input type="${question.multiSelect ? 'checkbox' : 'radio'}" name="native-choice" value="${esc(option.label)}" ${draft.selected.includes(option.label) ? 'checked' : ''}>
          <span class="ask-num">${i + 1}</span><span class="option-copy"><strong>${esc(option.label)}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span><span class="option-check" aria-hidden="true">✓</span></label>`).join('');
        body = `<div class="native-scroll"><fieldset data-id="${esc(question.id)}"><legend class="ask-q native-question">${esc(question.question)}</legend>
          ${question.detail ? `<p class="question-detail">${esc(question.detail)}</p>` : ''}
          <div class="ask-opts native-options">${options}</div>
          <label class="answer-label" for="native-answer">${question.options.length ? question.multiSelect ? '补充内容（可选）' : '或自由回答' : '自由回答'}</label>
          <textarea id="native-answer" class="answer-text" placeholder="${question.options.length && !question.multiSelect ? '填写后使用自由回答' : '输入答案'}">${esc(draft.custom)}</textarea>
          </fieldset></div>
          <div class="question-progress"><span>第 ${page + 1} / ${request.payload.questions.length} 题 · ${question.multiSelect ? '多选' : '单选 / 文本'}</span><span class="selection-count">${question.multiSelect ? `已选 ${draft.selected.length} 项` : ''}</span></div>
          <div class="appr-btns native-buttons">${page ? action('prev', '上一题') : action('return', '返回客户端')}${action('next', page + 1 < request.payload.questions.length ? '下一题' : '检查答案', 'btn-allow')}</div>`;
      }
      target.innerHTML = head(request) + body;
      target.insertAdjacentHTML('beforeend', '<p class="request-error" role="status" aria-live="polite"></p>');
      for (const detail of target.querySelectorAll('details')) detail.addEventListener('toggle', () => changed());
      const field = target.querySelector('fieldset');
      if (field) {
        const question = request.payload.questions[page];
        const text = field.querySelector('textarea');
        const activateText = async (event) => {
          if (submitting) return;
          editing = true;
          event.preventDefault();
          try {
            const focused = await keyboard(true);
            try { console.log('HUD_KEYBOARD ' + JSON.stringify(focused)); } catch { /* ignore */ }
            text.focus({ preventScroll: true });
          } catch { /* The host can still be used through the native client. */ }
        };
        text.addEventListener('pointerdown', activateText);
        text.addEventListener('click', activateText);
        text.addEventListener('compositionstart', () => { composing = true; editing = true; });
        text.addEventListener('compositionend', () => { composing = false; save(); });
        text.addEventListener('input', () => {
          if (!question.multiSelect && text.value) for (const input of field.querySelectorAll('input')) input.checked = false;
          save();
          changed();
        });
        for (const input of field.querySelectorAll('input')) input.addEventListener('change', () => {
          if (!question.multiSelect) text.value = '';
          save();
          const count = target.querySelector('.selection-count');
          if (count && question.multiSelect) count.textContent = `已选 ${answers(request)[page].selected.length} 项`;
          changed();
        });
      }
      updateControls();
    }
    function sync(next) {
      const previous = active;
      requests = Array.isArray(next) ? next : [];
      active = requests[0] || null;
      if (active?.id === previous?.id) { updateControls(); return; }
      // Save from the previous mounted layer before switching identities.
      if (previous) { const incoming = active; active = previous; save(); active = incoming; const oldLayer = layers[layerName(previous)]; delete oldLayer.dataset.native; oldLayer.replaceChildren(); }
      keyboard(false); editing = false; composing = false; submitting = false; uncertain = false; page = 0; reviewing = false; collapsed = false;
      if (!active) expiryNotice = '';
      if (active) {
        draw();
        tickExpiry();
      }
      changed();
    }
    async function submit(decision) {
      if (!active || submitting || uncertain || active.state !== 'pending') return;
      if (expired(active)) {
        tickExpiry();
        return;
      }
      save();
      const request = active;
      if (decision !== 'return') submitted.set(request.id, { at: Date.now(), confirmed: false,
        draftKey: request.kind === 'question' ? drafts.keyOf(request) : null });
      for (const [id, value] of submitted) if (Date.now() - value.at > 600000) submitted.delete(id);
      submitting = true; editing = false; keyboard(false); updateControls(); changed();
      try {
        const result = await api.reply({ id: request.id, decision, answers: answers(request) });
        if (result.status === 'failed' && active?.id === request.id) { submitting = false; uncertain = true; updateControls(); const message = layer().querySelector('.request-error'); if (message) message.textContent = '结果未知，请在 DSH 确认。答案草稿已保留。'; }
        if (result.status === 'delivered' && submitted.get(request.id)?.confirmed) return;
        if (result.status !== 'delivered') submitted.delete(request.id);
        toast(result.status === 'delivered' ? decision === 'return' ? '已交回客户端' : '已发送，等待客户端确认'
          : result.status === 'failed' ? '提交失败：' + (result.reason || '请返回客户端处理') : '请求已失效或已被处理');
      } catch { if (active?.id === request.id) { submitting = false; uncertain = true; updateControls(); layer().querySelector('.request-error').textContent = '结果未知，请在 DSH 确认。答案草稿已保留。'; } toast('连接失败，请返回客户端处理'); }
    }
    function collapse() { save(); collapsed = true; editing = false; keyboard(false); changed(); }
    function expand() { if (!active) return false; collapsed = false; changed(); return true; }
    function click(event) {
      const button = event.target.closest('[data-native-action]');
      if (!button || !active) return false;
      event.stopPropagation();
      const name = button.dataset.nativeAction;
      if (name === 'collapse') { collapse(); return true; }
      if (submitting || active.state !== 'pending' || expired(active)) {
        tickExpiry();
        return true;
      }
      if (['allow', 'deny', 'return'].includes(name)) void submit(name);
      else if (name === 'submit') void submit('answer');
      else {
        save(); editing = false; keyboard(false);
        if (name === 'prev') page = Math.max(0, page - 1);
        if (name === 'next') { if (page < active.payload.questions.length - 1) page++; else reviewing = true; }
        if (name === 'edit') reviewing = false;
        draw();
        changed();
      }
      return true;
    }
    return {
      connect() {
        expiryTimer = setInterval(() => { if (active && !collapsed && document.visibilityState !== 'hidden') tickExpiry(); }, 1000);
        if (!api) return;
        disposers.push(api.onConfirmation?.(value => {
          const sent = submitted.get(value.id);
          if (!sent || sent.confirmed || Date.now() - sent.at > 600000) return;
          const message = { 'allowed-once': '客户端已确认允许一次', rejected: '客户端已确认拒绝', answered: '客户端已收到答案', cancelled: '客户端已取消请求', unavailable: '客户端未接受该请求' }[value.outcome];
          if (message) {
            sent.confirmed = true;
            if (value.outcome === 'answered' && sent.draftKey) drafts.removeKey(sent.draftKey);
            feedback(message, value.outcome);
          }
        }));
        disposers.push(api.onRequests(next => { revision++; sync(next); }));
        const initialRevision = revision;
        api.snapshot().then(next => { if (revision === initialRevision) sync(next); }).catch(() => {});
      },
      owns: name => !!active && name === layerName(active),
      scene: () => active ? collapsed ? 'compact' : layerName(active) : null,
      height: () => null,
      summary: () => active ? { phase: active.kind === 'approval' ? 'waitingForApproval' : 'waitingForAnswer',
        text: `${source(active)} · ${active.kind === 'approval' ? active.payload.tool?.name || '等待审批' : active.payload.questions[0].question}`, count: requests.length } : null,
      click, collapse, expand, pending: () => !!active,
      active: () => active,
      protected: () => !!active && !collapsed && (editing || reviewing || submitting || composing || !!layer()?.querySelector('details[open]')),
      releaseEditing: () => { editing = false; composing = false; },
      keydown(event) {
        if (event.isComposing || composing || event.keyCode === 229) return;
        if (event.ctrlKey && event.key === 'Enter' && reviewing && !submitting && !uncertain) { event.preventDefault(); void submit('answer'); }
      },
      destroy() { save(); drafts.flush(); clearInterval(expiryTimer); },
      preview(request) { sync(request ? [request] : []); },
    };
  };
})();
