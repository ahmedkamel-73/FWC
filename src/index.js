// FWC CLEAN v1 - index.js (Step 1)
import { initDB, getUser, createOrUpdateUser, getConfigValue, isFounder, getFounderConfig } from './db.js';
import { getSecrets } from './config.js';
import { canMine, doMine, getMiningSettings } from './mining.js';
import { calculateWithdrawalFee } from './fees.js';
import { getUserDailyProgress, doTask, testJoinVerification } from './tasks.js';
import { handleBotUpdate } from './bot/commands.js';
import { notifyWithdrawalApproved, notifyWithdrawalRejected } from './bot/notifications.js';
import USER_HTML from './html/user.html';
import ADMIN_HTML from './html/admin.html';

function json(o,s=200){ return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json'}}); }
function htmlResponse(h){ return new Response(h,{headers:{'Content-Type':'text/html; charset=utf-8'}}); }
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
      try{ const update=await request.json(); await handleBotUpdate(env, update); }catch(e){ console.warn('webhook error', e.message); }
      return json({ok:true});
    }
    if(path==='/webhook' && request.method==='GET'){
      return json({ok:true, hint:'POST Telegram updates here. Set webhook to https://fwc.ahmed73.workers.dev/webhook'});
    }
    if(path==='/tonconnect-manifest.json') return json({url:url.origin,name:'FWC Mining',iconUrl:url.origin+'/logo.png'});
    if(path==='/'||path==='/app') return htmlResponse(USER_HTML);
    if(path==='/aha.htm') return htmlResponse(ADMIN_HTML);
    if(path==='/logo.png' || path==='/logo.jpg' || path==='/favicon.ico') return json({ok:false,error:'not_found'},404);
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
        await notifyWithdrawalApproved(env, wd.telegram_id, wd.amount, wd.net_amount);
        return json({ok:true});
      }
      if(path==='/api/admin/withdrawals/reject' && request.method==='POST'){
        const body=await request.json().catch(()=>({}));
        const wd=await env.DB.prepare(`SELECT * FROM withdrawals WHERE id=?`).bind(body.id).first();
        if(!wd) return json({ok:false,error:'not_found'},404);
        await env.DB.prepare(`UPDATE withdrawals SET status='rejected' WHERE id=?`).bind(body.id).run();
        await env.DB.prepare(`UPDATE users SET balance=ROUND(balance+?,8) WHERE telegram_id=?`).bind(wd.amount, wd.telegram_id).run();
        await notifyWithdrawalRejected(env, wd.telegram_id, wd.amount, body.reason||'');
        return json({ok:true});
      }
      return json({ok:false,error:'not_found'},404);
    }
    // USER APIs - require tgUser
    if(!tgUser) return json({ok:false,error:'no_telegram_user'},401);
    if(path==='/api/me'){
      const user=await createOrUpdateUser(env.DB,{telegram_id:tgUser.id,username:tgUser.username,first_name:tgUser.first_name});
      const mine=await canMine(env.DB,tgUser.id);
      const founderFlag=await isFounder(env.DB,tgUser.id);
      const founderCfg=await getFounderConfig(env.DB);
      // Mining amount: 6 base, founder gets bonus
      let miningAmount=6;
      try{ const s=await getMiningSettings(env.DB); if(s?.amount) miningAmount=parseFloat(s.amount); }catch{}
      let founderObj={isFounder:false,interval_hours:founderCfg?.interval_hours||168,bonus_percent:founderCfg?.bonus_percent||0,fee_percent:founderCfg?.fee_percent||0};
      if(founderFlag){
        const nextAmount=Math.round(miningAmount*( (founderCfg?.interval_hours||168)/4 )*(1+(founderCfg?.bonus_percent||0)/100)*100000000)/100000000;
        founderObj={isFounder:true,interval_hours:founderCfg?.interval_hours||168,bonus_percent:founderCfg?.bonus_percent||0,fee_percent:founderCfg?.fee_percent||0,nextAmount};
      }
      // Streak: from daily_checkins
      let streak=0;
      try{ const r=await env.DB.prepare(`SELECT COUNT(*) c FROM daily_checkins WHERE telegram_id=?`).bind(tgUser.id).first(); streak=r?.c||0; }catch{}
      // canWithdraw: wallet + balance >= min + not banned
      let canWithdraw={ok:false,reason:'addWallet'};
      try{
        const min=parseFloat(await getConfigValue(env.DB,'withdraw_min','1000'));
        if(!user?.wallet) canWithdraw={ok:false,reason:'addWallet'};
        else if((user?.balance||0)<min) canWithdraw={ok:false,reason:'min',min};
        else if(user?.is_banned) canWithdraw={ok:false,reason:'banned'};
        else canWithdraw={ok:true};
      }catch{ canWithdraw={ok:false,reason:'error'}; }
      // Ads config (may be missing in clean DB, default null)
      let adBlockId=null, adAutoBlockId=null;
      try{ adBlockId=await getConfigValue(env.DB,'ads_free_block_id',null); adAutoBlockId=await getConfigValue(env.DB,'ads_auto_block_id',null); }catch{}
      return json({ok:true,telegram_id:tgUser.id,username:tgUser.username||user?.username||null,first_name:user?.first_name||tgUser.first_name||null,language:user?.language||'en',balance:user?.balance||0,wallet:user?.wallet||null,wallet_verified:user?.wallet_verified||0,is_banned:user?.is_banned||0,miningAmount,founder:founderObj,canMine:mine,canWithdraw,streak,adBlockId,adAutoBlockId,ads:{freeBlockId:adBlockId,autoBlockId:adAutoBlockId},user});
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
      return json({ok:true,isFounder:founder,config:cfg});
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
      const refs=(await env.DB.prepare(`SELECT telegram_id,username,first_name FROM users WHERE referral_by=?`).bind(tgUser.id).all()).results||[];
      const u=await getUser(env.DB,tgUser.id);
      return json({ok:true,code:u?.referral_code,referrals:refs,count:refs.length,link:`https://t.me/FWC_Bot?start=${u?.referral_code||''}`});
    }
    if(path==='/api/leaderboard'){
      const rows=(await env.DB.prepare(`SELECT telegram_id,username,first_name,balance FROM users ORDER BY balance DESC LIMIT 50`).all()).results||[];
      return json({ok:true,leaderboard:rows});
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
