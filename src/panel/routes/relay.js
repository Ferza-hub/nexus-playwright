'use strict';

const { Router } = require('express');
const { startRelaySession, getRelaySession } = require('../browser-relay');

const router = Router();
const VALID_PLATFORMS = ['youtube', 'instagram', 'tiktok', 'facebook', 'twitter', 'threads'];

// POST /api/relay — start a browser relay session
router.post('/', async (req, res) => {
  const { platform } = req.body;
  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` });
  }
  try {
    const id = await startRelaySession(platform);
    res.status(201).json({ sessionId: id });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// GET /api/relay/:id — session status
router.get('/:id', (req, res) => {
  const s = getRelaySession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ id: s.id, platform: s.platform, status: s.status, accountId: s.accountId });
});

// POST /api/relay/:id/capture — capture storageState → save account → warmup
router.post('/:id/capture', async (req, res) => {
  const s = getRelaySession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found or expired' });
  try {
    const result = await s.captureSession(req.body?.label);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/relay/:id — close the relay session
router.delete('/:id', async (req, res) => {
  const s = getRelaySession(req.params.id);
  if (!s) return res.status(404).json({ ok: true }); // already gone
  await s.destroy();
  res.json({ ok: true });
});

module.exports = router;
