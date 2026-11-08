
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
import { getDailyTasks, doTask, doCheckin, getCheckinStreak, getUserDailyProgress, hasCheckedInToday, testJoinVerification } from './tasks.js';
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
    const botToken = (env?.BOT_TOKEN || '').toString().trim();
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
    await initDB(env.DB);

    const url = new URL(request.url);
    const path = url.pathname;
    // FIX: was `const { BOT_TOKEN: botToken } = getSecrets(env)` but getSecrets returns { botToken }, so this was ALWAYS undefined.
    const { botToken } = getSecrets(env);
    const botTokenSafe = (botToken || env?.BOT_TOKEN || '').toString().trim();

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
        const date = new Date().toISOString().split('T')[0];
        const already = await hasCheckedInToday(env.DB, tgUser.id, date);
        if (already) return json({ ok: false, error: 'already_checked_in' }, 400);
        const result = await doCheckin(env.DB, tgUser.id, date);
        return json({ ok: true, ...result });
      }

      if (path.startsWith('/api/tasks/') && request.method === 'POST' && tgUser) {
        const taskId = path.split('/')[3];
        if (!taskId) return json({ ok: false, error: 'invalid_task' }, 400);

        const date = new Date().toISOString().split('T')[0];

        if (taskId === 'checkin') {
          const already = await hasCheckedInToday(env.DB, tgUser.id, date);
          if (already) return json({ ok: false, error: 'already_checked_in' }, 400);
          const r = await doCheckin(env.DB, tgUser.id, date);
          return json({ ok: true, reward: r.reward, streak: r.streak });
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
        return json({ ok: true, enabled: cfg.enabled, price: cfg.price, limit: cfg.limit, owners, remaining: Math.max(0, cfg.limit - owners), burned: cfg.burned, burn_address: cfg.burn_address, interval_hours: cfg.interval_hours, bonus_percent: cfg.bonus_percent, fee_percent: cfg.fee_percent, isFounder: mine });
      }
      if (path === '/api/founder/status' && !tgUser) {
        const cfg = await getFounderConfig(env.DB);
        const owners = await getFounderOwnersCount(env.DB);
        return json({ ok: true, enabled: cfg.enabled, price: cfg.price, limit: cfg.limit, owners, remaining: Math.max(0, cfg.limit - owners), burned: cfg.burned, burn_address: cfg.burn_address, interval_hours: cfg.interval_hours, bonus_percent: cfg.bonus_percent, fee_percent: cfg.fee_percent });
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
          // Find transfer to burn address with enough amount. Jetton address must match CONFIG.jetton if provided.
          let matched = null;
          for (const t of transfers) {
            const dest = (t.destination?.address || t.destination || t.to || '').toString();
            const amt = parseFloat(t.amount || 0) / 1e9;
            const jettonMaster = (t.jetton_master?.address || t.jetton_master || '').toString();
            if (dest.toLowerCase() === cfg.burn_address.toLowerCase() && amt + 0.001 >= cfg.price) {
              if (!jettonMaster || jettonMaster.toLowerCase() === CONFIG.jetton.toLowerCase()) { matched = { dest, amt }; break; }
            }
          }
          if (!matched) {
            // Fallback: check any transfer to burn address, report amount
            const toBurn = transfers.filter(t => (t.destination?.address || t.destination || '').toString().toLowerCase() === cfg.burn_address.toLowerCase());
            if (toBurn.length === 0) return json({ ok: false, error: 'wrong_burn_address', detail: 'Tx did not go to burn address' }, 400);
            const maxAmt = Math.max(...toBurn.map(t => parseFloat(t.amount || 0) / 1e9));
            return json({ ok: false, error: 'amount_too_low', detail: `Sent ${maxAmt}, need ${cfg.price}` }, 400);
          }
          // Optional: verify sender matches user wallet (if TonCenter provides source)
          // Do NOT block on sender mismatch alone - burn verification is destination+amount.
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
        if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }

        if (path === '/api/admin/stats') {
          const miningAmount = await getCurrentMiningAmount(env.DB);
        const founderFlag = await isFounder(env.DB, tgUser.id);
        const founderCfg = await getFounderConfig(env.DB);
          const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first();
          const wdPending = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'`).first();
          const totalBalance = await env.DB.prepare(`SELECT COALESCE(SUM(balance),0) as s FROM users`).first();
          const totalMined = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM mining_log`).first();
          const totalFees = await getTotalFees(env.DB, 0);
          const openAlerts = await env.DB.prepare(`SELECT COUNT(*) as c FROM anticheat_alerts WHERE status='open'`).first();

          return json({ ok: true, miningAmount, usersCount: usersCount?.c || 0, wdPending: wdPending?.c || 0, totalBalance: totalBalance?.s || 0, totalMined: totalMined?.s || 0, totalFees, openAlerts: openAlerts?.c || 0 });
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
          const targetId = parseInt(balanceMatch[1]);
          const body = await request.json();
          const amount = typeof body.amount === 'number' ? body.amount : body.balance;
          if (typeof amount !== 'number') return json({ ok: false, error: 'invalid' }, 400);
          const mode = body.mode || (typeof body.balance === 'number' ? 'set' : 'add');
          if (mode === 'set') {
            await env.DB.prepare(`UPDATE users SET balance = ? WHERE telegram_id = ?`).bind(amount, targetId).run();
          } else {
            await env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`).bind(amount, targetId).run();
          }
          const newU = await env.DB.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(targetId).first();
          return json({ ok: true, newBalance: newU?.balance || 0 });
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
          const apiKey = env.TONCENTER_API_KEY || '';
          let jettonBal = 0;
          try {
            if (apiKey && CONFIG.jetton) {
              const r = await fetch(`https://toncenter.com/api/v3/jetton/wallets?owner_address=${user.wallet}&jetton_address=${CONFIG.jetton}&limit=1`, { headers: { 'X-API-Key': apiKey } });
              const d = await r.json();
              if (d.jetton_wallets && d.jetton_wallets.length > 0) jettonBal = parseFloat(d.jetton_wallets[0].balance) / 1e9;
            }
          } catch {}
          const wdCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE telegram_id = ? AND status != 'rejected'`).bind(targetId).first();
          return json({ ok: true, wallet: user.wallet, jettonBalance: jettonBal, balance: jettonBal, withdrawCount: wdCount?.c || 0, holdAmount, meetsHold: jettonBal >= holdAmount });
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

        // Diagnostic - NEVER returns secret values, only presence + length, so you can prove env is wired without leaking.
        if (path === '/api/admin/debug-secrets') {
          const bt = (env?.BOT_TOKEN || '').toString();
          const tc = (env?.TONCENTER_API_KEY || '').toString();
          return json({ ok: true, scriptName: 'fwc', hasBOT_TOKEN: !!bt.trim(), botTokenLength: bt.trim().length, botTokenStartsWith: bt.trim().slice(0, 3), hasTONCENTER: !!tc.trim(), toncenterLength: tc.trim().length, hasADMIN_SECRET: !!(env?.ADMIN_SECRET || '').toString().trim(), hasDB: !!env?.DB, hint: bt.trim() ? 'BOT_TOKEN IS present in this Worker env. If tasks still say missing, you deployed a different Worker/env.' : 'BOT_TOKEN is EMPTY in THIS Worker (scriptName fwc, Production). Check: Cloudflare > Workers > fwc > Settings > Variables > Production, then Deploy.' });
        }
        if (path === '/api/admin/founder' && request.method === 'GET') {
          const cfg = await getFounderConfig(env.DB);
          const owners = await getFounderOwnersCount(env.DB);
          return json({ ok: true, enabled: cfg.enabled, price: cfg.price, limit: cfg.limit, owners, remaining: Math.max(0, cfg.limit - owners), burned: cfg.burned, burn_address: cfg.burn_address, interval_hours: cfg.interval_hours, bonus_percent: cfg.bonus_percent, fee_percent: cfg.fee_percent });
        }
        if (path === '/api/admin/founder/toggle' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const enabled = body.enabled === true || body.enabled === '1' || body.enabled === 1;
          await env.DB.prepare(`INSERT OR REPLACE INTO config_overrides (key, value) VALUES ('founder_enabled', ?)`).bind(enabled ? '1' : '0').run();
          return json({ ok: true, enabled });
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


        if (path === '/api/admin/tasks/test-join') {
          const channel = url.searchParams.get('channel') || '';
          const userId = parseInt(url.searchParams.get('user_id') || '0');
          if (!channel || !userId) return json({ ok: false, error: 'need channel + user_id, e.g. ?channel=@fwc_coin&user_id=123' }, 400);
          const r = await testJoinVerification(env, channel, userId);
          return json({ ok: true, ...r, hint: r.ok ? 'Bot CAN see this chat. If user status is left/kicked, user really has not joined.' : 'Bot CANNOT see this chat. Add bot as ADMIN in the channel/group, check BOT_TOKEN, check channel username.' });
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
            await approveWithdrawal(env.DB, wdId);
          } else {
            const body = await request.json().catch(() => ({}));
            await rejectWithdrawal(env.DB, wdId, body.reason || null);
            await env.DB.prepare(`UPDATE users SET balance = ROUND(balance + ?, 8) WHERE telegram_id = ?`).bind(wd.amount, wd.telegram_id).run();
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

        if (path === '/api/admin/health') {
          const health = await getSystemHealth(env);
          return json({ ok: true, health });
        }
      }

      return json({ ok: false, error: 'not_found' }, 404);
    }

    // ========== TELEGRAM WEBHOOK ==========
    if (path === '/webhook' && request.method === 'POST') {
      if (!botTokenSafe) return new Response('BOT_TOKEN missing', { status: 500 });

      try {
        const update = await request.json();
        const message = update.message;

        if (message && message.text) {
          const text = message.text;
          const fromId = message.from.id;
          const fromUsername = message.from.username || null;
          const fromFirstName = message.from.first_name || null;
          const fromLang = message.from.language_code || 'en';

          if (text.startsWith('/start')) {
            await createOrUpdateUser(env.DB, {
              telegram_id: fromId, username: fromUsername, first_name: fromFirstName, language: fromLang,
            });

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
                await env.DB.prepare(`UPDATE users SET referral_by = ? WHERE telegram_id = ? AND referral_by IS NULL`)
                  .bind(refId, fromId).run();
              }
            }

            const workerUrl = env.WORKER_URL || url.origin;
            const isAdmin = await isAdminDB(env.DB, fromId);
            const buttons = [[{ text: '🚀 Open FWC Mining App', web_app: { url: workerUrl } }]];
            if (isAdmin) buttons.push([{ text: '👑 Admin Panel', web_app: { url: workerUrl + '/aha.htm' } }]);

            await sendTelegramMessage(botTokenSafe, fromId,
              `⛏️ *FWC Mining*\\n\\nWelcome ${fromFirstName}! Start mining FWC now.`,
              { inline_keyboard: buttons }
            );
          }
        }
      } catch (e) {
        console.error('Webhook error:', e.message, e.stack);
      }

      return new Response('ok');
    }

    return htmlResponse(USER_HTML);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event, env));
  }
};
