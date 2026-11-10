// FWC CLEAN v1 - tasks.js (Step 1: checkin + join with real detail)
export async function getUserDailyProgress(db, telegram_id, date){
  const rows = (await db.prepare(`SELECT task_id, COUNT(*) cnt FROM user_daily_tasks WHERE telegram_id=? AND date=? GROUP BY task_id`).bind(telegram_id,date).all()).results||[];
  const map={};
  for(const r of rows) map[r.task_id]=r.cnt;
  // once tasks: lifetime
  const once = (await db.prepare(`SELECT task_id, COUNT(*) cnt FROM user_daily_tasks WHERE telegram_id=? GROUP BY task_id`).bind(telegram_id).all()).results||[];
  for(const r of once){ if(map[r.task_id]===undefined) map[r.task_id]=r.cnt; else map[r.task_id]=Math.max(map[r.task_id], r.cnt); }
  return map;
}
export async function doTask(db, telegram_id, task_id, date, env){
  const task = await db.prepare(`SELECT * FROM daily_tasks WHERE id=? AND active=1`).bind(task_id).first();
  if(!task) return { ok:false, reason:'no_task' };
  if(task.once){
    const done = await db.prepare(`SELECT 1 FROM user_daily_tasks WHERE telegram_id=? AND task_id=? LIMIT 1`).bind(telegram_id,task_id).first();
    if(done) return { ok:false, reason:'already_done' };
  }
  const today = await db.prepare(`SELECT COUNT(*) c FROM user_daily_tasks WHERE telegram_id=? AND task_id=? AND date=?`).bind(telegram_id,task_id,date).first();
  if((today?.c||0) >= task.max_per_day) return { ok:false, reason:'limit', count:today.c, max:task.max_per_day };
  if(task.type==='invite'){
    const ref = await db.prepare(`SELECT COUNT(*) c FROM users WHERE referral_by=?`).bind(telegram_id).first();
    const claimed = await db.prepare(`SELECT COUNT(*) c FROM user_daily_tasks WHERE telegram_id=? AND task_id=?`).bind(telegram_id,task_id).first();
    if((ref?.c||0) <= (claimed?.c||0)) return { ok:false, reason:'not_enough_referrals', referrals:ref?.c||0, claimed:claimed?.c||0 };
  }
  if(task.type==='join' && task.channel){
    const botToken = (env?.BOT_TOKEN||env?.botToken||'').toString().trim();
    if(!botToken) return { ok:false, reason:'bot_token_missing', detail:'BOT_TOKEN is empty in Worker env.' };
    let chatId = String(task.channel).trim();
    if(!chatId.startsWith('@') && !chatId.startsWith('-') && !/^\d+$/.test(chatId)) chatId='@'+chatId;
    let lastErr=null;
    for(let a=0;a<2;a++){
      try{
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${telegram_id}`);
        let data=null; try{ data=await res.json(); }catch{}
        if(!data){ lastErr='Telegram non-JSON HTTP '+res.status; continue; }
        if(data.ok){
          const st=data.result?.status;
          if(['member','administrator','creator','restricted'].includes(st)) break;
          return { ok:false, reason:'not_subscribed', detail:'Telegram status: '+st };
        }
        const desc=(data.description||'').toLowerCase();
        if(desc.includes('bot is not a member')||desc.includes('chat not found')||desc.includes('member list')) return { ok:false, reason:'bot_not_in_chat', detail:data.description };
        if(desc.includes('bot was blocked')||desc.includes('unauthorized')) return { ok:false, reason:'bot_token_missing', detail:data.description };
        lastErr=data.description||'Telegram error';
      }catch(e){ lastErr=e.message; }
    }
    if(lastErr) return { ok:false, reason:'verification_error', detail:lastErr };
  }
  const now=Math.floor(Date.now()/1000);
  await db.prepare(`INSERT INTO user_daily_tasks(telegram_id,task_id,date,created_at) VALUES(?,?,?,?)`).bind(telegram_id,task_id,date,now).run();
  await db.prepare(`UPDATE users SET balance=ROUND(balance+?,8) WHERE telegram_id=?`).bind(task.reward||0,telegram_id).run();
  return { ok:true, reward: task.reward||0 };
}
export async function testJoinVerification(env, channel, userId){
  const botToken=(env?.BOT_TOKEN||'').toString().trim();
  if(!botToken) return { ok:false, reason:'bot_token_missing' };
  let chatId=String(channel).trim(); if(!chatId.startsWith('@')&&!chatId.startsWith('-')) chatId='@'+chatId;
  const res=await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`);
  const data=await res.json().catch(()=>null);
  return { ok: !!data?.ok, telegram:data };
}
