// src/config.js - FWC 4.0.0 PRODUCTION
// Public config - safe for GitHub (all on blockchain)

export const CONFIG = {
  jetton: "EQC0bkbZmjWW82AIwb0oAQHvdj4JPbwrmYpmjnB2FJSAUh76",
  treasury: "UQD35kO80vaNpOcUk7fNuRvLds4TgzE6MDAvpHcFZnP3jOtw",
  pool: "EQA_FhrVf_wjOAvg-Ubzqive8-9riRc0KX_NdEmh-uyynZRM",
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
  referral_percent: 5,
  root_admin_id: 921627899,
  default_language: 'en',
  workerUrl: 'https://fwc-bot.workers.dev', // 👈 مهم جداً للتحقق من ton_proof
};

// Secrets - from Cloudflare Dashboard only
export function getSecrets(env) {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN missing in Cloudflare Secrets - Add in Dashboard > Variables and Secrets");
  }
  return {
    botToken: env.BOT_TOKEN,
    adminSecret: env.ADMIN_SECRET,
    mnemonic: env.TON_MNEMONIC_TREASURY,
    adsgramId: env.ADSGRAM_BLOCK_ID,
    toncenterApiKey: env.TONCENTER_API_KEY,
    tonApiKey: env.TONAPI_KEY,
  };
}