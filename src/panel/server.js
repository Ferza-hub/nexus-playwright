'use strict';

require('dotenv').config();
const http    = require('http');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');

const { requireAuth } = require('./middleware/auth');
const { attachRelay } = require('./browser-relay');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../../public')));

// All API routes require auth
app.use('/api/analytics', requireAuth, require('./routes/analytics'));
app.use('/api/proxies',   requireAuth, require('./routes/proxies'));
app.use('/api/settings',  requireAuth, require('./routes/settings'));
app.use('/api/traffic',   requireAuth, require('./routes/traffic'));
app.use('/api/accounts',  requireAuth, require('./routes/accounts'));
app.use('/api/logs',      requireAuth, require('./routes/logs'));
app.use('/api/relay',      requireAuth, require('./routes/relay'));
app.use('/api/preview',    requireAuth, require('./routes/preview'));
app.use('/api/web-traffic', requireAuth, require('./routes/web-traffic'));
app.use('/api/goals',      requireAuth, require('./routes/goals'));
app.use('/api/benchmark',  requireAuth, require('./routes/benchmark'));

// SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../../public/index.html')));

function startPanel() {
  const server = http.createServer(app);
  attachRelay(server); // WebSocket relay on /ws/relay
  server.listen(PORT, () => {
    console.log(`[Panel] Running on http://localhost:${PORT}`);
  });
}

module.exports = { startPanel };
