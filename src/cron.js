// src/cron.js - FWC 4.0.0 PRODUCTION
// Scheduled tasks (Cloudflare Cron)

import { confirmBatch } from './payout.js';

export async function handleCron(event, env) {
  const cron = event.cron;
  console.log('Cron triggered:', cron);

  // Every 6 hours: auto-confirm processing batches older than 1 hour
  if (cron === '0 */6 * * *') {
    await confirmStaleBatches(env);
  }

  // Daily: send summary to admin
  if (cron === '0 9 * * *') {
    await sendDailySummary(env);
  }

  // Every 15 min: check for stuck withdrawals
  if (cron === '*/15 * * * *') {
    await checkStuckWithdrawals(env);
  }
}

async function confirmStaleBatches(env) {
  try {
    const stale = await env.DB.prepare(`
      SELECT * FROM payout_batches 
      WHERE status = 'processing' 
        AND created_at < unixepoch() - 3600
    `).all();

    for (const batch of stale.results || []) {
      await confirmBatch(env.DB, batch.tx_hash);
      console.log('Confirmed batch:', batch.tx_hash);
    }
  } catch (e) {
    console.error('Cron confirmStaleBatches error:', e);
  }
}

async function sendDailySummary(env) {
  try {
    const { BOT_TOKEN } = env;
    if (!BOT_TOKEN) return;

    const users = await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first();
    const pending = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'`).first();
    const mined = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM mining_log WHERE created_at > unixepoch() - 86400`).first();

    const text = `📊 FWC Daily Summary\n\n👥 Users: ${users.c}\n💰 Mined 24h: ${mined.s.toFixed(2)} FWC\n⏳ Pending withdrawals: ${pending.c}`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: 921627899,
        text,
      }),
    });
  } catch (e) {
    console.error('Cron sendDailySummary error:', e);
  }
}

async function checkStuckWithdrawals(env) {
  try {
    const stuck = await env.DB.prepare(`
      SELECT * FROM withdrawals 
      WHERE status = 'processing' 
        AND updated_at < unixepoch() - 7200
    `).all();
    console.log('Stuck withdrawals:', stuck.results?.length || 0);
  } catch (e) {
    console.error('Cron checkStuckWithdrawals error:', e);
  }
}