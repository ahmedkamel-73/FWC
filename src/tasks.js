// src/tasks.js - FWC 4.0.0 PRODUCTION FIXED - TASKS_FINAL
// Fixes:
// 1. user_daily_tasks PK was (telegram_id, task_id, date) => max_per_day > 1 was IMPOSSIBLE (ads x7, invite x100 always hit UNIQUE). Schema migrated in db.js to id AUTOINCREMENT.
// 2. getUserDailyProgress only returned TODAY => once tasks (join/youtube/x) showed as NOT DONE every new day, then server said already_done. Now once tasks return lifetime count.
// 3. invite task never completed: frontend returned early and never called API. Now server verifies referral count.
// 4. youtube/x cannot be verified server-side (no API) => kept as click-to-claim after opening link, documented. join IS verified via getChatMember.

export const STREAK_REWARDS = { 1: 1, 2: 2, 3: 3, 4: 5, 5: 7, 6: 10, 7: 15 };
export const BONUS_WEEK = 5;

export async function getDailyTasks(db) {
  try {
    const res = await db.prepare(`SELECT * FROM daily_tasks WHERE active = 1 ORDER BY id ASC`).all();
    return res.results || [];
  } catch(e) {
    console.error('getDailyTasks error', e);
    return [];
  }
}

// FIX #2: once tasks must show as done forever, not just today.
// Returns map task_id -> count. For once=1 tasks: lifetime count. For others: today's count.
export async function getUserDailyProgress(db, telegram_id, date) {
  try {
    const res = await db.prepare(`SELECT task_id, COUNT(*) as cnt FROM user_daily_tasks WHERE telegram_id = ? AND date = ? GROUP BY task_id`)
      .bind(telegram_id, date).all();
    const map = {};
    for (const r of res.results || []) {
      map[r.task_id] = r.cnt;
    }
    // Once tasks: lifetime count (so frontend shows Done even tomorrow)
    try {
      const onceRes = await db.prepare(`SELECT task_id, COUNT(*) as cnt FROM user_daily_tasks WHERE telegram_id = ? AND task_id IN (SELECT id FROM daily_tasks WHERE once = 1) GROUP BY task_id`)
        .bind(telegram_id).all();
      for (const r of onceRes.results || []) {
        // Lifetime is >= today, use max so once tasks never flip back to Not Done
        map[r.task_id] = Math.max(map[r.task_id] || 0, r.cnt);
      }
    } catch {}
    return map;
  } catch(e) {
    return {};
  }
}

export async function getCheckinStreak(db, telegram_id) {
  try {
    const row = await db.prepare(`SELECT streak, date FROM daily_checkins WHERE telegram_id = ? ORDER BY date DESC LIMIT 1`)
      .bind(telegram_id).first();
    if (!row) return 0;
    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    if (row.date !== today && row.date !== yesterday) {
      return 0;
    }
    return row?.streak || 0;
  } catch(e) { return 0; }
}

export async function hasCheckedInToday(db, telegram_id, date) {
  try {
    const row = await db.prepare(`SELECT 1 FROM daily_checkins WHERE telegram_id = ? AND date = ?`)
      .bind(telegram_id, date).first();
    return !!row;
  } catch(e) { return false; }
}

export async function doCheckin(db, telegram_id, date) {
  const already = await hasCheckedInToday(db, telegram_id, date);
  if (already) {
    return { ok: false, reason: 'already_checked_in' };
  }
  const streak = await getCheckinStreak(db, telegram_id);
  const newStreak = streak >= 7 ? 1 : streak + 1;
  let reward = STREAK_REWARDS[newStreak] || 1;
  let useAdminReward = false;
  try {
    const taskRow = await db.prepare(`SELECT reward FROM daily_tasks WHERE id = 'checkin'`).first();
    if (taskRow && taskRow.reward !== null && taskRow.reward !== 0) {
      reward = taskRow.reward;
      useAdminReward = true;
    }
  } catch {}
  if (!useAdminReward && newStreak === 7) reward += BONUS_WEEK;
  const insertResult = await db.prepare(`INSERT OR IGNORE INTO daily_checkins(telegram_id, date, streak, created_at) VALUES (?, ?, ?, unixepoch())`)
    .bind(telegram_id, date, newStreak).run();
  if (insertResult.meta.changes === 0) {
    return { ok: false, reason: 'already_checked_in' };
  }
  try {
    await db.prepare(`INSERT OR IGNORE INTO user_daily_tasks(telegram_id, task_id, date, created_at) VALUES (?, 'checkin', ?, unixepoch())`)
      .bind(telegram_id, date).run();
  } catch(e) {}
  await db.prepare(`UPDATE users SET balance = ROUND(balance + ?, 8) WHERE telegram_id = ?`)
    .bind(reward, telegram_id).run();
  return { streak: newStreak, reward, ok: true };
}

export async function doTask(db, telegram_id, task_id, date, env) {
  try {
    const task = await db.prepare(`SELECT * FROM daily_tasks WHERE id = ? AND active = 1`).bind(task_id).first();
    if (!task) return { ok: false, reason: 'no_task' };

    // Once-only check (lifetime)
    if (task.once) {
      const done = await db.prepare(`SELECT 1 FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? LIMIT 1`)
        .bind(telegram_id, task_id).first();
      if (done) return { ok: false, reason: 'already_done' };
    }

    // Max per day (today only for repeatable, lifetime handled above for once)
    const todayCount = await db.prepare(`SELECT COUNT(*) as c FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? AND date = ?`)
      .bind(telegram_id, task_id, date).first();
    const count = todayCount?.c || 0;
    if (count >= task.max_per_day) return { ok: false, reason: 'limit', count, max: task.max_per_day };

    // FIX #3: Invite task - verify referral count, not just click.
    // Reward is per NEW referral: claimed count must be < total referrals.
    if (task.type === 'invite') {
      const refRow = await db.prepare(`SELECT COUNT(*) as c FROM users WHERE referral_by = ?`).bind(telegram_id).first();
      const totalReferrals = refRow?.c || 0;
      // Total claimed ever for invite task
      const claimedRow = await db.prepare(`SELECT COUNT(*) as c FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ?`).bind(telegram_id, task_id).first();
      const claimed = claimedRow?.c || 0;
      if (totalReferrals <= claimed) {
        return { ok: false, reason: 'not_enough_referrals', referrals: totalReferrals, claimed, need: claimed + 1 };
      }
      // Fall through to insert + reward below (one reward per referral)
    }

    // Verify subscription for join tasks - FIXED: distinguish bot problems from user not joined
    // Root causes of old generic 'verification_error':
    //  1. BOT_TOKEN missing / has spaces in Worker env
    //  2. Bot is NOT admin/member in the channel/group -> Telegram returns 403 "chat not found / member list inaccessible / bot is not a member"
    //  3. Network / Telegram 5xx -> retry once
    // Old code mapped ALL of these to one generic error, so user thought HE was the problem.
    if (task.type === 'join' && task.channel) {
      const botToken = (env?.BOT_TOKEN || env?.botToken || '').toString().trim();
      if (!botToken) return { ok: false, reason: 'bot_token_missing', detail: 'BOT_TOKEN is empty in Worker env. Set it in Cloudflare Dashboard > Settings > Variables.' };
      // Normalize channel: "@fwc_coin" or "fwc_coin" or "-100123..." all work. Telegram needs @ for usernames.
      let chatId = String(task.channel).trim();
      if (!chatId.startsWith('@') && !chatId.startsWith('-') && !/^\d+$/.test(chatId)) chatId = '@' + chatId;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${telegram_id}`);
          let data = null;
          try { data = await res.json(); } catch { data = null; }
          if (!data) { lastErr = 'Telegram returned non-JSON (HTTP ' + res.status + ')'; continue; }
          if (data.ok) {
            const status = data.result?.status;
            // member / administrator / creator / restricted = joined. left / kicked = NOT joined.
            if (['member', 'administrator', 'creator', 'restricted'].includes(status)) break;
            return { ok: false, reason: 'not_subscribed', detail: 'Telegram status: ' + status };
          }
          // data.ok === false -> read Telegram description, it tells us WHO is wrong
          const desc = (data.description || '').toLowerCase();
          if (desc.includes('chat not found') || desc.includes('member list') || desc.includes('bot is not a member') || desc.includes('bot was blocked') || desc.includes('forbidden') || desc.includes('chat_id is empty') || desc.includes('peer_id_invalid')) {
            return { ok: false, reason: 'bot_not_in_chat', detail: 'Telegram: ' + data.description + ' | Channel: ' + chatId + ' | Fix: Add the bot as ADMIN in ' + chatId + ' (Channels: Admin, Groups: Member+ at least). Then retry.' };
          }
          if (desc.includes('user not found') || desc.includes('participant_id_invalid') || desc.includes('user_id_invalid')) {
            return { ok: false, reason: 'not_subscribed', detail: 'Telegram: ' + data.description };
          }
          // Unknown Telegram error -> retry once, then surface it (not generic)
          lastErr = data.description || 'Telegram error';
          continue;
        } catch (e) {
          lastErr = e.message;
          continue;
        }
      }
      if (lastErr) return { ok: false, reason: 'verification_error', detail: 'Telegram API failed after retry: ' + lastErr + ' | Channel: ' + chatId };
      // If we broke out of loop via member status, continue to reward. If loop ended without break and without return, it means last attempt was member - already handled. Safety:
      // Re-check once more is not needed; if we are here and lastErr is null, verification passed.
    }

    // Admin diagnostic helper - call from /api/admin/tasks/test-join
    // Returns raw Telegram result so admin can see exactly why it fails.

    // NOTE: youtube / x / custom tasks CANNOT be verified server-side (no YouTube/X API in Worker).
    // They are click-to-claim after opening the link in frontend. Do NOT add fake verification here.
    // If you want strict verification, change their type to 'join' or disable them in Admin.

    // FIX #1: INSERT must allow multiple rows per day for max_per_day > 1.
    // Requires db.js migration: user_daily_tasks has id INTEGER PRIMARY KEY AUTOINCREMENT, NOT (telegram_id, task_id, date).
    // Old schema blocked 2nd claim with UNIQUE error. New schema allows it.
    const insertResult = await db.prepare(`INSERT INTO user_daily_tasks(telegram_id, task_id, date, created_at) VALUES (?, ?, ?, unixepoch())`)
      .bind(telegram_id, task_id, date).run().catch(async (e) => {
        if (e.message && (e.message.includes('UNIQUE') || e.message.includes('PRIMARY'))) {
          // Old DB still has old PK - tell admin to migrate, don't silently fail
          return { meta: { changes: 0 }, duplicate: true, oldSchema: true };
        }
        throw e;
      });

    if (insertResult.duplicate) {
      if (insertResult.oldSchema) return { ok: false, reason: 'old_schema_needs_migration', detail: 'user_daily_tasks still has old PK (telegram_id, task_id, date). Run db migration.' };
      return { ok: false, reason: 'limit', detail: 'already_claimed' };
    }
    if (insertResult.meta.changes === 0) {
      return { ok: false, reason: 'limit', detail: 'already_claimed' };
    }

    const afterCount = await db.prepare(`SELECT COUNT(*) as c FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? AND date = ?`)
      .bind(telegram_id, task_id, date).first();
    if ((afterCount?.c || 0) > task.max_per_day) {
      await db.prepare(`DELETE FROM user_daily_tasks WHERE rowid = (SELECT MAX(rowid) FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? AND date = ?)`).bind(telegram_id, task_id, date).run();
      return { ok: false, reason: 'limit', count: afterCount?.c, max: task.max_per_day };
    }

    if (task.reward > 0) {
      await db.prepare(`UPDATE users SET balance = ROUND(balance + ?, 8) WHERE telegram_id = ?`)
        .bind(task.reward, telegram_id).run();
    }
    const user = await db.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(telegram_id).first();
    return { ok: true, reward: task.reward, newBalance: user?.balance || 0, count: count+1 };
  } catch(e) {
    console.error('doTask error', e);
    return { ok: false, reason: 'server_error', detail: e.message };
  }
}


// Diagnostic: test join verification for one user/channel without giving reward.
// Returns { ok, status, telegramRaw, hint } - use it in Admin to see the real Telegram answer.
export async function testJoinVerification(env, channel, telegram_id) {
  const botToken = (env?.BOT_TOKEN || env?.botToken || '').toString().trim();
  if (!botToken) return { ok: false, reason: 'bot_token_missing' };
  let chatId = String(channel || '').trim();
  if (chatId && !chatId.startsWith('@') && !chatId.startsWith('-') && !/^\d+$/.test(chatId)) chatId = '@' + chatId;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${telegram_id}`);
    const data = await res.json().catch(() => null);
    return { ok: !!data?.ok, status: data?.result?.status || null, telegramRaw: data, chatId };
  } catch (e) {
    return { ok: false, reason: 'verification_error', detail: e.message };
  }
}
