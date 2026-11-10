// FWC CLEAN v1 - db.js
export async function initDB(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, balance REAL DEFAULT 0, wallet TEXT, referral_code TEXT, referral_by INTEGER, created_at INTEGER)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS mining_log (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, amount REAL, created_at INTEGER)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, amount REAL, fee REAL, net_amount REAL, wallet TEXT, status TEXT DEFAULT 'pending', created_at INTEGER)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS config_overrides (key TEXT PRIMARY KEY, value TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS daily_tasks (id TEXT PRIMARY KEY, title TEXT, title_ar TEXT, type TEXT, reward REAL, channel TEXT, url TEXT, max_per_day INTEGER DEFAULT 1, once INTEGER DEFAULT 0, active INTEGER DEFAULT 1)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS user_daily_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, task_id TEXT, date TEXT, created_at INTEGER)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS daily_checkins (telegram_id INTEGER, date TEXT, streak INTEGER, created_at INTEGER, PRIMARY KEY (telegram_id, date))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS founder_owners (telegram_id INTEGER PRIMARY KEY, tx_hash TEXT UNIQUE, burned_amount REAL, created_at INTEGER)`).run();
  const eco = await db.prepare(`SELECT COUNT(*) c FROM config_overrides`).first();
  if(!eco || eco.c===0){
    const d=[['mining_amount','6'],['mining_interval_ms','14400000'],['withdraw_min','1000'],['withdraw_delay_hours','24'],['withdraw_fee_percent','5']];
    for(const [k,v] of d) await db.prepare(`INSERT OR IGNORE INTO config_overrides(key,value) VALUES(?,?)`).bind(k,v).run();
  }
  const tc = await db.prepare(`SELECT COUNT(*) c FROM daily_tasks`).first();
  if(!tc || tc.c===0){
    const tasks=[
      ['checkin','Daily Check-in','تسجيل دخول يومي','checkin',0,null,null,1,0,1],
      ['ads','Watch Ads','مشاهدة إعلانات','ads',0.5,null,null,7,0,1],
      ['join_main','Join Main Channel','انضم للقناة الرئيسية','join',5,'@fwc_coin','https://t.me/fwc_coin',1,1,1],
      ['join_group','Join Group','انضم للجروب','join',5,'@fwc_coin1','https://t.me/fwc_coin1',1,1,1],
      ['youtube','Subscribe YouTube','اشترك يوتيوب','youtube',5,null,'https://youtube.com/@fwc_coin',1,1,1],
      ['x_twitter','Follow on X','تابع على X','x',5,null,'https://x.com/fwc_coin',1,1,1],
      ['invite_friend','Invite Friend','دعوة صديق','invite',2,null,null,100,0,1],
    ];
    for(const t of tasks) await db.prepare(`INSERT OR IGNORE INTO daily_tasks(id,title,title_ar,type,reward,channel,url,max_per_day,once,active) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(...t).run();
  }
}
export async function getUser(db,id){ return await db.prepare(`SELECT * FROM users WHERE telegram_id=?`).bind(id).first(); }
export async function createOrUpdateUser(db,u){
  const ex=await getUser(db,u.telegram_id);
  if(ex){ await db.prepare(`UPDATE users SET username=?, first_name=? WHERE telegram_id=?`).bind(u.username||ex.username,u.first_name||ex.first_name,u.telegram_id).run(); return await getUser(db,u.telegram_id); }
  const code='FWC'+Math.random().toString(36).slice(2,8).toUpperCase();
  await db.prepare(`INSERT INTO users(telegram_id,username,first_name,balance,referral_code,created_at) VALUES(?,?,?,?,?,unixepoch())`).bind(u.telegram_id,u.username||'',u.first_name||'',0,code).run();
  return await getUser(db,u.telegram_id);
}
export async function getConfigValue(db,key,fallback){
  const r=await db.prepare(`SELECT value FROM config_overrides WHERE key=?`).bind(key).first();
  return r? r.value : fallback;
}
export async function isFounder(db,id){
  const r=await db.prepare(`SELECT 1 FROM founder_owners WHERE telegram_id=?`).bind(id).first();
  return !!r;
}
export async function getFounderConfig(db){
  const get=async(k,f)=> (await getConfigValue(db,k,f));
  return { enabled: (await get('founder_enabled','1'))==='1', price: parseFloat(await get('founder_price','10000')), max: parseInt(await get('founder_max','500')), burnAddress: await get('founder_burn_address','EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJQ'), claimHours: parseFloat(await get('founder_claim_hours','8')), miningBonusPercent: parseFloat(await get('founder_mining_bonus','20')), founderFeePercent: parseFloat(await get('founder_fee_percent','3')) };
}
