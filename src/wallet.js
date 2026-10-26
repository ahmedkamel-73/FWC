
// src/wallet.js - FWC 4.0.0 PRODUCTION
import { Address } from '@ton/ton';

export function normalizeTonAddress(addr) {
  if (!addr || typeof addr !== 'string') return null;
  const trimmed = addr.trim();
  if (!trimmed) return null;
  try {
    const parsed = Address.parse(trimmed);
    return parsed.toString({ bounceable: false, urlSafe: true });
  } catch {
    return null;
  }
}

export function validateTonAddress(addr) {
  return normalizeTonAddress(addr) !== null;
}

export async function saveWallet(db, telegram_id, wallet, opts = {}) {
  const normalized = normalizeTonAddress(wallet);
  if (!normalized) return { ok: false, reason: 'invalid' };

  const { verified = false } = opts;

  try {
    await db.prepare(
      `UPDATE users SET wallet = ?, wallet_verified = ?, wallet_saved_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`
    ).bind(normalized, verified ? 1 : 0, telegram_id).run();
  } catch {
    await db.prepare(`UPDATE users SET wallet = ? WHERE telegram_id = ?`)
      .bind(normalized, telegram_id).run();
  }

  return { ok: true, wallet: normalized, verified };
}
