// src/index.js - FWC 4.0.0 PRODUCTION
// Main router: webhooks, APIs, HTML pages

import { Bot } from 'grammy';
import { CONFIG, getSecrets } from './config.js';
import {
  initDB, isAdminDB, getUser, createOrUpdateUser, setUserLanguage,
  getAllAdmins, addAdminById, removeAdmin, banUser, unbanUser,
  getEconomyConfig, setEconomyConfig, getAllEconomyConfig, getAdsConfig,
  getAllTasksAdmin, createTask, updateTask, deleteTask,
  createWithdrawal, getWithdrawalById, approveWithdrawal, rejectWithdrawal,
  getUserPendingWithdrawal, logFee, getTotalFees,
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

function getTelegramUser(request) {
  try {
    const initData = request.headers.get('X-Telegram-Init-Data')
      || new URL(request.url).searchParams.get('initData');
    if (!initData) return null;
    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || null;
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
    const { BOT_TOKEN: botToken } = getSecrets(env);

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
    
    // 👇 ربط صفحة الأدمن بالمسار الجديد /aha.htm
    if (path === '/aha.htm') {
      return htmlResponse(ADMIN_HTML); 
    }

    // ========== API ROUTES ==========
    if (path.startsWith('/api/')) {
      const tgUser = getTelegramUser(request);
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
        const miningAmount = await getCurrentMiningAmount(env.DB);
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
          canMine: canMineRes,
          canWithdraw: canWithdrawRes,
          ads,
          streak,
        });
      }

      if (path === '/api/language' && request.method === 'POST' && tgUser) {
        const body = await request.json();
        const lang = ['en', 'ar', 'ru', 'tr'].includes(body.lang) ? body.lang : 'en';
        await setUserLanguage(env.DB, tgUser.id, lang);
        return json({ ok: true, language: lang });
      }

      if (path === '/api/mine' && request.method === 'POST' && tgUser) {
        const check = await canMine(env.DB, tgUser.id);
        if (!check.ok) return json({ ok: false, error: check.reason, detail: check }, 400);
        const res = await doMine(env.DB, tgUser.id);
        return json({ ok: true, ...res });
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

        const result = await doTask(env.DB, tgUser.id, taskId, date);
        if (!result.ok) return json({ ok: false, error: result.reason }, 400);
        return json({ ok: true, reward: result.reward, newBalance: result.newBalance });
      }

      if (path === '/api/withdraw/estimate' && tgUser) {
        const amount = Number(url.searchParams.get('amount'));
        if (!amount || amount <= 0) return json({ ok: false, error: 'invalid_amount' }, 400);

        const feeInfo = await calculateWithdrawalFee(env.DB, amount);
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
        const feeInfo = await calculateWithdrawalFee(env.DB, amount);

        if (user.balance < amount) {
          return json({
            ok: false,
            error: 'insufficient_balance',
            required: amount,
            available: user.balance,
          }, 400);
        }

        const pending = await getUserPendingWithdrawal(env.DB, tgUser.id);
        if (pending) return json({ ok: false, error: 'pending_exists' }, 400);

        await env.DB.prepare(`UPDATE users SET balance = balance - ? WHERE telegram_id = ?`)
          .bind(amount, tgUser.id).run();

        const wdResult = await createWithdrawal(
          env.DB, tgUser.id, amount, user.wallet,
          feeInfo.fee, feeInfo.netAmount
        );

        try {
          const wdId = wdResult?.meta?.last_row_id;
          if (wdId && feeInfo.fee > 0) {
            await logFee(env.DB, tgUser.id, wdId, feeInfo.fee);
          }
        } catch {}

        return json({
          ok: true,
          amount: feeInfo.netAmount,
          fee: feeInfo.fee,
          totalDeducted: amount,
          newBalance: user.balance - amount,
        });
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

      if (path === '/api/health') {
        const health = await getSystemHealth(env);
        return json(health, health.status === 'critical' ? 503 : 200);
      }

      // ============ ADMIN APIs ============
      if (path.startsWith('/api/admin/')) {
        // 👇 التحقق من كلمة المرور فقط (من غير تليجرام) عشان تشتغل من المتصفح
        const adminSecret = request.headers.get('X-Admin-Secret');
        if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }

        if (path === '/api/admin/stats') {
          const miningAmount = await getCurrentMiningAmount(env.DB);
          const usersCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM users`).first();
          const wdPending = await env.DB.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'`).first();
          const totalBalance = await env.DB.prepare(`SELECT COALESCE(SUM(balance),0) as s FROM users`).first();
          const totalMined = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM mining_log`).first();
          const totalFees = await getTotalFees(env.DB, 0);
          const openAlerts = await env.DB.prepare(`SELECT COUNT(*) as c FROM anticheat_alerts WHERE status='open'`).first();

          return json({
            ok: true,
            miningAmount,
            usersCount: usersCount?.c || 0,
            wdPending: wdPending?.c || 0,
            totalBalance: totalBalance?.s || 0,
            totalMined: totalMined?.s || 0,
            totalFees,
            openAlerts: openAlerts?.c || 0,
          });
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
          if (typeof body.balance !== 'number') return json({ ok: false, error: 'invalid' }, 400);
          await env.DB.prepare(`UPDATE users SET balance = ? WHERE telegram_id = ?`).bind(body.balance, targetId).run();
          return json({ ok: true });
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
            await env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`).bind(wd.amount, wd.telegram_id).run();
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
      if (!botToken) return new Response('BOT_TOKEN missing', { status: 500 });

      const bot = new Bot(botToken);
      
      // الأوامر
      bot.command('start', async (ctx) => {
        const u = ctx.from;
        await createOrUpdateUser(env.DB, {
          telegram_id: u.id, username: u.username, first_name: u.first_name, language: u.language_code || 'en',
        });
        const workerUrl = env.WORKER_URL || url.origin;
        const isAdmin = await isAdminDB(env.DB, u.id);
        const keyboard = [[{ text: '🚀 Open FWC Mining App', web_app: { url: workerUrl } }]];
        if (isAdmin) keyboard.push([{ text: '👑 Admin Panel', web_app: { url: workerUrl + '/aha.htm' } }]);
        await ctx.reply(`⛏️ *FWC Mining*\n\nWelcome ${u.first_name}! Start mining FWC now.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
      });

      bot.command('mine', async (ctx) => {
        const u = ctx.from;
        const check = await canMine(env.DB, u.id);
        if (!check.ok) return ctx.reply(`⏳ Please wait: ${check.reason}`);
        const res = await doMine(env.DB, u.id);
        await ctx.reply(`✅ Mined +${res.amount} FWC! New balance: ${res.newBalance.toFixed(2)}`);
      });

      bot.command('balance', async (ctx) => {
        const user = await getUser(env.DB, ctx.from.id);
        await ctx.reply(`💰 Your balance: ${(user?.balance || 0).toFixed(2)} FWC`);
      });

      bot.command('wallet', async (ctx) => {
        const workerUrl = env.WORKER_URL || url.origin;
        const isAdmin = await isAdminDB(env.DB, ctx.from.id);
        const keyboard = [[{ text: '🚀 Open FWC Mining App', web_app: { url: workerUrl } }]];
        if (isAdmin) keyboard.push([{ text: '👑 Admin Panel', web_app: { url: workerUrl + '/aha.htm' } }]);
        await ctx.reply('💳 Connect or update your wallet from the app:', { reply_markup: { inline_keyboard: keyboard } });
      });

      bot.command('tasks', async (ctx) => {
        const workerUrl = env.WORKER_URL || url.origin;
        const isAdmin = await isAdminDB(env.DB, ctx.from.id);
        const keyboard = [[{ text: '🚀 Open FWC Mining App', web_app: { url: workerUrl } }]];
        if (isAdmin) keyboard.push([{ text: '👑 Admin Panel', web_app: { url: workerUrl + '/aha.htm' } }]);
        await ctx.reply('📋 View your daily tasks in the app:', { reply_markup: { inline_keyboard: keyboard } });
      });

      bot.command('withdraw', async (ctx) => {
        const workerUrl = env.WORKER_URL || url.origin;
        const isAdmin = await isAdminDB(env.DB, ctx.from.id);
        const keyboard = [[{ text: '🚀 Open FWC Mining App', web_app: { url: workerUrl } }]];
        if (isAdmin) keyboard.push([{ text: '👑 Admin Panel', web_app: { url: workerUrl + '/aha.htm' } }]);
        await ctx.reply('💸 Request a withdrawal from the app:', { reply_markup: { inline_keyboard: keyboard } });
      });

      bot.command('help', async (ctx) => {
        await ctx.reply(`🆘 *FWC Mining Help*\n\n/start - Open the app\n/mine - Mine FWC\n/balance - Check your balance\n/wallet - Connect your TON wallet\n/tasks - View daily tasks\n/withdraw - Request a withdrawal\n/admin - Open Admin Panel\n\nFor support, contact @fwc_coin`, { parse_mode: 'Markdown' });
      });

      bot.command('admin', async (ctx) => {
        const u = ctx.from;
        const workerUrl = env.WORKER_URL || url.origin;
        const isAdmin = await isAdminDB(env.DB, u.id);
        
        if (isAdmin) {
          const keyboard = [[{ text: '👑 Open Admin Panel', web_app: { url: workerUrl + '/aha.htm' } }]];
          await ctx.reply('Welcome Admin! Click below to open the control panel:', {
            reply_markup: { inline_keyboard: keyboard }
          });
        } else {
          await ctx.reply('⛔ You are not authorized to use this command.');
        }
      });

      // السطر ده اللي بيمنع الـ 500
      await bot.handleUpdate(await request.json());
      return new Response('ok');
    }

    return htmlResponse(USER_HTML);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event, env));
  }
};
