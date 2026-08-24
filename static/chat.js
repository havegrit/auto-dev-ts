(() => {
  'use strict';

  const STORAGE_PREFIX = 'auto-dev.chat.v1.';
  const PREF_KEY = 'auto-dev.chat-prefs.v1';
  const HISTORY_LIMIT = 30000;
  let config = { model: '', availableModels: [], projects: [] };
  let mode = 'general';
  let project = '';
  let state = null;
  let activeKey = '';
  let abortController = null;
  let failedRequest = false;
  let busy = false;

  const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const scopeKey = (nextMode = mode, nextProject = project) => nextMode === 'project' && nextProject ? `project:${nextProject}` : 'general';
  const storageKey = (key) => `${STORAGE_PREFIX}${encodeURIComponent(key)}`;

  function emptyState() {
    return { messages: [], memory: '', model: config.model || '', summarizedIds: [], updatedAt: new Date().toISOString() };
  }

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }

  function normalizeState(value) {
    const fallback = emptyState();
    if (!value || typeof value !== 'object') return fallback;
    return {
      messages: Array.isArray(value.messages) ? value.messages.filter((message) =>
        (message?.role === 'user' || message?.role === 'assistant') && typeof message.content === 'string'
      ).map((message) => ({
        id: typeof message.id === 'string' ? message.id : id(),
        role: message.role,
        content: message.content,
        createdAt: message.createdAt || new Date().toISOString(),
      })) : [],
      memory: typeof value.memory === 'string' ? value.memory : '',
      model: typeof value.model === 'string' && value.model ? value.model : fallback.model,
      summarizedIds: Array.isArray(value.summarizedIds) ? value.summarizedIds.filter((item) => typeof item === 'string') : [],
      updatedAt: value.updatedAt || fallback.updatedAt,
    };
  }

  function saveState(target = state, key = activeKey) {
    if (!target || !key) return;
    target.updatedAt = new Date().toISOString();
    try { localStorage.setItem(storageKey(key), JSON.stringify(target)); } catch {}
  }

  function loadScope() {
    saveState();
    activeKey = scopeKey();
    state = normalizeState(readJson(storageKey(activeKey), null));
    if (!config.availableModels.some((modelSpec) => modelSpec.id === state.model)) state.model = config.model || config.availableModels[0]?.id || '';
    savePrefs();
    renderAll();
  }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ mode, project })); } catch {}
  }

  function createWidget() {
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'chat-fab';
    fab.className = 'chat-fab';
    fab.setAttribute('aria-label', 'AI 채팅 열기');
    fab.setAttribute('aria-expanded', 'false');
    fab.textContent = '✦';

    const panel = document.createElement('section');
    panel.id = 'chat-panel';
    panel.className = 'chat-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'AI 채팅');
    panel.innerHTML = `
      <header class="chat-panel-header">
        <div class="chat-panel-title">AI 채팅<span class="chat-memory-size" id="chat-memory-size">기억 없음</span></div>
        <button type="button" class="chat-icon-btn" id="chat-new" title="새 대화">새 대화</button>
        <button type="button" class="chat-icon-btn" id="chat-memory-delete" title="장기 기억만 삭제">기억 삭제</button>
        <button type="button" class="chat-icon-btn" id="chat-delete" title="대화와 기억 모두 삭제">전체 삭제</button>
        <button type="button" class="chat-icon-btn" id="chat-close" aria-label="채팅 닫기">×</button>
      </header>
      <div class="chat-toolbar">
        <div class="chat-mode-tabs" role="group" aria-label="채팅 모드">
          <button type="button" class="chat-mode-btn" data-chat-mode="general">일반</button>
          <button type="button" class="chat-mode-btn" data-chat-mode="project">프로젝트</button>
        </div>
        <div class="chat-select-row">
          <div class="chat-select-group"><label for="chat-project">채팅 프로젝트</label><select id="chat-project"></select></div>
          <div class="chat-select-group"><label for="chat-model">모델</label><select id="chat-model"></select></div>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages" aria-live="polite"></div>
      <div class="chat-status-row"><span class="chat-status" id="chat-status">준비됨</span><button type="button" class="chat-retry" id="chat-retry" hidden>재시도</button></div>
      <div class="chat-composer">
        <textarea class="chat-input" id="chat-input" rows="2" placeholder="메시지를 입력하세요" aria-label="채팅 메시지"></textarea>
        <div class="chat-composer-actions">
          <span class="chat-input-hint">Enter 전송 · Shift+Enter 줄바꿈</span>
          <button type="button" class="chat-stop-btn" id="chat-stop">중지</button>
          <button type="button" class="chat-send-btn" id="chat-send">전송</button>
        </div>
      </div>`;
    document.body.append(fab, panel);
  }

  function htmlEscape(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function renderMarkdown(element, content) {
    if (window.marked && window.DOMPurify) {
      element.classList.add('md-body');
      element.innerHTML = DOMPurify.sanitize(marked.parse(content || ''));
    } else {
      element.classList.remove('md-body');
      element.textContent = content || '';
    }
  }

  function messageElement(message, streaming = false) {
    const wrapper = document.createElement('div');
    wrapper.className = `chat-message ${message.role}${streaming ? ' streaming' : ''}`;
    wrapper.dataset.messageId = message.id;
    const label = document.createElement('div');
    label.className = 'chat-message-label';
    label.textContent = message.role === 'user' ? '나' : 'AI';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    if (message.role === 'assistant') renderMarkdown(bubble, message.content);
    else bubble.textContent = message.content;
    wrapper.append(label, bubble);
    return wrapper;
  }

  function renderMessages() {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    if (!state.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.innerHTML = mode === 'project'
        ? '프로젝트를 선택하고 질문하세요.<br>README와 관련 파일을 안전하게 찾아 답합니다.'
        : '일반 AI 채팅입니다.<br>프로젝트 파일은 전달하지 않습니다.';
      container.append(empty);
      return;
    }
    for (const message of state.messages) container.append(messageElement(message));
    container.scrollTop = container.scrollHeight;
  }

  function renderSelectors() {
    document.querySelectorAll('[data-chat-mode]').forEach((button) => {
      const active = button.dataset.chatMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const projectSelect = document.getElementById('chat-project');
    projectSelect.innerHTML = `<option value="">프로젝트 선택</option>${config.projects.map((name) =>
      `<option value="${htmlEscape(name)}"${name === project ? ' selected' : ''}>${htmlEscape(name)}</option>`
    ).join('')}`;
    projectSelect.disabled = busy || mode !== 'project';

    const modelSelect = document.getElementById('chat-model');
    modelSelect.innerHTML = config.availableModels.map((modelSpec) => {
      const label = modelSpec.description ? `${modelSpec.displayName} — ${modelSpec.description}` : modelSpec.displayName;
      return `<option value="${htmlEscape(modelSpec.id)}"${modelSpec.id === state.model ? ' selected' : ''}>${htmlEscape(label)}</option>`;
    }).join('');
    modelSelect.value = state.model;
    modelSelect.disabled = busy || (mode === 'project' && !project);
  }

  function renderAll() {
    if (!state) return;
    renderSelectors();
    renderMessages();
    document.getElementById('chat-memory-size').textContent = mode === 'project' && state.memory
      ? `장기 기억 ${state.memory.length.toLocaleString()}자`
      : '장기 기억 없음';
    document.getElementById('chat-memory-delete').disabled = mode !== 'project' || !state.memory;
  }

  function setStatus(text, error = false) {
    const element = document.getElementById('chat-status');
    element.textContent = text;
    element.style.color = error ? '#f85149' : '#8b949e';
  }

  function setGenerating(generating, stoppable = true) {
    busy = generating;
    document.getElementById('chat-panel').classList.toggle('generating', generating);
    document.getElementById('chat-stop').style.display = generating && !stoppable ? 'none' : '';
    document.getElementById('chat-input').disabled = generating;
    document.querySelectorAll('#chat-panel select, [data-chat-mode], #chat-new, #chat-memory-delete, #chat-delete').forEach((element) => {
      element.disabled = generating || (element.id === 'chat-memory-delete' && (mode !== 'project' || !state.memory));
    });
    document.getElementById('chat-project').disabled = generating || mode !== 'project';
    document.getElementById('chat-model').disabled = generating || (mode === 'project' && !project);
  }

  function recentContext() {
    const selected = [];
    const overflow = [];
    let used = 0;
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index];
      if (used + message.content.length > HISTORY_LIMIT) {
        overflow.unshift(...state.messages.slice(0, index + 1));
        break;
      }
      selected.unshift({ role: message.role, content: message.content });
      used += message.content.length;
    }
    if (!selected.length && state.messages.length) {
      const last = state.messages.at(-1);
      selected.push({ role: last.role, content: last.content.slice(-HISTORY_LIMIT) });
      overflow.push(...state.messages.slice(0, -1), last);
    }
    return { selected, overflow };
  }

  function memoryTokens(text) {
    return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []).slice(0, 30))];
  }

  function relevantMemory(question, recentMessages) {
    if (mode !== 'project' || !state.memory) return '';
    const tokens = memoryTokens(question);
    const recent = recentMessages.slice(0, -1).map((message) => message.content.toLowerCase()).join('\n');
    if (tokens.some((token) => recent.includes(token))) return '';
    const sections = state.memory.split(/(?=^##\s+)/m).filter((section) => section.trim());
    return sections.map((section) => ({
      section,
      score: tokens.reduce((score, token) => score + (section.toLowerCase().includes(token) ? 1 : 0), 0),
    })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
      .slice(0, 4).map((item) => item.section.trim()).join('\n\n');
  }

  function chunkMessages(messages) {
    const chunks = [];
    let chunk = [];
    let size = 0;
    for (const message of messages) {
      if (chunk.length && size + message.content.length > HISTORY_LIMIT) {
        chunks.push(chunk); chunk = []; size = 0;
      }
      const content = message.content.length > HISTORY_LIMIT ? message.content.slice(-HISTORY_LIMIT) : message.content;
      chunk.push({ ...message, content });
      size += content.length;
    }
    if (chunk.length) chunks.push(chunk);
    return chunks;
  }

  async function summarizeIntoMemory(messages, targetState = state, key = activeKey) {
    if (mode !== 'project' || !messages.length) return true;
    const summarized = new Set(targetState.summarizedIds);
    const pending = messages.filter((message) => !summarized.has(message.id));
    if (!pending.length) return true;
    let memory = targetState.memory;
    try {
      for (const chunk of chunkMessages(pending)) {
        const response = await fetch('/api/chat/memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            existingMemory: memory,
            messages: chunk.map(({ role, content }) => ({ role, content })),
            model: targetState.model,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '장기 기억 갱신 실패');
        memory = data.memory || memory;
        chunk.forEach((message) => summarized.add(message.id));
      }
      targetState.memory = memory;
      targetState.summarizedIds = [...summarized].slice(-1000);
      saveState(targetState, key);
      if (key === activeKey) renderAll();
      return true;
    } catch (error) {
      setStatus(`기억 갱신 실패: ${error.message}`, true);
      return false;
    }
  }

  async function readNdjson(response, onEvent) {
    if (!response.body) throw new Error('스트림 응답이 없습니다.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  }

  async function sendMessage(text, retry = false) {
    const clean = text.trim();
    if ((!clean && !retry) || abortController) return;
    if (mode === 'project' && !project) {
      setStatus('채팅 프로젝트를 선택하세요.', true);
      document.getElementById('chat-project').focus();
      return;
    }
    if (!retry) {
      state.messages.push({ id: id(), role: 'user', content: clean, createdAt: new Date().toISOString() });
      document.getElementById('chat-input').value = '';
      saveState();
      renderMessages();
    }
    const last = state.messages.at(-1);
    if (!last || last.role !== 'user') return;

    failedRequest = false;
    document.getElementById('chat-retry').hidden = true;
    abortController = new AbortController();
    setGenerating(true);
    setStatus(mode === 'project' ? '관련 프로젝트 문맥 찾는 중…' : 'AI 응답 기다리는 중…');

    const streamingMessage = { id: id(), role: 'assistant', content: '', createdAt: new Date().toISOString() };
    const container = document.getElementById('chat-messages');
    const wrapper = messageElement(streamingMessage, true);
    container.append(wrapper);
    container.scrollTop = container.scrollHeight;
    const bubble = wrapper.querySelector('.chat-bubble');
    const { selected, overflow } = recentContext();
    let output = '';
    let files = [];
    let streamError = null;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          mode,
          ...(mode === 'project' ? { project } : {}),
          model: state.model,
          messages: selected,
          memory: relevantMemory(last.content, selected),
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `채팅 요청 실패 (${response.status})`);
      }
      await readNdjson(response, (event) => {
        if (event.type === 'context') {
          files = Array.isArray(event.files) ? event.files : [];
          setStatus(files.length ? `참고 파일 ${files.length}개 · 답변 생성 중…` : '답변 생성 중…');
        } else if (event.type === 'delta') {
          output += event.text || '';
          renderMarkdown(bubble, output);
          container.scrollTop = container.scrollHeight;
        } else if (event.type === 'done' && !output) {
          output = event.text || '';
          renderMarkdown(bubble, output);
        } else if (event.type === 'error') {
          streamError = new Error(event.error || '채팅 생성 실패');
        }
      });
      if (streamError) throw streamError;
      if (!output.trim()) throw new Error('AI가 빈 응답을 반환했습니다.');
      wrapper.classList.remove('streaming');
      streamingMessage.content = output;
      state.messages.push(streamingMessage);
      saveState();
      setStatus(files.length ? `완료 · 참고: ${files.join(', ')}` : '완료');
      if (overflow.length && mode === 'project') summarizeIntoMemory(overflow).catch(() => {});
    } catch (error) {
      wrapper.remove();
      if (error.name === 'AbortError') {
        if (output.trim()) {
          streamingMessage.content = `${output}\n\n_생성이 중지되었습니다._`;
          state.messages.push(streamingMessage);
          saveState();
          renderMessages();
        }
        setStatus('생성 중지됨');
      } else {
        failedRequest = true;
        document.getElementById('chat-retry').hidden = false;
        setStatus(error.message || '채팅 실패', true);
      }
    } finally {
      abortController = null;
      setGenerating(false);
    }
  }

  async function newConversation() {
    if (!state.messages.length) return;
    if (!window.confirm('현재 대화를 비웁니다. 프로젝트 장기 기억은 유지됩니다.')) return;
    setGenerating(true, false);
    setStatus(mode === 'project' ? '장기 기억 정리 중…' : '새 대화 준비 중…');
    if (mode === 'project') await summarizeIntoMemory(state.messages);
    state.messages = [];
    state.summarizedIds = [];
    saveState();
    renderAll();
    setGenerating(false);
    setStatus('새 대화 시작');
  }

  function deleteMemory() {
    if (!state.memory || mode !== 'project') return;
    if (!window.confirm('현재 프로젝트의 장기 기억을 삭제합니다. 이 작업은 복구할 수 없습니다.')) return;
    state.memory = '';
    state.summarizedIds = [];
    saveState();
    renderAll();
    setStatus('장기 기억 삭제됨');
  }

  function deleteAll() {
    if (!window.confirm('현재 채팅의 대화와 장기 기억을 모두 삭제합니다. 이 작업은 복구할 수 없습니다.')) return;
    state = emptyState();
    saveState();
    renderAll();
    setStatus('대화와 기억 삭제됨');
  }

  function bindEvents() {
    document.getElementById('chat-fab').addEventListener('click', () => {
      const panel = document.getElementById('chat-panel');
      panel.hidden = !panel.hidden;
      document.getElementById('chat-fab').setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) setTimeout(() => document.getElementById('chat-input').focus(), 0);
    });
    document.getElementById('chat-close').addEventListener('click', () => {
      document.getElementById('chat-panel').hidden = true;
      document.getElementById('chat-fab').setAttribute('aria-expanded', 'false');
      document.getElementById('chat-fab').focus();
    });
    document.querySelectorAll('[data-chat-mode]').forEach((button) => button.addEventListener('click', () => {
      mode = button.dataset.chatMode;
      loadScope();
      setStatus(mode === 'project' && !project ? '채팅 프로젝트를 선택하세요.' : '준비됨');
    }));
    document.getElementById('chat-project').addEventListener('change', (event) => {
      project = event.target.value;
      if (project) mode = 'project';
      loadScope();
      setStatus(project ? '프로젝트 채팅 준비됨' : '채팅 프로젝트를 선택하세요.');
    });
    document.getElementById('chat-model').addEventListener('change', (event) => {
      state.model = event.target.value;
      saveState();
      setStatus('채팅 모델 저장됨');
    });
    document.getElementById('chat-send').addEventListener('click', () => sendMessage(document.getElementById('chat-input').value));
    document.getElementById('chat-stop').addEventListener('click', () => abortController?.abort());
    document.getElementById('chat-retry').addEventListener('click', () => failedRequest && sendMessage('', true));
    document.getElementById('chat-new').addEventListener('click', newConversation);
    document.getElementById('chat-memory-delete').addEventListener('click', deleteMemory);
    document.getElementById('chat-delete').addEventListener('click', deleteAll);
    document.getElementById('chat-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage(event.currentTarget.value);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !document.getElementById('chat-panel').hidden && !abortController) {
        document.getElementById('chat-close').click();
      }
    });
  }

  async function init() {
    createWidget();
    bindEvents();
    try {
      const response = await fetch('/api/config');
      config = await response.json();
      config.availableModels = config.availableModels || [];
      config.projects = config.projects || [];
      const prefs = readJson(PREF_KEY, {});
      project = typeof prefs.project === 'string' && config.projects.includes(prefs.project) ? prefs.project : '';
      mode = prefs.mode === 'project' && project ? 'project' : 'general';
      activeKey = scopeKey();
      state = normalizeState(readJson(storageKey(activeKey), null));
      renderAll();
    } catch (error) {
      state = emptyState();
      activeKey = 'general';
      renderAll();
      setStatus(`채팅 설정 로드 실패: ${error.message}`, true);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
