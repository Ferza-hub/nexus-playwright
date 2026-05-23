const cron = require('node-cron');
const { db } = require('./db');
const { runCampaign } = require('./engine');

const active = new Set();

async function processPending() {
  const pending = db.prepare(
    "SELECT * FROM campaigns WHERE status = 'running' LIMIT 3"
  ).all();

  for (const campaign of pending) {
    if (active.has(campaign.id)) continue;
    active.add(campaign.id);
    runCampaign(campaign.id).finally(() => active.delete(campaign.id));
  }
}

function startScheduler() {
  cron.schedule('*/30 * * * * *', processPending);
  console.log('✅ Scheduler started');
}

module.exports = { startScheduler };
