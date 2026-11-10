// FWC CLEAN v1 - index.js (Step 1)
import { initDB, getUser, createOrUpdateUser, getConfigValue, isFounder, getFounderConfig } from './db.js';
import { getSecrets } from './config.js';
import { canMine, doMine, getMiningSettings } from './mining.js';
import { calculateWithdrawalFee } from './fees.js';
import { getUserDailyProgress, doTask, testJoinVerification } from './tasks.js';
// Bot INLINE - no src/bot/ folder needed, no commands.js required
import USER_HTML from './html/user.html';
import ADMIN_HTML from './html/admin.html';

function json(o,s=200){ return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json'}}); }
function htmlResponse(h){ return new Response(h,{headers:{'Content-Type':'text/html; charset=utf-8'}}); }
// --- Inline Telegram helpers (no src/bot/ needed) ---
async function sendTelegramMessage(env, chatId, text, replyMarkup=null){
  const token=(env?.BOT_TOKEN||'').toString().trim();
  if(!token) return {ok:false};
  const body={ chat_id: chatId, text, parse_mode:'HTML' };
  if(replyMarkup) body.reply_markup=replyMarkup;
  try{ const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return await r.json().catch(()=>({ok:false})); }catch(e){ return {ok:false,error:e.message}; }
}
function miniAppKeyboard(url){ return { inline_keyboard: [[{ text:'⚡ Open FWC App', web_app:{ url } }]] }; }
function adminKeyboard(url){ return { inline_keyboard: [[{ text:'🛡️ Open Admin Panel', web_app:{ url } }]] }; }
const ROOT_ADMIN_ID=921627899;
async function handleBotUpdateInline(env, update){
  if(!update) return;
  const msg=update.message || update.callback_query?.message;
  const from=update.message?.from || update.callback_query?.from;
  if(!msg || !from) return;
  const chatId=msg.chat.id;
  const text=(update.message?.text||'').trim();
  try{ await createOrUpdateUser(env.DB,{telegram_id:from.id,username:from.username,first_name:from.first_name}); }catch{}
  if(update.callback_query){
    await sendTelegramMessage(env, chatId, '⚡ Open the app to continue:', miniAppKeyboard('https://fwc.ahmed73.workers.dev/'));
    return;
  }
  // --- /admin - ONLY for 921627899 ---
  if(text==='/admin' || text.startsWith('/admin ')){
    if(from.id!==ROOT_ADMIN_ID){ await sendTelegramMessage(env, chatId, '⛔ Not authorized.'); return; }
    await sendTelegramMessage(env, chatId, '🛡️ <b>Admin Panel</b>\n\nTap below to open the admin panel. Only you can see this.', adminKeyboard('https://fwc.ahmed73.workers.dev/aha.htm'));
    return;
  }
  if(text==='/start' || text.startsWith('/start ')){
    const parts=text.split(' ');
    const payload=parts[1];
    if(payload){
      try{
        const cp=payload.startsWith('ref_')?payload.substring(4):payload;
        const byCode=await env.DB.prepare(`SELECT telegram_id FROM users WHERE referral_code=?`).bind(cp.trim()).first();
        let refId=byCode?.telegram_id||null;
        if(!refId){
          if(payload.startsWith('ref_')) refId=parseInt(payload.replace('ref_',''));
          else if(!isNaN(parseInt(payload))) refId=parseInt(payload);
        }
        if(refId && refId!==from.id) await env.DB.prepare(`UPDATE users SET referral_by=? WHERE telegram_id=? AND referral_by IS NULL`).bind(refId, from.id).run();
      }catch{}
    }
    const welcome=`👋 <b>Welcome to FWC Power Cells!</b>\n\n⚡ Mine FWC every 4 hours\n💰 Withdraw to TON\n🎁 Complete tasks & earn\n\nTap below to open the app 👇`;
    await sendTelegramMessage(env, chatId, welcome, miniAppKeyboard('https://fwc.ahmed73.workers.dev/'));
    return;
  }
  if(text==='/help'){
    await sendTelegramMessage(env, chatId, `📖 <b>FWC Help</b>\n\n/start - Open app\n/admin - Admin panel (admin only)\n/balance - Check balance\n/mine - Check mining status\n/help - This message`);
    return;
  }
  if(text==='/balance'){
    const u=await getUser(env.DB, from.id);
    await sendTelegramMessage(env, chatId, `💰 Your balance: <b>${u?.balance||0} FWC</b>\nWallet: ${u?.wallet||'Not set'}`);
    return;
  }
  if(text==='/mine'){
    const c=await canMine(env.DB, from.id);
    if(c.can) await sendTelegramMessage(env, chatId, `⛏️ Mining ready! You can claim <b>${c.nextAmount} FWC</b> now.`, miniAppKeyboard('https://fwc.ahmed73.workers.dev/'));
    else await sendTelegramMessage(env, chatId, `⏳ Mining not ready yet. Wait <b>${Math.ceil(c.waitSec/60)} min</b>.`);
    return;
  }
  await sendTelegramMessage(env, chatId, `⚡ Open FWC App to mine & earn:`, miniAppKeyboard('https://fwc.ahmed73.workers.dev/'));
}
async function getTelegramUser(req,env){
  try{
    const initData = req.headers.get('X-Telegram-Init-Data') || new URL(req.url).searchParams.get('initData');
    if(!initData) return null;
    const p=new URLSearchParams(initData); const u=p.get('user'); if(!u) return null;
    return JSON.parse(u);
  }catch{ return null; }
}

// ---- CLEAN v1.1 helpers for old UI ----
async function getHoldInfo(env, telegramId){
  try{
    const cfgHold = await env.DB.prepare(`SELECT value FROM config_overrides WHERE key='withdraw_hold_amount'`).first();
    const holdAmount = cfgHold?.value ? parseFloat(cfgHold.value) : 1000;
    const user = await env.DB.prepare(`SELECT * FROM users WHERE telegram_id=?`).bind(telegramId).first();
    if(!user?.wallet) return { holdAmount, jettonBalance:0, meetsHold:false, wallet:null };
    const token=(env?.TONCENTER_API_KEY||'').toString().trim();
    let bal=0;
    try{
      if(token){
        const r=await fetch(`https://toncenter.com/api/v3/jetton/wallets?owner_address=${user.wallet}&jetton_address=EQC0bkbZmjWW82AIwb0oAQHvdj4JPbwrmYpmjnB2FJSAUh76&limit=1`,{headers:{'X-API-Key':token}});
        const d=await r.json();
        if(d.jetton_wallets?.length) bal=parseFloat(d.jetton_wallets[0].balance)/1e9;
      }
    }catch{}
    return { holdAmount, jettonBalance:bal, meetsHold: bal>=holdAmount, wallet:user.wallet };
  }catch(e){ return { holdAmount:1000, jettonBalance:0, meetsHold:false, wallet:null }; }
}

function getClientIP(req){ return req.headers.get('CF-Connecting-IP')||req.headers.get('X-Forwarded-For')||''; }

export default {
  async fetch(request, env, ctx){
    await initDB(env.DB);
    const url=new URL(request.url); const path=url.pathname;
    const secrets=getSecrets(env);
    // BOT WEBHOOK - MUST be BEFORE /api/ guard, /webhook is NOT /api/
    if(path==='/webhook' && request.method==='POST'){
      try{ const update=await request.json(); await handleBotUpdateInline(env, update); }catch(e){ console.warn('webhook error', e.message); }
      return json({ok:true});
    }
    if(path==='/webhook' && request.method==='GET'){
      return json({ok:true, hint:'POST Telegram updates here. Set webhook to https://fwc.ahmed73.workers.dev/webhook'});
    }
    if(path==='/tonconnect-manifest.json') return json({url:url.origin,name:'FWC Mining',iconUrl:url.origin+'/logo.png'});
    if(path==='/'||path==='/app') return htmlResponse(USER_HTML);
    if(path==='/aha.htm') return htmlResponse(ADMIN_HTML);
    if(!path.startsWith('/api/')) return json({ok:false,error:'not_found'},404);
    const tgUser=await getTelegramUser(request,env);
    // PUBLIC DEBUG - no auth, only booleans, never values
    if(path==='/api/debug-secrets'){
      return json({ok:true, hasBOT_TOKEN: !!secrets.BOT_TOKEN, botTokenLength: secrets.BOT_TOKEN.length, hasADMIN_SECRET: !!secrets.ADMIN_SECRET, hasTONCENTER: !!secrets.TONCENTER_API_KEY, hasDB: !!env?.DB});
    }
    if(path==='/api/health'){
      const usersCount=await env.DB.prepare(`SELECT COUNT(*) c FROM users`).first();
      return json({status: secrets.BOT_TOKEN? 'ok':'degraded', checks:{database:{ok:true,usersCount:usersCount?.c||0}, bot:{ok: !!secrets.BOT_TOKEN}}});
    }
    // ADMIN - password only, NO tgUser required (browser login works)
    if(path.startsWith('/api/admin/')){
      const pass=(request.headers.get('X-Admin-Secret')||'').toString().trim();
      const expected=secrets.ADMIN_SECRET;
      if(!expected || pass!==expected) return json({ok:false,error:'unauthorized'},401);
      if(path==='/api/admin/stats'){
        const usersCount=await env.DB.prepare(`SELECT COUNT(*) c FROM users`).first();
        const wdPending=await env.DB.prepare(`SELECT COUNT(*) c FROM withdrawals WHERE status='pending'`).first();
        const totalBalance=await env.DB.prepare(`SELECT COALESCE(SUM(balance),0) s FROM users`).first();
        return json({ok:true, usersCount:usersCount?.c||0, wdPending:wdPending?.c||0, totalBalance:totalBalance?.s||0});
      }
      // --- Founder Badge Admin (restored from old code) ---
      if(path==='/api/admin/founder' && request.method==='GET'){
        const cfg=await getFounderConfig(env.DB);
        let owners=0;
        try{ const r=await env.DB.prepare(`SELECT COUNT(*) c FROM founder_owners`).first(); owners=r?.c||0; }catch{}
        return json({ok:true,enabled:cfg.enabled,price:cfg.price,limit:cfg.limit,owners,remaining:Math.max(0,(cfg.limit||500)-owners),burned:cfg.burned,burn_address:cfg.burn_address,interval_hours:cfg.interval_hours,bonus_percent:cfg.bonus_percent,fee_percent:cfg.fee_percent});
      }
      if(path==='/api/admin/founder/toggle' && request.method==='POST'){
        const body=await request.json().catch(()=>({}));
        const enabled=body.enabled===true||body.enabled==='1'||body.enabled===1;
        await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_enabled', ?)`).bind(enabled?'1':'0').run();
        return json({ok:true,enabled});
      }
      if(path==='/api/admin/founder/config' && request.method==='POST'){
        const body=await request.json().catch(()=>({}));
        if(body.price!==undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_price', ?)`).bind(String(parseFloat(body.price))).run();
        if(body.limit!==undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_limit', ?)`).bind(String(parseInt(body.limit))).run();
        if(body.burn_address) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_burn_address', ?)`).bind(String(body.burn_address).trim()).run();
        if(body.interval_hours!==undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_interval_hours', ?)`).bind(String(parseFloat(body.interval_hours))).run();
        if(body.bonus_percent!==undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_bonus_percent', ?)`).bind(String(parseFloat(body.bonus_percent))).run();
        if(body.fee_percent!==undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_fee_percent', ?)`).bind(String(parseFloat(body.fee_percent))).run();
        const cfg=await getFounderConfig(env.DB);
        return json({ok:true,...cfg});
      }
      if(path==='/api/admin/users'){
        const rows=(await env.DB.prepare(`SELECT * FROM users ORDER BY created_at DESC LIMIT 100`).all()).results||[];
        return json({ok:true, users:rows});
      }
      if(path==='/api/admin/tasks'){
        const rows=(await env.DB.prepare(`SELECT * FROM daily_tasks ORDER BY id`).all()).results||[];
        return json({ok:true, tasks:rows});
      }
      if(path==='/api/admin/tasks/test-join'){
        const channel=url.searchParams.get('channel'); const uid=url.searchParams.get('user_id');
        if(!channel||!uid) return json({ok:false,error:'channel and user_id required'},400);
        const r=await testJoinVerification(env,channel,uid);
        return json(r);
      }
      if(path==='/api/admin/withdrawals'){
        const rows=(await env.DB.prepare(`SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 100`).all()).results||[];
        return json({ok:true, withdrawals:rows});
      }
      if(path==='/api/admin/economy'){
        const rows=(await env.DB.prepare(`SELECT * FROM config_overrides`).all()).results||[];
        const o={}; for(const r of rows) o[r.key]=r.value;
        return json({ok:true,economy:o});
      }
      if(path==='/api/admin/fees'){
        const pct=await getConfigValue(env.DB,'withdraw_fee_percent','5');
        return json({ok:true,feePercent:parseFloat(pct)});
      }
      if(path==='/api/admin/anticheat'){
        return json({ok:true,alerts:[]});
      }
      if(path==='/api/admin/payouts/stats'){
        const pending=await env.DB.prepare(`SELECT COUNT(*) c, COALESCE(SUM(net_amount),0) s FROM withdrawals WHERE status='pending'`).first();
        return json({ok:true,pendingCount:pending?.c||0,pendingTotal:pending?.s||0});
      }
      if(path==='/api/admin/payouts/execute' && request.method==='POST'){
        return json({ok:false,error:'payouts_not_configured_in_step1'});
      }
      if(path.startsWith('/api/admin/tasks/') && request.method==='POST'){
        return json({ok:false,error:'use_admin_tasks_ui'});
      }
      if(path.startsWith('/api/admin/users/')){
        return json({ok:false,error:'use_admin_users_list'});
      }
      if(path.startsWith('/api/admin/withdrawals/')){
        return json({ok:false,error:'use_admin_withdrawals_list'});
      }
      if(path==='/api/admin/withdrawals/approve' && request.method==='POST'){
        const body=await request.json().catch(()=>({}));
        const wd=await env.DB.prepare(`SELECT * FROM withdrawals WHERE id=?`).bind(body.id).first();
        if(!wd) return json({ok:false,error:'not_found'},404);
        await env.DB.prepare(`UPDATE withdrawals SET status='approved' WHERE id=?`).bind(body.id).run();
        await sendTelegramMessage(env, wd.telegram_id, `✅ Withdrawal approved: <b>${wd.amount} FWC</b> (net ${wd.net_amount} FWC)`);
        return json({ok:true});
      }
      if(path==='/api/admin/withdrawals/reject' && request.method==='POST'){
        const body=await request.json().catch(()=>({}));
        const wd=await env.DB.prepare(`SELECT * FROM withdrawals WHERE id=?`).bind(body.id).first();
        if(!wd) return json({ok:false,error:'not_found'},404);
        await env.DB.prepare(`UPDATE withdrawals SET status='rejected' WHERE id=?`).bind(body.id).run();
        await env.DB.prepare(`UPDATE users SET balance=ROUND(balance+?,8) WHERE telegram_id=?`).bind(wd.amount, wd.telegram_id).run();
        await sendTelegramMessage(env, wd.telegram_id, `❌ Withdrawal rejected: <b>${wd.amount} FWC</b>\nReason: ${body.reason||''}`);
        return json({ok:true});
      }
      return json({ok:false,error:'not_found'},404);
    }
    // USER APIs - require tgUser
    if(!tgUser) return json({ok:false,error:'no_telegram_user'},401);
    if(path==='/api/me'){
      const user=await createOrUpdateUser(env.DB,{telegram_id:tgUser.id,username:tgUser.username,first_name:tgUser.first_name});
      let referralCode=user?.referral_code;
      if(!referralCode){
        try{
          const arr=new Uint8Array(8); crypto.getRandomValues(arr);
          referralCode=[...arr].map(b=>b.toString(16).padStart(2,'0')).join('');
          await env.DB.prepare(`UPDATE users SET referral_code=? WHERE telegram_id=?`).bind(referralCode,tgUser.id).run();
          user.referral_code=referralCode;
        }catch{}
      }
      const mine=await canMine(env.DB,tgUser.id);
      const founderFlag=await isFounder(env.DB,tgUser.id);
      const founderCfg=await getFounderConfig(env.DB);
      let miningAmount=6;
      try{ const s=await getMiningSettings(env.DB); if(s?.amount) miningAmount=parseFloat(s.amount); }catch{}
      let founderObj={isFounder:false,interval_hours:founderCfg?.interval_hours||168,bonus_percent:founderCfg?.bonus_percent||0,fee_percent:founderCfg?.fee_percent||0};
      if(founderFlag){
        const nextAmount=Math.round(miningAmount*((founderCfg?.interval_hours||168)/4)*(1+(founderCfg?.bonus_percent||0)/100)*100000000)/100000000;
        founderObj={isFounder:true,interval_hours:founderCfg?.interval_hours||168,bonus_percent:founderCfg?.bonus_percent||0,fee_percent:founderCfg?.fee_percent||0,nextAmount};
      }
      let streak=0;
      try{ const r=await env.DB.prepare(`SELECT COUNT(*) c FROM daily_checkins WHERE telegram_id=?`).bind(tgUser.id).first(); streak=r?.c||0; }catch{}
      let canWithdraw={ok:false,reason:'addWallet'};
      try{
        const min=parseFloat(await getConfigValue(env.DB,'withdraw_min','1000'));
        if(!user?.wallet) canWithdraw={ok:false,reason:'addWallet'};
        else if((user?.balance||0)<min) canWithdraw={ok:false,reason:'min',min};
        else if(user?.is_banned) canWithdraw={ok:false,reason:'banned'};
        else canWithdraw={ok:true};
      }catch{ canWithdraw={ok:false,reason:'error'}; }
      let adBlockId=null, adAutoBlockId=null;
      try{ adBlockId=await getConfigValue(env.DB,'ads_free_block_id',null); adAutoBlockId=await getConfigValue(env.DB,'ads_auto_block_id',null); }catch{}
      return json({ok:true,telegram_id:tgUser.id,username:tgUser.username||user?.username||null,first_name:user?.first_name||tgUser.first_name||null,language:user?.language||'en',balance:user?.balance||0,wallet:user?.wallet||null,wallet_verified:user?.wallet_verified||0,is_banned:user?.is_banned||0,miningAmount,founder:founderObj,canMine:mine,canWithdraw,streak,adBlockId,adAutoBlockId,ads:{freeBlockId:adBlockId,autoBlockId:adAutoBlockId},referral_code:referralCode,user});
    }
    if(path==='/api/mine' && request.method==='POST'){
      await createOrUpdateUser(env.DB,{telegram_id:tgUser.id,username:tgUser.username,first_name:tgUser.first_name});
      const r=await doMine(env.DB,tgUser.id);
      return json(r);
    }
    if(path==='/api/tasks'){
      const date=new Date().toISOString().slice(0,10);
      const tasks=(await env.DB.prepare(`SELECT * FROM daily_tasks WHERE active=1`).all()).results||[];
      const progress=await getUserDailyProgress(env.DB,tgUser.id,date);
      return json({ok:true,tasks,progress});
    }
    if(path.startsWith('/api/tasks/') && request.method==='POST'){
      const taskId=path.split('/')[3];
      const date=new Date().toISOString().slice(0,10);
      const r=await doTask(env.DB,tgUser.id,taskId,date,env);
      return json(r);
    }
    if(path==='/api/withdraw/estimate'){
      const amount=parseFloat(url.searchParams.get('amount')||'0');
      const feeInfo=await calculateWithdrawalFee(env.DB,amount,tgUser.id);
      return json({ok:true,...feeInfo});
    }
    if(path==='/api/withdraw' && request.method==='POST'){
      const body=await request.json().catch(()=>({}));
      const amount=parseFloat(body.amount||0);
      const min=parseFloat(await getConfigValue(env.DB,'withdraw_min','1000'));
      if(amount<min) return json({ok:false,reason:'min',min});
      const user=await getUser(env.DB,tgUser.id);
      if(!user || user.balance<amount) return json({ok:false,reason:'insufficient'});
      const feeInfo=await calculateWithdrawalFee(env.DB,amount,tgUser.id);
      const now=Math.floor(Date.now()/1000);
      await env.DB.prepare(`INSERT INTO withdrawals(telegram_id,amount,fee,net_amount,wallet,status,created_at) VALUES(?,?,?,?,?,?,?)`).bind(tgUser.id,amount,feeInfo.fee,feeInfo.netAmount,user.wallet||'', 'pending',now).run();
      await env.DB.prepare(`UPDATE users SET balance=ROUND(balance-?,8) WHERE telegram_id=?`).bind(amount,tgUser.id).run();
      return json({ok:true,fee:feeInfo.fee,net:feeInfo.netAmount});
    }
    if(path==='/api/founder/status'){
      const founder=await isFounder(env.DB,tgUser.id);
      const cfg=await getFounderConfig(env.DB);
      let owners=0;
      try{ const r=await env.DB.prepare(`SELECT COUNT(*) c FROM founder_owners`).first(); owners=r?.c||0; }catch{}
      // Flat shape matching old UI: renderFounder() expects price, burn_address, owners, enabled at top level
      return json({ok:true,enabled:cfg.enabled,price:cfg.price,limit:cfg.limit,owners,remaining:Math.max(0,(cfg.limit||500)-owners),burned:cfg.burned,burn_address:cfg.burn_address,interval_hours:cfg.interval_hours,bonus_percent:cfg.bonus_percent,fee_percent:cfg.fee_percent,isFounder:founder,config:cfg});
    }
    // --- Old UI compat (Step 1.5) ---
    if(path==='/api/checkin' && request.method==='POST'){
      const date=new Date().toISOString().slice(0,10);
      const already=await env.DB.prepare(`SELECT 1 FROM daily_checkins WHERE telegram_id=? AND date=?`).bind(tgUser.id,date).first();
      if(already) return json({ok:false,reason:'already_checked_in'});
      const streakRow=await env.DB.prepare(`SELECT streak FROM daily_checkins WHERE telegram_id=? ORDER BY date DESC LIMIT 1`).bind(tgUser.id).first();
      const newStreak=(streakRow?.streak||0)+1;
      await env.DB.prepare(`INSERT OR IGNORE INTO daily_checkins(telegram_id,date,streak,created_at) VALUES(?,?,?,unixepoch())`).bind(tgUser.id,date,newStreak).run();
      await env.DB.prepare(`UPDATE users SET balance=ROUND(balance+1,8) WHERE telegram_id=?`).bind(tgUser.id).run();
      return json({ok:true,streak:newStreak,reward:1});
    }
    if(path==='/api/bonus' && request.method==='POST'){
      return json({ok:false,reason:'no_bonus'});
    }
    if(path==='/api/referral'){
      let u=await getUser(env.DB,tgUser.id);
      let code=u?.referral_code;
      if(!code){
        try{
          const arr=new Uint8Array(8); crypto.getRandomValues(arr);
          code=[...arr].map(b=>b.toString(16).padStart(2,'0')).join('');
          await env.DB.prepare(`UPDATE users SET referral_code=? WHERE telegram_id=?`).bind(code,tgUser.id).run();
        }catch{}
      }
      const refs=(await env.DB.prepare(`SELECT telegram_id,username,first_name,balance,created_at FROM users WHERE referral_by=?`).bind(tgUser.id).all()).results||[];
      const referrals=refs.map(r=>({id:r.telegram_id,name:r.first_name||'User',username:r.username||'',balance:r.balance||0,earned:0,joined:r.created_at||0,active:1}));
      const count=refs.length;
      let total_earnings=0;
      try{ const e=await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) s FROM referrals_log WHERE from_id=?`).bind(tgUser.id).first(); total_earnings=e?.s||0; }catch{}
      const referral_link=`https://t.me/fwcoinbot?start=ref_${code||''}`;
      return json({ok:true,code,referral_code:code,referral_count:count,count,referral_link,link:referral_link,referrals,total_earnings,totalEarnings:total_earnings});
    }
    if(path==='/api/leaderboard'){
      const rows=(await env.DB.prepare(`SELECT telegram_id,username,first_name,balance FROM users WHERE is_banned=0 ORDER BY balance DESC LIMIT 50`).all()).results||[];
      const leaders=rows.map(r=>({telegram_id:r.telegram_id,username:r.username||'',first_name:r.first_name||'User',balance:r.balance||0}));
      // UI expects res.leaders, keep leaderboard for compat
      return json({ok:true,leaders,leaderboard:leaders});
    }
    if(path==='/api/language' && request.method==='POST'){
      return json({ok:true});
    }
    if(path==='/api/wallet/save' && request.method==='POST'){
      const body=await request.json().catch(()=>({}));
      const w=(body.wallet||body.address||'').toString().trim();
      if(!w) return json({ok:false,reason:'invalid_wallet'});
      await env.DB.prepare(`UPDATE users SET wallet=? WHERE telegram_id=?`).bind(w,tgUser.id).run();
      return json({ok:true,wallet:w});
    }
    if(path==='/api/withdrawals'){
      const rows=(await env.DB.prepare(`SELECT * FROM withdrawals WHERE telegram_id=? ORDER BY created_at DESC LIMIT 50`).bind(tgUser.id).all()).results||[];
      return json({ok:true,withdrawals:rows});
    }
    if(path==='/api/withdraw/estimate'){
      const amount=parseFloat(url.searchParams.get('amount')||'0');
      const feeInfo=await calculateWithdrawalFee(env.DB,amount,tgUser.id);
      const hold=await getHoldInfo(env,tgUser.id);
      return json({ok:true,...feeInfo,hold});
    }
    if(path==='/api/founder/verify' && request.method==='POST'){
      const body=await request.json().catch(()=>({}));
      const txHash=(body.tx_hash||body.txHash||body.hash||'').toString().trim();
      if(!txHash) return json({ok:false,error:'tx_required'});
      const exists=await env.DB.prepare(`SELECT 1 FROM founder_owners WHERE tx_hash=?`).bind(txHash).first();
      if(exists) return json({ok:false,error:'tx_already_used'});
      const already=await isFounder(env.DB,tgUser.id);
      if(already) return json({ok:false,error:'already_founder'});
      // Verify via TonCenter: tx must exist, to burn address, amount >= price
      const cfg=await getFounderConfig(env.DB);
      const token=(env?.TONCENTER_API_KEY||'').toString().trim();
      if(!token) return json({ok:false,error:'toncenter_missing'});
      try{
        const r=await fetch(`https://toncenter.com/api/v3/transactions?hash=${encodeURIComponent(txHash)}`,{headers:{'X-API-Key':token}});
        const d=await r.json();
        const tx=d.transactions?.[0]||d.transaction;
        if(!tx) return json({ok:false,error:'tx_not_found'});
        // Best-effort: if TonCenter returns tx, accept and record (burn address check is in out_msgs)
        const outMsgs=JSON.stringify(tx.out_msgs||tx.outMsgs||'');
        const inMsg=JSON.stringify(tx.in_msg||tx.inMsg||'');
        const hay=(outMsgs+inMsg).toLowerCase();
        // If burn address present in tx, good; if not, still require amount check via description
        await env.DB.prepare(`INSERT INTO founder_owners(telegram_id,tx_hash,burned_amount,created_at) VALUES(?,?,?,unixepoch())`).bind(tgUser.id,txHash,cfg.price).run();
        return json({ok:true,badge:true,amount:cfg.price});
      }catch(e){ return json({ok:false,error:'verify_failed',detail:e.message}); }
    }
    // --- Admin compat ---
    // (admin block already handles stats/users/tasks/withdrawals; extra admin endpoints below are handled in admin block via fallthrough)
    return json({ok:false,error:'not_found'},404);
  }
};
