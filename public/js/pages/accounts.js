// Accounts — connect via browser relay (no extension needed) or cookie paste.
// After connecting: session captured → auto-warmup → ready for actions.

const AccountsPage = (() => {

  const PLATFORMS = {
    youtube:   { emoji: '▶️',  label: 'YouTube'   },
    instagram: { emoji: '📸', label: 'Instagram'  },
    tiktok:    { emoji: '🎵', label: 'TikTok'     },
    facebook:  { emoji: '👥', label: 'Facebook'   },
    twitter:   { emoji: '🐦', label: 'Twitter/X'  },
    threads:   { emoji: '🧵', label: 'Threads'    },
  };

  function warmBadge(s) {
    const MAP = {
      cold:    { icon: '🥶', color: '#64748b', label: 'cold'    },
      warming: { icon: '🔥', color: '#f59e0b', label: 'warming' },
      warm:    { icon: '✅', color: '#22c55e', label: 'warm'    },
    };
    const w = MAP[s] || MAP.cold;
    return `<span style="color:${w.color};font-size:.8rem">${w.icon} ${w.label}</span>`;
  }

  function statusBadge(s) {
    const cls = { active: 'success', inactive: 'warning', expired: 'danger' }[s] || 'secondary';
    return `<span class="badge badge-${cls}">${s}</span>`;
  }

  function _ago(d) {
    const s = Math.round((Date.now() - new Date(d)) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function renderTable(accounts) {
    if (!accounts.length) return `
      <div class="empty-state">
        <div style="font-size:2.5rem;margin-bottom:.75rem">👤</div>
        <p style="font-size:.95rem;font-weight:600;margin:0 0 .25rem">No accounts yet</p>
        <p class="text-muted text-sm">Connect an account — workers warm up and train on it automatically.</p>
      </div>`;

    const byPlatform = {};
    for (const a of accounts) {
      if (!byPlatform[a.platform]) byPlatform[a.platform] = [];
      byPlatform[a.platform].push(a);
    }

    return Object.entries(byPlatform).map(([plat, rows]) => {
      const info = PLATFORMS[plat] || { emoji: '🌐', label: plat };
      return `
        <div style="margin-bottom:1.5rem">
          <h3 style="font-size:.85rem;color:var(--text-muted);margin:0 0 .5rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em">
            ${info.emoji} ${info.label} <span style="font-weight:400">(${rows.length})</span>
          </h3>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>#</th><th>Label</th><th>Session</th><th>Warmup</th>
                <th>Uses</th><th>Last warmup</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                ${rows.map(a => `
                  <tr>
                    <td class="text-muted text-sm">${a.id}</td>
                    <td><strong>${a.label || '—'}</strong></td>
                    <td>${a.storage_state_path
                      ? '<span style="color:var(--success);font-size:.82rem">✓ ready</span>'
                      : '<span class="text-muted text-sm">⚠ missing</span>'}</td>
                    <td>${warmBadge(a.warmup_status || 'cold')}</td>
                    <td class="text-muted text-sm">${a.use_count ?? 0}</td>
                    <td class="text-muted text-sm">${a.last_warmup_at ? _ago(a.last_warmup_at) : '—'}</td>
                    <td>${statusBadge(a.status)}</td>
                    <td>
                      <div class="flex gap-1">
                        <button class="btn btn-ghost btn-sm"
                          title="Re-warm session"
                          onclick="AccountsPage.rewarm(${a.id})">🔥</button>
                        ${a.status !== 'active'
                          ? `<button class="btn btn-ghost btn-sm" onclick="AccountsPage.setStatus(${a.id},'active')">↺</button>`
                          : `<button class="btn btn-ghost btn-sm" onclick="AccountsPage.setStatus(${a.id},'inactive')">Pause</button>`}
                        <button class="btn btn-danger btn-sm" onclick="AccountsPage.remove(${a.id})">✕</button>
                      </div>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }).join('');
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  let _reloadTimer = null;

  async function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Accounts</h1>
        <div class="flex gap-1">
          <button class="btn btn-ghost" onclick="AccountsPage.importCookies()">Paste Cookies</button>
          <button class="btn btn-primary" onclick="AccountsPage.connectViaBrowser()">+ Connect Account</button>
        </div>
      </div>

      <div class="card" style="padding:.9rem 1rem;margin-bottom:1.25rem;border-left:3px solid var(--primary)">
        <div class="flex gap-1" style="align-items:flex-start;gap:.75rem">
          <span style="font-size:1.3rem">🖥️</span>
          <div class="text-sm text-muted" style="line-height:1.7">
            <strong>Connect Account</strong> opens a browser window on the server.
            Log into any platform normally (including 2FA) — then click <strong>Capture Session</strong>.
            The session is saved and your worker warms up automatically. No extension needed.
          </div>
        </div>
      </div>

      <div id="accounts-list">Loading…</div>`;

    await reload();
  }

  function destroy() {
    if (_reloadTimer) { clearInterval(_reloadTimer); _reloadTimer = null; }
  }

  async function reload() {
    try {
      const accounts = await API.get('/api/accounts');
      document.getElementById('accounts-list').innerHTML = renderTable(accounts);

      const warming = accounts.some(a => a.warmup_status === 'warming');
      if (warming && !_reloadTimer) {
        _reloadTimer = setInterval(reload, 4000);
      } else if (!warming && _reloadTimer) {
        clearInterval(_reloadTimer); _reloadTimer = null;
      }
    } catch (err) { Toast.error(err.message); }
  }

  // ── Connect via Browser relay ────────────────────────────────────────────────

  function connectViaBrowser() {
    const platOpts = Object.entries(PLATFORMS).map(([key, p], i) => `
      <button type="button"
        class="btn ${i === 0 ? 'btn-primary' : 'btn-ghost'} btn-sm"
        data-plat="${key}"
        onclick="AccountsPage._pickPlatform('${key}', this)"
        style="justify-content:center;gap:.3rem">
        ${p.emoji} ${p.label}
      </button>`).join('');

    Modal.open('Connect Account', `
      <div class="form-group">
        <label>Choose platform</label>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.35rem;margin-top:.4rem">
          ${platOpts}
        </div>
        <input type="hidden" id="br-platform" value="youtube">
      </div>

      <div class="card" style="padding:.8rem 1rem;background:rgba(59,130,246,.07);border:1px solid rgba(59,130,246,.25);margin:.75rem 0 0">
        <div style="display:flex;gap:.6rem;align-items:flex-start">
          <span style="font-size:1.1rem">🖥️</span>
          <div class="text-sm" style="line-height:1.7;color:var(--text-muted)">
            A browser will open on the server. Log into your account normally —
            including any 2FA or captcha — then click <strong style="color:var(--text)">Launch Browser</strong> to start.
          </div>
        </div>
      </div>

      <div class="flex gap-1" style="justify-content:flex-end;margin-top:1rem">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="AccountsPage._launchRelay()">🖥️ Launch Browser</button>
      </div>
    `);

    // Pre-select first platform button style
    _pickPlatform('youtube', document.querySelector('[data-plat="youtube"]'));
  }

  function _pickPlatform(key, btn) {
    document.querySelectorAll('[data-plat]').forEach(b => {
      b.className = b.dataset.plat === key ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
      b.style.cssText = 'justify-content:center;gap:.3rem';
    });
    document.getElementById('br-platform').value = key;
  }

  async function _launchRelay() {
    const platform = document.getElementById('br-platform').value;
    try {
      const res = await API.post('/api/relay', { platform });
      Modal.close();
      BrowserRelay.open(res.sessionId, { onDone: reload });
    } catch (err) {
      Toast.error(err.message);
    }
  }

  // ── Cookie paste (fallback) ─────────────────────────────────────────────────

  function importCookies() {
    const platOpts = Object.entries(PLATFORMS).map(([key, p], i) => `
      <button type="button"
        class="btn ${i === 0 ? 'btn-primary' : 'btn-ghost'} btn-sm"
        data-imp-plat="${key}"
        onclick="AccountsPage._selPlat('${key}', this)"
        style="justify-content:center;gap:.3rem">
        ${p.emoji} ${p.label}
      </button>`).join('');

    Modal.open('Paste Cookies (Cookie Editor)', `
      <div class="form-group">
        <label>Platform</label>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.35rem;margin-top:.4rem">
          ${platOpts}
        </div>
        <input type="hidden" id="imp-platform" value="youtube">
      </div>

      <div class="form-group">
        <label>Label <span class="text-muted text-sm">(optional)</span></label>
        <input type="text" id="imp-label" placeholder="e.g. My Account">
      </div>

      <div class="form-group">
        <label>Cookies JSON <span class="text-muted text-sm">— Cookie Editor → Export as JSON</span></label>
        <textarea id="imp-cookies" rows="7"
          style="width:100%;box-sizing:border-box;font-family:monospace;font-size:.8rem"
          placeholder='[{"name":"SID","value":"...","domain":".youtube.com",...}]'></textarea>
      </div>

      <div class="flex gap-1" style="justify-content:flex-end;margin-top:1rem">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="AccountsPage._submitImport()">Import & Warm Up</button>
      </div>
    `);
  }

  function _selPlat(key, btn) {
    document.querySelectorAll('[data-imp-plat]').forEach(b => {
      b.className = b.dataset.impPlat === key ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
      b.style.cssText = 'justify-content:center;gap:.3rem';
    });
    document.getElementById('imp-platform').value = key;
  }

  async function _submitImport() {
    const platform     = document.getElementById('imp-platform').value;
    const label        = document.getElementById('imp-label').value.trim();
    const cookies_json = document.getElementById('imp-cookies').value.trim();
    if (!cookies_json) { Toast.error('Paste cookies JSON first'); return; }
    try {
      const res = await API.post('/api/accounts/import', { platform, label, cookies_json });
      Toast.success(`Imported ${res.cookies} cookies — warmup started`);
      Modal.close();
      await reload();
    } catch (err) { Toast.error(err.message); }
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function rewarm(id) {
    try {
      await API.post(`/api/accounts/${id}/warmup`);
      Toast.success('Warmup started');
      await reload();
    } catch (err) { Toast.error(err.message); }
  }

  async function setStatus(id, status) {
    try {
      await API.patch(`/api/accounts/${id}/status`, { status });
      await reload();
    } catch (err) { Toast.error(err.message); }
  }

  async function remove(id) {
    if (!confirm('Remove this account and its session?')) return;
    try {
      await API.delete(`/api/accounts/${id}`);
      Toast.success('Account removed');
      await reload();
    } catch (err) { Toast.error(err.message); }
  }

  return {
    render, destroy, reload,
    connectViaBrowser, _pickPlatform, _launchRelay,
    importCookies, _selPlat, _submitImport,
    rewarm, setStatus, remove,
  };
})();
