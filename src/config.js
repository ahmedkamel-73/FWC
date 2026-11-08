// src/config.js - FWC 4.0.0 PRODUCTION
// Public config - safe for GitHub (all on blockchain)

export const CONFIG = {
  jetton: "EQC0bkbZmjWW82AIwb0oAQHvdj4JPbwrmYpmjnB2FJSAUh76",
  treasury: "UQDoMZ-PRZGOqa1uyTZd7znXHR93zceemATkPOdUEAQyAjw1",
  pool: "EQCUaVJUrUHzUa6IWxrrreNCgqLUDrDt11ky-0DpZHDB8G12",
  channels: {
    main: "@fwc_coin",
    group: "@fwc_coin1",
    payouts: "@fwc_payouts",
    youtube: "https://youtube.com/@fwc_coin",
    x: "https://x.com/fwc_coin",
  },
  mining_amount: 6,
  mining_interval: 4 * 3600 * 1000, // 4 hours
  withdraw_min: 1000,
  withdraw_delay_hours: 24,
  withdraw_fee_percent: 5, // 5% fixed
  withdraw_hold_amount: 1000, // Hold requirement
  // Founder Badge (burn to support coin) - defaults, overridable from Admin / config_overrides
  founder_enabled: 0,
  founder_price: 10000,
  founder_limit: 500,
  founder_burn_address: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
  founder_interval_hours: 8, // Founder mines every 8h instead of 4h
  founder_bonus_percent: 20, // Extra % on top of x2 (8h => base * 2 * 1.20 = x2.4)
  founder_fee_percent: 3, // Founder withdrawal fee fixed 3%
  referral_percent: 5,
  root_admin_id: 921627899,
  default_language: 'en',
  workerUrl: 'https://fwc-bot.workers.dev',
};

// Secrets - from Cloudflare Dashboard only
// FIX: getSecrets used to return { botToken } but index.js destructured { BOT_TOKEN }.
// So botToken was ALWAYS undefined even when env.BOT_TOKEN was set correctly.
// Now it returns BOTH names, trimmed, so any file reading it works.
export function getSecrets(env) {
  const raw = (env?.BOT_TOKEN || '').toString().trim();
  if (!raw) {
    console.log("BOT_TOKEN missing - serving pages without bot");
  }
  const token = raw || null;
  return {
    // Both spellings - prevents future destructuring mismatch
    BOT_TOKEN: token,
    botToken: token,
    // Other secrets - also return both spellings for safety
    ADMIN_SECRET: env?.ADMIN_SECRET || null,
    adminSecret: env?.ADMIN_SECRET || null,
    mnemonic: env?.TON_MNEMONIC_TREASURY || null,
    TON_MNEMONIC_TREASURY: env?.TON_MNEMONIC_TREASURY || null,
    adsgramId: env?.ADSGRAM_BLOCK_ID || null,
    ADSGRAM_BLOCK_ID: env?.ADSGRAM_BLOCK_ID || null,
    toncenterApiKey: (env?.TONCENTER_API_KEY || '').toString().trim() || null,
    TONCENTER_API_KEY: (env?.TONCENTER_API_KEY || '').toString().trim() || null,
    tonApiKey: (env?.TONAPI_KEY || '').toString().trim() || null,
    TONAPI_KEY: (env?.TONAPI_KEY || '').toString().trim() || null,
  };
}
