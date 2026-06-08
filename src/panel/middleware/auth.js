'use strict';

const { createClient } = require('@supabase/supabase-js');

const _supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data: { user }, error } = await _supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch (_) {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { requireAuth };
