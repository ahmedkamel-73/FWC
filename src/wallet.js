
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

  // Check duplicate before saving
  const dupe = await db.prepare(`SELECT telegram_id, referral_by FROM users WHERE wallet = ? AND telegram_id != ? LIMIT 1`)
    .bind(normalized, telegram_id).first();
  if (dupe) {
    // إذا نفس المحفظة مستخدمة من المُحيل نفسه، الغي الإحالة
    if (dupe.telegram_id && dupe.telegram_id !== telegram_id) {
      const currentUser = await db.prepare(`SELECT referral_by FROM users WHERE telegram_id = ?`).bind(telegram_id).first();
      if (currentUser?.referral_by === dupe.telegram_id) {
        await db.prepare(`UPDATE users SET referral_by = NULL, referred_bonus_paid = 0 WHERE telegram_id = ?`)
          .bind(telegram_id).run();
      }
    }
  }

  try {
    await db.prepare(
      `UPDATE users SET wallet = ?, wallet_verified = ?, wallet_saved_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`
    ).bind(normalized, verified ? 1 : 0, telegram_id).run();
  } catch {
    await db.prepare(`UPDATE users SET wallet = ? WHERE telegram_id = ?`)
      .bind(normalized, telegram_id).run();
  }

  return { ok: true, wallet: normalized, verified, duplicate: !!dupe };
}
