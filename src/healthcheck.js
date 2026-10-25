// src/healthcheck.js
export async function getSystemHealth(env) {
  const health = { timestamp: new Date().toISOString(), status: 'healthy', checks: {} };
  try {
    const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first();
    health.checks.database = { ok: true, usersCount: usersCount?.c || 0 };
  } catch (e) { health.checks.database = { ok: false, error: e.message }; health.status = 'critical'; }
  health.checks.treasury = env.TON_MNEMONIC_TREASURY ? { ok: true } : { ok: false };
  health.checks.bot = env.BOT_TOKEN ? { ok: true } : { ok: false };
  if (!env.BOT_TOKEN || !env.TON_MNEMONIC_TREASURY) health.status = 'degraded';
  return health;
}