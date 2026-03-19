/* MailFlow — Frontend App Logic
 * All API calls go to /api/* on the same origin (Express backend).
 * No API keys or secrets live in this file — those are in .env on the server.
 */

const App = (() => {
  // ─── State ────────────────────────────────────────────────────────────────
  let currentUser   = null;
  let threads       = [];
  let activeThread  = null;   // full thread object
  let currentFilter = 'all';
  let searchQuery   = '';
  let toastTimer    = null;

  // ─── Init ─────────────────────────────────────────────────────────────────
  async function init() {
    const { user } = await api('/api/me');
    if (!user) {
      show('login-screen');
      hide('app');
    } else {
      currentUser = user;
      show('app');
      hide('login-screen');
      document.getElementById('agent-name').textContent = user.name;
      await loadThreads();
    }
  }

  // ─── API helper ───────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ─── Load & render thread list ────────────────────────────────────────────
  async function loadThreads() {
    try {
      const data = await api('/api/threads');
      threads = data.threads || [];
      updateCounts();
      renderList();
    } catch (e) {
      toast('⚠ Could not load threads: ' + e.message);
    }
  }

  function updateCounts() {
    document.getElementById('cnt-all').textContent   = threads.length;
    document.getElementById('cnt-ai').textContent    = threads.filter(t => t.status === 'ai').length;
    document.getElementById('cnt-human').textContent = threads.filter(t => t.status === 'human').length;
  }

  function renderList() {
    const container = document.getElementById('thread-list');
    const empty     = document.getElementById('thread-empty');

    let filtered = threads;
    if (currentFilter === 'ai')    filtered = threads.filter(t => t.status === 'ai');
    if (currentFilter === 'human') filtered = threads.filter(t => t.status === 'human');
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(t =>
        t.contact_name?.toLowerCase().includes(q) ||
        t.subject?.toLowerCase().includes(q) ||
        t.last_message_preview?.toLowerCase().includes(q)
      );
    }

    if (!filtered.length) {
      container.innerHTML = '';
      show('thread-empty');
      return;
    }
    hide('thread-empty');

    container.innerHTML = filtered.map(t => {
      const isAI    = t.status === 'ai';
      const isActive = activeThread?.id === t.id;
      const dotCls  = isAI ? 'blue' : 'coral';

      return `
        <div class="thread-item ${isActive ? 'active' : ''} mode-${t.status}"
             onclick="App.openThread('${t.id}')">
          <div class="ti-header">
            <div class="ti-dot ${dotCls}"></div>
            <div class="ti-from">${esc(t.contact_name)}</div>
            <div class="ti-time">${timeAgo(t.updated_at)}</div>
          </div>
          <div class="ti-subject">${esc(t.subject)}</div>
          <div class="ti-preview">${esc(t.last_message_preview || '—')}</div>
          <div class="ti-tags">
            ${isAI
              ? `<span class="tag ai">🤖 AI</span>`
              : `<span class="tag human">👤 ${esc(t.claimed_by_name || 'Human')}</span>`}
            ${t.message_count > 1
              ? `<span class="tag chain">⛓ ${t.message_count} msgs</span>`
              : ''}
            ${t.is_primary
              ? `<span class="tag good">✓ Primary</span>`
              : `<span class="tag warn">⚠ Check inbox</span>`}
          </div>
        </div>
      `;
    }).join('');
  }

  // ─── Open thread detail ───────────────────────────────────────────────────
  async function openThread(threadId) {
    try {
      const data = await api(`/api/threads/${threadId}`);
      activeThread = data.thread;
      renderList(); // refresh active state

      hide('detail-empty');
      show('detail-content');

      renderDetail(data.thread, data.contact, data.messages);
    } catch (e) {
      // 403 = not owner/claimed
      if (e.message.includes('Access denied') || e.message.includes('403')) {
        toast('🔒 You can only view threads you started or claimed.');
      } else {
        toast('Error: ' + e.message);
      }
    }
  }

  // ─── Render thread detail ─────────────────────────────────────────────────
  function renderDetail(thread, contact, messages) {
    const isOwner   = thread.owner_id === currentUser.id;
    const isClaimed = thread.claimed_by === currentUser.id;
    const isAiMode  = !!thread.ai_mode;
    const isHuman   = thread.status === 'human';

    const el = document.getElementById('detail-content');

    el.innerHTML = `
      <!-- Header -->
      <div class="detail-header">
        <div>
          <div class="detail-subject">${esc(thread.subject)}</div>
          <div class="detail-meta">
            <span>${esc(contact.name)} &lt;${esc(contact.email)}&gt;</span>
            <span>⛓ ${messages.length} message${messages.length !== 1 ? 's' : ''}</span>
            ${thread.is_primary
              ? `<span class="good">✓ Lands in Primary</span>`
              : `<span class="warn">⚠ Check deliverability</span>`}
            <span>Score: <strong style="color:var(--green)">${thread.deliv_score}%</strong></span>
          </div>
        </div>
        <div class="detail-actions">
          ${isOwner && !isHuman
            ? `<button class="btn btn-sm btn-human" onclick="App.claimThread('${thread.id}')">👤 Take over</button>`
            : ''}
          ${(isOwner || isClaimed) && isHuman
            ? `<button class="btn btn-sm btn-ai" onclick="App.releaseThread('${thread.id}')">🤖 Return to AI</button>`
            : ''}
        </div>
      </div>

      <!-- AI / Human mid-thread toggle (owner only) -->
      ${isOwner ? `
      <div class="mode-toggle">
        <div class="mode-toggle-label">
          <strong>Reply mode</strong> — toggle who handles the next reply
        </div>
        <div class="toggle-switch">
          <button class="toggle-opt ${isAiMode ? 'active-ai' : ''}"
                  onclick="App.toggleAiMode('${thread.id}', true)"
                  id="btn-ai-mode">🤖 AI</button>
          <button class="toggle-opt ${!isAiMode ? 'active-human' : ''}"
                  onclick="App.toggleAiMode('${thread.id}', false)"
                  id="btn-human-mode">👤 Me</button>
        </div>
      </div>` : ''}

      <!-- Escalation banner placeholder -->
      <div id="escalation-banner" class="escalation-banner hidden"></div>

      <!-- Messages chain -->
      <div class="section-title">Conversation chain</div>
      <div id="messages-chain">
        ${messages.map((m, i) => renderMessage(m, contact)).join('')}
      </div>

      <!-- Composer (owner or claimed only) -->
      ${(isOwner || isClaimed) ? `
      <div class="section-title">Compose reply</div>
      <div class="composer ${isAiMode ? '' : 'human-mode'}" id="composer">
        <div class="composer-top">
          <span class="clabel">From:</span>
          <strong style="font-size:13px">${esc(currentUser.name)}</strong>
          <span class="clabel" style="margin-left:auto">via</span>
          <span class="clabel" style="color:${isAiMode ? 'var(--accent)' : 'var(--coral)'}">
            ${isAiMode ? '🤖 AI draft' : '👤 Manual'}
          </span>
          ${isAiMode ? `
          <button class="btn btn-sm btn-ai" onclick="App.generateDraft('${thread.id}')" id="draft-btn">
            ⚡ Generate draft
          </button>` : ''}
        </div>
        <textarea class="composer-textarea" id="composer-text"
          placeholder="${isAiMode
            ? 'Click ⚡ Generate draft — AI will read the full chain and compose a reply…'
            : 'Write your reply here. Full conversation history is shown above for context…'}"></textarea>
        <div class="composer-footer">
          <div class="score-widget">
            <span>Send score</span>
            <div class="score-bar">
              <div class="score-fill" style="width:${thread.deliv_score}%"></div>
            </div>
            <span style="color:var(--green)">${thread.deliv_score}%</span>
          </div>
          <span style="flex:1"></span>
          <button class="btn btn-ghost btn-sm" onclick="App.clearDraft()">Clear</button>
          <button class="btn btn-primary btn-sm" onclick="App.sendReply('${thread.id}', ${isAiMode})">
            Send reply →
          </button>
        </div>
      </div>` : `
      <div style="margin-top:20px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);font-size:13px;color:var(--muted)">
        🔒 Only <strong>${esc(thread.owner_name)}</strong> can reply to this thread.
      </div>`}
    `;
  }

  // ─── Render a single message bubble ──────────────────────────────────────
  function renderMessage(msg, contact) {
    const roleMap = {
      'outbound-ai':    { cls: 'outbound-ai',    avCls: 'ai',      avLetter: 'AI', badgeCls: 'ai',    label: 'AI sent' },
      'outbound-human': { cls: 'outbound-human', avCls: 'human',   avLetter: '👤', badgeCls: 'human', label: 'Human sent' },
      'inbound':        { cls: 'inbound',        avCls: 'contact', avLetter: contact.name[0], badgeCls: 'in', label: 'Received' },
    };
    const r = roleMap[msg.role] || roleMap['inbound'];
    const hid = `headers-${msg.id}`;

    return `
      <div class="message-bubble ${r.cls}">
        <div class="msg-header">
          <div class="avatar ${r.avCls}">${r.avLetter}</div>
          <div class="msg-from">${esc(msg.from_name)}</div>
          <span class="msg-role-badge ${r.badgeCls}">${r.label}</span>
          <div class="msg-time">${new Date(msg.sent_at * 1000).toLocaleString()}</div>
        </div>
        <div class="msg-body">${esc(msg.body)}</div>
        <button class="show-headers-btn" onclick="toggleHeaders('${hid}')">show thread headers</button>
        <div class="msg-headers" id="${hid}">
          ${msg.message_id_header ? `<code>Message-ID: ${esc(msg.message_id_header)}</code>` : ''}
          ${msg.in_reply_to       ? `<code>In-Reply-To: ${esc(msg.in_reply_to)}</code>` : ''}
          ${msg.references_header ? `<code>References: ${esc(msg.references_header)}</code>` : ''}
        </div>
      </div>
    `;
  }

  // ─── Thread actions ────────────────────────────────────────────────────────

  async function claimThread(threadId) {
    try {
      await api(`/api/threads/${threadId}/claim`, { method: 'POST' });
      toast('👤 Thread claimed — you\'re now handling replies');
      await openThread(threadId);
      await loadThreads();
    } catch (e) { toast('Error: ' + e.message); }
  }

  async function releaseThread(threadId) {
    try {
      await api(`/api/threads/${threadId}/release`, { method: 'POST' });
      toast('🤖 Returned to AI management');
      await openThread(threadId);
      await loadThreads();
    } catch (e) { toast('Error: ' + e.message); }
  }

  // ─── AI / Human mid-thread toggle ─────────────────────────────────────────
  // The core feature: switch who handles the NEXT reply without losing history.
  async function toggleAiMode(threadId, aiMode) {
    try {
      await api(`/api/threads/${threadId}/toggle-ai`, {
        method: 'POST',
        body: { aiMode },
      });

      const label = aiMode ? '🤖 AI will handle next reply' : '👤 You\'ll handle next reply';
      toast(label);

      // Refresh detail pane
      await openThread(threadId);
      await loadThreads();
    } catch (e) { toast('Error: ' + e.message); }
  }

  // ─── Generate AI draft ─────────────────────────────────────────────────────
  async function generateDraft(threadId) {
    const btn = document.getElementById('draft-btn');
    const ta  = document.getElementById('composer-text');
    if (!btn || !ta) return;

    btn.textContent = '⏳ Generating…';
    btn.disabled = true;
    ta.value = '';
    ta.placeholder = 'Claude is reading the full thread chain…';

    try {
      const { draft, escalation } = await api(`/api/threads/${threadId}/draft`, { method: 'POST' });
      ta.value = draft;

      // Show escalation warning if needed
      if (escalation?.escalate) {
        const banner = document.getElementById('escalation-banner');
        banner.innerHTML = `⚠ AI suggests human review: ${esc(escalation.reason)}`;
        banner.classList.remove('hidden');
      }

      toast('⚡ AI draft ready — review before sending');
    } catch (e) {
      toast('Draft error: ' + e.message);
    } finally {
      btn.textContent = '⚡ Generate draft';
      btn.disabled = false;
    }
  }

  // ─── Send reply ────────────────────────────────────────────────────────────
  async function sendReply(threadId, isAiMode) {
    const ta = document.getElementById('composer-text');
    const body = ta?.value?.trim();
    if (!body) { toast('Write something first'); return; }

    const role = isAiMode ? 'outbound-ai' : 'outbound-human';

    try {
      await api(`/api/threads/${threadId}/reply`, {
        method: 'POST',
        body: { body, role },
      });

      toast('✓ Reply sent — thread chain updated');
      ta.value = '';
      await openThread(threadId);
      await loadThreads();
    } catch (e) { toast('Send error: ' + e.message); }
  }

  function clearDraft() {
    const ta = document.getElementById('composer-text');
    if (ta) ta.value = '';
  }

  // ─── New thread modal ─────────────────────────────────────────────────────
  function newThread() {
    document.getElementById('new-thread-modal').classList.remove('hidden');
  }

  async function submitNewThread() {
    const contactEmail  = v('nt-email');
    const contactName   = v('nt-name');
    const contactCompany= v('nt-company');
    const subject       = v('nt-subject');
    const body          = v('nt-body');

    if (!contactEmail || !subject || !body) {
      toast('Email, subject, and message are required');
      return;
    }

    try {
      const { threadId } = await api('/api/threads', {
        method: 'POST',
        body: { contactEmail, contactName, contactCompany, subject, body },
      });

      closeModal('new-thread-modal');
      toast('🚀 Thread started — first email sent');
      await loadThreads();
      await openThread(threadId);
    } catch (e) { toast('Error: ' + e.message); }
  }

  // ─── Filter & search ──────────────────────────────────────────────────────
  function setFilter(filter, el) {
    currentFilter = filter;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
    renderList();
  }

  function search(q) {
    searchQuery = q;
    renderList();
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────
  async function logout() {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
  function hide(id) { document.getElementById(id)?.classList.add('hidden'); }
  function v(id)    { return document.getElementById(id)?.value?.trim() || ''; }
  function esc(s)   { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

  function timeAgo(unixTs) {
    const diff = Math.floor(Date.now() / 1000) - unixTs;
    if (diff < 60)   return 'just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400)return `${Math.floor(diff/3600)}h ago`;
    return `${Math.floor(diff/86400)}d ago`;
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // Public exports
  return {
    init, openThread, claimThread, releaseThread,
    toggleAiMode, generateDraft, sendReply, clearDraft,
    newThread, submitNewThread, closeModal,
    setFilter, search, logout,
  };
})();

// ─── Global helpers ────────────────────────────────────────────────────────────
function toggleHeaders(id) {
  document.getElementById(id)?.classList.toggle('open');
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', App.init);