// Accounts page — real browser session import via Cookie Editor

const AccountsPage = (() => {

  const PLATFORM_INFO = {
    youtube:   { emoji: '▶️',  label: 'YouTube',   domain: 'youtube.com',   cookieUrl: 'https://www.youtube.com' },
    instagram: { emoji: '📸', label: 'Instagram',  domain: 'instagram.com', cookieUrl: 'https://www.instagram.com' },
    tiktok:    { emoji: '🎵', label: 'TikTok',     domain: 'tiktok.com',    cookieUrl: 'https://www.tiktok.com' },
    facebook:  { emoji: '👥', label: 'Facebook',   domain: 'facebook.com',  cookieUrl: 'https://www.facebook.com' },
    twitter:   { emoji: '🐦', label: 'Twitter/X',  domain: 'x.com',         cookieUrl: 'https://x.com' },
  };

  function statusBadge(s) {
    const cls = { active: 'success', inactive: 'warning', expired: 'danger' }[s] || 'secondary';
    return `<span class="badge badge-${cls}">${s}</span>`;
  }

  function renderTable(accounts) {
    if (!accounts.length) return `
      <div class="empty-state">
        <div class="empty-icon">🍪</div>
        <p style="font-size:.95rem;font-weight:600;margin:.5rem 0 .25rem">No accounts yet</p>
        <p class="text-muted text-sm">Import a session from your browser using the Cookie Editor extension.</p>
      </div>`;

    const byPlatform = {};
    for (const a of accounts) {
      if (!byPlatform[a.platform]) byPlatform[a.platform] = [];
      byPlatform[a.platform].push(a);
    }

    return Object.entries(byPlatform).map(([plat, rows]) => {
      const info = PLATFORM_INFO[plat] || { emoji: '🌐', label: plat };
      return `
        <div style="margin-bottom:1.5rem">
          <h3 style="font-size:.9rem;color:var(--text-muted);margin:0 0 .5rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">
            ${info.emoji} ${info.label} <span style="font-weight:400">(${rows.length})</span>
          </h3>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>#</th><th>Label</th><th>Session</th><th>Uses</th><th>Last used</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                ${rows.map(a => `
                  <tr>
                    <td class="text-muted text-sm">${a.id}</td>
                    <td><strong>${a.label || '—'}</strong></td>
                    <td>${a.storage_state_path
                      ? '<span style="color:var(--success)">✓ loaded</span>'
                      : '<span class="text-muted">⚠ missing</span>'}</td>
                    <td class="text-muted text-sm">${a.use_count ?? 0}</td>
                    <td class="text-muted text-sm">${a.last_used_at ? _ago(a.last_used_at) : '—'}</td>
                    <td>${statusBadge(a.status)}</td>
                    <td>
                      <div class="flex gap-1">
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

  function _ago(d) {
    const s = Math.round((Date.now() - new Date(d)) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  async function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Accounts</h1>
        <button class="btn btn-primary" onclick="AccountsPage.importCookies()">+ Import Session</button>
      </div>

      <div class="card" style="padding:1rem;margin-bottom:1.25rem;background:var(--surface-raised);border:1px solid var(--border)">
        <div style="display:flex;gap:.75rem;align-items:flex-start">
          <span style="font-size:1.4rem;line-height:1">🍪</span>
          <div>
            <strong style="font-size:.875rem">How to import a session</strong>
            <ol class="text-muted text-sm" style="margin:.4rem 0 0;padding-left:1.2rem;line-height:1.8">
              <li>Install <strong>Cookie Editor</strong> extension in Chrome/Firefox</li>
              <li>Log in to the platform in your browser (YouTube, Instagram, etc.)</li>
              <li>Click the Cookie Editor icon → <strong>Export → Export as JSON</strong></li>
              <li>Paste the JSON below and click Import</li>
            </ol>
          </div>
        </div>
      </div>

      <div id="accounts-list">Loading…</div>`;
    await reload();
  }

  async function reload() {
    try {
      const accounts = await API.get('/api/accounts');
      document.getElementById('accounts-list').innerHTML = renderTable(accounts);
    } catch (err) { Toast.error(err.message); }
  }

  function importCookies() {
    Modal.open('Import Browser Session', `
      <div class="form-group">
        <label>Platform</label>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.35rem">
          ${Object.entries(PLATFORM_INFO).map(([key, p], i) => `
            <button type="button"
              class="btn ${i === 0 ? 'btn-primary' : 'btn-ghost'} btn-sm"
              data-imp-plat="${key}"
              onclick="AccountsPage._selPlat('${key}', this)"
              style="justify-content:center;gap:.3rem">
              ${p.emoji} ${p.label}
            </button>`).join('')}
        </div>
        <input type="hidden" id="imp-platform" value="${Object.keys(PLATFORM_INFO)[0]}">
      </div>

      <div class="form-group">
        <label>Label <span class="text-muted text-sm">(optional)</span></label>
        <input type="text" id="imp-label" placeholder="e.g. My YouTube Account 1">
      </div>

      <div class="form-group">
        <label>Cookies JSON <span class="text-muted" style="font-size:.75rem">from Cookie Editor → Export as JSON</span></label>
        <textarea id="imp-cookies" rows="8" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:.8rem"
          placeholder='[{"name":"SID","value":"...","domain":".youtube.com",...}, ...]'></textarea>
      </div>

      <div class="flex gap-1" style="justify-content:flex-end;margin-top:1rem">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="AccountsPage._submitImport()">Import Session</button>
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
    const platform    = document.getElementById('imp-platform').value;
    const label       = document.getElementById('imp-label').value.trim();
    const cookies_json = document.getElementById('imp-cookies').value.trim();
    if (!cookies_json) { Toast.error('Paste your cookies JSON first'); return; }
    try {
      const res = await API.post('/api/accounts/import', { platform, label, cookies_json });
      Toast.success(`Imported ${res.cookies} cookies for "${res.label}"`);
      Modal.close();
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

  return { render, importCookies, _selPlat, _submitImport, setStatus, remove };
})();
