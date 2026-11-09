// FWC CLEAN v1 - bot/commands.js
import { createOrUpdateUser, getUser } from '../db.js';
import { canMine } from '../mining.js';
import { sendMessage, miniAppKeyboard } from './telegram.js';
import { getSecrets } from '../config.js';

const APP_URL='https://fwc.ahmed73.workers.dev/';

export async function handleBotUpdate(env, update){
  if(!update) return {ok:true};
  const msg=update.message || update.callback_query?.message;
  const from=update.message?.from || update.callback_query?.from;
  if(!msg || !from) return {ok:true};
  const chatId=msg.chat.id;
  const text=(update.message?.text||'').trim();
  // Register user on any interaction
  try{ await createOrUpdateUser(env.DB,{telegram_id:from.id,username:from.username,first_name:from.first_name}); }catch{}
  if(update.callback_query){
    await sendMessage(env, chatId, '⚡ Open the app to continue:', { replyMarkup: miniAppKeyboard(APP_URL) });
    return {ok:true};
  }
  if(text==='/start'){
    const startParam=text.split(' ')[1] || update.message?.text?.split(' ')[1];
    // Referral: /start FWCxxxx
    if(startParam && startParam.startsWith('FWC')){
      try{
        const ref=await env.DB.prepare(`SELECT telegram_id FROM users WHERE referral_code=?`).bind(startParam).first();
        if(ref && ref.telegram_id!==from.id){
          await env.DB.prepare(`UPDATE users SET referral_by=? WHERE telegram_id=? AND referral_by IS NULL`).bind(ref.telegram_id, from.id).run();
        }
      }catch{}
    }
    const welcome=`👋 <b>Welcome to FWC Power Cells!</b>\n\n⚡ Mine FWC every 4 hours\n💰 Withdraw to TON\n🎁 Complete tasks & earn\n\nTap below to open the app 👇`;
    await sendMessage(env, chatId, welcome, { replyMarkup: miniAppKeyboard(APP_URL) });
    return {ok:true};
  }
  if(text==='/help'){
    await sendMessage(env, chatId, `📖 <b>FWC Help</b>\n\n/start - Open app\n/balance - Check balance\n/mine - Check mining status\n/help - This message\n\nOpen app: ${APP_URL}`);
    return {ok:true};
  }
  if(text==='/balance'){
    const u=await getUser(env.DB, from.id);
    await sendMessage(env, chatId, `💰 Your balance: <b>${u?.balance||0} FWC</b>\nWallet: ${u?.wallet||'Not set'}`);
    return {ok:true};
  }
  if(text==='/mine'){
    const c=await canMine(env.DB, from.id);
    if(c.can) await sendMessage(env, chatId, `⛏️ Mining ready! You can claim <b>${c.nextAmount} FWC</b> now.`, {replyMarkup: miniAppKeyboard(APP_URL)});
    else await sendMessage(env, chatId, `⏳ Mining not ready yet. Wait <b>${Math.ceil(c.waitSec/60)} min</b>.`);
    return {ok:true};
  }
  // Unknown text -> guide to app
  await sendMessage(env, chatId, `⚡ Open FWC App to mine & earn:`, {replyMarkup: miniAppKeyboard(APP_URL)});
  return {ok:true};
}
