// FWC CLEAN v1 - bot/telegram.js - low level Telegram API
export async function sendMessage(env, chatId, text, opts={}){
  const token=(env?.BOT_TOKEN||'').toString().trim();
  if(!token) { console.warn('BOT_TOKEN missing - cannot send message'); return {ok:false, reason:'bot_token_missing'}; }
  const body={ chat_id: chatId, text, parse_mode: opts.parse_mode||'HTML', ...opts.extra };
  if(opts.replyMarkup) body.reply_markup=opts.replyMarkup;
  try{
    const res=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json().catch(()=>null);
    return data||{ok:false};
  }catch(e){ return {ok:false,error:e.message}; }
}
export function miniAppKeyboard(url){
  return { inline_keyboard: [[{ text:'⚡ Open FWC App', web_app:{ url } }]] };
}
