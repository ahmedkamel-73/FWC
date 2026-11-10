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
  workerUrl: 'https://fwc.ahmed73.workers.dev', // SINGLE SOURCE OF TRUTH - Mini App lives here only.
};

// Secrets - from Cloudflare Dashboard only
export function getSecrets(env) {
  // متوقعش الموقع لو التوكن مش موجود - التوكن للبوت بس
  if (!env.BOT_TOKEN) {
    console.log("BOT_TOKEN missing - serving pages without bot");
    return {
      BOT_TOKEN: null,
      botToken: null,
      adminSecret: env.ADMIN_SECRET,
      mnemonic: env.TON_MNEMONIC_TREASURY,
      adsgramId: env.ADSGRAM_BLOCK_ID,
      toncenterApiKey: env.TONCENTER_API_KEY,
      tonApiKey: env.TONAPI_KEY,
    };
  }
  return {
    BOT_TOKEN: env.BOT_TOKEN,
    botToken: env.BOT_TOKEN,
    adminSecret: env.ADMIN_SECRET,
    mnemonic: env.TON_MNEMONIC_TREASURY,
    adsgramId: env.ADSGRAM_BLOCK_ID,
    toncenterApiKey: env.TONCENTER_API_KEY,
    tonApiKey: env.TONAPI_KEY,
  };
}
