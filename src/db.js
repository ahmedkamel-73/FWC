// src/db.js - FWC 4.0.0 PRODUCTION
// Database schema + all CRUD operations

export async function initDB(db) {
  // ========== USERS ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    language TEXT DEFAULT 'en',
    wallet TEXT,
    balance REAL DEFAULT 0,
    referral_by INTEGER,
    first_mine_at INTEGER,
    last_mine INTEGER,
    is_banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    created_at INTEGER,
    wallet_verified INTEGER DEFAULT 0,
    wallet_saved_at TEXT,
    referred_bonus_paid INTEGER DEFAULT 0
  );`).run();

  try { await db.prepare(`ALTER TABLE users ADD COLUMN referred_bonus_paid INTEGER DEFAULT 0`).run(); } catch (e) {}
  try { await db.prepare(`ALTER TABLE users ADD COLUMN last_bonus_at INTEGER`).run(); } catch (e) {}
  try { await db.prepare(`ALTER TABLE users ADD COLUMN last_mine INTEGER`).run(); } catch (e) {}

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance DESC);`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet);`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_referral ON users(referral_by);`).run();

  // ========== ADMINS ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS admins (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    role TEXT DEFAULT 'admin' CHECK(role IN ('admin','superadmin')),
    added_by INTEGER,
    created_at INTEGER NOT NULL
  );`).run();

  await db.prepare(`INSERT OR IGNORE INTO admins(telegram_id, username, first_name, role, created_at)
    VALUES (921627899, 'root', 'superadmin', 'superadmin', unixepoch())`).run();

  // ========== MINING LOG ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS mining_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    amount REAL,
    created_at INTEGER
  );`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_mining_user ON mining_log(telegram_id);`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_mining_created ON mining_log(created_at DESC);`).run();

  // ========== WITHDRAWALS ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    amount REAL,
    fee REAL DEFAULT 0,
    net_amount REAL,
    wallet TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','approved','rejected','completed')),
    tx_hash TEXT,
    reject_reason TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status);`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(telegram_id);`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wd_created ON withdrawals(created_at DESC);`).run();

  // ========== DAILY TASKS ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS daily_tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    title_ar TEXT,
    type TEXT,
    reward REAL,
    channel TEXT,
    url TEXT,
    max_per_day INTEGER DEFAULT 1,
    once INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );`).run();

  try { await db.prepare(`ALTER TABLE daily_tasks ADD COLUMN channel TEXT`).run(); } catch (e) {}

  // ========== USER DAILY TASKS ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_daily_tasks (
    telegram_id INTEGER,
    task_id TEXT,
    date TEXT,
    created_at INTEGER,
    PRIMARY KEY (telegram_id, task_id, date)
  );`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_udt_user_date ON user_daily_tasks(telegram_id, date);`).run();

  // ========== DAILY CHECKINS ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS daily_checkins (
    telegram_id INTEGER,
    date TEXT,
    streak INTEGER,
    created_at INTEGER,
    PRIMARY KEY (telegram_id, date)
  );`).run();

  // ========== CONFIG OVERRIDES ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS config_overrides (
    key TEXT PRIMARY KEY,
    value TEXT
  );`).run();

  // ========== REFERRALS LOG ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS referrals_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER,
    to_id INTEGER,
    amount REAL,
    created_at INTEGER
  );`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_ref_from ON referrals_log(from_id);`).run();

  // ========== PAYOUT BATCHES ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS payout_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT,
    count INTEGER,
    total_amount REAL,
    status TEXT DEFAULT 'processing',
    created_at INTEGER
  );`).run();

  // ========== FEES LOG ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS fees_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    withdrawal_id INTEGER,
    amount REAL,
    created_at INTEGER
  );`).run();

  // ========== ANTI-CHEAT ALERTS ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS anticheat_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT CHECK(type IN ('wallet_duplicate','ip_duplicate','suspicious_pattern')),
    telegram_ids TEXT,
    details TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','dismissed')),
    resolved_by INTEGER,
    resolved_at INTEGER,
    created_at INTEGER
  );`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_alerts_status ON anticheat_alerts(status);`).run();

  // ========== USER IP TRACKING ==========
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_ips (
    telegram_id INTEGER,
    ip TEXT,
    last_seen INTEGER,
    PRIMARY KEY (telegram_id, ip)
  );`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_ips_ip ON user_ips(ip);`).run();

  // ========== SEED DEFAULT TASKS ==========
  const count = await db.prepare(`SELECT COUNT(*) as c FROM daily_tasks`).first();
  if (count.c === 0) {
    const defaults = [
      ['checkin', 'Daily Check-in', 'تسجيل دخول يومي', 'checkin', 0, null, null, 1, 0, 1],
      ['ads', 'Watch Ads', 'مشاهدة إعلانات', 'ads', 0.5, null, null, 7, 0, 1],
      ['join_main', 'Join Main Channel', 'انضم للقناة الرئيسية', 'join', 5, '@fwc_coin', 'https://t.me/fwc_coin', 1, 1, 1],
      ['join_group', 'Join Group', 'انضم للجروب', 'join', 5, '@fwc_coin1', 'https://t.me/fwc_coin1', 1, 1, 1],
      ['youtube', 'Subscribe YouTube', 'اشترك يوتيوب', 'youtube', 5, null, 'https://youtube.com/@fwc_coin', 1, 1, 1],
      ['x_twitter', 'Follow on X', 'تابع على X', 'x', 5, null, 'https://x.com/fwc_coin', 1, 1, 1],
      ['invite_friend', 'Invite Friend', 'دعوة صديق', 'invite', 2, null, null, 100, 0, 1],
    ];
    for (const t of defaults) {
      await db.prepare(`INSERT OR IGNORE INTO daily_tasks(id,title,title_ar,type,reward,channel,url,max_per_day,once,active) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(...t).run();
    }
  }

  // ========== SEED ECONOMY DEFAULTS ==========
  const ecoCount = await db.prepare(`SELECT COUNT(*) as c FROM config_overrides`).first();
  if (ecoCount.c === 0) {
    const defaults = [
      ['mining_amount', '6'],
      ['mining_interval_ms', '14400000'],
      ['withdraw_min', '1000'],
      ['withdraw_delay_hours', '24'],
      ['withdraw_fee_percent', '5'],
      ['withdraw_hold_amount', '1000'],
      ['referral_percent', '5'],
      ['ad_enabled', '1'],
      ['ad_auto_enabled', '1'],
      ['ad_auto_block_id', ''],
      ['ad_auto_on_mine', '1'],
      ['ad_auto_on_tasks', '0'],
      ['ad_free_block_id', ''],
      ['ad_free_mult', '2'],
      ['ad_free_duration_sec', '7200'],
    ];
    for (const [k, v] of defaults) {
      await db.prepare(`INSERT OR IGNORE INTO config_overrides(key, value) VALUES (?, ?)`).bind(k, v).run();
    }
  }
}

// ========== ADMIN SYSTEM ==========
export async function isAdminDB(db, telegram_id) {
  if (!telegram_id) return false;
  if (telegram_id == 921627899) return true;
  const row = await db.prepare(`SELECT 1 FROM admins WHERE telegram_id = ?`).bind(telegram_id).first();
  if (row) return true;
  try {
    const override = await db.prepare(`SELECT value FROM config_overrides WHERE key = 'admin_ids'`).first();
    if (override?.value) {
      const ids = JSON.parse(override.value);
      if (Array.isArray(ids) && ids.includes(telegram_id)) return true;
    }
  } catch {}
  return false;
}

export async function getAllAdmins(db) {
  return (await db.prepare(`SELECT * FROM admins ORDER BY role DESC, created_at ASC`).all()).results;
}

export async function addAdminById(db, telegram_id, username, first_name, added_by) {
  if (telegram_id == 921627899) throw new Error('root already exists');
  return await db.prepare(`INSERT OR REPLACE INTO admins(telegram_id, username, first_name, role, added_by, created_at)
    VALUES (?, ?, ?, 'admin', ?, unixepoch())`).bind(telegram_id, username || null, first_name || null, added_by).run();
}

export async function removeAdmin(db, telegram_id) {
  if (telegram_id == 921627899) throw new Error('cannot delete root admin');
  return await db.prepare(`DELETE FROM admins WHERE telegram_id = ?`).bind(telegram_id).run();
}

// ========== USER CRUD ==========
export async function getUser(db, telegram_id) {
  return await db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(telegram_id).first();
}

export async function createOrUpdateUser(db, user) {
  const existing = await getUser(db, user.telegram_id);
  if (existing) {
    await db.prepare(`UPDATE users SET username = ?, first_name = ?, language = ? WHERE telegram_id = ?`)
      .bind(user.username || null, user.first_name || null, user.language || 'en', user.telegram_id).run();
  } else {
    await db.prepare(`INSERT INTO users(telegram_id, username, first_name, language, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(user.telegram_id, user.username || null, user.first_name || null, user.language || 'en', Math.floor(Date.now() / 1000)).run();
  }
}

export async function setUserLanguage(db, telegram_id, lang) {
  return await db.prepare(`UPDATE users SET language = ? WHERE telegram_id = ?`).bind(lang, telegram_id).run();
}

export async function banUser(db, telegram_id, reason = null) {
  return await db.prepare(`UPDATE users SET is_banned = 1, ban_reason = ? WHERE telegram_id = ?`).bind(reason, telegram_id).run();
}

export async function unbanUser(db, telegram_id) {
  return await db.prepare(`UPDATE users SET is_banned = 0, ban_reason = NULL WHERE telegram_id = ?`).bind(telegram_id).run();
}

// ========== CONFIG ==========
export async function getConfigOverride(db, key) {
  const row = await db.prepare(`SELECT value FROM config_overrides WHERE key = ?`).bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export async function getEconomyConfig(db, key) {
  const row = await db.prepare(`SELECT value FROM config_overrides WHERE key = ?`).bind(key).first();
  if (!row || row.value === null || row.value === '') return null;
  const num = Number(row.value);
  if (!isNaN(num) && row.value !== '') return num;
  return row.value;
}

export async function setEconomyConfig(db, key, value) {
  const strVal = value === null || value === undefined ? '' : String(value);
  return await db.prepare(`INSERT OR REPLACE INTO config_overrides(key, value) VALUES (?, ?)`).bind(key, strVal).run();
}

export async function getAllEconomyConfig(db) {
  const res = await db.prepare(`SELECT key, value FROM config_overrides`).all();
  return res.results || [];
}

export async function getAdsConfig(db) {
  const rows = await db.prepare(`SELECT key, value FROM config_overrides WHERE key LIKE 'ad_%'`).all();
  const map = {};
  for (const r of rows.results || []) map[r.key] = r.value;
  return {
    enabled: map['ad_enabled'] === '1',
    autoEnabled: map['ad_auto_enabled'] === '1',
    autoBlockId: map['ad_auto_block_id'] || '',
    autoOnMine: map['ad_auto_on_mine'] === '1',
    autoOnTasks: map['ad_auto_on_tasks'] === '1',
    freeBlockId: map['ad_free_block_id'] || '',
    freeMult: parseFloat(map['ad_free_mult']) || 2,
    freeDurationSec: parseInt(map['ad_free_duration_sec']) || 7200,
  };
}

// ========== TASKS ADMIN ==========
export async function getAllTasksAdmin(db) {
  return (await db.prepare(`SELECT * FROM daily_tasks ORDER BY id ASC`).all()).results || [];
}

export async function createTask(db, task) {
  return await db.prepare(`INSERT INTO daily_tasks(id, title, title_ar, type, reward, channel, url, max_per_day, once, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    task.id, task.title, task.title_ar || null, task.type, task.reward || 0,
    task.channel || null, task.url || null, task.max_per_day || 1,
    task.once ? 1 : 0, task.active === false ? 0 : 1
  ).run();
}

export async function updateTask(db, id, updates) {
  const task = await db.prepare(`SELECT * FROM daily_tasks WHERE id = ?`).bind(id).first();
  if (!task) return null;
  const m = { ...task, ...updates };
  return await db.prepare(`UPDATE daily_tasks SET title=?, title_ar=?, type=?, reward=?, channel=?, url=?, max_per_day=?, once=?, active=? WHERE id=?`).bind(
    m.title, m.title_ar || null, m.type, m.reward || 0, m.channel || null,
    m.url || null, m.max_per_day || 1, m.once ? 1 : 0, m.active ? 1 : 0, id
  ).run();
}

export async function deleteTask(db, id) {
  return await db.prepare(`DELETE FROM daily_tasks WHERE id = ?`).bind(id).run();
}

// ========== WITHDRAWALS ==========
export async function createWithdrawal(db, telegram_id, amount, wallet, fee, netAmount) {
  return await db.prepare(`INSERT INTO withdrawals(telegram_id, amount, fee, net_amount, wallet, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', unixepoch())`).bind(telegram_id, amount, fee, netAmount, wallet).run();
}

export async function getWithdrawalById(db, id) {
  return await db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).bind(id).first();
}

export async function approveWithdrawal(db, id) {
  return await db.prepare(`UPDATE withdrawals SET status = 'approved', updated_at = unixepoch() WHERE id = ? AND status = 'pending'`).bind(id).run();
}

export async function rejectWithdrawal(db, id, reason = null) {
  const wd = await db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).bind(id).first();
  if (!wd) return null;
  if (wd.status !== 'pending') return null;
  await db.prepare(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`).bind(wd.amount, wd.telegram_id).run();
  return await db.prepare(`UPDATE withdrawals SET status = 'rejected', reject_reason = ?, updated_at = unixepoch() WHERE id = ? AND status = 'pending'`)
    .bind(reason, id).run();
}

export async function getUserPendingWithdrawal(db, telegram_id) {
  return await db.prepare(`SELECT * FROM withdrawals WHERE telegram_id = ? AND status IN ('pending','approved','processing') LIMIT 1`).bind(telegram_id).first();
}

// ========== FEE LOG ==========
export async function logFee(db, telegram_id, withdrawal_id, amount) {
  return await db.prepare(`INSERT INTO fees_log(telegram_id, withdrawal_id, amount, created_at) VALUES (?, ?, ?, unixepoch())`)
    .bind(telegram_id, withdrawal_id, amount).run();
}

export async function getTotalFees(db, since = 0) {
  const row = await db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM fees_log WHERE created_at > ?`).bind(since).first();
  return row?.total || 0;
}

// ========== ANTI-CHEAT ==========
export async function trackUserIP(db, telegram_id, ip) {
  if (!ip || !telegram_id) return;
  await db.prepare(`INSERT OR REPLACE INTO user_ips(telegram_id, ip, last_seen) VALUES (?, ?, unixepoch())`)
    .bind(telegram_id, ip).run();
}

export async function checkWalletDuplicate(db, telegram_id, wallet) {
  if (!wallet) return { duplicate: false };
  const rows = await db.prepare(`SELECT telegram_id, username FROM users WHERE wallet = ? AND telegram_id != ? LIMIT 10`)
    .bind(wallet, telegram_id).all();
  return { duplicate: rows.results.length > 0, users: rows.results };
}

export async function checkIPDuplicate(db, telegram_id, ip) {
  if (!ip) return { duplicate: false };
  const rows = await db.prepare(`
    SELECT DISTINCT u.telegram_id, u.username 
    FROM user_ips ui 
    JOIN users u ON u.telegram_id = ui.telegram_id 
    WHERE ui.ip = ? AND ui.telegram_id != ? LIMIT 10
  `).bind(ip, telegram_id).all();
  return { duplicate: rows.results.length > 0, users: rows.results };
}

export async function createAntiCheatAlert(db, type, telegramIds, details) {
  return await db.prepare(`INSERT INTO anticheat_alerts(type, telegram_ids, details, status, created_at)
    VALUES (?, ?, ?, 'open', unixepoch())`).bind(type, JSON.stringify(telegramIds), details).run();
}

export async function getAntiCheatAlerts(db, status = 'open') {
  const rows = await db.prepare(`SELECT * FROM anticheat_alerts WHERE status = ? ORDER BY created_at DESC LIMIT 100`)
    .bind(status).all();
  return rows.results || [];
}

export async function resolveAlert(db, id, adminId) {
  return await db.prepare(`UPDATE anticheat_alerts SET status = 'resolved', resolved_by = ?, resolved_at = unixepoch() WHERE id = ?`)
    .bind(adminId, id).run();
}

export async function dismissAlert(db, id, adminId) {
  return await db.prepare(`UPDATE anticheat_alerts SET status = 'dismissed', resolved_by = ?, resolved_at = unixepoch() WHERE id = ?`)
    .bind(adminId, id).run();
}
