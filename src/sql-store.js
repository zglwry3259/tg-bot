/**
 * sql-store.js — SQLite 存储门面（facade），供 bot.js / bot-live.js 作为 LOTTERY_KV 使用
 *
 * 与 kv-store.js 暴露【完全相同】的接口：get / put / delete / list。
 *   import LOTTERY_KV from './sql-store.js'   // 替换原 import './kv-store.js'，业务代码零改动
 *
 * 行为（对应既定策略）：
 *   1) 优先加载 SQLite（内置 node:sqlite → 回退 better-sqlite3）。
 *   2) 【driver 不可用 / 建库失败】→ 静默回退到 kv-store.js（原 KV），整进程降级，不崩溃。
 *   3) 运行期某次 SQL 读写异常（损坏、锁、磁盘满等）→ 该次操作回退 KV，保证可用性。
 *   4) 首次启动且 SQL 表为空、KV 有数据 → 自动把 KV 数据全量迁入 SQL（幂等，已迁过则跳过）。
 *
 * 环境变量（可选）：
 *   BOT_SQL_PATH      数据库文件路径（默认 ./bot.sqlite）
 *   BOT_SQL_DISABLE   =1 时强制只用 KV（等价于"不能装就算了"直接走 KV）
 *   BOT_SQL_AUTOMIGRATE =0 时关闭"首次自动迁移"（默认开启）
 */
import KV from './kv-store.js';                 // 原 KV 后端（回退目标）
import { openSql, migrateFromKv } from './sql-impl.js';

const SQL_PATH = process.env.BOT_SQL_PATH || 'bot.sqlite';
const DISABLE = process.env.BOT_SQL_DISABLE === '1';
const AUTOMIGRATE = process.env.BOT_SQL_AUTOMIGRATE !== '0';

// 打开 SQLite；任何失败都返回 null（交给 KV 兜底）
let sql = null;
if (!DISABLE) {
  try {
    sql = openSql(SQL_PATH);
    // 首次自动迁移（仅当 SQL 表为空而 KV 有数据时）
    if (AUTOMIGRATE) {
      const probe = await sql.list({});
      if (probe && probe.keys && probe.keys.length === 0) {
        const kvProbe = await KV.list({});
        if (kvProbe && kvProbe.keys && kvProbe.keys.length > 0) {
          const n = await migrateFromKv(KV, sql);
          console.log(`[sql-store] 首次自动迁移 KV→SQLite 完成，共 ${n} 个 key`);
        }
      }
    }
    console.log(`[sql-store] 使用 SQLite（${sql.driver}）: ${sql.path}`);
  } catch (e) {
    console.warn('[sql-store] SQLite 初始化失败，回退到 KV:', e && e.message ? e.message : e);
    sql = null;
  }
} else {
  console.log('[sql-store] BOT_SQL_DISABLE=1，使用 KV');
}

// facade：SQL 可用走 SQL，否则（或该次 SQL 抛错）走 KV
const kvGet = KV.get.bind(KV);
const kvPut = KV.put.bind(KV);
const kvDelete = KV.delete.bind(KV);
const kvList = KV.list.bind(KV);

const store = {
  // 当前生效的存储后端（'sql' | 'kv'），便于诊断
  backend: () => (sql ? 'sql' : 'kv'),

  async get(key) {
    if (sql) { try { return await sql.get(key); } catch (e) { console.warn('[sql-store] get 失败回退 KV:', e && e.message); } }
    return kvGet(key);
  },

  async put(key, value, opts) {
    if (sql) { try { await sql.put(key, value, opts); return; } catch (e) { console.warn('[sql-store] put 失败回退 KV:', e && e.message); } }
    return kvPut(key, value, opts);
  },

  async delete(key) {
    if (sql) { try { await sql.delete(key); return; } catch (e) { console.warn('[sql-store] delete 失败回退 KV:', e && e.message); } }
    return kvDelete(key);
  },

  async list(opts) {
    if (sql) { try { return await sql.list(opts); } catch (e) { console.warn('[sql-store] list 失败回退 KV:', e && e.message); } }
    return kvList(opts);
  },
};

// 同时提供 default 与具名导出，兼容两种导入写法：
//   import LOTTERY_KV from './sql-store.js'         （default，bot.js）
//   import { LOTTERY_KV } from './sql-store.js'    （具名，lucky.js / features.js）
export default store;
export const LOTTERY_KV = store;
