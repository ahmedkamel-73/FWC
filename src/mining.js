// FWC CLEAN v1 - mining.js
import { getConfigValue, isFounder, getFounderConfig } from './db.js';
export async function getMiningSettings(db, telegram_id){
  const base = parseFloat(await getConfigValue(db,'mining_amount','6'));
  const interval = parseInt(await getConfigValue(db,'mining_interval_ms','14400000'));
  const founder = telegram_id ? await isFounder(db, telegram_id) : false;
  if(!founder) return { base, intervalMs: interval, amount: base, isFounder:false, claimHours: interval/3600000 };
  const cfg = await getFounderConfig(db);
  const founderInterval = cfg.claimHours*3600000;
  const amount = base * (cfg.claimHours/4) * (1 + cfg.miningBonusPercent/100);
  return { base, intervalMs: founderInterval, amount, isFounder:true, claimHours: cfg.claimHours };
}
export async function canMine(db, telegram_id){
  const s = await getMiningSettings(db, telegram_id);
  const row = await db.prepare(`SELECT MAX(created_at) m FROM mining_log WHERE telegram_id=?`).bind(telegram_id).first();
  const last = row?.m || 0;
  const now = Math.floor(Date.now()/1000);
  const next = last + Math.floor(s.intervalMs/1000);
  if(now >= next) return { can:true, nextAmount: s.amount, isFounder: s.isFounder };
  return { can:false, waitSec: next-now, nextAmount: s.amount, isFounder: s.isFounder };
}
export async function doMine(db, telegram_id){
  const c = await canMine(db, telegram_id);
  if(!c.can) return { ok:false, reason:'cooldown', waitSec:c.waitSec };
  const now = Math.floor(Date.now()/1000);
  await db.prepare(`INSERT INTO mining_log(telegram_id,amount,created_at) VALUES(?,?,?)`).bind(telegram_id,c.nextAmount,now).run();
  await db.prepare(`UPDATE users SET balance=ROUND(balance+?,8) WHERE telegram_id=?`).bind(c.nextAmount,telegram_id).run();
  return { ok:true, amount:c.nextAmount, isFounder:c.isFounder };
}
