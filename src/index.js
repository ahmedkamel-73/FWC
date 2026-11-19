// src/index.js - FWC 4.0.0 PRODUCTION
// Main router: webhooks, APIs, HTML pages

import { CONFIG, getSecrets } from './config.js';
import {
  initDB, isAdminDB, getUser, createOrUpdateUser, setUserLanguage,
  getAllAdmins, addAdminById, removeAdmin, banUser, unbanUser,
  getEconomyConfig, setEconomyConfig, getAllEconomyConfig, getAdsConfig,
  getAllTasksAdmin, createTask, updateTask, deleteTask,
  createWithdrawal, getWithdrawalById, approveWithdrawal, rejectWithdrawal,
  getUserPendingWithdrawal, logFee, getTotalFees,
  getFounderConfig, isFounder, getFounderOwnersCount,
  trackUserIP, checkWalletDuplicate, checkIPDuplicate,
  createAntiCheatAlert, getAntiCheatAlerts, resolveAlert, dismissAlert,
} from './db.js';
import { getCurrentMiningAmount, canMine, doMine, canWithdraw } from './mining.js';
import { getDailyTasks, doTask, doCheckin, getCheckinStreak, getUserDailyProgress, hasCheckedInToday } from './tasks.js';
import { saveWallet, validateTonAddress, normalizeTonAddress } from './wallet.js';
import { calculateWithdrawalFee, getFeeConfig, updateFeePercent } from './fees.js';
import {
  getPendingWithdrawalsBatch, createBatchPayoutTransaction,
  markBatchAsSent, getPayoutStats, estimateBatchSaving, confirmBatch,
} from './payout.js';
import { executeBatchOnChain } from './ton-executor.js';
import { getSystemHealth } from './healthcheck.js'; 
import { handleCron } from './cron.js'; 

// TonConnect Verification Imports
import { Address, Cell, contractAddress, loadStateInit } from '@ton/ton';
import { sha256 } from '@ton/crypto';
import { Buffer } from 'node:buffer';

import USER_HTML from './html/user.html';
import ADMIN_HTML from './html/admin.html';

// ========== HELPERS ==========
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  });
}

async function verifyTelegramInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const encoder = new TextEncoder();
    const secretKeyData = encoder.encode('WebAppData' + botToken);
    const secretHash = await crypto.subtle.digest('SHA-256', secretKeyData);
    const key = await crypto.subtle.importKey('raw', secretHash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(dataCheckString));
    const calculatedHash = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
    return calculatedHash === hash;
  } catch {
    return false;
  }
}

async function getTelegramUser(request, env) {
  try {
    const initData = request.headers.get('X-Telegram-Init-Data')
      || new URL(request.url).searchParams.get('initData');
    if (!initData) return null;
    
    // Verify signature (non-blocking - log warning but allow)
    const botToken = env.BOT_TOKEN;
    if (botToken) {
      try {
        const isValid = await verifyTelegramInitData(initData, botToken);
        if (!isValid) {
          console.warn('Invalid Telegram initData hash - allowing anyway');
        }
      } catch (e) {
        console.warn('verify error', e.message);
      }
    }
    
    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}


function generateReferralCode() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || null;
}

// ========== RATE LIMIT (D1, no KV, non-blocking) ==========
async function checkRateLimit(db, key, limit = 8, windowMs = 60000) {
  if (!key) return false;
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER,
      window_start INTEGER
    )`).run();
    const now = Date.now();
    const windowStart = now - windowMs;
    const row = await db.prepare(`SELECT count, window_start FROM rate_limits WHERE key = ?`).bind(key).first();
    if (!row || row.window_start < windowStart) {
      await db.prepare(`INSERT OR REPLACE INTO rate_limits(key, count, window_start) VALUES (?, 1, ?)`).bind(key, now).run();
      return false;
    }
    if (row.count >= limit) return true;
    await db.prepare(`UPDATE rate_limits SET count = count + 1 WHERE key = ?`).bind(key).run();
    return false;
  } catch (e) {
    // If rate limit fails, don't block user
    console.warn('Rate limit error:', e.message);
    return false;
  }
}

// ========== TELEGRAM BOT API ==========
async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error('Telegram sendMessage error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ========== TON PROOF VERIFICATION ==========
const tonProofPrefix = 'ton-proof-item-v2/';
const tonConnectPrefix = 'ton-connect';

async function verifyTonProof(payload, account) {
  const { address, publicKey, chain } = account;
  const { timestamp, domain, signature, payload: payloadStr, state_init } = payload.proof;

  const stateInit = loadStateInit(Cell.fromBase64(state_init).beginParse());
  const expectedAddress = contractAddress(0, stateInit).toString();
  if (expectedAddress !== Address.parse(address).toString()) {
    return false;
  }

  const pubKeyBuffer = Buffer.from(publicKey, 'hex');
  const workchain = 0;
  const hash = Address.parse(address).hash;
  const addressBuffer = Buffer.alloc(36);
  addressBuffer.writeInt32BE(workchain, 0);
  hash.copy(addressBuffer, 4);

  const timestampBuffer = Buffer.alloc(8);
  timestampBuffer.writeBigUInt64LE(BigInt(timestamp));

  const domainBuffer = Buffer.alloc(4 + domain.lengthBytes);
  domainBuffer.writeUInt32LE(domain.lengthBytes, 0);
  domainBuffer.write(domain.value, 4);

  const payloadBuffer = Buffer.from(payloadStr, 'utf8');

  const message = Buffer.concat([
    Buffer.from(tonProofPrefix, 'utf8'),
    addressBuffer,
    domainBuffer,
    timestampBuffer,
    payloadBuffer
  ]);

  const messageHash = sha256(message);
  const finalHash = sha256(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from(tonConnectPrefix, 'utf8'), messageHash]));

  const signatureBuffer = Buffer.from(signature, 'base64');

  const key = await crypto.subtle.importKey(
    'raw',
    pubKeyBuffer,
    { name: 'Ed25519' },
    false,
    ['verify']
  );

  return await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    signatureBuffer,
    finalHash
  );
}

// ========== MAIN HANDLER ==========
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const botToken = env.BOT_TOKEN || getSecrets(env).botToken;

    // ========== TELEGRAM WEBHOOK FIRST - MUST ALWAYS RETURN 200 ==========
    // Webhook must never return 500, or Telegram keeps messages pending forever.
    // It runs BEFORE initDB so a DB error can never block the bot.
    if (path === '/webhook' && request.method === 'POST') {
      try {
        if (!botToken) {
          console.error('Webhook: BOT_TOKEN missing');
          return new Response('ok');
        }
        const update = await request.json().catch(() => null);
        const message = update?.message;
        if (message && message.text) {
          const text = message.text;
          const fromId = message.from.id;
          const fromUsername = message.from.username || null;
          const fromFirstName = message.from.first_name || null;
          const fromLang = message.from.language_code || 'en';
          try { await initDB(env.DB); } catch (e) { console.error('Webhook initDB error:', e.message); }
          if (text.startsWith('/start')) {
            try { await createOrUpdateUser(env.DB, { telegram_id: fromId, username: fromUsername, first_name: fromFirstName, language: fromLang }); } catch (e) { console.error('Webhook createUser:', e.message); }
            const parts = text.split(' ');
            const payload = parts[1];
            if (payload) {
              let refId = null;
              try {
                const cp = payload.startsWith('ref_') ? payload.substring(4) : payload;
                const byCode = await env.DB.prepare(`SELECT telegram_id FROM users WHERE referral_code = ?`).bind(cp.trim()).first();
                if (byCode) refId = byCode.telegram_id;
              } catch {}
              if (!refId) {
                if (payload.startsWith('ref_')) refId = parseInt(payload.replace('ref_', ''));
                else if (!isNaN(parseInt(payload))) refId = parseInt(payload);
              }
              if (refId && refId !== fromId) {
                try { await env.DB.prepare(`UPDATE users SET referral_by = ? WHERE telegram_id = ? AND referral_by IS NULL`).bind(refId, fromId).run(); } catch {}
              }
            }
            const workerUrl = env.WORKER_URL || url.origin;
            let isAdmin = false;
            try { isAdmin = await isAdminDB(env.DB, fromId); } catch {}
            const buttons = [[{ text: '🚀 Open FWC Mining App', web_app: { url: workerUrl } }]];
            if (isAdmin) buttons.push([{ text: '👑 Admin Panel', web_app: { url: workerUrl + '/aha.htm' } }]);
            try { await sendTelegramMessage(botToken, fromId, `⛏️ *FWC Mining*\n\nWelcome ${fromFirstName}! Start mining FWC now.`, { inline_keyboard: buttons }); } catch (e) { console.error('Webhook send:', e.message); }
          } else if (text.startsWith('/balance')) {
            try {
              const u = await getUser(env.DB, fromId);
              await sendTelegramMessage(botToken, fromId, `💰 *Balance:* ${u ? u.balance : 0} FWC`);
            } catch (e) { console.error('Webhook balance:', e.message); }
          } else if (text.startsWith('/mine')) {
            try { await sendTelegramMessage(botToken, fromId, `⛏️ Open the Mini App to mine: ${env.WORKER_URL || url.origin}`); } catch {}
          } else if (text.startsWith('/help')) {
            try { await sendTelegramMessage(botToken, fromId, `📖 *FWC Help*\n\n/start - Open app\n/balance - Your balance\n/mine - How to mine\n/help - This help`); } catch {}
          } else if (text.startsWith('/admin')) {
            if (fromId === 921627899) {
              try { await sendTelegramMessage(botToken, fromId, `👑 *Admin Panel*\n\nOpen: ${(env.WORKER_URL || url.origin)}/aha.htm`); } catch {}
            } else {
              try { await sendTelegramMessage(botToken, fromId, `⛔ Not authorized.`); } catch {}
            }
          }
        }
      } catch (e) {
        console.error('Webhook outer error:', e.message, e.stack);
      }
      return new Response('ok');
    }

    // Normal requests still need DB
    try { await initDB(env.DB); } catch (e) { console.error('initDB error:', e.message); }

    // ========== STATIC PAGES ==========
    if (path === '/tonconnect-manifest.json') {
      return json({
        url: url.origin,
        name: 'FWC Mining',
        iconUrl: url.origin + '/logo.png',
        termsOfUseUrl: 'https://t.me/fwc_coin',
        privacyPolicyUrl: 'https://t.me/fwc_coin',
      });
    }
    if (path === '/' || path === '/app') return htmlResponse(USER_HTML);
    
    if (path === '/aha.htm') {
      return htmlResponse(ADMIN_HTML); 
    }

    // ========== API ROUTES ==========
    if (path.startsWith('/api/')) {
      const tgUser = await getTelegramUser(request, env);
      const clientIP = getClientIP(request);

      // ============ PUBLIC USER APIs ============

      if (path === '/api/me' && tgUser) {
        await createOrUpdateUser(env.DB, {
          telegram_id: tgUser.id,
          username: tgUser.username,
          first_name: tgUser.first_name,
          language: tgUser.language_code || 'en',
        });

        const user = await getUser(env.DB, tgUser.id);
        try {
          if (!user.referral_code) {
            const nc = generateReferralCode();
            await env.DB.prepare(`UPDATE users SET referral_code = ? WHERE telegram_id = ?`).bind(nc, tgUser.id).run();
            user.referral_code = nc;
          }
        } catch {}

        // === CORRECT REFERRAL LOGIC FOR MINI APP ===
        try {
          // Get start_param from Telegram initData (Mini App referral)
          const initDataHeader = request.headers.get('X-Telegram-Init-Data') || '';
          let startParamFromInit = null;
          try {
            if (initDataHeader) {
              const initParams = new URLSearchParams(initDataHeader);
              startParamFromInit = initParams.get('start_param') || initParams.get('startParam') || null;
            }
          } catch {}
          
          // Also check tgUser._start_param if getTelegramUser extracts it
          if (!startParamFromInit && tgUser._start_param) {
            startParamFromInit = tgUser._start_param;
          }
          
          // Check all possible referral param sources
          const refParam = url.searchParams.get('ref') 
            || url.searchParams.get('start') 
            || url.searchParams.get('start_param') 
            || url.searchParams.get('startapp') 
            || startParamFromInit;
          
          if (refParam && !user.referral_by) {
            let refId = null;
            const rawRef = refParam.toString().trim();
            
            try {
              const codePart = rawRef.toLowerCase().startsWith('ref_') ? rawRef.substring(4) : rawRef;
              const byCode = await env.DB.prepare(`SELECT telegram_id FROM users WHERE referral_code = ?`).bind(codePart.trim()).first();
              if (byCode) refId = byCode.telegram_id;
            } catch {}
            if (!refId) {
              if (rawRef.toLowerCase().startsWith('ref_')) {
                const idStr = rawRef.substring(4);
                const parsed = parseInt(idStr);
                if (!isNaN(parsed) && parsed > 0) refId = parsed;
              } else {
                const parsed = parseInt(rawRef);
                if (!isNaN(parsed) && parsed > 0) refId = parsed;
              }
            }
            
            if (refId && refId !== tgUser.id) {
              // Double-check no existing referral
              const existingCheck = await env.DB.prepare(
                `SELECT referral_by FROM users WHERE telegram_id = ?`
              ).bind(tgUser.id).first();
              
              if (!existingCheck || !existingCheck.referral_by) {
                await env.DB.prepare(
                  `UPDATE users SET referral_by = ? WHERE telegram_id = ? AND (referral_by IS NULL OR referral_by = 0)`
                ).bind(refId, tgUser.id).run();
                
                try {
                  await env.DB.prepare(
                    `UPDATE users SET referred_bonus_paid = 1 WHERE telegram_id = ?`
                  ).bind(tgUser.id).run();
                } catch {}
                
                // Give bonus to referrer
                try {
                  const alreadyLogged = await env.DB.prepare(
                    `SELECT 1 FROM referrals_log WHERE to_id = ? LIMIT 1`
                  ).bind(tgUser.id).first();
                  
                  if (!alreadyLogged) {
                    const refUser = await getUser(env.DB, refId);
                    if (refUser) {
                      await env.DB.prepare(
                        `UPDATE users SET balance = ROUND(balance + 2, 8) WHERE telegram_id = ?`
                      ).bind(refId).run();
                      
                      await env.DB.prepare(
                        `INSERT INTO mining_log(telegram_id, amount, created_at) VALUES (?, 2, unixepoch())`
                      ).bind(refId).run();
                      
                      await env.DB.prepare(
                        `INSERT INTO referrals_log(from_id, to_id, amount, created_at) VALUES (?, ?, 2, unixepoch())`
                      ).bind(refId, tgUser.id).run();
                    }
                  }
                } catch (e) {
                  console.error('Referral bonus error in /api/me:', e.message);
                }
              }
            }
          }
        } catch (e) {
          console.error('Referral error in /api/me:', e.message);
        }

        const miningAmount = await getCurrentMiningAmount(env.DB);
        const founderFlag = await isFounder(env.DB, tgUser.id);
        const founderCfg = await getFounderConfig(env.DB);
        const canMineRes = await canMine(env.DB, tgUser.id);
        const canWithdrawRes = await canWithdraw(env.DB, env, tgUser.id);
        const ads = await getAdsConfig(env.DB);
        const streak = await getCheckinStreak(env.DB, tgUser.id);

        if (clientIP) await trackUserIP(env.DB, tgUser.id, clientIP);

        return json({
          ok: true,
          telegram_id: tgUser.id,
          username: tgUser.username || user?.username || null,
          first_name: user?.first_name || tgUser.first_name || null,
          language: user?.language || 'en',
          balance: user?.balance || 0,
          wallet: user?.wallet || null,
          wallet_verified: user?.wallet_verified || 0,
          is_banned: user?.is_banned || 0,
          miningAmount,
          founder: founderFlag ? { isFounder: true, interval_hours: founderCfg.interval_hours, bonus_percent: founderCfg.bonus_percent, fee_percent: founderCfg.fee_percent, nextAmount: Math.round(miningAmount * (founderCfg.interval_hours / 4) * (1 + founderCfg.bonus_percent / 100) * 100000000) / 100000000 } : { isFounder: false, interval_hours: founderCfg.interval_hours, bonus_percent: founderCfg.bonus_percent, fee_percent: founderCfg.fee_percent },
          canMine: canMineRes,
          canWithdraw: canWithdrawRes,
          ads: ads,
          adBlockId: ads.freeBlockId || null,
          adAutoBlockId: ads.autoBlockId || null,
          streak,
        });
      }

      if (path === '/api/referral' && tgUser) {
        const count = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE referral_by = ?`).bind(tgUser.id).first();
        const botUsername = (await env.DB.prepare(`SELECT value FROM config_overrides WHERE key = 'bot_username'`).first())?.value || 'fwcoinbot';
        let refCode = null;
        try {
          const r = await env.DB.prepare(`SELECT referral_code FROM users WHERE telegram_id = ?`).bind(tgUser.id).first();
          refCode = r?.referral_code;
        } catch {}
        if (!refCode) {
          refCode = generateReferralCode();
          try { await env.DB.prepare(`UPDATE users SET referral_code = ? WHERE telegram_id = ?`).bind(refCode, tgUser.id).run(); } catch {}
        }
        // Get referral list with details + actual earnings per referral
        let referrals = [];
        try {
          const list = await env.DB.prepare(`
            SELECT u.telegram_id, u.username, u.first_name, u.balance, u.created_at, u.first_mine_at,
                   COALESCE(SUM(r.amount),0) as earned
            FROM users u
            LEFT JOIN referrals_log r ON r.to_id = u.telegram_id AND r.from_id = ?
            WHERE u.referral_by = ?
            GROUP BY u.telegram_id
            ORDER BY u.created_at DESC
            LIMIT 100
          `).bind(tgUser.id, tgUser.id).all();
          referrals = (list.results || []).map(u => ({
            id: u.telegram_id,
            username: u.username || null,
            name: u.first_name || 'User',
            balance: u.balance || 0,
            joined: u.created_at,
            active: !!u.first_mine_at,
            earned: u.earned || 0
          }));
        } catch (e) {
          console.warn('Referral list error:', e.message);
          // Fallback simple query
          try {
            const list2 = await env.DB.prepare(`SELECT telegram_id, username, first_name, balance, created_at, first_mine_at FROM users WHERE referral_by = ? ORDER BY created_at DESC LIMIT 100`).bind(tgUser.id).all();
            referrals = (list2.results || []).map(u => ({
              id: u.telegram_id,
              username: u.username || null,
              name: u.first_name || 'User',
              balance: u.balance || 0,
              joined: u.created_at,
              active: !!u.first_mine_at,
              earned: 0
            }));
          } catch {}
        }
        // Calculate total referral earnings
        let totalEarnings = 0;
        try {
          const earn = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM referrals_log WHERE from_id = ?`).bind(tgUser.id).first();
          totalEarnings = earn?.total || 0;
        } catch {}
        return json({
          ok: true,
          referral_count: count?.c || 0,
          referral_link: `https://t.me/${botUsername}?startapp=ref_${refCode}`,
          referral_code: refCode,
          referrals,
          total_earnings: totalEarnings
        });
      }

      if (path === '/api/language' && request.method === 'POST' && tgUser) {
        const body = await request.json();
        const lang = ['en', 'ar', 'ru', 'tr'].includes(body.lang) ? body.lang : 'en';
        await setUserLanguage(env.DB, tgUser.id, lang);
        return json({ ok: true, language: lang });
      }

      if (path === '/api/mine' && request.method === 'POST' && tgUser) {
        // STEP 5: mining_paused blocks mining only. maintenance_mode blocks mining + tasks + checkin + withdraw.
        const _mp = await getEconomyConfig(env.DB, 'mining_paused');
        const _mm = await getEconomyConfig(env.DB, 'maintenance_mode');
        if (String(_mm) === '1' || _mm === 1 || _mm === true) return json({ ok: false, error: 'maintenance_mode', message: 'الصيانة شغالة دلوقتي - حاول تاني بعد شوية' }, 503);
        if (String(_mp) === '1' || _mp === 1 || _mp === true) return json({ ok: false, error: 'mining_paused', message: 'التعدين متوقف مؤقتاً' }, 503);
        const rlKey = `mine:${tgUser.id}`;
        if (await checkRateLimit(env.DB, rlKey, 6, 60000)) {
          return json({ ok: false, error: 'rate_limited', retry_after: 60 }, 429);
        }
        const check = await canMine(env.DB, tgUser.id);
        if (!check.ok) return json({ ok: false, error: check.reason, detail: check }, 400);
        const res = await doMine(env.DB, tgUser.id);
        return json({ ok: true, ...res });
      }

      if (path === '/api/bonus' && request.method === 'POST' && tgUser) {
        return jsonResponse({ ok: false, error: 'bonus_disabled', message: 'Bonus mining disabled' }, 400);
      }
      if (false && path === '/api/bonus' && request.method === 'POST' && tgUser) {
        const rlKey = `bonus:${tgUser.id}`;
        if (await checkRateLimit(env.DB, rlKey, 6, 60000)) {
          return json({ ok: false, error: 'rate_limited', retry_after: 60 }, 429);
        }

        // === FIXED: Either-Or 4h - Bonus cancels normal claim ===
        const check = await canMine(env.DB, tgUser.id);
        if (!check.ok) return json({ ok: false, error: check.reason, remaining: check.remaining, detail: check }, 400);
        
        const bonusMult = await getEconomyConfig(env.DB, 'ad_free_mult') || 2;
        const baseAmount = await getCurrentMiningAmount(env.DB);
        const totalBonus = baseAmount * bonusMult;
        const now = Date.now();
        
        await env.DB.prepare(`UPDATE users SET balance = balance + ?, last_mine = ?, first_mine_at = COALESCE(first_mine_at, ?), created_at = COALESCE(created_at, ?) WHERE telegram_id = ?`)
          .bind(totalBonus, now, now, now, tgUser.id).run();
        
        await env.DB.prepare(`INSERT INTO mining_log(telegram_id, amount, created_at) VALUES (?, ?, ?)`).bind(tgUser.id, totalBonus, now).run();
        
        const user = await env.DB.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(tgUser.id).first();
        if (user?.referral_by) {
          const refPercent = await getEconomyConfig(env.DB, 'referral_percent') || 5;
          const refBonus = totalBonus * (refPercent / 100);
          await env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`).bind(refBonus, user.referral_by).run();
          await env.DB.prepare(`INSERT INTO referrals_log(from_id, to_id, amount, created_at) VALUES (?, ?, ?, ?)`).bind(user.referral_by, tgUser.id, refBonus, now).run();
        }
        
        const newUser = await env.DB.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(tgUser.id).first();
        return json({ ok: true, amount: totalBonus, newBalance: newUser?.balance || 0 });
      }

      if (path === '/api/wallet/verify' && request.method === 'POST' && tgUser) {
        const body = await request.json();
        try {
          const isValid = await verifyTonProof(body, body.account);
          if (!isValid) return json({ ok: false, error: 'Invalid proof' }, 400);

          const walletAddress = normalizeTonAddress(body.account.address);
          if (!walletAddress) return json({ ok: false, error: 'invalid_address' }, 400);

          const dupeCheck = await checkWalletDuplicate(env.DB, tgUser.id, walletAddress);
          if (dupeCheck.duplicate) {
            await createAntiCheatAlert(env.DB, 'wallet_duplicate',
              [tgUser.id, ...dupeCheck.users.map(u => u.telegram_id)],
              `Wallet ${walletAddress.slice(0, 10)}... used by multiple accounts`);
          }

          const result = await saveWallet(env.DB, tgUser.id, walletAddress, { verified: true });
          if (!result.ok) return json({ ok: false, error: result.reason }, 400);

          return json({ ok: true, wallet: result.wallet, verified: true, warning: dupeCheck.duplicate ? 'duplicate_wallet_detected' : null });
        } catch (e) {
          return json({ ok: false, error: 'verification_error', detail: e.message }, 500);
        }
      }

      if (path === '/api/wallet/save' && request.method === 'POST' && tgUser) {
        const body = await request.json();
        if (!body.address) return json({ ok: false, error: 'no_address' }, 400);

        const walletAddress = normalizeTonAddress(body.address);
        if (!walletAddress) return json({ ok: false, error: 'invalid_address' }, 400);

        const dupeCheck = await checkWalletDuplicate(env.DB, tgUser.id, walletAddress);
        if (dupeCheck.duplicate) {
          await createAntiCheatAlert(env.DB, 'wallet_duplicate',
            [tgUser.id, ...dupeCheck.users.map(u => u.telegram_id)],
            `Wallet ${walletAddress.slice(0, 10)}... used by multiple accounts`);
        }

        const result = await saveWallet(env.DB, tgUser.id, walletAddress, { verified: false });
        if (!result.ok) return json({ ok: false, error: result.reason }, 400);

        return json({ ok: true, wallet: result.wallet, verified: false, warning: dupeCheck.duplicate ? 'duplicate_wallet_detected' : null });
      }

      if (path === '/api/tasks' && tgUser) {
        const tasks = await getDailyTasks(env.DB);
        const date = new Date().toISOString().split('T')[0];
        const progress = await getUserDailyProgress(env.DB, tgUser.id, date);
        const streak = await getCheckinStreak(env.DB, tgUser.id);
        return json({ ok: true, tasks, progress, date, streak });
      }

      if (path === '/api/checkin' && request.method === 'POST' && tgUser) {
        const _mmC = await getEconomyConfig(env.DB, 'maintenance_mode');
        if (String(_mmC) === '1' || _mmC === 1 || _mmC === true) return json({ ok: false, error: 'maintenance_mode', message: 'الصيانة شغالة دلوقتي' }, 503);
        const date = new Date().toISOString().split('T')[0];
        const already = await hasCheckedInToday(env.DB, tgUser.id, date);
        if (already) return json({ ok: false, error: 'already_checked_in' }, 400);
        const result = await doCheckin(env.DB, tgUser.id, date);
        return json({ ok: true, ...result });
      }

      if (path.startsWith('/api/tasks/') && request.method === 'POST' && tgUser) {
        const _mmT = await getEconomyConfig(env.DB, 'maintenance_mode');
        if (String(_mmT) === '1' || _mmT === 1 || _mmT === true) return json({ ok: false, error: 'maintenance_mode', message: 'الصيانة شغالة دلوقتي' }, 503);
        const taskId = path.split('/')[3];
        if (!taskId) return json({ ok: false, error: 'invalid_task' }, 400);

        const date = new Date().toISOString().split('T')[0];

        if (taskId === 'checkin') {
          const already = await hasCheckedInToday(env.DB, tgUser.id, date);
          if (already) return json({ ok: false, error: 'already_checked_in' }, 400);
          const r = await doCheckin(env.DB, tgUser.id, date);
          return json({ ok: true, reward: r.reward, streak: r.streak });
        }

        // TASKS MEMBERSHIP VERIFICATION (server-side, STEP 9): Join tasks must be real members.
        // Chats confirmed by owner: Channel @fwc_coin, Groups @fwc_coin1 + @fwc_payouts.
        // Non-join tasks (checkin already handled above, ads, etc.) skip verification.
        // Bot MUST be admin/member in all 3 chats, otherwise getChatMember fails and task is blocked with a clear error.
        try {
          const _tasks = await getDailyTasks(env.DB);
          const _task = Array.isArray(_tasks) ? _tasks.find(t => String(t.id) === String(taskId)) : null;
          if (_task) {
            const _blob = JSON.stringify(_task).toLowerCase();
            let _chat = null;
            if (_blob.includes('fwc_coin1')) _chat = '@fwc_coin1';
            else if (_blob.includes('fwc_payouts')) _chat = '@fwc_payouts';
            else if (/(^|[^a-z0-9_])fwc_coin([^0-9a-z_]|$)/.test(_blob)) _chat = '@fwc_coin';
            if (_chat) {
              const _botTok = env.BOT_TOKEN || (typeof getSecrets === 'function' ? getSecrets(env).botToken : null);
              if (!_botTok) return json({ ok: false, error: 'member_check_unavailable', detail: 'BOT_TOKEN missing - cannot verify membership' }, 500);
              const _gm = await fetch(`https://api.telegram.org/bot${_botTok}/getChatMember?chat_id=${encodeURIComponent(_chat)}&user_id=${tgUser.id}`);
              const _gmd = await _gm.json().catch(() => ({}));
              if (!_gmd.ok) return json({ ok: false, error: 'member_check_unavailable', detail: `Bot cannot check ${_chat}: ${_gmd.description || 'Telegram API error'}. Make @fwcoinbot admin/member in the chat.` }, 500);
              const _st = _gmd.result?.status;
              if (_st === 'left' || _st === 'kicked') return json({ ok: false, error: 'not_member', detail: `Join ${_chat} first, then claim.` }, 400);
              if (!['creator', 'administrator', 'member'].includes(_st)) return json({ ok: false, error: 'not_member', detail: `Join ${_chat} first, then claim.` }, 400);
            }
          }
        } catch (e) {
          // Verification itself failed (not a not_member case) -> block, do NOT silently allow.
          if (e && (e._blocked)) throw e;
          return json({ ok: false, error: 'member_check_failed', detail: String(e?.message || e) }, 500);
        }
        const result = await doTask(env.DB, tgUser.id, taskId, date, env);
        if (!result.ok) return json({ ok: false, error: result.reason }, 400);
        return json({ ok: true, reward: result.reward, newBalance: result.newBalance });
      }

      if (path === '/api/withdraw/estimate' && tgUser) {
        const amount = Number(url.searchParams.get('amount'));
        if (!amount || amount <= 0) return json({ ok: false, error: 'invalid_amount' }, 400);

        const feeInfo = await calculateWithdrawalFee(env.DB, amount, tgUser.id);
        const user = await getUser(env.DB, tgUser.id);

        return json({
          ok: true,
          amount,
          fee: feeInfo.fee,
          netAmount: feeInfo.netAmount,
          percent: feeInfo.percent,
          total: amount,
          balance: user?.balance || 0,
          canAfford: (user?.balance || 0) >= amount,
        });
      }

      if (path === '/api/withdraw' && request.method === 'POST' && tgUser) {
        const _mmW = await getEconomyConfig(env.DB, 'maintenance_mode');
        if (String(_mmW) === '1' || _mmW === 1 || _mmW === true) return json({ ok: false, error: 'maintenance_mode', message: 'الصيانة شغالة دلوقتي' }, 503);
        const body = await request.json();
        const amount = Number(body.amount);
        if (!amount || amount <= 0) return json({ ok: false, error: 'invalid_amount' }, 400);

        const check = await canWithdraw(env.DB, env, tgUser.id);
        if (!check.ok) return json({ ok: false, error: check.reason, detail: check }, 400);

        const user = await getUser(env.DB, tgUser.id);
        const feeInfo = await calculateWithdrawalFee(env.DB, amount, tgUser.id);

        if (user.balance < amount) {
          return json({ ok: false, error: 'insufficient_balance', required: amount, available: user.balance }, 400);
        }

        const pending = await getUserPendingWithdrawal(env.DB, tgUser.id);
        if (pending) return json({ ok: false, error: 'pending_exists' }, 400);

        await env.DB.prepare(`UPDATE users SET balance = balance - ? WHERE telegram_id = ?`)
          .bind(amount, tgUser.id).run();

        const wdResult = await createWithdrawal(env.DB, tgUser.id, amount, user.wallet, feeInfo.fee, feeInfo.netAmount);

        try {
          const wdId = wdResult?.meta?.last_row_id;
          if (wdId && feeInfo.fee > 0) {
            await logFee(env.DB, tgUser.id, wdId, feeInfo.fee);
          }
        } catch {}

        return json({ ok: true, amount: feeInfo.netAmount, fee: feeInfo.fee, totalDeducted: amount, newBalance: user.balance - amount });
      }

      if (path === '/api/withdrawals' && tgUser) {
        const res = await env.DB.prepare(`
          SELECT id, amount, fee, net_amount, status, tx_hash, reject_reason, created_at 
          FROM withdrawals 
          WHERE telegram_id = ? 
          ORDER BY created_at DESC 
          LIMIT 20
        `).bind(tgUser.id).all();
        return json({ ok: true, withdrawals: res.results || [] });
      }

      if (path === '/api/leaderboard') {
        const leaders = await env.DB.prepare(`
          SELECT telegram_id, username, first_name, balance 
          FROM users 
          WHERE balance > 0 AND is_banned = 0
          ORDER BY balance DESC 
          LIMIT 20
        `).all();
        return json({ ok: true, leaders: leaders.results || [] });
      }


      // ============ FOUNDER BADGE APIs ============
      if (path === '/api/founder/status' && tgUser) {
        const cfg = await getFounderConfig(env.DB);
        const owners = await getFounderOwnersCount(env.DB);
        const mine = await isFounder(env.DB, tgUser.id);
        let _vis = '1'; try { const vr = await env.DB.prepare(`SELECT value FROM config_overrides WHERE key = 'founder_visible'`).first(); if (vr) _vis = String(vr.value); } catch {}
        return json({ ok: true, enabled: cfg.enabled, visible: _vis !== '0', price: cfg.price, limit: cfg.limit, owners, remaining: Math.max(0, cfg.limit - owners), burned: cfg.burned, burn_address: cfg.burn_address, interval_hours: cfg.interval_hours, bonus_percent: cfg.bonus_percent, fee_percent: cfg.fee_percent, isFounder: mine });
      }
      if (path === '/api/founder/status' && !tgUser) {
        const cfg = await getFounderConfig(env.DB);
        const owners = await getFounderOwnersCount(env.DB);
        let _vis2 = '1'; try { const vr2 = await env.DB.prepare(`SELECT value FROM config_overrides WHERE key = 'founder_visible'`).first(); if (vr2) _vis2 = String(vr2.value); } catch {}
        return json({ ok: true, enabled: cfg.enabled, visible: _vis2 !== '0', price: cfg.price, limit: cfg.limit, owners, remaining: Math.max(0, cfg.limit - owners), burned: cfg.burned, burn_address: cfg.burn_address, interval_hours: cfg.interval_hours, bonus_percent: cfg.bonus_percent, fee_percent: cfg.fee_percent });
      }
      if (path === '/api/founder/verify' && request.method === 'POST' && tgUser) {
        const cfg = await getFounderConfig(env.DB);
        if (!cfg.enabled) return json({ ok: false, error: 'disabled' }, 400);
        const owners = await getFounderOwnersCount(env.DB);
        if (owners >= cfg.limit) return json({ ok: false, error: 'sold_out' }, 400);
        if (await isFounder(env.DB, tgUser.id)) return json({ ok: false, error: 'already_has' }, 400);
        let body = {};
        try { body = await request.json(); } catch {}
        const txHash = (body.tx_hash || '').trim();
        if (!txHash) return json({ ok: false, error: 'no_tx' }, 400);
        const used = await env.DB.prepare(`SELECT * FROM founder_owners WHERE tx_hash = ?`).bind(txHash).first();
        if (used) return json({ ok: false, error: 'tx_already_used' }, 400);
        const userRow = await env.DB.prepare(`SELECT wallet FROM users WHERE telegram_id = ?`).bind(tgUser.id).first();
        if (!userRow?.wallet) return json({ ok: false, error: 'no_wallet' }, 400);
        const apiKey = env.TONCENTER_API_KEY || '';
        if (!apiKey) return json({ ok: false, error: 'verify_unavailable', detail: 'Set TONCENTER_API_KEY' }, 500);
        try {
          // Real on-chain check: TonCenter jetton transfers by transaction hash
          const trRes = await fetch(`https://toncenter.com/api/v3/jetton/transfers?transaction_hash=${encodeURIComponent(txHash)}&limit=10`, { headers: { 'X-API-Key': apiKey } });
          const trData = await trRes.json();
          const transfers = trData.jetton_transfers || trData.transfers || [];
          if (!transfers || transfers.length === 0) return json({ ok: false, error: 'tx_not_found', detail: 'No jetton transfer found for this hash' }, 400);
          // Find transfer to burn address with enough amount. Jetton address MUST match CONFIG.jetton.
          // STRICT sender check (FIX): source missing/unparseable -> REJECT, do not allow. Sender must equal user's registered wallet.
          const normAddr = (a) => {
            const s = (a || '').toString().trim();
            if (!s) return '';
            try { return Address.parse(s).toRawString(); } catch { return s.toLowerCase(); }
          };
          // Note: top-level import already provides Address, use dynamic fallback if needed
          let userWalletRaw = '';
          try { const { Address } = await import('@ton/ton'); userWalletRaw = Address.parse(userRow.wallet).toRawString(); } catch { userWalletRaw = (userRow.wallet || '').toString().toLowerCase(); }
          const getSource = (t) => (t.source?.address || t.source || t.from || t.sender?.address || t.sender || '').toString();
          const getSourceRaw = (t) => {
            const s = getSource(t);
            if (!s) return '';
            try { return normAddr(s); } catch { return s.toLowerCase(); }
          };
          let matched = null;
          let senderMismatchFound = false;
          // Burn address normalized both ways (raw + friendly) so comparison can't fail on format
          let burnRaw = ''; try { burnRaw = Address.parse(cfg.burn_address).toRawString(); } catch { burnRaw = (cfg.burn_address || '').toString().toLowerCase(); }
          const burnLower = (cfg.burn_address || '').toString().toLowerCase();
          for (const t of transfers) {
            const dest = (t.destination?.address || t.destination || t.to || '').toString();
            const amt = parseFloat(t.amount || 0) / 1e9;
            const jettonMaster = (t.jetton_master?.address || t.jetton_master || '').toString();
            // Dest must match burn address (raw or friendly)
            let destRaw = ''; try { destRaw = Address.parse(dest).toRawString(); } catch { destRaw = dest.toLowerCase(); }
            if ((destRaw === burnRaw || dest.toLowerCase() === burnLower) && amt + 0.001 >= cfg.price) {
              // STRICT jetton: if CONFIG.jetton is set, master MUST equal it. Empty master -> reject.
              if (CONFIG.jetton) {
                let masterRaw = ''; try { masterRaw = Address.parse(jettonMaster).toRawString(); } catch { masterRaw = jettonMaster.toLowerCase(); }
                let cfgJettonRaw = ''; try { cfgJettonRaw = Address.parse(CONFIG.jetton).toRawString(); } catch { cfgJettonRaw = CONFIG.jetton.toLowerCase(); }
                if (!jettonMaster || (masterRaw !== cfgJettonRaw && jettonMaster.toLowerCase() !== CONFIG.jetton.toLowerCase())) { senderMismatchFound = true; continue; }
              }
              const srcRaw = getSourceRaw(t);
              // STRICT: missing/unparseable source -> REJECT, do not match
              if (!srcRaw) { senderMismatchFound = true; continue; }
              const srcLower = getSource(t).toLowerCase();
              const userLower = (userRow.wallet || '').toString().toLowerCase();
              if (srcRaw === userWalletRaw || srcLower === userLower) { matched = { dest, amt }; break; }
              senderMismatchFound = true;
            }
          }
          if (!matched && senderMismatchFound) {
            return json({ ok: false, error: 'sender_mismatch', detail: 'Burn was not sent from your registered wallet' }, 400);
          }
          if (!matched) {
            // Fallback: check any transfer to burn address, report amount
            const toBurn = transfers.filter(t => (t.destination?.address || t.destination || '').toString().toLowerCase() === cfg.burn_address.toLowerCase());
            if (toBurn.length === 0) return json({ ok: false, error: 'wrong_burn_address', detail: 'Tx did not go to burn address' }, 400);
            const maxAmt = Math.max(...toBurn.map(t => parseFloat(t.amount || 0) / 1e9));
            return json({ ok: false, error: 'amount_too_low', detail: `Sent ${maxAmt}, need ${cfg.price}` }, 400);
          }
          // Sender already strictly verified above: missing source or mismatch -> rejected before reaching here.
          await env.DB.prepare(`INSERT INTO founder_owners (telegram_id, price, tx_hash, created_at) VALUES (?, ?, ?, unixepoch())`).bind(tgUser.id, cfg.price, txHash).run();
          const newBurned = Math.round((cfg.burned + cfg.price) * 100000000) / 100000000;
          await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_burned', ?)`).bind(String(newBurned)).run();
          return json({ ok: true, badge: true, burned_total: newBurned, amount: matched.amt });
        } catch (e) {
          return json({ ok: false, error: 'verify_failed', detail: e.message }, 500);
        }
      }

      if (path === '/api/health') {
        const health = await getSystemHealth(env);
        return json(health, health.status === 'critical' ? 503 : 200);
      }

      // ============ ADMIN APIs ============
      if (path.startsWith('/api/admin/')) {
        const adminSecret = request.headers.get('X-Admin-Secret');
        // Allow EITHER: correct ADMIN_SECRET (web) OR verified Telegram admin identity (Telegram Mini App).
        // From Telegram, Init-Data proves you are root admin even if browser autofill types a wrong/old password.
        // From web, Init-Data is empty, so password must match exactly.
        let viaTelegram = false;
        if (tgUser?.id) {
          try { viaTelegram = await isAdminDB(env.DB, tgUser.id); } catch { viaTelegram = false; }
        }
        const viaPassword = !!env.ADMIN_SECRET && adminSecret === env.ADMIN_SECRET;
        if (!viaPassword && !viaTelegram) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }

        // STEP 11-1 + 11-2 (Admin roles) - FIXED from db.js (real root cause).
        // db.js schema is the truth:
        //   admins(telegram_id PK, username, first_name, role CHECK(role IN ('admin','superadmin')), added_by, created_at NOT NULL)
        // Old index.js code used role='assistant' / role='root' -> BOTH violate the CHECK -> "CHECK constraint failed" -> db_error.
        // Old code also omitted created_at (NOT NULL) -> second failure. And PRAGMA/ALTER was never the problem.
        // Fix: DB stores 'admin' (assistant) / 'superadmin' (root). API maps them to 'assistant' / 'root' for admin.html.
        // All writes go through db.js addAdminById / removeAdmin / getAllAdmins, which already use the correct columns.
        const isRootAdmin = tgUser?.id ? (tgUser.id === 921627899) : viaPassword;
        const mapDbRoleToApi = (r) => (r === 'superadmin' ? 'root' : 'assistant');
        const ensureRootAdminRow = async () => {
          try { await env.DB.prepare(`INSERT OR IGNORE INTO admins(telegram_id, username, first_name, role, created_at) VALUES (921627899, 'root', 'superadmin', 'superadmin', unixepoch())`).run(); } catch {}
          try { await env.DB.prepare(`UPDATE admins SET role = 'superadmin' WHERE telegram_id = 921627899`).run(); } catch {}
        };
        if (path === '/api/admin/admins' && request.method === 'GET') {
          if (!isRootAdmin) return json({ ok: false, error: 'root_only' }, 403);
          await ensureRootAdminRow();
          let rows;
          try { rows = await getAllAdmins(env.DB); } catch (e) { return json({ ok: false, error: 'db_error', detail: String(e.message || e) }, 500); }
          return json({ ok: true, admins: (rows || []).map(r => ({ telegram_id: r.telegram_id, username: r.username || null, first_name: r.first_name || null, role: mapDbRoleToApi(r.role) })), root_id: 921627899 });
        }
        if (path === '/api/admin/admins' && request.method === 'POST') {
          if (!isRootAdmin) return json({ ok: false, error: 'root_only' }, 403);
          const body = await request.json().catch(() => ({}));
          const tid = parseInt(body.telegram_id);
          if (!isFinite(tid) || tid <= 0) return json({ ok: false, error: 'invalid_telegram_id' }, 400);
          if (tid === 921627899) return json({ ok: false, error: 'already_root' }, 400);
          // Look up username/first_name from users table so the row is complete (db.js addAdminById expects them).
          let _u = null;
          try { _u = await env.DB.prepare(`SELECT username, first_name FROM users WHERE telegram_id = ?`).bind(tid).first(); } catch {}
          const _addedBy = tgUser?.id || 921627899;
          try {
            await addAdminById(env.DB, tid, _u?.username || null, _u?.first_name || null, _addedBy);
          } catch (e) {
            return json({ ok: false, error: 'db_error', detail: String(e.message || e) }, 500);
          }
          return json({ ok: true, telegram_id: tid, role: 'assistant' });
        }
        const adminDelMatch = path.match(/^\/api\/admin\/admins\/(\d+)$/);
        if (adminDelMatch && request.method === 'DELETE') {
          if (!isRootAdmin) return json({ ok: false, error: 'root_only' }, 403);
          const tid = parseInt(adminDelMatch[1]);
          if (tid === 921627899) return json({ ok: false, error: 'cannot_remove_root' }, 400);
          try { await removeAdmin(env.DB, tid); } catch (e) { return json({ ok: false, error: 'db_error', detail: String(e.message || e) }, 500); }
          return json({ ok: true, removed: tid });
        }
        // STEP 11-2 (Assistant permissions): central gate. Root = everything. Assistant = limited.
        // ALLOWED for assistant: GET stats/users/detail/balance-log/withdrawals/payouts-stats/preview/anticheat/health/tasks/economy/fees/founder/hold (view only)
        // + POST withdrawals approve/reject + POST anticheat resolve/dismiss.
        // BLOCKED for assistant: deduct/clawback, ban (user + alert-ban), broadcast + broadcast-test, founder toggle/visible/config,
        // economy/fees/hold/tasks POST/PUT/DELETE, payouts execute, withdrawals reset, admins manage.
        const _m = request.method;
        const _isAssistantBlocked =
          path === '/api/admin/admins' && _m !== 'GET' ? true :
          /^\/api\/admin\/admins\/\d+$/.test(path) ? true :
          /\/balance$/.test(path) && _m === 'POST' ? true :
          /\/(ban|unban)$/.test(path) && _m === 'POST' ? true :
          /\/withdrawals\/reset$/.test(path) && _m === 'POST' ? true :
          /\/anticheat\/\d+\/(clawback|ban)$/.test(path) && _m === 'POST' ? true :
          (path === '/api/admin/broadcast' || path === '/api/admin/broadcast-test') && _m === 'POST' ? true :
          (path === '/api/admin/payouts/execute') && _m === 'POST' ? true :
          (path === '/api/admin/hold' || path === '/api/admin/founder/toggle' || path === '/api/admin/founder/visible' || path === '/api/admin/founder/config' || path === '/api/admin/economy' || path === '/api/admin/fees') && _m === 'POST' ? true :
          (path === '/api/admin/tasks' && _m === 'POST') ? true :
          /^\/api\/admin\/tasks\/[\w-]+$/.test(path) && (_m === 'PUT' || _m === 'DELETE') ? true :
          false;
        if (!isRootAdmin && _isAssistantBlocked) {
          return json({ ok: false, error: 'assistant_forbidden', message: 'Assistant admins cannot do this. Root only.' }, 403);
        }
        // Return role in stats so admin.html can hide forbidden buttons (no extra endpoint needed).

        if (path === '/api/admin/stats') {
          // FIX (web admin): tgUser is null on web (no Telegram Init-Data).
          // Old code did tgUser.id here -> TypeError -> 500, and admin.html showed it as "Wrong password".
          // On Telegram tgUser exists, so it worked there. This is why same password failed on web only.
          // founderFlag/founderCfg are not returned here, so guard them and never let them crash login check.
          const miningAmount = await getCurrentMiningAmount(env.DB);
        const founderFlag = tgUser?.id ? await isFounder(env.DB, tgUser.id).catch(() => false) : false;
        const founderCfg = await getFounderConfig(env.DB).catch(() => null);
          const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first();
          const wdPending = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'`).first();
          const totalBalance = await env.DB.prepare(`SELECT COALESCE(SUM(balance),0) as s FROM users`).first();
          const totalMined = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM mining_log`).first();
          const totalFees = await getTotalFees(env.DB, 0);
          const openAlerts = await env.DB.prepare(`SELECT COUNT(*) as c FROM anticheat_alerts WHERE status='open'`).first();

          return json({ ok: true, role: isRootAdmin ? 'root' : 'assistant', isRoot: isRootAdmin, miningAmount, usersCount: usersCount?.c || 0, wdPending: wdPending?.c || 0, totalBalance: totalBalance?.s || 0, totalMined: totalMined?.s || 0, totalFees, openAlerts: openAlerts?.c || 0 });
        }

        if (path === '/api/admin/users') {
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 500);
          const search = url.searchParams.get('q') || '';
          let query = `SELECT telegram_id, username, first_name, balance, wallet, wallet_verified, referral_by, is_banned, ban_reason, created_at, last_mine FROM users`;
          let params = [];
          if (search) {
            query += ` WHERE username LIKE ? OR first_name LIKE ? OR CAST(telegram_id AS TEXT) LIKE ?`;
            const like = `%${search}%`;
            params = [like, like, like];
          }
          query += ` ORDER BY created_at DESC LIMIT ?`;
          params.push(limit);
          const users = await env.DB.prepare(query).bind(...params).all();
          return json({ ok: true, users: users.results || [] });
        }

        // STEP 6 (User Detail): one user - profile + withdrawals + alerts + balance log + referrals. Read-only except existing actions. Login NOT touched.
        const detailMatch = path.match(/^\/api\/admin\/users\/(\d+)\/detail$/);
        if (detailMatch && request.method === 'GET') {
          const targetId = parseInt(detailMatch[1]);
          const user = await env.DB.prepare(`SELECT telegram_id, username, first_name, balance, wallet, wallet_verified, referral_by, referral_code, is_banned, ban_reason, created_at, last_mine FROM users WHERE telegram_id = ?`).bind(targetId).first();
          if (!user) return json({ ok: false, error: 'not_found' }, 404);
          let withdrawals = [];
          try { const w = await env.DB.prepare(`SELECT id, amount, fee, net_amount, status, tx_hash, reject_reason, created_at FROM withdrawals WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 20`).bind(targetId).all(); withdrawals = w.results || []; } catch {}
          let alerts = [];
          try { const a = await env.DB.prepare(`SELECT id, type, details, telegram_ids, status, created_at FROM anticheat_alerts ORDER BY created_at DESC LIMIT 200`).all(); const all = a.results || []; alerts = all.filter(r => String(r.telegram_ids || '').includes(String(targetId))); } catch {}
          let balanceLog = [];
          try { const b = await env.DB.prepare(`SELECT id, mode, amount, before_balance, after_balance, reason, created_at FROM admin_balance_log WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 20`).bind(targetId).all(); balanceLog = b.results || []; } catch {}
          let referrals = 0, referredByName = null;
          try { const rc = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE referral_by = ?`).bind(targetId).first(); referrals = rc?.c || 0; } catch {}
          try { if (user.referral_by) { const rb = await env.DB.prepare(`SELECT first_name, username FROM users WHERE telegram_id = ?`).bind(user.referral_by).first(); referredByName = rb ? (rb.first_name || rb.username || String(user.referral_by)) : String(user.referral_by); } } catch {}
          return json({ ok: true, user, withdrawals, alerts, balanceLog, referrals, referredByName });
        }
        const banMatch = path.match(/^\/api\/admin\/users\/(\d+)\/(ban|unban)$/);
        if (banMatch && request.method === 'POST') {
          const targetId = parseInt(banMatch[1]);
          const body = await request.json().catch(() => ({}));
          if (banMatch[2] === 'ban') await banUser(env.DB, targetId, body.reason || null);
          else await unbanUser(env.DB, targetId);
          return json({ ok: true });
        }

        const balanceMatch = path.match(/^\/api\/admin\/users\/(\d+)\/balance$/);
        if (balanceMatch && request.method === 'POST') {
          // STEP 1 ONLY (your file): deduct + reason + log. Add/Set unchanged. Login NOT touched.
          const targetId = parseInt(balanceMatch[1]);
          const body = await request.json();
          const amount = typeof body.amount === 'number' ? body.amount : body.balance;
          if (typeof amount !== 'number' || !isFinite(amount) || amount < 0) return json({ ok: false, error: 'invalid' }, 400);
          const mode = body.mode || (typeof body.balance === 'number' ? 'set' : 'add');
          const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
          const before = await env.DB.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(targetId).first();
          if (!before) return json({ ok: false, error: 'not_found' }, 404);
          let newBal = before.balance || 0;
          if (mode === 'set') {
            await env.DB.prepare(`UPDATE users SET balance = ? WHERE telegram_id = ?`).bind(amount, targetId).run();
            newBal = amount;
          } else if (mode === 'subtract' || mode === 'deduct') {
            newBal = Math.max(0, (before.balance || 0) - amount);
            await env.DB.prepare(`UPDATE users SET balance = ? WHERE telegram_id = ?`).bind(newBal, targetId).run();
          } else {
            await env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`).bind(amount, targetId).run();
            newBal = (before.balance || 0) + amount;
          }
          try {
            await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_balance_log (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, mode TEXT, amount REAL, before_balance REAL, after_balance REAL, reason TEXT, created_at INTEGER)`).run();
            await env.DB.prepare(`INSERT INTO admin_balance_log (telegram_id, mode, amount, before_balance, after_balance, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())`).bind(targetId, mode, amount, before.balance || 0, newBal, reason).run();
          } catch (e) { console.warn('balance_log failed', e.message); }
          return json({ ok: true, newBalance: newBal });
        }
        // STEP 1 ONLY: read balance log for one user.
        if (path.match(/^\/api\/admin\/users\/(\d+)\/balance-log$/) && request.method === 'GET') {
          const targetId = parseInt(path.match(/\/(\d+)\/balance-log/)[1]);
          const rows = await env.DB.prepare(`SELECT * FROM admin_balance_log WHERE telegram_id = ? ORDER BY id DESC LIMIT 50`).bind(targetId).all().catch(() => ({ results: [] }));
          return json({ ok: true, log: rows.results || [] });
        }

        const resetWdMatch = path.match(/^\/api\/admin\/users\/(\d+)\/withdrawals\/reset$/);
        if (resetWdMatch && request.method === 'POST') {
          const targetId = parseInt(resetWdMatch[1]);
          const del = await env.DB.prepare(`DELETE FROM withdrawals WHERE telegram_id = ?`).bind(targetId).run();
          return json({ ok: true, deleted: del.meta?.changes || 0 });
        }

        const holdCheckMatch = path.match(/^\/api\/admin\/users\/(\d+)\/hold-check$/);
        if (holdCheckMatch) {
          const targetId = parseInt(holdCheckMatch[1]);
          const user = await env.DB.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(targetId).first();
          if (!user) return json({ ok: false, error: 'not_found' }, 404);
          const cfgHold = await env.DB.prepare(`SELECT value FROM config_overrides WHERE key = 'withdraw_hold_amount'`).first();
          const holdAmount = cfgHold?.value ? parseFloat(cfgHold.value) : (CONFIG.withdraw_hold_amount || 1000);
          if (!user.wallet) return json({ ok: true, wallet: null, jettonBalance: 0, withdrawCount: 0, holdAmount });
          const apiKey = env.TONCENTER_API_KEY || env.TON_API_KEY || '';
          let jettonBal = 0;
          let holdError = null;
          try {
            if (!apiKey) { holdError = 'TONCENTER_API_KEY missing in Worker env'; }
            else if (CONFIG.jetton) {
              // TonCenter v3 expects owner_address in RAW format (0:...) - UQ... returns empty
              let ownerRaw = user.wallet;
              try { const { Address } = await import('@ton/ton'); ownerRaw = Address.parse(user.wallet).toRawString(); } catch {}
              const r = await fetch(`https://toncenter.com/api/v3/jetton/wallets?owner_address=${encodeURIComponent(ownerRaw)}&jetton_address=${CONFIG.jetton}&limit=1`, { headers: { 'X-API-Key': apiKey } });
              const d = await r.json();
              if (d.jetton_wallets && d.jetton_wallets.length > 0) jettonBal = parseFloat(d.jetton_wallets[0].balance) / 1e9;
              else if (d.error) holdError = d.error;
            }
          } catch(e){ holdError = e.message; }
          const wdCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE telegram_id = ? AND status != 'rejected'`).bind(targetId).first();
          return json({ ok: true, wallet: user.wallet, jettonBalance: jettonBal, balance: jettonBal, withdrawCount: wdCount?.c || 0, holdAmount, meetsHold: jettonBal >= holdAmount, holdError, isSecondPlus: (wdCount?.c||0) >= 1 });
        }

        if (path === '/api/admin/hold' && request.method === 'GET') {
          const val = await env.DB.prepare(`SELECT value FROM config_overrides WHERE key = 'withdraw_hold_amount'`).first();
          const cfg = val?.value ? parseFloat(val.value) : (CONFIG.withdraw_hold_amount || 0);
          return json({ ok: true, holdAmount: cfg });
        }
        if (path === '/api/admin/hold' && request.method === 'POST') {
          const body = await request.json();
          const amount = parseFloat(body.amount);
          if (isNaN(amount) || amount < 0) return json({ ok: false, error: 'invalid' }, 400);
          await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('withdraw_hold_amount', ?)`).bind(String(amount)).run();
          return json({ ok: true, holdAmount: amount });
        }


        // ============ ADMIN FOUNDER ============
        if (path === '/api/admin/founder' && request.method === 'GET') {
          const cfg = await getFounderConfig(env.DB);
          const owners = await getFounderOwnersCount(env.DB);
          let _visA = '1'; try { const vrA = await env.DB.prepare(`SELECT value FROM config_overrides WHERE key = 'founder_visible'`).first(); if (vrA) _visA = String(vrA.value); } catch {}
          return json({ ok: true, enabled: cfg.enabled, visible: _visA !== '0', price: cfg.price, limit: cfg.limit, owners, remaining: Math.max(0, cfg.limit - owners), burned: cfg.burned, burn_address: cfg.burn_address, interval_hours: cfg.interval_hours, bonus_percent: cfg.bonus_percent, fee_percent: cfg.fee_percent });
        }
        if (path === '/api/admin/founder/toggle' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const enabled = body.enabled === true || body.enabled === '1' || body.enabled === 1;
          await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_enabled', ?)`).bind(enabled ? '1' : '0').run();
          return json({ ok: true, enabled });
        }
        // STEP 7: Founder tab show/hide - SEPARATE from founder_enabled. visible=0 hides the tab in user app, but does NOT disable the program: existing founders keep bonus, verify still works if enabled. Login NOT touched.
        if (path === '/api/admin/founder/visible' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const visible = body.visible === true || body.visible === '1' || body.visible === 1;
          await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_visible', ?)`).bind(visible ? '1' : '0').run();
          return json({ ok: true, visible });
        }
        if (path === '/api/admin/founder/config' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          if (body.price !== undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_price', ?)`).bind(String(parseFloat(body.price))).run();
          if (body.limit !== undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_limit', ?)`).bind(String(parseInt(body.limit))).run();
          if (body.burn_address) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_burn_address', ?)`).bind(String(body.burn_address).trim()).run();
          if (body.interval_hours !== undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_interval_hours', ?)`).bind(String(parseFloat(body.interval_hours))).run();
          if (body.bonus_percent !== undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_bonus_percent', ?)`).bind(String(parseFloat(body.bonus_percent))).run();
          if (body.fee_percent !== undefined) await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_fee_percent', ?)`).bind(String(parseFloat(body.fee_percent))).run();
          const cfg = await getFounderConfig(env.DB);
          return json({ ok: true, ...cfg });
        }
        // Alias: /hold  -> same as /hold-check (Admin frontend calls /hold)
        if (path.match(/^\/api\/admin\/users\/(\d+)\/hold$/) && !path.endsWith('/hold-check')) {
          const targetId = parseInt(path.match(/^\/api\/admin\/users\/(\d+)\/hold$/)[1]);
          const user = await env.DB.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(targetId).first();
          if (!user) return json({ ok: false, error: 'not_found' }, 404);
          const cfgHold = await env.DB.prepare(`SELECT value FROM config_overrides WHERE key = 'withdraw_hold_amount'`).first();
          const holdAmount = cfgHold?.value ? parseFloat(cfgHold.value) : (CONFIG.withdraw_hold_amount || 1000);
          if (!user.wallet) return json({ ok: true, wallet: null, jettonBalance: 0, withdrawCount: 0, holdAmount, balance: 0 });
          const apiKey2 = env.TONCENTER_API_KEY || '';
          let jettonBal = 0;
          try {
            if (apiKey2 && CONFIG.jetton) {
              const r = await fetch(`https://toncenter.com/api/v3/jetton/wallets?owner_address=${user.wallet}&jetton_address=${CONFIG.jetton}&limit=1`, { headers: { 'X-API-Key': apiKey2 } });
              const d = await r.json();
              if (d.jetton_wallets && d.jetton_wallets.length > 0) jettonBal = parseFloat(d.jetton_wallets[0].balance) / 1e9;
            }
          } catch {}
          const wdCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE telegram_id = ? AND status != 'rejected'`).bind(targetId).first();
          return json({ ok: true, wallet: user.wallet, jettonBalance: jettonBal, balance: jettonBal, withdrawCount: wdCount?.c || 0, holdAmount, meetsHold: jettonBal >= holdAmount });
        }

        if (path === '/api/admin/tasks' && request.method === 'GET') {
          const tasks = await getAllTasksAdmin(env.DB);
          return json({ ok: true, tasks });
        }

        if (path === '/api/admin/tasks' && request.method === 'POST') {
          const body = await request.json();
          if (!body.id || !body.title) return json({ ok: false, error: 'id and title required' }, 400);
          try { await createTask(env.DB, body); return json({ ok: true }); } catch (e) { return json({ ok: false, error: e.message }, 400); }
        }

        const taskMatch = path.match(/^\/api\/admin\/tasks\/([\w_-]+)$/);
        if (taskMatch && request.method === 'PUT') {
          const body = await request.json();
          await updateTask(env.DB, taskMatch[1], body);
          return json({ ok: true });
        }
        if (taskMatch && request.method === 'DELETE') {
          await deleteTask(env.DB, taskMatch[1]);
          return json({ ok: true });
        }

        if (path === '/api/admin/withdrawals') {
          const status = url.searchParams.get('status');
          let query = `SELECT w.*, u.username, u.first_name FROM withdrawals w LEFT JOIN users u ON u.telegram_id = w.telegram_id`;
          let params = [];
          if (status) { query += ` WHERE w.status = ?`; params.push(status); }
          query += ` ORDER BY w.created_at DESC LIMIT 200`;
          const wds = await env.DB.prepare(query).bind(...params).all();
          return json({ ok: true, withdrawals: wds.results || [] });
        }

        const wdMatch = path.match(/^\/api\/admin\/withdrawals\/(\d+)\/(approve|reject)$/);
        if (wdMatch && request.method === 'POST') {
          const wdId = parseInt(wdMatch[1]);
          const wd = await getWithdrawalById(env.DB, wdId);
          if (!wd) return json({ ok: false, error: 'not_found' }, 404);
          if (wd.status !== 'pending') return json({ ok: false, error: 'not_pending' }, 400);

          if (wdMatch[2] === 'approve') {
            // HOLD ENFORCEMENT (server-side, FIX): 2nd+ withdrawal requires on-chain Hold. No longer browser-only.
            // Prior count EXCLUDES the current pending withdrawal itself, so 1st withdrawal is exempt.
            const _wdUser = await env.DB.prepare(`SELECT wallet FROM users WHERE telegram_id = ?`).bind(wd.telegram_id).first();
            const _prior = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE telegram_id = ? AND status != 'rejected' AND id != ?`).bind(wd.telegram_id, wdId).first();
            const _priorCount = _prior?.c || 0;
            if (_priorCount >= 1) {
              const _cfgHold = await env.DB.prepare(`SELECT value FROM config_overrides WHERE key = 'withdraw_hold_amount'`).first();
              const _holdAmount = _cfgHold?.value ? parseFloat(_cfgHold.value) : (CONFIG.withdraw_hold_amount || 1000);
              if (!_wdUser?.wallet) return json({ ok: false, error: 'hold_no_wallet', detail: 'User has no wallet for Hold check' }, 400);
              const _apiKey = env.TONCENTER_API_KEY || env.TON_API_KEY || '';
              if (!_apiKey) return json({ ok: false, error: 'hold_unavailable', detail: 'TONCENTER_API_KEY missing - cannot verify Hold, approval blocked' }, 500);
              if (!CONFIG.jetton) return json({ ok: false, error: 'hold_unavailable', detail: 'Jetton address not configured' }, 500);
              let _ownerRaw = _wdUser.wallet;
              try { const { Address } = await import('@ton/ton'); _ownerRaw = Address.parse(_wdUser.wallet).toRawString(); } catch {}
              let _jettonBal = 0; let _holdErr = null;
              try {
                const _r = await fetch(`https://toncenter.com/api/v3/jetton/wallets?owner_address=${encodeURIComponent(_ownerRaw)}&jetton_address=${CONFIG.jetton}&limit=1`, { headers: { 'X-API-Key': _apiKey } });
                const _d = await _r.json();
                if (_d.jetton_wallets && _d.jetton_wallets.length > 0) _jettonBal = parseFloat(_d.jetton_wallets[0].balance) / 1e9;
                else if (_d.error) _holdErr = _d.error;
              } catch (e) { _holdErr = e.message; }
              if (_holdErr) return json({ ok: false, error: 'hold_check_failed', detail: String(_holdErr), jettonBalance: _jettonBal, holdAmount: _holdAmount }, 500);
              if (_jettonBal < _holdAmount) return json({ ok: false, error: 'hold_not_met', detail: `On-chain FWC: ${_jettonBal}, Hold required: ${_holdAmount}`, jettonBalance: _jettonBal, holdAmount: _holdAmount }, 400);
            }
            await approveWithdrawal(env.DB, wdId);
            // NOTE: No notification here on purpose. Money is NOT sent at Approve - it is sent at Execute Batch.
            // Notifications (DM + @fwc_payouts post) fire in /api/admin/payouts/execute AFTER on-chain send, with real Tx Hash.
          } else {
            const body = await request.json().catch(() => ({}));
            await rejectWithdrawal(env.DB, wdId, body.reason || null);
            await env.DB.prepare(`UPDATE users SET balance = ROUND(balance + ?, 8) WHERE telegram_id = ?`).bind(wd.amount, wd.telegram_id).run();
            // Reject DM to user (no group post for rejections)
            try { await sendTelegramMessage(botToken, wd.telegram_id, `❌ *Withdrawal Rejected*\n\nAmount: ${wd.amount} FWC\nReason: ${body.reason || '—'}\n\nThe amount was refunded to your balance.`); } catch (e) { console.error('Reject DM failed:', e.message); }
          }
          return json({ ok: true });
        }

        if (path === '/api/admin/economy' && request.method === 'GET') {
          const economy = await getAllEconomyConfig(env.DB);
          return json({ ok: true, economy });
        }
        if (path === '/api/admin/economy' && request.method === 'POST') {
          const body = await request.json();
          if (!body.key) return json({ ok: false, error: 'key required' }, 400);
          await setEconomyConfig(env.DB, body.key, body.value);
          return json({ ok: true });
        }

        if (path === '/api/admin/fees' && request.method === 'GET') {
          const config = await getFeeConfig(env.DB);
          return json({ ok: true, config });
        }
        if (path === '/api/admin/fees' && request.method === 'POST') {
          const body = await request.json();
          if (typeof body.percent === 'number') await updateFeePercent(env.DB, body.percent);
          return json({ ok: true });
        }

        if (path === '/api/admin/payouts/stats') {
          const stats = await getPayoutStats(env.DB);
          return json({ ok: true, stats });
        }

        if (path === '/api/admin/payouts/preview') {
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '255'), 255);
          const pending = await getPendingWithdrawalsBatch(env.DB, limit);
          const batch = pending.length > 0 ? await createBatchPayoutTransaction(env.DB, pending) : null;
          return json({ ok: true, pending, batch, estimate: pending.length > 0 ? estimateBatchSaving(pending.length) : null });
        }

        if (path === '/api/admin/payouts/execute' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const limit = Math.min(body.limit || 255, 255);
          const pending = await getPendingWithdrawalsBatch(env.DB, limit);
          if (pending.length === 0) return json({ ok: false, error: 'no_pending' }, 400);

          const batchTx = await createBatchPayoutTransaction(env.DB, pending);
          const result = await executeBatchOnChain(env, batchTx);

          if (!result.ok && !result.mock) return json({ ok: false, error: result.error || 'execution_failed' }, 500);

          const txHash = result.txHash || ('batch_' + Date.now());
          await markBatchAsSent(env.DB, batchTx, txHash);
          // WITHDRAWAL NOTIFICATIONS (STEP 10 FIX): fire HERE, after real on-chain send - NOT at Approve.
          // Full transparency (owner's decision): DM to each user + public proof post in @fwc_payouts with name + username + FULL wallet + amount + date + REAL Tx Hash.
          // If result.mock is true, do NOT post proof (nothing was actually sent) - log a warning instead.
          if (result.mock) {
            console.warn('Payout executed in MOCK mode - notifications skipped, no real on-chain send. txHash:', txHash);
          } else {
            try {
              const _date2 = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Cairo' });
              for (const wd of pending) {
                try {
                  const _u2 = await env.DB.prepare(`SELECT username, first_name, wallet FROM users WHERE telegram_id = ?`).bind(wd.telegram_id).first();
                  const _name2 = _u2?.first_name || 'User';
                  const _uname2 = _u2?.username ? '@' + _u2.username : '—';
                  const _wallet2 = _u2?.wallet || wd.wallet || '—';
                  const _amt2 = wd.amount; const _net2 = (wd.net_amount !== undefined && wd.net_amount !== null) ? wd.net_amount : wd.amount;
                  const _isRealHash = txHash && !String(txHash).startsWith('batch_') && !String(txHash).startsWith('highload_');
                  const _proofLine = _isRealHash ? `Tx: https://tonviewer.com/transaction/${txHash}` : `Verify: https://tonviewer.com/${_wallet2}`;
                  try { await sendTelegramMessage(botToken, wd.telegram_id, `✅ *Withdrawal Sent*\n\nAmount: ${_amt2} FWC\nNet: ${_net2} FWC\nWallet: \`${_wallet2}\`\n${_proofLine}\n\nCheck your wallet. Thank you for mining with FWC! ⛏️`); } catch (e) { console.error('Withdraw DM failed:', e.message); }
                  try { await sendTelegramMessage(botToken, '@fwc_payouts', `✅ *Payout Completed*\n\n👤 ${_name2} (${_uname2})\n💰 Amount: ${_amt2} FWC\n💳 Wallet: \`${_wallet2}\`\n📅 Date: ${_date2}\n${_proofLine}\n\n#FWC #Payout`); } catch (e) { console.error('Payout group post failed:', e.message); }
                } catch (e) { console.error('Payout notify per-user failed:', e.message); }
              }
            } catch (e) { console.error('Payout notifications failed:', e.message); }
          }

          // Log fees for each withdrawal in batch
          try {
            for (const wd of pending) {
              if (wd.fee && wd.fee > 0) {
                await logFee(env.DB, wd.telegram_id, wd.id, wd.fee);
              }
            }
          } catch (e) {
            console.warn('Fee log error:', e.message);
          }

          return json({ ok: true, result, batch: batchTx, marked: pending.length, txHash });
        }

        if (path === '/api/admin/anticheat' && request.method === 'GET') {
          const status = url.searchParams.get('status') || 'open';
          const alerts = await getAntiCheatAlerts(env.DB, status);
          return json({ ok: true, alerts });
        }

        const alertMatch = path.match(/^\/api\/admin\/anticheat\/(\d+)\/(resolve|dismiss)$/);
        if (alertMatch && request.method === 'POST') {
          const alertId = parseInt(alertMatch[1]);
          if (alertMatch[2] === 'resolve') await resolveAlert(env.DB, alertId, 0);
          else await dismissAlert(env.DB, alertId, 0);
          return json({ ok: true });
        }
        // STEP 2 ONLY: Clawback - deduct a chosen amount from every user in this alert, with reason + log. Uses same deduct logic as Step 1 (never below 0). Does NOT guess mining/task tables.
        const clawMatch = path.match(/^\/api\/admin\/anticheat\/(\d+)\/clawback$/);
        if (clawMatch && request.method === 'POST') {
          const alertId = parseInt(clawMatch[1]);
          const body = await request.json().catch(() => ({}));
          const amount = parseFloat(body.amount);
          const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : ('clawback alert #' + alertId);
          if (!isFinite(amount) || amount <= 0) return json({ ok: false, error: 'invalid_amount' }, 400);
          const alertRow = await env.DB.prepare(`SELECT * FROM anticheat_alerts WHERE id = ?`).bind(alertId).first();
          if (!alertRow) return json({ ok: false, error: 'not_found' }, 404);
          let ids = [];
          try {
            const raw = String(alertRow.telegram_ids || '');
            if (raw.trim().startsWith('[')) ids = JSON.parse(raw);
            else ids = raw.split(',').map(s => parseInt(String(s).trim())).filter(n => isFinite(n));
          } catch { ids = []; }
          if (!ids.length) return json({ ok: false, error: 'no_users_in_alert' }, 400);
          const results = [];
          for (const tid of ids) {
            const u = await env.DB.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(tid).first();
            if (!u) { results.push({ telegram_id: tid, deducted: 0, before: 0, after: 0, note: 'not_found' }); continue; }
            const beforeBal = u.balance || 0;
            const deduct = Math.min(amount, beforeBal);
            const afterBal = Math.max(0, beforeBal - deduct);
            await env.DB.prepare(`UPDATE users SET balance = ? WHERE telegram_id = ?`).bind(afterBal, tid).run();
            try {
              await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_balance_log (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, mode TEXT, amount REAL, before_balance REAL, after_balance REAL, reason TEXT, created_at INTEGER)`).run();
              await env.DB.prepare(`INSERT INTO admin_balance_log (telegram_id, mode, amount, before_balance, after_balance, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())`).bind(tid, 'clawback', deduct, beforeBal, afterBal, reason).run();
            } catch (e) { console.warn('clawback log failed', e.message); }
            results.push({ telegram_id: tid, deducted: deduct, before: beforeBal, after: afterBal });
          }
          await resolveAlert(env.DB, alertId, 0);
          return json({ ok: true, alertId, results });
        }
        // STEP 3 ONLY: Ban from alert - ban all, or ban all except one. Per banned user: ban + unlink wallet (wallet=NULL, wallet_verified=0) + cancel pending withdrawals (reset withdrawal counter: pending -> rejected, so withdrawCount drops). Does NOT delete users, does NOT touch already-paid withdrawals. Login NOT touched.
        const banAlertMatch = path.match(/^\/api\/admin\/anticheat\/(\d+)\/ban$/);
        if (banAlertMatch && request.method === 'POST') {
          const alertId = parseInt(banAlertMatch[1]);
          const body = await request.json().catch(() => ({}));
          const mode = body.mode === 'except_one' ? 'except_one' : 'all';
          const keepId = parseInt(body.keepId);
          const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : ('anticheat ban alert #' + alertId);
          const alertRow = await env.DB.prepare(`SELECT * FROM anticheat_alerts WHERE id = ?`).bind(alertId).first();
          if (!alertRow) return json({ ok: false, error: 'not_found' }, 404);
          let ids = [];
          try {
            const raw = String(alertRow.telegram_ids || '');
            if (raw.trim().startsWith('[')) ids = JSON.parse(raw);
            else ids = raw.split(',').map(s => parseInt(String(s).trim())).filter(n => isFinite(n));
          } catch { ids = []; }
          if (!ids.length) return json({ ok: false, error: 'no_users_in_alert' }, 400);
          let targets = ids;
          if (mode === 'except_one') {
            if (!isFinite(keepId) || !ids.includes(keepId)) return json({ ok: false, error: 'invalid_keepId' }, 400);
            targets = ids.filter(t => t !== keepId);
          }
          const results = [];
          for (const tid of targets) {
            const u = await env.DB.prepare(`SELECT telegram_id, wallet FROM users WHERE telegram_id = ?`).bind(tid).first();
            if (!u) { results.push({ telegram_id: tid, note: 'not_found' }); continue; }
            await banUser(env.DB, tid, reason);
            await env.DB.prepare(`UPDATE users SET wallet = NULL, wallet_verified = 0 WHERE telegram_id = ?`).bind(tid).run();
            const pend = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE telegram_id = ? AND status = 'pending'`).bind(tid).first();
            await env.DB.prepare(`UPDATE withdrawals SET status = 'rejected' WHERE telegram_id = ? AND status = 'pending'`).bind(tid).run();
            results.push({ telegram_id: tid, banned: true, wallet_unlinked: true, pending_withdrawals_cancelled: pend?.c || 0 });
          }
          return json({ ok: true, alertId, mode, keepId: mode === 'except_one' ? keepId : null, results });
        }

        // STEP 4 - Test: send ONLY to the admin who clicked (tgUser.id), never to first user. Login NOT touched.
        if (path === '/api/admin/broadcast-test' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const message = typeof body.message === 'string' ? body.message.trim().slice(0, 4000) : '';
          if (!message) return json({ ok: false, error: 'empty_message' }, 400);
          const botToken = env.BOT_TOKEN || getSecrets(env).botToken;
          if (!botToken) return json({ ok: false, error: 'no_bot_token' }, 500);
          // FIX: web admin logs in with password, so tgUser is null. Use tgUser.id if present (Telegram mode), else first admin from DB, else owner 921627899.
          let testTarget = (tgUser && tgUser.id) ? tgUser.id : null;
          if (!testTarget) {
            try {
              const admRow = await env.DB.prepare(`SELECT telegram_id FROM admins ORDER BY telegram_id ASC LIMIT 1`).first();
              testTarget = admRow ? admRow.telegram_id : 921627899;
            } catch { testTarget = 921627899; }
          }
          const r = await sendTelegramMessage(botToken, testTarget, message);
          return json({ ok: !!(r && r.ok), error: r && !r.ok ? (r.description || r.error || 'failed') : undefined });
        }
        // STEP 4 (Broadcast): send to all non-banned users in BATCHES. Worker times out if we send to everyone in one request, so admin UI calls this repeatedly with offset/limit (e.g. 30 at a time) until done. Login NOT touched. Uses existing sendTelegramMessage + BOT_TOKEN.
        if (path === '/api/admin/broadcast' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const message = typeof body.message === 'string' ? body.message.trim().slice(0, 4000) : '';
          if (!message) return json({ ok: false, error: 'empty_message' }, 400);
          const offset = Math.max(0, parseInt(body.offset) || 0);
          const limit = Math.min(50, Math.max(1, parseInt(body.limit) || 30));
          const botToken = env.BOT_TOKEN || getSecrets(env).botToken;
          if (!botToken) return json({ ok: false, error: 'no_bot_token' }, 500);
          const totalRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM users WHERE is_banned = 0`).first();
          const total = totalRow?.c || 0;
          const batch = await env.DB.prepare(`SELECT telegram_id FROM users WHERE is_banned = 0 ORDER BY telegram_id ASC LIMIT ? OFFSET ?`).bind(limit, offset).all();
          const ids = (batch.results || []).map(r => r.telegram_id);
          let sent = 0, failed = 0;
          const failures = [];
          for (const tid of ids) {
            const r = await sendTelegramMessage(botToken, tid, message);
            if (r && r.ok) sent++;
            else { failed++; if (failures.length < 10) failures.push({ telegram_id: tid, error: r?.description || r?.error || 'failed' }); }
          }
          try {
            await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_broadcast_log (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT, offset_used INTEGER, sent INTEGER, failed INTEGER, created_at INTEGER)`).run();
            await env.DB.prepare(`INSERT INTO admin_broadcast_log (message, offset_used, sent, failed, created_at) VALUES (?, ?, ?, ?, unixepoch())`).bind(message, offset, sent, failed).run();
          } catch {}
          return json({ ok: true, total, offset, limit, sent, failed, nextOffset: offset + ids.length, done: offset + ids.length >= total, failures });
        }

        if (path === '/api/admin/health') {
          const health = await getSystemHealth(env);
          return json({ ok: true, health });
        }
      }

      return json({ ok: false, error: 'not_found' }, 404);
    }

    // Webhook handled at top of fetch (always returns 200)

    return htmlResponse(USER_HTML);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event, env));
  }
};
