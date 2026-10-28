// src/tasks.js - FWC 4.0.0 PRODUCTION FIXED 7X
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
    // Fallback for old schema
    try {
      const res = await db.prepare(`SELECT task_id FROM user_daily_tasks WHERE telegram_id = ? AND date = ?`)
        .bind(telegram_id, date).all();
      const map = {};
      for (const r of res.results || []) {
        map[r.task_id] = (map[r.task_id] || 0) + 1;
      }
      return map;
    } catch(e2) {
      return {};
    }
  }
}

export async function getCheckinStreak(db, telegram_id) {
  try {
    const row = await db.prepare(`SELECT streak FROM daily_checkins WHERE telegram_id = ? ORDER BY date DESC LIMIT 1`)
      .bind(telegram_id).first();
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
  const streak = await getCheckinStreak(db, telegram_id);
  const newStreak = streak >= 7 ? 1 : streak + 1;
  let reward = STREAK_REWARDS[newStreak] || 1;
  if (newStreak === 7) reward += BONUS_WEEK;

  await db.prepare(`INSERT OR REPLACE INTO daily_checkins(telegram_id, date, streak, created_at) VALUES (?, ?, ?, unixepoch())`)
    .bind(telegram_id, date, newStreak).run();

  try {
    await db.prepare(`INSERT INTO user_daily_tasks(telegram_id, task_id, date, created_at) VALUES (?, 'checkin', ?, unixepoch())`)
      .bind(telegram_id, date).run();
  } catch(e) {
    // Ignore duplicate if old schema
  }

  await db.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`)
    .bind(reward, telegram_id).run();

  return { streak: newStreak, reward };
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

    // Check max_per_day
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

    // Insert progress - allow multiple per day
    try {
      await db.prepare(`INSERT INTO user_daily_tasks(telegram_id, task_id, date, created_at) VALUES (?, ?, ?, unixepoch())`)
        .bind(telegram_id, task_id, date).run();
    } catch(e) {
      // If old schema with PK (telegram_id, task_id, date) prevents second insert, try update or return limit
      if (e.message && e.message.includes('UNIQUE') || e.message.includes('PRIMARY')) {
        // Old table - can't insert second time, treat as limit
        if (count >= 1) {
          return { ok: false, reason: 'limit', detail: 'old_schema_needs_migration' };
        }
      }
      console.error('Insert user_daily_tasks failed', e.message);
      return { ok: false, reason: 'db_error', detail: e.message };
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
