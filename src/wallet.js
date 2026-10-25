// src/wallet.js - FWC 4.0.0 PRODUCTION
// TON wallet validation

export function validateTonAddress(addr) {
  if (!addr) return false;
  addr = addr.trim();

  // Friendly format (EQ... / UQ... / kQ... / 0Q...)
  if (/^(EQ|UQ|kQ|0Q|Ef|Uf)[A-Za-z0-9_-]{46}$/.test(addr)) return true;

  // Raw address (workchain:hex)
  if (/^-?\d+:[a-fA-F0-9]{64}$/.test(addr)) return true;

  // Base64 URL-safe 48 chars
  if (/^[A-Za-z0-9_-]{48}$/.test(addr)) return true;

  return false;
}

export async function saveWallet(db, telegram_id, wallet) {
  if (!validateTonAddress(wallet)) {
    return { ok: false, reason: 'invalid' };
  }
  await db.prepare(`UPDATE users SET wallet = ? WHERE telegram_id = ?`)
    .bind(wallet.trim(), telegram_id).run();
  return { ok: true, wallet: wallet.trim() };
}