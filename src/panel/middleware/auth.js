'use strict';

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;

function _getClient() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');
    }
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return _supabase;
}

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data: { user }, error } = await _getClient().auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch (_) {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { requireAuth };
