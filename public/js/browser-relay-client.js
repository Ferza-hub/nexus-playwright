// BrowserRelay — client-side screen relay.
// Connects to /ws/relay, streams JPEG frames onto a canvas,
// and forwards mouse/keyboard events back to the server-side Playwright browser.

const BrowserRelay = (() => {
  const W = 1280; // server browser viewport width
  const H = 800;  // server browser viewport height

  let _ws         = null;
  let _sessionId  = null;
  let _overlay    = null;
  let _canvas     = null;
  let _ctx        = null;
  let _img        = new Image();
  let _prevBlobUrl = null;
  let _onDone     = null; // callback after successful capture

  // ── Overlay DOM ─────────────────────────────────────────────────────────────

  function _buildOverlay() {
    _overlay = document.createElement('div');
    _overlay.id = 'relay-overlay';
    _overlay.style.cssText = [
      'position:fixed;inset:0;z-index:9999',
      'background:rgba(0,0,0,.88)',
      'display:flex;align-items:center;justify-content:center',
    ].join(';');

    _overlay.innerHTML = `
      <div style="
        width:min(1310px,99vw);display:flex;flex-direction:column;
        background:#1e2330;border-radius:10px;overflow:hidden;
        box-shadow:0 24px 80px rgba(0,0,0,.7);
      ">
        <!-- Header bar -->
        <div style="
          display:flex;align-items:center;gap:.6rem;
          padding:.5rem .8rem;background:#141824;
          border-bottom:1px solid #2a3040;flex-wrap:nowrap;min-width:0;
        ">
          <span id="relay-dot" style="
            flex-shrink:0;width:9px;height:9px;border-radius:50%;
            background:#f59e0b;transition:background .3s;
          "></span>
          <span id="relay-status" style="
            flex-shrink:0;font-size:.78rem;color:#94a3b8;white-space:nowrap;
          ">Starting browser…</span>
          <div id="relay-url-bar" style="
            flex:1;min-width:0;padding:.2rem .55rem;font-size:.75rem;
            background:#0f1420;border:1px solid #2a3040;border-radius:5px;
            color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          ">about:blank</div>
          <input id="relay-label" type="text" placeholder="Label (optional)"
            style="
              flex-shrink:0;width:160px;padding:.28rem .55rem;font-size:.78rem;
              background:#0f1420;border:1px solid #2a3040;border-radius:5px;
              color:#e2e8f0;outline:none;
            ">
          <button id="relay-capture-btn"
            style="
              flex-shrink:0;padding:.28rem .75rem;font-size:.78rem;font-weight:600;
              background:#3b82f6;color:#fff;border:none;border-radius:5px;
              cursor:pointer;opacity:.4;pointer-events:none;white-space:nowrap;
            " disabled>
            📸 Capture Session
          </button>
          <button id="relay-close-btn"
            style="
              flex-shrink:0;padding:.28rem .6rem;font-size:.78rem;
              background:transparent;color:#94a3b8;border:1px solid #2a3040;
              border-radius:5px;cursor:pointer;
            ">✕</button>
        </div>

        <!-- Screen -->
        <div style="position:relative;background:#000;line-height:0;overflow:hidden;" id="relay-screen">
          <canvas id="relay-canvas"
            tabindex="0"
            style="display:block;width:100%;height:auto;cursor:crosshair;outline:none;"></canvas>
          <div id="relay-spinner" style="
            position:absolute;inset:0;display:flex;align-items:center;
            justify-content:center;background:rgba(0,0,0,.75);
            color:#e2e8f0;font-size:1.05rem;gap:.6rem;
          ">
            <span id="relay-spin-icon" style="display:inline-block">⟳</span>
            <span id="relay-spin-text">Starting browser…</span>
          </div>
        </div>

        <!-- Footer hint -->
        <div style="
          padding:.35rem .9rem;background:#141824;border-top:1px solid #2a3040;
          font-size:.72rem;color:#475569;display:flex;gap:1.2rem;
        ">
          <span>🖱 Click to interact</span>
          <span>⌨️ Type after clicking</span>
          <span>↕ Scroll to scroll</span>
          <span>Log in, then click <strong style="color:#e2e8f0">Capture Session</strong></span>
        </div>
      </div>
    `;

    document.body.appendChild(_overlay);
    _canvas = document.getElementById('relay-canvas');
    _ctx    = _canvas.getContext('2d');
    _canvas.width  = W;
    _canvas.height = H;

    document.getElementById('relay-capture-btn').onclick = _captureSession;
    document.getElementById('relay-close-btn').onclick   = close;

    _canvas.addEventListener('click',    _onClick);
    _canvas.addEventListener('dblclick', _onDblClick);
    _canvas.addEventListener('mousemove', _onMouseMove);
    _canvas.addEventListener('wheel',    _onWheel, { passive: false });
    _canvas.addEventListener('mousedown', (e) => { _canvas.focus(); e.preventDefault(); });
    _canvas.addEventListener('keydown',  _onKeyDown);

    // Animate spinner
    let angle = 0;
    const spinIcon = document.getElementById('relay-spin-icon');
    const _spinInterval = setInterval(() => {
      if (!_overlay) { clearInterval(_spinInterval); return; }
      angle += 15;
      if (spinIcon) spinIcon.style.transform = `rotate(${angle}deg)`;
    }, 50);
  }

  // ── Coordinate scaling ───────────────────────────────────────────────────────

  function _scale(e) {
    const r = _canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (W / r.width)),
      y: Math.round((e.clientY - r.top)  * (H / r.height)),
    };
  }

  // ── Input forwarding ─────────────────────────────────────────────────────────

  function _onClick(e)    { _send({ type: 'click',    ..._scale(e) }); }
  function _onDblClick(e) { _send({ type: 'dblclick', ..._scale(e) }); }
  function _onMouseMove(e){ _send({ type: 'mousemove',..._scale(e) }); }

  function _onWheel(e) {
    e.preventDefault();
    _send({ type: 'scroll', dy: Math.round(e.deltaY) });
  }

  const SPECIAL_KEYS = new Set([
    'Enter','Backspace','Delete','Tab','Escape',
    'Home','End','PageUp','PageDown',
    'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  ]);

  function _onKeyDown(e) {
    // Escape closes the relay overlay (doesn't forward to server)
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }

    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      _send({ type: 'keydown', key: e.key });
      return;
    }

    // Ctrl/Cmd combos (e.g. Ctrl+a, Ctrl+c)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key.length === 1) {
        _send({ type: 'keydown', key: `Control+${e.key}` });
      }
      return;
    }

    // Regular printable character
    if (e.key.length === 1) {
      e.stopPropagation();
      _send({ type: 'type', text: e.key });
    }
  }

  function _send(obj) {
    if (_ws && _ws.readyState === 1) _ws.send(JSON.stringify(obj));
  }

  // ── Frame rendering ──────────────────────────────────────────────────────────

  function _drawFrame(arrayBuffer) {
    const jpeg = arrayBuffer.slice(1); // strip 0x01 prefix byte
    if (_prevBlobUrl) URL.revokeObjectURL(_prevBlobUrl);
    const blob = new Blob([jpeg], { type: 'image/jpeg' });
    _prevBlobUrl = URL.createObjectURL(blob);
    _img.onload = () => {
      _ctx.drawImage(_img, 0, 0);
      const spinner = document.getElementById('relay-spinner');
      if (spinner) spinner.style.display = 'none';
    };
    _img.src = _prevBlobUrl;
  }

  // ── Status updates ───────────────────────────────────────────────────────────

  function _setStatus(status, extra) {
    const dot  = document.getElementById('relay-dot');
    const txt  = document.getElementById('relay-status');
    const btn  = document.getElementById('relay-capture-btn');
    if (!dot) return;

    if (status === 'ready') {
      dot.style.background = '#22c55e';
      txt.textContent = 'Browser ready — log in, then capture';
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    } else if (status === 'captured') {
      dot.style.background = '#22c55e';
      txt.textContent = 'Session captured — warming up…';
      btn.disabled = true;
      btn.style.opacity = '.4';
      btn.style.pointerEvents = 'none';
    } else if (status === 'error') {
      dot.style.background = '#ef4444';
      txt.textContent = extra?.message ? `Error: ${extra.message}` : 'Browser error';
      const sp = document.getElementById('relay-spinner');
      if (sp) { sp.style.display = 'flex'; document.getElementById('relay-spin-text').textContent = extra?.message || 'Error'; }
    } else if (status === 'closed') {
      dot.style.background = '#ef4444';
      txt.textContent = 'Session closed';
    }
  }

  // ── Capture ───────────────────────────────────────────────────────────────────

  async function _captureSession() {
    const label = document.getElementById('relay-label')?.value.trim();
    try {
      const res = await API.post(`/api/relay/${_sessionId}/capture`, { label });
      Toast.success(`Session captured — ${res.cookies} cookies, warming up…`);
      setTimeout(() => {
        close();
        if (_onDone) _onDone();
      }, 1200);
    } catch (err) {
      Toast.error(err.message);
    }
  }

  // ── Public ────────────────────────────────────────────────────────────────────

  function open(sessionId, { onDone } = {}) {
    if (_overlay) close(); // close any existing relay first
    _sessionId = sessionId;
    _onDone    = onDone || null;
    _buildOverlay();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    _ws = new WebSocket(`${proto}://${location.host}/ws/relay?s=${sessionId}`);
    _ws.binaryType = 'arraybuffer';

    _ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const view = new Uint8Array(e.data);
        if (view[0] === 0x01) _drawFrame(e.data);
        return;
      }
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status') _setStatus(msg.status, msg);
        if (msg.type === 'url')    { const el = document.getElementById('relay-url-bar'); if (el) el.textContent = msg.url; }
        if (msg.type === 'error')  { Toast.error(msg.message); _setStatus('error', msg); }
        if (msg.type === 'closed') close();
      } catch (_) {}
    };

    _ws.onclose = () => _setStatus('closed');
    _ws.onerror = () => _setStatus('error', { message: 'WebSocket connection failed' });
  }

  function close() {
    if (_ws) { _ws.close(); _ws = null; }
    if (_sessionId) {
      API.delete(`/api/relay/${_sessionId}`).catch(() => {});
      _sessionId = null;
    }
    if (_overlay) { _overlay.remove(); _overlay = null; }
    if (_prevBlobUrl) { URL.revokeObjectURL(_prevBlobUrl); _prevBlobUrl = null; }
    _canvas = null;
    _ctx    = null;
  }

  return { open, close };
})();
