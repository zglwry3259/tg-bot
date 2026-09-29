/**
 * SQLite KV 存储 - 兼容 Cloudflare KV API（get / put / delete / list，带 TTL）
 * 接口与旧 JSON 版完全一致，业务代码无需改动
 */
import db from './db.js';

class KVStore {
  /**
   * 获取键值
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async get(key) {
    const row = db.prepare('SELECT value FROM kv WHERE key = ? AND (expireAt = 0 OR expireAt > ?)').get(key, Date.now());
    return row ? row.value : null;
  }

  /**
   * 存储键值
   * @param {string} key
   * @param {string} value
   * @param {{expirationTtl?: number}} options - 过期秒数
   */
  async put(key, value, options = {}) {
    let expireAt = 0;
    if (options.expirationTtl && options.expirationTtl > 0) {
      expireAt = Date.now() + options.expirationTtl * 1000;
    }
    db.prepare(
      'INSERT INTO kv (key, value, expireAt) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expireAt = excluded.expireAt'
    ).run(key, String(value), expireAt);
  }

  /**
   * 删除键
   * @param {string} key
   */
  async delete(key) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  /**
   * 列出键
   * @param {{prefix?: string}} options
   * @returns {Promise<{keys: Array<{name: string}>}>}
   */
  async list(options = {}) {
    const prefix = options.prefix || '';
    const rows = prefix
      ? db.prepare('SELECT key FROM kv WHERE key LIKE ? AND (expireAt = 0 OR expireAt > ?)').all(prefix + '%', Date.now())
      : db.prepare('SELECT key FROM kv WHERE expireAt = 0 OR expireAt > ?').all(Date.now());
    return { keys: rows.map((r) => ({ name: r.key })) };
  }
}

export const LOTTERY_KV = new KVStore();
export default LOTTERY_KV;
