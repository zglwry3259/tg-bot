/**
 * 群组管家 - Telegram Mini App 后端
 * 挂载 /app/api/*
 * 功能：Telegram WebApp initData 鉴权、管理员（群管/频道/公告/抽奖）、用户自助（待兑奖/警告/参与抽奖/入群验证）
 */
import express from 'express';
import crypto from 'crypto';
import LOTTERY_KV from './kv-store.js';
import * as features from './features.js';

const router = express.Router();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org:18443';
const ADMIN_IDS = (process.env.BOT_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_USERNAMES = (process.env.BOT_ADMIN_USERNAMES || '').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
const DEV_KEY = process.env.MINIAPP_DEV_KEY || '';

// 管理密码登录会话：tgId -> expires（7 天）
const adminSessions = new Map();
const ADMIN_SESSION_TTL = 7 * 24 * 3600 * 1000;

/* ================= Telegram API ================= */
async function tgApi(method, params) {
  const r = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  }).catch(() => null);
  if (!r) return { ok: false, description: 'Telegram API 网络错误' };
  try { return await r.json(); } catch { return { ok: false, description: 'Telegram API 响应异常' }; }
}

/* ================= initData 校验 ================= */
function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  const pairs = [];
  for (const [k, v] of params.entries()) if (k !== 'hash') pairs.push([k, v]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataStr = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  try {
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataStr).digest('hex');
    if (calc !== hash) return null;
  } catch { return null; }
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch {}
  if (!user || !user.id) return null;
  // 防重放：auth_date 允许 48 小时内
  const authDate = parseInt(params.get('auth_date'), 10);
  if (authDate && (Date.now() / 1000 - authDate) > 48 * 3600) return null;
  return user;
}

/** 开发调试用户（仅当 .env 配置 MINIAPP_DEV_KEY 且请求头匹配） */
function devUser(req) {
  if (!DEV_KEY) return null;
  if (req.headers['x-miniapp-dev'] !== DEV_KEY) return null;
  const uid = parseInt((req.query && req.query.uid) || (req.body && req.body.uid) || '0', 10);
  if (!uid) return null;
  return { id: uid, username: (req.query && req.query.username) || `dev${uid}`, first_name: `开发测试${uid}` };
}

function authUser(req) {
  const dev = devUser(req);
  if (dev) return dev;
  const initData = req.method === 'GET' ? (req.query && req.query.initData) : ((req.body && req.body.initData) || '');
  return verifyInitData(initData);
}

async function isTgAdmin(userId, username) {
  const uid = String(userId);
  if (ADMIN_IDS.includes(uid)) return true;
  if (ADMIN_USERNAMES.includes(String(username || '').toLowerCase())) return true;
  if ((adminSessions.get(uid) || 0) > Date.now()) return true;
  try {
    const raw = await LOTTERY_KV.get('bot_admins');
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.some(a => String(a.id) === uid)) return true;
    }
  } catch {}
  return false;
}

function needAuth(req, res, next) {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Telegram 身份验证失败，请在 Telegram 内打开' });
  req.tgUser = u;
  next();
}

async function needAdmin(req, res, next) {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Telegram 身份验证失败，请在 Telegram 内打开' });
  req.tgUser = u;
  if (!(await isTgAdmin(u.id, u.username))) return res.status(403).json({ ok: false, error: '无管理员权限' });
  next();
}

/* ================= 工具 ================= */
async function countPrefix(prefix) {
  const r = await LOTTERY_KV.list({ prefix });
  return (r.keys || []).length;
}

function isAdminStatus(s) { return s === 'creator' || s === 'administrator'; }

function allPermissions(whole) {
  return {
    can_send_messages: whole, can_send_audios: whole, can_send_documents: whole,
    can_send_photos: whole, can_send_videos: whole, can_send_video_notes: whole,
    can_send_voice_notes: whole, can_send_polls: whole, can_send_other_messages: whole,
    can_add_web_page_previews: whole, can_change_info: whole, can_invite_users: whole, can_pin_messages: whole,
  };
}

// 解析公告按钮文本 → inline_keyboard
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
  return keyboard.length ? keyboard : null;
}

// 解析目标用户：数字 ID 或 @username（username 尝试通过已有记录解析）
async function resolveTarget(chatId, raw) {
  const input = String(raw || '').trim();
  if (!input) return null;
  if (/^\d+$/.test(input)) return { userId: parseInt(input, 10), name: null };
  const name = input.replace(/^@/, '').toLowerCase();
  // 从该群警告/封禁记录中按用户名匹配
  const keys = await LOTTERY_KV.list({ prefix: `warns:${chatId}:` });
  for (const k of (keys.keys || [])) {
    const uid = k.name.split(':').pop();
    const memberName = await tgApi('getChatMember', { chat_id: chatId, user_id: parseInt(uid, 10) });
    const u = memberName.ok ? memberName.result.user : null;
    if (u && String(u.username || '').toLowerCase() === name) return { userId: parseInt(uid, 10), name: u.username || u.first_name };
  }
  const logRaw = await LOTTERY_KV.get(`banned_log:${chatId}`);
  if (logRaw) {
    try {
      const list = JSON.parse(logRaw);
      const hit = list.find(x => String(x.name || '').replace(/^@/, '').toLowerCase() === name);
      if (hit) return { userId: parseInt(hit.id, 10), name: hit.name };
    } catch {}
  }
  return { userId: null, name: name };
}

/* ================= 鉴权 ================= */
router.post('/api/auth', async (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Telegram 身份验证失败，请在 Telegram 内打开' });
  const isAdmin = await isTgAdmin(u.id, u.username);
  res.json({
    ok: true,
    user: { id: u.id, username: u.username || '', first_name: u.first_name || '', photo_url: u.photo_url || '' },
    isAdmin,
  });
});

// 管理员密码登录（绑定 TG 身份，7 天有效，并记入 bot_admins）
router.post('/api/admin-login', needAuth, async (req, res) => {
  const pw = (req.body && req.body.password) || '';
  if (!ADMIN_PASSWORD || pw !== ADMIN_PASSWORD) {
    return res.status(403).json({ ok: false, error: '管理密码错误' });
  }
  adminSessions.set(String(req.tgUser.id), Date.now() + ADMIN_SESSION_TTL);
  try {
    const raw = await LOTTERY_KV.get('bot_admins');
    let list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];
    if (!list.some(a => String(a.id) === String(req.tgUser.id))) {
      list.push({ id: req.tgUser.id, name: req.tgUser.username || req.tgUser.first_name || '', at: Date.now() });
      await LOTTERY_KV.put('bot_admins', JSON.stringify(list));
    }
  } catch {}
  res.json({ ok: true, isAdmin: true, message: '管理员验证成功，已记住身份（7 天内免输密码）' });
});

/* ================= 总览（管理员） ================= */
router.post('/api/overview', needAdmin, async (req, res) => {
  try {
    const [me, wh] = await Promise.all([tgApi('getMe', {}), tgApi('getWebhookInfo', {})]);
    const [groups, channels, lotteries, bannedCfgs, welcomeCfgs, verifyCfgs, pendingVerify, warnKeys] = await Promise.all([
      countPrefix('bot_groups'), countPrefix('bot_channels'), countPrefix('lottery:'),
      countPrefix('banned:'), countPrefix('welcome_cfg:'), countPrefix('verify_cfg:'),
      countPrefix('verify_pending:'), countPrefix('warns:'),
    ]);
    res.json({
      ok: true,
      bot: {
        username: me.ok ? me.result.username : null,
        name: me.ok ? me.result.first_name : null,
        online: !!me.ok,
        webhook: wh.ok ? wh.result.url : null,
      },
      stats: { groups, channels, lotteries, bannedCfgs, welcomeCfgs, verifyCfgs, pendingVerify, warnKeys },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= 群 / 频道列表（管理员） ================= */
router.post('/api/chats', needAdmin, async (req, res) => {
  try {
    const groupsRaw = await LOTTERY_KV.get('bot_groups');
    const channelsRaw = await LOTTERY_KV.get('bot_channels');
    const groups = groupsRaw ? JSON.parse(groupsRaw) : [];
    const channels = channelsRaw ? JSON.parse(channelsRaw) : [];
    // 附带每个群/频道的当前配置
    const items = [];
    for (const g of groups) {
      const cfgRaw = await LOTTERY_KV.get(`group_cfg:${g.id}`);
      let cfg = {};
      if (cfgRaw) { try { cfg = JSON.parse(cfgRaw); } catch {} }
      items.push({ ...g, cfg });
    }
    const chItems = [];
    for (const c of channels) {
      const btnRaw = await LOTTERY_KV.get(`btn:${c.id}`);
      let btn = null;
      if (btnRaw) { try { btn = JSON.parse(btnRaw); } catch {} }
      chItems.push({ ...c, btn });
    }
    res.json({ ok: true, groups: items, channels: chItems });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= 群/频道操作（管理员） ================= */
router.post('/api/action', needAdmin, async (req, res) => {
  const { action, chatId, userId, target, minutes, text, buttons, key, value, name } = req.body || {};
  try {
    if (!chatId) return res.json({ ok: false, message: '缺少 chatId' });

    // 除配置类操作外，执行者必须是该群/频道管理员（creator/administrator）
    if (!['saveConfig', 'deleteKey', 'lock', 'unlock'].includes(action)) {
      const st = await tgApi('getChatMember', { chat_id: chatId, user_id: req.tgUser.id });
      if (!st.ok || !isAdminStatus(st.result && st.result.status)) {
        return res.json({ ok: false, message: '你不是该群/频道管理员，无法操作' });
      }
    }

    let targetInfo = null;
    if (target || /^\d+$/.test(String(userId || ''))) {
      targetInfo = /^\d+$/.test(String(userId || ''))
        ? { userId: parseInt(userId, 10), name: name || null }
        : await resolveTarget(chatId, target || userId);
      if (targetInfo && !targetInfo.userId) return res.json({ ok: false, message: `无法解析用户「${targetInfo.name}」的 ID，请直接输入数字 ID` });
    }

    const uid = targetInfo ? targetInfo.userId : null;

    if (action === 'ban') {
      if (!uid) return res.json({ ok: false, message: '缺少目标用户' });
      const r = await tgApi('banChatMember', { chat_id: chatId, user_id: uid });
      if (r.ok) await addBannedLog(chatId, uid, targetInfo.name || await getMemberName(chatId, uid) || `用户${uid}`, 'ban');
      return res.json({ ok: r.ok, message: r.ok ? '已封禁并移出群' : (r.description || '封禁失败') });
    }
    if (action === 'unban') {
      if (!uid) return res.json({ ok: false, message: '缺少目标用户' });
      const r = await tgApi('unbanChatMember', { chat_id: chatId, user_id: uid });
      if (r.ok) await removeBannedLog(chatId, uid);
      return res.json({ ok: r.ok, message: r.ok ? '已解除封禁（对方需重新加入群组）' : (r.description || '解封失败') });
    }
    if (action === 'mute') {
      if (!uid) return res.json({ ok: false, message: '缺少目标用户' });
      const until = Math.floor(Date.now() / 1000) + (parseInt(minutes, 10) || 60) * 60;
      const r = await tgApi('restrictChatMember', { chat_id: chatId, user_id: uid, permissions: allPermissions(false), until_date: until });
      if (r.ok) await addBannedLog(chatId, uid, targetInfo.name || await getMemberName(chatId, uid) || `用户${uid}`, 'mute');
      return res.json({ ok: r.ok, message: r.ok ? `已禁言 ${parseInt(minutes, 10) || 60} 分钟` : (r.description || '禁言失败') });
    }
    if (action === 'unmute') {
      if (!uid) return res.json({ ok: false, message: '缺少目标用户' });
      const r = await tgApi('restrictChatMember', { chat_id: chatId, user_id: uid, permissions: allPermissions(true) });
      if (r.ok) await removeBannedLog(chatId, uid);
      return res.json({ ok: r.ok, message: r.ok ? '已解除禁言' : (r.description || '解除失败') });
    }
    if (action === 'kick') {
      if (!uid) return res.json({ ok: false, message: '缺少目标用户' });
      const r = await tgApi('banChatMember', { chat_id: chatId, user_id: uid });
      if (r.ok) await tgApi('unbanChatMember', { chat_id: chatId, user_id: uid });
      return res.json({ ok: r.ok, message: r.ok ? '已移出群聊' : (r.description || '操作失败') });
    }
    if (action === 'warn') {
      if (!uid) return res.json({ ok: false, message: '缺少目标用户' });
      const warnKey = `warns:${chatId}:${uid}`;
      const raw = await LOTTERY_KV.get(warnKey);
      const count = (parseInt(raw, 10) || 0) + 1;
      await LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 3600 });
      return res.json({ ok: true, message: `已警告，当前 ${count} 次`, count });
    }
    if (action === 'unwarn') {
      if (!uid) return res.json({ ok: false, message: '缺少目标用户' });
      const warnKey = `warns:${chatId}:${uid}`;
      const raw = await LOTTERY_KV.get(warnKey);
      const count = Math.max(0, (parseInt(raw, 10) || 0) - 1);
      if (count <= 0) await LOTTERY_KV.delete(warnKey);
      else await LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 3600 });
      return res.json({ ok: true, message: count > 0 ? `已撤销警告，剩余 ${count} 次` : '已撤销全部警告', count });
    }
    if (action === 'lock' || action === 'unlock') {
      const lock = action === 'lock';
      const r = await tgApi('setChatPermissions', { chat_id: chatId, permissions: allPermissions(!lock) });
      const cfgRaw = await LOTTERY_KV.get(`group_cfg:${chatId}`);
      let cfg = cfgRaw ? JSON.parse(cfgRaw) : {};
      cfg.lock = lock;
      await LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg));
      return res.json({ ok: r.ok, message: r.ok ? (lock ? '🔒 全员禁言已开启' : '🔓 全员禁言已解除') : (r.description || '操作失败') });
    }
    if (action === 'announce') {
      if (!text) return res.json({ ok: false, message: '公告内容不能为空' });
      let keyboard = parseAnnounceButtons(buttons);
      if (!keyboard) {
        const btnRaw = await LOTTERY_KV.get(`btn:${chatId}`);
        if (btnRaw) {
          try {
            const bcfg = JSON.parse(btnRaw);
            if (bcfg && bcfg.keyboard && bcfg.keyboard.length && bcfg.mode !== 'reply') keyboard = bcfg.keyboard;
          } catch {}
        }
      }
      const sent = await tgApi('sendMessage', {
        chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true,
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

/* ================= 封禁/警告日志 ================= */
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
async function getMemberName(chatId, userId) {
  const r = await tgApi('getChatMember', { chat_id: chatId, user_id: userId });
  if (r.ok && r.result && r.result.user) {
    const u = r.result.user;
    return u.username ? `@${u.username}` : (u.first_name || `用户${userId}`);
  }
  return null;
}

// 群成员候选列表（警告记录 + 封禁日志），供管理操作选择目标
router.post('/api/members', needAdmin, async (req, res) => {
  const chatId = req.body && req.body.chatId;
  if (!chatId) return res.json({ ok: false, message: '缺少 chatId' });
  try {
    const warns = [];
    const keys = await LOTTERY_KV.list({ prefix: `warns:${chatId}:` });
    for (const k of (keys.keys || [])) {
      const uid = k.name.split(':').pop();
      const cnt = parseInt(await LOTTERY_KV.get(k.name), 10) || 0;
      warns.push({ id: parseInt(uid, 10), count: cnt });
    }
    res.json({ ok: true, warns, bannedLog: await getBannedLog(chatId) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 查询指定用户的警告（管理员用）
router.post('/api/warns', needAdmin, async (req, res) => {
  const { chatId, target } = req.body || {};
  if (!chatId || !target) return res.json({ ok: false, message: '缺少参数' });
  const t = await resolveTarget(chatId, target);
  if (!t || !t.userId) return res.json({ ok: false, message: `无法解析用户「${target}」` });
  const raw = await LOTTERY_KV.get(`warns:${chatId}:${t.userId}`);
  res.json({ ok: true, userId: t.userId, name: t.name, count: parseInt(raw, 10) || 0 });
});

/* ================= 抽奖列表 ================= */
// 管理员：全部群的进行中抽奖；普通用户：自己参与/中奖的抽奖
router.post('/api/lotteries', needAuth, async (req, res) => {
  try {
    const groupsRaw = await LOTTERY_KV.get('bot_groups');
    const groups = groupsRaw ? JSON.parse(groupsRaw) : [];
    const isAdmin = await isTgAdmin(req.tgUser.id, req.tgUser.username);
    const seen = new Set();
    const out = [];
    async function pushFromIndex(g) {
      const idxRaw = await LOTTERY_KV.get(`group:${g.id}:lotteries`);
      if (!idxRaw) return;
      let ids = [];
      try { ids = JSON.parse(idxRaw); } catch {}
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const raw = await LOTTERY_KV.get(`lottery:${id}`);
        if (!raw) continue;
        const l = JSON.parse(raw);
        const joined = (l.participants || []).includes(req.tgUser.id);
        const won = (l.winners || []).includes(req.tgUser.id);
        if (isAdmin) {
          out.push({
            id: l.id || id, name: l.name, group: g.title || `群 ${g.id}`, status: l.status,
            participants: (l.participants || []).length, winners: (l.winners || []).length,
            useCodes: !!l.useCodes, prize: l.prize || ((l.prizes || [])[0]) || '', createdAt: l.createdAt || 0, groupId: g.id,
          });
        } else if (joined) {
          const myPrize = won ? ((l.prizes && l.prizes.length) ? l.prizes[(l.winners || []).indexOf(req.tgUser.id)] : (l.prize || '')) : '';
          out.push({
            id: l.id || id, name: l.name, group: g.title || `群 ${g.id}`, status: l.status,
            won, prize: myPrize, createdAt: l.createdAt || 0, groupId: g.id,
          });
        }
      }
    }
    for (const g of groups) await pushFromIndex(g);
    if (isAdmin) {
      // 兜底：扫描所有 lottery: 键（频道抽奖 / 孤儿数据）
      try {
        const all = await LOTTERY_KV.list({ prefix: 'lottery:' });
        for (const k of (all.keys || [])) {
          const keyName = typeof k === 'string' ? k : (k.name || k.key || '');
          const id = keyName.slice('lottery:'.length);
          if (seen.has(id)) continue;
          seen.add(id);
          const raw = await LOTTERY_KV.get(keyName);
          if (!raw) continue;
          const l = JSON.parse(raw);
          out.push({
            id: l.id || id, name: l.name, group: l.groupName || '（未关联群）', status: l.status,
            participants: (l.participants || []).length, winners: (l.winners || []).length,
            useCodes: !!l.useCodes, prize: l.prize || ((l.prizes || [])[0]) || '', createdAt: l.createdAt || 0, groupId: l.groupId || 0,
          });
        }
      } catch {}
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ ok: true, lotteries: out.slice(0, 200), isAdmin });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= 抽奖管理（发起/开奖/取消/详情） ================= */
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function securePick(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
function fmtDate(ts) { const d = new Date(ts); const p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
async function addToGroupIndex(groupId, lotteryId) {
  const idxRaw = await LOTTERY_KV.get(`group:${groupId}:lotteries`);
  let ids = [];
  if (idxRaw) { try { ids = JSON.parse(idxRaw); } catch {} }
  if (!ids.includes(lotteryId)) ids.push(lotteryId);
  await LOTTERY_KV.put(`group:${groupId}:lotteries`, JSON.stringify(ids));
}
async function addToScheduled(lotteryId) {
  const raw = await LOTTERY_KV.get('scheduled_draws');
  let ids = [];
  if (raw) { try { ids = JSON.parse(raw); } catch {} }
  if (!ids.includes(lotteryId)) ids.push(lotteryId);
  await LOTTERY_KV.put('scheduled_draws', JSON.stringify(ids));
}
async function removeScheduled(lotteryId) {
  const raw = await LOTTERY_KV.get('scheduled_draws');
  if (!raw) return;
  try { const ids = JSON.parse(raw).filter(x => x !== lotteryId); await LOTTERY_KV.put('scheduled_draws', JSON.stringify(ids)); } catch {}
}
async function checkBotInChat(chatId) {
  const botId = parseInt((process.env.BOT_TOKEN || '').split(':')[0], 10);
  if (!botId) return false;
  const r = await tgApi('getChatMember', { chat_id: chatId, user_id: botId });
  return r.ok && ['administrator', 'creator', 'member'].includes(r.result && r.result.status);
}
async function sendTgMsg(chatId, text, extra) {
  return tgApi('sendMessage', Object.assign({ chat_id: chatId, text, parse_mode: 'Markdown' }, extra || {}));
}

// 发起抽奖
router.post('/api/lottery-create', needAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const groupId = parseInt(b.groupId, 10);
    const name = String(b.name || '').trim();
    if (!groupId || !name) return res.json({ ok: false, error: '请填写发布群和抽奖名称' });
    const prizeText = String(b.prize || '').trim();
    if (!prizeText) return res.json({ ok: false, error: '请填写奖品（多奖品用换行分隔）' });
    const prizes = prizeText.split('\n').map(s => s.trim()).filter(Boolean);
    const winnerCount = Math.max(1, parseInt(b.winnerCount, 10) || 1);
    const keyword = String(b.keyword || '抽奖').trim() || '抽奖';
    const triggerType = ['manual', 'count', 'time'].includes(b.triggerType) ? b.triggerType : 'manual';
    let triggerValue = 0;
    if (triggerType === 'count') triggerValue = Math.max(2, parseInt(b.triggerValue, 10) || 2);
    if (triggerType === 'time') triggerValue = parseInt(b.triggerValue, 10) || 0;
    const useCodes = !!b.useCodes;
    let codes = [];
    if (useCodes) codes = String(b.codes || '').split(/[\n,;，；]/).map(s => s.trim()).filter(Boolean);
    const groupsRaw = await LOTTERY_KV.get('bot_groups');
    const groups = groupsRaw ? JSON.parse(groupsRaw) : [];
    const g = groups.find(x => String(x.id) === String(groupId));
    if (!g) return res.json({ ok: false, error: '该群不在 bot 群列表中' });

    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    const lotteryId = Array.from(buf).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, 8);
    const now = Date.now();
    const lottery = {
      id: lotteryId, groupId, groupName: g.title || `群 ${groupId}`, creatorId: req.tgUser.id,
      name, prize: prizes[0], prizes, winnerCount, keyword, triggerType, triggerValue,
      channel: b.channel || '', useCodes, codes, codesUsed: [],
      participants: [], participantNames: {}, winners: [],
      status: 'active', createdAt: now, drawnAt: null, groupMsgId: null, channelMsgId: null,
    };
    await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
    await addToGroupIndex(groupId, lotteryId);
    if (triggerType === 'time' && triggerValue) await addToScheduled(lotteryId);

    const triggerText = triggerType === 'time' ? `⏰ 开奖时间：${fmtDate(triggerValue)}`
      : triggerType === 'count' ? `👥 满 ${triggerValue} 人自动开奖` : '🎲 手动开奖';
    const codeText = useCodes ? `\n🎟️ 中奖后由 bot 私信发放兑换码` : '';
    const groupPost = `🎊 **抽奖开始啦！** 🎊\n\n━━━━━━━━━━━━━━━━\n📝 **活动名称：** ${esc(name)}\n🎁 **奖品：** ${esc(prizes[0])}\n🏆 **中奖名额：** ${winnerCount} 人\n${triggerText}${codeText}\n━━━━━━━━━━━━━━━━\n\n🔑 在群内发送口令 \`${esc(keyword)}\` 即可参与抽奖！`;
    const inGroup = await checkBotInChat(groupId);
    let groupMsgId = null;
    if (inGroup) {
      const postRes = await sendTgMsg(groupId, groupPost);
      if (postRes.ok && postRes.result && postRes.result.message_id) groupMsgId = postRes.result.message_id;
    }
    if (groupMsgId) {
      lottery.groupMsgId = groupMsgId;
      try { await tgApi('pinChatMessage', { chat_id: groupId, message_id: groupMsgId, disable_notification: false }); } catch {}
    }
    await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
    res.json({ ok: true, lottery: { id: lotteryId, name, group: lottery.groupName, status: 'active', posted: !!groupMsgId, inGroup } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 开奖
router.post('/api/lottery-draw', needAdmin, async (req, res) => {
  try {
    const lotteryId = String((req.body || {}).lotteryId || '').trim();
    if (!lotteryId) return res.json({ ok: false, error: '缺少抽奖ID' });
    const raw = await LOTTERY_KV.get(`lottery:${lotteryId}`);
    if (!raw) return res.json({ ok: false, error: '抽奖不存在' });
    const lottery = JSON.parse(raw);
    if (lottery.status !== 'active') return res.json({ ok: false, error: '抽奖已结束或已取消' });
    if (!lottery.participants || lottery.participants.length === 0) return res.json({ ok: false, error: '暂无人参与，无法开奖' });
    const participants = lottery.participants;
    const winnerCount = Math.min(lottery.winnerCount || 1, participants.length);
    const winners = securePick(participants, winnerCount);
    lottery.status = 'completed';
    lottery.winners = winners;
    lottery.drawnAt = Date.now();
    await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
    await removeScheduled(lotteryId);
    if (lottery.groupMsgId) { try { await tgApi('unpinChatMessage', { chat_id: lottery.groupId, message_id: lottery.groupMsgId }); } catch {} }
    const winnerNames = winners.map(id => lottery.participantNames[id] || `用户${id}`);
    const prizes = (lottery.prizes && lottery.prizes.length) ? lottery.prizes : [lottery.prize || '奖品'];
    const winnerList = winnerNames.map((n, i) => { const p = prizes[Math.min(i, prizes.length - 1)]; return `${i + 1}. @${esc(n)}${prizes.length > 1 ? ` → ${esc(p)}` : ''}`; }).join('\n');
    const groupText = `🎊🎊🎊 **开奖啦！** 🎊🎊🎊\n\n━━━━━━━━━━━━━━━━\n📝 **活动：** ${esc(lottery.name)}\n${prizes.length > 1 ? `🎁 **奖品：**\n${prizes.map((p, i) => `  ${i + 1}. ${esc(p)}`).join('\n')}` : `🎁 **奖品：** ${esc(lottery.prize)}`}\n👥 **参与人数：** ${participants.length} 人\n🏆 **中奖人数：** ${winnerCount} 人\n━━━━━━━━━━━━━━━━\n\n🎉 **中奖者：**\n${winnerList}\n\n🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉`;
    await sendTgMsg(lottery.groupId, groupText);
    if (lottery.channel) { try { await sendTgMsg(lottery.channel, groupText); } catch {} }
    let codeIdx = 0;
    const codeAssignments = {};
    const dmFailed = [];
    for (let wi = 0; wi < winners.length; wi++) {
      const winnerId = winners[wi];
      const myPrize = prizes[Math.min(wi, prizes.length - 1)];
      let codeText = '';
      if (lottery.useCodes && Array.isArray(lottery.codes)) {
        if (codeIdx < lottery.codes.length) { const code = lottery.codes[codeIdx]; codeIdx++; codeAssignments[winnerId] = code; lottery.codesUsed.push(code); }
        else codeText = '\n⚠️ 兑奖码已发放完毕，请联系管理员单独处理';
      }
      const dmText = `🥳🥳 **恭喜中奖啦！** 🥳🥳\n\n━━━━━━━━━━━━━━━━\n**抽奖群：** ${esc(lottery.groupName || '')}\n**活动名称：** ${esc(lottery.name)}\n**获得奖品：** ${esc(myPrize)}${codeText}\n━━━━━━━━━━━━━━━━\n\n🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉`;
      const kb = [[{ text: '🎟️ 立即兑奖', callback_data: `redeem:${lotteryId}` }]];
      const dm = await tgApi('sendMessage', { chat_id: winnerId, text: dmText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
      if (!dm.ok) dmFailed.push(winnerId);
      const rk = `my_redeem:${winnerId}`;
      const rr = await LOTTERY_KV.get(rk);
      let list = rr ? JSON.parse(rr) : [];
      list = list.filter(x => x.lotteryId !== lotteryId);
      list.unshift({ lotteryId, name: lottery.name, prize: myPrize, code: codeAssignments[winnerId] || null, groupName: lottery.groupName || '', drawnAt: lottery.drawnAt });
      list = list.slice(0, 30);
      await LOTTERY_KV.put(rk, JSON.stringify(list));
    }
    if (lottery.useCodes && codeIdx > 0) await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
    if (dmFailed.length) { try { await sendTgMsg(lottery.groupId, `💡 中奖通知私信失败：${dmFailed.map(id => lottery.participantNames[id] || `用户${id}`).join('、')}，请私聊机器人开启通知`); } catch {} }
    try { await sendTgMsg(lottery.creatorId, `💐💐💐 **开奖了** 💐💐💐\n\n**${esc(lottery.name)}** 开奖了!\n本期总参与人数: ${participants.length}\n\n${winnerNames.map((n, i) => { const c = codeAssignments[winners[i]]; const p = prizes[Math.min(i, prizes.length - 1)]; return `${i + 1}- ${n}  获得:${esc(p)}${c ? `\n    🎟️ 兑换码: \`${esc(c)}\`` : ''}`; }).join('\n')}\n\n谨祝中奖用户大吉大利万事顺意`); } catch {}
    res.json({ ok: true, message: `已开奖：${winnerCount} 人中奖` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 取消抽奖
router.post('/api/lottery-cancel', needAdmin, async (req, res) => {
  try {
    const lotteryId = String((req.body || {}).lotteryId || '').trim();
    const raw = await LOTTERY_KV.get(`lottery:${lotteryId}`);
    if (!raw) return res.json({ ok: false, error: '抽奖不存在' });
    const l = JSON.parse(raw);
    if (l.status !== 'active') return res.json({ ok: false, error: '抽奖已结束或已取消' });
    l.status = 'cancelled';
    await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(l));
    await removeScheduled(lotteryId);
    if (l.groupMsgId) { try { await tgApi('unpinChatMessage', { chat_id: l.groupId, message_id: l.groupMsgId }); } catch {} }
    try { await sendTgMsg(l.groupId, `❌ **抽奖已取消**\n\n📝 ${esc(l.name)}\n参与已取消，感谢关注～`); } catch {}
    res.json({ ok: true, message: '已取消抽奖' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 抽奖详情（参与/中奖名单、兑奖码）
router.post('/api/lottery-detail', needAdmin, async (req, res) => {
  try {
    const lotteryId = String((req.body || {}).lotteryId || '').trim();
    const raw = await LOTTERY_KV.get(`lottery:${lotteryId}`);
    if (!raw) return res.json({ ok: false, error: '抽奖不存在' });
    const l = JSON.parse(raw);
    res.json({ ok: true, lottery: {
      id: l.id, name: l.name, group: l.groupName || '', status: l.status,
      prize: l.prize, prizes: l.prizes || [], winnerCount: l.winnerCount,
      keyword: l.keyword, triggerType: l.triggerType, triggerValue: l.triggerValue,
      useCodes: !!l.useCodes, codes: l.codes || [], codesUsed: l.codesUsed || [],
      participants: (l.participants || []).map(id => ({ id, name: l.participantNames[id] || `用户${id}` })),
      winners: (l.winners || []).map(id => ({ id, name: l.participantNames[id] || `用户${id}` })),
      createdAt: l.createdAt, drawnAt: l.drawnAt,
    } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ================= 用户自助 ================= */
router.post('/api/me', needAuth, async (req, res) => {
  try {
    const uid = req.tgUser.id;
    const groupsRaw = await LOTTERY_KV.get('bot_groups');
    const groups = groupsRaw ? JSON.parse(groupsRaw) : [];

    // 待兑奖
    let redeem = [];
    const redeemRaw = await LOTTERY_KV.get(`my_redeem:${uid}`);
    if (redeemRaw) { try { redeem = JSON.parse(redeemRaw); } catch {} }

    // 警告（跨群汇总）
    const warns = [];
    for (const g of groups) {
      const w = await LOTTERY_KV.get(`warns:${g.id}:${uid}`);
      if (w && parseInt(w, 10) > 0) warns.push({ groupId: g.id, group: g.title || `群 ${g.id}`, count: parseInt(w, 10) });
    }

    // 我参与的抽奖
    const lotteries = [];
    for (const g of groups) {
      const idxRaw = await LOTTERY_KV.get(`group:${g.id}:lotteries`);
      if (!idxRaw) continue;
      let ids = [];
      try { ids = JSON.parse(idxRaw); } catch {}
      for (const id of ids) {
        const raw = await LOTTERY_KV.get(`lottery:${id}`);
        if (!raw) continue;
        const l = JSON.parse(raw);
        if (!(l.participants || []).includes(uid)) continue;
        const won = (l.winners || []).includes(uid);
        const myPrize = won ? ((l.prizes && l.prizes.length) ? l.prizes[(l.winners || []).indexOf(uid)] : (l.prize || '')) : '';
        lotteries.push({ id: l.id || id, name: l.name, group: g.title || `群 ${g.id}`, status: l.status, won, prize: myPrize });
      }
    }

    // 入群验证状态
    const verifies = [];
    for (const g of groups) {
      const v = await LOTTERY_KV.get(`verify_pending:${g.id}:${uid}`);
      if (v) verifies.push({ groupId: g.id, group: g.title || `群 ${g.id}`, joinedAt: (() => { try { return JSON.parse(v).joinedAt || 0; } catch { return 0; } })() });
    }

    const isAdmin = await isTgAdmin(uid, req.tgUser.username);
    res.json({
      ok: true,
      isAdmin,
      user: { id: uid, username: req.tgUser.username || '', first_name: req.tgUser.first_name || '' },
      groups: groups.map(g => ({ id: g.id, title: g.title })),
      redeem: redeem.slice(-50),
      warns,
      lotteries: lotteries.slice(-50),
      verifies,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= TGBot 功能管理（管理员） ================= */

// 概览：各功能表统计 + 群列表
router.post('/api/tg-features/overview', needAdmin, async (req, res) => {
  try {
    const groupsRaw = await LOTTERY_KV.get('bot_groups');
    let groups = groupsRaw ? JSON.parse(groupsRaw) : [];
    if (!Array.isArray(groups)) groups = [];
    const channelsRaw = await LOTTERY_KV.get('bot_channels');
    let channels = channelsRaw ? JSON.parse(channelsRaw) : [];
    if (!Array.isArray(channels)) channels = [];
    res.json({
      ok: true,
      groups: groups.map(g => ({ id: g.id, title: g.title || `群${g.id}` })),
      channels: channels.map(c => ({ id: c.id, title: c.title || `频道${c.id}` })),
      counts: {
        scheduled: features.listScheduled().length,
        keywords: features.countRows('keyword_replies'),
        memberStats: features.countRows('member_stats'),
        syncs: features.listSyncs().length,
        settings: features.countRows('group_settings'),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 群功能配置
router.post('/api/tg-features/config', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const cfg = await features.getGroupCfg(chatId);
    res.json({ ok: true, chatId, cfg });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/config-save', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const cfg = req.body.cfg || {};
    await features.setGroupCfg(chatId, cfg);
    res.json({ ok: true, message: '群配置已保存' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 定时消息
router.post('/api/tg-features/scheduled', needAdmin, async (req, res) => {
  try { res.json({ ok: true, list: features.listScheduled(req.body.chatId ? Number(req.body.chatId) : undefined) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/scheduled-add', needAdmin, async (req, res) => {
  try {
    const { chatId, chatType, text, intervalMinutes } = req.body;
    if (!chatId || !text || !intervalMinutes || intervalMinutes < 1) return res.json({ ok: false, error: '参数不完整（chatId/text/intervalMinutes>=1）' });
    const r = features.addScheduled(Number(chatId), chatType || 'group', String(text).slice(0, 3500), Number(intervalMinutes));
    res.json({ ok: true, id: r.id, message: '定时消息已创建（立即到期，下一次调度发送）' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/scheduled-del', needAdmin, async (req, res) => {
  try { features.delScheduled(Number(req.body.id)); res.json({ ok: true, message: '已删除' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/scheduled-toggle', needAdmin, async (req, res) => {
  try { features.toggleScheduled(Number(req.body.id), !!req.body.enabled); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 关键词回复
router.post('/api/tg-features/keywords', needAdmin, async (req, res) => {
  try { res.json({ ok: true, list: features.listKeywords(Number(req.body.chatId)) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/keyword-add', needAdmin, async (req, res) => {
  try {
    const { chatId, keyword, reply } = req.body;
    if (!chatId || !keyword || !reply) return res.json({ ok: false, error: '参数不完整（chatId/keyword/reply）' });
    const r = features.addKeyword(Number(chatId), String(keyword).slice(0, 100), String(reply).slice(0, 1000));
    res.json({ ok: true, id: r.id, message: '关键词回复已添加（注意：请勿与抽奖口令重复）' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/keyword-del', needAdmin, async (req, res) => {
  try { features.delKeyword(Number(req.body.id)); res.json({ ok: true, message: '已删除' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/keyword-toggle', needAdmin, async (req, res) => {
  try { features.toggleKeyword(Number(req.body.id), !!req.body.enabled); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 频道同步
router.post('/api/tg-features/syncs', needAdmin, async (req, res) => {
  try { res.json({ ok: true, list: features.listSyncs() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/sync-add', needAdmin, async (req, res) => {
  try {
    const { sourceChatId, targetChatIds } = req.body;
    if (!sourceChatId || !Array.isArray(targetChatIds) || !targetChatIds.length) return res.json({ ok: false, error: '参数不完整（sourceChatId/targetChatIds[]）' });
    const r = features.addSync(Number(sourceChatId), targetChatIds.map(Number));
    res.json({ ok: true, id: r.id, message: '频道同步已添加' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/sync-del', needAdmin, async (req, res) => {
  try { features.delSync(Number(req.body.id)); res.json({ ok: true, message: '已删除' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/sync-toggle', needAdmin, async (req, res) => {
  try { features.toggleSync(Number(req.body.id), !!req.body.enabled); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 群统计（成员积分/活跃）
router.post('/api/tg-features/stats', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const stats = features.getGroupStats(chatId);
    res.json({ ok: true, chatId, stats });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 邀请链接（获取/新建）
router.post('/api/tg-features/invite', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const action = req.body.action === 'create' ? 'createChatInviteLink' : 'exportChatInviteLink';
    const r = await tgApi(action, { chat_id: chatId });
    if (r.ok) return res.json({ ok: true, link: r.result.invite_link });
    return res.json({ ok: false, error: r.description || '获取失败（请确认 bot 有邀请成员权限）' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 成员权限控制（禁言/解禁/媒体/链接 开关）
async function getFullPerms(chatId, uid) {
  const m = await tgApi('getChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
  if (!m || !m.ok || !m.result || !m.result.permissions) return null;
  const p = m.result.permissions;
  return {
    can_send_messages: !!p.can_send_messages, can_send_media_messages: !!p.can_send_media_messages,
    can_send_other_messages: !!p.can_send_other_messages, can_add_web_page_previews: !!p.can_add_web_page_previews,
    can_send_polls: !!p.can_send_polls, can_change_info: !!p.can_change_info,
    can_invite_users: !!p.can_invite_users, can_pin_messages: !!p.can_pin_messages,
  };
}
router.post('/api/tg-features/perm', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const uid = Number(req.body.userId);
    const action = String(req.body.action || '');
    const minutes = parseInt(req.body.minutes, 10) || 60;
    if (!chatId || !uid) return res.json({ ok: false, error: '缺少群ID或用户ID' });
    const cur = await getFullPerms(chatId, uid);
    let perms;
    if (cur) {
      perms = Object.assign({}, cur);
      if (action === 'mute') { perms.can_send_messages = false; perms.can_send_media_messages = false; perms.can_send_other_messages = false; perms.can_add_web_page_previews = false; }
      else if (action === 'unmute') { perms.can_send_messages = true; perms.can_send_media_messages = true; perms.can_send_other_messages = true; perms.can_add_web_page_previews = true; }
      else if (action === 'mediaoff') perms.can_send_media_messages = false;
      else if (action === 'mediaon') perms.can_send_media_messages = true;
      else if (action === 'linkoff') perms.can_add_web_page_previews = false;
      else if (action === 'linkon') perms.can_add_web_page_previews = true;
      else return res.json({ ok: false, error: '未知操作' });
    } else {
      if (action === 'mute') perms = { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false, can_add_web_page_previews: false };
      else if (action === 'unmute') perms = { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true };
      else if (action === 'mediaoff' || action === 'linkoff') perms = { can_send_messages: true, can_send_media_messages: action === 'mediaoff' ? false : true, can_send_other_messages: true, can_add_web_page_previews: action === 'linkoff' ? false : true };
      else if (action === 'mediaon' || action === 'linkon') perms = { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true };
      else return res.json({ ok: false, error: '未知操作' });
    }
    const until = action === 'mute' ? Math.floor(Date.now() / 1000) + minutes * 60 : 0;
    const r = await tgApi('restrictChatMember', { chat_id: chatId, user_id: uid, permissions: perms, until_date: until || undefined });
    if (r.ok) return res.json({ ok: true, message: '权限已更新' });
    return res.json({ ok: false, error: r.description || '操作失败（请确认 bot 是群管理员）' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 邀请链接统计 / 重置
router.post('/api/tg-features/invite-stats', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const rows = await features.getInviteStatsAll(chatId);
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/invite-reset', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const r = await features.resetInviteData(chatId);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 增减积分（管理员）
router.post('/api/tg-features/points-adjust', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const userId = Number(req.body.userId);
    const delta = parseInt(req.body.delta, 10);
    const r = await features.adjustPoints(chatId, userId, delta);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 频道配置（评论沙发/自动删除/屏蔽/控制权限）
router.post('/api/tg-features/channel-config', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    if (!chatId) return res.json({ ok: false, error: '缺少频道ID' });
    const cfg = await features.getChannelCfg(chatId);
    res.json({ ok: true, chatId, cfg });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/tg-features/channel-config-save', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const cfg = req.body.cfg;
    if (!chatId || !cfg || typeof cfg !== 'object') return res.json({ ok: false, error: '参数不完整' });
    await features.setChannelCfg(chatId, cfg);
    res.json({ ok: true, message: '频道配置已保存' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 人数趋势
router.post('/api/tg-features/member-trend', needAdmin, async (req, res) => {
  try {
    const chatId = Number(req.body.chatId);
    const days = parseInt(req.body.days, 10) || 14;
    const rows = features.getMemberCountTrend(chatId, days);
    res.json({ ok: true, chatId, rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
