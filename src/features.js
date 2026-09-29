/**
 * TGBot 功能模块（SQLite 版）
 * 积分系统 / 成员统计 / 关键词回复 / 定时消息 / 频道同步
 * 新成员限制 / 夜间模式 / 闪进闪退屏蔽 / 群组命令
 */
import db from './db.js';
import { LOTTERY_KV } from './sql-store.js';

const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org:18443';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_ID = parseInt((BOT_TOKEN || '').split(':')[0]) || 0;

async function tgApi(method, body = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (d && d.ok) return d;
      if (d && (d.error_code === 429 || (d.error_code >= 500 && d.error_code < 600)) && i < retries - 1) {
        await new Promise((res) => setTimeout(res, 800 * (i + 1)));
        continue;
      }
      return d;
    } catch (e) {
      if (i < retries - 1) await new Promise((res) => setTimeout(res, 500 * (i + 1)));
      else return { ok: false, description: e.message };
    }
  }
  return { ok: false };
}

const sendMsg = (chatId, text) => tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' }).catch(() => null);

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/* ================= 群功能设置（group_settings 表） ================= */
export async function getGroupCfg(chatId) {
  const row = db.prepare('SELECT cfg FROM group_settings WHERE chatId = ?').get(chatId);
  return row ? JSON.parse(row.cfg) : {};
}
export async function setGroupCfg(chatId, cfg) {
  db.prepare('INSERT INTO group_settings (chatId, cfg, updatedAt) VALUES (?, ?, ?) ON CONFLICT(chatId) DO UPDATE SET cfg = excluded.cfg, updatedAt = excluded.updatedAt')
    .run(chatId, JSON.stringify(cfg), Date.now());
}
export async function patchGroupCfg(chatId, patch) {
  const cfg = await getGroupCfg(chatId);
  Object.assign(cfg, patch);
  await setGroupCfg(chatId, cfg);
  return cfg;
}

/* ================= 积分系统 + 成员统计 ================= */
function msgTypeOf(msg) {
  if (!msg) return 'text';
  if (msg.photo) return 'photo';
  if (msg.video || msg.video_note) return 'video';
  if (msg.document) return 'document';
  if (msg.audio || msg.voice) return 'audio';
  if (msg.sticker) return 'sticker';
  return 'text';
}
export async function onGroupMessage(chatId, userId, username, text, msg) {
  if (!chatId || !userId || userId === BOT_ID) return false;
  const cfg = await getGroupCfg(chatId);
  // 群级总开关：关闭则该群所有 TGBot 功能停用
  if (cfg.enabled === false) return false;
  // 白名单：豁免删除类规则（积分/关键词照常）
  const whitelist = (cfg.antispam && cfg.antispam.whitelist) || [];
  const isWhitelisted = whitelist.includes(userId);
  // 管理员豁免删除规则/防刷屏（积分与关键词照常）
  let isAdmin = false;
  if (!isWhitelisted && (cfg.autoDelete || (cfg.flood && cfg.flood.enabled) || cfg.chatCheck || cfg.switchGroup)) {
    const am = await tgApi('getChatMember', { chat_id: chatId, user_id: userId }).catch(() => null);
    if (am && am.ok) {
      const s = am.result.status;
      const scope = cfg.adminScope || 'all';
      if (s === 'creator') isAdmin = true;
      else if (s === 'administrator') {
        if (scope === 'all') isAdmin = true;
        else if (scope === 'addadmin') isAdmin = !!am.result.can_promote_members;
        else if (scope === 'banright') isAdmin = !!am.result.can_restrict_members;
      }
    }
  }
  // 开关群：管理员发送自定义关键词 → 全员禁言/解除
  const sg = cfg.switchGroup || {};
  if (sg.enabled && text && isAdmin) {
    const t = String(text).trim();
    if (sg.openKw && t === sg.openKw) {
      await tgApi('setChatPermissions', { chat_id: chatId, permissions: allPerms(false) }).catch(() => null);
      await sendMsg(chatId, sg.openMsg || '🔒 已全员禁言');
      return true;
    }
    if (sg.closeKw && t === sg.closeKw) {
      await tgApi('setChatPermissions', { chat_id: chatId, permissions: allPerms(true) }).catch(() => null);
      await sendMsg(chatId, sg.closeMsg || '🔓 已解除全员禁言');
      return true;
    }
  }
  // 发言检查：必须设置用户名/头像、昵称禁词、超长消息/昵称
  if (!isAdmin && !isWhitelisted) {
    const cc = cfg.chatCheck || {};
    let ccHit = null;
    if (cc.mustUsername && !username) ccHit = { code: 'username', msg: '请先设置用户名（Telegram 设置 → 用户名），设置后重新发言' };
    if (!ccHit && cc.mustAvatar) {
      const pp = await tgApi('getUserProfilePhotos', { user_id: userId, limit: 1 }).catch(() => null);
      if (!pp || !pp.ok || !pp.result.total_count) ccHit = { code: 'avatar', msg: '请先设置头像后再发言' };
    }
    if (!ccHit && Array.isArray(cc.nickForbid) && cc.nickForbid.length && msg && msg.from && msg.from.first_name) {
      const n = String(msg.from.first_name).toLowerCase();
      const hit = cc.nickForbid.find(w => w && n.includes(String(w).toLowerCase()));
      if (hit) ccHit = { code: 'nick', msg: `昵称包含违规词「${hit}」，请修改昵称` };
    }
    if (!ccHit && cc.maxMsgLen > 0 && text && text.length > cc.maxMsgLen) ccHit = { code: 'len', msg: `消息过长（${text.length} 字，上限 ${cc.maxMsgLen}），已删除` };
    if (!ccHit && cc.maxNickLen > 0 && msg && msg.from) {
      const nn = (msg.from.first_name || '') + (msg.from.username ? `@${msg.from.username}` : '');
      if (nn.length > cc.maxNickLen) ccHit = { code: 'nicklen', msg: '昵称过长，请修改昵称后再发言' };
    }
    if (ccHit) {
      if (msg && msg.message_id) await tgApi('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => null);
      const until = Math.floor(Date.now() / 1000) + 600;
      await tgApi('restrictChatMember', { chat_id: chatId, user_id: userId, permissions: { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false, can_add_web_page_previews: false }, until_date: until }).catch(() => null);
      await sendMsg(chatId, `⚠️ @${username || `用户${userId}`} ${ccHit.msg}（已禁言 10 分钟）`);
      return true;
    }
  }
  // 自动删除规则（图片/视频/文件/转发/链接）
  if (!isAdmin && !isWhitelisted) {
    const ad = cfg.autoDelete || {};
    const mtype = msgTypeOf(msg);
    const hasLink = /(https?:\/\/|t\.me\/|telegram\.me\/)/i.test(text || '');
    const isForward = !!(msg && msg.forward_from);
    let shouldDelete = false;
    if (ad.photo && mtype === 'photo') shouldDelete = true;
    else if (ad.video && mtype === 'video') shouldDelete = true;
    else if (ad.document && mtype === 'document') shouldDelete = true;
    else if (ad.forward && isForward) shouldDelete = true;
    else if (ad.link && hasLink) shouldDelete = true;
    if (shouldDelete) {
      if (msg && msg.message_id) await tgApi('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => null);
      return true;
    }
    // 防刷屏（发言频率限制）
    const fl = cfg.flood || { enabled: false, secs: 10, max: 5 };
    if (fl.enabled) {
      const key = `flood:${chatId}:${userId}`;
      const raw = await LOTTERY_KV.get(key);
      const now = Date.now();
      const win = (fl.secs || 10) * 1000;
      let arr = [];
      if (raw) { try { arr = JSON.parse(raw).filter(t => now - t < win); } catch {} }
      arr.push(now);
      const max = fl.max || 5;
      if (arr.length > max) {
        await LOTTERY_KV.put(key, JSON.stringify(arr.slice(-max)), { expirationTtl: (fl.secs || 10) * 2 });
        if (msg && msg.message_id) await tgApi('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => null);
        await sendMsg(chatId, `⚠️ @${username || `用户${userId}`} 发言过快，请勿刷屏。`);
        return true;
      }
      await LOTTERY_KV.put(key, JSON.stringify(arr), { expirationTtl: (fl.secs || 10) * 2 });
    }
  }
  // 发言积分 + 消息统计
  const pc = cfg.points || { enabled: true, perMsg: 1, dailyCap: 0 };
  if (pc.enabled !== false) {
    const today = todayStr();
    const row = db.prepare('SELECT * FROM member_stats WHERE chatId = ? AND userId = ?').get(chatId, userId);
    if (row) {
      const todayMsgs = row.todayDate === today ? row.todayMsgs + 1 : 1;
      let points = row.points;
      if (todayMsgs <= (pc.dailyCap || 100)) points += (pc.perMsg || 1);
      db.prepare('UPDATE member_stats SET username = ?, points = ?, totalMsgs = totalMsgs + 1, todayMsgs = ?, todayDate = ?, lastActive = ? WHERE chatId = ? AND userId = ?')
        .run(String(username || '').slice(0, 64), points, todayMsgs, today, Date.now(), chatId, userId);
    } else {
      db.prepare('INSERT INTO member_stats (chatId, userId, username, points, totalMsgs, todayMsgs, todayDate, lastActive) VALUES (?, ?, ?, ?, 1, 1, ?, ?)')
        .run(chatId, userId, String(username || '').slice(0, 64), (pc.perMsg || 1), today, Date.now());
    }
    // 同步积分到抽奖中心
    try {
      const bindRow = db.prepare('SELECT luckyUsername FROM lucky_bindings WHERE userId = ?').get(userId);
      if (bindRow && bindRow.luckyUsername) {
        const perMsg = pc.perMsg || 1;
        if (perMsg > 0) {
          fetch(LUCKY_API_URL + '/lucky-admin/api/grant-points', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-pw': LUCKY_ADMIN_PASSWORD },
            body: JSON.stringify({ username: bindRow.luckyUsername, count: perMsg })
          }).catch(e => console.error('同步抽奖积分失败:', e.message));
        }
      }
    } catch(e) { console.error('抽奖同步错误:', e.message); }
  }
  // 关键词自动回复（命中则拦截后续口令处理，注意勿与抽奖口令重复）
  if (text) {
    const kws = db.prepare('SELECT * FROM keyword_replies WHERE chatId = ? AND enabled = 1').all(chatId);
    if (kws.length) {
      const t = String(text).toLowerCase();
      for (const k of kws) {
        if (k.keyword && t.includes(String(k.keyword).toLowerCase())) {
          await sendMsg(chatId, k.reply);
          return true;
        }
      }
    }
  }
  return false;
}

/* ================= 群组命令 ================= */
async function resolveCmdTarget(chatId, text, replyMsg) {
  // 1. 回复消息定位
  if (replyMsg && replyMsg.from && replyMsg.from.id) {
    return { userId: replyMsg.from.id, name: replyMsg.from.username || replyMsg.from.first_name || `用户${replyMsg.from.id}` };
  }
  // 2. @username 定位（从警告/封禁记录匹配）
  const input = String(text).trim();
  const m = input.match(/@([A-Za-z0-9_]{3,})/);
  if (m) {
    const name = m[1].toLowerCase();
    const logRaw = await LOTTERY_KV.get(`banned_log:${chatId}`);
    if (logRaw) {
      try {
        const list = JSON.parse(logRaw);
        const hit = list.find(x => String(x.name || '').replace(/^@/, '').toLowerCase() === name);
        if (hit) return { userId: parseInt(hit.id, 10), name: hit.name };
      } catch {}
    }
  }
  return null;
}
export async function onCommand(chatId, userId, username, text, replyMsg) {
  if (!chatId || !text) return false;
  const cfg = await getGroupCfg(chatId);
  const rawCmd = String(text).trim().split(/\s+/)[0].toLowerCase();
  // 命令别名映射（如 "签到" → /sign_in）
  const aliasMap = cfg.cmdAlias || {};
  let cmd = rawCmd;
  if (aliasMap[rawCmd]) cmd = String(aliasMap[rawCmd]).toLowerCase();
  // 签到：每日一次得积分（默认 5，可配置）
  if (cmd === '/sign_in' || cmd === '/signin') {
    const today = todayStr();
    const key = `sign:${chatId}:${userId}`;
    const last = await LOTTERY_KV.get(key);
    if (last === today) { await sendMsg(chatId, '⏰ 今天已经签过到啦，明天再来！'); return true; }
    await LOTTERY_KV.put(key, today);
    const signPts = (cfg.points && cfg.points.signIn) || 5;
    const row = db.prepare('SELECT * FROM member_stats WHERE chatId = ? AND userId = ?').get(chatId, userId);
    if (row) db.prepare('UPDATE member_stats SET username = ?, points = points + ? WHERE chatId = ? AND userId = ?').run(String(username || '').slice(0, 64), signPts, chatId, userId);
    else db.prepare('INSERT INTO member_stats (chatId, userId, username, points, totalMsgs, todayMsgs, todayDate, lastActive) VALUES (?, ?, ?, ?, 0, 0, ?, ?)').run(chatId, userId, String(username || '').slice(0, 64), signPts, todayStr(), Date.now());
    await sendMsg(chatId, `✅ 签到成功！积分 +${signPts}`);
    return true;
  }
  // 邀请链接：生成专属链接 + 查询邀请统计
  if (cmd === '/link') {
    const ic = (cfg.inviteLink) || { enabled: false, expireHours: 0, maxUsers: 0 };
    if (ic.enabled === false) { await sendMsg(chatId, '❌ 本群未开启邀请链接功能'); return true; }
    const linksRaw = await LOTTERY_KV.get(`invite_links:${chatId}`);
    const links = linksRaw ? JSON.parse(linksRaw) : [];
    const mine = links.find(l => l.userId === userId);
    if (mine && mine.link) {
      const stat = await getInviteStat(chatId, userId);
      await sendMsg(chatId, `🔗 你的专属邀请链接：\n${mine.link}\n\n👥 已邀请：${stat.count} 人${stat.points ? `\n⭐ 邀请积分：+${stat.points}` : ''}`);
      return true;
    }
    const params = { chat_id: chatId, name: `UID${userId}` };
    if (ic.expireHours > 0) params.expire_date = Math.floor(Date.now() / 1000) + ic.expireHours * 3600;
    if (ic.maxUsers > 0) params.member_limit = ic.maxUsers;
    const r = await tgApi('createChatInviteLink', params).catch(() => null);
    if (r && r.ok) {
      links.push({ userId, link: r.result.invite_link, createdAt: Date.now(), lastCount: 0 });
      await LOTTERY_KV.put(`invite_links:${chatId}`, JSON.stringify(links));
      await sendMsg(chatId, `🔗 你的专属邀请链接已生成：\n${r.result.invite_link}\n\n分享给好友加入本群，每邀请 1 人可获得积分！`);
    } else {
      await sendMsg(chatId, '❌ 生成失败，请确认 bot 有「邀请成员」权限');
    }
    return true;
  }
  // 管理员增减积分：/givepoints @user 数量 或 回复消息
  if (cmd === '/givepoints' || cmd === '/addpoints') {
    const okAdmin = await isPrivileged(chatId, userId);
    if (!okAdmin) { await sendMsg(chatId, '❌ 只有群管理员可以使用该命令'); return true; }
    const m = String(text).trim().match(/@([A-Za-z0-9_]{3,})\s+(-?\d+)/);
    let target = null, delta = 0;
    if (m) {
      target = await resolveCmdTarget(chatId, '@' + m[1], null);
      delta = parseInt(m[2], 10);
    } else if (replyMsg && replyMsg.from && replyMsg.from.id) {
      const mm = String(text).trim().match(/(-?\d+)\s*$/);
      target = { userId: replyMsg.from.id, name: replyMsg.from.username || replyMsg.from.first_name };
      delta = mm ? parseInt(mm[1], 10) : 0;
    }
    if (!target || !delta) { await sendMsg(chatId, '❌ 用法：/givepoints @用户名 数量（回复消息时：/givepoints 数量）'); return true; }
    const trow = db.prepare('SELECT * FROM member_stats WHERE chatId = ? AND userId = ?').get(chatId, target.userId);
    if (trow) db.prepare('UPDATE member_stats SET points = MAX(0, points + ?), username = ? WHERE chatId = ? AND userId = ?').run(delta, String(target.name || '').slice(0, 64), chatId, target.userId);
    else if (delta > 0) db.prepare('INSERT INTO member_stats (chatId, userId, username, points, totalMsgs, todayMsgs, todayDate, lastActive) VALUES (?, ?, ?, ?, 0, 0, ?, ?)').run(chatId, target.userId, String(target.name || '').slice(0, 64), delta, todayStr(), Date.now());
    await sendMsg(chatId, `✅ ${esc(target.name || `用户${target.userId}`)} 积分 ${delta > 0 ? '+' : ''}${delta}（当前 ${Math.max(0, (trow ? trow.points : 0) + delta)}）`);
    return true;
  }
  if (cmd === '/points' || cmd === '/积分') {
    const row = db.prepare('SELECT * FROM member_stats WHERE chatId = ? AND userId = ?').get(chatId, userId);
    if (!row) { await sendMsg(chatId, '📊 你还没有积分记录，多发言赚积分吧！'); return true; }
    const rank = db.prepare('SELECT COUNT(*) AS n FROM member_stats WHERE chatId = ? AND points > ?').get(chatId, row.points).n + 1;
    await sendMsg(chatId, `📊 **积分查询**\n\n⭐ 积分：${row.points}\n🏆 排名：第 ${rank} 名\n💬 总发言：${row.totalMsgs} 条`);
    return true;
  }
  if (cmd === '/rank' || cmd === '/排行') {
    const rows = db.prepare('SELECT * FROM member_stats WHERE chatId = ? ORDER BY points DESC LIMIT 10').all(chatId);
    if (!rows.length) { await sendMsg(chatId, '📊 暂无活跃排行数据'); return true; }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => `${medals[i] || '🎖'} ${i + 1}. ${esc(r.username || `用户${r.userId}`)} — ${r.points} 分`);
    await sendMsg(chatId, `🏆 **活跃排行 TOP10**\n\n${lines.join('\n')}`);
    return true;
  }
  if (cmd === '/stat' || cmd === '/统计') {
    const cnt = await tgApi('getChatMemberCount', { chat_id: chatId }).catch(() => null);
    const today = todayStr();
    const agg = db.prepare('SELECT COUNT(*) AS members, SUM(totalMsgs) AS total, SUM(todayMsgs) AS today, SUM(points) AS pts FROM member_stats WHERE chatId = ? AND todayDate = ?').get(chatId, today);
    const all = db.prepare('SELECT COUNT(*) AS members, SUM(totalMsgs) AS total, SUM(points) AS pts FROM member_stats WHERE chatId = ?').get(chatId);
    const memberCount = (cnt && cnt.ok) ? cnt.result : '?';
    await sendMsg(chatId, `📈 **群统计**\n\n👥 成员：${memberCount}\n📊 活跃成员：${all.members || 0}\n💬 今日消息：${agg.today || 0}\n💬 累计消息：${all.total || 0}\n⭐ 积分总量：${all.pts || 0}`);
    return true;
  }
  if (cmd === '/rules' || cmd === '/群规') {
    const raw = await LOTTERY_KV.get(`group_cfg:${chatId}`);
    const rules = raw ? (JSON.parse(raw).rules || '') : '';
    await sendMsg(chatId, rules ? `📜 **群规**\n\n${rules}` : '本群暂未设置群规');
    return true;
  }

  // 绑定抽奖中心账号
  if (cmd === '/bindlucky') {
    const parts = String(text).trim().split(/\s+/);
    const luckyUser = parts[1] ? parts[1].trim().replace(/^@/, '') : '';
    if (!luckyUser) { await sendMsg(chatId, '用法: /bindlucky 抽奖中心用户名。绑定后群内发言积分自动同步到抽奖中心。'); return true; }
    try {
      const r = await fetch(LUCKY_API_URL + '/lucky-admin/api/accounts', { headers: { 'x-admin-pw': LUCKY_ADMIN_PASSWORD } });
      const d = await r.json();
      const found = (d.accounts || []).find(a => a.username === luckyUser);
      if (!found) { await sendMsg(chatId, '抽奖中心里没有用户 ' + luckyUser + '，请先在抽奖中心注册。'); return true; }
    } catch(e) { console.error('绑定检查失败:', e.message); }
    db.prepare('INSERT OR REPLACE INTO lucky_bindings (userId, luckyUsername, boundAt) VALUES (?, ?, ?)').run(userId, luckyUser, Date.now());
    await sendMsg(chatId, '绑定成功! 抽奖中心账号: ' + luckyUser);
    return true;
  }
  // 解绑抽奖中心
  if (cmd === '/unbindlucky') {
    db.prepare('DELETE FROM lucky_bindings WHERE userId = ?').run(userId);
    await sendMsg(chatId, '已解绑抽奖中心账号。');
    return true;
  }
  // 查询绑定状态
  if (cmd === '/luckybind') {
    const row = db.prepare('SELECT luckyUsername FROM lucky_bindings WHERE userId = ?').get(userId);
    if (row) await sendMsg(chatId, '已绑定抽奖中心账号: ' + row.luckyUsername);
    else await sendMsg(chatId, '你还没有绑定，使用 /bindlucky 用户名 绑定。');
    return true;
  }

  if (cmd === '/help' || cmd === '/帮助') {
    await sendMsg(chatId, `🤖 **群组管家 · 群内命令**\n\n/points 查询我的积分
/bindlucky 绑定抽奖中心
/luckybind 查看绑定状态\n/rank 活跃排行 TOP10\n/stat 群数据统计\n/rules 查看群规\n/help 显示本帮助\n\n👮 管理员（回复目标消息或 @用户名）：\n/warn 警告 · /mute 禁言1小时\n/kick 踢出 · /ban 封禁 · /unban 解封\n\n🎁 参与群抽奖：直接发送口令即可`);
    return true;
  }
  // 群管快捷命令（管理员）：回复目标消息或 @用户名
  if (['/warn', '/mute', '/kick', '/ban', '/unban'].includes(cmd)) {
    const admin = await isPrivileged(chatId, userId);
    if (!admin) {
      await sendMsg(chatId, '❌ 只有群管理员可以使用该命令');
      return true;
    }
    const target = await resolveCmdTarget(chatId, text, replyMsg || null);
    if (!target) { await sendMsg(chatId, '❌ 请回复目标用户的消息，或 @用户名 指定目标'); return true; }
    const name = target.name || `用户${target.userId}`;
    const uid = target.userId;
    if (cmd === '/warn') {
      const key = `fwarns:${chatId}:${uid}`;
      const raw = await LOTTERY_KV.get(key);
      const n = (parseInt(raw, 10) || 0) + 1;
      await LOTTERY_KV.put(key, String(n));
      if (n >= 3) {
        await tgApi('restrictChatMember', { chat_id: chatId, user_id: uid, permissions: { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false, can_add_web_page_previews: false }, until_date: Math.floor(Date.now() / 1000) + 3600 }).catch(() => null);
        await LOTTERY_KV.delete(key);
        await sendMsg(chatId, `⚠️ ${esc(name)} 累计警告 ${n} 次，已自动禁言 1 小时。`);
      } else {
        await sendMsg(chatId, `⚠️ ${esc(name)} 已被警告（${n}/3），满 3 次将自动禁言 1 小时。`);
      }
    } else if (cmd === '/mute') {
      await tgApi('restrictChatMember', { chat_id: chatId, user_id: uid, permissions: { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false, can_add_web_page_previews: false }, until_date: Math.floor(Date.now() / 1000) + 3600 }).catch(() => null);
      await sendMsg(chatId, `🔇 ${esc(name)} 已被禁言 1 小时。`);
    } else if (cmd === '/kick') {
      await tgApi('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
      await tgApi('unbanChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
      await sendMsg(chatId, `👢 ${esc(name)} 已被移出群聊。`);
    } else if (cmd === '/ban') {
      await tgApi('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
      await sendMsg(chatId, `🚫 ${esc(name)} 已被封禁。`);
    } else if (cmd === '/unban') {
      await tgApi('unbanChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
      await sendMsg(chatId, `✅ ${esc(name)} 已被解封。`);
    }
    return true;
  }
  return false;
}

/* ================= 邀请链接系统 ================= */
async function getInviteStat(chatId, userId) {
  const raw = await LOTTERY_KV.get(`invite_stat:${chatId}:${userId}`);
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return { count: 0, points: 0 };
}
async function addInviteGain(chatId, userId, gain) {
  const stat = await getInviteStat(chatId, userId);
  stat.count += gain;
  const cfg = await getGroupCfg(chatId);
  const perInvite = (cfg.points && cfg.points.invite) || 0;
  if (perInvite > 0) {
    const pts = gain * perInvite;
    stat.points = (stat.points || 0) + pts;
    const row = db.prepare('SELECT * FROM member_stats WHERE chatId = ? AND userId = ?').get(chatId, userId);
    if (row) db.prepare('UPDATE member_stats SET points = points + ? WHERE chatId = ? AND userId = ?').run(pts, chatId, userId);
    else db.prepare('INSERT INTO member_stats (chatId, userId, username, points, totalMsgs, todayMsgs, todayDate, lastActive) VALUES (?, ?, ?, ?, 0, 0, ?, ?)').run(chatId, userId, `用户${userId}`, pts, todayStr(), Date.now());
  }
  await LOTTERY_KV.put(`invite_stat:${chatId}:${userId}`, JSON.stringify(stat));
}
async function runInvitePoll() {
  const list = await LOTTERY_KV.list({ prefix: 'invite_cfg:' });
  for (const k of (list.keys || [])) {
    const chatId = parseInt(k.name.split(':')[1], 10);
    if (!chatId) continue;
    let cfg = null;
    try { cfg = JSON.parse(await LOTTERY_KV.get(k.name)); } catch {}
    if (!cfg || cfg.enabled === false) continue;
    const linksRaw = await LOTTERY_KV.get(`invite_links:${chatId}`);
    if (!linksRaw) continue;
    let links = [];
    try { links = JSON.parse(linksRaw); } catch {}
    if (!Array.isArray(links)) continue;
    let changed = false;
    for (const L of links) {
      if (!L.link) continue;
      const r = await tgApi('getChatInviteLink', { chat_id: chatId, invite_link: L.link }).catch(() => null);
      if (!r || !r.ok) continue;
      const cnt = r.result.member_count || 0;
      const prev = L.lastCount || 0;
      if (cnt > prev) {
        await addInviteGain(chatId, L.userId, cnt - prev);
      }
      L.lastCount = cnt;
      changed = true;
    }
    if (changed) await LOTTERY_KV.put(`invite_links:${chatId}`, JSON.stringify(links));
  }
}

/* ================= 新成员限制 + 闪进闪退记录 ================= */
export async function onNewMembers(chatId, members) {
  if (!chatId || !Array.isArray(members)) return;
  const cfg = await getGroupCfg(chatId);
  // 屏蔽机器人：新成员是机器人自动封禁
  const blk = cfg.block || {};
  for (const m of members) {
    const uid = m?.id;
    if (!uid || uid === BOT_ID) continue;
    if (blk.robots && m.is_bot) {
      await tgApi('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
      continue;
    }
    await LOTTERY_KV.put(`join_ts:${chatId}:${uid}`, String(Date.now()), { expirationTtl: 900 });
  }
  const nm = cfg.newMember;
  if (nm && nm.enabled && nm.minutes > 0) {
    const until = Math.floor(Date.now() / 1000) + nm.minutes * 60;
    for (const m of members) {
      const uid = m?.id;
      if (!uid || uid === BOT_ID) continue;
      await tgApi('restrictChatMember', {
        chat_id: chatId, user_id: uid,
        permissions: { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false, can_add_web_page_previews: false },
        until_date: until,
      }).catch(() => null);
    }
  }
}

/* ================= 闪进闪退屏蔽 ================= */
export async function onMemberLeft(chatId, user) {
  const uid = user?.id;
  if (!chatId || !uid) return;
  const cfg = await getGroupCfg(chatId);
  const blk = cfg.block || {};
  // 退群封禁开关：离开即封禁
  if (blk.leaveBan) {
    await tgApi('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
    return;
  }
  const raw = await LOTTERY_KV.get(`join_ts:${chatId}:${uid}`);
  if (!raw) return;
  const joined = parseInt(raw) || 0;
  const as = cfg.antispam || { enabled: true, withinSec: 60 };
  if (as.enabled !== false && Date.now() - joined < (as.withinSec || 60) * 1000) {
    const name = user.username || user.first_name || `用户${uid}`;
    await tgApi('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
    await LOTTERY_KV.delete(`join_ts:${chatId}:${uid}`);
    await sendMsg(chatId, `🛡️ ${esc(name)} 加入后 ${as.withinSec || 60} 秒内退出（闪进闪退），已自动封禁。`);
  }
}

/* ================= 频道同步 ================= */
export async function onChannelPost(post) {
  const chatId = post?.chat?.id;
  const msgId = post?.message_id;
  if (!chatId || !msgId) return;
  const rows = db.prepare('SELECT * FROM chat_syncs WHERE sourceChatId = ? AND enabled = 1').all(chatId);
  for (const s of rows) {
    let targets = [];
    try { targets = JSON.parse(s.targetChatIds || '[]'); } catch (e) {}
    for (const t of targets) {
      await tgApi('copyMessage', { chat_id: t, from_chat_id: chatId, message_id: msgId }).catch(() => null);
    }
  }
}

/* ================= 编辑消息检测 ================= */
export async function onEditedMessage(chatId, userId, username, msgId, msg) {
  if (!chatId || !userId || !msgId) return;
  const cfg = await getGroupCfg(chatId);
  const ed = cfg.edited || { enabled: false };
  if (!ed.enabled) return;
  const am = await tgApi('getChatMember', { chat_id: chatId, user_id: userId }).catch(() => null);
  if (am && am.ok && (am.result.status === 'creator' || am.result.status === 'administrator')) return;
  const whitelist = (cfg.antispam && cfg.antispam.whitelist) || [];
  if (whitelist.includes(userId)) return;
  const mtype = msgTypeOf(msg);
  const isMedia = ['photo', 'video', 'document', 'audio'].includes(mtype);
  if (ed.blockMedia && isMedia) {
    await tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => null);
    await sendMsg(chatId, `⚠️ @${username || `用户${userId}`} 不允许编辑为媒体消息`);
    return;
  }
  if (ed.blockAll !== false) {
    await tgApi('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => null);
    await sendMsg(chatId, `⚠️ @${username || `用户${userId}`} 本群禁止编辑消息`);
  }
}

/* ================= 频道配置（KV） ================= */
export async function getChannelCfg(chatId) {
  const raw = await LOTTERY_KV.get(`chcfg:${chatId}`);
  if (raw) { try { const c = JSON.parse(raw); if (c && typeof c === 'object') return c; } catch {} }
  return { autoDelete: { pin: true, title: true, photo: true }, block: { leaveBan: false, flash: false, bot: false }, commentSofa: { enabled: false, text: '', button: '' }, adminScope: 'all', countDaily: true };
}
export async function setChannelCfg(chatId, cfg) {
  await LOTTERY_KV.put(`chcfg:${chatId}`, JSON.stringify(cfg));
  return cfg;
}

/* ================= 控制权限（谁能设置 bot） ================= */
export async function isPrivileged(chatId, userId) {
  const am = await tgApi('getChatMember', { chat_id: chatId, user_id: userId }).catch(() => null);
  if (!am || !am.ok) return false;
  const s = am.result.status;
  if (s === 'creator') return true;
  if (s !== 'administrator') return false;
  const cfg = await getGroupCfg(chatId).catch(() => ({}));
  const scope = cfg.adminScope || 'all';
  const pr = am.result;
  if (scope === 'creator') return false;
  if (scope === 'addadmin') return !!pr.can_promote_members;
  if (scope === 'banright') return !!pr.can_restrict_members;
  return true;
}

/* ================= 频道成员屏蔽（订阅/退订） ================= */
export async function onChannelMember(chatId, user, newStatus) {
  if (!chatId || !user || !user.id) return;
  const uid = user.id;
  const cfg = await getChannelCfg(chatId);
  const blk = cfg.block || {};
  if (newStatus === 'left' || newStatus === 'kicked') {
    if (blk.leaveBan) {
      await tgApi('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
      return;
    }
    if (blk.flash) {
      const raw = await LOTTERY_KV.get(`join_ts:${chatId}:${uid}`);
      if (raw && Date.now() - parseInt(raw, 10) < 60 * 1000) {
        await tgApi('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
      }
    }
    return;
  }
  if (newStatus === 'member') {
    await LOTTERY_KV.put(`join_ts:${chatId}:${uid}`, String(Date.now()), { expirationTtl: 900 });
    if (blk.bot && user.is_bot) {
      await tgApi('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => null);
    }
  }
}

/* ================= 评论沙发（频道帖子抢占评论区） ================= */
export async function onChannelSofa(post, env) {
  try {
    const chatId = post?.chat?.id;
    const postId = post?.message_id;
    if (!chatId || !postId) return;
    const cfg = await getChannelCfg(chatId);
    const sofa = cfg.commentSofa || {};
    if (!sofa.enabled || !sofa.text) return;
    const ci = await tgApi('getChat', { chat_id: chatId }).catch(() => null);
    const linked = ci && ci.ok ? ci.result.linked_chat_id : null;
    if (!linked) {
      console.log(`[评论沙发] 频道 ${chatId} 未绑定讨论群，无法抢沙发`);
      return;
    }
    const payload = { chat_id: linked, reply_to_message_id: postId, text: sofa.text };
    if (sofa.button && Array.isArray(sofa.button.keyboard) && sofa.button.keyboard.length) {
      payload.reply_markup = { inline_keyboard: sofa.button.keyboard };
    }
    await tgApi('sendMessage', payload).catch(() => null);
  } catch (e) { console.error('[评论沙发]', e.message); }
}

/* ================= 人数统计（每日/每小时记录趋势） ================= */
async function runMemberCounts() {
  const hourKey = `mc_hour:${todayStr()}:${Math.floor(Date.now() / 3600000)}`;
  const done = await LOTTERY_KV.get(hourKey);
  if (done) return;
  const groupsRaw = await LOTTERY_KV.get('bot_groups');
  const channelsRaw = await LOTTERY_KV.get('bot_channels');
  const targets = [];
  if (groupsRaw) { try { targets.push(...JSON.parse(groupsRaw)); } catch {} }
  if (channelsRaw) { try { targets.push(...JSON.parse(channelsRaw)); } catch {} }
  const date = todayStr();
  for (const t of targets) {
    const r = await tgApi('getChatMemberCount', { chat_id: t.id }).catch(() => null);
    if (r && r.ok) {
      db.prepare('INSERT INTO member_counts (chatId, date, count) VALUES (?, ?, ?) ON CONFLICT(chatId, date) DO UPDATE SET count = excluded.count')
        .run(t.id, date, r.result);
    }
  }
  await LOTTERY_KV.put(hourKey, '1', { expirationTtl: 7200 });
}
export function getMemberCountTrend(chatId, days) {
  const rows = db.prepare('SELECT date, count FROM member_counts WHERE chatId = ? ORDER BY date DESC LIMIT ?').all(chatId, days || 14);
  return rows.reverse();
}

/* ================= 定时消息 ================= */
async function runScheduledMessages() {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM scheduled_messages WHERE enabled = 1 AND nextRunAt <= ? LIMIT 20').all(now);
  for (const r of rows) {
    const sent = await sendMsg(r.chatId, r.text);
    const next = Date.now() + r.intervalMinutes * 60000;
    if (sent && sent.ok) {
      db.prepare('UPDATE scheduled_messages SET nextRunAt = ? WHERE id = ?').run(next, r.id);
    } else {
      db.prepare('UPDATE scheduled_messages SET nextRunAt = ? WHERE id = ?').run(now + 60000, r.id);
    }
  }
}

/* ================= 夜间模式 ================= */
function inRange(h, m, start, end) {
  const cur = h * 60 + m;
  const s = String(start || '22:00').split(':').map(Number);
  const e = String(end || '07:00').split(':').map(Number);
  const sMin = (s[0] || 0) * 60 + (s[1] || 0);
  const eMin = (e[0] || 0) * 60 + (e[1] || 0);
  if (sMin <= eMin) return cur >= sMin && cur < eMin;
  return cur >= sMin || cur < eMin;
}
function allPerms(can) {
  return {
    can_send_messages: can, can_send_media_messages: can, can_send_other_messages: can,
    can_add_web_page_previews: can, can_send_polls: can, can_change_info: can,
    can_invite_users: can, can_pin_messages: can,
  };
}
async function runNightMode() {
  const d = new Date();
  if (d.getMinutes() % 5 !== 0) return;
  const h = d.getHours(), m = d.getMinutes();
  const rows = db.prepare('SELECT chatId, cfg FROM group_settings').all();
  for (const r of rows) {
    const cfg = JSON.parse(r.cfg || '{}');
    const nm = cfg.nightMode;
    if (!nm || !nm.enabled) continue;
    const key = `night_active:${r.chatId}`;
    const was = await LOTTERY_KV.get(key);
    const active = inRange(h, m, nm.start, nm.end);
    if (active && !was) {
      const res = await tgApi('setChatPermissions', { chat_id: r.chatId, permissions: allPerms(false) });
      if (res && res.ok) await LOTTERY_KV.put(key, '1');
    } else if (!active && was) {
      const res = await tgApi('setChatPermissions', { chat_id: r.chatId, permissions: allPerms(true) });
      if (res && res.ok) await LOTTERY_KV.delete(key);
    }
  }
}

/* ================= 调度器 ================= */
export function startScheduler() {
  setInterval(async () => {
    try { await runScheduledMessages(); } catch (e) { console.error('[定时消息]', e.message); }
    try { await runNightMode(); } catch (e) { console.error('[夜间模式]', e.message); }
    try { await runInvitePoll(); } catch (e) { console.error('[邀请统计]', e.message); }
    try { await runMemberCounts(); } catch (e) { console.error('[人数统计]', e.message); }
  }, 60 * 1000).unref();
}

/* ================= 管理接口（Mini App 调用） ================= */
export function countRows(table) {
  const t = String(table).replace(/[^a-z_]/gi, '');
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (e) { return 0; }
}
export function listScheduled(chatId) {
  const rows = chatId
    ? db.prepare('SELECT * FROM scheduled_messages WHERE chatId = ? ORDER BY id DESC').all(chatId)
    : db.prepare('SELECT * FROM scheduled_messages ORDER BY id DESC LIMIT 100').all();
  return rows.map((r) => ({ ...r }));
}
export function addScheduled(chatId, chatType, text, intervalMinutes) {
  const id = db.prepare('INSERT INTO scheduled_messages (chatId, chatType, text, intervalMinutes, nextRunAt, enabled, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(chatId, chatType || 'group', text, intervalMinutes, Date.now(), Date.now()).lastInsertRowid;
  return { ok: true, id: Number(id) };
}
export function delScheduled(id) {
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
  return { ok: true };
}
export function toggleScheduled(id, enabled) {
  db.prepare('UPDATE scheduled_messages SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return { ok: true };
}

export function listKeywords(chatId) {
  return db.prepare('SELECT * FROM keyword_replies WHERE chatId = ? ORDER BY id DESC').all(chatId);
}
export function addKeyword(chatId, keyword, reply) {
  const id = db.prepare('INSERT INTO keyword_replies (chatId, keyword, reply, enabled, createdAt) VALUES (?, ?, ?, 1, ?)')
    .run(chatId, keyword, reply, Date.now()).lastInsertRowid;
  return { ok: true, id: Number(id) };
}
export function delKeyword(id) {
  db.prepare('DELETE FROM keyword_replies WHERE id = ?').run(id);
  return { ok: true };
}
export function toggleKeyword(id, enabled) {
  db.prepare('UPDATE keyword_replies SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return { ok: true };
}

export function listSyncs() {
  return db.prepare('SELECT * FROM chat_syncs ORDER BY id DESC').all().map((r) => ({ ...r, targetChatIds: JSON.parse(r.targetChatIds || '[]') }));
}
export function addSync(sourceChatId, targetChatIds) {
  const id = db.prepare('INSERT INTO chat_syncs (sourceChatId, targetChatIds, enabled, createdAt) VALUES (?, ?, 1, ?)')
    .run(sourceChatId, JSON.stringify(targetChatIds), Date.now()).lastInsertRowid;
  return { ok: true, id: Number(id) };
}
export function delSync(id) {
  db.prepare('DELETE FROM chat_syncs WHERE id = ?').run(id);
  return { ok: true };
}
export function toggleSync(id, enabled) {
  db.prepare('UPDATE chat_syncs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return { ok: true };
}

export function getGroupStats(chatId) {
  const today = todayStr();
  const rows = db.prepare('SELECT * FROM member_stats WHERE chatId = ? ORDER BY points DESC').all(chatId);
  const todayAgg = db.prepare('SELECT SUM(todayMsgs) AS today, COUNT(*) AS active FROM member_stats WHERE chatId = ? AND todayDate = ?').get(chatId, today);
  const allAgg = db.prepare('SELECT SUM(totalMsgs) AS total, SUM(points) AS pts FROM member_stats WHERE chatId = ?').get(chatId);
  return {
    members: rows.length,
    todayMsgs: todayAgg.today || 0,
    todayActive: todayAgg.active || 0,
    totalMsgs: allAgg.total || 0,
    totalPoints: allAgg.pts || 0,
    top: rows.slice(0, 10).map((r, i) => ({ rank: i + 1, username: r.username, userId: r.userId, points: r.points, totalMsgs: r.totalMsgs })),
  };
}

export async function getInviteStatsAll(chatId) {
  const list = await LOTTERY_KV.list({ prefix: `invite_stat:${chatId}:` });
  const rows = [];
  for (const k of (list.keys || [])) {
    const uid = parseInt(k.name.split(':')[2], 10);
    const st = await getInviteStat(chatId, uid);
    rows.push({ userId: uid, count: st.count, points: st.points || 0 });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, 50);
}
export async function resetInviteData(chatId) {
  await LOTTERY_KV.put(`invite_links:${chatId}`, '[]');
  const list = await LOTTERY_KV.list({ prefix: `invite_stat:${chatId}:` });
  for (const k of (list.keys || [])) await LOTTERY_KV.delete(k.name);
  return { ok: true, message: '邀请数据已清空' };
}
export async function adjustPoints(chatId, userId, delta) {
  if (!chatId || !userId || !delta) return { ok: false, error: '参数不完整' };
  const row = db.prepare('SELECT * FROM member_stats WHERE chatId = ? AND userId = ?').get(chatId, userId);
  if (row) db.prepare('UPDATE member_stats SET points = MAX(0, points + ?) WHERE chatId = ? AND userId = ?').run(delta, chatId, userId);
  else if (delta > 0) db.prepare('INSERT INTO member_stats (chatId, userId, username, points, totalMsgs, todayMsgs, todayDate, lastActive) VALUES (?, ?, ?, ?, 0, 0, ?, ?)').run(chatId, userId, `用户${userId}`, delta, todayStr(), Date.now());
  return { ok: true, message: '积分已更新' };
}

export default {
  onGroupMessage, onCommand, onNewMembers, onMemberLeft, onChannelPost, onEditedMessage, onChannelMember, onChannelSofa,
  startScheduler, getGroupCfg, setGroupCfg, patchGroupCfg, getChannelCfg, setChannelCfg, isPrivileged,
  countRows, listScheduled, addScheduled, delScheduled, toggleScheduled,
  listKeywords, addKeyword, delKeyword, toggleKeyword,
  listSyncs, addSync, delSync, toggleSync,
  getGroupStats, getInviteStatsAll, resetInviteData, adjustPoints, getMemberCountTrend,
};
