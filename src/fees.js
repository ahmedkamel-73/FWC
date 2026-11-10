// src/fees.js - FWC 4.0.0 PRODUCTION
// Fixed withdrawal fee (configurable via DB)

import { CONFIG } from './config.js';

/**
 * Get current fee config
 */
export async function getFeeConfig(db) {
  const row = await db.prepare(`SELECT value FROM config_overrides WHERE key = 'withdraw_fee_percent'`).first();
  const percent = row?.value ? parseFloat(row.value) : CONFIG.withdraw_fee_percent;
  return {
    enabled: percent > 0,
    percent,
  };
}

/**
 * Calculate withdrawal fee
 * @returns { fee, netAmount, total, percent }
 */
export async function calculateWithdrawalFee(db, amount, telegram_id = null) {
  // Founder: fixed 3% (configurable via founder_fee_percent), regardless of normal fee
  if (telegram_id) {
    try {
      const fRow = await db.prepare(`SELECT * FROM founder_owners WHERE telegram_id = ?`).bind(telegram_id).first();
      if (fRow) {
        const feeRow = await db.prepare(`SELECT value FROM config_overrides WHERE key = 'founder_fee_percent'`).first();
        const founderPercent = feeRow?.value ? parseFloat(feeRow.value) : 3;
        let fee = amount * (founderPercent / 100);
        fee = Math.round(fee * 100) / 100;
        const netAmount = Math.round((amount - fee) * 100) / 100;
        return { fee, netAmount, total: amount, percent: founderPercent, enabled: true, isFounder: true };
      }
    } catch {}
  }
  const config = await getFeeConfig(db);

  if (!config.enabled || amount <= 0) {
    return {
      fee: 0,
      netAmount: amount,
      total: amount,
      percent: 0,
      enabled: false,
    };
  }

  let fee = amount * (config.percent / 100);
  fee = Math.round(fee * 100) / 100;
  const netAmount = Math.round((amount - fee) * 100) / 100;

  return {
    fee,
    netAmount,
    total: amount, // Total deducted = amount requested (fee taken from within)
    percent: config.percent,
    enabled: true,
  };
}

/**
 * Update fee percent (admin only)
 */
export async function updateFeePercent(db, percent) {
  const val = Math.max(0, Math.min(50, parseFloat(percent) || 0));
  await db.prepare(`INSERT OR REPLACE INTO config_overrides(key, value) VALUES ('withdraw_fee_percent', ?)`)
    .bind(String(val)).run();
  return { ok: true, percent: val };
}