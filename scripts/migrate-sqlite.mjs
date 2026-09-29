/**
 * 一键迁移：data/kv-store.json → SQLite store.db
 * 迁移完成会输出统计；旧 JSON 文件保留不改（可随时回退）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.KV_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'kv-store.json');

if (!fs.existsSync(FILE)) {
  console.log('未找到 kv-store.json，无需迁移（空库初始化）');
  process.exit(0);
}

const raw = fs.readFileSync(FILE, 'utf-8');
const data = JSON.parse(raw);
const entries = Object.entries(data);

const ins = db.prepare(
  'INSERT OR REPLACE INTO kv (key, value, expireAt) VALUES (?, ?, ?)'
);
const tx = db.transaction((list) => {
  for (const [k, e] of list) {
    if (!e || typeof e !== 'object') continue;
    let v = e.value;
    if (typeof v !== 'string') v = JSON.stringify(v);
    const exp = (e.expireAt && e.expireAt > 0) ? e.expireAt : 0;
    ins.run(k, v, exp);
  }
});
tx(entries);

const before = entries.length;
const after = db.prepare('SELECT COUNT(*) AS n FROM kv').get().n;
console.log(`迁移完成：JSON ${before} 键 → SQLite ${after} 行`);
console.log('旧文件保留：' + FILE);
process.exit(0);
