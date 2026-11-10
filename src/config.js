// FWC CLEAN v1 - config.js
export const WORKER_URL = 'https://fwc.ahmed73.workers.dev';
export function getSecrets(env){
  const trim = (v)=> (v||'').toString().trim();
  return {
    BOT_TOKEN: trim(env?.BOT_TOKEN),
    botToken: trim(env?.BOT_TOKEN),
    ADMIN_SECRET: trim(env?.ADMIN_SECRET),
    adminSecret: trim(env?.ADMIN_SECRET),
    TONCENTER_API_KEY: trim(env?.TONCENTER_API_KEY),
    toncenterKey: trim(env?.TONCENTER_API_KEY),
  };
}
export function getFounderDefaults(){
  return { enabled:true, price:10000, max:500, burnAddress:'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJQ', claimHours:8, miningBonusPercent:20, founderFeePercent:3 };
}
