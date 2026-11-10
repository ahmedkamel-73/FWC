-- schema.sql - FWC 4.0.0 PRODUCTION
-- Run: wrangler d1 execute fwc-db --file=schema.sql --remote

-- ==================== USERS ====================
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  language TEXT DEFAULT 'en',
  wallet TEXT,
  balance REAL DEFAULT 0,
  referral_by INTEGER,
  referred_bonus_paid INTEGER DEFAULT 0,
  first_mine_at INTEGER,
  last_mine INTEGER,
  is_banned INTEGER DEFAULT 0,
  ban_reason TEXT,
  created_at INTEGER,
  wallet_verified INTEGER NOT NULL DEFAULT 0,
  wallet_saved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance DESC);
CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet);
CREATE INDEX IF NOT EXISTS idx_users_referral ON users(referral_by);

-- ==================== ADMINS ====================
CREATE TABLE IF NOT EXISTS admins (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  role TEXT DEFAULT 'admin' CHECK(role IN ('admin','superadmin')),
  added_by INTEGER,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO admins(telegram_id, username, first_name, role, created_at)
VALUES (921627899, 'root', 'superadmin', 'superadmin', unixepoch());

-- ==================== MINING LOG ====================
CREATE TABLE IF NOT EXISTS mining_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER,
  amount REAL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mining_user ON mining_log(telegram_id);
CREATE INDEX IF NOT EXISTS idx_mining_created ON mining_log(created_at DESC);

-- ==================== WITHDRAWALS ====================
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER,
  amount REAL,
  fee REAL DEFAULT 0,
  net_amount REAL,
  wallet TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','approved','completed','rejected')),
  tx_hash TEXT,
  reject_reason TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(telegram_id);
CREATE INDEX IF NOT EXISTS idx_wd_created ON withdrawals(created_at DESC);

-- ==================== DAILY TASKS ====================
CREATE TABLE IF NOT EXISTS daily_tasks (
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
);

-- ==================== USER DAILY TASKS ====================
CREATE TABLE IF NOT EXISTS user_daily_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER,
  task_id TEXT,
  date TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_udt_telegram_task_date ON user_daily_tasks(telegram_id, task_id, date);
CREATE INDEX IF NOT EXISTS idx_udt_user_date ON user_daily_tasks(telegram_id, date);

-- ==================== DAILY CHECKINS ====================
CREATE TABLE IF NOT EXISTS daily_checkins (
  telegram_id INTEGER,
  date TEXT,
  streak INTEGER,
  created_at INTEGER,
  PRIMARY KEY (telegram_id, date)
);

-- ==================== CONFIG OVERRIDES ====================
CREATE TABLE IF NOT EXISTS config_overrides (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ==================== REFERRALS LOG ====================
CREATE TABLE IF NOT EXISTS referrals_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER,
  to_id INTEGER,
  amount REAL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ref_from ON referrals_log(from_id);

-- ==================== PAYOUT BATCHES ====================
CREATE TABLE IF NOT EXISTS payout_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash TEXT,
  count INTEGER,
  total_amount REAL,
  status TEXT DEFAULT 'processing' CHECK(status IN ('processing','approved','completed','failed')),
  created_at INTEGER
);

-- ==================== FEES LOG ====================
CREATE TABLE IF NOT EXISTS fees_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER,
  withdrawal_id INTEGER,
  amount REAL,
  created_at INTEGER
);

-- ==================== ANTI-CHEAT ALERTS ====================
CREATE TABLE IF NOT EXISTS anticheat_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT CHECK(type IN ('wallet_duplicate','ip_duplicate','suspicious_pattern')),
  telegram_ids TEXT,
  details TEXT,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','dismissed')),
  resolved_by INTEGER,
  resolved_at INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON anticheat_alerts(status);

-- ==================== USER IP TRACKING ====================
CREATE TABLE IF NOT EXISTS user_ips (
  telegram_id INTEGER,
  ip TEXT,
  last_seen INTEGER,
  PRIMARY KEY (telegram_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_ips_ip ON user_ips(ip);

-- ==================== SEED DEFAULT TASKS ====================
INSERT OR IGNORE INTO daily_tasks(id, title, title_ar, type, reward, channel, url, max_per_day, once, active) VALUES
  ('checkin', 'Daily Check-in', 'تسجيل دخول يومي', 'checkin', 0, NULL, NULL, 1, 0, 1),
  ('ads', 'Watch Ads', 'مشاهدة إعلانات', 'ads', 0.5, NULL, NULL, 10, 0, 1),
  ('join_main', 'Join Main Channel', 'انضم للقناة الرئيسية', 'join', 5, '@fwc_coin', 'https://t.me/fwc_coin', 1, 1, 1),
  ('join_group', 'Join Group', 'انضم للجروب', 'join', 5, '@fwc_coin1', 'https://t.me/fwc_coin1', 1, 1, 1),
  ('youtube', 'Subscribe YouTube', 'اشترك يوتيوب', 'youtube', 5, NULL, 'https://youtube.com/@fwc_coin', 1, 1, 1),
  ('x_twitter', 'Follow on X', 'تابع على X', 'x', 5, NULL, 'https://x.com/fwc_coin', 1, 1, 1),
  ('invite_friend', 'Invite Friend', 'دعوة صديق', 'invite', 2, NULL, NULL, 100, 0, 1);

-- ==================== SEED ECONOMY DEFAULTS ====================
INSERT OR IGNORE INTO config_overrides(key, value) VALUES
  ('mining_amount', '6'),
  ('mining_interval_ms', '14400000'),
  ('withdraw_min', '1000'),
  ('withdraw_delay_hours', '24'),
  ('withdraw_fee_percent', '5'),
  ('withdraw_hold_amount', '1000'),
  ('referral_percent', '5'),
  ('ad_enabled', '1'),
  ('ad_auto_enabled', '1'),
  ('ad_auto_block_id', ''),
  ('ad_auto_on_mine', '1'),
  ('ad_auto_on_tasks', '0'),
  ('ad_free_block_id', ''),
  ('ad_free_mult', '2'),
  ('ad_free_duration_sec', '7200');

-- ==================== FOUNDER OWNERS (created by initDB, included here for completeness) ====================
CREATE TABLE IF NOT EXISTS founder_owners (
  telegram_id INTEGER PRIMARY KEY,
  tx_hash TEXT UNIQUE,
  burned_amount REAL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_founder_tx ON founder_owners(tx_hash);
