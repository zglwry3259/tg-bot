/**
 * sql-impl.js — SQLite 存储实现（纯 SQL，不依赖 KV 后端）
 *
 * 设计：用【单张通用 KV 镜像表】承载原有 Cloudflare/文件 KV 的全部语义。
 *   key       TEXT PRIMARY KEY   —— 存完整 key 字符串（如 points:123 / lucky_bind:tg / verify_cfg:-100...）
 *   value     TEXT               —— 存原始字符串（业务侧 JSON.stringify 的对象也直接存原文）
 *   expire_at INTEGER            —— Unix 毫秒；NULL 表示不过期（对应 put 的 expirationTtl）
 *
 * 对外暴露与 kv-store.js 完全相同的 4 个方法（get/put/delete/list），签名一致，
 * 因此业务代码（bot.js / bot-live.js）只需把 import 换成 sql-store.js 即可零改动。
 *
 * 驱动：优先 Node 内置 node:sqlite（零安装），回退 better-sqlite3。
 *       两者同步 API（prepare/run/get/all/exec/close）完全一致，可共用一套语句。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kv_key    ON kv(key);
CREATE INDEX IF NOT EXISTS idx_kv_expire ON kv(expire_at);
`;

function initSchema(db) {
  db.exec(SCHEMA);
}

// 内置 node:sqlite（Node 22.5+ / 24）：export 名 DatabaseSync（部分版本为 Sqlite.Database，双保险）
function factoryNodeSqlite() {
  try {
    const m = require('node:sqlite');
    const Ctor = m && (m.DatabaseSync || (m.Sqlite && m.Sqlite.Database));
    if (Ctor) return { name: 'node:sqlite', open: (p) => new Ctor(p) };
  } catch { /* 无内置 → 落到 better-sqlite3 */ }
  return null;
}

// better-sqlite3（需 npm 安装；本地/服务器缺失时自动跳过）
function factoryBetter() {
  try {
    const B = require('better-sqlite3');
    if (B) return { name: 'better-sqlite3', open: (p) => new B(p) };
  } catch { /* 未安装 */ }
  return null;
}

/**
 * 打开（并初始化）一个 SQLite KV 实现。
 * @param {string} sqlPath 数据库文件路径（相对工作目录或绝对路径）
 * @returns {object} 含 get/put/delete/list/close 的实例（方法均为 async，兼容 await）
 * @throws 当无任何可用驱动时抛出
 */
export function openSql(sqlPath) {
  const driver = factoryNodeSqlite() || factoryBetter();
  if (!driver) {
    throw new Error('SQLite 驱动不可用（node:sqlite 与 better-sqlite3 均未就绪）');
  }
  const p = sqlPath || 'bot.sqlite';
  const dir = path.dirname(p);
  if (dir && dir !== '.' && dir !== '') fs.mkdirSync(dir, { recursive: true });
  const db = driver.open(p);
  initSchema(db);

  // 语句缓存
  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  return {
    driver: driver.name,
    path: p,
    db,

    close() { try { db.close && db.close(); } catch { /* ignore */ } },

    // 读取；命中且已过期则惰性删除并返回 null
    async get(key) {
      const row = prep('SELECT value, expire_at FROM kv WHERE key = ?').get(key);
      if (!row) return null;
      if (row.expire_at !== null && row.expire_at <= Date.now()) {
        prep('DELETE FROM kv WHERE key = ?').run(key);
        return null;
      }
      return row.value;
    },

    // 写入；opts.expirationTtl（秒）→ expire_at（毫秒）；无 TTL 则 expire_at = NULL
    async put(key, value, opts) {
      const ttl = opts && opts.expirationTtl;
      const expire_at = ttl ? Date.now() + Number(ttl) * 1000 : null;
      prep('INSERT INTO kv(key, value, expire_at) VALUES(?,?,?) ' +
           'ON CONFLICT(key) DO UPDATE SET value=excluded.value, expire_at=excluded.expire_at')
        .run(key, value == null ? '' : String(value), expire_at);
    },

    async delete(key) {
      prep('DELETE FROM kv WHERE key = ?').run(key);
    },

    // 前缀枚举。返回 { keys: [{ name }] }（与 Cloudflare KV list 业务侧用法一致）。
    // 说明：本地单文件小库，直接返回全部匹配 key（不做 cursor 分页）。
    async list({ prefix } = {}) {
      const p = (prefix || '').replace(/[\\%_]/g, (c) => '\\' + c);
      const rows = prep("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key").all(p + '%');
      return { keys: rows.map((r) => ({ name: r.key })) };
    },
  };
}

/**
 * 全量迁移：把一个 KV 后端的当前数据复制到 SQLite 实现。
 * 用于「首次启动自动迁移」与「VPS 手动迁移脚本」共用逻辑。
 * 幂等：同名 key 用 KV 当前值覆盖 SQL 中记录。
 * @returns {Promise<number>} 迁移的 key 数量
 */
export async function migrateFromKv(kv, impl) {
  let migrated = 0;
  let cursor;
  do {
    const args = {};
    if (cursor) args.cursor = cursor;
    const res = await kv.list(args);
    const keys = res && res.keys ? res.keys : [];
    for (const k of keys) {
      const val = await kv.get(k.name);
      if (val === null || val === undefined) continue; // KV 中已无该值则跳过
      await impl.put(k.name, val);
      migrated++;
    }
    cursor = res && res.cursor ? res.cursor : undefined;
    if (!keys.length) break; // 无分页或末页
  } while (cursor);
  return migrated;
}
