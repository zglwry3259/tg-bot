/**
 * 群组管家 - VPS 服务器入口
 * 使用 Express + 本地 JSON 存储，替代 Cloudflare Workers
 */
import 'dotenv/config';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new EnvHttpProxyAgent());
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first'); // 强制IPv4优先，避免api.telegram.org走IPv6间歇超时
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { processUpdate, runScheduledTasks } from './bot-live.js';
import * as features from './features.js';
import adminRouter from './admin.js';
import miniappRouter from './miniapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

app.use(express.json({ limit: '1mb' }));

// 健康检查
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: '群组管家 Bot',
    version: '6.7.11-server',
    uptime: process.uptime(),
    time: new Date().toISOString(),
  });
});

// Webhook 接收端点
app.post(WEBHOOK_PATH, async (req, res) => {
  // 验证 Webhook Secret（如果设置了）
  if (WEBHOOK_SECRET) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== WEBHOOK_SECRET) {
      console.warn('⚠️ 收到无效的 Webhook Secret 请求');
      return res.status(403).send('Forbidden');
    }
  }

  const update = req.body;
  if (!update || !update.update_id) {
    return res.status(400).send('Bad Request');
  }

  // 立即返回 200，异步处理更新（避免 Telegram 超时重试）
  res.status(200).send('OK');

  // 异步处理
  processUpdate(update).catch(err => {
    console.error('处理更新失败:', err);
  });
});

// ==================== Web 管理后台 ====================
// /admin 直接返回管理页面
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get('/admin/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
// 静态页面（public 目录）
app.use('/admin', express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));
// 管理后台 API
app.use('/admin', adminRouter);

// ==================== Telegram Mini App ====================
// miniapp 内部路由以 /api/* 开头，挂载到 /app 下 → /app/api/*
app.use('/app', miniappRouter);
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
app.get('/app/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
app.use('/app', express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));

// 启动服务器
const server = app.listen(PORT, () => {
  console.log('========================================');
  console.log('  🤖 群组管家 Bot 已启动');
  console.log('  📡 监听端口:', PORT);
  console.log('  🔗 Webhook 路径:', WEBHOOK_PATH);
  console.log('  💾 数据存储: SQLite (data/store.db)');
  console.log('  ⏰ 定时任务: 每分钟执行');
  console.log('========================================');
  console.log('');
  console.log('💡 首次部署请设置 Webhook:');
  console.log(`   node scripts/setWebhook.mjs <BOT_TOKEN> https://你的域名${WEBHOOK_PATH} [WEBHOOK_SECRET]`);
  console.log('');
});

// 定时任务：每分钟执行一次（替代 Cloudflare Cron）
let scheduledRunning = false;
const scheduledInterval = setInterval(async () => {
  if (scheduledRunning) return; // 防止重叠
  scheduledRunning = true;
  try {
    await runScheduledTasks();
  } catch (err) {
    console.error('定时任务执行失败:', err);
  } finally {
    scheduledRunning = false;
  }
}, 60 * 1000);

// 启动时立即执行一次定时任务（设置命令菜单等）
setTimeout(() => {
  runScheduledTasks().catch(err => {
    console.error('初始定时任务执行失败:', err);
  });
}, 3000);

// TGBot 功能调度器：定时消息 + 夜间模式（每分钟）
features.startScheduler();

// ==================== 长轮询模式（替代 Webhook，规避入站封锁）====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org:18443';

async function tgRequest(method, body) {
  const res = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    // 长轮询 timeout=25s，35s 兜底：网络挂起时快速失败，不拖垮调度
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

let polling = false;
let offset = 0;
let pollBackoff = 200;
function schedulePoll(ms) {
  setTimeout(() => {
    pollUpdates().catch(e => console.error('轮询调度异常:', e?.cause?.code || e?.message || e));
  }, ms);
}
async function pollUpdates() {
  if (polling) { schedulePoll(1000); return; }
  polling = true;
  try {
    const data = await tgRequest('getUpdates', {
      offset,
      timeout: 10,
      allowed_updates: ['message', 'channel_post', 'callback_query', 'my_chat_member', 'chat_member'],
    });
    if (data.ok && Array.isArray(data.result) && data.result.length) {
      for (const u of data.result) {
        if (u.update_id >= offset) offset = u.update_id + 1;
        processUpdate(u).catch(e => console.error('处理更新失败:', e));
      }
    } else if (!data.ok && data.description) {
      console.warn('getUpdates:', data.description);
    }
    // 成功：尽快进入下一轮长轮询；失败：指数退避，避免硬打 API
    pollBackoff = 500;
    schedulePoll(500);
  } catch (err) {
    pollBackoff = Math.min(pollBackoff * 2, 5000);
    console.warn(`getUpdates 错误: ${err?.cause?.code || err?.message || err}，${Math.round(pollBackoff / 1000)}s 后重试`);
    schedulePoll(pollBackoff);
  } finally {
    polling = false;
  }
}

// 启动时：删除 Webhook 并开启长轮询
async function initPolling() {
  try {
    const d = await tgRequest('deleteWebhook', { drop_pending_updates: false });
    console.log('📡 Webhook 已删除，启用长轮询模式:', d.ok ? 'OK' : (d.description || ''));
    if (d.ok) {
      offset = 0; // 从头拉取（含 webhook 期间积压的消息，seen 会去重）
      pollUpdates();
    }
  } catch (err) {
    console.error('deleteWebhook 失败:', err.message);
    schedulePoll(5000);
  }
}
setTimeout(initPolling, 1500);

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('\n收到 SIGTERM，正在关闭...');
  clearInterval(scheduledInterval);
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，正在关闭...');
  clearInterval(scheduledInterval);
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
