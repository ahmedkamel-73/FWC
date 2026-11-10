// FWC CLEAN v1 - fees.js
import { getConfigValue, isFounder, getFounderConfig } from './db.js';
export async function calculateWithdrawalFee(db, amount, telegram_id){
  const founder = telegram_id ? await isFounder(db, telegram_id) : false;
  if(founder){
    const cfg = await getFounderConfig(db);
    const fee = amount * cfg.founderFeePercent/100;
    return { fee, netAmount: amount-fee, percent: cfg.founderFeePercent, isFounder:true };
  }
  const pct = parseFloat(await getConfigValue(db,'withdraw_fee_percent','5'));
  const fee = amount * pct/100;
  return { fee, netAmount: amount-fee, percent:pct, isFounder:false };
}
