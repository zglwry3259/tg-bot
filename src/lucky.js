import { db } from './db.js';
import { LOTTERY_KV } from './sql-store.js';
import { grantToMmwx } from './mmwx-grant.js';

// 初始化表
db.exec(`
CREATE TABLE IF NOT EXISTS lucky_users (
  tg_id TEXT PRIMARY KEY,
  points INTEGER DEFAULT 0,
  draw_left INTEGER DEFAULT 0,
  total_draws INTEGER DEFAULT 0,
  last_signin TEXT,
  sign_chance INTEGER DEFAULT 1,
  inventory TEXT DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lucky_prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  icon TEXT,
  type TEXT,
  value TEXT,
  probability INTEGER,
  description TEXT
);
`);

// 默认奖品
const defaultPrizes = [
  { name: '5G流量', icon: '📦', type: 'traffic', value: '5G', probability: 30, description: '5GB流量' },
  { name: '10G流量', icon: '📦', type: 'traffic', value: '10G', probability: 20, description: '10GB流量' },
  { name: '30G流量', icon: '📦', type: 'traffic', value: '30G', probability: 10, description: '30GB流量' },
  { name: '1天时长', icon: '⏰', type: 'days', value: '1', probability: 20, description: '1天会员时长' },
  { name: '3天时长', icon: '⏰', type: 'days', value: '3', probability: 10, description: '3天会员时长' },
  { name: '10积分', icon: '💰', type: 'points', value: '10', probability: 10, description: '10积分' },
];

// 初始化奖品表
const count = db.prepare('SELECT COUNT(*) as c FROM lucky_prizes').get().c;
if (count === 0) {
  const insert = db.prepare('INSERT INTO lucky_prizes (name, icon, type, value, probability, description) VALUES (?, ?, ?, ?, ?, ?)');
  for (const p of defaultPrizes) {
    insert.run(p.name, p.icon, p.type, p.value, p.probability, p.description);
  }
}

function getUser(tgId, username = '') {
  let u = db.prepare('SELECT * FROM lucky_users WHERE tg_id = ?').get(tgId);
  if (!u) {
    db.prepare('INSERT INTO lucky_users (tg_id, username) VALUES (?, ?)').run(tgId, username);
    u = db.prepare('SELECT * FROM lucky_users WHERE tg_id = ?').get(tgId);
  } else if (username && u.username !== username) {
    db.prepare('UPDATE lucky_users SET username = ? WHERE tg_id = ?').run(username, tgId);
  }
  return {
    points: u.points,
    drawLeft: u.draw_left,
    totalDraws: u.total_draws,
    lastSignin: u.last_signin,
    signChance: u.sign_chance,
    inventory: JSON.parse(u.inventory || '[]'),
  };
}

const NO_RECORD_MSG = '❌ 未找到你的账号记录。请先私聊我（发送任意消息即可完成初始化），再回群使用签到/抽奖功能。';
// 只查不建：无记录返回 null（用于判断是否私聊过 bot）
function findUser(tgId, username = '') {
  const u = db.prepare('SELECT * FROM lucky_users WHERE tg_id = ?').get(tgId);
  if (u && username && u.username !== username) {
    db.prepare('UPDATE lucky_users SET username = ? WHERE tg_id = ?').run(username, tgId);
    u.username = username;
  }
  return u;
}
// 私聊/任意交互时自动建档：无记录则创建
export function ensureUser(tgId, username = '') {
  const u = findUser(tgId, username);
  if (u) return { ok: true, created: false };
  db.prepare('INSERT INTO lucky_users (tg_id, username) VALUES (?, ?)').run(tgId, username);
  return { ok: true, created: true };
}

function saveUser(tgId, u) {
  db.prepare(`UPDATE lucky_users SET
    points = ?, draw_left = ?, total_draws = ?, last_signin = ?, sign_chance = ?, inventory = ?
    WHERE tg_id = ?`).run(
    u.points, u.drawLeft, u.totalDraws, u.lastSignin, u.signChance, JSON.stringify(u.inventory), tgId
  );
}

export async function checkin(tgId, username = "") {
  if (!findUser(tgId, username)) return { ok: false, needPrivate: true, error: NO_RECORD_MSG };
  const today = new Date().toISOString().slice(0, 10);
  const u = getUser(tgId);
  if (u.lastSignin === today) {
    return { ok: false, error: '今天已经签到过了，明天再来吧！' };
  }

  // 判定是否中奖
  const roll = Math.random() * 100;
  const gotDraw = roll < u.signChance;

  if (gotDraw) {
    u.drawLeft += 1;
    u.totalDraws += 1;
    u.signChance = 1; // 重置概率
  } else {
    // 概率增加 0~3 随机（保留 1 位小数）
    u.signChance = Math.min(100, +(u.signChance + Math.random() * 3).toFixed(1));
  }

  u.points += 10; // 签到送10积分
  u.lastSignin = today;
  saveUser(tgId, u);

  return {
    ok: true,
    points: u.points,
    drawLeft: u.drawLeft,
    gotDraw,
    nextProb: u.signChance,
  };
}

export async function draw(tgId, count = 1, username = "") {
  if (!findUser(tgId, username)) return { ok: false, needPrivate: true, error: NO_RECORD_MSG };
  const u = getUser(tgId);
  if (u.drawLeft < count) {
    return { ok: false, error: '抽奖次数不足！当前剩余：' + u.drawLeft };
  }

  u.drawLeft -= count;
  const prizes = db.prepare('SELECT * FROM lucky_prizes').all();
  const results = [];

  for (let i = 0; i < count; i++) {
    const roll = Math.random() * 100;
    let acc = 0;
    let won = prizes[0];
    for (const p of prizes) {
      acc += p.probability;
      if (roll < acc) {
        won = p;
        break;
      }
    }

    // 处理不同类型
    if (won.type === 'draw') {
      u.drawLeft += parseInt(won.value, 10);
    } else if (won.type === 'points') {
      u.points += parseInt(won.value, 10);
    } else if (won.type !== 'none') {
      // 其他类型（流量、时长）加到背包
      const existing = u.inventory.find(x => x.name === won.name);
      if (existing) {
        existing.count += 1;
      } else {
        u.inventory.push({ name: won.name, icon: won.icon, type: won.type, value: won.value, count: 1 });
      }
    }
    // 谢谢参与不加东西

    results.push({ name: won.name, icon: won.icon, count: 1 });
  }

  saveUser(tgId, u);
  return { ok: true, prizes: results, drawLeft: u.drawLeft };
}

export async function listPrizes() {
  return db.prepare('SELECT * FROM lucky_prizes').all();
}

export async function getUserBag(tgId) {
  if (!findUser(tgId)) return { ok: false, needPrivate: true, error: NO_RECORD_MSG };
  const u = getUser(tgId);
  return { ok: true, points: u.points, drawLeft: u.drawLeft, inventory: u.inventory };
}

export async function bindMmwx(tgId, username) {
  await LOTTERY_KV.put('mmwx_bind:' + tgId, username);
  return { ok: true, username };
}

export async function getMmwxBind(tgId) {
  return await LOTTERY_KV.get('mmwx_bind:' + tgId);
}

export async function exchangeItem(tgId, itemName) {
  if (!findUser(tgId)) return { ok: false, needPrivate: true, error: NO_RECORD_MSG };
  const u = getUser(tgId);
  itemName = itemName.toLowerCase();
  const idx = u.inventory.findIndex(i => i.name.toLowerCase() === itemName);
  if (idx === -1) return { ok: false, error: '背包里没有这个物品' };

  const item = u.inventory[idx];
  if (item.type === 'points') {
    u.points += parseInt(item.value, 10);
    item.count -= 1;
    if (item.count <= 0) u.inventory.splice(idx, 1);
    saveUser(tgId, u);
    return { ok: true, item };
  }

  // 流量/时长：直连 mmwx 面板发放到绑定账号（脱离抽奖中心，发放成功才扣背包）
  const mmwxName = await getMmwxBind(tgId);
  if (!mmwxName) return { ok: false, error: '❌ 请先私聊发送 /bindmmwx 你的mmwx用户名 绑定账号，再兑换流量/时长。' };

  const gb = item.type === 'traffic' ? (parseInt(item.value, 10) || 0) : 0;
  const days = item.type === 'days' ? (parseInt(item.value, 10) || 0) : 0;
  const r = await grantToMmwx(mmwxName, { type: item.type, gb, days });

  if (!r || r.ok === false) {
    const err = (r && r.error) || '发放失败';
    return { ok: false, error: '❌ 发放失败：' + err + '\n（背包物品未扣除，可稍后重试 /exchange ' + itemName + '）' };
  }

  item.count -= 1;
  if (item.count <= 0) u.inventory.splice(idx, 1);
  saveUser(tgId, u);

  return { ok: true, item, granted: true, message: r.message };
}

// 管理员功能
export function findUserByUsername(username) {
  username = username.replace(/^@/, "").toLowerCase();
  const u = db.prepare("SELECT * FROM lucky_users WHERE LOWER(username) = ?").get(username);
  if (!u) return null;
  return u.tg_id;
}

export function adminListUsers() {
  const rows = db.prepare('SELECT * FROM lucky_users ORDER BY created_at DESC').all();
  return rows.map(r => ({
    tgId: r.tg_id,
    points: r.points,
    drawLeft: r.draw_left,
    totalDraws: r.total_draws,
    inventory: JSON.parse(r.inventory || '[]'),
  }));
}

export function adminGrantPoints(tgId, amount) {
  const u = getUser(tgId);
  u.points += amount;
  saveUser(tgId, u);
  return { ok: true, points: u.points };
}

export function adminGrantDraws(tgId, count) {
  const u = getUser(tgId);
  u.drawLeft += count;
  saveUser(tgId, u);
  return { ok: true, drawLeft: u.drawLeft };
}

export function adminGrantItem(tgId, itemName, count = 1) {
  const u = getUser(tgId);
  const prize = db.prepare('SELECT * FROM lucky_prizes WHERE name = ?').get(itemName);
  if (!prize) return { ok: false, error: '奖品不存在' };
  const existing = u.inventory.find(i => i.name === itemName);
  if (existing) {
    existing.count += count;
  } else {
    u.inventory.push({ name: prize.name, icon: prize.icon, type: prize.type, value: prize.value, count });
  }
  saveUser(tgId, u);
  return { ok: true, inventory: u.inventory };
}
