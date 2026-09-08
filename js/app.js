(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const page = document.body.dataset.page || '';
  const params = new URLSearchParams(location.search);

  function esc(value = '') {
    const el = document.createElement('div');
    el.textContent = String(value);
    return el.innerHTML;
  }
  function fmtDate(value) {
    if (!value) return 'Recently';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  }
  function normalizeVerdict(value = '') {
    const v = String(value).toLowerCase();
    if (v.includes('real') || v.includes('true')) return 'real';
    if (v.includes('mislead')) return 'misleading';
    if (v.includes('fake') || v.includes('false')) return 'fake';
    return 'unverified';
  }
  function verdictLabel(value = '') {
    const type = normalizeVerdict(value);
    return type === 'real' ? 'Real' : type === 'fake' ? 'Fake' : type === 'misleading' ? 'Misleading' : 'Unverified';
  }
  function toast(message, kind = 'default') {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add('show');
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }
  async function api(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));
    if (!response.ok || data.success === false) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function setBusy(button, busy, label = 'Working…') {
    if (!button) return;
    if (busy) {
      if (!button.dataset.original) button.dataset.original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span>${esc(label)}`;
    } else {
      button.disabled = false;
      if (button.dataset.original) button.innerHTML = button.dataset.original;
    }
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }
  function setTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    localStorage.setItem('ng_theme', next);
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    const toggle = $('#themeToggle');
    if (toggle) toggle.checked = next === 'dark';
    window.dispatchEvent(new CustomEvent('newsguard-theme-change', { detail: next }));
  }
  function wireBottomNav() {
    $$('.bottom-nav .nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === page));
  }
  function avatarKey(userId = 'guest') { return `ng_avatar_${userId}`; }
  function loadAvatarInto(img, initial, userId = 'guest', name = 'User') {
    const stored = localStorage.getItem(avatarKey(userId));
    if (stored && img) {
      img.src = stored;
      img.hidden = false;
      if (initial) initial.hidden = true;
    } else {
      if (img) img.hidden = true;
      if (initial) { initial.hidden = false; initial.textContent = String(name || 'U').trim().charAt(0).toUpperCase() || 'U'; }
    }
  }
  async function compressAvatar(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const el = new Image(); el.onload = () => resolve(el); el.onerror = reject; el.src = dataUrl;
    });
    const size = 360;
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.84);
  }

  async function initHome() {
    const status = $('#apiStatus');
    const authWarning = sessionStorage.getItem('ng_auth_warning');
    if (authWarning) { sessionStorage.removeItem('ng_auth_warning'); setTimeout(() => toast(authWarning, 'error'), 300); }
    let user = null;
    try {
      const data = await api('/api/health');
      user = data.user;
      if (status) {
        status.className = `api-pill ${data.geminiConfigured ? 'ok' : 'warn'}`;
        status.innerHTML = data.geminiConfigured ? `<span></span> Gemini connected · ${esc(data.model)}` : `<span></span> Gemini API key required`;
      }
      const hello = $('#helloUser');
      if (hello) hello.textContent = data.user ? `Hi, ${data.user.fullName.split(' ')[0]}` : 'Guest mode';
      loadAvatarInto($('#homeAvatarImage'), $('#homeAvatarInitial'), data.user?.id || 'guest', data.user?.fullName || 'Guest');
    } catch {
      if (status) { status.className = 'api-pill bad'; status.innerHTML = '<span></span> Server unavailable'; }
      loadAvatarInto($('#homeAvatarImage'), $('#homeAvatarInitial'), 'guest', 'Guest');
    }

    $('#howBtn')?.addEventListener('click', () => {
      $('#howPanel')?.classList.toggle('show');
      $('#howBtn')?.classList.toggle('active');
    });
    $('#menuBtn')?.addEventListener('click', () => {
      const panel = $('#howPanel');
      if (panel) { panel.classList.add('show'); panel.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    $('#quickNewsForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const value = $('#quickNewsUrl')?.value.trim();
      if (!value) return toast('Paste a news URL first.', 'error');
      location.href = `checknews.html?mode=url&url=${encodeURIComponent(value)}`;
    });
    $('#uploadTextBtn')?.addEventListener('click', () => $('#quickTextFile')?.click());
    $('#quickTextFile')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) return toast('Text file must be 2 MB or smaller.', 'error');
      try {
        const text = await file.text();
        if (text.trim().length < 8) return toast('This file does not contain enough text.', 'error');
        sessionStorage.setItem('ng_prefill_text', text.slice(0, 6000));
        location.href = 'checknews.html?mode=text&prefill=1';
      } catch { toast('Could not read this text file.', 'error'); }
    });
  }

  function initAnalyze() {
    const tabs = $$('.segmented [data-tab]');
    const panels = $$('.field-wrap');
    const form = $('#analyzeForm');
    const textarea = $('#articleText');
    const count = $('#charCount');
    const imageInput = $('#newsImage');
    const imageName = $('#imageName');

    function selectTab(tab) {
      const chosen = ['text', 'url', 'image'].includes(tab) ? tab : 'text';
      tabs.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === chosen));
      panels.forEach(panel => panel.classList.toggle('active', panel.dataset.panel === chosen));
      if ($('#mode')) $('#mode').value = chosen;
    }
    tabs.forEach(btn => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));
    selectTab(params.get('mode') || 'text');

    if (params.get('url') && $('#articleUrl')) $('#articleUrl').value = params.get('url');
    if (params.get('prefill') === '1' && textarea) {
      textarea.value = sessionStorage.getItem('ng_prefill_text') || '';
      sessionStorage.removeItem('ng_prefill_text');
    }
    const updateCount = () => { if (count && textarea) count.textContent = `${textarea.value.length}/6000`; };
    textarea?.addEventListener('input', updateCount); updateCount();

    $$('.example-chip').forEach(btn => btn.addEventListener('click', () => {
      selectTab('text');
      if (textarea) { textarea.value = btn.dataset.text || btn.textContent.trim(); textarea.dispatchEvent(new Event('input')); textarea.focus(); }
    }));

    imageInput?.addEventListener('change', () => {
      const file = imageInput.files?.[0];
      if (imageName) imageName.textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB` : 'JPG, PNG, WEBP · max 8 MB';
      const preview = $('#imagePreview');
      if (preview) {
        if (file) { preview.src = URL.createObjectURL(file); preview.hidden = false; }
        else preview.hidden = true;
      }
    });

    form?.addEventListener('submit', async event => {
      event.preventDefault();
      const button = $('#analyzeBtn');
      const mode = $('#mode')?.value || 'text';
      const payload = { mode };
      if (mode === 'text') payload.text = textarea?.value.trim() || '';
      if (mode === 'url') payload.url = $('#articleUrl')?.value.trim() || '';
      if (mode === 'image') {
        const file = imageInput?.files?.[0];
        if (!file) { toast('Choose an image first.', 'error'); return; }
        if (file.size > 8 * 1024 * 1024) { toast('Image must be 8 MB or smaller.', 'error'); return; }
        const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        payload.imageBase64 = String(dataUrl).split(',')[1] || '';
        payload.imageMime = file.type;
        payload.imageName = file.name;
      }
      setBusy(button, true, mode === 'url' ? 'Reading article…' : 'Checking with Gemini…');
      try {
        const data = await api('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        sessionStorage.setItem('ng_last_item', JSON.stringify(data.item));
        location.href = `result.html?id=${encodeURIComponent(data.item.id)}`;
      } catch (error) {
        toast(error.message, 'error');
        if (error.status === 503) $('#apiHelp')?.classList.add('show');
      } finally { setBusy(button, false); }
    });
    $('#apiHelpClose')?.addEventListener('click', () => $('#apiHelp')?.classList.remove('show'));
  }

  function resultTemplate(item) {
    const a = item.analysis || {};
    const type = normalizeVerdict(a.verdict);
    const fakeLike = type === 'fake' || type === 'misleading';
    const icon = type === 'real' ? '✓' : type === 'fake' ? '×' : type === 'misleading' ? '!' : '?';
    const title = type === 'real' ? 'Likely Real News' : type === 'fake' ? 'Likely Fake News' : type === 'misleading' ? 'Potentially Misleading' : 'Unverified Claim';
    const heroClass = type === 'real' ? 'real' : type === 'unverified' ? 'neutral' : 'fake';
    const reasons = (a.reasons || []).map((r, i) => `<div class="reason"><span class="reason-num">${i + 1}</span><span>${esc(r)}</span></div>`).join('');
    const warnings = (a.warningSigns || []).length ? `<section class="card"><h3 class="section-title">⚠️ Warning Signs</h3><div class="tag-cloud">${a.warningSigns.map(w => `<span>${esc(w)}</span>`).join('')}</div></section>` : '';
    const sources = (a.trustedSources || []).length ? a.trustedSources.map(s => {
      const inner = `<div class="source-logo">✓</div><div><strong>${esc(s.name)}</strong><p>${esc(s.note || 'Independent source to consult.')}</p></div><div class="source-arrow">${s.url ? '↗' : '•'}</div>`;
      return s.url ? `<a class="source-row" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<div class="source-row">${inner}</div>`;
    }).join('') : `<p class="muted-copy">No source suggestions were returned. Search trusted primary sources before sharing.</p>`;
    const safeHeadline = a.headline || item.input || 'Analyzed news content';
    return `<section class="result-hero ${heroClass}"><div class="verdict-row"><div class="verdict-icon">${icon}</div><div><h2>${title}</h2><p>${esc(a.summary || 'Review the reasons below before sharing.')}</p></div></div><div class="score-label">Classification confidence</div><div class="score-line"><div class="score-track"><div class="score-fill" style="width:${Number(a.confidence || 0)}%"></div></div><div class="score-num">${Number(a.confidence || 0)}%</div></div></section><section class="card"><p class="claim">“${esc(safeHeadline)}”</p><div class="meta">Source: ${esc(a.sourceType || item.mode || 'Input')} · Checked ${esc(fmtDate(item.createdAt || a.checkedAt))}</div></section><section class="card"><h3 class="section-title">💡 Key ${fakeLike ? 'Reasons' : 'Points'}</h3><div class="reason-list">${reasons || '<p class="muted-copy">No detailed reasons were returned.</p>'}</div></section>${warnings}<section class="card"><h3 class="section-title">📚 Sources to Verify</h3>${sources}</section><div class="notice-card">AI fact-checking can make mistakes. For important claims, verify with original documents and multiple trusted sources.</div><div class="action-stack"><button class="primary-btn share-btn" id="shareResult">↗ Share Result</button><button class="secondary-btn" id="saveResult">♡ Save Article</button><a class="secondary-btn" href="checknews.html">⌕ Check Another News</a></div>`;
  }
  async function initResult() {
    const root = $('#resultRoot'); if (!root) return;
    let item = null; const idValue = params.get('id');
    if (idValue) { try { item = (await api(`/api/history/${encodeURIComponent(idValue)}`)).item; } catch {} }
    if (!item) { try { item = JSON.parse(sessionStorage.getItem('ng_last_item') || 'null'); } catch { item = null; } }
    if (!item) { root.innerHTML = `<div class="empty-state"><div class="empty-icon">⌕</div><h3>No result selected</h3><p>Analyze news first or open an item from History.</p><a class="primary-btn" style="margin-top:18px" href="checknews.html">Analyze News</a></div>`; return; }
    root.innerHTML = resultTemplate(item);
    $('#shareResult')?.addEventListener('click', async () => {
      const a = item.analysis; const text = `NewsGuard AI: ${verdictLabel(a.verdict)} (${a.confidence}% confidence)\n${a.headline}\n${a.summary}`;
      if (navigator.share) { try { await navigator.share({ title: 'NewsGuard AI Result', text }); } catch {} }
      else { await navigator.clipboard.writeText(text).catch(() => {}); toast('Result copied to clipboard.'); }
    });
    $('#saveResult')?.addEventListener('click', async () => {
      try { const data = await api('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ historyId: item.id }) }); toast(data.alreadySaved ? 'Already saved.' : 'Saved successfully.'); $('#saveResult').textContent = '✓ Saved'; }
      catch (error) { toast(error.message, 'error'); }
    });
  }

  function historyCard(item, options = {}) {
    const a = item.analysis || {}, type = normalizeVerdict(a.verdict), icon = type === 'real' ? '✓' : type === 'fake' ? '×' : type === 'misleading' ? '!' : '?';
    return `<article class="history-card history-card-actions" data-id="${esc(item.id)}"><div class="status-dot ${type}">${icon}</div><a class="history-main" href="result.html?id=${encodeURIComponent(item.id)}"><h3>${esc(a.headline || item.input || 'News analysis')}</h3><div class="history-meta"><span class="${type}">${verdictLabel(a.verdict)}</span><span>•</span><span>${esc(a.confidence ?? 0)}%</span><span>•</span><span>${esc(fmtDate(item.createdAt))}</span></div></a>${options.deleteId ? `<button class="mini-action danger history-delete" data-id="${esc(options.deleteId)}" title="Delete">×</button>` : '<div class="chev">›</div>'}</article>`;
  }
  async function initHistory() {
    const root = $('#historyList'); let data = [];
    async function load() { try { data = (await api('/api/history')).history || []; render('all'); } catch (error) { root.innerHTML = `<div class="empty-state"><div class="empty-icon">!</div><h3>History unavailable</h3><p>${esc(error.message)}</p></div>`; } }
    function render(filter) {
      const items = data.filter(item => filter === 'all' || normalizeVerdict(item.analysis?.verdict) === filter);
      root.innerHTML = items.length ? items.map(item => historyCard(item, { deleteId: item.id })).join('') : `<div class="empty-state"><div class="empty-icon">◷</div><h3>No checks found</h3><p>Analyze a news claim and it will appear here.</p><a class="primary-btn" style="margin-top:18px" href="checknews.html">Check News</a></div>`;
      $$('.history-delete', root).forEach(btn => btn.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation(); if (!confirm('Delete this history item?')) return;
        try { await api(`/api/history/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' }); data = data.filter(x => x.id !== btn.dataset.id); render($('.filter-chip.active')?.dataset.filter || 'all'); toast('History item deleted.'); } catch (error) { toast(error.message, 'error'); }
      }));
    }
    $$('.filter-chip').forEach(btn => btn.addEventListener('click', () => { $$('.filter-chip').forEach(x => x.classList.toggle('active', x === btn)); render(btn.dataset.filter); }));
    $('#clearHistory')?.addEventListener('click', async () => { if (!data.length) return toast('History is already empty.'); if (!confirm('Clear all history for this profile/guest session?')) return; try { await api('/api/history', { method: 'DELETE' }); data = []; render('all'); toast('History cleared.'); } catch (error) { toast(error.message, 'error'); } });
    await load();
  }
  async function initSaved() {
    const root = $('#savedList'); let saved = [];
    async function load() { try { saved = (await api('/api/saved')).saved || []; render(); } catch (error) { root.innerHTML = `<div class="empty-state"><h3>Saved list unavailable</h3><p>${esc(error.message)}</p></div>`; } }
    function render() {
      root.innerHTML = saved.length ? saved.map(s => {
        const item = s.item, a = item.analysis || {}, type = normalizeVerdict(a.verdict), icon = type === 'real' ? '✓' : type === 'fake' ? '×' : type === 'misleading' ? '!' : '?';
        return `<article class="saved-card"><div class="status-dot ${type}">${icon}</div><div class="saved-content"><h3>${esc(a.headline || item.input)}</h3><p>${esc(a.summary || '')}</p><div class="history-meta"><span class="${type}">${verdictLabel(a.verdict)}</span><span>•</span><span>${esc(a.confidence)}%</span><span>•</span><span>Saved ${esc(fmtDate(s.savedAt))}</span></div></div><div class="saved-actions"><a class="mini-action" href="result.html?id=${encodeURIComponent(item.id)}" title="View">›</a><button class="mini-action danger unsave" data-id="${esc(s.id)}" title="Remove">×</button></div></article>`;
      }).join('') : `<div class="empty-state"><div class="empty-icon">♡</div><h3>No saved articles</h3><p>Open an analysis result and tap Save Article.</p><a class="primary-btn" style="margin-top:18px" href="history.html">Open History</a></div>`;
      $$('.unsave', root).forEach(btn => btn.addEventListener('click', async () => { try { await api(`/api/saved/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' }); saved = saved.filter(x => x.id !== btn.dataset.id); render(); toast('Removed from saved.'); } catch (error) { toast(error.message, 'error'); } }));
    }
    await load();
  }

  function modalOpen(title, html) {
    if (!$('#infoModal')) return;
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#infoModal').classList.add('show');
  }
  function modalClose() { $('#infoModal')?.classList.remove('show'); }
  async function initProfile() {
    $('#themeToggle').checked = currentTheme() === 'dark';
    $('#themeToggle')?.addEventListener('change', event => { setTheme(event.target.checked ? 'dark' : 'light'); toast(event.target.checked ? 'Dark mode enabled.' : 'Light mode enabled.'); });

    let profileData = null;
    try {
      profileData = await api('/api/profile');
      const user = profileData.user;
      $('#statChecked').textContent = profileData.stats?.checked ?? 0;
      $('#statFake').textContent = profileData.stats?.fake ?? 0;
      $('#statReal').textContent = profileData.stats?.real ?? 0;
      $$('.member-only').forEach(el => el.hidden = !user);
      $('#guestCta').hidden = Boolean(user);
      if (user) {
        $('#profileName').textContent = user.fullName;
        $('#profileTagline').textContent = user.bio || 'Verify Facts. Share Truth.';
        $('#profileEmail').textContent = user.email;
        $('#fullName').value = user.fullName;
        $('#bio').value = user.bio || '';
        $('#notificationToggle').checked = user.notifications !== false;
        loadAvatarInto($('#profileAvatarImage'), $('#profileAvatarInitial'), user.id, user.fullName);
      } else {
        $('#profileName').textContent = 'Guest User';
        $('#profileTagline').textContent = 'Verify Facts. Share Truth.';
        loadAvatarInto($('#profileAvatarImage'), $('#profileAvatarInitial'), 'guest', 'Guest');
      }
    } catch (error) { toast(error.message, 'error'); }

    $('#avatarInput')?.addEventListener('change', async event => {
      const file = event.target.files?.[0]; if (!file) return;
      if (!file.type.startsWith('image/')) return toast('Choose an image file.', 'error');
      try {
        const dataUrl = await compressAvatar(file);
        const key = avatarKey(profileData?.user?.id || 'guest');
        localStorage.setItem(key, dataUrl);
        loadAvatarInto($('#profileAvatarImage'), $('#profileAvatarInitial'), profileData?.user?.id || 'guest', profileData?.user?.fullName || 'Guest');
        toast('Profile photo updated.');
      } catch { toast('Could not process this image.', 'error'); }
    });
    $('#editProfileBtn')?.addEventListener('click', () => { const card = $('#editProfileCard'); if (!card) return; card.hidden = !card.hidden; if (!card.hidden) card.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    $('#emailRow')?.addEventListener('click', async () => { const email = $('#profileEmail')?.textContent || ''; if (email && email !== '—') { await navigator.clipboard.writeText(email).catch(() => {}); toast('Email copied.'); } });
    $('#notificationToggle')?.addEventListener('change', async event => {
      try { await api('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: event.target.checked }) }); toast(event.target.checked ? 'Notifications enabled.' : 'Notifications disabled.'); }
      catch (error) { event.target.checked = !event.target.checked; toast(error.message, 'error'); }
    });
    $('#profileForm')?.addEventListener('submit', async event => {
      event.preventDefault(); const button = $('#saveProfile'); setBusy(button, true, 'Saving…');
      try {
        const data = await api('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: $('#fullName').value.trim(), bio: $('#bio').value.trim() }) });
        $('#profileName').textContent = data.user.fullName; $('#profileTagline').textContent = data.user.bio || 'Verify Facts. Share Truth.'; toast('Profile updated.'); $('#editProfileCard').hidden = true;
      } catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); }
    });
    function openChangePassword() {
      modalOpen('Change Password', `<p class="modal-help">For security, enter your current MongoDB account password and choose a new password with at least 6 characters.</p><form id="changePasswordForm" class="form-grid"><div class="form-group"><label>Current Password</label><input class="form-control" id="currentPassword" type="password" required minlength="6" autocomplete="current-password" placeholder="Current password"></div><div class="form-group"><label>New Password</label><input class="form-control" id="newPassword" type="password" required minlength="6" autocomplete="new-password" placeholder="New password"></div><div class="form-group"><label>Confirm New Password</label><input class="form-control" id="confirmPassword" type="password" required minlength="6" autocomplete="new-password" placeholder="Confirm new password"></div><label class="check-row"><input id="showChangePasswords" type="checkbox"> Show passwords</label><button class="primary-btn" id="changePasswordSubmit" type="submit">Change Password</button></form>`);
      const form = $('#changePasswordForm');
      $('#showChangePasswords')?.addEventListener('change', event => {
        ['#currentPassword','#newPassword','#confirmPassword'].forEach(id => { const input=$(id); if (input) input.type = event.target.checked ? 'text' : 'password'; });
      });
      form?.addEventListener('submit', async event => {
        event.preventDefault();
        const currentPassword = $('#currentPassword')?.value || '';
        const newPassword = $('#newPassword')?.value || '';
        const confirmPassword = $('#confirmPassword')?.value || '';
        if (newPassword.length < 6) return toast('New password must be at least 6 characters.', 'error');
        if (newPassword !== confirmPassword) return toast('New password and confirmation do not match.', 'error');
        if (currentPassword === newPassword) return toast('Choose a different new password.', 'error');
        const button = $('#changePasswordSubmit'); setBusy(button, true, 'Updating…');
        try {
          await api('/api/change-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ currentPassword, newPassword }) });
          toast('Password changed successfully.');
          modalClose();
        } catch (error) { toast(error.message, 'error'); }
        finally { setBusy(button, false); }
      });
    }
    $('#changePasswordBtn')?.addEventListener('click', openChangePassword);
    $('#modalClose')?.addEventListener('click', modalClose); $('#modalDone')?.addEventListener('click', modalClose); $('#infoModal')?.addEventListener('click', e => { if (e.target.id === 'infoModal') modalClose(); });
    $('#logoutBtn')?.addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); location.href = 'login.html'; } catch (error) { toast(error.message, 'error'); } });

    try {
      const health = await api('/api/health');
      $('#mongoState').textContent = health.mongoConnected ? 'MongoDB: connected' : (health.mongoConfigured ? 'MongoDB: connection error' : 'MongoDB: URI needed');
      $('#firebaseState').textContent = health.firebaseConfigured ? 'Firebase reset: ready' : 'Firebase reset: API key needed';
      $('#geminiState').textContent = health.geminiConfigured ? `Gemini: ${health.model}` : 'Gemini: API key needed';
    } catch {}
  }

  function initAuth(type) {
    const form = $('#authForm');
    form?.addEventListener('submit', async event => {
      event.preventDefault(); const button = $('#authBtn'); setBusy(button, true, type === 'signup' ? 'Creating account…' : 'Signing in…');
      const payload = type === 'signup' ? { fullName: $('#fullName').value.trim(), email: $('#email').value.trim(), password: $('#password').value } : { email: $('#email').value.trim(), password: $('#password').value };
      try { const data = await api(`/api/${type}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (data.warning) sessionStorage.setItem('ng_auth_warning', data.warning); location.href = 'index.html'; }
      catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); }
    });
    $('#showPassword')?.addEventListener('change', () => { $('#password').type = $('#showPassword').checked ? 'text' : 'password'; });
  }
  function initForgot() {
    $('#forgotForm')?.addEventListener('submit', async event => {
      event.preventDefault(); const button = $('#forgotBtn'); setBusy(button, true, 'Sending…');
      try {
        const data = await api('/api/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#email').value.trim() }) });
        $('#forgotSuccess').hidden = false; $('#forgotSuccess p').textContent = data.message || 'Check your email for the reset link.'; toast('Reset email request sent.');
      } catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); }
    });
  }

  async function initResetPassword() {
    const oobCode = params.get('oobCode') || '';
    const status = $('#resetStatus');
    const form = $('#resetPasswordForm');
    if (!oobCode) { if (status) status.textContent = 'This reset link is missing the Firebase reset code.'; if (form) form.hidden = true; return; }
    try {
      const data = await api('/api/firebase-reset/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ oobCode }) });
      if (status) status.textContent = data.email ? `Reset password for ${data.email}` : 'Choose a new password.';
    } catch (error) { if (status) status.textContent = error.message; if (form) form.hidden = true; return; }
    $('#showResetPassword')?.addEventListener('change', () => { ['#newPassword','#confirmPassword'].forEach(sel => { const input=$(sel); if (input) input.type = $('#showResetPassword').checked ? 'text' : 'password'; }); });
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      const newPassword = $('#newPassword')?.value || '';
      const confirmPassword = $('#confirmPassword')?.value || '';
      if (newPassword.length < 6) return toast('Password must be at least 6 characters.', 'error');
      if (newPassword !== confirmPassword) return toast('Passwords do not match.', 'error');
      const button = $('#resetPasswordBtn'); setBusy(button, true, 'Resetting…');
      try {
        const data = await api('/api/firebase-reset/confirm', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ oobCode, newPassword }) });
        if (status) status.textContent = data.message;
        form.hidden = true; $('#resetDone').hidden = false; toast('Password reset successfully.');
      } catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); }
    });
  }

  wireBottomNav();
  if (page === 'home') initHome();
  if (page === 'analyze') initAnalyze();
  if (page === 'result') initResult();
  if (page === 'history') initHistory();
  if (page === 'saved') initSaved();
  if (page === 'profile') initProfile();
  if (page === 'login') initAuth('login');
  if (page === 'signup') initAuth('signup');
  if (page === 'forgot') initForgot();
  if (page === 'reset-password') initResetPassword();
})();
