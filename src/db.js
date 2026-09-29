/**
 * SQLite 数据库统一入口
 * 存储：/opt/tg-group-bot/data/store.db (WAL 模式)
 * 表：
 *  - kv                   兼容旧 KV 的全部数据（抽奖/公告/群管/MiniApp 会话等）
 *  - scheduled_messages   定时消息（TGBot 功能）
 *  - keyword_replies      关键词自动回复（TGBot 功能）
 *  - member_stats         成员积分/发言统计（TGBot 功能）
 *  - chat_syncs           频道/群同步转发（TGBot 功能）
 *  - group_settings       群/频道功能配置（夜间模式/新成员限制/反垃圾等）
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.KV_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'store.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  expireAt INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId INTEGER NOT NULL,
  chatType TEXT NOT NULL DEFAULT 'group',
  text TEXT NOT NULL,
  intervalMinutes INTEGER NOT NULL DEFAULT 60,
  nextRunAt INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  reply TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS member_stats (
  chatId INTEGER NOT NULL,
  userId INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  totalMsgs INTEGER NOT NULL DEFAULT 0,
  todayMsgs INTEGER NOT NULL DEFAULT 0,
  todayDate TEXT NOT NULL DEFAULT '',
  lastSignin TEXT NOT NULL DEFAULT '',
  lastActive INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chatId, userId)
);

CREATE TABLE IF NOT EXISTS chat_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceChatId INTEGER NOT NULL,
  targetChatIds TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_settings (
  chatId INTEGER PRIMARY KEY,
  cfg TEXT NOT NULL DEFAULT '{}',
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS member_counts (
  chatId INTEGER NOT NULL,
  date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chatId, date)
);
`);

// 兼容旧库：补充新列（已存在则忽略）
try { db.exec('ALTER TABLE member_stats ADD COLUMN todayMsgs INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE member_stats ADD COLUMN todayDate TEXT NOT NULL DEFAULT \'\''); } catch (e) {}

// 定期清理过期 KV（每 5 分钟）
setInterval(() => {
  try { db.prepare('DELETE FROM kv WHERE expireAt > 0 AND expireAt < ?').run(Date.now()); } catch (e) {}
}, 5 * 60 * 1000).unref();

export default db;

// 抽奖中心绑定表
db.exec(`
CREATE TABLE IF NOT EXISTS lucky_bindings (
  userId INTEGER PRIMARY KEY,
  luckyUsername TEXT NOT NULL,
  boundAt INTEGER NOT NULL
);
`);
