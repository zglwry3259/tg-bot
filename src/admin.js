/**
 * 群组管家 - Web 管理后台（后端路由）
 * 提供：登录认证 / 总览 / 群管理 / 频道管理 / 数据浏览 / 日志
 * 挂载路径：/admin/api/*
 */
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import LOTTERY_KV from './kv-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org';

// 会话（简单内存 session）
const sessions = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 小时

function tgApi(method, params) {
  return fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(15000),
  }).then(r => r.json()).catch(() => ({ ok: false, description: 'Telegram API 网络错误' }));
}

function auth(req, res, next) {
  const token = req.headers['x-admin-token'];
  const s = token ? sessions.get(token) : null;
  if (!s || s.expires < Date.now()) {
    if (s) sessions.delete(token);
    return res.status(401).json({ ok: false, error: '未登录或会话已过期' });
  }
  next();
}

function execCmd(cmd) {
  return new Promise(resolve => {
    exec(cmd, { timeout: 10000 }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').trim() });
    });
  });
}

// 解析公告按钮文本 → inline_keyboard 数组（名称-链接，&& 分隔，多行=多行）
function parseAnnounceButtons(input) {
  if (Array.isArray(input) && input.length) return input;
  if (typeof input !== 'string' || !input.trim()) return null;
  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  const keyboard = [];
  for (const line of lines) {
    const items = line.split('&&').map(s => s.trim()).filter(Boolean);
    if (!items.length) continue;
    const row = [];
    for (const item of items) {
      const clean = item.replace(/^#(p|r|g|D)\s*/i, '').trim();
      if (!clean) continue;
      const dash = clean.indexOf('-');
      if (dash <= 0) return null;
      const name = clean.slice(0, dash).trim();
      let url = clean.slice(dash + 1).trim();
      if (/^@[A-Za-z0-9_]{3,}$/.test(url)) url = `https://t.me/${url.slice(1)}`;
      else if (/^t\.me\/[A-Za-z0-9_]+$/.test(url)) url = `https://${url}`;
      if (!name || !/^https?:\/\//i.test(url)) return null;
      row.push({ text: name, url });
    }
    if (row.length) keyboard.push(row);
  }
  if (!keyboard.length) return null;
  return keyboard;
}

// 统计 KV 中某前缀的键数量
async function countPrefix(prefix) {
  const r = await LOTTERY_KV.list({ prefix });
  return (r.keys || []).length;
}

// ==================== 认证 ====================

router.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ ok: false, error: '服务器未设置 ADMIN_PASSWORD' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: '密码错误' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { expires: Date.now() + SESSION_TTL });
  res.json({ ok: true, token });
});

router.post('/api/logout', auth, (req, res) => {
  const token = req.headers['x-admin-token'];
  sessions.delete(token);
  res.json({ ok: true });
});

// ==================== 总览 ====================

router.get('/api/overview', auth, async (req, res) => {
  try {
    const [me, wh] = await Promise.all([
      tgApi('getMe', {}),
      tgApi('getWebhookInfo', {}),
    ]);
    const groups = await countPrefix('bot_groups');
    const channels = await countPrefix('bot_channels');
    const lotteries = await countPrefix('lottery:');
    const bannedCfgs = await countPrefix('banned:');
    const welcomeCfgs = await countPrefix('welcome_cfg:');
    const btnCfgs = await countPrefix('btn:');
    const bannedLogs = await countPrefix('banned_log:');
    const verifyCfgs = await countPrefix('verify_cfg:');
    const pendingVerify = await countPrefix('verify_pending:');

    // 数据文件信息
    const dataFile = path.join(__dirname, '..', 'data', 'kv-store.json');
    let dataSize = 0;
    try { dataSize = fs.statSync(dataFile).size; } catch {}

    // 服务器状态
    const mem = os.totalmem();
    const df = await execCmd('df -h / | tail -1');
    const dfParts = (df.out || '').split(/\s+/);
    const disk = dfParts.length >= 5 ? { used: dfParts[2], avail: dfParts[3], use: dfParts[4] } : null;

    res.json({
      ok: true,
      bot: {
        username: me.ok ? me.result.username : null,
        name: me.ok ? me.result.first_name : null,
        online: !!me.ok,
        webhook: wh.ok ? wh.result.url : null,
        pendingCount: wh.ok ? wh.result.pending_update_count : null,
        lastError: wh.ok ? wh.result.last_error_message : null,
      },
      stats: {
        groups, channels, lotteries, bannedCfgs, welcomeCfgs, btnCfgs, bannedLogs, verifyCfgs, pendingVerify,
        kvTotal: (await LOTTERY_KV.list({})).keys.length,
        dataSize,
      },
      server: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptime: Math.floor(os.uptime()),
        memTotalMB: Math.round(mem / 1024 / 1024),
        memFreeMB: Math.round(os.freemem() / 1024 / 1024),
        memUsedMB: Math.round((mem - os.freemem()) / 1024 / 1024),
        disk,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== 群 / 频道列表 ====================

router.get('/api/chats', auth, async (req, res) => {
  try {
    const groupsRaw = await LOTTERY_KV.get('bot_groups');
    const channelsRaw = await LOTTERY_KV.get('bot_channels');
    const groups = groupsRaw ? JSON.parse(groupsRaw) : [];
    const channels = channelsRaw ? JSON.parse(channelsRaw) : [];
    res.json({ ok: true, groups, channels });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== 数据浏览 ====================

router.get('/api/data', auth, async (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    const list = await LOTTERY_KV.list({ prefix });
    const keys = (list.keys || []).map(k => k.name).sort();
    const items = [];
    for (const key of keys) {
      const raw = await LOTTERY_KV.get(key);
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch {}
      items.push({ key, value: parsed });
    }
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== 操作 ====================

function isAdminStatus(s) { return s === 'creator' || s === 'administrator'; }

async function getAllPermissions(whole) {
  return {
    can_send_messages: whole, can_send_audios: whole, can_send_documents: whole,
    can_send_photos: whole, can_send_videos: whole, can_send_video_notes: whole,
    can_send_voice_notes: whole, can_send_polls: whole, can_send_other_messages: whole,
    can_add_web_page_previews: whole, can_change_info: whole, can_invite_users: whole, can_pin_messages: whole,
  };
}

// 封禁/禁言名单记录
async function getBannedLog(groupId) {
  const raw = await LOTTERY_KV.get(`banned_log:${groupId}`);
  if (!raw) return [];
  try { const l = JSON.parse(raw); return Array.isArray(l) ? l : []; } catch { return []; }
}
async function addBannedLog(groupId, userId, name, type) {
  const log = await getBannedLog(groupId);
  const idx = log.findIndex(x => String(x.id) === String(userId));
  if (idx >= 0) log.splice(idx, 1);
  log.unshift({ id: userId, name: name || `用户${userId}`, at: Date.now(), type: type || 'ban' });
  if (log.length > 50) log.length = 50;
  await LOTTERY_KV.put(`banned_log:${groupId}`, JSON.stringify(log));
}
async function removeBannedLog(groupId, userId) {
  const log = await getBannedLog(groupId);
  const idx = log.findIndex(x => String(x.id) === String(userId));
  if (idx >= 0) { log.splice(idx, 1); await LOTTERY_KV.put(`banned_log:${groupId}`, JSON.stringify(log)); }
}

// 获取群成员状态（用于显示昵称）
async function getMemberName(chatId, userId) {
  const r = await tgApi('getChatMember', { chat_id: chatId, user_id: userId });
  if (r.ok && r.result?.user) {
    const u = r.result.user;
    return u.username ? `@${u.username}` : (u.first_name || `用户${userId}`);
  }
  return null;
}

router.post('/api/action', auth, async (req, res) => {
  const { action, chatId, userId, minutes, text, key, value, name } = req.body || {};
  try {
    if (action === 'ban') {
      const r = await tgApi('banChatMember', { chat_id: chatId, user_id: userId });
      if (r.ok) await addBannedLog(chatId, userId, name || await getMemberName(chatId, userId) || `用户${userId}`, 'ban');
      return res.json({ ok: r.ok, message: r.ok ? '已封禁并移出群' : (r.description || '封禁失败') });
    }
    if (action === 'unban') {
      const r = await tgApi('unbanChatMember', { chat_id: chatId, user_id: userId });
      if (r.ok) await removeBannedLog(chatId, userId);
      return res.json({ ok: r.ok, message: r.ok ? '已解除封禁（对方需重新加入群组）' : (r.description || '解封失败') });
    }
    if (action === 'mute') {
      const until = Math.floor(Date.now() / 1000) + (minutes || 60) * 60;
      const r = await tgApi('restrictChatMember', { chat_id: chatId, user_id: userId, permissions: await getAllPermissions(false), until_date: until });
      if (r.ok) await addBannedLog(chatId, userId, name || await getMemberName(chatId, userId) || `用户${userId}`, 'mute');
      return res.json({ ok: r.ok, message: r.ok ? `已禁言 ${minutes || 60} 分钟` : (r.description || '禁言失败') });
    }
    if (action === 'unmute') {
      const r = await tgApi('restrictChatMember', { chat_id: chatId, user_id: userId, permissions: await getAllPermissions(true) });
      if (r.ok) await removeBannedLog(chatId, userId);
      return res.json({ ok: r.ok, message: r.ok ? '已解除禁言' : (r.description || '解除失败') });
    }
    if (action === 'kick') {
      const r = await tgApi('banChatMember', { chat_id: chatId, user_id: userId });
      if (r.ok) await tgApi('unbanChatMember', { chat_id: chatId, user_id: userId });
      return res.json({ ok: r.ok, message: r.ok ? '已移出群聊' : (r.description || '操作失败') });
    }
    if (action === 'announce') {
      if (!text) return res.json({ ok: false, message: '公告内容不能为空' });
      // 附带按钮：优先用传入的 buttons，否则自动读取该聊天室已配置的自动按钮（btn:<id>）
      let keyboard = parseAnnounceButtons(req.body.buttons);
      if (!keyboard) {
        const btnRaw = await LOTTERY_KV.get(`btn:${chatId}`);
        if (btnRaw) {
          try {
            const bcfg = JSON.parse(btnRaw);
            if (bcfg && bcfg.keyboard && bcfg.keyboard.length && bcfg.mode !== 'reply') keyboard = bcfg.keyboard;
          } catch (e) {}
        }
      }
      const sent = await tgApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
      if (sent.ok) {
        await tgApi('pinChatMessage', { chat_id: chatId, message_id: sent.result.message_id, disable_notification: true });
      }
      return res.json({ ok: sent.ok, message: sent.ok ? (keyboard ? '公告已发送并置顶（附带按钮）' : '公告已发送并置顶') : (sent.description || '发送失败') });
    }
    if (action === 'saveConfig') {
      if (!key) return res.json({ ok: false, message: '缺少 key' });
      await LOTTERY_KV.put(key, typeof value === 'string' ? value : JSON.stringify(value));
      return res.json({ ok: true, message: '配置已保存' });
    }
    if (action === 'deleteKey') {
      if (!key) return res.json({ ok: false, message: '缺少 key' });
      await LOTTERY_KV.delete(key);
      return res.json({ ok: true, message: `已删除 ${key}` });
    }
    return res.json({ ok: false, message: '未知操作' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== 日志 ====================

router.get('/api/logs', auth, async (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  const r = await execCmd(`journalctl -u tg-bot --no-pager -n ${Math.min(lines, 500)} 2>/dev/null | tail -${Math.min(lines, 500)}`);
  res.json({ ok: true, logs: r.out });
});

export default router;
