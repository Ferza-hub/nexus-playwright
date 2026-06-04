'use strict';

const cron           = require('node-cron');
const { getDb }      = require('../database/db');
const { runCampaign } = require('./engine');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('WebTrafficScheduler');

const active = new Set();

async function processPending() {
  const db = getDb();
  const pending = db.prepare(
    "SELECT * FROM web_campaigns WHERE status = 'running' LIMIT 3"
  ).all();

  for (const campaign of pending) {
    if (active.has(campaign.id)) continue;
    active.add(campaign.id);
    runCampaign(campaign.id).finally(() => active.delete(campaign.id));
  }
}

function startWebTrafficScheduler() {
  cron.schedule('*/30 * * * * *', processPending);
  log.info('Web traffic scheduler started');
}

module.exports = { startWebTrafficScheduler };
