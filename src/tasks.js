// src/tasks.js - FWC 4.0.0 PRODUCTION
// Daily tasks + streak system + subscription verification

export const STREAK_REWARDS = { 1: 1, 2: 2, 3: 3, 4: 5, 5: 7, 6: 10, 7: 15 };
export const BONUS_WEEK = 5;

export async function getDailyTasks(db) {
  const res = await db.prepare(`SELECT * FROM daily_tasks WHERE active = 1 ORDER BY id ASC`).all();
  return res.results || [];
}

export async function getUserDailyProgress(db, telegram_id, date) {
  const res = await db.prepare(`SELECT task_id FROM user_daily_tasks WHERE telegram_id = ? AND date = ?`)
    .bind(telegram_id, date).all();
  return res.results.map(r => r.task_id);
}

export async function getCheckinStreak(db, telegram_id) {
  const row = await db.prepare(`SELECT streak FROM daily_checkins WHERE telegram_id = ? ORDER BY date DESC LIMIT 1`)
    .bind(telegram_id).first();
  return row?.streak || 0;
}

export async function hasCheckedInToday(db, telegram_id, date) {
  const row = await db.prepare(`SELECT 1 FROM daily_checkins WHERE telegram_id = ? AND date = ?`)
    .bind(telegram_id, date).first();
  return !!row;
}

export async function doCheckin(db, telegram_id, date) {
  const streak = await getCheckinStreak(db, telegram_id);
  const newStreak = streak >= 7 ? 1 : streak + 1;
  let reward = STREAK_REWARDS[newStreak] || 1;
  if (newStreak === 7) reward += BONUS_WEEK;

  await db.prepare(`INSERT OR REPLACE INTO daily_checkins(telegram_id, date, streak, created_at) VALUES (?, ?, ?, unixepoch())`)
    .bind(telegram_id, date, newStreak).run();

  await db.prepare(`INSERT OR IGNORE INTO user_daily_tasks(telegram_id, task_id, date, created_at) VALUES (?, 'checkin', ?, unixepoch())`)
    .bind(telegram_id, date).run();

  await db.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`)
    .bind(reward, telegram_id).run();

  return { streak: newStreak, reward };
}

export async function doTask(db, telegram_id, task_id, date, env) {
  const task = await db.prepare(`SELECT * FROM daily_tasks WHERE id = ? AND active = 1`).bind(task_id).first();
  if (!task) return { ok: false, reason: 'no_task' };

  // Check once-only
  if (task.once) {
    const done = await db.prepare(`SELECT 1 FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? LIMIT 1`)
      .bind(telegram_id, task_id).first();
    if (done) return { ok: false, reason: 'already_done' };
  }

  // Check max_per_day
  const todayCount = await db.prepare(`SELECT COUNT(*) as c FROM user_daily_tasks WHERE telegram_id = ? AND task_id = ? AND date = ?`)
    .bind(telegram_id, task_id, date).first();
  if (todayCount.c >= task.max_per_day) return { ok: false, reason: 'limit' };

  // 👇 التحقق من الاشتراك في القناة/الجروب
  if (task.type === 'join' && task.channel) {
    try {
      const botToken = env.BOT_TOKEN;
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${task.channel}&user_id=${telegram_id}`);
      const data = await res.json();
      if (!data.ok || !['member', 'administrator', 'creator'].includes(data.result?.status)) {
        return { ok: false, reason: 'not_subscribed' };
      }
    } catch (e) {
      return { ok: false, reason: 'verification_error' };
    }
  }

  await db.prepare(`INSERT INTO user_daily_tasks(telegram_id, task_id, date, created_at) VALUES (?, ?, ?, unixepoch())`)
    .bind(telegram_id, task_id, date).run();

  if (task.reward > 0) {
    await db.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`)
      .bind(task.reward, telegram_id).run();
  }

  const user = await db.prepare(`SELECT balance FROM users WHERE telegram_id = ?`).bind(telegram_id).first();

  return { ok: true, reward: task.reward, newBalance: user?.balance || 0 };
}
