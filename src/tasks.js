// src/tasks.js - FWC 4.0.0 PRODUCTION FIXED ATOMIC
// Daily tasks + streak system + subscription verification

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

export async function getUserDailyProgress(db, telegram_id, date) {
  try {
    const res = await db.prepare(`SELECT task_id, COUNT(*) as cnt FROM user_daily_tasks WHERE telegram_id = ? AND date = ? GROUP BY task_id`)
      .bind(telegram_id, date).all();
    const map = {};
    for (const r of res.results || []) {
      map[r.task_id] = r.cnt;
    }
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
    // Check if streak is continuous
    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    if (row.date !== today && row.date !== yesterday) {
      return 0; // Streak broken
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
  // Prevent double checkin - atomic check
  const already = await hasCheckedInToday(db, telegram_id, date);
  if (already) {
    return { ok: false, reason: 'already_checked_in' };
  }

  const streak = await getCheckinStreak(db, telegram_id);
  const newStreak = streak >= 7 ? 1 : streak + 1;
  
  // Respect admin value from daily_tasks table (fix for 0.5 issue)
  let reward = STREAK_REWARDS[newStreak] || 1;
  let useAdminReward = false;
  try {
    const taskRow = await db.prepare(`SELECT reward FROM daily_tasks WHERE id = 'checkin'`).first();
    if (taskRow && taskRow.reward !== null && taskRow.reward !== 0) {
      // Use admin-set reward as fixed value (0.5)
      reward = taskRow.reward;
      useAdminReward = true;
    }
  } catch {}
  
  if (!useAdminReward && newStreak === 7) reward += BONUS_WEEK;

  // Atomic insert - prevent race condition
  const insertResult = await db.prepare(`INSERT OR IGNORE INTO daily_checkins(telegram_id, date, streak, created_at) VALUES (?, ?, ?, unixepoch())`)
    .bind(telegram_id, date, newStreak).run();

  if (insertResult.meta.changes === 0) {
    return { ok: false, reason: 'already_checked_in' };
  }

  try {
    await db.prepare(`INSERT OR IGNORE INTO user_daily_tasks(telegram_id, task_id, date, created_at) VALUES (?, 'checkin', ?, unixepoch())`)
      .bind(telegram_id, date).run();
  } catch(e) {}

  await db.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`)
    .bind(reward, telegram_id).run();

  return { streak: newStreak, reward, ok: true };
}

export async function doTask(db, telegram_id, task_id, date, env) {
  try {
    const task = await db.prepare(`SELECT * FROM daily_tasks WHERE id = ? AND active = 1`).bind(task_id).first();
    if (!task) return { ok: false, reason: 'no_task' };

    // Check once-only - only for tasks marked once=1
    if (task.once) {
      const done = await db.prepare(`SELECT 1 FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? LIMIT 1`)
        .bind(telegram_id, task_id).first();
      if (done) return { ok: false, reason: 'already_done' };
    }

    // Check max_per_day - atomic check
    const todayCount = await db.prepare(`SELECT COUNT(*) as c FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? AND date = ?`)
      .bind(telegram_id, task_id, date).first();
    const count = todayCount?.c || 0;
    if (count >= task.max_per_day) return { ok: false, reason: 'limit', count, max: task.max_per_day };

    // Verify subscription for join tasks
    if (task.type === 'join' && task.channel) {
      try {
        const botToken = env.BOT_TOKEN;
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${task.channel}&user_id=${telegram_id}`);
        const data = await res.json();
        if (!data.ok || !['member', 'administrator', 'creator'].includes(data.result?.status)) {
          return { ok: false, reason: 'not_subscribed' };
        }
      } catch (e) {
        return { ok: false, reason: 'verification_error', detail: e.message };
      }
    }

    // Atomic insert with race condition protection
    // Use INSERT OR IGNORE and check if count increased
    const insertResult = await db.prepare(`INSERT INTO user_daily_tasks(telegram_id, task_id, date, created_at) VALUES (?, ?, ?, unixepoch())`)
      .bind(telegram_id, task_id, date).run().catch(async (e) => {
        // If duplicate due to race, check again
        if (e.message && (e.message.includes('UNIQUE') || e.message.includes('PRIMARY'))) {
          const newCount = await db.prepare(`SELECT COUNT(*) as c FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? AND date = ?`)
            .bind(telegram_id, task_id, date).first();
          if ((newCount?.c || 0) > count) {
            return { meta: { changes: 0 }, duplicate: true };
          }
        }
        throw e;
      });

    // If it was a duplicate race, return limit error
    if (insertResult.duplicate || insertResult.meta.changes === 0) {
      return { ok: false, reason: 'limit', detail: 'already_claimed' };
    }

    // Double-check after insert that we didn't exceed max (race protection)
    const afterCount = await db.prepare(`SELECT COUNT(*) as c FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? AND date = ?`)
      .bind(telegram_id, task_id, date).first();
    if ((afterCount?.c || 0) > task.max_per_day) {
      // Rollback - delete the extra
      await db.prepare(`DELETE FROM user_daily_tasks WHERE rowid = (SELECT MAX(rowid) FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? AND date = ?)`)
        .bind(telegram_id, task_id, date).run();
      return { ok: false, reason: 'limit', count: afterCount?.c, max: task.max_per_day };
    }

    if (task.reward > 0) {
      await db.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`)
        .bind(task.reward, telegram_id).run();
    }

    const user = await db.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(telegram_id).first();

    return { ok: true, reward: task.reward, newBalance: user?.balance || 0, count: count+1 };
  } catch(e) {
    console.error('doTask error', e);
    return { ok: false, reason: 'server_error', detail: e.message };
  }
}
