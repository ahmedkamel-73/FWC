// src/mining.js - FWC 4.0.0 PRODUCTION - FIXED ATOMIC
// Mining engine with halving + anti-cheat + referral bonus

import { CONFIG } from './config.js';
import { getEconomyConfig } from './db.js';

export async function getTotalMined(db) {
  const row = await db.prepare(`SELECT SUM(amount) as total FROM mining_log`).first();
  return row?.total || 0;
}

export async function getCurrentMiningAmount(db) {
  const eco = await getEconomyConfig(db, 'mining_amount');
  if (eco !== null) return eco;
  const total = await getTotalMined(db);
  
  // السبلاي المتاح للتعدين 50 مليون (مع حجز 10 مليون للفريق)
  if (total < 12500000) return 6;
  if (total < 25000000) return 3;
  if (total < 37500000) return 1.5;
  return 0.75;
}

export async function canMine(db, telegram_id) {
  const user = await db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(telegram_id).first();
  if (!user) return { ok: false, reason: 'no_user' };
  if (!user.wallet) return { ok: false, reason: 'no_wallet' };
  if (user.is_banned) return { ok: false, reason: 'banned' };

  if (user.last_mine) {
    const interval = await getEconomyConfig(db, 'mining_interval_ms') || CONFIG.mining_interval;
    const elapsed = Date.now() - user.last_mine;
    if (elapsed < interval) {
      const remaining = interval - elapsed;
      return {
        ok: false,
        reason: 'cooldown',
        remaining,
        hours: Math.floor(remaining / 3600000),
        mins: Math.floor((remaining % 3600000) / 60000),
      };
    }
  }
  return { ok: true };
}

export async function doMine(db, telegram_id) {
  const amount = await getCurrentMiningAmount(db);
  const now = Date.now();
  const user = await db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(telegram_id).first();
  if (!user) return { amount: 0, newBalance: 0, referralBonus: 0 };

  // Atomic update - prevent double mine race condition
  const interval = await getEconomyConfig(db, 'mining_interval_ms') || CONFIG.mining_interval;
  const minLastMine = now - interval;
  
  const updateResult = await db.prepare(`UPDATE users SET 
    balance = balance + ?, 
    last_mine = ?, 
    first_mine_at = COALESCE(first_mine_at, ?),
    created_at = COALESCE(created_at, ?)
    WHERE telegram_id = ? AND (last_mine IS NULL OR last_mine <= ?)`)
    .bind(amount, now, now, now, telegram_id, minLastMine).run();

  // If no rows updated, it was a race condition - someone already mined
  if (updateResult.meta.changes === 0) {
    const currentUser = await db.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(telegram_id).first();
    return {
      amount: 0,
      newBalance: currentUser?.balance || 0,
      referralBonus: 0,
      error: 'already_mined',
    };
  }

  await db.prepare(`INSERT INTO mining_log(telegram_id, amount, created_at) VALUES (?, ?, ?)`)
    .bind(telegram_id, amount, now).run();

  let referralBonus = 0;
  if (user.referral_by) {
    const refPercent = await getEconomyConfig(db, 'referral_percent') || CONFIG.referral_percent;
    referralBonus = amount * (refPercent / 100);
    await db.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`)
      .bind(referralBonus, user.referral_by).run();
    await db.prepare(`INSERT INTO referrals_log(from_id, to_id, amount, created_at) VALUES (?, ?, ?, ?)`)
      .bind(user.referral_by, telegram_id, referralBonus, now).run();
  }

  const newUser = await db.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(telegram_id).first();

  return {
    amount,
    newBalance: newUser?.balance || 0,
    referralBonus,
  };
}

async function getJettonBalanceFromChain(env, walletAddress) {
  if (!walletAddress) return 0;
  const apiKey = env.TONCENTER_API_KEY || '';
  if (!apiKey) return 0;
  try {
    const res = await fetch(`https://toncenter.com/api/v3/jetton/wallets?owner_address=${walletAddress}&jetton_address=${CONFIG.jetton}&limit=1`, {
      headers: { 'X-API-Key': apiKey }
    });
    const data = await res.json();
    if (data.jetton_wallets && data.jetton_wallets.length > 0) {
      return parseFloat(data.jetton_wallets[0].balance) / 1e9;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

export async function canWithdraw(db, env, telegram_id) {
  const user = await db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(telegram_id).first();
  if (!user) return { ok: false, reason: 'no_user' };
  if (!user.wallet) return { ok: false, reason: 'no_wallet' };
  if (user.is_banned) return { ok: false, reason: 'banned' };

  const withdrawMin = await getEconomyConfig(db, 'withdraw_min') || CONFIG.withdraw_min;
  if (user.balance < withdrawMin) {
    return { ok: false, reason: 'min_balance', need: withdrawMin, current: user.balance };
  }

  if (!user.first_mine_at) return { ok: false, reason: 'no_mine' };

  const delayHours = await getEconomyConfig(db, 'withdraw_delay_hours') || CONFIG.withdraw_delay_hours;
  const hoursPassed = (Date.now() - user.first_mine_at) / 3600000;
  if (hoursPassed < delayHours) {
    return { ok: false, reason: '24h', remaining: delayHours - hoursPassed };
  }

  // شرط الـ Hold - بداية من السحب الثاني فقط
  const holdAmount = await getEconomyConfig(db, 'withdraw_hold_amount') || 0;
  if (holdAmount > 0) {
    const wdCount = await db.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE telegram_id = ? AND status != 'rejected'`).bind(telegram_id).first();
    const isFirstWithdraw = (wdCount?.c || 0) === 0;
    if (!isFirstWithdraw) {
      const onChainBalance = await getJettonBalanceFromChain(env, user.wallet);
      if (onChainBalance < holdAmount) {
        return { ok: false, reason: 'hold_required', need: holdAmount, current: onChainBalance };
      }
    }
  }

  return { ok: true };
}
