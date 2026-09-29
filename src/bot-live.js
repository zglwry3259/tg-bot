import * as lucky from './lucky.js';
import { grantToMmwx } from './mmwx-grant.js';
/**
 * 群组管家 v6.7.11 - 服务器版（VPS / Node.js）
 * 抽奖 + 入群验证 + 公告 + 投票 + 群管 + 防广告/链接 + 删除服务消息 + 全局广播
 * 从 Cloudflare Workers 改造，使用本地 JSON 存储
 */

import LOTTERY_KV from './sql-store.js'; // 原 ./kv-store.js；SQLite 优先，driver 不可用时自动回退 KV
import * as features from './features.js';

const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org:18443';

// ===== 安全工具函数 =====
function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function kvGetJson(key, fallback) {
  const raw = await LOTTERY_KV.get(key);
  return safeJsonParse(raw, fallback);
}

async function kvPutJson(key, val) {
  await LOTTERY_KV.put(key, JSON.stringify(val));
}

// ===== 积分内存缓存（解决竞态+减少KV读写）=====
const pointsCache = new Map(); // userId -> { points, name, dirty }
const POINTS_FLUSH_MS = 30000; // 30秒刷写一次
let pointsFlushTimer = null;

function getPointsFromCache(userId) {
  const e = pointsCache.get(String(userId));
  return e ? e.points : null;
}

async function addPoints(userId, delta, name) {
  const key = String(userId);
  let e = pointsCache.get(key);
  if (!e) {
    const cur = parseInt(await LOTTERY_KV.get(`points:${key}`) || '0', 10);
    e = { points: cur, name: name || '', dirty: false };
    pointsCache.set(key, e);
  }
  e.points += delta;
  if (name) e.name = name;
  e.dirty = true;
  // 更新排行榜快照
  updatePointsRank(key, e.points, e.name);
  return e.points;
}

async function getPoints(userId) {
  const key = String(userId);
  const e = pointsCache.get(key);
  if (e) return e.points;
  const cur = parseInt(await LOTTERY_KV.get(`points:${key}`) || '0', 10);
  pointsCache.set(key, { points: cur, name: '', dirty: false });
  return cur;
}

async function flushPoints() {
  const promises = [];
  for (const [key, e] of pointsCache) {
    if (e.dirty) {
      e.dirty = false;
      promises.push(LOTTERY_KV.put(`points:${key}`, String(e.points)));
      if (e.name) promises.push(LOTTERY_KV.put(`points_name:${key}`, e.name));
    }
  }
  await Promise.all(promises);
}

// ===== 积分排行榜快照 =====
const pointsRankCache = []; // [{uid, points, name}] 已排序降序
let pointsRankDirty = false;

async function updatePointsRank(uid, points, name) {
  const idx = pointsRankCache.findIndex(x => x.uid === uid);
  if (idx >= 0) {
    pointsRankCache[idx].points = points;
    if (name) pointsRankCache[idx].name = name;
  } else {
    pointsRankCache.push({ uid, points, name: name || '' });
    // 同步 points_index
    const idxRaw = await LOTTERY_KV.get('points_index');
    const idxArr = safeJsonParse(idxRaw, []);
    if (!idxArr.some(x => String(x) === String(uid))) {
      idxArr.push(String(uid));
      await LOTTERY_KV.put('points_index', JSON.stringify(idxArr));
    }
  }
  pointsRankCache.sort((a, b) => b.points - a.points);
  if (pointsRankCache.length > 200) pointsRankCache.length = 200;
  pointsRankDirty = true;
}

async function flushPointsRank() {
  if (!pointsRankDirty) return;
  pointsRankDirty = false;
  await kvPutJson('points_rank_top', pointsRankCache);
}

// 处理 Telegram 更新（供服务器入口调用）
export async function processUpdate(update) {
  try {
    const updateId = update.update_id;
    if (updateId) {
      const seen = await LOTTERY_KV.get(`seen:${updateId}`);
      if (seen) return;
      await LOTTERY_KV.put(`seen:${updateId}`, '1', { expirationTtl: 86400 });
    }
    await handleUpdate(update, {});
  } catch (err) {
    console.error('Error:', err);
  }
}

// 定时任务（每分钟调用一次，供服务器入口调用）
export async function runScheduledTasks() {
  await loadTzOffset({});
  await checkScheduledDraws({});
  await checkPendingVerifications({});
  await checkFsubExpired({});
  await autoFsubRounds({});
  await ensureCommands({});
  await flushPoints();
  await flushPointsRank();
}

async function ensureCommands(env) {
  try {
    const flag = await LOTTERY_KV.get('commands_set_v22');
    if (flag === '1') return;
    const token = process.env.BOT_TOKEN || '';
    const url = `${TELEGRAM_API}/bot${token}/setMyCommands`;
    const privateCommands = [
    { command: 'checkin', description: '📅 每日签到赢抽奖次数' },
    { command: 'draw', description: '🎰 抽奖（可带次数）' },
    { command: 'prizes', description: '🎁 查看所有奖品' },
    { command: 'bag', description: '🎒 我的背包' },
    { command: 'bindmmwx', description: '🔗 绑定mmwx账号' },
    { command: 'exchange', description: '💱 兑换奖品到mmwx' },
    { command: 'points', description: '💰 我的积分与排行' },
    { command: 'mall', description: '🛒 积分商城' },
    { command: 'traffic', description: '📊 流量使用排行榜' },
    { command: 'mod', description: '🛡️ 群管理设置' },
    { command: 'chmod', description: '📢 频道管理（自动按钮）' },
    { command: 'grantpoints', description: '🔒 [管理员] 发积分给用户' },
    { command: 'grantdraws', description: '🔒 [管理员] 发抽奖次数' },
    { command: 'grantitem', description: '🔒 [管理员] 发背包物品' },
    { command: 'grantallpoints', description: '🔒 [管理员] 全员发积分' },
    { command: 'grantalldraws', description: '🔒 [管理员] 全员发抽奖' },
    { command: 'openlottery', description: '🎲 开奖（需要抽奖ID）' },
  ];;
    const groupCommands = [
    { command: 'list', description: '📋 查看本群抽奖' },
    { command: 'draw', description: '🎲 手动开奖 用法: /draw <ID>' },
    { command: 'cancel', description: '❌ 取消抽奖 用法: /cancel <ID>' },
    { command: 'subinfo', description: '📊 查询我的订阅信息' },
    { command: 'checkin', description: '📅 每日签到赢抽奖次数' },
    { command: 'lottery', description: '🎰 幸运抽奖 用法: /lottery [次数]' },
    { command: 'bag', description: '🎒 查看我的背包' },
    { command: 'pool', description: '🎟 抽奖奖池(积分参与)' },
    { command: 'points', description: '💰 我的积分与排行' },
    { command: 'mall', description: '🛒 积分商城' },
    { command: 'traffic', description: '📊 流量使用排行榜' },
    { command: 'bug', description: '🐞 提交 BUG 用法: /bug 内容' },
    { command: 'suggest', description: '💡 提交建议 用法: /suggest 内容' },
    { command: 'issues', description: '📋 查看我的反馈进度' },
    { command: 'ibugs', description: '🔒 查看全部反馈(管理员)' },
    { command: 'poolcreate', description: '🔒 创建奖池(管理员)' },
    { command: 'give', description: '🔒 发放积分(管理员)' },
    { command: 'bindings', description: '🔒 绑定列表(管理员)' },
    { command: 'settings', description: '🔒 群功能开关(管理员)' },
    { command: 'mod', description: '🛡️ 群管理设置' },
    { command: 'verify', description: '🔒 入群验证开关: /verify on|off' },
    { command: 'forcesub', description: '🔒 强制关注频道: /forcesub @频道|off' },
    { command: 'fsubcheck', description: '🔒 巡检成员频道关注' },
    { command: 'mute', description: '🔒 禁言: 回复+ /mute 1h' },
    { command: 'kick', description: '🔒 踢出: 回复+ /kick' },
    { command: 'ban', description: '🔒 封禁: 回复+ /ban' },
    { command: 'warn', description: '🔒 警告: 回复+ /warn' },
    { command: 'rules', description: '🔒 查看/设置群规' },
    { command: 'welcome', description: '🔒 设置欢迎语' },
    { command: 'admins', description: '🔒 管理员列表' },
    { command: 'info', description: 'ℹ️ 群信息' },
    { command: 'start', description: '📖 帮助说明' },
    ];
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: privateCommands }),
    });
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: { type: 'all_group_chats' }, commands: groupCommands }),
    });
    await LOTTERY_KV.put('commands_set_v22', '1');
  } catch (err) { console.error('ensureCommands error:', err); }
}

async function checkScheduledDraws(env) {
  try {
    const raw = await LOTTERY_KV.get('scheduled_draws');
    if (!raw) return;
    const ids = safeJsonParse(raw, []);
    if (!Array.isArray(ids) || ids.length === 0) return;
    const now = Date.now();
    const remaining = [];
    const kraws = await Promise.all(ids.map(id => LOTTERY_KV.get(`lottery:${id}`)));
    for (let i = 0; i < ids.length; i++) {
      const kraw = kraws[i];
      if (!kraw) continue;
      const lottery = safeJsonParse(kraw, {});
      if (lottery.status !== 'active') continue;
      if (now < lottery.triggerValue) { remaining.push(ids[i]); continue; }
      if (lottery.participants.length === 0) {
        lottery.status = 'cancelled';
        await LOTTERY_KV.put(`lottery:${ids[i]}`, JSON.stringify(lottery));
        await sendMessage(lottery.groupId, `⏰ 开奖时间已到，但「${esc(lottery.name)}」无人参与，已自动取消`, env);
      } else {
        try {
          await executeDraw(ids[i], lottery, env, lottery.groupName);
        } catch (e) {
          console.error('executeDraw failed for', ids[i], e);
          remaining.push(ids[i]); // 失败时保留，下次重试
        }
      }
    }
    await LOTTERY_KV.put('scheduled_draws', JSON.stringify(remaining));
  } catch (err) { console.error('Scheduled draw error:', err); }
}

async function addToScheduled(env, lotteryId) {
  const raw = await LOTTERY_KV.get('scheduled_draws');
  let ids = safeJsonParse(raw, []);
  if (!Array.isArray(ids)) ids = [];
  if (!ids.includes(lotteryId)) ids.push(lotteryId);
  await LOTTERY_KV.put('scheduled_draws', JSON.stringify(ids));
}

async function removeFromScheduled(env, lotteryId) {
  const raw = await LOTTERY_KV.get('scheduled_draws');
  if (!raw) return;
  let ids = safeJsonParse(raw, []);
  if (!Array.isArray(ids)) return;
  ids = ids.filter(id => id !== lotteryId);
  await LOTTERY_KV.put('scheduled_draws', JSON.stringify(ids));
}

async function handleUpdate(update, env) {
  await loadTzOffset(env);
  if (update.message) {
    if (update.message.text && update.message.text.startsWith('/')) {
      await handleMessage(update.message, env);
    } else {
      handleMessage(update.message, env).catch(e => console.error('handleMessage async error:', e));
    }
  } else if (update.callback_query) await handleCallbackQuery(update.callback_query, env);
  else if (update.my_chat_member) await handleMyChatMember(update.my_chat_member, env);
  else if (update.chat_member) await handleChatMember(update.chat_member, env);
  else if (update.channel_post) await handleChannelPost(update.channel_post, env);
  else if (update.edited_message) await handleEditedMessage(update.edited_message, env);
}

// TGBot 功能：编辑消息检测（屏蔽编辑消息/编辑为媒体）
async function handleEditedMessage(msg, env) {
  try {
    const chat = msg.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
    const userId = msg.from?.id;
    if (!userId) return;
    await features.onEditedMessage(chat.id, userId, msg.from.username || '', msg.message_id, msg);
  } catch (e) { console.error('编辑检测错误:', e.message); }
}

// 频道自动置顶 + 清理系统消息：管理员发布新帖自动置顶，系统消息（置顶通知等）自动删除
async function handleChannelPost(post, env) {
  try {
    const chat = post.chat;
    if (!chat || chat.type !== 'channel') return;
    // 检测系统服务消息（置顶通知/入退群/改标题等）
    const isService = !!(post.pinned_message || post.new_chat_members || post.left_chat_member
      || post.new_chat_title || post.new_chat_photo || post.delete_chat_photo
      || post.group_chat_created || post.supergroup_chat_created || post.channel_chat_created);
    if (isService) {
      // TGBot：频道自动删除系统消息开关（置顶/改头像/改名称）
      try {
        const chcfg = await features.getChannelCfg(chat.id);
        const ad = chcfg.autoDelete || { pin: true, title: true, photo: true };
        const isPin = !!post.pinned_message;
        const isTitle = !!post.new_chat_title;
        const isPhoto = !!(post.new_chat_photo || post.delete_chat_photo);
        const isMember = !!(post.new_chat_members || post.left_chat_member);
        const del = isMember || (isPin && ad.pin !== false) || (isTitle && ad.title !== false) || (isPhoto && ad.photo !== false);
        if (del && post.message_id) {
          await tgApi(env, 'deleteMessage', { chat_id: chat.id, message_id: post.message_id }).catch(() => null);
        }
      } catch (e) { console.error('[频道自动删除]', e.message); }
      return;
    }
    // 普通帖子：如有自动按钮配置 → 优先直接给原帖加内联键盘；失败再复制替换
    if (post.message_id) {
      // TGBot 功能：频道同步转发（在自动按钮复制前，转发原帖）
      try { await features.onChannelPost(post); } catch (e) { console.error('[频道同步]', e.message); }
      // TGBot 功能：评论沙发（机器人抢占评论区）
      try { await features.onChannelSofa(post, env); } catch (e) { console.error('[评论沙发]', e.message); }
      try {
        const btnRaw = await LOTTERY_KV.get(`btn:${chat.id}`);
        const cfg = safeJsonParse(btnRaw, null);
        if (cfg && cfg.keyboard && cfg.keyboard.length) {
          const markup = cfg.mode === 'reply'
            ? { keyboard: cfg.keyboard, resize_keyboard: true, is_persistent: true, input_field_placeholder: '点击下方按钮' }
            : { inline_keyboard: cfg.keyboard };
          if (cfg.mode !== 'reply') {
            const ed = await tgApi(env, 'editMessageReplyMarkup', {
              chat_id: chat.id,
              message_id: post.message_id,
              reply_markup: markup,
            }).catch(e => { console.log('[自动按钮] 改原帖失败:', chat.id, e?.message || e); return null; });
            if (ed && ed.ok) {
              console.log('[自动按钮] 已加到原帖', chat.id, post.message_id);
              await tgApi(env, 'pinChatMessage', { chat_id: chat.id, message_id: post.message_id, disable_notification: true }).catch(() => null);
              return;
            }
            console.log('[自动按钮] editMarkup未成功', chat.id, ed && ed.description);
          }
          // 复制原帖内容并附加按钮（同一消息：文字/媒体 + 按钮）
          const cp = await tgApi(env, 'copyMessage', {
            chat_id: chat.id,
            from_chat_id: chat.id,
            message_id: post.message_id,
            reply_markup: markup,
          }).catch(e => { console.log('[自动按钮] 复制失败:', chat.id, e?.message || e); return null; });
          if (cp && cp.ok) {
            await tgApi(env, 'deleteMessage', { chat_id: chat.id, message_id: post.message_id }).catch(() => null);
            await tgApi(env, 'pinChatMessage', { chat_id: chat.id, message_id: cp.result.message_id, disable_notification: true }).catch(() => null);
            return;
          }
          console.log('[自动按钮] 复制也失败', chat.id, cp && cp.description);
        }
      } catch (e) { console.log('[自动按钮] 错误:', e.message); }
      // 无按钮配置或复制失败：保持原帖置顶
      await tgApi(env, 'pinChatMessage', { chat_id: chat.id, message_id: post.message_id, disable_notification: true })
        .catch(e => console.log('[频道置顶] 失败:', chat.id, e?.message || e));
    }
  } catch (err) {
    console.error('handleChannelPost error:', err);
  }
}

// ==================== 违禁词功能 ====================

async function getBannedCfg(groupId) {
  const raw = await LOTTERY_KV.get(`banned:${groupId}`);
  if (raw) { try { const c = JSON.parse(raw); if (c && typeof c === 'object') return c; } catch {} }
  return { enabled: false, words: [], warnLimit: 3, muteMinutes: 60, remindDelete: true };
}

async function saveBannedCfg(groupId, cfg) {
  await LOTTERY_KV.put(`banned:${groupId}`, JSON.stringify(cfg));
}

async function showBannedMenu(chatId, msgId, env, userId, groupId) {
  const g = (await getBotGroups(env)).find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, '❌ 你不是该群管理员。', env); return; }
  const cfg = await getBannedCfg(groupId);
  const kb = [
    [{ text: cfg.enabled ? '✅ 开启' : '🔴 关闭', callback_data: `mod_pick:${groupId}:banned_toggle` }],
    [{ text: '➕ 添加违禁词', callback_data: `mod_pick:${groupId}:banned_add` }, { text: '📋 违禁词列表', callback_data: `mod_pick:${groupId}:banned_list` }],
    [{ text: '⚙️ 惩罚设置', callback_data: `mod_pick:${groupId}:banned_punish` }, { text: cfg.remindDelete ? '🗑 删除提醒:开' : '🗑 删除提醒:关', callback_data: `mod_pick:${groupId}:banned_remind` }],
    [{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }],
  ];
  await editMsg(chatId, msgId, `🚫 **违禁词** — ${esc(gname)}\n\n状态：${cfg.enabled ? '开启 ✅' : '关闭 ❌'}\n惩罚：警告 ${cfg.warnLimit} 次后禁言 ${cfg.muteMinutes} 分钟\n违禁词：${cfg.words.length} 个\n删除提醒：${cfg.remindDelete ? '开启' : '关闭'}`, env, kb);
}

async function bannedAction(chatId, msgId, userId, groupId, action, env) {
  const g = (await getBotGroups(env)).find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, '❌ 你不是该群管理员。', env); return; }
  const cfg = await getBannedCfg(groupId);

  if (action === 'banned_toggle') {
    cfg.enabled = !cfg.enabled;
    await saveBannedCfg(groupId, cfg);
    await showBannedMenu(chatId, msgId, env, userId, groupId);
    return;
  }
  if (action === 'banned_remind') {
    cfg.remindDelete = !cfg.remindDelete;
    await saveBannedCfg(groupId, cfg);
    await showBannedMenu(chatId, msgId, env, userId, groupId);
    return;
  }
  if (action === 'banned_add') {
    await LOTTERY_KV.put(`banned_input:${userId}`, JSON.stringify({ groupId, action: 'add' }), { expirationTtl: 900 });
    const kb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]];
    const current = cfg.words.length ? cfg.words.map(w => `\`${esc(w)}\``).join('、') : '（无）';
    await editMsg(chatId, msgId, `➕ **添加违禁词** — ${esc(gname)}\n\n请直接发送违禁词（多个用逗号或空格分隔）：\n\n当前违禁词：${current}`, env, kb);
    return;
  }
  if (action === 'banned_list') {
    if (!cfg.words.length) { await editMsg(chatId, msgId, `📋 **违禁词列表** — ${esc(gname)}\n\n（暂无违禁词）`, env); return; }
    const kb = cfg.words.map((w, i) => [{ text: `${i + 1}. ${esc(w)}`, callback_data: `mod_pick:${groupId}:banned_del:${i}` }]);
    kb.push([{ text: '🔙 返回', callback_data: `mod_pick:${groupId}` }, { text: '🗑 全部清空', callback_data: `mod_pick:${groupId}:banned_clear` }]);
    await editMsg(chatId, msgId, `📋 **违禁词列表** — ${esc(gname)}（${cfg.words.length}个）\n\n点击词条可删除：`, env, kb);
    return;
  }
  if (action.startsWith('banned_del')) {
    const idx = parseInt(action.split(':')[1]);
    if (!isNaN(idx) && cfg.words[idx]) {
      const removed = cfg.words.splice(idx, 1);
      await saveBannedCfg(groupId, cfg);
      await editMsg(chatId, msgId, `✅ 已删除违禁词「${esc(removed[0])}」`, env);
    }
    return;
  }
  if (action === 'banned_clear') {
    cfg.words = [];
    await saveBannedCfg(groupId, cfg);
    await editMsg(chatId, msgId, '✅ 已清空全部违禁词', env);
    return;
  }
  if (action === 'banned_punish') {
    await LOTTERY_KV.put(`banned_input:${userId}`, JSON.stringify({ groupId, action: 'punish' }), { expirationTtl: 900 });
    const kb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]];
    await editMsg(chatId, msgId, `⚙️ **惩罚设置** — ${esc(gname)}\n\n当前：警告 ${cfg.warnLimit} 次后禁言 ${cfg.muteMinutes} 分钟\n\n请发送格式：\`警告次数,禁言分钟\`\n示例：\`3,60\`（警告3次后禁言60分钟）`, env, kb);
    return;
  }
  await showBannedMenu(chatId, msgId, env, userId, groupId);
}

async function checkBannedWord(chatId, userId, username, text, messageId, env) {
  try {
    const cfg = await getBannedCfg(chatId);
    if (!cfg.enabled || !cfg.words.length) return false;
    const isAdmin = await getChatMemberStatus(chatId, userId, env);
    if (isAdminStatus(isAdmin)) return false;
    const lower = text.toLowerCase();
    const hit = cfg.words.find(w => w && lower.includes(w.toLowerCase()));
    if (!hit) return false;
    // 删除违规消息
    if (cfg.remindDelete && messageId) {
      await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null);
    }
    // 警告计数
    const warnKey = `banned_warns:${chatId}:${userId}`;
    const raw = await LOTTERY_KV.get(warnKey);
    let count = raw ? parseInt(raw) : 0;
    count += 1;
    const warnLimit = cfg.warnLimit || 3;
    await LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 60 * 60 });
    if (count >= warnLimit) {
      await LOTTERY_KV.delete(warnKey);
      const muteMinutes = cfg.muteMinutes || 60;
      let muted = false;
      if (await isBotAdmin(chatId, env)) {
        const until = Math.floor(Date.now() / 1000) + muteMinutes * 60;
        const r = await tgApi(env, 'restrictChatMember', { chat_id: chatId, user_id: userId, permissions: allPermissionsObject(false), until_date: until }).catch(() => null);
        muted = !!(r && r.ok);
        if (muted) await addBannedLog(chatId, userId, username, 'mute');
      }
      await sendMessage(chatId, `🚫 **${esc(username)}** 触发违禁词「${esc(hit)}」达 ${warnLimit} 次${muted ? `，已禁言 ${muteMinutes} 分钟` : '，但 bot 无权限禁言'}！`, env);
      return true;
    }
    await sendMessage(chatId, `⚠️ **${esc(username)}** 请注意，消息含违禁词「${esc(hit)}」！\n警告（${count}/${warnLimit}），满 ${warnLimit} 次将自动禁言。`, env);
    return true;
  } catch (e) { console.error('checkBannedWord error:', e.message); return false; }
}

// ==================== 进群欢迎（完整版） ====================

async function getWelcomeCfg(groupId) {
  const raw = await LOTTERY_KV.get(`welcome_cfg:${groupId}`);
  if (raw) { try { const c = JSON.parse(raw); if (c && typeof c === 'object') return c; } catch {} }
  // 兼容旧版 group_cfg.welcome 文本
  const old = await getGroupCfg(groupId, null);
  return { enabled: false, deleteMin: 0, text: old?.welcome || '', media: '', mediaType: 'photo', buttons: [] };
}

async function saveWelcomeCfg(groupId, cfg) {
  await LOTTERY_KV.put(`welcome_cfg:${groupId}`, JSON.stringify(cfg));
}

async function showWelcomeMenu(chatId, msgId, env, userId, groupId) {
  const g = (await getBotGroups(env)).find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, '❌ 你不是该群管理员。', env); return; }
  const cfg = await getWelcomeCfg(groupId);
  const kb = [
    [{ text: cfg.enabled ? '✅ 开启' : '🔴 关闭', callback_data: `mod_pick:${groupId}:welcome_toggle` }],
    [{ text: `删除消息(分钟): ${cfg.deleteMin || '否'}`, callback_data: `mod_pick:${groupId}:welcome_del` }],
    [{ text: '🗑 删除上一条', callback_data: `mod_pick:${groupId}:welcome_delmsg` }, { text: '👀 预览消息', callback_data: `mod_pick:${groupId}:welcome_preview` }],
    [{ text: '📝 修改文本', callback_data: `mod_pick:${groupId}:welcome_text` }, { text: '📷 修改媒体', callback_data: `mod_pick:${groupId}:welcome_media` }, { text: '🔘 修改按钮', callback_data: `mod_pick:${groupId}:welcome_btn` }],
    [{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }],
  ];
  const lines = [
    `👋 **进群欢迎** — ${esc(gname)}`,
    ``,
    `状态：${cfg.enabled ? '开启 ✅' : '关闭 ❌'}`,
    `删除消息(分钟)：${cfg.deleteMin || '否'}`,
    ``,
    `自定义欢迎内容：`,
    `🖼️ 媒体图片：${cfg.media ? '✅' : '❌'}`,
    `🔗 链接按钮：${cfg.buttons.length ? `✅(${cfg.buttons.length})` : '❌'}`,
    `📝 文本内容：${cfg.text ? '✅' : '❌'}`,
  ];
  await editMsg(chatId, msgId, lines.join('\n'), env, kb);
}

async function welcomeAction(chatId, msgId, userId, groupId, action, env) {
  const g = (await getBotGroups(env)).find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, '❌ 你不是该群管理员。', env); return; }
  const cfg = await getWelcomeCfg(groupId);

  if (action === 'welcome_toggle') {
    cfg.enabled = !cfg.enabled;
    await saveWelcomeCfg(groupId, cfg);
    return showWelcomeMenu(chatId, msgId, env, userId, groupId);
  }
  if (action === 'welcome_del') {
    const seq = [0, 1, 5, 10];
    const idx = seq.indexOf(cfg.deleteMin);
    cfg.deleteMin = seq[(idx + 1) % seq.length];
    await saveWelcomeCfg(groupId, cfg);
    return showWelcomeMenu(chatId, msgId, env, userId, groupId);
  }
  if (action === 'welcome_delmsg') {
    const last = await LOTTERY_KV.get(`welcome_last:${groupId}`);
    if (last) {
      await tgApi(env, 'deleteMessage', { chat_id: groupId, message_id: parseInt(last) }).catch(() => null);
      await LOTTERY_KV.delete(`welcome_last:${groupId}`);
      await editMsg(chatId, msgId, '✅ 已删除上一条欢迎消息', env);
    } else {
      await editMsg(chatId, msgId, 'ℹ️ 暂无欢迎消息记录（bot 在群内发送的欢迎消息会自动记录）', env);
    }
    return;
  }
  if (action === 'welcome_preview') {
    const name = '新成员';
    const text = (cfg.text || `👋 欢迎 ${name} 加入本群！`).replace(/\{name\}/g, name);
    const kb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }]];
    try {
      if (cfg.media) {
        if (cfg.mediaType === 'video') await tgApi(env, 'sendVideo', { chat_id: chatId, video: cfg.media, caption: text, reply_markup: cfg.buttons.length ? { inline_keyboard: cfg.buttons } : undefined }).catch(() => null);
        else await tgApi(env, 'sendPhoto', { chat_id: chatId, photo: cfg.media, caption: text, reply_markup: cfg.buttons.length ? { inline_keyboard: cfg.buttons } : undefined }).catch(() => null);
      } else {
        if (cfg.buttons && cfg.buttons.length) await sendMsgKb(chatId, text, cfg.buttons, env);
        else await sendMessage(chatId, text, env);
      }
      await editMsg(chatId, msgId, '👀 上面是欢迎消息预览（`{name}` 显示为"新成员"）', env, kb);
    } catch (e) {
      await editMsg(chatId, msgId, `❌ 预览失败：${e.message}`, env, kb);
    }
    return;
  }
  if (action === 'welcome_text' || action === 'welcome_media' || action === 'welcome_btn') {
    const sub = action.replace('welcome_', '');
    await LOTTERY_KV.put(`welcome_input:${userId}`, JSON.stringify({ groupId, action: sub }), { expirationTtl: 900 });
    const kb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]];
    const prompt = {
      text: `📝 **修改欢迎文本** — ${esc(gname)}\n\n请直接发送文本内容；\n\`{name}\` 自动替换为新成员名；\n发送 \`off\` 清除文本。`,
      media: `📷 **修改欢迎媒体** — ${esc(gname)}\n\n请发送**图片/视频的直链 URL**（https://...）；\n视频请以 \`video:\` 开头（如 \`video:https://.../a.mp4\`）；\n发送 \`off\` 清除媒体。`,
      btn: `🔘 **修改欢迎按钮** — ${esc(gname)}\n\n格式：\`名称-链接\`\n多个用 \`&&\` 或换行分隔；\n发送 \`off\` 清除按钮。`,
    }[sub];
    await editMsg(chatId, msgId, prompt, env, kb);
    return;
  }
  await showWelcomeMenu(chatId, msgId, env, userId, groupId);
}

async function handleNewMembers(chatId, members, env, sysMsgId) {
  const cfg = await getWelcomeCfg(chatId);
  if (sysMsgId) {
    // TGBot：自动删除系统消息开关（join 默认开启）
    let delSys = true;
    try { const fcfg = await features.getGroupCfg(chatId); delSys = (fcfg.autoDeleteSys || { join: true }).join !== false; } catch {}
    if (delSys) {
      const doDel = () => tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: sysMsgId }).catch(() => null);
      if (cfg.deleteMin > 0) setTimeout(doDel, cfg.deleteMin * 60 * 1000);
      else doDel();
    }
  }
  for (const m of members) {
    if (m.is_bot) continue;
    await addGroupMember(chatId, m);
  }
  // 欢迎语（含按钮）改在入群验证完成后发送（finishVerification）
  // TGBot 功能：新成员限制 + 闪进闪退记录
  try { await features.onNewMembers(chatId, members); } catch (e) { console.error('新成员限制错误:', e.message); }
}

// ==================== 封禁名单（解封查找用） ====================

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
  if (idx >= 0) {
    log.splice(idx, 1);
    await LOTTERY_KV.put(`banned_log:${groupId}`, JSON.stringify(log));
  }
}

// 链接规范化：@xxx → https://t.me/xxx；t.me/xxx → https://t.me/xxx
function normalizeUrl(url) {
  const u = (url || '').trim();
  if (!u) return null;
  if (/^@[A-Za-z0-9_]{3,}$/.test(u)) return `https://t.me/${u.slice(1)}`;
  if (/^t\.me\/[A-Za-z0-9_]+$/.test(u)) return `https://${u}`;
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

// 解析自动按钮配置
function parseAutoButtons(text) {
  if (!text || !text.trim()) return null;
  let title = '📌 更多信息';
  let body = text.trim();
  let mode = 'inline';
  // 底部键盘模式：#kb
  if (/^#kb\b/i.test(body)) {
    mode = 'reply';
    body = body.replace(/^#kb\b/i, '').trim();
  }
  // 分离标题：--- 或 ===
  const sepMatch = body.match(/\n\s*(?:-{3,}|={3,})\s*\n/);
  if (sepMatch) {
    const idx = body.indexOf(sepMatch[0]);
    const head = body.slice(0, idx).trim();
    if (head) title = head;
    body = body.slice(idx + sepMatch[0].length).trim();
  }
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const keyboard = [];
  for (const line of lines) {
    const items = line.split('&&').map(s => s.trim()).filter(Boolean);
    if (!items.length) continue;
    const row = [];
    for (const item of items) {
      // 忽略颜色前缀（#p/#r/#g/#D，Telegram 原生不支持按钮背景色）
      const clean = item.replace(/^#(p|r|g|D)\s*/i, '').trim();
      if (!clean) continue;
      if (mode === 'reply') {
        row.push({ text: clean });
      } else {
        // 名称-链接（第一个分隔符，兼容 - — – － 及两侧空格）
        const dm = clean.match(/^(.*?)\s*[-—–－]\s*(.*)$/);
        if (!dm) return null;
        const name = dm[1].trim();
        const url = normalizeUrl(dm[2].trim());
        if (!name || !url) return null;
        row.push({ text: name, url });
      }
    }
    if (row.length) keyboard.push(row);
  }
  if (!keyboard.length) return null;
  return { title, keyboard, mode };
}

async function saveChannelButtons(chatId, userId, channelId, cfg, env) {
  await LOTTERY_KV.put(`btn:${channelId}`, JSON.stringify(cfg));
  await LOTTERY_KV.delete(`chmod_btn:${userId}`);
  await LOTTERY_KV.delete(`chmod_btn_cfg:${userId}`);
  const n = cfg.keyboard.flat().length;
  const text = cfg.mode === 'reply'
    ? `✅ 自动按钮已保存（底部键盘）！\n\n📢 频道：\`${channelId}\`\n🖱 ${n} 个按钮\n\n之后在该频道发帖会附上键盘。`
    : `✅ 自动按钮已保存！\n\n📢 频道：\`${channelId}\`\n🔘 ${cfg.keyboard.length} 行 / ${n} 个按钮\n\n请到该频道再发一条消息，机器人会把按钮加到那条帖子下面。\n下面是预览：`;
  if (cfg.mode !== 'reply') return sendMsgKb(chatId, text, cfg.keyboard, env);
  return sendMessage(chatId, text, env);
}

// 用户指令消息延迟自动删除（保持群内整洁）
const CMD_DELETE_MS = (parseInt(process.env.CMD_DELETE_SEC || '30', 10) || 30) * 1000;
// 结果/操作类指令：永久保留不删（留痕）
const CMD_NO_DELETE = new Set([
  '/pool',       // 参与买券（结果）
  '/poolcreate', // 建池（操作）
  '/buy',        // 购买（交易）
  '/exchange',   // 兑换（交易）
  '/grantitem',  // 发奖（操作）
  '/grantpoints',// 发分（操作）
  '/grantdraws', // 发抽奖次数（操作）
  '/grantallpoints',
  '/grantalldraws',
  '/announce',   // 公告（播报）
  '/notice',
  '/lottery',    // 幸运抽奖参与
  '/抽奖',
  '/choujiang',
  '/openlottery',// 开奖（结果）
  '/draw',       // 手动开奖（结果）
  '/cancel',     // 取消抽奖（操作）
  '/list',       // 我的抽奖列表
  '/mod',        // 群管理（操作）
  '/settings',   // 群设置（操作）
  '/verify',     // 群验证（操作）
  '/forcesub',   // 强制订阅（操作）
  '/fsub',
  '/bindmmwx',   // 绑定（操作）
  '/bindlucky',  // 绑定（操作）
  '/give',       // 赠送积分（操作）
  '/givepoints',
  '/broadcast',  // 广播（操作）
]);

// HTML 模式发送（含可点 @mention 锚点；降级纯文本）
async function sendHtml(chatId, text, env) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const r = await tgApi(env, 'sendMessage', payload);
  if (r && r.ok === false && /can't parse entities|message is not formatted/i.test(r.description || '')) {
    const p2 = Object.assign({}, payload);
    delete p2.parse_mode;
    return tgApi(env, 'sendMessage', p2);
  }
  return r;
}

async function replyCmd(chatId, msg, r) {
  try {
    const cmdLow = (msg.text || '').split(/\s+/)[0].toLowerCase().split('@')[0];
    const keep = CMD_NO_DELETE.has(cmdLow);
    if (r && r.result && r.result.message_id && (msg.chat.type === 'group' || msg.chat.type === 'supergroup') && (await grpFeature(chatId, 'autodelete')) && !keep) {
      scheduleCmdDelete(chatId, r.result.message_id);
    }
  } catch (e) {}
  return r;
}
function scheduleCmdDelete(chatId, msgId) {
  if (!msgId) return;
  setTimeout(() => {
    tgApi(null, 'deleteMessage', { chat_id: chatId, message_id: msgId })
      .then(r => { if (!r || r.ok === false) console.warn('[cmd-del] 删除失败:', (r && r.description) || 'unknown', chatId, msgId); })
      .catch(e => console.warn('[cmd-del] 异常:', e?.message || e));
  }, CMD_DELETE_MS);
}

async function routeCommand(ctx) {
  const { msg, env, chatId, userId, username, text, chatType, chatTitle } = ctx;
  if (text.startsWith('/')) {
    const [cmd, ...args] = text.split(/\s+/);
    const cmdLower = cmd.toLowerCase().split('@')[0]; // 兼容群内 @bot 唤起：/start@mmdaguanjiabot → /start
    // 群里所有指令消息 30 秒后自动删除（可在 /settings 关闭）；并按开关拦截指令
    if (chatType === 'group' || chatType === 'supergroup') {
      // 结果/操作类指令永久保留；其他指令 30s 自删
      if (await grpFeature(chatId, 'autodelete') && !CMD_NO_DELETE.has(cmdLower)) scheduleCmdDelete(chatId, msg.message_id);
      const fk0 = GRP_CMD_FEAT[cmdLower];
      if (fk0 && !(await grpFeature(chatId, fk0))) return replyCmd(chatId, msg, await sendMessage(chatId, '⛔ 本群已关闭该功能（群管理员发 /settings 可开启）。', env));
    }
    if (cmdLower === '/start') {
      const deepLink = (args[0] || '').toLowerCase();
      if (deepLink.startsWith('verify_')) return replyCmd(chatId, msg, await handleVerifyStart(chatId, userId, deepLink, env));
      if (deepLink.startsWith('fsub_')) return replyCmd(chatId, msg, await handleFsubStart(chatId, userId, deepLink, env));
      if (deepLink === 'notify' || deepLink === '开启提醒') return replyCmd(chatId, msg, await sendMessage(chatId, '🔔 **中奖私信提醒已开启！**\n\n以后你参与的抽奖开奖后，中奖结果会第一时间私信通知你～\n（本提示仅需开启一次，之后所有抽奖自动生效）', env));
      if (deepLink === 'redeem' || deepLink === '兑奖') return replyCmd(chatId, msg, await handleRedeemStart(chatId, userId, env));
      const menuKb = [
        [{ text: '✨ 创建抽奖', callback_data: 'menu:create' }, { text: '📢 发布公告', callback_data: 'menu:announce' }],
        [{ text: '📊 发起投票', callback_data: 'menu:poll' }, { text: '📋 我的抽奖', callback_data: 'menu:list' }],
        [{ text: '🛡️ 群管理', callback_data: 'menu:mod' }, { text: '📢 频道管理', callback_data: 'menu:chmod' }],
        [{ text: '⚙️ 设置群组', callback_data: 'menu:groups' }, { text: '⚙️ 设置频道', callback_data: 'menu:channels' }],
        [{ text: '🌏 设置时区', callback_data: 'menu:timezone' }],
      ];
      let helpText = '🎉 **群组管家 & 抽奖系统**\n\n';
      helpText += '📅 **签到抽奖**\n';
      helpText += '/checkin - 每日签到赢抽奖次数\n';
      helpText += '/draw - 抽奖（可带次数）\n';
      helpText += '/prizes - 查看所有奖品\n';
      helpText += '/bag - 我的背包\n\n';
      helpText += '💰 **积分商城**\n';
      helpText += '/points - 我的积分与排行（群内发言 +1 积分）\n';
      helpText += '/mall - 打开积分商城（积分兑换流量/时长/抽奖）\n';
      helpText += '/traffic - 流量使用排行榜\n';
      helpText += '/bindmmwx 用户名 - 绑定mmwx账号\n';
      helpText += '/exchange 物品名 - 兑换背包奖品到mmwx\n\n';
      helpText += '🎲 **抽奖功能**\n';
      helpText += '/create - 创建新抽奖\n';
      helpText += '/list - 我的抽奖列表\n';
      helpText += '/openlottery - 开奖（需要抽奖ID）\n\n';
      helpText += '🛡️ **群管理**\n';
      helpText += '/mod - 群管理设置\n';
      helpText += '/chmod - 频道管理（自动按钮/公告）\n';
      helpText += '/announce - 发布公告\n';
      helpText += '/poll - 发起投票\n\n';
      helpText += '⚙️ **系统设置**\n';
      helpText += '/groups - 设置默认群组\n';
      helpText += '/channels - 设置默认频道\n';
      helpText += '/timezone - 设置时区\n\n';
      helpText += '🔒 **管理员功能**\n';
      helpText += '/grantpoints 用户名 数量 - 发积分\n';
      helpText += '/grantdraws 用户名 数量 - 发抽奖次数\n';
      helpText += '/grantitem 用户名 物品名 - 发物品\n';
      helpText += '/grantallpoints 数量 - 全员发积分\n';
      helpText += '/grantalldraws 数量 - 全员发抽奖\n';
      return replyCmd(chatId, msg, await sendMsgKb(chatId, helpText, menuKb, env));
    }
    if (cmdLower === '/create') {
      if (!(await isFbAdmin(chatId, userId, env))) return replyCmd(chatId, msg, await sendMessage(chatId, '⛔ 仅管理员可创建抽奖。', env));
      return replyCmd(chatId, msg, await startWizard(chatId, userId, username, chatTitle, env));
    }
    // 新抽奖功能
    if (cmdLower === '/checkin' || cmdLower === '/签到') return replyCmd(chatId, msg, await checkinCmd(chatId, userId, username, env));
    if (cmdLower === '/draw' || cmdLower === '/抽奖') return replyCmd(chatId, msg, await drawCmd(chatId, userId, args[0], username, env));
    if (cmdLower === '/prizes' || cmdLower === '/奖品') return replyCmd(chatId, msg, await prizesCmd(chatId, userId, username, env));
    if (cmdLower === '/bag' || cmdLower === '/背包') return replyCmd(chatId, msg, await bagCmd(chatId, userId, username, env));
    if (cmdLower === '/bindmmwx' || cmdLower === '/绑定') return replyCmd(chatId, msg, await bindmmwxCmd(chatId, userId, args.join(' '), env));
    if (cmdLower === '/exchange' || cmdLower === '/兑换') return replyCmd(chatId, msg, await exchangeCmd(chatId, userId, args.join(' '), username, env));
    if (cmdLower === '/grantpoints') return replyCmd(chatId, msg, await grantPointsCmd(chatId, userId, args, env));
    if (cmdLower === '/grantdraws') return replyCmd(chatId, msg, await grantDrawsCmd(chatId, userId, args, env));
    if (cmdLower === '/grantitem') return replyCmd(chatId, msg, await grantItemCmd(chatId, userId, args, env));
    if (cmdLower === '/grantallpoints') return replyCmd(chatId, msg, await grantAllPointsCmd(chatId, userId, args, env));
    if (cmdLower === '/grantalldraws') return replyCmd(chatId, msg, await grantAllDrawsCmd(chatId, userId, args, env));
    if (cmdLower === '/openlottery') return replyCmd(chatId, msg, await drawLottery(chatId, userId, args[0], env, chatTitle));
    if (cmdLower === '/cancel') return replyCmd(chatId, msg, await cancelLotteryCmd(chatId, userId, args[0], env, chatTitle));
    if (cmdLower === '/list') return replyCmd(chatId, msg, await listLotteries(chatId, env, chatTitle, userId));
    if (cmdLower === '/groups') return replyCmd(chatId, msg, await refreshGroupsCmd(chatId, userId, env));
    if (cmdLower === '/announce' || cmdLower === '/notice') return replyCmd(chatId, msg, await announceCmd(chatId, userId, args.join(' '), env, chatTitle));
    if (cmdLower === '/poll' || cmdLower === '/vote') return replyCmd(chatId, msg, await pollCmd(chatId, args.join(' '), env));
    if (cmdLower === '/verify') return replyCmd(chatId, msg, await verifyCmd(chatId, userId, args[0] || '', env));
    if (cmdLower === '/forcesub' || cmdLower === '/fsub') return replyCmd(chatId, msg, await forceSubCmd(chatId, userId, args.join(' '), env));
    if (cmdLower === '/fsubcheck' || cmdLower === '/fsubc') return replyCmd(chatId, msg, await forceSubCheck(chatId, userId, env));
    if (cmdLower === '/diag' || cmdLower === '/status') return replyCmd(chatId, msg, await diagCmd(chatId, userId, env));
    if (cmdLower === '/subinfo' || cmdLower === '/mysub' || cmdLower.split('@')[0] === '/subinfo') return replyCmd(chatId, msg, await showMySubscription(chatId, userId, msg.from.username || '', env));
    if (cmdLower === '/traffic' || cmdLower === '/流量' || cmdLower === '/流量榜') return replyCmd(chatId, msg, await trafficRankCmd(chatId, userId, msg.from.username || '', env));
    const cmdBase = cmdLower.split('@')[0];
    if (cmdBase === '/bug') return replyCmd(chatId, msg, await feedbackCmd(chatId, userId, username, msg.from.username || '', 'bug', args.join(' '), chatTitle, env));
    if (cmdBase === '/suggest' || cmdBase === '/idea') return replyCmd(chatId, msg, await feedbackCmd(chatId, userId, username, msg.from.username || '', 'suggest', args.join(' '), chatTitle, env));
    if (cmdBase === '/issues') return replyCmd(chatId, msg, await myIssuesCmd(chatId, userId, env));
    if (cmdBase === '/ibugs' || cmdBase === '/ibug') {
      const adm = await isFbAdmin(chatId, userId, env);
      if (!adm && chatType === 'private') return replyCmd(chatId, msg, await sendMessage(chatId, '⛔ 仅管理员可用 /ibugs。', env));
      return replyCmd(chatId, msg, await fbRenderAll(chatId, null, env, { admin: adm }));
    }
    if (cmdBase === '/checkin') return replyCmd(chatId, msg, await checkinCmd(chatId, userId, username, env));
    if (cmdBase === '/bindlucky') return replyCmd(chatId, msg, await bindLuckyCmd(chatId, userId, args.join(' '), env));
    if (cmdBase === '/lottery' || cmdLower === '/抽奖' || cmdBase === '/choujiang') return replyCmd(chatId, msg, await luckyDrawCmd(chatId, userId, username, args.join(' '), env));
    if (cmdBase === '/bag') return replyCmd(chatId, msg, await luckyBagCmd(chatId, userId, env));
    if (cmdBase === '/settings') {
      if (chatType === 'private') return replyCmd(chatId, msg, await sendMessage(chatId, '请在群内使用 /settings（管理本群功能开关）。', env));
      const stt = await getChatMemberStatus(chatId, userId, env);
      if (!isAdminStatus(stt)) return replyCmd(chatId, msg, await sendMessage(chatId, '⛔ 仅群管理员可用 /settings。', env));
      // /settings 属于管理操作，CMD_NO_DELETE 已包含，不删
      return replyCmd(chatId, msg, await grpSettingsRender(chatId, null, env));
    }
    if (cmdBase === '/pool') return replyCmd(chatId, msg, await poolCmd(chatId, userId, username, args.join(' '), env));
    if (cmdBase === '/poolcreate') {
      if (!(await isFbAdmin(chatId, userId, env))) return sendMessage(chatId, '⛔ 仅管理员可用 /poolcreate。', env);
      return poolCreateCmd(chatId, userId, args.join(' '), env);
    }
    if (cmdBase === '/bindings' || cmdBase === '/bindlist') {
      if (!(await isFbAdmin(chatId, userId, env))) return sendMessage(chatId, '⛔ 仅管理员可用 /bindings。', env);
      return bindingsCmd(chatId, null, env);
    }
    if (cmdBase === '/points' || cmdBase === '/积分') return replyCmd(chatId, msg, await pointsCmd(chatId, userId, env));
    if (cmdBase === '/give' || cmdBase === '/givepoints') return replyCmd(chatId, msg, await giveCmd(chatId, userId, username, msg, args.join(' '), chatType, env));
    if (cmdBase === '/mall' || cmdBase === '/商城') return mallCmd(chatId, userId, env);
    if (cmdBase === '/buy' || cmdBase === '/购买') return replyCmd(chatId, msg, await buyCmd(chatId, userId, username, args.join(' '), env));
    if (cmdBase === '/mall_add') {
      if (!fbAdminIds().includes(userId)) return replyCmd(chatId, msg, await sendMessage(chatId, '⛔ 仅管理员可用。', env));
      return replyCmd(chatId, msg, await mallAddCmd(chatId, args.join(' '), env));
    }
    if (cmdBase === '/mall_del') {
      if (!fbAdminIds().includes(userId)) return replyCmd(chatId, msg, await sendMessage(chatId, '⛔ 仅管理员可用。', env));
      return replyCmd(chatId, msg, await mallDelCmd(chatId, args.join(' '), env));
    }    if (cmdLower === '/broadcast') {
      if (chatId < 0) return replyCmd(chatId, msg, await sendMessage(chatId, '❌ 请在私聊中使用 /broadcast', env));
      if (!fbAdminIds().includes(userId)) return replyCmd(chatId, msg, await sendMessage(chatId, '⛔ 仅管理员可用 /broadcast。', env));
      await LOTTERY_KV.put(`broadcast_pending:${userId}`, '1', { expirationTtl: 900 });
      const kb = [[{ text: '❌ 取消广播', callback_data: 'broadcast_cancel' }]];
      return replyCmd(chatId, msg, await sendMsgKb(chatId, '📢 **全局广播**\n\n请直接发送要**广播到所有群**的消息内容：\n\n⚠️ 发送后无法撤回，请确认内容无误！', kb, env));
    }
    if (cmdLower === '/mod') {
      if (chatType === 'group' || chatType === 'supergroup') {
        const st = await getChatMemberStatus(chatId, userId, env);
        if (!isAdminStatus(st)) return replyCmd(chatId, msg, await sendMessage(chatId, '⛔ 仅群管理员可用 /mod。', env));
        return replyCmd(chatId, msg, await showModActions(chatId, null, env, userId, chatId));
      }
      return replyCmd(chatId, msg, await showModStart(chatId, null, env, userId));
    }
    if (cmdLower === '/chmod' || cmdLower === '/channelmod') {
      if (chatType === 'group' || chatType === 'supergroup') {
        return replyCmd(chatId, msg, await sendMessage(chatId, '📢 请私聊机器人使用 /chmod 管理频道（含自动按钮）。', env));
      }
      return replyCmd(chatId, msg, await showChannelModStart(chatId, null, env, userId));
    }
  if (MOD_CMD_LIST.includes(cmdLower)) return replyCmd(chatId, msg, await handleModCmd(chatId, userId, cmdLower, args.join(' '), msg, chatTitle, env));
  return;
  }
}

async function handleMallAddWizard(ctx) {
  const { env, chatId, userId, text } = ctx;
  // 商城上架向导：等待 价格 名称 数值（带类型预设）
  const mtRaw = await LOTTERY_KV.get(`mall_add_type:${userId}`);
  if (mtRaw) {
    await LOTTERY_KV.delete(`mall_add_type:${userId}`);
    if (!(await isFbAdmin(chatId, userId, env))) { sendMessage(chatId, '⛔ 仅管理员可用。', env); return true; }
    const parts = (text || '').trim().split(/\s+/).filter(Boolean);
    const price = parseInt(parts[0], 10);
    const value = parseInt(parts[2] || '', 10);
    const name = parts[1] || '';
    if (!price || price < 1 || !value || value < 1 || !name) {
      await LOTTERY_KV.put(`mall_add_type:${userId}`, mtRaw, { expirationTtl: 900 });
      sendMessage(chatId, '❌ 格式不对。请发送：价格 名称 数值\n例如：100 5G流量 5', env);
      return true;
    }
    const items = await getMall();
    const id = items.length ? Math.max(...items.map(x => x.id)) + 1 : 1;
    items.push({ id, name: mdSafe(name), price, type: mtRaw, value });
    await LOTTERY_KV.put('mall_list', JSON.stringify(items));
    await sendMessage(chatId, `✅ 商品已上架 #${items.length}：${mdSafe(name)}（${price} 分，效果：${fmtEffect(mtRaw, value)}）`, env);
    await mallCmd(chatId, userId, env).catch(() => null);
    return true;
  }
  return false;
}

async function handlePlainTextTrigger(ctx) {
  const { msg, env, chatId, userId, username, text, chatType } = ctx;
  if (text === '签到') {
  if (chatType !== 'private') {
    if (!(await grpFeature(chatId, 'checkin'))) { sendMessage(chatId, '⛔ 本群已关闭签到。', env); return true; }
    // 签到是高频查询，保持30s自删
  }
  replyCmd(chatId, msg, await checkinCmd(chatId, userId, username, env));
  return true;
  }
  if (text === '积分' || text === '我的积分') {
  if (chatType !== 'private') {
    if (!(await grpFeature(chatId, 'points'))) { sendMessage(chatId, '⛔ 本群已关闭积分功能。', env); return true; }
  }
  replyCmd(chatId, msg, await pointsCmd(chatId, userId, env));
  return true;
  }
  if (text === '商城') {
  if (chatType !== 'private') {
    if (!(await grpFeature(chatId, 'mall'))) { sendMessage(chatId, '⛔ 本群已关闭积分商城。', env); return true; }
  }
  replyCmd(chatId, msg, await mallCmd(chatId, userId, env));
  return true;
}
  return false;
    }
    
    async function handlePrivateChatText(ctx) {
  const { msg, env, chatId, userId, username, text, chatType, chatTitle } = ctx;
  lucky.ensureUser(userId, username || mdSafe(username)).catch(() => null); // 私聊即建档，回群可用签到/抽奖
    const handledVerify = await tryVerifyAnswer(chatId, userId, text, env);
    if (handledVerify) return;
    const handledMod = await handleModDraft(chatId, userId, msg, env);
    if (handledMod) return;
    const announcePending = await LOTTERY_KV.get(`announce_pending:${userId}`);
    if (announcePending) {
      await LOTTERY_KV.delete(`announce_pending:${userId}`);
      return announceCmd(chatId, userId, text, env, chatTitle);
    }
    const chmodAnnounce = await LOTTERY_KV.get(`chmod_announce:${userId}`);
    if (chmodAnnounce) {
      await LOTTERY_KV.delete(`chmod_announce:${userId}`);
      const channelId = parseInt(chmodAnnounce);
      if (!channelId || !text) return sendMessage(chatId, '❌ 公告内容不能为空', env);
      const admin = await getChatMemberStatus(channelId, userId, env);
      if (!isAdminStatus(admin)) return sendMessage(chatId, '❌ 你不是该频道管理员，无法发布公告。', env);
      const res = await tgApi(env, 'sendMessage', { chat_id: channelId, text: text, parse_mode: 'Markdown' });
      if (res?.ok) {
        await tgApi(env, 'pinChatMessage', { chat_id: channelId, message_id: res.result.message_id, disable_notification: true }).catch(() => null);
        await sendMessage(chatId, `✅ 公告已发布并置顶到频道！\n\n${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`);
      }
      else await sendMessage(chatId, `❌ 发布失败：${res?.description || '未知错误'}`);
      return;
    }
    const chmodBtn = await LOTTERY_KV.get(`chmod_btn:${userId}`);
    const btnText = (text || msg.caption || '').trim();
    if (chmodBtn) {
      const btnChannelId = parseInt(chmodBtn);
      if (!btnChannelId) { await LOTTERY_KV.delete(`chmod_btn:${userId}`); return sendMessage(chatId, '❌ 频道ID无效', env); }
      if (/^(off|关闭|删除|clear)$/i.test(btnText)) {
        await LOTTERY_KV.delete(`chmod_btn:${userId}`);
        await LOTTERY_KV.delete(`btn:${btnChannelId}`);
        return sendMessage(chatId, '✅ 已关闭该频道的自动按钮。', env);
      }
      const cfg = parseAutoButtons(btnText);
      if (!cfg) return sendMessage(chatId, '❌ 按钮格式无法识别，请在**当前私聊**重新发送（不要发到频道）。\n\n格式：\n订阅BOT-https://t.me/xxx && 传话筒-https://t.me/yyy\n兑换购买-https://shop.example.com', env);
      return saveChannelButtons(chatId, userId, btnChannelId, cfg, env);
    }
    const autoCfg = parseAutoButtons(btnText);
    if (autoCfg && /https?:\/\//i.test(btnText)) {
      const channels = await getBotChannels(env);
      const adminCh = [];
      for (const c of channels) {
        const st = await getChatMemberStatus(c.id, userId, env);
        if (isAdminStatus(st)) adminCh.push(c);
      }
      if (adminCh.length === 1) return saveChannelButtons(chatId, userId, adminCh[0].id, autoCfg, env);
      if (adminCh.length > 1) {
        await LOTTERY_KV.put(`chmod_btn_cfg:${userId}`, JSON.stringify(autoCfg), { expirationTtl: 900 });
        const kb = adminCh.map(c => [{ text: `📢 ${esc(c.title || c.id)}`, callback_data: `chmod_applybtn:${c.id}` }]);
        kb.push([{ text: '❌ 取消', callback_data: 'chmod_cancel_announce' }]);
        return sendMsgKb(chatId, '检测到按钮配置。请选择要应用到哪个频道：', kb, env);
      }
    }
    const pollPending = await LOTTERY_KV.get(`poll_pending:${chatId}`);
    if (pollPending) {
      await LOTTERY_KV.delete(`poll_pending:${chatId}`);
      return pollCmd(chatId, text, env);
    }
    const pollDraft = await LOTTERY_KV.get(`poll_draft:${chatId}`);
    if (pollDraft) return resolvePollGroup(chatId, text, env);
    const announceDraft = await LOTTERY_KV.get(`announce_draft:${chatId}`);
    if (announceDraft) return resolveAnnounceGroup(chatId, text, env);
    const broadcastPending = await LOTTERY_KV.get(`broadcast_pending:${userId}`);
    if (broadcastPending) {
      if (!fbAdminIds().includes(userId)) { await LOTTERY_KV.delete(`broadcast_pending:${userId}`); return sendMessage(chatId, '⛔ 仅管理员可用 /broadcast。', env); }
      await LOTTERY_KV.delete(`broadcast_pending:${userId}`);
      const content = text;
      if (!content) return sendMessage(chatId, '❌ 内容不能为空', env);
      await LOTTERY_KV.put(`broadcast_draft:${userId}`, JSON.stringify({ content }), { expirationTtl: 900 });
      const preview = `📢 **广播预览**\n\n${content}\n\n━━━━\n⚠️ 将发送到 **所有** bot 已加入的群组。\n确认发送吗？`;
      const kb = [
        [{ text: '✅ 确认广播', callback_data: 'broadcast_confirm' }],
        [{ text: '❌ 取消广播', callback_data: 'broadcast_cancel' }],
      ];
      return sendMsgKb(chatId, preview, kb, env);
    }
    const bannedInput = await LOTTERY_KV.get(`banned_input:${userId}`);
    if (bannedInput) {
      await LOTTERY_KV.delete(`banned_input:${userId}`);
      const bi = safeJsonParse(bannedInput, {});
      const bcfg = await getBannedCfg(bi.groupId);
      if (bi.action === 'add') {
        const words = text.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
        if (!words.length) return sendMessage(chatId, '❌ 未识别到违禁词，请重新发送。', env);
        const added = [];
        for (const w of words) { if (w && !bcfg.words.includes(w)) { bcfg.words.push(w); added.push(w); } }
        await saveBannedCfg(bi.groupId, bcfg);
        return sendMessage(chatId, `✅ 已添加 ${added.length} 个违禁词：${added.map(w => `\`${esc(w)}\``).join('、')}\n\n当前共 ${bcfg.words.length} 个违禁词。`, env);
      }
      if (bi.action === 'punish') {
        const m = text.trim().match(/^(\d+)\s*[,，、]\s*(\d+)$/);
        if (!m) return sendMessage(chatId, '❌ 格式错误，请发送：`警告次数,禁言分钟`（如 `3,60`）', env);
        bcfg.warnLimit = Math.max(1, parseInt(m[1]));
        bcfg.muteMinutes = Math.max(1, parseInt(m[2]));
        await saveBannedCfg(bi.groupId, bcfg);
        return sendMessage(chatId, `✅ 惩罚规则已更新：警告 ${bcfg.warnLimit} 次后禁言 ${bcfg.muteMinutes} 分钟`, env);
      }
    }
    const welcomeInput = await LOTTERY_KV.get(`welcome_input:${userId}`);
    if (welcomeInput) {
      await LOTTERY_KV.delete(`welcome_input:${userId}`);
      const wi = safeJsonParse(welcomeInput, {});
      const wcfg = await getWelcomeCfg(wi.groupId);
      if (wi.action === 'text') {
        const t = text.trim();
        if (t.toLowerCase() === 'off') { wcfg.text = ''; await saveWelcomeCfg(wi.groupId, wcfg); return sendMessage(chatId, '✅ 已清除欢迎文本', env); }
        wcfg.text = t.slice(0, 1000);
        await saveWelcomeCfg(wi.groupId, wcfg);
        return sendMessage(chatId, `✅ 欢迎文本已更新：\n\n${wcfg.text}`, env);
      }
      if (wi.action === 'media') {
        const t = text.trim();
        if (t.toLowerCase() === 'off') { wcfg.media = ''; await saveWelcomeCfg(wi.groupId, wcfg); return sendMessage(chatId, '✅ 已清除欢迎媒体', env); }
        let media = t;
        let mtype = 'photo';
        if (/^video:/i.test(t)) { media = t.replace(/^video:/i, '').trim(); mtype = 'video'; }
        else if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(media)) mtype = 'video';
        wcfg.media = media;
        wcfg.mediaType = mtype;
        await saveWelcomeCfg(wi.groupId, wcfg);
        return sendMessage(chatId, `✅ 欢迎媒体已更新（${mtype === 'video' ? '🎬 视频' : '🖼️ 图片'}）：\n${media}`, env);
      }
      if (wi.action === 'btn') {
        const t = text.trim();
        if (t.toLowerCase() === 'off' || t.toLowerCase() === 'clear') { wcfg.buttons = []; await saveWelcomeCfg(wi.groupId, wcfg); return sendMessage(chatId, '✅ 已清除欢迎按钮', env); }
        const parsedBtn = parseAutoButtons(t);
        if (!parsedBtn || !parsedBtn.keyboard || !parsedBtn.keyboard.length) return sendMessage(chatId, '❌ 按钮格式无法识别。格式：`名称-链接`，多个用 `&&` 或换行分隔。', env);
        wcfg.buttons = parsedBtn.keyboard;
        await saveWelcomeCfg(wi.groupId, wcfg);
        const btnFlat = parsedBtn.keyboard.flat();
        return sendMessage(chatId, `✅ 欢迎按钮已更新（${btnFlat.length} 个）：\n${btnFlat.map(b => `🔘 ${b.text}`).join('\n')}`, env);
      }
    }
  return handleWizardStep(chatId, userId, text, env);
  }

  async function handleGroupChatText(ctx) {
  const { msg, env, chatId, userId, username, text, chatType, chatTitle } = ctx;
  // ---- 群聊处理（防广告/链接 + 删除服务消息 + 口令） ----
  if (msg.left_chat_member || msg.pinned_message) {
      try {
        // TGBot：自动删除系统消息开关（默认开启）
        const fcfg = await features.getGroupCfg(chatId);
        const ad = fcfg.autoDeleteSys || { leave: true, pin: true };
        const isLeave = !!msg.left_chat_member, isPin = !!msg.pinned_message;
        if (isLeave && msg.left_chat_member?.user?.id) await removeGroupMember(chatId, msg.left_chat_member.user.id);
        if ((isLeave && ad.leave !== false) || (isPin && ad.pin !== false)) {
          await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id });
        }
      } catch {}
      return;
    }
    if (msg.new_chat_members) {
      try { await handleNewMembers(chatId, msg.new_chat_members, env, msg.message_id); } catch (e) { console.error('welcome error:', e.message); }
      return;
    }
    const hasLink = /(https?:\/\/|t\.me\/|telegram\.me\/)/i.test(text);
    if (hasLink) {
      const isAdmin = await getChatMemberStatus(chatId, userId, env);
      if (!isAdminStatus(isAdmin)) {
        try { await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }); } catch {}
        return;
      }
    }
    // 违禁词检测（管理员跳过；命中则删除+警告+禁言）
    const bannedHit = await checkBannedWord(chatId, userId, username, text, msg.message_id, env);
    if (bannedHit) return;
    // TGBot 功能：群内命令 / 积分统计 / 关键词回复
    try {
      const isAdminForCmd = await getChatMemberStatus(chatId, userId, env);
      const isAdminUser = isAdminStatus(isAdminForCmd);
      if (text.startsWith('/')) {
        const handledCmd = await features.onCommand(chatId, userId, username, text, msg.reply_to_message || null);
        if (handledCmd) return;
      }
      const featHandled = await features.onGroupMessage(chatId, userId, username, text, msg);
      if (featHandled) return;
    void isAdminUser;
  } catch (e) { console.error('TGBot 功能处理错误:', e.message); }
  return checkKeyword(chatId, userId, username, text, chatTitle, env);
  }

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || `用户${userId}`;
  const text = (msg.text || '').trim();
  const chatType = msg.chat.type;
  const chatTitle = msg.chat.title || '';

  // 成员发言即记录进群成员注册表（弥补 Telegram 无法拉取全量成员的限制）
  if ((chatType === 'group' || chatType === 'supergroup') && !msg.from.is_bot) {
    await addGroupMember(chatId, msg.from).catch(() => null);
  }

  // 群发言积分：一条消息 +1（内存累加，定时刷写）
  if ((chatType === 'group' || chatType === 'supergroup') && (!msg.from.is_bot || Number(msg.from.id) === 1087968824)) {
    await addPoints(userId, 1, Number(userId) === 1087968824 ? '匿名管理员' : mdSafe(username));
  }

  const ctx = { msg, env, chatId, userId, username, text, chatType, chatTitle };
  if (text.startsWith('/')) return routeCommand(ctx);
  if (await handleMallAddWizard(ctx)) return;
  if (await handlePlainTextTrigger(ctx)) return;
  if (chatType === 'private') return handlePrivateChatText(ctx);
  if (chatType === 'group' || chatType === 'supergroup') return handleGroupChatText(ctx);
}

// ==================== Bot 入群记录（发布目标群/频道列表） ====================

async function handleMyChatMember(mcm, env) {
  const chat = mcm.chat;
  if (!chat) return;
  const isChannel = chat.type === 'channel';
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  if (!isGroup && !isChannel) return;
  const newStatus = mcm.new_chat_member?.status || '';

  const key = isChannel ? 'bot_channels' : 'bot_groups';
  const raw = await LOTTERY_KV.get(key);
  let list = safeJsonParse(raw, []);
  if (!Array.isArray(list)) list = [];

  const idx = list.findIndex(g => String(g.id) === String(chat.id));
  if (newStatus === 'left' || newStatus === 'kicked') {
    if (idx >= 0) list.splice(idx, 1);
  } else if (newStatus === 'member' || newStatus === 'administrator' || newStatus === 'restricted') {
    const prev = idx >= 0 ? list[idx] : null;
    const prevStatus = prev?.lastStatus || '';
    const g = { id: chat.id, title: chat.title || (isChannel ? `频道${chat.id}` : `群${chat.id}`), lastStatus: newStatus };
    if (idx >= 0) list[idx] = g;
    else list.push(g);
    if (isGroup && prevStatus !== newStatus) {
      const admin = newStatus === 'administrator';
      const text = admin
        ? '👋 **大家好，我是群组管家 bot！**\n\n✅ bot 已具备群管理权限，抽奖/入群验证/群管功能可用。\n\n👮 群管理员可私聊 bot 使用 🛡️ 群管理 功能。'
        : '👋 **大家好，我是群组管家 bot！**\n\n⚠️ **请把我设为群管理员**（成员列表 → 设为管理员，勾选权限）。\n\n否则以下功能不可用：\n🔸 入群验证（新成员需点击验证按钮，收不到新人入群事件）\n🔸 禁言 / 踢出 / 封禁 等群管操作\n🔸 公告/抽奖 置顶\n\n设好管理员后，bot 会自动发确认消息。';
      await sendMessage(chat.id, text, env).catch(() => {});
    }
  }
  if (list.length > 1) {
    const seen = new Map();
    for (const item of list) seen.set(String(item.id), item);
    list = Array.from(seen.values());
  }
  await LOTTERY_KV.put(key, JSON.stringify(list));
  if (isChannel) {
    const groupsRaw = await LOTTERY_KV.get('bot_groups');
    if (groupsRaw) {
      let groupsList = safeJsonParse(groupsRaw, []);
      if (Array.isArray(groupsList)) {
        const groupsIdx = groupsList.findIndex(g => String(g.id) === String(chat.id));
        if (groupsIdx >= 0) { groupsList.splice(groupsIdx, 1); await LOTTERY_KV.put('bot_groups', JSON.stringify(groupsList)); }
      }
    }
  }
}

async function getBotGroups(env) {
  const raw = await LOTTERY_KV.get('bot_groups');
  if (!raw) return [];
  let groups = safeJsonParse(raw, []);
  if (!Array.isArray(groups)) return [];
  const seen = new Map();
  for (const g of groups) seen.set(String(g.id), { id: Number(g.id), title: g.title || `群${g.id}` });
  groups = Array.from(seen.values());
  await LOTTERY_KV.put('bot_groups', JSON.stringify(groups)).catch(() => {});
  return groups;
}

async function getBotChannels(env) {
  const raw = await LOTTERY_KV.get('bot_channels');
  if (!raw) return [];
  let channels = safeJsonParse(raw, []);
  if (!Array.isArray(channels)) return [];
  const seen = new Map();
  for (const c of channels) seen.set(String(c.id), { id: Number(c.id), title: c.title || `频道${c.id}` });
  channels = Array.from(seen.values());
  return channels;
}

async function getUserCfg(userId, env) {
  const raw = await LOTTERY_KV.get(`user_cfg:${userId}`);
  if (!raw) return { defaultGroupId: null, defaultChannelId: null };
  try { return JSON.parse(raw); } catch { return { defaultGroupId: null, defaultChannelId: null }; }
}

async function showSettingsGroups(chatId, msgId, env, userId) {
  const groups = await getBotGroups(env);
  const cfg = await getUserCfg(userId, env);
  const kb = [];
  for (const g of groups.slice(0, 15)) {
    const mark = cfg.defaultGroupId === g.id ? ' ⭐' : '';
    kb.push([{ text: `📢 ${esc(g.title || g.id)}${mark}`, callback_data: `set_group:${g.id}` }]);
  }
  kb.push([{ text: '🔙 返回主菜单', callback_data: 'menu_back' }]);
  if (groups.length === 0) await editMsg(chatId, msgId, '⚠️ **还未找到可发布群组**\n\n请先把机器人**加入目标群组**（并设为管理员），bot 会自动记录。', env, kb);
  else await editMsg(chatId, msgId, '⚙️ **设置默认发布群组**\n\n点击选择一个群组作为默认发布目标（⭐ 为当前默认）：', env, kb);
}

async function showSettingsChannels(chatId, msgId, env, userId) {
  const channels = await getBotChannels(env);
  const cfg = await getUserCfg(userId, env);
  const kb = [];
  for (const c of channels.slice(0, 15)) {
    const mark = cfg.defaultChannelId === c.id ? ' ⭐' : '';
    kb.push([{ text: `📣 ${esc(c.title || c.id)}${mark}`, callback_data: `set_channel:${c.id}` }]);
  }
  kb.push([{ text: '🔙 返回主菜单', callback_data: 'menu_back' }]);
  if (channels.length === 0) await editMsg(chatId, msgId, '⚠️ **还未找到频道**\n\n请先把机器人**加入目标频道**（并设为管理员），bot 会自动记录。', env, kb);
  else await editMsg(chatId, msgId, '⚙️ **设置默认发布频道**\n\n点击选择一个频道作为默认发布目标（⭐ 为当前默认）：', env, kb);
}

async function showSettingsTimezone(chatId, msgId, env, userId) {
  const names = [
    { label: '🇨🇳 北京时间 (UTC+8)', val: '8' },
    { label: '🇯🇵 东京时间 (UTC+9)', val: '9' },
    { label: '🇹🇭 曼谷时间 (UTC+7)', val: '7' },
    { label: '🌐 UTC (UTC+0)', val: '0' },
    { label: '🇺🇸 纽约时间 (UTC-5)', val: '-5' },
  ];
  const kb = names.map(n => [{ text: n.label, callback_data: `set_timezone:${n.val}` }]);
  kb.push([{ text: '🔙 返回主菜单', callback_data: 'menu_back' }]);
  const tzNames = { 8: '北京时间', 9: '东京时间', 0: 'UTC', 7: '曼谷时间', '-5': '纽约时间' };
  await editMsg(chatId, msgId, `🌏 **设置时区**\n\n当前时区：**${tzNames[TZ_OFFSET_HOURS] || `UTC${TZ_OFFSET_HOURS >= 0 ? '+' : ''}${TZ_OFFSET_HOURS}`}**\n\n开奖时间会按所选时区显示：`, env, kb);
}

async function handleChatMember(mcm, env) {
  const chat = mcm.chat;
  if (!chat) return;
  const newMember = mcm.new_chat_member;
  const userId = newMember?.user?.id;
  if (!userId) return;
  const botId = parseInt((process.env.BOT_TOKEN || '').split(':')[0]);
  if (userId === botId) return;
  const oldStatus = mcm.old_chat_member?.status || '';
  const newStatus = newMember.status || '';
  const userName = newMember.user?.username || newMember.user?.first_name || `用户${userId}`;

  // TGBot 频道功能：订阅/退订 → 频道屏蔽（退群封禁/闪进闪退/屏蔽机器人）
  if (chat.type === 'channel') {
    try {
      if (newStatus === 'member' || newStatus === 'left' || newStatus === 'kicked') {
        await features.onChannelMember(chat.id, newMember.user, newStatus);
      }
    } catch (e) { console.error('频道屏蔽错误:', e.message); }
    return;
  }
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  // TGBot 功能：成员离开 → 闪进闪退检测（加入后短时间内退出自动封禁）
  if (newStatus === 'left' || newStatus === 'kicked') {
    try {
      await removeGroupMember(chat.id, userId);
      const botAdmin2 = await isBotAdmin(chat.id, env).catch(() => false);
      if (botAdmin2) await features.onMemberLeft(chat.id, newMember.user);
    } catch (e) { console.error('闪进闪退检测错误:', e.message); }
  }

  if (oldStatus !== '' && oldStatus !== 'left' && oldStatus !== 'kicked') return;
  if (newStatus !== 'member' && newStatus !== 'restricted') return;
  await addGroupMember(chat.id, newMember.user);

  const cfgRaw = await LOTTERY_KV.get(`verify_cfg:${chat.id}`);
  let cfg = { enabled: true };
  if (cfgRaw) { try { cfg = JSON.parse(cfgRaw); } catch {} }
  if (!cfg.enabled) { await sendWelcomeIfSet(chat.id, newMember.user.username || newMember.user.first_name || `用户${userId}`, env); return; }

  const botAdmin = await isBotAdmin(chat.id, env);
  const name = newMember.user.username || newMember.user.first_name || `用户${userId}`;
  let muted = false;
  if (botAdmin) {
    const rest = await tgApi(env, 'restrictChatMember', {
      chat_id: chat.id,
      user_id: userId,
      permissions: allPermissionsObject(false),
      until_date: Math.floor(Date.now() / 1000) + 600,
    }).catch(() => null);
    muted = !!(rest && rest.ok);
  }

  const vKey = `verify_pending:${chat.id}:${userId}`;
  const pending = {
    chatId: chat.id,
    userId,
    name,
    muted,
    joinedAt: Date.now(),
    msgId: null,
    stage: 'idle',
    question: '',
    answer: null,
    attempts: 0,
  };
  await LOTTERY_KV.put(vKey, JSON.stringify(pending), { expirationTtl: 660 });

  const welcomeText = await getWelcomeText(chat.id, name, env);
  const text = `👋 欢迎 **${esc(name)}** 加入本群！${welcomeText ? `\n\n${welcomeText}` : ''}\n\n🧮 为防广告/骚扰，请点击下方按钮**跳转到机器人完成数学验证**，10分钟内未验证将被移出群聊。`;
  const botUn = await getBotUsername(env);
  const verifyUrl = botUn ? `https://t.me/${botUn}?start=verify_${chat.id}_${userId}` : null;
  const kb = verifyUrl ? [[{ text: '🧮 点击验证', url: verifyUrl }]] : [[{ text: '✅ 点击验证', callback_data: `verify_join:${chat.id}:${userId}` }]];
  const res = await sendMsgKb(chat.id, text, kb, env).catch(() => null);
  if (res && res.ok && res.result?.message_id) {
    pending.msgId = res.result.message_id;
    await LOTTERY_KV.put(vKey, JSON.stringify(pending), { expirationTtl: 660 });
  }
}

async function checkPendingVerifications(env) {
  try {
    const list = await LOTTERY_KV.list({ prefix: 'verify_pending:' });
    if (!list.keys || list.keys.length === 0) return;
    const now = Date.now();
    const datas = await Promise.all(list.keys.map(k => LOTTERY_KV.get(k.name)));
    for (let i = 0; i < list.keys.length; i++) {
      const raw = datas[i];
      if (!raw) continue;
      let pending;
      try { pending = JSON.parse(raw); } catch { continue; }
      if (now - pending.joinedAt < 10 * 60 * 1000) continue;
      const kicked = await kickUser(pending.chatId, pending.userId, env);
      await LOTTERY_KV.delete(list.keys[i].name);
      if (pending.msgId) await tgApi(env, 'deleteMessage', { chat_id: pending.chatId, message_id: pending.msgId }).catch(() => null);
      if (kicked) {
        const km = await sendMessage(pending.chatId, `🚫 **${esc(pending.name || `用户${pending.userId}`)}** 未在10分钟内完成入群验证，已被移出群聊。`, env).catch(() => null);
        if (km?.ok && km.result?.message_id) {
          const kmid = km.result.message_id;
          await logNotifyMsg(pending.chatId, kmid);
          setTimeout(() => tgApi(env, 'deleteMessage', { chat_id: pending.chatId, message_id: kmid }).catch(() => null), 10 * 1000);
        }
      }
    }
  } catch (err) { console.error('checkPendingVerifications error:', err); }
}

async function kickUser(chatId, userId, env) {
  try { await tgApi(env, 'banChatMember', { chat_id: chatId, user_id: userId }); await tgApi(env, 'unbanChatMember', { chat_id: chatId, user_id: userId }); return true; } catch { return false; }
}

async function isBotAdmin(chatId, env) {
  try {
    const botId = parseInt((process.env.BOT_TOKEN || '').split(':')[0]);
    if (!botId) return false;
    const res = await tgApi(env, 'getChatMember', { chat_id: chatId, user_id: botId });
    if (!res.ok) return false;
    return ['administrator', 'creator'].includes(res.result.status);
  } catch { return false; }
}

function allPermissionsObject(whole) {
  return {
    can_send_messages: whole,
    can_send_audios: whole,
    can_send_documents: whole,
    can_send_photos: whole,
    can_send_videos: whole,
    can_send_video_notes: whole,
    can_send_voice_notes: whole,
    can_send_polls: whole,
    can_send_other_messages: whole,
    can_add_web_page_previews: whole,
    can_change_info: whole,
    can_invite_users: whole,
    can_pin_messages: whole,
  };
}

async function announceCmd(chatId, userId, text, env, chatTitle) {
  if (chatId < 0) return sendMessage(chatId, '📢 发布公告请**私聊机器人**：\n\n直接发送 `/announce`，按提示输入公告内容。\n\n发布后自动置顶，并校验你是目标群管理员。', env);
  const content = (text || '').trim();
  if (!content) {
    await LOTTERY_KV.put(`announce_pending:${userId}`, '1', { expirationTtl: 900 });
    const kb = [[{ text: '❌ 取消', callback_data: 'cancel_announce_pending' }]];
    return sendMsgKb(chatId, '📢 **管理员公告**\n\n请直接发送**公告内容**：\n\n💡 示例：`本周六晚8点群活动，欢迎参加！`', kb, env);
  }
  if (content.length > 1000) return sendMessage(chatId, '❌ 公告过长（≤1000字），请精简后重试', env);
  const draftKey = `announce_draft:${userId}`;
  await LOTTERY_KV.put(draftKey, JSON.stringify({ userId, content }), { expirationTtl: 900 });
  return showGroupPicker(chatId, env, 'announce_publish', true);
}

async function publishAnnounce(chatId, userId, targetGroupId, msgId, env) {
  const draftKey = `announce_draft:${userId}`;
  const raw = await LOTTERY_KV.get(draftKey);
  await LOTTERY_KV.delete(draftKey);
  const status = await getChatMemberStatus(targetGroupId, userId, env);
  if (status !== 'creator' && status !== 'administrator') { await editMsg(chatId, msgId, '❌ 你不是该目标的管理员，无法发布公告。', env); return { ok: false, reason: 'not_admin' }; }
  const draft = safeJsonParse(raw, null);
  if (!draft || !draft.content) { await editMsg(chatId, msgId, '⏰ 公告草稿已过期，请重新发送 `/announce` 再输入内容', env); return { ok: false, reason: 'expired' }; }
  const post = `📢 **公告**\n\n${draft.content}\n\n— ${'群管理组'}`;
  const res = await sendMessage(targetGroupId, post, env);
  if (res && res.ok && res.result?.message_id) {
    await tgApi(env, 'pinChatMessage', { chat_id: targetGroupId, message_id: res.result.message_id, disable_notification: true }).catch(() => null);
    await editMsg(chatId, msgId, `✅ 公告已发布并置顶！\n\n📢 发布目标：\`${targetGroupId}\``, env);
    return { ok: true };
  }
  await editMsg(chatId, msgId, '❌ 发布失败：请确认 bot 在该群且有发送权限。', env);
  return { ok: false, reason: 'send_failed' };
}

async function pollCmd(chatId, text, env) {
  if (chatId < 0) return sendMessage(chatId, '📊 发起投票请**私聊机器人**：\n\n直接发送 `/poll`，按提示输入投票内容。', env);
  if (!(text || '').trim()) {
    await LOTTERY_KV.put(`poll_pending:${chatId}`, '1', { expirationTtl: 900 });
    const kb = [[{ text: '❌ 取消', callback_data: 'cancel_poll_pending' }]];
    return sendMsgKb(chatId, '📊 **发起投票**\n\n请直接发送：`问题|选项1|选项2|...`\n\n💡 示例：`今晚吃什么？|火锅|烧烤|日料`\n⚡ 多选：`--multi 喜欢哪些？|A|B|C`\n📌 需要 问题 + 至少2个选项', kb, env);
  }
  let multi = false;
  let body = (text || '').trim();
  const flagMatch = body.match(/^--(multi|anonymous|open)\b/);
  if (flagMatch) { multi = flagMatch[1] === 'multi'; body = body.replace(flagMatch[0], '').trim(); }
  const parts = body.replace(/｜/g, '|').split('|').map(s => s.trim());
  if (parts.length < 3) return sendMessage(chatId, '❌ 格式错误：至少需要 问题 + 2 个选项\n用法：`/poll 问题|选项1|选项2`', env);
  const question = parts[0];
  const options = parts.slice(1);
  if (question.length > 300) return sendMessage(chatId, '❌ 问题过长（≤300字）', env);
  if (options.length > 10) return sendMessage(chatId, '❌ 选项最多10个', env);
  for (const o of options) { if (o.length > 100) return sendMessage(chatId, '❌ 单个选项不能超过100字', env); }
  const draftKey = `poll_draft:${chatId}`;
  await LOTTERY_KV.put(draftKey, JSON.stringify({ userId: chatId, question, options, multi }), { expirationTtl: 900 });
  return showGroupPicker(chatId, env, 'poll_publish');
}

async function publishPoll(chatId, userId, targetGroupId, msgId, env) {
  const draftKey = `poll_draft:${userId}`;
  const raw = await LOTTERY_KV.get(draftKey);
  await LOTTERY_KV.delete(draftKey);
  const draft = safeJsonParse(raw, null);
  if (!draft || !draft.question) { await editMsg(chatId, msgId, '⏰ 投票草稿已过期，请重新发送 `/poll` 再输入内容', env); return { ok: false, reason: 'expired' }; }
  const res = await tgApi(env, 'sendPoll', {
    chat_id: targetGroupId,
    question: draft.question,
    options: draft.options,
    is_anonymous: true,
    allows_multiple_answers: draft.multi,
  });
  if (res && res.ok) { await editMsg(chatId, msgId, `✅ 投票已发布到群 \`${targetGroupId}\`！\n\n📊 **${esc(draft.question)}**`, env); return { ok: true }; }
  await editMsg(chatId, msgId, '❌ 发布失败：请确认 bot 在该群且有发送权限。', env);
  return { ok: false, reason: 'send_failed' };
}

async function showGroupPicker(chatId, env, actionPrefix, includeChannels = false) {
  const groups = await getBotGroups(env);
  const cfg = await getUserCfg(chatId, env);
  if (cfg.defaultGroupId) {
    const idx = groups.findIndex(g => g.id === cfg.defaultGroupId);
    if (idx > 0) { const [def] = groups.splice(idx, 1); groups.unshift(def); }
  }
  const kb = [];
  for (const g of groups.slice(0, 12)) {
    const isDef = cfg.defaultGroupId === g.id;
    kb.push([{ text: `${isDef ? '⭐ ' : ''}📢 ${esc(g.title || g.id)}`, callback_data: `${actionPrefix}:${g.id}` }]);
  }
  // 可选：附带频道列表（用于公告等场景）
  if (includeChannels) {
    const channels = await getBotChannels(env);
    for (const c of channels.slice(0, 12)) {
      kb.push([{ text: `📣 ${esc(c.title || c.id)}`, callback_data: `${actionPrefix}:${c.id}` }]);
    }
  }
  kb.push([{ text: '❌ 取消', callback_data: 'cancel_group_pick' }]);
  const hint = includeChannels
    ? '📤 **选择发布目标**\n\n📢 = 群组，📣 = 频道\n点选下方目标（最多各显示12个），或直接输入 ID / t.me 链接：'
    : '📤 **选择发布群**\n\n点选下方群组（最多显示12个），或直接输入群 ID / t.me 链接：';
  return sendMsgKb(chatId, hint, kb, env);
}

async function resolveTargetGroupId(text) {
  const t = (text || '').trim();
  if (/^-?\d{5,}$/.test(t)) return parseInt(t);
  const m = t.match(/t\.me\/([A-Za-z0-9_]+)/);
  if (m) return m[1];
  if (/^@[A-Za-z0-9_]{3,}$/.test(t)) return t.slice(1);
  return null;
}

async function resolveAnnounceGroup(chatId, text, env) {
  const resolved = await resolveTargetGroupId(text);
  if (!resolved || typeof resolved === 'string') return sendMessage(chatId, '⚠️ 无法识别群标识，请发送群 ID（负整数，如 `-1001234567890`）或 t.me 链接。');
  const status = await getChatMemberStatus(resolved, chatId, env);
  if (status !== 'creator' && status !== 'administrator') { await LOTTERY_KV.delete(`announce_draft:${chatId}`); return sendMessage(chatId, '❌ 你不是该群的管理员，无法在此群发布公告。'); }
  const raw = await LOTTERY_KV.get(`announce_draft:${chatId}`);
  await LOTTERY_KV.delete(`announce_draft:${chatId}`);
  if (!raw) return sendMessage(chatId, '⏰ 公告草稿已过期，请重新发送 `/announce` 再输入内容');
  const draft = safeJsonParse(raw, {});
  const post = `📢 **公告**\n\n${draft.content}\n\n— ${'群管理组'}`;
  const res = await sendMessage(resolved, post, env);
  if (res && res.ok && res.result?.message_id) {
    await tgApi(env, 'pinChatMessage', { chat_id: resolved, message_id: res.result.message_id, disable_notification: true }).catch(() => null);
    await sendMessage(chatId, `✅ 公告已发布并置顶！\n\n📢 发布群：\`${resolved}\``, env);
    return null;
  }
  await sendMessage(chatId, '❌ 发布失败：请确认 bot 在该群且有发送权限。', env);
  return null;
}

async function resolvePollGroup(chatId, text, env) {
  const resolved = await resolveTargetGroupId(text);
  if (!resolved || typeof resolved === 'string') return sendMessage(chatId, '⚠️ 无法识别群标识，请发送群 ID（负整数，如 `-1001234567890`）或 t.me 链接。');
  const raw = await LOTTERY_KV.get(`poll_draft:${chatId}`);
  await LOTTERY_KV.delete(`poll_draft:${chatId}`);
  if (!raw) return sendMessage(chatId, '⏰ 投票草稿已过期，请重新发送 `/poll` 再输入内容');
  const draft = safeJsonParse(raw, {});
  const res = await tgApi(env, 'sendPoll', {
    chat_id: resolved,
    question: draft.question,
    options: draft.options,
    is_anonymous: true,
    allows_multiple_answers: draft.multi,
  });
  if (res && res.ok) { await sendMessage(chatId, `✅ 投票已发布到群 \`${resolved}\`！\n\n📊 **${draft.question}**`, env); return null; }
  await sendMessage(chatId, '❌ 发布失败：请确认 bot 在该群且有发送权限。', env);
  return null;
}

function genQuiz() {
  const op = Math.random() < 0.5 ? '+' : '-';
  let a = 1 + Math.floor(Math.random() * 50);
  let b = 1 + Math.floor(Math.random() * 50);
  if (op === '-' && b > a) { const t = a; a = b; b = t; }
  const answer = op === '+' ? a + b : a - b;
  return { question: `${a} ${op} ${b}`, answer };
}

async function handleVerifyStart(chatId, userId, deepLink, env) {
  if (chatId < 0) return sendMessage(chatId, '🧮 请**私聊机器人**完成入群验证：\n\n打开 @' + (deepLink.replace('verify_', '')) + ' 或从群内验证消息点按钮，在私聊里回答问题即可。', env);
  const parts = deepLink.split('_');
  if (parts.length < 3) return sendMessage(chatId, '❌ 无效的验证链接，请从群内验证消息重新点按钮', env);
  const targetUserId = parseInt(parts[parts.length - 1]);
  const targetChatId = parseInt(parts.slice(1, -1).join(''));
  if (!targetChatId || !targetUserId) return sendMessage(chatId, '❌ 无效的验证链接', env);
  if (userId !== targetUserId) return sendMessage(chatId, `⚠️ 请**本人**（用户 ${targetUserId}）点击验证链接完成入群验证。`, env);
  const vKey = `verify_pending:${targetChatId}:${targetUserId}`;
  const vRaw = await LOTTERY_KV.get(vKey);
  if (!vRaw) return sendMessage(chatId, '⏳ 该验证已过期或已完成。\n\n如果你仍然在群里但被禁言，请联系管理员处理。', env);
  const pending = safeJsonParse(vRaw, {});
  const { question, answer } = genQuiz();
  pending.stage = 'quiz';
  pending.question = question;
  pending.answer = answer;
  pending.attempts = 0;
  await LOTTERY_KV.put(vKey, JSON.stringify(pending), { expirationTtl: 660 });
  const name = pending.name || `用户${targetUserId}`;
  return sendMessage(chatId, `🧮 **入群验证**\n\n👋 你好 **${esc(name)}**！\n\n请回答下面的算术题以完成验证（答错可重试，最多3次）：\n\n**${question} = ?**\n\n📝 直接回复**答案数字**即可。`, env);
}

async function tryVerifyAnswer(chatId, userId, text, env) {
  if (chatId < 0) return false;
  let matchedKey = null, pending = null;
  try {
    const list = await LOTTERY_KV.list({ prefix: 'verify_pending:' });
    for (const k of list.keys || []) {
      const raw = await LOTTERY_KV.get(k.name);
      if (!raw) continue;
      let p;
      try { p = JSON.parse(raw); } catch { continue; }
      if (p.userId === userId && p.stage === 'quiz') { matchedKey = k.name; pending = p; break; }
    }
  } catch { return false; }
  if (!pending) return false;
  let answerNum = NaN;
  const plusM = (text || '').match(/(\d+)\s*\+\s*(\d+)/);
  const minusM = (text || '').match(/(\d+)\s*-\s*(\d+)/);
  if (plusM) answerNum = parseInt(plusM[1], 10) + parseInt(plusM[2], 10);
  else if (minusM) answerNum = parseInt(minusM[1], 10) - parseInt(minusM[2], 10);
  else answerNum = parseInt((text || '').replace(/[^\d-]/g, ''), 10);
  const displayName = pending.name || `用户${userId}`;
  if (!isNaN(answerNum) && answerNum === pending.answer) {
    const vcfg = await getVerifyCfg(pending.chatId);
    const forceChannel = (vcfg.forceChannel || '').trim();
    if (forceChannel) {
      const joined = await checkChannelMembership(forceChannel, userId, env);
      if (!joined) {
        // 答题正确但未关注频道: 保持禁言, 进入频道关注阶段
        pending.stage = 'channel';
        pending.forceChannel = forceChannel;
        await LOTTERY_KV.put(matchedKey, JSON.stringify(pending), { expirationTtl: 660 });
        const chName = forceChannel.replace(/^@/, '');
        const openUrl = /^-?\d+$/.test(forceChannel)
          ? `https://t.me/c/${String(Math.abs(parseInt(forceChannel, 10))).replace(/^100/, '')}`
          : `https://t.me/${chName}`;
        const subKb = [
          [{ text: '📢 打开频道关注', url: openUrl }],
          [{ text: '✅ 我已关注，完成验证', callback_data: `verify_sub:${pending.chatId}:${userId}` }],
        ];
        await sendMsgKb(chatId, `✅ 数学题回答正确！\n\n📢 **还差最后一步**\n请先关注我们的频道 **${esc(forceChannel)}**，关注后点击下方「我已关注」按钮，系统将自动解除你的禁言。\n\n⏳ 全部流程需在入群 10 分钟内完成。`, subKb, env);
        return true;
      }
    }
    await finishVerification(pending, matchedKey, chatId, userId, displayName, env);
    return true;
  }
  pending.attempts = (pending.attempts || 0) + 1;
  if (pending.attempts >= 3) {
    const { question, answer } = genQuiz();
    pending.question = question;
    pending.answer = answer;
    pending.attempts = 0;
    await LOTTERY_KV.put(matchedKey, JSON.stringify(pending), { expirationTtl: 660 });
    await sendMessage(chatId, `❌ 已连续答错 3 次，已为你更换新题：\n\n**${question} = ?**\n\n📝 直接回复答案数字即可。`, env);
    return true;
  }
  await LOTTERY_KV.put(matchedKey, JSON.stringify(pending), { expirationTtl: 660 });
  await sendMessage(chatId, `❌ 答案不对哦，请再想想（剩余 ${3 - pending.attempts} 次机会）：\n\n**${pending.question} = ?**`, env);
  return true;
}

async function verifyCmd(chatId, userId, arg, env) {
  if (chatId > 0) return sendMessage(chatId, '❌ 请在群聊中使用：`/verify on|off`', env);
  const admin = await getChatMemberStatus(chatId, userId, env);
  if (admin !== 'creator' && admin !== 'administrator') return sendMessage(chatId, '❌ 只有群管理员才能设置入群验证', env);
  const cfgKey = `verify_cfg:${chatId}`;
  const cfgRaw = await LOTTERY_KV.get(cfgKey);
  let cfg = { enabled: true };
  if (cfgRaw) { try { cfg = JSON.parse(cfgRaw); } catch {} }
  const a = (arg || '').toLowerCase();
  if (a === 'on' || a === '1' || a === '开') { cfg.enabled = true; await LOTTERY_KV.put(cfgKey, JSON.stringify(cfg)); return sendMessage(chatId, '✅ 入群验证已开启：新成员需点击验证按钮后方可发言。', env); }
  if (a === 'off' || a === '0' || a === '关') { cfg.enabled = false; await LOTTERY_KV.put(cfgKey, JSON.stringify(cfg)); return sendMessage(chatId, '⛔ 入群验证已关闭。', env); }
  return sendMessage(chatId, `🛡️ 入群验证当前状态：**${cfg.enabled ? '开启 ✅' : '关闭 ❌'}**${cfg.forceChannel ? `\n📢 答题后强制关注：**${esc(cfg.forceChannel)}** ✅` : ''}\n\n用法：\`/verify on\` 开启 · \`/verify off\` 关闭\n\`/forcesub @频道\` 设置关注频道 · \`/forcesub off\` 关闭`, env);
}

async function getVerifyCfg(chatId) {
  const raw = await LOTTERY_KV.get(`verify_cfg:${chatId}`);
  let cfg = { enabled: true };
  if (raw) { try { cfg = JSON.parse(raw); } catch {} }
  return cfg;
}

async function finishVerification(pending, matchedKey, privateChatId, userId, displayName, env) {
  if (pending.muted) await tgApi(env, 'restrictChatMember', { chat_id: pending.chatId, user_id: userId, permissions: allPermissionsObject(true) }).catch(() => {});
  await LOTTERY_KV.delete(matchedKey);
  if (pending.msgId) await tgApi(env, 'deleteMessage', { chat_id: pending.chatId, message_id: pending.msgId }).catch(() => {});
  if (privateChatId) await sendMessage(privateChatId, `✅ 验证成功！**${esc(displayName)}** 已解除禁言，欢迎加入本群～ 🎉`, env).catch(() => {});
  // 验证完成通知：10 秒后自动删除
  const notifyMsg = await sendMessage(pending.chatId, `✅ **${esc(displayName)}** 已完成验证，欢迎加入本群！🎉`, env).catch(() => null);
  if (notifyMsg?.ok && notifyMsg.result?.message_id) {
    const nid = notifyMsg.result.message_id;
    await logNotifyMsg(pending.chatId, nid);
    setTimeout(() => tgApi(env, 'deleteMessage', { chat_id: pending.chatId, message_id: nid }).catch(() => null), 10 * 1000);
  }
  // 验证完成后再发送欢迎语+配置按钮
  try {
    const wcfg = await getWelcomeCfg(pending.chatId);
    if (wcfg.enabled) {
      const wtext = (wcfg.text || `👋 欢迎 ${displayName} 加入本群！`).replace(/\{name\}/g, displayName);
      let wres = null;
      if (wcfg.media) {
        const markupObj = wcfg.buttons?.length ? { inline_keyboard: wcfg.buttons } : undefined;
        if (wcfg.mediaType === 'video') wres = await tgApi(env, 'sendVideo', { chat_id: pending.chatId, video: wcfg.media, caption: wtext, reply_markup: markupObj }).catch(() => null);
        else wres = await tgApi(env, 'sendPhoto', { chat_id: pending.chatId, photo: wcfg.media, caption: wtext, reply_markup: markupObj }).catch(() => null);
      } else {
        if (wcfg.buttons?.length) wres = await sendMsgKb(pending.chatId, wtext, wcfg.buttons, env).catch(() => null);
        else wres = await sendMessage(pending.chatId, wtext, env).catch(() => null);
      }
      if (wres?.ok && wres.result?.message_id) {
        await LOTTERY_KV.put(`welcome_last:${pending.chatId}`, String(wres.result.message_id), { expirationTtl: 7 * 24 * 60 * 60 });
      }
    }
  } catch (e) { console.error('welcome after verify error:', e.message); }
}

// ==================== 验证通知记录与一键清理 ====================

async function logNotifyMsg(chatId, msgId) {
  try {
    if (!chatId || !msgId) return;
    const key = `notify_log:${chatId}`;
    const raw = await LOTTERY_KV.get(key);
    let arr = [];
    if (raw) { try { arr = JSON.parse(raw); } catch {} }
    if (!Array.isArray(arr)) arr = [];
    if (!arr.includes(msgId)) {
      arr.push(msgId);
      if (arr.length > 200) arr = arr.slice(-200);
      await LOTTERY_KV.put(key, JSON.stringify(arr));
    }
  } catch (e) { console.error('logNotifyMsg error:', e.message); }
}

async function showNotifyCleanMenu(chatId, msgId, env, userId, groupId) {
  const groups = await getBotGroups(env);
  const g = groups.find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, `🛡️ **${esc(gname)}**\n\n❌ 你不是该群管理员，无法管理。`, env); return; }
  const raw = await LOTTERY_KV.get(`notify_log:${groupId}`);
  let arr = [];
  if (raw) { try { arr = JSON.parse(raw); } catch {} }
  const kb = [
    [{ text: '🧹 立即清理', callback_data: `mod_notify_clean:${groupId}` }],
    [{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }],
  ];
  await editMsg(chatId, msgId, `🧹 **清理验证通知** — ${esc(gname)}\n\n已记录 **${arr.length} 条**验证相关通知（✅ 验证完成 / 🚫 未验证移出）。\n\n点击「立即清理」删除这些消息；新通知发出后 10 秒也会自动删除，群内不会堆积。`, env, kb);
}

async function cleanNotifyMessages(chatId, msgId, env, userId, groupId, gname) {
  const key = `notify_log:${groupId}`;
  const raw = await LOTTERY_KV.get(key);
  let arr = [];
  if (raw) { try { arr = JSON.parse(raw); } catch {} }
  let ok = 0;
  const remain = [];
  for (const mid of arr) {
    const r = await tgApi(env, 'deleteMessage', { chat_id: groupId, message_id: mid }).catch(() => null);
    if (r?.ok) ok++;
    else remain.push(mid);
  }
  if (remain.length) await LOTTERY_KV.put(key, JSON.stringify(remain));
  else await LOTTERY_KV.delete(key);
  const note = arr.length === 0 ? '（没有已记录的通知）' : ok > 0 ? `✅ 已删除 **${ok}** 条通知。` : '通知均已不存在（可能已被 10 秒自动删除）。';
  await editMsg(chatId, msgId, `🧹 **清理完成** — ${esc(gname)}\n\n${note}`, env);
}

// ==================== 群成员注册表（频道关注巡检） ====================

async function getGroupMembers(chatId) {
  const raw = await LOTTERY_KV.get(`gm:${chatId}`);
  if (!raw) return [];
  try {
    const o = safeJsonParse(raw, {});
    return Object.entries(o).map(([id, v]) => ({ id: parseInt(id, 10), name: v.name || `用户${id}`, joinedAt: v.at || 0 }));
  } catch { return []; }
}

async function addGroupMember(chatId, user) {
  const key = `gm:${chatId}`;
  const raw = await LOTTERY_KV.get(key);
  let o = {};
  if (raw) { try { o = JSON.parse(raw); } catch {} }
  o[String(user.id)] = { name: o[String(user.id)]?.name || user.username || user.first_name || `用户${user.id}`, at: Date.now() };
  await LOTTERY_KV.put(key, JSON.stringify(o));
}

async function removeGroupMember(chatId, userId) {
  const key = `gm:${chatId}`;
  const raw = await LOTTERY_KV.get(key);
  if (!raw) return;
  try {
    const o = safeJsonParse(raw, {});
    if (o[String(userId)]) { delete o[String(userId)]; await LOTTERY_KV.put(key, JSON.stringify(o)); }
  } catch {}
}

async function forceSubCheck(targetGroupId, actorUserId, env) {
  const admin = await getChatMemberStatus(targetGroupId, actorUserId, env);
  if (!isAdminStatus(admin)) return sendMessage(actorUserId, '❌ 只有群管理员才能执行巡检', env);
  const cfg = await getVerifyCfg(targetGroupId);
  const ch = (cfg.forceChannel || '').trim();
  if (!ch) return sendMessage(actorUserId, '❌ 本群尚未设置强制关注频道。\n请先用 `/forcesub @频道` 或群管理菜单设置。', env);
  const members = await getGroupMembers(targetGroupId);
  if (!members.length) return sendMessage(actorUserId, 'ℹ️ 群成员注册表为空。\n\n📌 说明：Telegram Bot API 无法获取群内全部成员列表，bot 只能记录**入群之后**的成员。请等待新成员入群后注册表逐步完整，再重新巡检。', env);
  const admins = new Set();
  try {
    const ar = await tgApi(env, 'getChatAdministrators', { chat_id: targetGroupId });
    if (ar?.ok) for (const a of ar.result || []) admins.add(a.user.id);
  } catch {}
  const botId = parseInt((process.env.BOT_TOKEN || '').split(':')[0]);
  admins.add(botId);
  const missing = [];
  const needNotify = [];
  const now = Date.now();
  for (const m of members) {
    if (admins.has(m.id)) continue;
    const st = await getChatMemberStatus(targetGroupId, m.id, env);
    if (st !== 'member' && st !== 'restricted' && st !== 'creator' && st !== 'administrator') { await removeGroupMember(targetGroupId, m.id); await LOTTERY_KV.delete(`fsub_check:${targetGroupId}:${m.id}`); continue; }
    const ok = await checkChannelMembership(ch, m.id, env);
    const fKey = `fsub_check:${targetGroupId}:${m.id}`;
    if (ok) {
      // 已关注：删除提醒消息、解除禁言、清记录
      const exRaw = await LOTTERY_KV.get(fKey);
      if (exRaw) {
        let ex; try { ex = JSON.parse(exRaw); } catch {}
        if (ex?.msgId) await tgApi(env, 'deleteMessage', { chat_id: targetGroupId, message_id: ex.msgId }).catch(() => null);
        if (st === 'restricted') await tgApi(env, 'restrictChatMember', { chat_id: targetGroupId, user_id: m.id, permissions: allPermissionsObject(true) }).catch(() => null);
        await LOTTERY_KV.delete(fKey);
      }
      continue;
    }
    missing.push(m);
    const existRaw = await LOTTERY_KV.get(fKey);
    if (!existRaw) needNotify.push(m);
  }
  if (!missing.length) return sendMessage(actorUserId, `✅ 巡检完成：所有已记录成员均已关注频道 **${esc(ch)}**。`);
  const botUn = await getBotUsername(env);
  const deadline = now + 24 * 3600 * 1000;
  for (const m of needNotify) {
    const fKey = `fsub_check:${targetGroupId}:${m.id}`;
    const verifyUrl = botUn ? `https://t.me/${botUn}?start=fsub_${targetGroupId}_${m.id}` : null;
    const kb = verifyUrl ? [[{ text: '✅ 前往验证', url: verifyUrl }]] : [];
    const msgRes = await sendMsgKb(targetGroupId, `[${esc(m.name)}](tg://user?id=${m.id}) 你还未关注频道 **${esc(ch)}**！\n请点击下方按钮跳转机器人完成关注验证。\n\n⏳ 请在 **24 小时**内完成关注，超时将被移出群聊。`, kb, env).catch(() => null);
    // 未关注期间禁言（24 小时）
    await tgApi(env, 'restrictChatMember', { chat_id: targetGroupId, user_id: m.id, permissions: allPermissionsObject(false) }).catch(() => null);
    await LOTTERY_KV.put(fKey, JSON.stringify({ chatId: targetGroupId, userId: m.id, name: m.name, checkedAt: now, deadline, msgId: msgRes?.result?.message_id || null }), { expirationTtl: 25 * 3600 });
  }
  const tip = needNotify.length ? `已新增提醒 **${needNotify.length}** 人（24 小时时效 + 禁言）。` : `其余 **${missing.length - needNotify.length}** 人已在 24 小时时效内，超时自动移出。`;
  return sendMessage(actorUserId, `🔍 **巡检完成**\n\n共检查 ${members.length} 名已记录成员，其中 **${missing.length} 人未关注**频道 ${esc(ch)}。\n${tip}`);
}

async function handleFsubStart(chatId, userId, deepLink, env) {
  if (chatId < 0) return sendMessage(chatId, '🧮 请**私聊机器人**完成关注验证：\n\n从群内提醒消息点「✅ 前往验证」按钮，在私聊里即可完成验证。', env);
  const parts = deepLink.split('_');
  if (parts.length < 3) return sendMessage(chatId, '❌ 无效的验证链接，请从群内提醒消息重新点按钮', env);
  const targetUserId = parseInt(parts[parts.length - 1]);
  const targetChatId = parseInt(parts.slice(1, -1).join(''));
  if (!targetChatId || !targetUserId) return sendMessage(chatId, '❌ 无效的验证链接', env);
  if (userId !== targetUserId) {
    const cfg = await getVerifyCfg(targetChatId);
    const ch = (cfg.forceChannel || '').trim();
    const chName = ch.replace(/^@/, '');
    const openUrl = /^-?\d+$/.test(ch)
      ? `https://t.me/c/${String(Math.abs(parseInt(ch, 10))).replace(/^100/, '')}`
      : `https://t.me/${chName}`;
    const kb = [[{ text: '📢 打开频道关注', url: openUrl }]];
    return sendMsgKb(chatId, `⚠️ 请**本人**（用户 ${targetUserId}）点击验证链接完成关注验证。\n\n你不是本人，无法代为验证。`, kb, env);
  }
  const cfg = await getVerifyCfg(targetChatId);
  const ch = (cfg.forceChannel || '').trim();
  if (!ch) return sendMessage(chatId, 'ℹ️ 该群当前未设置强制关注频道，无需验证。', env);
  const ok = await checkChannelMembership(ch, userId, env);
  const fKey = `fsub_check:${targetChatId}:${userId}`;
  if (ok) {
    const exRaw = await LOTTERY_KV.get(fKey);
    if (exRaw) {
      let ex; try { ex = JSON.parse(exRaw); } catch {}
      if (ex?.msgId) await tgApi(env, 'deleteMessage', { chat_id: targetChatId, message_id: ex.msgId }).catch(() => null);
    }
    await LOTTERY_KV.delete(fKey);
    try { const st = await getChatMemberStatus(targetChatId, userId, env); if (st === 'restricted') await tgApi(env, 'restrictChatMember', { chat_id: targetChatId, user_id: userId, permissions: allPermissionsObject(true) }).catch(() => null); } catch {}
    return sendMessage(chatId, `✅ **验证通过！** 你已关注频道 **${esc(ch)}**，无需再处理。`);
  }
  const chName = ch.replace(/^@/, '');
  const openUrl = /^-?\d+$/.test(ch)
    ? `https://t.me/c/${String(Math.abs(parseInt(ch, 10))).replace(/^100/, '')}`
    : `https://t.me/${chName}`;
  const kb = [[{ text: '📢 打开频道关注', url: openUrl }], [{ text: '✅ 我已关注，重新验证', callback_data: `fsub_retry:${targetChatId}:${userId}` }]];
  return sendMsgKb(chatId, `❌ 还未检测到你已关注频道 **${esc(ch)}**。\n\n请先点击上方按钮打开频道并关注，然后点击「我已关注，重新验证」。`, kb, env);
}

const MAX_FSUB_DEADLINE_EXTEND = 7; // 最多续期7天

async function checkFsubExpired(env) {
  try {
    const list = await LOTTERY_KV.list({ prefix: 'fsub_check:' });
    if (!list.keys || !list.keys.length) return;
    const now = Date.now();
    const datas = await Promise.all(list.keys.map(k => LOTTERY_KV.get(k.name)));
    for (let i = 0; i < list.keys.length; i++) {
      const raw = datas[i];
      if (!raw) continue;
      let p;
      try { p = JSON.parse(raw); } catch { continue; }
      if (now < p.deadline) continue;
      const extCount = p.extendCount || 0;
      if (extCount >= MAX_FSUB_DEADLINE_EXTEND) {
        // 超过最大续期次数，踢出用户
        await tgApi(env, 'banChatMember', { chat_id: p.chatId, user_id: p.userId }).catch(() => null);
        if (p.msgId) await tgApi(env, 'deleteMessage', { chat_id: p.chatId, message_id: p.msgId }).catch(() => null);
        await LOTTERY_KV.delete(list.keys[i].name);
        continue;
      }
      // 未超次数：续期继续追踪
      await LOTTERY_KV.put(list.keys[i].name, JSON.stringify({ ...p, deadline: now + 24 * 3600 * 1000, extendCount: extCount + 1 }), { expirationTtl: 25 * 3600 });
    }
  } catch (err) { console.error('checkFsubExpired error:', err); }
}

async function autoFsubRounds(env) {
  try {
    // 节流：每 10 分钟一轮
    const last = await LOTTERY_KV.get('fsub_auto_last_run');
    const nowTs = Date.now();
    if (last && nowTs - parseInt(last) < 10 * 60 * 1000) return;
    await LOTTERY_KV.put('fsub_auto_last_run', String(nowTs));
    const list = await LOTTERY_KV.list({ prefix: 'verify_cfg:' });
    if (!list.keys || !list.keys.length) return;
    const cfgDatas = await Promise.all(list.keys.map(k => LOTTERY_KV.get(k.name)));
    for (let ci = 0; ci < list.keys.length; ci++) {
      const raw = cfgDatas[ci];
      if (!raw) continue;
      let cfg; try { cfg = JSON.parse(raw); } catch { continue; }
      const ch = (cfg.forceChannel || '').trim();
      if (!ch) continue;
      const chatId = parseInt(list.keys[ci].name.split(':')[1]);
      if (!chatId) continue;
      const members = await getGroupMembers(chatId);
      if (!members.length) continue;
      const admins = new Set();
      try {
        const ar = await tgApi(env, 'getChatAdministrators', { chat_id: chatId });
        if (ar?.ok) for (const a of ar.result || []) admins.add(a.user.id);
      } catch (e) { console.warn('[warn]', e?.message || e); }
      const botId = parseInt((process.env.BOT_TOKEN || '').split(':')[0]);
      admins.add(botId);
      const now = Date.now();
      for (const m of members) {
        if (admins.has(m.id)) continue;
        const st = await getChatMemberStatus(chatId, m.id, env);
        if (st !== 'member' && st !== 'restricted' && st !== 'creator' && st !== 'administrator') { await removeGroupMember(chatId, m.id); await LOTTERY_KV.delete(`fsub_check:${chatId}:${m.id}`); continue; }
        const ok = await checkChannelMembership(ch, m.id, env);
        const fKey = `fsub_check:${chatId}:${m.id}`;
        const exRaw = await LOTTERY_KV.get(fKey);
        if (ok) {
          // 已关注：删提醒消息、解除禁言、清记录
          if (exRaw) {
            let ex; try { ex = JSON.parse(exRaw); } catch (e) { console.warn('[warn]', e?.message || e); }
            if (ex?.msgId) await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: ex.msgId }).catch(() => null);
            if (st === 'restricted') await tgApi(env, 'restrictChatMember', { chat_id: chatId, user_id: m.id, permissions: allPermissionsObject(true) }).catch(() => null);
            await LOTTERY_KV.delete(fKey);
          }
          continue;
        }
        if (exRaw) continue; // 已在 24h 时效内，等超时
        // 新发现未关注：@ 提醒 + 禁言 + 记录
        const botUn = await getBotUsername(env);
        const deadline = now + 24 * 3600 * 1000;
        const verifyUrl = botUn ? `https://t.me/${botUn}?start=fsub_${chatId}_${m.id}` : null;
        const kb = verifyUrl ? [[{ text: '✅ 前往验证', url: verifyUrl }]] : [];
        const msgRes = await sendMsgKb(chatId, `[${esc(m.name)}](tg://user?id=${m.id}) 你还未关注频道 **${esc(ch)}**！\n请点击下方按钮跳转机器人完成关注验证。\n\n⏳ 请在 **24 小时**内完成关注，超时将被移出群聊。`, kb, env).catch(() => null);
        await tgApi(env, 'restrictChatMember', { chat_id: chatId, user_id: m.id, permissions: allPermissionsObject(false) }).catch(() => null);
        await LOTTERY_KV.put(fKey, JSON.stringify({ chatId, userId: m.id, name: m.name, checkedAt: now, deadline, msgId: msgRes?.result?.message_id || null }), { expirationTtl: 25 * 3600 });
      }
    }
  } catch (err) { console.error('autoFsubRounds error:', err); }
}

async function forceSubCmd(chatId, userId, arg, env) {
  if (chatId > 0) return sendMessage(chatId, '❌ 请在群聊中使用：`/forcesub @频道用户名`（或 `/forcesub off` 关闭）', env);
  const admin = await getChatMemberStatus(chatId, userId, env);
  if (admin !== 'creator' && admin !== 'administrator') return sendMessage(chatId, '❌ 只有群管理员才能设置强制关注频道', env);
  const cfgKey = `verify_cfg:${chatId}`;
  const cfg = await getVerifyCfg(chatId);
  const a = (arg || '').trim();
  const al = a.toLowerCase();
  if (!al) {
    return sendMessage(chatId, `📢 **入群强制关注频道**\n\n当前：${cfg.forceChannel ? `**${esc(cfg.forceChannel)}** ✅（答题通过后还须关注该频道才解除禁言）` : '未设置 ❌'}\n\n用法：\n\`/forcesub @你的频道\` 设置（也支持 t.me 链接或 -100 数字ID）\n\`/forcesub off\` 关闭`, env);
  }
  if (al === 'off' || al === '0' || al === '关闭' || al === '关') {
    cfg.forceChannel = '';
    await LOTTERY_KV.put(cfgKey, JSON.stringify(cfg));
    return sendMessage(chatId, '⛔ 已关闭入群强制关注频道（入群验证本身仍按 /verify 开关运行）。', env);
  }
  const normalized = normalizeChannelInput(a);
  if (!normalized) return sendMessage(chatId, '❌ 频道格式无效。\n公开频道：`@mychannel` 或 `https://t.me/mychannel`\n私有频道：先把 bot 拉入频道设为管理员，再填 `-100` 开头的数字 ID。', env);
  const probe = await checkChannelMembership(normalized, userId, env);
  cfg.forceChannel = normalized;
  await LOTTERY_KV.put(cfgKey, JSON.stringify(cfg));
  const warn = probe ? '' : '\n\n⚠️ 暂时无法查询你在该频道的成员身份，请确认频道用户名正确、且 bot 可访问该频道（私有频道须把 bot 设为频道管理员），否则新人将无法通过验证。';
  return sendMessage(chatId, `✅ 已设置入群强制关注频道：**${esc(normalized)}**\n\n新人完整流程：入群禁言 → 数学验证 → 关注频道检查，全部通过才解除禁言；10 分钟内未完成会被移出。${warn}`, env);
}

async function diagCmd(chatId, userId, env) {
  if (chatId < 0) return sendMessage(chatId, '❌ 请在私聊中使用：`/diag`', env);
  const lines = ['🔍 **入群验证诊断**\n'];
  try {
    const res = await tgApi(env, 'getWebhookInfo', {});
    if (!res.ok) lines.push('🌐 **Webhook**：查询失败');
    else {
      const info = res.result || {};
      const allowed = (info.allowed_updates || []).join(', ') || '（无限制=全部）';
      lines.push(`🌐 **Webhook**：\nURL: \`${info.url || '（未设置）'}\`\nallowed_updates: \`${allowed}\`\n待处理队列: ${info.pending_update_count ?? '?'}`);
      const hasChatMember = !info.allowed_updates || info.allowed_updates.includes('chat_member');
      lines.push(`chat_member 事件: ${hasChatMember ? '✅ 已包含' : '❌ 未包含（入群验证收不到！）'}`);
    }
  } catch (err) { lines.push(`🌐 **Webhook**：查询失败（${err.message || err}）`); }
  try {
    const groups = await getBotGroups(env);
    if (!groups.length) lines.push('\n👥 **bot 所在群**：还没有记录到群（bot 加入群后需重新部署/等 my_chat_member 事件）');
    else {
      lines.push(`\n👥 **bot 所在群**（${groups.length}）：`);
      for (const g of groups) {
        const admin = await isBotAdmin(g.id, env);
        lines.push(`- ${esc(g.title || `群 ${g.id}`)}：${admin ? '✅ 管理员' : '❌ 非管理员（收不到入群事件，无法禁言/踢人！）'}`);
      }
    }
  } catch (err) { lines.push(`\n👥 **bot 所在群**：读取失败（${err.message || err}）`); }
  try {
    const groups = await getBotGroups(env);
    if (groups.length) {
      lines.push('\n⚙️ **入群验证开关**：');
      for (const g of groups) {
        const raw = await LOTTERY_KV.get(`verify_cfg:${g.id}`);
        let enabled = true;
        if (raw) { try { enabled = JSON.parse(raw).enabled; } catch {} }
        lines.push(`- ${esc(g.title || `群 ${g.id}`)}：${enabled ? '开启 ✅' : '关闭 ❌'}`);
      }
    }
  } catch {}
  try {
    const raw = await LOTTERY_KV.get('bot_groups');
    if (raw) {
      let rawGroups;
      try { rawGroups = JSON.parse(raw); } catch { rawGroups = []; }
      if (Array.isArray(rawGroups) && rawGroups.length > 0) {
        lines.push('\n📦 **bot_groups 原始数据**（KV 中存的所有条目）：');
        for (const g of rawGroups) lines.push(`- id=${g.id} title=${esc(g.title || '?')}`);
      }
    }
  } catch {}
  try {
    const logRaw = await LOTTERY_KV.get('debug:chat_member_events');
    if (logRaw) {
      const logs = safeJsonParse(logRaw, []);
      if (logs.length > 0) {
        lines.push('\n📋 **最近 chat_member 事件**：');
        for (const e of logs) {
          const dt = new Date(e.t).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
          const res = e.processed || 'pending';
          lines.push(`- \`${dt}\` 群${e.chat} 用户${e.user}(${e.name}) ${e.old}→${e.new} → ${res}`);
        }
      }
    }
  } catch {}
  return sendMessage(chatId, lines.join('\n'), env);
}

async function getChatMemberStatus(chatId, userId, env) {
  try {
    const res = await tgApi(env, 'getChatMember', { chat_id: chatId, user_id: userId });
    if (res.ok && res.result?.status) return res.result.status;
  } catch {}
  return '';
}

const MOD_CMD_LIST = ['/mute', '/unmute', '/kick', '/ban', '/unban', '/warn', '/unwarn', '/warns', '/warnings', '/del', '/pin', '/unpin', '/settitle', '/welcome', '/rules', '/lock', '/unlock', '/admins', '/adminlist', '/info', '/groupinfo'];

function parseMuteTime(arg) {
  const a = (arg || '').trim().toLowerCase();
  if (!a) return { seconds: 60 * 60, label: '1小时', forever: false };
  if (a === 'forever' || a === '永久' || a === '0') return { seconds: 0, label: '永久', forever: true };
  const m = a.match(/^(\d+)\s*(s|秒|m|分|分钟|h|时|小时|d|天)$/);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = m[2];
  let seconds;
  if (unit === 's' || unit === '秒') seconds = n;
  else if (unit === 'm' || unit === '分' || unit === '分钟') seconds = n * 60;
  else if (unit === 'h' || unit === '时' || unit === '小时') seconds = n * 60 * 60;
  else if (unit === 'd' || unit === '天') seconds = n * 24 * 60 * 60;
  return { seconds, label: a, forever: n <= 0 };
}

async function getGroupCfg(chatId, env) {
  const raw = await LOTTERY_KV.get(`group_cfg:${chatId}`);
  if (!raw) return { welcome: '', rules: '', lock: false };
  try { return JSON.parse(raw); } catch { return { welcome: '', rules: '', lock: false }; }
}

function isAdminStatus(s) {
  return s === 'creator' || s === 'administrator';
}

async function getWelcomeText(chatId, name, env) {
  try {
    const cfg = await getGroupCfg(chatId, env);
    if (!cfg.welcome) return null;
    return cfg.welcome.replace(/\{name\}/g, name);
  } catch { return null; }
}

async function sendWelcomeIfSet(chatId, name, env) {
  try {
    const text = await getWelcomeText(chatId, name, env);
    if (!text) return null;
    return sendMessage(chatId, text, env);
  } catch { return null; }
}

async function handleModCmd(chatId, userId, cmd, arg, msg, chatTitle, env) {
  if (chatId > 0) return sendMessage(chatId, '❌ 群管命令请在群聊中使用。', env);
  const isAdmin = await getChatMemberStatus(chatId, userId, env);
  if (!isAdminStatus(isAdmin)) return sendMessage(chatId, '❌ 只有群管理员才能使用群管命令', env);
  const botAdmin = await isBotAdmin(chatId, env);
  const replyUser = msg.reply_to_message?.from ? msg.reply_to_message.from : null;

  if (cmd === '/admins' || cmd === '/adminlist') {
    try {
      const res = await tgApi(env, 'getChatAdministrators', { chat_id: chatId });
      if (!res.ok) return sendMessage(chatId, '❌ 获取管理员列表失败', env);
      const lines = res.result.map((a, i) => {
        const u = a.user;
        const name = u.username ? `@${u.username}` : (u.first_name || `用户${u.id}`);
        const role = a.status === 'creator' ? '👑 群主' : '🛡️ 管理员';
        return `${i + 1}. ${role} ${esc(name)}`;
      });
      return sendMessage(chatId, `🛡️ **管理员列表**（${lines.length}）\n\n${lines.join('\n')}`, env);
    } catch { return sendMessage(chatId, '❌ 获取管理员列表失败', env); }
  }

  if (cmd === '/info' || cmd === '/groupinfo') {
    try {
      const [chatRes, memRes, admRes] = await Promise.all([
        tgApi(env, 'getChat', { chat_id: chatId }),
        tgApi(env, 'getChatMemberCount', { chat_id: chatId }),
        tgApi(env, 'getChatAdministrators', { chat_id: chatId }),
      ]);
      const title = chatRes.ok ? (chatRes.result.title || chatTitle) : chatTitle;
      const members = memRes.ok ? memRes.result : '?';
      const admins = admRes.ok ? admRes.result.length : '?';
      return sendMessage(chatId, `ℹ️ **群信息**\n\n📢 群名：${esc(title)}\n👥 成员：${members}\n🛡️ 管理员：${admins}\n🆔 ID：\`${chatId}\`\n🤖 bot 管理员权限：${botAdmin ? '✅ 有' : '❌ 无（部分功能不可用）'}`, env);
    } catch { return sendMessage(chatId, '❌ 获取群信息失败', env); }
  }

  if (cmd === '/settitle') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能修改群标题', env);
    const title = (arg || '').trim();
    if (!title || title.length > 128) return sendMessage(chatId, '❌ 请输入群标题（≤128字符）', env);
    const res = await tgApi(env, 'setChatTitle', { chat_id: chatId, title });
    return res.ok ? sendMessage(chatId, `✅ 群标题已改为：**${esc(title)}**`, env) : sendMessage(chatId, '❌ 修改失败（权限不足？）', env);
  }

  if (cmd === '/welcome') {
    const a = (arg || '').trim();
    if (!a) {
      const cfg = await getGroupCfg(chatId, env);
      return sendMessage(chatId, `👋 **欢迎语**：${cfg.welcome ? `\n\n${cfg.welcome}` : '（未设置）'}\n\n设置：\`/welcome 文本\`（\`{name}\` 代表新成员名）\n关闭：\`/welcome off\``, env);
    }
    const cfg = await getGroupCfg(chatId, env);
    if (a.toLowerCase() === 'off' || a === '关') { cfg.welcome = ''; await LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg)); return sendMessage(chatId, '🚫 欢迎语已关闭', env); }
    if (a.length > 500) return sendMessage(chatId, '❌ 欢迎语过长（≤500字）', env);
    cfg.welcome = a;
    await LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg));
    return sendMessage(chatId, `✅ 欢迎语已设置：\n\n${a}\n\n新成员加入时会自动发送（\`{name}\` 自动替换为成员名）。`, env);
  }

  if (cmd === '/rules') {
    const a = (arg || '').trim();
    if (!a) {
      const cfg = await getGroupCfg(chatId, env);
      return sendMessage(chatId, `📜 **群规**：${cfg.rules ? `\n\n${cfg.rules}` : '（未设置）'}\n\n设置：\`/rules 群规内容\``, env);
    }
    const cfg = await getGroupCfg(chatId, env);
    if (a.length > 2000) return sendMessage(chatId, '❌ 群规过长（≤2000字）', env);
    cfg.rules = a;
    await LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg));
    return sendMessage(chatId, `✅ 群规已设置：\n\n${a}`, env);
  }

  if (cmd === '/lock' || cmd === '/unlock') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能设置全员禁言', env);
    const lock = cmd === '/lock';
    const res = await tgApi(env, 'setChatPermissions', { chat_id: chatId, permissions: allPermissionsObject(!lock) });
    if (!res.ok) return sendMessage(chatId, '❌ 设置失败（权限不足？）', env);
    const cfg = await getGroupCfg(chatId, env);
    cfg.lock = lock;
    await LOTTERY_KV.put(`group_cfg:${chatId}`, JSON.stringify(cfg));
    return sendMessage(chatId, lock ? '🔒 全员禁言已开启（除管理员外禁止发言）' : '🔓 全员禁言已解除', env);
  }

  if (!replyUser) return sendMessage(chatId, '❌ 请**回复**目标用户的消息来使用该命令', env);
  const targetId = replyUser.id;
  const targetName = replyUser.username ? `@${replyUser.username}` : (replyUser.first_name || `用户${targetId}`);

  if (cmd === '/del' || cmd === '/delete') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能删除消息', env);
    const msgId = msg.reply_to_message.message_id;
    const res = await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => null);
    await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => null);
    return res && res.ok ? null : sendMessage(chatId, '❌ 删除失败', env);
  }

  if (cmd === '/pin') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能置顶', env);
    const msgId = msg.reply_to_message.message_id;
    const res = await tgApi(env, 'pinChatMessage', { chat_id: chatId, message_id: msgId, disable_notification: true }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, '📌 已置顶该消息', env) : sendMessage(chatId, '❌ 置顶失败（权限不足？）', env);
  }

  if (cmd === '/unpin') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能取消置顶', env);
    const msgId = msg.reply_to_message.message_id;
    const res = await tgApi(env, 'unpinChatMessage', { chat_id: chatId, message_id: msgId }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, '📍 已取消置顶', env) : sendMessage(chatId, '❌ 取消置顶失败', env);
  }

  if (cmd === '/mute') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能禁言', env);
    const parsed = parseMuteTime(arg);
    if (!parsed) return sendMessage(chatId, '❌ 时间格式错误，支持：`1m` `30m` `1h` `1d` `永久`\n示例：`/mute 1h`（回复目标）', env);
    const body = { chat_id: chatId, user_id: targetId, permissions: allPermissionsObject(false) };
    if (!parsed.forever) body.until_date = Math.floor(Date.now() / 1000) + parsed.seconds;
    const res = await tgApi(env, 'restrictChatMember', body).catch(() => null);
    return res && res.ok ? sendMessage(chatId, `🔇 **${esc(targetName)}** 已被禁言 ${parsed.label}${parsed.forever ? '' : ''}`, env) : sendMessage(chatId, '❌ 禁言失败（目标已是管理员？权限不足？）', env);
  }

  if (cmd === '/unmute') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能解除禁言', env);
    const res = await tgApi(env, 'restrictChatMember', { chat_id: chatId, user_id: targetId, permissions: allPermissionsObject(true) }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, `🔊 **${esc(targetName)}** 已被解除禁言`, env) : sendMessage(chatId, '❌ 解除禁言失败', env);
  }

  if (cmd === '/kick') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能踢出', env);
    const res = await kickUser(chatId, targetId, env);
    return res ? sendMessage(chatId, `👢 **${esc(targetName)}** 已被移出群聊`, env) : sendMessage(chatId, '❌ 踢出失败（权限不足？）', env);
  }

  if (cmd === '/ban') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能封禁', env);
    const res = await tgApi(env, 'banChatMember', { chat_id: chatId, user_id: targetId }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, `🚫 **${esc(targetName)}** 已被封禁（无法再加入）`, env) : sendMessage(chatId, '❌ 封禁失败', env);
  }

  if (cmd === '/unban') {
    if (!botAdmin) return sendMessage(chatId, '❌ bot 需要管理员权限才能解封', env);
    const res = await tgApi(env, 'unbanChatMember', { chat_id: chatId, user_id: targetId }).catch(() => null);
    return res && res.ok ? sendMessage(chatId, `✅ **${esc(targetName)}** 已解除封禁`, env) : sendMessage(chatId, '❌ 解封失败', env);
  }

  if (cmd === '/warn') {
    const warnKey = `warns:${chatId}:${targetId}`;
    const raw = await LOTTERY_KV.get(warnKey);
    let count = raw ? parseInt(raw) : 0;
    count += 1;
    await LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 60 * 60 });
    const reason = (arg || '').trim();
    if (count >= 3) {
      await LOTTERY_KV.delete(warnKey);
      let kicked = false;
      if (botAdmin) kicked = await kickUser(chatId, targetId, env);
      return sendMessage(chatId, `⚠️ **${esc(targetName)}** 警告次数已达 3 次${kicked ? '，已被移出群聊' : ''}！${reason ? `\n原因：${reason}` : ''}`, env);
    }
    return sendMessage(chatId, `⚠️ **${esc(targetName)}** 警告（${count}/3）${reason ? `\n原因：${reason}` : ''}\n满 3 次将自动移出群聊`, env);
  }

  if (cmd === '/unwarn') {
    const warnKey = `warns:${chatId}:${targetId}`;
    const raw = await LOTTERY_KV.get(warnKey);
    if (!raw) return sendMessage(chatId, `ℹ️ **${esc(targetName)}** 当前没有警告记录`, env);
    const count = parseInt(raw) - 1;
    if (count <= 0) await LOTTERY_KV.delete(warnKey);
    else await LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 60 * 60 });
    return sendMessage(chatId, `✅ **${esc(targetName)}** 警告已撤销，当前 ${Math.max(count, 0)}/3`, env);
  }

  if (cmd === '/warns' || cmd === '/warnings') {
    const warnKey = `warns:${chatId}:${targetId}`;
    const raw = await LOTTERY_KV.get(warnKey);
    const count = raw ? parseInt(raw) : 0;
    return sendMessage(chatId, `📋 **${esc(targetName)}** 当前警告：${count}/3`, env);
  }
  return null;
}
async function chatsUserAdmins(chats, userId, env) {
  const out = [];
  await Promise.all((chats || []).map(async (g) => {
    const st = await getChatMemberStatus(g.id, userId, env);
    if (isAdminStatus(st)) out.push(g);
  }));
  return out;
}

async function showModStart(chatId, msgId, env, userId) {
  const groups = await getBotGroups(env);
  if (!groups.length) {
    await showOrEdit(chatId, msgId, '🛡️ **群管理**\n\n❌ bot 尚未加入任何群。\n请先把 bot 拉进群并设为管理员，再在这里管理。', env);
    return;
  }

  // 并发检查，通过 getChat API 准确判断类型，过滤掉频道
  const checks = groups.map(async (g) => {
    try {
      const ci = await tgApi(env, 'getChat', { chat_id: g.id });
      // 只有 type 明确为 channel 才过滤
      if (ci?.ok && ci.result?.type === 'channel') {
        // 从 bot_groups 中移除频道
        const groupsRaw = await LOTTERY_KV.get('bot_groups');
        if (groupsRaw) {
          let groupsList = safeJsonParse(groupsRaw, []);
          if (Array.isArray(groupsList)) {
            const idx = groupsList.findIndex(x => String(x.id) === String(g.id));
            if (idx >= 0) {
              groupsList.splice(idx, 1);
              await LOTTERY_KV.put('bot_groups', JSON.stringify(groupsList));
            }
          }
        }
        return null;
      }
      // 群（group/supergroup）或其他类型保留
      return g;
    } catch {
      // API 调用失败时保留，不删除（避免误删正常群）
      return g;
    }
  });

  const filtered = (await Promise.all(checks)).filter(Boolean);
  const adminGroups = await chatsUserAdmins(filtered, userId, env);
  if (!adminGroups.length) {
    await showOrEdit(chatId, msgId, '🛡️ **群管理**\n\n⛔ 仅群管理员可用。\n你不是 bot 所在任何群的管理员。', env);
    return;
  }

  const kb = [];
  for (const g of adminGroups) {
    kb.push([{ text: `🏘 ${esc(g.title || `群 ${g.id}`)}`, callback_data: `mod_pick:${g.id}` }]);
  }
  kb.push([{ text: '🏠 主菜单', callback_data: 'menu_back' }]);
  await showOrEdit(chatId, msgId, '🛡️ **群管理**\n\n选择要管理的群（仅显示你担任管理员的群）：', env, kb);
}

async function showChannelModStart(chatId, msgId, env, userId) {
  const raw = await LOTTERY_KV.get('bot_channels');
  let channels = safeJsonParse(raw, []);
  if (!Array.isArray(channels)) channels = [];
  if (!channels.length) { await showOrEdit(chatId, msgId, '📢 **频道管理**\n\n❌ bot 尚未加入任何频道。\n请先把 bot 拉进频道并设为管理员。', env); return; }
  const adminCh = await chatsUserAdmins(channels, userId, env);
  if (!adminCh.length) { await showOrEdit(chatId, msgId, '📢 **频道管理**\n\n⛔ 仅频道管理员可用。\n你不是 bot 所在任何频道的管理员。', env); return; }
  const kb = [];
  for (const c of adminCh) kb.push([{ text: `📢 ${esc(c.title || `频道 ${c.id}`)}`, callback_data: `chmod_pick:${c.id}` }]);
  kb.push([{ text: '🏠 主菜单', callback_data: 'menu_back' }]);
  await showOrEdit(chatId, msgId, '📢 **频道管理**\n\n选择要管理的频道（仅显示你担任管理员的频道）：', env, kb);
}

async function showChannelActions(chatId, msgId, env, userId, channelId) {
  const raw = await LOTTERY_KV.get('bot_channels');
  let channels = safeJsonParse(raw, []);
  if (!Array.isArray(channels)) channels = [];
  const c = channels.find(x => x.id === channelId);
  const cname = c?.title || `频道 ${channelId}`;
  const chatInfo = await tgApi(env, 'getChat', { chat_id: channelId });
  if (!chatInfo?.ok || chatInfo.result?.type !== 'channel') { await editMsg(chatId, msgId, `📢 **${esc(cname)}**\n\n❌ 这不是一个频道，请使用 🛡️ 群管理 功能。`, env); return; }
  const admin = await getChatMemberStatus(channelId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, `📢 **${esc(cname)}**\n\n❌ 你不是该频道管理员，无法管理。`, env); return; }
  const kb = [
    [{ text: 'ℹ️ 频道信息', callback_data: `chmod_exec:${channelId}:info` }, { text: '📢 发布公告', callback_data: `chmod_exec:${channelId}:announce` }],
    [{ text: '🛡️ 管理员列表', callback_data: `chmod_exec:${channelId}:admins` }, { text: '⚙️ 自动按钮', callback_data: `chmod_exec:${channelId}:btn` }],
    [{ text: '⬅️ 返回', callback_data: 'chmod_back_list' }, { text: '🏠 主菜单', callback_data: 'menu_back' }],
  ];
  await editMsg(chatId, msgId, `📢 **频道管理** — ${esc(cname)}（\`${channelId}\`）\n\n选择操作：`, env, kb);
}

async function chmodExecAction(chatId, msgId, env, userId, channelId, action) {
  const raw = await LOTTERY_KV.get('bot_channels');
  let channels = safeJsonParse(raw, []);
  if (!Array.isArray(channels)) channels = [];
  const c = channels.find(x => x.id === channelId);
  const cname = c?.title || `频道 ${channelId}`;
  const admin = await getChatMemberStatus(channelId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, `❌ 你不是该频道管理员。`, env); return; }

  if (action === 'info') {
    const [chatInfo, countInfo] = await Promise.all([
      tgApi(env, 'getChat', { chat_id: channelId }),
      tgApi(env, 'getChatMembersCount', { chat_id: channelId }),
    ]);
    if (chatInfo?.ok) {
      const r = chatInfo.result;
      const memberCount = countInfo.ok ? countInfo.result : '?';
      const lines = [
        `📢 **频道信息** — ${esc(cname)}`,
        ``,
        `🆔 ID：\`${channelId}\``,
        `📛 标题：${esc(r.title || '?')}`,
        `📝 描述：${r.description ? esc(r.description.slice(0, 200)) : '（无）'}`,
        `👥 成员数：${memberCount}`,
        `🔗 链接：${r.invite_link ? r.invite_link : '（私有）'}`,
        `📌 类型：${r.type}`,
      ];
      await editMsg(chatId, msgId, lines.join('\n'), env);
    } else {
      await editMsg(chatId, msgId, `❌ 获取频道信息失败。`, env);
    }
    return;
  }

  if (action === 'announce') {
    await LOTTERY_KV.put(`chmod_announce:${userId}`, String(channelId), { expirationTtl: 900 });
    const kb = [[{ text: '❌ 取消', callback_data: 'chmod_cancel_announce' }]];
    await editMsg(chatId, msgId, `📢 **发布公告** — ${esc(cname)}\n\n请直接发送**公告内容**：\n\n💡 公告将发送到该频道。`, env, kb);
    return;
  }

  if (action === 'btn') {
    const btnRaw = await LOTTERY_KV.get(`btn:${channelId}`);
    const hasBtn = !!btnRaw;
    await LOTTERY_KV.put(`chmod_btn:${userId}`, String(channelId), { expirationTtl: 900 });
    const kb = [[{ text: '❌ 取消', callback_data: 'chmod_cancel_announce' }]];
    const formatTip = '⚠️ 请在**当前私聊**发送配置，不要发到频道。\n\n📋 **格式示例**：\n订阅BOT-https://t.me/xxx && 传话筒-https://t.me/yyy\n兑换购买-https://shop.example.com\n\n· 名称和链接用 `-` 分隔\n· 同一行多个按钮用 `&&` 分隔\n· 换行 = 按钮另起一行\n· 发送 `off` 可关闭自动按钮';
    const tip = hasBtn
      ? `⚙️ **自动按钮** — ${esc(cname)}\n\n✅ 当前已配置按钮。\n\n发送**新的按钮配置**可覆盖当前配置。\n\n${formatTip}`
      : `⚙️ **自动按钮** — ${esc(cname)}\n\n管理员在频道发信息后，Bot 将自动发送带按钮的消息。\n\n请发送按钮配置：\n\n${formatTip}`;
    await editMsg(chatId, msgId, tip, env, kb);
    return;
  }

  if (action === 'admins') {
    const admins = await tgApi(env, 'getChatAdministrators', { chat_id: channelId });
    if (admins?.ok && Array.isArray(admins.result)) {
      const lines = [`🛡️ **频道管理员** — ${esc(cname)}\n`];
      for (const a of admins.result) {
        const name = a.user?.first_name || a.user?.username || '?';
        const role = a.status === 'creator' ? '👑 创建者' : '🛡️ 管理员';
        lines.push(`${role}：${esc(name)}${a.user?.username ? ` @${a.user.username}` : ''}`);
      }
      const kb = [[{ text: '⬅️ 返回', callback_data: `chmod_pick:${channelId}` }]];
      await editMsg(chatId, msgId, lines.join('\n'), env, kb);
    } else {
      await editMsg(chatId, msgId, `❌ 获取管理员列表失败。`, env);
    }
    return;
  }
}

async function showModActions(chatId, msgId, env, userId, groupId) {
  const groups = await getBotGroups(env);
  const g = groups.find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await showOrEdit(chatId, msgId, `🛡️ **${esc(gname)}**\n\n❌ 你不是该群管理员，无法管理。`, env); return; }
  const kb = [
    [{ text: '👥 成员管理', callback_data: `modcat:${groupId}:members` }, { text: '🛡️ 防护与验证', callback_data: `modcat:${groupId}:guard` }],
    [{ text: '⚙️ 群设置', callback_data: `modcat:${groupId}:settings` }, { text: 'ℹ️ 信息查询', callback_data: `modcat:${groupId}:info` }],
    [{ text: '⬅️ 返回选群', callback_data: 'mod_back_list' }, { text: '🏠 主菜单', callback_data: 'menu_back' }],
  ];
  await showOrEdit(chatId, msgId, `🛡️ **群管理** — ${esc(gname)}（\`${groupId}\`）\n\n选择分类：`, env, kb);
}

// 群管理分类子菜单：modcat:${groupId}:${cat}
const MOD_CATS = {
  members: { title: '👥 成员管理', rows: [
    [['🔇 禁言', 'mute'], ['🔊 解除禁言', 'unmute']],
    [['👢 踢出', 'kick'], ['🚫 封禁', 'ban'], ['✅ 解封', 'unban']],
    [['⚠️ 警告', 'warn'], ['📋 查警告', 'warns']],
  ]},
  guard: { title: '🛡️ 防护与验证', rows: [
    [['🚫 违禁词', 'banned']],
    [['📢 强制关注频道', 'forcesub'], ['🔍 巡检关注', 'forcesubcheck']],
    [['🧹 清理验证通知', 'notify_clean']],
  ]},
  settings: { title: '⚙️ 群设置', rows: [
    [['📜 设置群规', 'rules'], ['👋 进群欢迎', 'welcome_menu'], ['✏️ 改群名', 'settitle']],
    [['🔒 全员禁言', 'lock'], ['🔓 解除全员禁言', 'unlock']],
  ]},
  info: { title: 'ℹ️ 信息查询', rows: [
    [['🛡️ 管理员列表', 'admins'], ['ℹ️ 群信息', 'info']],
  ]},
};

async function showModCategory(chatId, msgId, env, userId, groupId, cat) {
  const c = MOD_CATS[cat];
  if (!c) return showModActions(chatId, msgId, env, userId, groupId);
  const groups = await getBotGroups(env);
  const g = groups.find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, `🛡️ **${esc(gname)}**\n\n❌ 你不是该群管理员，无法管理。`, env); return; }
  const kb = c.rows.map(r => r.map(([t, a]) => ({ text: t, callback_data: `mod_pick:${groupId}:${a}` })));
  kb.push([{ text: '⬅️ 返回分类', callback_data: `mod_back:${groupId}` }]);
  await editMsg(chatId, msgId, `🛡️ **${c.title}** — ${esc(gname)}（\`${groupId}\`）\n\n选择操作：`, env, kb);
}

async function showForceSubMenu(chatId, msgId, env, userId, groupId) {
  const groups = await getBotGroups(env);
  const g = groups.find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, `🛡️ **${esc(gname)}**\n\n❌ 你不是该群管理员，无法管理。`, env); return; }
  const cfg = await getVerifyCfg(groupId);
  const cur = cfg.forceChannel ? `**${esc(cfg.forceChannel)}** ✅` : '未设置 ❌';
  const kb = [
    [{ text: '✏️ 设置/更换频道', callback_data: `mod_fsub_set:${groupId}` }],
    [{ text: '⛔ 关闭强制关注', callback_data: `mod_fsub_off:${groupId}` }],
    [{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }],
  ];
  await editMsg(chatId, msgId, `📢 **强制关注频道** — ${esc(gname)}\n\n当前：${cur}\n\n机制：新人入群先禁言，答完数学验证题后，还须关注该频道才解除禁言；未关注会收到关注引导，10 分钟内未完成将被移出。`, env, kb);
}

function normalizeChannelInput(a) {
  let ch = String(a || '').replace(/^https?:\/\/t\.me\//i, '').replace(/^@+/, '').trim();
  ch = ch.split(/[?\/]/)[0].trim();
  if (/^-100\d+$/.test(ch)) return ch;
  if (/^[a-zA-Z][a-zA-Z0-9_]{2,}$/.test(ch)) return '@' + ch;
  return null;
}

async function modAct(chatId, msgId, userId, groupId, action, env) {
  const groups = await getBotGroups(env);
  const g = groups.find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  const admin = await getChatMemberStatus(groupId, userId, env);
  if (!isAdminStatus(admin)) { await editMsg(chatId, msgId, `❌ 你不是该群管理员。`, env); return; }
  if (action === 'lock' || action === 'unlock' || action === 'admins' || action === 'info') { await modExecAction(chatId, msgId, env, groupId, action, null, '', ''); return; }
  if (action === 'welcome_menu') { await showWelcomeMenu(chatId, msgId, env, userId, groupId); return; }
  if (action === 'forcesub') { await showForceSubMenu(chatId, msgId, env, userId, groupId); return; }
  if (action === 'forcesubcheck') { await forceSubCheck(groupId, userId, env); return; }
  if (action === 'notify_clean') { await showNotifyCleanMenu(chatId, msgId, env, userId, groupId); return; }
  if (action === 'mute') {
    const kb = [
      [{ text: '10分钟', callback_data: `mod_setmute:${groupId}:10m` }, { text: '30分钟', callback_data: `mod_setmute:${groupId}:30m` }],
      [{ text: '1小时', callback_data: `mod_setmute:${groupId}:1h` }, { text: '1天', callback_data: `mod_setmute:${groupId}:1d` }],
      [{ text: '永久', callback_data: `mod_setmute:${groupId}:forever` }],
      [{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }],
    ];
    await editMsg(chatId, msgId, `🔇 **禁言** — ${esc(gname)}\n\n请选择禁言时长：`, env, kb);
    return;
  }
  if (action === 'unban') {
    const log = await getBannedLog(groupId);
    const show = log.slice(0, 20);
    const kb = [];
    for (const u of show) kb.push([{ text: `${u.type === 'mute' ? '🔊 解除禁言' : '🔓 解封'} ${esc(u.name)}`, callback_data: `mod_unban:${groupId}:${u.id}` }]);
    kb.push([{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]);
    const listPart = log.length
      ? `📋 **名单**（共 ${log.length} 个）：\n${show.map((u, i) => `${i + 1}. ${u.type === 'mute' ? '🔒' : '🚫'} ${esc(u.name)}`).join('\n')}\n\n✅ 点击下方按钮直接解除，`
      : `📋 **暂无记录**\n（用 bot 封禁/自动禁言的成员会自动记录）\n\n`;
    await editMsg(chatId, msgId, `🚫 **解除封禁/禁言** — ${esc(gname)}\n\n${listPart}或转发消息 / 输入用户 ID：\n\n📌 **说明**：\n🔒 **禁言** = 还在群里，只是不能发言 → 解除后无需重新加入\n🚫 **封禁** = 已被移出群 → 解封后对方需在群里点「加入群组」重新入群`, env, kb);
    return;
  }
  const needTarget = ['unmute', 'kick', 'ban', 'unban', 'unwarn', 'warns'];
  if (needTarget.includes(action)) {
    await LOTTERY_KV.put(`mod_draft:${userId}`, JSON.stringify({ groupId, action, step: 'target', groupName: gname }), { expirationTtl: 900 });
    const kb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]];
    await editMsg(chatId, msgId, `🛡️ **${modActionLabel(action)}** — ${esc(gname)}\n\n请**转发**目标用户在群里的任意一条消息给我，\n或直接发送该用户的 **ID 数字**：`, env, kb);
    return;
  }
  if (action === 'warn') {
    await LOTTERY_KV.put(`mod_draft:${userId}`, JSON.stringify({ groupId, action, step: 'target', groupName: gname }), { expirationTtl: 900 });
    const kb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]];
    await editMsg(chatId, msgId, `⚠️ **警告** — ${esc(gname)}\n\n请转发目标用户的消息或发送其用户 ID（可选：一起发送原因，如 \`12345 广告刷屏\`）：`, env, kb);
    return;
  }
  const needText = ['rules', 'welcome', 'settitle'];
  if (needText.includes(action)) {
    await LOTTERY_KV.put(`mod_draft:${userId}`, JSON.stringify({ groupId, action, step: 'text', groupName: gname }), { expirationTtl: 900 });
    const kb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]];
    const prompt = {
      rules: `📜 **设置群规** — ${esc(gname)}\n\n请直接发送群规内容（≤2000字）：`,
      welcome: `👋 **设置欢迎语** — ${esc(gname)}\n\n请直接发送欢迎语内容（≤500字）；\n\`{name}\` 会自动替换为新成员名；\n发送 \`off\` 可关闭欢迎语：`,
      settitle: `✏️ **修改群名** — ${esc(gname)}\n\n请直接发送新群名（≤128字）：`,
    }[action];
    await editMsg(chatId, msgId, prompt, env, kb);
    return;
  }
  await showModActions(chatId, msgId, env, userId, groupId);
}

function modActionLabel(action) {
  return { mute: '禁言', unmute: '解除禁言', kick: '踢出', ban: '封禁', unban: '解封', warn: '警告', unwarn: '撤销警告', warns: '查看警告', rules: '设置群规', welcome: '设置欢迎语', settitle: '修改群名' }[action] || action;
}

async function modAwaitTarget(chatId, msgId, userId, groupId, action, arg, env) {
  const groups = await getBotGroups(env);
  const g = groups.find(x => x.id === groupId);
  const gname = g?.title || `群 ${groupId}`;
  await LOTTERY_KV.put(`mod_draft:${userId}`, JSON.stringify({ groupId, action: 'mute', step: 'target', arg, groupName: gname }), { expirationTtl: 900 });
  const kb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${groupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]];
  await editMsg(chatId, msgId, `🔇 **禁言**（${arg}）— ${esc(gname)}\n\n请**转发**目标用户在群里的任意一条消息给我，\n或直接发送该用户的 **ID 数字**：`, env, kb);
}

async function handleModDraft(chatId, userId, msg, env) {
  if (chatId < 0) return false;
  const raw = await LOTTERY_KV.get(`mod_draft:${userId}`);
  if (!raw) return false;
  const draft = safeJsonParse(raw, {});
  const { groupId, action, step, arg, groupName } = draft;
  const text = (msg.text || '').trim();

  if (step === 'target') {
    let targetId = null;
    let targetName = '';
    let warnReason = arg || '';
    const fo = msg.forward_origin || null;
    if (fo && fo.type === 'user' && fo.sender_user) {
      targetId = fo.sender_user.id;
      targetName = fo.sender_user.username ? `@${fo.sender_user.username}` : (fo.sender_user.first_name || `用户${targetId}`);
    } else if (msg.forward_from) {
      targetId = msg.forward_from.id;
      targetName = msg.forward_from.username ? `@${msg.forward_from.username}` : (msg.forward_from.first_name || `用户${targetId}`);
    } else {
      const m = text.match(/^(\d+)(?:\s+(.*))?$/);
      if (!m) { await sendMessage(chatId, '❌ 无法识别目标用户。请**转发**该用户在群里的消息给我，或发送纯数字**用户 ID**。', env); return true; }
      targetId = parseInt(m[1]);
      targetName = `用户${targetId}`;
      if (m[2]) warnReason = m[2].trim();
    }
    if (!targetId) { await sendMessage(chatId, '❌ 无法识别目标用户（仅支持转发**个人用户**的消息）。', env); return true; }
    await LOTTERY_KV.delete(`mod_draft:${userId}`);
    await modExecAction(chatId, null, env, groupId, action, targetId, targetName, warnReason);
    return true;
  }

  if (step === 'text') {
    if (!text) { await sendMessage(chatId, '❌ 内容不能为空。', env); return true; }
    await LOTTERY_KV.delete(`mod_draft:${userId}`);
    await modExecAction(chatId, null, env, groupId, action, null, '', text);
    return true;
  }
  return false;
}

async function modExecAction(chatId, msgId, env, groupId, action, targetId, targetName, arg) {
  const sendOut = async (text) => {
    if (msgId) await editMsg(chatId, msgId, text, env).catch(() => sendMessage(chatId, text, env));
    else await sendMessage(chatId, text, env);
  };
  const botAdmin = await isBotAdmin(groupId, env);
  const needBot = ['lock', 'unlock', 'settitle', 'mute', 'unmute', 'kick', 'ban', 'unban', 'del', 'pin'];
  if (needBot.includes(action) && !botAdmin) return sendOut('❌ bot 需要**群管理员**权限才能执行该操作。\n请在群里把 bot 设为管理员后重试。');

  if (action === 'forcesub') {
    const normalized = normalizeChannelInput(arg);
    if (!normalized) return sendOut('❌ 频道格式无效。\n公开频道：`@mychannel` 或 `https://t.me/mychannel`\n私有频道：bot 先入频道当管理员，再发 -100 开头数字 ID。');
    const selfBotId = parseInt((process.env.BOT_TOKEN || '').split(':')[0]);
    const probe = await checkChannelMembership(normalized, selfBotId, env);
    const cfg = await getVerifyCfg(groupId);
    cfg.forceChannel = normalized;
    await LOTTERY_KV.put(`verify_cfg:${groupId}`, JSON.stringify(cfg));
    const warn = probe ? '' : '\n\n⚠️ bot 暂时无法访问该频道：公开频道请核对用户名；私有频道必须先把 bot 拉进频道并设为管理员，否则新人将无法通过验证。';
    return sendOut(`✅ 已设置强制关注频道：**${esc(normalized)}**\n\n新人答完入群验证题后还须关注该频道才解除禁言。${warn}`);
  }

  if (action === 'admins') {
    try {
      const res = await tgApi(env, 'getChatAdministrators', { chat_id: groupId });
      if (!res.ok) return sendOut('❌ 获取管理员列表失败');
      const lines = res.result.map((a, i) => {
        const u = a.user;
        const name = u.username ? `@${u.username}` : (u.first_name || `用户${u.id}`);
        const role = a.status === 'creator' ? '👑 群主' : '🛡️ 管理员';
        return `${i + 1}. ${role} ${esc(name)}`;
      });
      return sendOut(`🛡️ **管理员列表**（${lines.length}）\n\n${lines.join('\n')}`);
    } catch { return sendOut('❌ 获取管理员列表失败'); }
  }

  if (action === 'info') {
    try {
      const [chatRes, memRes, admRes] = await Promise.all([
        tgApi(env, 'getChat', { chat_id: groupId }),
        tgApi(env, 'getChatMemberCount', { chat_id: groupId }),
        tgApi(env, 'getChatAdministrators', { chat_id: groupId }),
      ]);
      const title = chatRes.ok ? (chatRes.result.title || groupName || groupId) : (groupName || groupId);
      const members = memRes.ok ? memRes.result : '?';
      const admins = admRes.ok ? admRes.result.length : '?';
      return sendOut(`ℹ️ **群信息**\n\n📢 群名：${esc(title)}\n👥 成员：${members}\n🛡️ 管理员：${admins}\n🆔 ID：\`${groupId}\`\n🤖 bot 管理员权限：${botAdmin ? '✅ 有' : '❌ 无（部分功能不可用）'}`);
    } catch { return sendOut('❌ 获取群信息失败'); }
  }

  if (action === 'settitle') {
    const title = (arg || '').trim();
    if (!title || title.length > 128) return sendOut('❌ 群标题为空或超过128字');
    const res = await tgApi(env, 'setChatTitle', { chat_id: groupId, title });
    return res.ok ? sendOut(`✅ 群标题已改为：**${esc(title)}**`) : sendOut('❌ 修改失败（权限不足？）');
  }

  if (action === 'welcome') {
    const cfg = await getGroupCfg(groupId, env);
    const a = (arg || '').trim();
    if (a.toLowerCase() === 'off' || a === '关') { cfg.welcome = ''; await LOTTERY_KV.put(`group_cfg:${groupId}`, JSON.stringify(cfg)); return sendOut('🚫 欢迎语已关闭'); }
    if (a.length > 500) return sendOut('❌ 欢迎语过长（≤500字）');
    cfg.welcome = a;
    await LOTTERY_KV.put(`group_cfg:${groupId}`, JSON.stringify(cfg));
    return sendOut(`✅ 欢迎语已设置：\n\n${a}\n\n新成员加入时会自动发送（\`{name}\` 自动替换为成员名）。`);
  }

  if (action === 'rules') {
    const cfg = await getGroupCfg(groupId, env);
    const a = (arg || '').trim();
    if (a.length > 2000) return sendOut('❌ 群规过长（≤2000字）');
    cfg.rules = a;
    await LOTTERY_KV.put(`group_cfg:${groupId}`, JSON.stringify(cfg));
    return sendOut(`✅ 群规已设置：\n\n${a}`);
  }

  if (action === 'lock' || action === 'unlock') {
    const lock = action === 'lock';
    const res = await tgApi(env, 'setChatPermissions', { chat_id: groupId, permissions: allPermissionsObject(!lock) });
    if (!res.ok) return sendOut('❌ 设置失败（权限不足？）');
    const cfg = await getGroupCfg(groupId, env);
    cfg.lock = lock;
    await LOTTERY_KV.put(`group_cfg:${groupId}`, JSON.stringify(cfg));
    return sendOut(lock ? '🔒 全员禁言已开启（除管理员外禁止发言）' : '🔓 全员禁言已解除');
  }

  if (!targetId) return sendOut('❌ 缺少目标用户');

  if (action === 'mute') {
    const parsed = parseMuteTime(arg);
    if (!parsed) return sendOut('❌ 禁言时长格式错误');
    const body = { chat_id: groupId, user_id: targetId, permissions: allPermissionsObject(false) };
    if (!parsed.forever) body.until_date = Math.floor(Date.now() / 1000) + parsed.seconds;
    const res = await tgApi(env, 'restrictChatMember', body).catch(() => null);
    return res && res.ok ? sendOut(`🔇 **${esc(targetName)}** 已被禁言 ${parsed.label}`) : sendOut('❌ 禁言失败（目标已是管理员/权限不足？）');
  }

  if (action === 'unmute') {
    const res = await tgApi(env, 'restrictChatMember', { chat_id: groupId, user_id: targetId, permissions: allPermissionsObject(true) }).catch(() => null);
    return res && res.ok ? sendOut(`🔊 **${esc(targetName)}** 已被解除禁言`) : sendOut('❌ 解除禁言失败');
  }

  if (action === 'kick') {
    const res = await kickUser(groupId, targetId, env);
    return res ? sendOut(`👢 **${esc(targetName)}** 已被移出群聊`) : sendOut('❌ 踢出失败（权限不足？）');
  }

  if (action === 'ban') {
    const res = await tgApi(env, 'banChatMember', { chat_id: groupId, user_id: targetId }).catch(() => null);
    if (res && res.ok) {
      await addBannedLog(groupId, targetId, targetName || `用户${targetId}`);
      return sendOut(`🚫 **${esc(targetName)}** 已被封禁（无法再加入）`);
    }
    return sendOut('❌ 封禁失败');
  }

  if (action === 'unban') {
    const res = await tgApi(env, 'unbanChatMember', { chat_id: groupId, user_id: targetId }).catch(() => null);
    if (res && res.ok) {
      await removeBannedLog(groupId, targetId);
      return sendOut(`✅ **${esc(targetName)}** 已解除封禁\n\n📌 对方已被移出群，需在群里点击「加入群组」重新入群（若开启入群验证，会触发验证）。`);
    }
    return sendOut('❌ 解封失败');
  }

  if (action === 'warn') {
    const warnKey = `warns:${groupId}:${targetId}`;
    const raw = await LOTTERY_KV.get(warnKey);
    let count = raw ? parseInt(raw) : 0;
    count += 1;
    await LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 60 * 60 });
    const reason = (arg || '').trim();
    if (count >= 3) {
      await LOTTERY_KV.delete(warnKey);
      let kicked = false;
      if (botAdmin) kicked = await kickUser(groupId, targetId, env);
      return sendOut(`⚠️ **${esc(targetName)}** 警告次数已达 3 次${kicked ? '，已被移出群聊' : ''}！${reason ? `\n原因：${reason}` : ''}`);
    }
    return sendOut(`⚠️ **${esc(targetName)}** 警告（${count}/3）${reason ? `\n原因：${reason}` : ''}\n满 3 次将自动移出群聊`);
  }

  if (action === 'unwarn') {
    const warnKey = `warns:${groupId}:${targetId}`;
    const raw = await LOTTERY_KV.get(warnKey);
    if (!raw) return sendOut(`ℹ️ **${esc(targetName)}** 当前没有警告记录`);
    const count = parseInt(raw) - 1;
    if (count <= 0) await LOTTERY_KV.delete(warnKey);
    else await LOTTERY_KV.put(warnKey, String(count), { expirationTtl: 30 * 24 * 60 * 60 });
    return sendOut(`✅ **${esc(targetName)}** 警告已撤销，当前 ${Math.max(count, 0)}/3`);
  }

  if (action === 'warns') {
    const warnKey = `warns:${groupId}:${targetId}`;
    const raw = await LOTTERY_KV.get(warnKey);
    const count = raw ? parseInt(raw) : 0;
    return sendOut(`📋 **${esc(targetName)}** 当前警告：${count}/3`);
  }
  return sendOut('❌ 未知操作');
}

async function startWizard(chatId, userId, username, chatTitle, env) {
  if (chatId < 0) return sendMessage(chatId, 'ℹ️ @抽奖机器人：创建抽奖请在私聊中发送 /create。', env);
  const wizard = { userId, step: 1, data: { name: '', prize: '', prizes: [], winnerCount: 1, keyword: '', triggerType: '', triggerValue: null, channel: '', groupId: null, groupName: '', useCodes: false, codes: [] } };
  await LOTTERY_KV.put(`wizard:${userId}`, JSON.stringify(wizard), { expirationTtl: 3600 });
  const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];
  return sendMsgKb(chatId, `🎯 **抽奖创建向导**（第1步/共10步）\n\n📝 请输入**抽奖活动名称**：`, kb, env);
}

async function showWizardGroupPicker(chatId, userId, wizard, confirmText, env) {
  const wizardKey = `wizard:${userId}`;
  wizard.step = 7;
  await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
  const groups = await getBotGroups(env);
  if (groups.length === 0) return sendMsgKb(chatId, `⚠️ **还未找到可发布群**\n\n请先把机器人**加入目标群组**（并设为管理员），然后发送 \`/groups\` 刷新，或直接输入群 ID（如 \`-1001234567890\`）。`, [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]], env);
  const cfg = await getUserCfg(userId, env);
  if (cfg.defaultGroupId) {
    const idx = groups.findIndex(g => g.id === cfg.defaultGroupId);
    if (idx > 0) { const [def] = groups.splice(idx, 1); groups.unshift(def); }
  }
  const groupKb = groups.slice(0, 12).map(g => [{ text: `${cfg.defaultGroupId === g.id ? '⭐ ' : ''}📢 ${esc(g.title || g.id)}`, callback_data: `select_group:${g.id}` }]);
  groupKb.push([{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]);
  return sendMsgKb(chatId, `✅ ${confirmText}\n\n📢 第7步：请选择**公告发布群**（公告发到该群，参与也在此群）：`, groupKb, env);
}

async function showCodeToggle(chatId, userId, wizard, env) {
  const wizardKey = `wizard:${userId}`;
  wizard.step = 9;
  await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
  const kb = [
    [{ text: '✅ 是，填写兑换码', callback_data: 'code_mode:yes' }, { text: '🚫 否，不需要', callback_data: 'code_mode:no' }],
    [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
  ];
  return sendMsgKb(chatId, `✅ 频道：${wizard.data.channel ? `\`${esc(wizard.data.channel)}\`` : '未设置（只发群）'}\n\n🎟️ 第9步：中奖后是否**直接通过 bot 发送兑换码**给中奖者？\n\n💡 选择「是」后，下一步请粘贴兑换码列表（每行一个），开奖时会按中奖名单逐个私信发放。`, kb, env);
}

async function handleWizardStep(chatId, userId, text, env) {
  const wizardKey = `wizard:${userId}`;
  const raw = await LOTTERY_KV.get(wizardKey);
  if (!raw) return;
  const wizard = safeJsonParse(raw, {});
  if (wizard.step < 1 || wizard.step > 10) return;
  const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];

  switch (wizard.step) {
    case 1:
      wizard.data.name = text;
      wizard.step = 2;
      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      return sendMsgKb(chatId, `✅ 活动名称：**${esc(text)}**\n\n🎁 第2步：请输入**奖品名称**：`, kb, env);
    case 2: {
      const first = (wizard.data.prizes || []).length === 0;
      wizard.data.prizes = wizard.data.prizes || [];
      wizard.data.prizes.push(text.trim());
      wizard.data.prize = wizard.data.prizes.join('、');
      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      const prizeKb = [
        [{ text: '➕ 继续添加', callback_data: 'prize_add' }, { text: '⏭️ 结束添加', callback_data: 'prize_done' }],
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ];
      const listText = wizard.data.prizes.map((p, i) => `  ${i + 1}. ${esc(p)}`).join('\n');
      return sendMsgKb(chatId, `✅ 已添加奖品${first ? '' : '（追加）'}：\n${listText}\n\n🎁 请回复**下一个奖品名称**继续添加，或点击按钮结束：\n\n💡 多个奖品将按中奖顺序一一对应发放。`, prizeKb, env);
    }
    case 3: {
      let wc = parseInt(text);
      if (isNaN(wc) || wc < 1 || wc > 100) return sendMsgKb(chatId, '❌ 请输入1~100之间的数字', kb, env);
      wizard.data.winnerCount = wc;
      wizard.step = 4;
      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      return sendMsgKb(chatId, `✅ 中奖名额：**${wc} 人**\n\n🔑 第4步：请输入**参与口令**\n参与者在群内发送此口令即可参与：`, kb, env);
    }
    case 4:
      if (!text.trim()) return sendMsgKb(chatId, '❌ 口令不能为空', kb, env);
      wizard.data.keyword = text.trim();
      wizard.step = 5;
      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      const triggerKb = [
        [{ text: '⏰ 定时开奖', callback_data: 'trigger_type:time' }, { text: '👥 人数开奖', callback_data: 'trigger_type:count' }],
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ];
      return sendMsgKb(chatId, `✅ 口令：\`${esc(wizard.data.keyword)}\`\n\n⏰ 第5步：请选择**开奖方式**：`, triggerKb, env);
    case 6:
      if (wizard.data.triggerType === 'time') {
        let targetTime = parseRelativeTime(text);
        if (targetTime === null) {
          const timeMatch = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
          if (!timeMatch) return sendMsgKb(chatId, '❌ 时间格式错误，请输入：\n`10分钟后` / `1小时后` / `1天后` / `1周后`\n或具体时间：`2026-08-25 20:00`', kb, env);
          const [, y, m, d, h, min] = timeMatch;
          targetTime = parseLocalTime(y, m, d, h, min);
        }
        if (targetTime <= Date.now()) return sendMsgKb(chatId, '❌ 开奖时间必须在当前时间之后', kb, env);
        wizard.data.triggerValue = targetTime;
      } else {
        const count = parseInt(text);
        if (isNaN(count) || count < 2 || count > 1000) return sendMsgKb(chatId, '❌ 请输入2~1000之间的数字', kb, env);
        wizard.data.triggerValue = count;
      }
      const confirmText = wizard.data.triggerType === 'time' ? `开奖时间：\`${fmtDate(wizard.data.triggerValue)}\`` : `人数上限：\`${wizard.data.triggerValue}\``;
      return showWizardGroupPicker(chatId, userId, wizard, confirmText, env);
    case 7: {
      const rawGroup = text.trim();
      let groupId = null;
      let groupName = '';
      if (/^-?\d+$/.test(rawGroup)) groupId = parseInt(rawGroup);
      else {
        const m = rawGroup.match(/t\.me\/([A-Za-z0-9_]+)/) || rawGroup.match(/^@?([A-Za-z0-9_]{3,})$/);
        if (m) {
          try {
            const res = await tgApi(env, 'getChat', { chat_id: `@${m[1]}` });
            if (res.ok) { groupId = res.result.id; groupName = res.result.title || m[1]; }
          } catch {}
        }
        if (!groupId) return sendMsgKb(chatId, '❌ 无法解析该群，请直接输入群 ID（如 `-1001234567890`），或在第7步按钮中选择。', kb, env);
      }
      if (!groupId) return sendMsgKb(chatId, '❌ 请输入有效的群 ID，或从按钮中选择。', kb, env);
      wizard.data.groupId = groupId;
      wizard.data.groupName = groupName;
      wizard.step = 8;
      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      const channelKb = [
        [{ text: '⏭️ 跳过（不发布到频道）', callback_data: 'skip_channel' }],
        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],
      ];
      return sendMsgKb(chatId, `✅ 发布群：\`${groupId}\`${groupName ? `（${esc(groupName)}）` : ''}\n\n📢 第8步（可选）：请输入**频道**链接或用户名\n例如：\`@mychannel\`\n公告会同时发布到该频道（并可设为强制加频道）\n（点击跳过则只发布到群）`, channelKb, env);
    }
    case 8: {
      let channelInput = text.trim();
      if (!channelInput) return sendMsgKb(chatId, '❌ 频道不能为空，或点「跳过」不发布到频道', kb, env);
      channelInput = channelInput.replace(/^https?:\/\/t\.me\//i, '');
      if (channelInput && !channelInput.startsWith('@')) channelInput = '@' + channelInput;
      wizard.data.channel = channelInput;
      wizard.step = 9;
      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      return showCodeToggle(chatId, userId, wizard, env);
    }
    case 10: {
      const codeLines = text.split('\n').map(s => s.replace(/[｜|,，、]/g, '\n').split('\n')).flat().map(s => s.trim()).filter(Boolean);
      if (codeLines.length === 0) return sendMsgKb(chatId, '❌ 请输入至少一个兑换码（每行一个）：', kb, env);
      wizard.data.useCodes = true;
      wizard.data.codes = codeLines;
      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });
      if (codeLines.length < wizard.data.winnerCount) await sendMessage(chatId, `⚠️ 兑换码数量（${codeLines.length}）少于中奖名额（${wizard.data.winnerCount}）\n开奖时未配发到码的中奖者将提示联系管理员。`, env);
      await finishWizard(chatId, null, userId, wizard, env);
      return;
    }
    default: return;
  }
}

async function handleCallbackQuery(cb, env) {

  const data = cb.data || '';

  const chatId = cb.message.chat.id;

  const userId = cb.from.id;

  const msgId = cb.message.message_id;

  const [action, ...params] = data.split(':');

  const param = params.join(':');

  const ctx = { cb, env, chatId, userId, msgId, data, action, param };

  for (const h of [cbMallBuy, cbMallRm, cbMallRefresh, cbMallAdd, cbMallAddType, cbMallAddCancel, cbGSet, cbFbConfirm, cbFball, cbFbPage, cbUnbind, cbFbNote, cbFbSet]) {

    if (await h(ctx)) return;

  }

  return cbDispatch(ctx);

}



async function cbMallBuy(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('mallbuy|')) return false;

    const itemId = parseInt(data.slice(8), 10);

    const items = await getMall();

    const it = items.find(x => x.id === itemId);

    if (!it) { await answerCb(cb.id, '商品不存在'); return true; }

    const k = `points:${userId}`;

    const my = parseInt(await LOTTERY_KV.get(k) || '0', 10);

    if (my < it.price) { await answerCb(cb.id, `积分不足（需${it.price}，你有${my}）`); return true; }

    let okMsg = '';

    if (it.type === 'draws') {

      lucky.ensureUser(userId, cb.from.username || cb.from.first_name || '');

      const r = lucky.adminGrantDraws(userId, it.value);

      if (!r || r.ok === false) { await answerCb(cb.id, '发放失败'); return true; }

      okMsg = fmtEffect(it.type, it.value) + ' 已到账抽奖次数';

    } else if (it.type === 'traffic' || it.type === 'days') {

      const mmwxName = await lucky.getMmwxBind(userId);

      if (!mmwxName) { await answerCb(cb.id, '请先 /bindmmwx 绑定mmwx账号'); return true; }

      const gr = await grantToMmwx(mmwxName, { type: it.type, gb: it.type === 'traffic' ? (it.value || 0) : 0, days: it.type === 'days' ? (it.value || 0) : 0 });

      if (!gr.ok) { await answerCb(cb.id, '发放失败:' + gr.error); return true; }

      okMsg = gr.message || fmtEffect(it.type, it.value);

    } else { okMsg = '兑换成功，请联系管理员领取。'; }

    await LOTTERY_KV.put(k, String(my - it.price));

    await answerCb(cb.id, '兑换成功');

    sendMessage(chatId, `✅ 兑换成功！${okMsg}\n消耗 ${it.price} 积分，余额 ${my - it.price} 分。`, env).catch(() => null);

    mallCmd(chatId, userId, env).catch(() => null);

    return true;

  return true;

}



async function cbMallRm(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('mallrm|')) return false;

    if (!(await isFbAdmin(chatId, userId, env))) { await answerCb(cb.id, '⛔ 无权限'); return true; }

    const itemId = parseInt(data.slice(7), 10);

    const items = await getMall();

    const idx = items.findIndex(x => x.id === itemId);

    if (idx < 0) { await answerCb(cb.id, '商品不存在'); return true; }

    items.splice(idx, 1);

    await LOTTERY_KV.put('mall_list', JSON.stringify(items));

    await answerCb(cb.id, '已下架');

    await mallCmd(chatId, userId, env).catch(() => null);

    return true;

  return true;

}



async function cbMallRefresh(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (data !== 'mallrefresh') return false;

    await answerCb(cb.id);

    await mallCmd(chatId, userId, env).catch(() => null);

    return true;

  return true;

}



async function cbMallAdd(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (data !== 'malladd') return false;

    if (!(await isFbAdmin(chatId, userId, env))) { await answerCb(cb.id, '⛔ 无权限'); return true; }

    await answerCb(cb.id);

    const kb = [

      [{ text: '🛢 加流量(G)', callback_data: 'malladdtype|traffic' }],

      [{ text: '⏱ 加时长(天)', callback_data: 'malladdtype|days' }],

      [{ text: '🎲 抽奖次数', callback_data: 'malladdtype|draws' }],

      [{ text: '❌ 取消', callback_data: 'malladdcancel' }],

    ];

    await editMsg(chatId, msgId, '➕ 上架商品\n\n先选择效果类型：', env, kb);

    return true;

  return true;

}



async function cbMallAddType(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('malladdtype|')) return false;

    if (!(await isFbAdmin(chatId, userId, env))) { await answerCb(cb.id, '⛔ 无权限'); return true; }

    const type = data.slice(12);

    if (!['traffic', 'days', 'draws'].includes(type)) { await answerCb(cb.id, '无效类型'); return true; }

    await LOTTERY_KV.put(`mall_add_type:${userId}`, type, { expirationTtl: 900 });

    await answerCb(cb.id);

    const tips = { traffic: '加流量', days: '加时长', draws: '抽奖次数' }[type];

    await editMsg(chatId, msgId, `✅ 已选择【${tips}】\n\n请直接发送：价格 名称 数值\n例如：100 5G流量 5（= ${tips} +5，售价 100 分）`, env, [[{ text: '❌ 取消', callback_data: 'malladdcancel' }]]);

    return true;

  return true;

}



async function cbMallAddCancel(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (data !== 'malladdcancel') return false;

    await LOTTERY_KV.delete(`mall_add_type:${userId}`);

    await answerCb(cb.id, '已取消');

    await mallCmd(chatId, userId, env).catch(() => null);

    return true;

  return true;

}



async function cbGSet(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('gset|') && data !== 'gsetdone') return false;

    const stAdm = await getChatMemberStatus(chatId, userId, env);

    if (!isAdminStatus(stAdm)) { await answerCb(cb.id, '⛔ 仅群管理员可操作'); return true; }

    if (data === 'gsetdone') {

      await answerCb(cb.id, '已保存');

      try { await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: msgId }); } catch (e) {}

      return true;

    }

    const gkey = data.slice(5);

    if (!GRP_FEATURES.some(f => f[0] === gkey)) { await answerCb(cb.id); return true; }

    const rawGS = await LOTTERY_KV.get(`grp_settings:${chatId}`);

    let gs = {};

    try { gs = rawGS ? JSON.parse(rawGS) : {}; } catch (e) {}

    gs[gkey] = gs[gkey] === false;

    await LOTTERY_KV.put(`grp_settings:${chatId}`, JSON.stringify(gs));

    await answerCb(cb.id, gs[gkey] === false ? '已开启' : '已关闭');

    await grpSettingsRender(chatId, msgId, env).catch(() => null);

    return true;

  return true;

}



async function cbFbConfirm(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('fbconfirm|')) return false;

    const parts = data.split('|');

    const fid = parseInt(parts[1], 10);

    const yes = parts[2] === 'yes';

    const rawF = await LOTTERY_KV.get(`fb:${fid}`);

    if (!rawF) { await answerCb(cb.id, '反馈不存在'); return true; }

    const t = safeJsonParse(rawF, {});

    if (t.from.id !== userId) { await answerCb(cb.id, '仅反馈提交人可以确认'); return true; }

    if (yes) {

      if (t.rewarded) { await answerCb(cb.id, '奖励已发放过啦'); return true; }

      lucky.ensureUser(userId, t.from?.name || '');

      const r = lucky.adminGrantDraws(userId, 1);

      if (!r || r.ok === false) { await answerCb(cb.id, '奖励发放失败,请稍后再试'); return true; }

      t.rewarded = true;

      await LOTTERY_KV.put(`fb:${fid}`, JSON.stringify(t));

      try { await tgApi(env, 'deleteMessage', { chat_id: chatId, message_id: msgId }); } catch (e) {}

      await sendMessage(chatId, `✅ ${mdSafe(t.from.name)} 已领取`, env);

      await answerCb(cb.id, '奖励已发放');

    } else {

      t.status = 'open';

      delete t.confirmSent;

      await LOTTERY_KV.put(`fb:${fid}`, JSON.stringify(t));

      await editMsg(chatId, msgId, `🔄 反馈 *#${fid}* 已重新打开，管理员会继续处理。`, env);

      await answerCb(cb.id, '已重新打开');

      for (const aid of fbAdminIds()) {

        await sendMessage(aid, `🔄 反馈 *#${fid}* 被提交人标记为未解决，请继续跟进。\n提交人:${mdSafe(t.from.name)}`, env).catch(() => null);

      }

    }

    return true;

  return true;

}



async function cbFball(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (data !== 'fball') return false;

    if (!(await isFbAdmin(chatId, userId, env))) { await answerCb(cb.id, '⛔ 无权限'); return true; }

    await answerCb(cb.id);

    await fbRenderAll(chatId, null, env, { admin: true }).catch(() => null);

    return true;

  return true;

}



async function cbFbPage(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('fbpage|')) return false;

    const parts = data.split('|');

    const pg = parseInt(parts[1], 10) || 1;

    let adm = false;

    if (parts[2] === '1') adm = await isFbAdmin(chatId, userId, env);

    await answerCb(cb.id);

    await fbRenderAll(chatId, msgId, env, { admin: adm, page: pg }).catch(() => null);

    return true;

  return true;

}



async function cbUnbind(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('unmmwx|') && !data.startsWith('unbind|')) return false;

  const isMmwx = data.startsWith('unmmwx|');

    const tg = data.slice(isMmwx ? 'unmmwx|'.length : 'unbind|'.length);

    if (isMmwx) {
      const mname = await LOTTERY_KV.get(`mmwx_bind:${tg}`);
      if (!mname) { await answerCb(cb.id, '该 mmwx 绑定已不存在'); return true; }
      await LOTTERY_KV.delete(`mmwx_bind:${tg}`);
      await answerCb(cb.id, '已解绑 mmwx ' + mname);
      await sendMessage(parseInt(tg, 10), '⚠️ 管理员已解除你的 mmwx 绑定（' + mname + '）。\n如需继续兑换/领奖，请重新 /bindmmwx 绑定。', env).catch(() => null);
      await bindingsCmd(chatId, msgId, env).catch(() => null);
      return true;
    }

    if (!(await isFbAdmin(chatId, userId, env))) { await answerCb(cb.id, '⛔ 无权限'); return true; }

    const uname = await LOTTERY_KV.get(`lucky_bind:${tg}`);

    if (!uname) { await answerCb(cb.id, '该绑定已不存在'); return true; }

    await LOTTERY_KV.delete(`lucky_bind:${tg}`);

    await LOTTERY_KV.delete(`lucky_bind_rev:${uname}`);

    await answerCb(cb.id, '已解绑 ' + uname);

    await sendMessage(parseInt(tg, 10), '⚠️ 管理员已解除你的抽奖中心绑定（' + uname + '）。\n如需继续签到/抽奖，请重新 /bindlucky 绑定。', env).catch(() => null);

    await bindingsCmd(chatId, msgId, env).catch(() => null);

    return true;

  return true;

}



async function cbFbNote(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('fbnote|')) return false;

    const parts = data.split('|');

    const fid = parseInt(parts[1], 10);

    const st = parts[2] === 'doing' ? 'doing' : (parts[2] === 'done' ? 'done' : 'open');

    if (!(await isFbAdmin(chatId, userId, env))) { await answerCb(cb.id, '⛔ 无权限'); return true; }

    const raw = await LOTTERY_KV.get(`fb:${fid}`);

    if (!raw) { await answerCb(cb.id, '反馈不存在'); return true; }

    const t = safeJsonParse(raw, {});

    const wasDone = t.status === 'done';

    t.status = st;

    await LOTTERY_KV.put(`fb:${fid}`, JSON.stringify(t));

    if (st === 'done' && !wasDone) await fbNotifyResolved(t, env).catch(() => null);

    await answerCb(cb.id, `#${fid} → ${FB_STATUS[st] || st}`);

    const ntype = t.type === 'bug' ? '🐞 新 BUG' : '💡 新建议';

    const ntext = `🔔 ${ntype} *#${fid}* ${FB_STATUS[t.status] || ''}\n来自:${mdSafe(t.from.name)}${t.from.username ? ' @' + mdSafe(t.from.username) : ''}\n群:${mdSafe(t.chat || '私聊')}\n\n${mdSafe(t.content.slice(0, 500))}`;

    const nkb = st === 'done'

      ? [[{ text: '📋 查看全部反馈', callback_data: 'fball' }]]

      : [[{ text: '✅ 已解决', callback_data: `fbnote|${fid}|done` }, { text: '🔵 处理中', callback_data: `fbnote|${fid}|doing` }], [{ text: '📋 查看全部反馈', callback_data: 'fball' }]];

    await editMsg(chatId, msgId, ntext, env, nkb);

    return true;

  return true;

}



async function cbFbSet(ctx) {

  const { data, cb, chatId, userId, msgId, env } = ctx;

  if (!data.startsWith('fbset|')) return false;

    const parts = data.split('|');

    const fid = parseInt(parts[1], 10);

    const st = parts[2] === 'doing' ? 'doing' : (parts[2] === 'done' ? 'done' : 'open');

    if (!(await isFbAdmin(chatId, userId, env))) { await answerCb(cb.id, '⛔ 无权限'); return true; }

    const raw = await LOTTERY_KV.get(`fb:${fid}`);

    if (!raw) { await answerCb(cb.id, '反馈不存在'); return true; }

    const t = safeJsonParse(raw, {});

    const wasDone = t.status === 'done';

    t.status = st;

    await LOTTERY_KV.put(`fb:${fid}`, JSON.stringify(t));

    if (st === 'done' && !wasDone) await fbNotifyResolved(t, env).catch(() => null);

    await answerCb(cb.id, `#${fid} → ${FB_STATUS[st] || st}`);

    await fbRenderAll(chatId, msgId, env, { admin: true }).catch(() => null);

    return true;

  return true;

}



async function cbDispatch(ctx) {

  const { data, cb, chatId, userId, msgId, env, action, param } = ctx;

  try {

    if (action === 'menu') {

      if (param === 'create') { await startWizard(chatId, userId, '', '', env); return answerCb(cb.id, '', env); }

      if (param === 'announce') {

        await LOTTERY_KV.put(`announce_pending:${userId}`, '1', { expirationTtl: 900 });

        const kb = [[{ text: '❌ 取消', callback_data: 'cancel_announce_pending' }]];

        await editMsg(chatId, msgId, '📢 **管理员公告**\n\n请直接发送**公告内容**：\n\n💡 示例：`本周六晚8点群活动，欢迎参加！`', env, kb);

        return answerCb(cb.id, '', env);

      }

      if (param === 'poll') {

        await LOTTERY_KV.put(`poll_pending:${chatId}`, '1', { expirationTtl: 900 });

        const kb = [[{ text: '❌ 取消', callback_data: 'cancel_poll_pending' }]];

        await editMsg(chatId, msgId, '📊 **发起投票**\n\n请直接发送：`问题|选项1|选项2|...`\n\n💡 示例：`今晚吃什么？|火锅|烧烤|日料`\n⚡ 多选：`--multi 喜欢哪些？|A|B|C`', env, kb);

        return answerCb(cb.id, '', env);

      }

      if (param === 'list') { await listLotteries(chatId, env, '', userId, msgId); return answerCb(cb.id, '', env); }

      if (param === 'groups') { await showSettingsGroups(chatId, msgId, env, userId); return answerCb(cb.id, '', env); }

      if (param === 'channels') { await showSettingsChannels(chatId, msgId, env, userId); return answerCb(cb.id, '', env); }

      if (param === 'timezone') { await showSettingsTimezone(chatId, msgId, env, userId); return answerCb(cb.id, '', env); }

      if (param === 'chmod') { await showChannelModStart(chatId, msgId, env, userId); return answerCb(cb.id, '', env); }

      if (param === 'mod') { await showModStart(chatId, msgId, env, userId); return answerCb(cb.id, '', env); }

    }



    if (action === 'chmod_pick') {

      const channelId = parseInt(param);

      if (!channelId) return answerCb(cb.id, '无效频道', env);

      await showChannelActions(chatId, msgId, env, userId, channelId);

      return answerCb(cb.id, '', env);

    }



    if (action === 'chmod_exec') {

      const ps = param.split(':');

      const channelId = parseInt(ps[0]);

      const chmodAction = ps[1] || '';

      if (!channelId || !chmodAction) return answerCb(cb.id, '无效参数', env);

      await chmodExecAction(chatId, msgId, env, userId, channelId, chmodAction);

      return answerCb(cb.id, '', env);

    }



    if (action === 'chmod_back_list') {

      await LOTTERY_KV.delete(`chmod_announce:${userId}`);

      await showChannelModStart(chatId, msgId, env, userId);

      return answerCb(cb.id, '', env);

    }



    if (action === 'chmod_cancel_announce') {

      await LOTTERY_KV.delete(`chmod_announce:${userId}`);

      await LOTTERY_KV.delete(`chmod_btn:${userId}`);

      await LOTTERY_KV.delete(`chmod_btn_cfg:${userId}`);

      await editMsg(chatId, msgId, '❌ 已取消', env);

      return answerCb(cb.id, '已取消', env);

    }



    if (action === 'chmod_applybtn') {

      const channelId = parseInt(param);

      const rawCfg = await LOTTERY_KV.get(`chmod_btn_cfg:${userId}`);

      if (!channelId || !rawCfg) return answerCb(cb.id, '配置已过期，请重新发送', env);

      let cfg;

      try { cfg = JSON.parse(rawCfg); } catch { return answerCb(cb.id, '配置损坏', env); }

      await saveChannelButtons(chatId, userId, channelId, cfg, env);

      return answerCb(cb.id, '已保存', env);

    }



    if (action === 'mod_pick') {

      const ps = param.split(':');

      const modGroupId = parseInt(ps[0]);

      const modAction = ps[1] || '';

      if (!modGroupId) return answerCb(cb.id, '无效群', env);

      if (modAction.startsWith('banned')) { await bannedAction(chatId, msgId, userId, modGroupId, modAction, env); return answerCb(cb.id, '', env); }

      if (modAction.startsWith('welcome')) { await welcomeAction(chatId, msgId, userId, modGroupId, modAction, env); return answerCb(cb.id, '', env); }

      if (modAction) await modAct(chatId, msgId, userId, modGroupId, modAction, env);

      else await showModActions(chatId, msgId, env, userId, modGroupId);

      return answerCb(cb.id, '', env);

    }



    if (action === 'modcat') {

      const ps = param.split(':');

      const modGroupId = parseInt(ps[0]);

      const cat = ps[1] || '';

      if (!modGroupId) return answerCb(cb.id, '无效群', env);

      await showModCategory(chatId, msgId, env, userId, modGroupId, cat);

      return answerCb(cb.id, '', env);

    }



    if (action === 'mod_unban') {

      const ps = param.split(':');

      const modGroupId = parseInt(ps[0]);

      const targetId = parseInt(ps[1]);

      if (!modGroupId || !targetId) return answerCb(cb.id, '无效参数', env);

      const logEntry = (await getBannedLog(modGroupId)).find(u => String(u.id) === String(targetId));

      const targetName = logEntry?.name || `用户${targetId}`;

      if (logEntry?.type === 'mute') {

        const r = await tgApi(env, 'restrictChatMember', { chat_id: modGroupId, user_id: targetId, permissions: allPermissionsObject(true) }).catch(() => null);

        if (r && r.ok) { await removeBannedLog(modGroupId, targetId); await editMsg(chatId, msgId, `🔊 **${esc(targetName)}** 已解除禁言（对方仍在群里，可正常发言，无需重新加入）`, env); }

        else await editMsg(chatId, msgId, '❌ 解除禁言失败（权限不足？）', env);

        return answerCb(cb.id, '', env);

      }

      await modExecAction(chatId, msgId, env, modGroupId, 'unban', targetId, targetName, '');

      return answerCb(cb.id, '', env);

    }



    if (action === 'mod_setmute') {

      const ps = param.split(':');

      const modGroupId = parseInt(ps[0]);

      const muteArg = ps[1] || '';

      if (!modGroupId) return answerCb(cb.id, '无效群', env);

      await modAwaitTarget(chatId, msgId, userId, modGroupId, 'mute', muteArg, env);

      return answerCb(cb.id, '', env);

    }



    if (action === 'mod_fsub_set') {

      const modGroupId = parseInt(param);

      if (!modGroupId) return answerCb(cb.id, '无效群', env);

      const groups = await getBotGroups(env);

      const g = groups.find(x => x.id === modGroupId);

      await LOTTERY_KV.put(`mod_draft:${userId}`, JSON.stringify({ groupId: modGroupId, action: 'forcesub', step: 'text', groupName: g?.title || `群${modGroupId}` }), { expirationTtl: 900 });

      const fkb = [[{ text: '⬅️ 返回', callback_data: `mod_back:${modGroupId}` }, { text: '❌ 取消', callback_data: 'mod_cancel' }]];

      await editMsg(chatId, msgId, '📢 **设置强制关注频道**\n\n请直接发送频道用户名（如 `@mychannel`）、t.me 链接，或私有频道的 -100 数字 ID：', env, fkb);

      return answerCb(cb.id, '', env);

    }



    if (action === 'mod_fsub_off') {

      const modGroupId = parseInt(param);

      if (!modGroupId) return answerCb(cb.id, '无效群', env);

      const cfg = await getVerifyCfg(modGroupId);

      cfg.forceChannel = '';

      await LOTTERY_KV.put(`verify_cfg:${modGroupId}`, JSON.stringify(cfg));

      await showForceSubMenu(chatId, msgId, env, userId, modGroupId);

      return answerCb(cb.id, '⛔ 已关闭', env);

    }



    if (action === 'mod_notify_clean') {

      const modGroupId = parseInt(param);

      if (!modGroupId) return answerCb(cb.id, '无效群', env);

      const groups = await getBotGroups(env);

      const g = groups.find(x => x.id === modGroupId);

      const gname = g?.title || `群 ${modGroupId}`;

      await cleanNotifyMessages(chatId, msgId, env, userId, modGroupId, gname);

      return answerCb(cb.id, '', env);

    }



    if (action === 'mod_cancel') {

      await LOTTERY_KV.delete(`mod_draft:${userId}`);

      await editMsg(chatId, msgId, '❌ 已取消群管理操作', env);

      return answerCb(cb.id, '已取消', env);

    }



    if (action === 'mod_back') {

      const modGroupId = parseInt(param);

      if (!modGroupId) return answerCb(cb.id, '无效群', env);

      await LOTTERY_KV.delete(`mod_draft:${userId}`);

      await showModActions(chatId, msgId, env, userId, modGroupId);

      return answerCb(cb.id, '', env);

    }



    if (action === 'mod_back_list') {

      await LOTTERY_KV.delete(`mod_draft:${userId}`);

      await showModStart(chatId, msgId, env, userId);

      return answerCb(cb.id, '', env);

    }



    if (action === 'set_group') {

      const groupId = parseInt(param);

      await LOTTERY_KV.put(`user_cfg:${userId}`, JSON.stringify({ ...(await getUserCfg(userId, env)), defaultGroupId: groupId }));

      const groups = await getBotGroups(env);

      const g = groups.find(x => x.id === groupId);

      await editMsg(chatId, msgId, `✅ 默认发布群已设置为：\`${g?.title || groupId}\`\n\n以后创建抽奖/公告/投票会优先选中该群。`, env);

      return answerCb(cb.id, '✅ 已设置', env);

    }



    if (action === 'set_channel') {

      const channelId = parseInt(param);

      await LOTTERY_KV.put(`user_cfg:${userId}`, JSON.stringify({ ...(await getUserCfg(userId, env)), defaultChannelId: channelId }));

      const channels = await getBotChannels(env);

      const c = channels.find(x => x.id === channelId);

      await editMsg(chatId, msgId, `✅ 默认发布频道已设置为：\`${c?.title || channelId}\``, env);

      return answerCb(cb.id, '✅ 已设置', env);

    }



    if (action === 'set_timezone') {

      const hours = parseInt(param);

      if (isNaN(hours)) return answerCb(cb.id, '无效时区', env);

      await LOTTERY_KV.put('bot_timezone', String(hours));

      TZ_OFFSET_HOURS = hours;

      const names = { '8': '北京时间 (UTC+8)', '9': '东京时间 (UTC+9)', '0': 'UTC (UTC+0)', '7': '曼谷时间 (UTC+7)', '-5': '纽约时间 (UTC-5)' };

      await editMsg(chatId, msgId, `✅ 时区已设置为：**${names[hours] || `UTC${hours >= 0 ? '+' : ''}${hours}`}**\n\n所有开奖时间将按该时区显示。`, env);

      return answerCb(cb.id, '✅ 已设置', env);

    }



    if (action === 'menu_back') {

      const menuKb = [

        [{ text: '✨ 创建抽奖', callback_data: 'menu:create' }, { text: '📢 发布公告', callback_data: 'menu:announce' }],

        [{ text: '📊 发起投票', callback_data: 'menu:poll' }, { text: '📋 我的抽奖', callback_data: 'menu:list' }],

        [{ text: '🛡️ 群管理', callback_data: 'menu:mod' }, { text: '📢 频道管理', callback_data: 'menu:chmod' }],

        [{ text: '⚙️ 设置群组', callback_data: 'menu:groups' }, { text: '⚙️ 设置频道', callback_data: 'menu:channels' }],

        [{ text: '🌏 设置时区', callback_data: 'menu:timezone' }],

      ];

      await editMsg(chatId, msgId, '🎉 **群组管家 v6.7.11**\n\n📌 所有功能都在**私聊**向我发起：\n\n✨ 创建抽奖（多奖品/兑奖码） · 📢 发布公告\n📊 发起投票 · 🛡️ 群管理 · 📢 频道管理\n📋 我的抽奖 · ⚙️ 设置默认群组/频道 · 🌏 时区', env, menuKb);

      return answerCb(cb.id, '', env);

    }



    if (action === 'prize_add') {

      const wizardKey = `wizard:${userId}`;

      const raw = await LOTTERY_KV.get(wizardKey);

      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);

      const wizard = safeJsonParse(raw, {});

      wizard.step = 2;

      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      await editMsg(chatId, msgId, '🎁 请回复**下一个奖品名称**（回复后自动继续添加，或点下方按钮结束）：', env, [[{ text: '⏭️ 结束添加', callback_data: 'prize_done' }], [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]]);

      return answerCb(cb.id, '继续添加', env);

    }



    if (action === 'prize_done') {

      const wizardKey = `wizard:${userId}`;

      const raw = await LOTTERY_KV.get(wizardKey);

      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);

      const wizard = safeJsonParse(raw, {});

      wizard.data.prize = (wizard.data.prizes || []).join('、');

      wizard.step = 3;

      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      const prizeList = (wizard.data.prizes || []).map((p, i) => `${i + 1}. ${esc(p)}`).join('\n');

      const manyHint = (wizard.data.prizes || []).length > 1 ? `\n\n⚠️ 多个奖品时，建议中奖名额与奖品数量一致，将按中奖顺序一一发放。` : '';

      await editMsg(chatId, msgId, `✅ 奖品已确认：\n${prizeList}${manyHint}\n\n🏆 第3步：请输入**中奖名额数量**（默认1人）：`, env, [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]]);

      return answerCb(cb.id, '已确认', env);

    }



    if (action === 'redeem') {

      const lotteryId = param;

      const raw = await LOTTERY_KV.get(`lottery:${lotteryId}`);

      if (!raw) return answerCb(cb.id, '该抽奖记录已不存在', env);

      const lottery = safeJsonParse(raw, {});

      const winnerIdx = (lottery.winners || []).indexOf(userId);

      if (winnerIdx === -1) return answerCb(cb.id, '你不是该抽奖的中奖者', env);

      const prizes = (lottery.prizes && lottery.prizes.length) ? lottery.prizes : [lottery.prize || '奖品'];

      const myPrize = prizes[Math.min(winnerIdx, prizes.length - 1)];

      const myCode = lottery.useCodes && Array.isArray(lottery.codes) ? lottery.codes[winnerIdx] : null;

      const text = myCode ? `🎟️ **兑奖成功！**\n\n🎁 奖品：${esc(myPrize)}\n🎟️ 兑奖码：\`${esc(myCode)}\`\n\n📌 如果是兑换码,就 [点击我](https://t.me/vipclashbot) 进行兑换` : `🎟️ 兑奖信息\n\n🎁 奖品：${esc(myPrize)}\n\n📌 请尽快兑换使用～`;

      await sendMessage(chatId, text, env);

      const redeemKey = `my_redeem:${userId}`;

      const rawR = await LOTTERY_KV.get(redeemKey);

      if (rawR) {

        try { const list = JSON.parse(rawR).filter(x => x.lotteryId !== lotteryId); await LOTTERY_KV.put(redeemKey, JSON.stringify(list)); } catch {}

      }

      const creator = lottery.creatorId;

      if (creator && creator !== userId) {

        try { await sendMessage(creator, `🎟️ **玩家已完成兑奖**\n\n📝 抽奖：${esc(lottery.name)}\n🎁 奖品：${esc(myPrize)}\n👤 中奖者：\`${userId}\`${myCode ? `\n🎟️ 兑奖码：\`${esc(myCode)}\`` : ''}`, env); } catch {}

      }

      return answerCb(cb.id, '✅ 兑奖成功', env);

    }



    if (action === 'redeem_clear') {

      await LOTTERY_KV.put(`my_redeem:${userId}`, JSON.stringify([]));

      await editMsg(chatId, msgId, '🎟️ 已清空待兑奖记录 ✅', env);

      return answerCb(cb.id, '已清空', env);

    }



    if (action === 'lot_view') {

      await showLotteryDetail(chatId, userId, msgId, param, env);

      return answerCb(cb.id, '', env);

    }



    if (action === 'lot_draw') {

      const raw = await LOTTERY_KV.get(`lottery:${param}`);

      if (!raw) return answerCb(cb.id, '抽奖不存在', env);

      const l = safeJsonParse(raw, {});

      if (l.creatorId !== userId) return answerCb(cb.id, '只有创建者才能开奖', env);

      if (l.status !== 'active') return answerCb(cb.id, '抽奖已结束', env);

      if (!l.participants || l.participants.length === 0) return answerCb(cb.id, '暂无人参与', env);

      await executeDraw(param, l, env, l.groupName || '');

      return answerCb(cb.id, '🎲 已开奖', env);

    }



    if (action === 'lot_end') {

      const raw = await LOTTERY_KV.get(`lottery:${param}`);

      if (!raw) return answerCb(cb.id, '抽奖不存在', env);

      const l = safeJsonParse(raw, {});

      if (l.creatorId !== userId) return answerCb(cb.id, '只有创建者才能结束', env);

      if (l.status !== 'active') return answerCb(cb.id, '抽奖已结束', env);

      const yesKb = [[{ text: '✅ 确认结束', callback_data: `lot_end_confirm:${param}` }], [{ text: '↩️ 返回详情', callback_data: `lot_view:${param}` }]];

      await editMsg(chatId, msgId, `⚠️ **确认结束本次抽奖？**\n\n📝 ${esc(l.name)}\n👥 已参与 ${l.participants ? l.participants.length : 0} 人\n\n结束后不可恢复，参与者将收到取消通知。`, env, yesKb);

      return answerCb(cb.id, '', env);

    }



    if (action === 'lot_end_confirm') {

      const raw = await LOTTERY_KV.get(`lottery:${param}`);

      if (!raw) return answerCb(cb.id, '抽奖不存在', env);

      const l = safeJsonParse(raw, {});

      if (l.creatorId !== userId) return answerCb(cb.id, '只有创建者才能结束', env);

      l.status = 'cancelled';

      l.cancelledAt = Date.now();

      await LOTTERY_KV.put(`lottery:${param}`, JSON.stringify(l));

      if (l.groupMsgId) { try { await tgApi(env, 'unpinChatMessage', { chat_id: l.groupId, message_id: l.groupMsgId }); } catch {} }

      const cancelText = `❌ 「${esc(l.name)}」已结束（未开奖）\n\n感谢参与，下次好运～`;

      for (const pid of (l.participants || [])) { try { await sendMessage(pid, cancelText, env); } catch {} }

      try { await sendMessage(l.groupId, `❌ **抽奖已结束**\n\n📝 ${esc(l.name)}\n本场未开奖，感谢参与～`, env); } catch {}

      await editMsg(chatId, msgId, `✅ 已结束本次抽奖「${esc(l.name)}」`, env);

      return answerCb(cb.id, '✅ 已结束', env);

    }



    if (action === 'trigger_type') {

      const wizardKey = `wizard:${userId}`;

      const raw = await LOTTERY_KV.get(wizardKey);

      if (!raw) return answerCb(cb.id, '⏰ 会话已过期，请重新 /create', env);

      const wizard = safeJsonParse(raw, {});

      wizard.data.triggerType = param;

      wizard.step = 6;

      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      if (param === 'time') {

        const timeKb = [

          [{ text: '⏱️ 10分钟后', callback_data: 'wizard_time:10m' }],

          [{ text: '⏱️ 1小时后', callback_data: 'wizard_time:1h' }],

          [{ text: '⏱️ 1天后', callback_data: 'wizard_time:1d' }],

          [{ text: '⏱️ 1周后', callback_data: 'wizard_time:1w' }],

          [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],

        ];

        await editMsg(chatId, msgId, `⏰ **定时开奖**\n\n点选快捷时间按钮，或直接输入：\n\`10分钟后\` / \`1小时后\` / \`1天后\` / \`1周后\`\n或具体时间：\`2026-08-25 20:00\``, env, timeKb);

      } else {

        await editMsg(chatId, msgId, `👥 **人数开奖**\n\n请输入参与人数上限（到达后自动开奖，例如：\`50\`）：`, env);

      }

      return answerCb(cb.id, '', env);

    }



    if (action === 'wizard_time') {

      const wizardKey = `wizard:${userId}`;

      const raw = await LOTTERY_KV.get(wizardKey);

      if (!raw) return answerCb(cb.id, '⏰ 会话已过期，请重新 /create', env);

      const wizard = safeJsonParse(raw, {});

      const unitMap = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };

      const num = parseInt(param);

      const unit = param.replace(/^\d+/, '');

      const ms = unitMap[unit];

      if (!ms || isNaN(num)) return answerCb(cb.id, '无效时间', env);

      wizard.data.triggerValue = Date.now() + num * ms;

      const confirmText = `开奖时间：\`${fmtDate(wizard.data.triggerValue)}\``;

      await showWizardGroupPicker(chatId, userId, wizard, confirmText, env);

      return answerCb(cb.id, `✅ ${fmtDate(wizard.data.triggerValue)}`, env);

    }



    if (action === 'select_group') {

      const wizardKey = `wizard:${userId}`;

      const raw = await LOTTERY_KV.get(wizardKey);

      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);

      const wizard = safeJsonParse(raw, {});

      const groupId = parseInt(param);

      const groups = await getBotGroups(env);

      const g = groups.find(x => x.id === groupId);

      wizard.data.groupId = groupId;

      wizard.data.groupName = g?.title || '';

      wizard.step = 8;

      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      const channelKb = [

        [{ text: '⏭️ 跳过（不发布到频道）', callback_data: 'skip_channel' }],

        [{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }],

      ];

      await editMsg(chatId, msgId, `✅ 发布群：\`${groupId}\`${g?.title ? `（${esc(g.title)}）` : ''}\n\n📢 第8步（可选）：请输入**频道**链接或用户名\n例如：\`@mychannel\`\n公告会同时发布到该频道（并可设为强制加频道）\n（点击跳过则只发布到群）`, env, channelKb);

      return answerCb(cb.id, '✅ 已选择', env);

    }



    if (action === 'skip_channel') {

      const wizardKey = `wizard:${userId}`;

      const raw = await LOTTERY_KV.get(wizardKey);

      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);

      const wizard = safeJsonParse(raw, {});

      wizard.data.channel = '';

      wizard.step = 9;

      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      await editMsg(chatId, msgId, '⏭️ 已跳过，只发布到群', env);

      await showCodeToggle(chatId, userId, wizard, env);

      return answerCb(cb.id, '✅ 跳过', env);

    }



    if (action === 'code_mode') {

      const wizardKey = `wizard:${userId}`;

      const raw = await LOTTERY_KV.get(wizardKey);

      if (!raw) return answerCb(cb.id, '⏰ 会话已过期', env);

      const wizard = safeJsonParse(raw, {});

      if (param === 'yes') {

        wizard.step = 10;

        await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

        const kb = [[{ text: '❌ 取消创建', callback_data: 'cancel_wizard' }]];

        await editMsg(chatId, msgId, '🎟️ **填写兑换码**（第10步/共10步）\n\n请粘贴**兑换码列表**，**每行一个**：\n\n💡 示例：\n`CODE-7X2K9M`\n`CODE-8PL4QN`\n`CODE-5RW3YT`\n\n📌 支持一行一个，或逗号/空格分隔；开奖时将按中奖名单顺序逐一私信发放。', env, kb);

        return answerCb(cb.id, '📝 请发送兑换码', env);

      }

      wizard.data.useCodes = false;

      wizard.data.codes = [];

      await LOTTERY_KV.put(wizardKey, JSON.stringify(wizard), { expirationTtl: 3600 });

      await finishWizard(chatId, msgId, userId, wizard, env);

      return answerCb(cb.id, '✅ 无需兑换码', env);

    }



    if (action === 'cancel_wizard') {

      await LOTTERY_KV.delete(`wizard:${userId}`);

      await editMsg(chatId, msgId, '❌ 已取消创建', env);

      return answerCb(cb.id, '已取消', env);

    }



    if (action === 'verify_join') {

      const ps = param.split(':');

      const verifyChatId = parseInt(ps[0]);

      const verifyUserId = parseInt(ps[1]);

      if (!verifyChatId || !verifyUserId) return answerCb(cb.id, '无效请求', env);

      if (userId !== verifyUserId) return answerCb(cb.id, '⚠️ 请本人点击验证', env);

      const vKey = `verify_pending:${verifyChatId}:${verifyUserId}`;

      const vRaw = await LOTTERY_KV.get(vKey);

      if (!vRaw) return answerCb(cb.id, '⏳ 验证已过期或已完成', env);

      const pending = safeJsonParse(vRaw, {});

      const jcfg = await getVerifyCfg(verifyChatId);

      const jch = (jcfg.forceChannel || '').trim();

      if (jch) {

        const jok = await checkChannelMembership(jch, verifyUserId, env);

        if (!jok) return answerCb(cb.id, `请先关注频道 ${jch} 后再点击；也可私聊 bot 完成完整验证`, env);

      }

      const jname = pending.name || `用户${verifyUserId}`;

      await finishVerification(pending, vKey, null, verifyUserId, jname, env);

      return answerCb(cb.id, '✅ 验证成功', env);

    }



    if (action === 'verify_sub') {

      const ps = param.split(':');

      const verifyChatId = parseInt(ps[0]);

      const verifyUserId = parseInt(ps[1]);

      if (!verifyChatId || !verifyUserId) return answerCb(cb.id, '无效请求', env);

      if (userId !== verifyUserId) return answerCb(cb.id, '⚠️ 请本人点击验证', env);

      const vKey = `verify_pending:${verifyChatId}:${verifyUserId}`;

      const vRaw = await LOTTERY_KV.get(vKey);

      if (!vRaw) return answerCb(cb.id, '⏳ 验证已过期或已完成', env);

      const pending = safeJsonParse(vRaw, {});

      const ch = (pending.forceChannel || '').trim();

      const sname = pending.name || `用户${verifyUserId}`;

      if (!ch) {

        await finishVerification(pending, vKey, chatId, verifyUserId, sname, env);

        await editMsg(chatId, msgId, `✅ 验证成功！**${esc(sname)}** 已解除禁言，欢迎加入本群～ 🎉`, env).catch(() => null);

        return answerCb(cb.id, '✅ 验证成功', env);

      }

      const ok = await checkChannelMembership(ch, verifyUserId, env);

      if (!ok) return answerCb(cb.id, `❗还未检测到你已关注 ${ch}，请先关注再点击`, env);

      await finishVerification(pending, vKey, chatId, verifyUserId, sname, env);

      await editMsg(chatId, msgId, `✅ 全部验证通过！**${esc(sname)}** 已解除禁言，欢迎加入本群～ 🎉`, env).catch(() => null);

      return answerCb(cb.id, '✅ 已确认关注，验证成功', env);

    }



    if (action === 'fsub_retry') {

      const ps = param.split(':');

      const fChatId = parseInt(ps[0]);

      const fUserId = parseInt(ps[1]);

      if (!fChatId || !fUserId) return answerCb(cb.id, '无效请求', env);

      if (userId !== fUserId) return answerCb(cb.id, '⚠️ 请本人点击', env);

      const fcfg = await getVerifyCfg(fChatId);

      const fch = (fcfg.forceChannel || '').trim();

      if (!fch) return answerCb(cb.id, '该群未设置强制关注频道', env);

      const fok = await checkChannelMembership(fch, fUserId, env);

      if (!fok) return answerCb(cb.id, `还未检测到你已关注 ${fch}，请先关注再点击`, env);

      const frKey = `fsub_check:${fChatId}:${fUserId}`;

      const frRaw = await LOTTERY_KV.get(frKey);

      if (frRaw) {

        let frex; try { frex = JSON.parse(frRaw); } catch {}

        if (frex?.msgId) await tgApi(env, 'deleteMessage', { chat_id: fChatId, message_id: frex.msgId }).catch(() => null);

      }

      await LOTTERY_KV.delete(frKey);

      try { const fst = await getChatMemberStatus(fChatId, fUserId, env); if (fst === 'restricted') await tgApi(env, 'restrictChatMember', { chat_id: fChatId, user_id: fUserId, permissions: allPermissionsObject(true) }).catch(() => null); } catch {}

      await editMsg(chatId, msgId, `✅ 验证通过！你已关注频道 **${esc(fch)}**。`, env);

      return answerCb(cb.id, '✅ 验证通过', env);

    }



    if (action === 'announce_publish') {

      const targetGroupId = parseInt(param);

      if (!targetGroupId) return answerCb(cb.id, '无效群ID', env);

      try { await publishAnnounce(chatId, userId, targetGroupId, msgId, env); } catch (err) { console.log('announce publish error:', err); await editMsg(chatId, msgId, '❌ 发布失败，请稍后重试', env); }

      return answerCb(cb.id, '', env);

    }



    if (action === 'poll_publish') {

      const targetGroupId = parseInt(param);

      if (!targetGroupId) return answerCb(cb.id, '无效群ID', env);

      try { await publishPoll(chatId, userId, targetGroupId, msgId, env); } catch (err) { console.log('poll publish error:', err); await editMsg(chatId, msgId, '❌ 发布失败，请稍后重试', env); }

      return answerCb(cb.id, '', env);

    }



    if (action === 'cancel_group_pick') {

      await LOTTERY_KV.delete(`announce_draft:${userId}`);

      await LOTTERY_KV.delete(`poll_draft:${userId}`);

      await editMsg(chatId, msgId, '❌ 已取消发布', env);

      return answerCb(cb.id, '已取消', env);

    }



    if (action === 'cancel_announce_pending' || action === 'cancel_poll_pending') {

      await LOTTERY_KV.delete(`announce_pending:${userId}`);

      await LOTTERY_KV.delete(`poll_pending:${userId}`);

      await editMsg(chatId, msgId, '❌ 已取消', env);

      return answerCb(cb.id, '已取消', env);

    }



    // 广播确认

    if (action === 'broadcast_confirm') {

      if (!fbAdminIds().includes(userId)) { await LOTTERY_KV.delete(`broadcast_pending:${userId}`); return answerCb(cb.id, '⛔ 无权限'); }

      await LOTTERY_KV.delete(`broadcast_pending:${userId}`);

      const draftKey = `broadcast_draft:${userId}`;

      const raw = await LOTTERY_KV.get(draftKey);

      await LOTTERY_KV.delete(draftKey);

      if (!raw) {

        await editMsg(chatId, msgId, '⏰ 广播草稿已过期', env);

        return answerCb(cb.id, '', env);

      }

      const draft = safeJsonParse(raw, {});

      const groups = await getBotGroups(env);

      if (!groups.length) {

        await editMsg(chatId, msgId, '❌ bot 尚未加入任何群，无法广播', env);

        return answerCb(cb.id, '', env);

      }

      let success = 0, fail = 0;

      for (const g of groups) {

        try {

          const res = await sendMessage(g.id, `📢 **全局广播**\n\n${draft.content}`, env);

          if (res && res.ok) success++; else fail++;

        } catch { fail++; }

      }

      await editMsg(chatId, msgId, `✅ **广播完成**\n\n📤 成功：${success} 个群\n❌ 失败：${fail} 个群`, env);

      return answerCb(cb.id, '✅ 广播完成', env);

    }



    if (action === 'broadcast_cancel') {

      await LOTTERY_KV.delete(`broadcast_pending:${userId}`);

      await LOTTERY_KV.delete(`broadcast_draft:${userId}`);

      await editMsg(chatId, msgId, '❌ 已取消广播', env);

      return answerCb(cb.id, '已取消', env);

    }



    await answerCb(cb.id, '', env);

  } catch (err) {

    console.error('Callback error:', err);

    await answerCb(cb.id, '处理出错', env);

  }

}
async function finishWizard(chatId, msgId, userId, wizard, env) {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const lotteryId = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, 8);

  const now = Date.now();
  const lottery = {
    id: lotteryId,
    groupId: wizard.data.groupId,
    groupName: wizard.data.groupName,
    creatorId: userId,
    name: wizard.data.name,
    prize: wizard.data.prize,
    prizes: Array.isArray(wizard.data.prizes) && wizard.data.prizes.length ? wizard.data.prizes : [wizard.data.prize || ''],
    winnerCount: wizard.data.winnerCount || 1,
    keyword: wizard.data.keyword,
    triggerType: wizard.data.triggerType,
    triggerValue: wizard.data.triggerValue,
    channel: wizard.data.channel || '',
    useCodes: !!wizard.data.useCodes,
    codes: Array.isArray(wizard.data.codes) ? wizard.data.codes : [],
    codesUsed: [],
    participants: [],
    participantNames: {},
    winners: [],
    status: 'active',
    createdAt: now,
    drawnAt: null,
    groupMsgId: null,
    channelMsgId: null,
  };

  if (!lottery.groupId) return sendMessage(chatId, '❌ 未选择发布群，创建失败。请重新 /create。', env);

  await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
  await addToGroupIndex(env, lottery.groupId, lotteryId);
  if (lottery.triggerType === 'time') await addToScheduled(env, lotteryId);

  await LOTTERY_KV.delete(`wizard:${userId}`);

  const botInGroup = await checkBotInChat(lottery.groupId, env);
  const triggerText = lottery.triggerType === 'time'
    ? `⏰ 开奖时间：${fmtDate(lottery.triggerValue)}`
    : `👥 满 ${lottery.triggerValue} 人自动开奖`;
  const channelText = lottery.channel ? `\n📢 频道：${lottery.channel}` : '';
  const codeText = lottery.useCodes ? `\n🎟️ 中奖后由 bot 私信发放兑换码` : '';

  const groupPost = `🎊 **抽奖开始啦！** 🎊

━━━━━━━━━━━━━━━━
📝 **活动名称：** ${esc(lottery.name)}
🎁 **奖品：** ${esc(lottery.prize)}
🏆 **中奖名额：** ${lottery.winnerCount} 人
${triggerText}${channelText}${codeText}
━━━━━━━━━━━━━━━━

🔑 在群内发送口令 \`${lottery.keyword}\` 即可参与抽奖！`;

  let groupMsgId = null;
  if (botInGroup) {
    const postRes = await sendMessage(lottery.groupId, groupPost, env);
    if (postRes && postRes.ok && postRes.result?.message_id) {
      groupMsgId = postRes.result.message_id;
      lottery.groupMsgId = groupMsgId;
    }
  }

  let channelMsgId = null;
  if (lottery.channel) {
    try {
      const chRes = await sendMessage(lottery.channel, groupPost, env);
      if (chRes && chRes.ok && chRes.result?.message_id) {
        channelMsgId = chRes.result.message_id;
        lottery.channelMsgId = channelMsgId;
      }
    } catch {}
  }

  if (lottery.groupId && groupMsgId) {
    try {
      await tgApi(env, 'pinChatMessage', {
        chat_id: lottery.groupId,
        message_id: groupMsgId,
        disable_notification: false,
      });
    } catch {}
  }
  await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));

  const botWarn = botInGroup ? '' : `\n⚠️ **机器人不在发布群中**，公告未能发布！\n请把机器人加入该群（设为管理员）后，手动发送公告或在私聊中使用 /groups 检查。`;
  const confirmText = `✅ **创建成功！**

🆔 **ID：** \`${lottery.id}\`
📢 **发布群：** \`${lottery.groupId}\`${lottery.groupName ? `（${esc(lottery.groupName)}）` : ''}
${lottery.channel ? `📢 **频道：** ${lottery.channel}` : ''}
🔑 **口令：** \`${lottery.keyword}\`
${lottery.useCodes ? `🎟️ **兑换码：** ${lottery.codes.length} 个（开奖时自动私信中奖者）` : ''}
${botWarn}`;

  const doneKb = [
    [{ text: '📋 我的抽奖', callback_data: 'menu:list' },
     { text: '🎲 立即开奖', callback_data: `lot_draw:${lottery.id}` }],
    [{ text: '🏠 主菜单', callback_data: 'menu_back' }],
  ];

  if (msgId) await editMsg(chatId, msgId, confirmText, env, doneKb);
  else await sendMsgKb(chatId, confirmText, doneKb, env);
}

async function checkKeyword(chatId, userId, username, text, chatTitle, env) {
  const indexData = await LOTTERY_KV.get(`group:${chatId}:lotteries`);
  if (!indexData) return;

  const ids = safeJsonParse(indexData, []);
  const now = Date.now();

  for (const id of ids) {
    const raw = await LOTTERY_KV.get(`lottery:${id}`);
    if (!raw) continue;
    const lottery = safeJsonParse(raw, {});
    if (lottery.status !== 'active') continue;

    if (lottery.triggerType === 'time' && now >= lottery.triggerValue) {
      if (lottery.participants.length === 0) {
        lottery.status = 'cancelled';
        await LOTTERY_KV.put(`lottery:${id}`, JSON.stringify(lottery));
        await sendMessage(chatId, `⏰ 开奖时间已到，但「${esc(lottery.name)}」无人参与，已自动取消`, env);
        continue;
      }
      await executeDraw(id, lottery, env, chatTitle);
      continue;
    }

    if (text.trim() !== lottery.keyword) continue;

    if (lottery.participants.includes(userId)) {
      return sendMessage(chatId, `⚠️ ${esc(username)}，你已经参与过「${esc(lottery.name)}」了，请等待开奖结果~`, env);
    }

    if (lottery.channel) {
      const isMember = await checkChannelMembership(lottery.channel, userId, env);
      if (!isMember) {
        return sendMessage(chatId, `❌ ${esc(username)}，请先加入频道 ${lottery.channel} 后再参与抽奖！`, env);
      }
    }

    lottery.participants.push(userId);
    lottery.participantNames[userId] = username;
    const count = lottery.participants.length;
    await LOTTERY_KV.put(`lottery:${id}`, JSON.stringify(lottery));

    const nbt = await notifyButton(env);
    if (nbt) {
      await sendMsgKb(chatId, `✅ ${esc(username)} 参与成功！「${esc(lottery.name)}」当前 ${count} 人参与 🎯\n\n🔔 点击「开启中奖私信提醒」：开奖结果私信送达\n🎟️ 点击「兑奖」：中奖后直接领取兑奖码`, nbt, env);
    } else {
      await sendMessage(chatId, `✅ ${esc(username)} 参与成功！「${esc(lottery.name)}」当前 ${count} 人参与 🎯`, env);
    }

    if (lottery.triggerType === 'count' && count >= lottery.triggerValue) {
      await executeDraw(id, lottery, env, chatTitle);
    }
    return;
  }
}

async function checkChannelMembership(channel, userId, env) {
  const raw = String(channel || '').trim();
  if (!raw) return true;
  let chatId;
  if (/^-?\d+$/.test(raw)) chatId = parseInt(raw, 10);
  else chatId = `@${raw.replace(/^@/, '').trim()}`;
  try {
    const res = await tgApi(env, 'getChatMember', {
      chat_id: chatId,
      user_id: userId,
    });
    if (!res.ok) return false;
    const status = res.result.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch {
    return false;
  }
}

async function drawLottery(chatId, userId, lotteryId, env, chatTitle) {
  if (!lotteryId) return sendMessage(chatId, '❌ 请提供抽奖ID\n用法：`/draw <抽奖ID>`', env);
  const raw = await LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return sendMessage(chatId, `❌ 抽奖 \`${lotteryId}\` 不存在`, env);
  const lottery = safeJsonParse(raw, {});
  if (userId !== lottery.creatorId) return sendMessage(chatId, '❌ 只有创建者才能开奖', env);
  if (lottery.status !== 'active') return sendMessage(chatId, '⚠️ 此抽奖已结束或已取消', env);
  if (lottery.participants.length === 0) return sendMessage(chatId, '😢 暂无人参与，无法开奖', env);
  return executeDraw(lotteryId, lottery, env, chatTitle);
}

async function executeDraw(lotteryId, lottery, env, chatTitle) {
  // 原子状态锁定：先标记completed防止竞态重复触发
  if (lottery.status === 'completed' || lottery.status === 'cancelled') return;
  lottery.status = 'completed';
  await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
  const participants = lottery.participants;
  const winnerCount = Math.min(lottery.winnerCount || 1, participants.length);
  const winners = securePick(participants, winnerCount);

  lottery.winners = winners;
  lottery.drawnAt = Date.now();
  await removeFromScheduled(env, lotteryId);

  if (lottery.groupMsgId) {
    try {
      await tgApi(env, 'unpinChatMessage', { chat_id: lottery.groupId, message_id: lottery.groupMsgId });
    } catch {}
  }

  const winnerNames = winners.map(id => lottery.participantNames[id] || `用户${id}`);
  const prizes = (lottery.prizes && lottery.prizes.length) ? lottery.prizes : [lottery.prize || '奖品'];

  const winnerList = winnerNames.map((n, i) => {
    const p = prizes[Math.min(i, prizes.length - 1)];
    const prizePart = prizes.length > 1 ? ` → ${esc(p)}` : '';
    return `${i + 1}. @${esc(n)}${prizePart}`;
  }).join('\n');
  const groupText = `🎊🎊🎊 **开奖啦！** 🎊🎊🎊

━━━━━━━━━━━━━━━━━━
📝 **活动：** ${esc(lottery.name)}
${prizes.length > 1 ? `🎁 **奖品：**\n${prizes.map((p, i) => `  ${i + 1}. ${esc(p)}`).join('\n')}` : `🎁 **奖品：** ${esc(lottery.prize)}`}
👥 **参与人数：** ${participants.length} 人
🏆 **中奖人数：** ${winnerCount} 人
━━━━━━━━━━━━━━━━━━

🎉 **中奖者：**
${winnerList}

🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉`;
  await sendMessage(lottery.groupId, groupText, env);
  if (lottery.channel) {
    try { await sendMessage(lottery.channel, groupText, env); } catch {}
  }

  const dmFailed = [];
  let codeIdx = 0;
  const codeAssignments = {};
  for (let wi = 0; wi < winners.length; wi++) {
    const winnerId = winners[wi];
    const name = lottery.participantNames[winnerId] || `用户${winnerId}`;
    const myPrize = prizes[Math.min(wi, prizes.length - 1)];
    let codeText = '';
    if (lottery.useCodes && Array.isArray(lottery.codes)) {
      if (codeIdx < lottery.codes.length) {
        const code = lottery.codes[codeIdx];
        codeIdx++;
        codeAssignments[winnerId] = code;
        lottery.codesUsed.push(code);
      } else {
        codeText = '\n⚠️ 兑奖码已发放完毕，请联系管理员单独处理';
      }
    }
    const dmText = `🥳🥳 **恭喜中奖啦！** 🥳🥳

━━━━━━━━━━━━━━━━
**抽奖群：** ${esc(chatTitle || lottery.groupName)}
**活动名称：** ${esc(lottery.name)}
**获得奖品：** ${esc(myPrize)}${codeText}
━━━━━━━━━━━━━━━━

🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉`;
    const res = await sendMsgKb(winnerId, dmText, [
      [{ text: '🎟️ 立即兑奖', callback_data: `redeem:${lotteryId}` }],
    ], env);
    if (!res || !res.ok) {
      dmFailed.push(winnerId);
    }
  }

  if (lottery.useCodes && codeIdx > 0) {
    await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
  }
  for (let wi = 0; wi < winners.length; wi++) {
    const winnerId = winners[wi];
    const myPrize = prizes[Math.min(wi, prizes.length - 1)];
    const myCode = codeAssignments[winnerId] || null;
    const redeemKey = `my_redeem:${winnerId}`;
    const rawR = await LOTTERY_KV.get(redeemKey);
    let list = safeJsonParse(rawR, []);
    list = list.filter(x => x.lotteryId !== lotteryId);
    list.unshift({ lotteryId, name: lottery.name, prize: myPrize, code: myCode, groupName: lottery.groupName || (chatTitle || ''), drawnAt: lottery.drawnAt || Date.now() });
    list = list.slice(0, 30);
    await LOTTERY_KV.put(redeemKey, JSON.stringify(list));
  }

  if (dmFailed.length > 0) {
    const failedNames = dmFailed.map(id => lottery.participantNames[id] || `用户${id}`);
    const tip = `💡 中奖通知私信失败：${failedNames.map(esc).join('、')}\n\n请**私聊机器人**发送任意消息（或点击上一篇参与成功消息里的「🔔 开启中奖私信提醒」按钮），以便接收中奖通知。`;
    try { await sendMessage(lottery.groupId, tip, env); } catch {}
    console.log('DM failed for:', dmFailed.join(','));
  }

  const winnerIds = winners;
  const creatorList = winnerNames.map((n, i) => {
    const code = codeAssignments[winnerIds[i]];
    const myPrize = prizes[Math.min(i, prizes.length - 1)];
    return `${i + 1}- ${n}  获得:${esc(myPrize)}${code ? `\n    🎟️ 兑换码: \`${esc(code)}\`` : ''}`;
  }).join('\n');
  const creatorText = `💐💐💐 **开奖了** 💐💐💐

**${esc(lottery.name)}** 开奖了!
本期总参与人数: ${participants.length}

${creatorList}

谨祝中奖用户大吉大利万事顺意`;
  try { await sendMessage(lottery.creatorId, creatorText, env); }
  catch { console.log(`Cannot DM creator ${lottery.creatorId}`); }
}

async function cancelLotteryCmd(chatId, userId, lotteryId, env, chatTitle) {
  if (!lotteryId) return sendMessage(chatId, '❌ 用法：`/cancel <抽奖ID>`', env);
  const raw = await LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return sendMessage(chatId, `❌ 抽奖 \`${lotteryId}\` 不存在`, env);
  const lottery = safeJsonParse(raw, {});
  if (userId !== lottery.creatorId) return sendMessage(chatId, '❌ 只有创建者才能取消', env);
  if (lottery.status !== 'active') return sendMessage(chatId, '⚠️ 此抽奖已结束或已取消', env);
  lottery.status = 'cancelled';
  await LOTTERY_KV.put(`lottery:${lotteryId}`, JSON.stringify(lottery));
  await removeFromScheduled(env, lotteryId);
  if (lottery.groupMsgId) {
    try {
      await tgApi(env, 'unpinChatMessage', { chat_id: lottery.groupId, message_id: lottery.groupMsgId });
    } catch {}
  }
  return sendMessage(chatId, `✅ 抽奖 \`${lotteryId}\` 已取消`, env);
}

async function listLotteries(chatId, env, chatTitle, userId, msgId) {
  const isPrivate = chatId > 0;
  let active = [];

  if (isPrivate) {
    const groups = await getBotGroups(env);
    // 先并发读取所有群的索引，再并发读取各群抽奖详情
    const groupIndexes = await Promise.all(groups.map(g => kvGetJson(`group:${g.id}:lotteries`, [])));
    const allIds = groupIndexes.flat();
    const allRaw = await Promise.all(allIds.map(id => kvGetJson(`lottery:${id}`, null)));
    for (const l of allRaw) {
      if (l && l.status === 'active' && l.creatorId === userId) active.push(l);
    }
  } else {
    const indexData = await LOTTERY_KV.get(`group:${chatId}:lotteries`);
    if (indexData) {
      const ids = safeJsonParse(indexData, []);
      for (const id of ids) {
        const raw = await LOTTERY_KV.get(`lottery:${id}`);
        if (raw) {
          const l = safeJsonParse(raw, {});
          if (l.status === 'active') active.push(l);
        }
      }
    }
  }
  if (active.length === 0) {
    const msg = '📭 当前没有进行中的抽奖\n\n💡 私聊机器人发送 /create 创建一个吧～\n🎟 查看抽奖中心奖池:/pool';
    if (msgId) return editMsg(chatId, msgId, msg, env);
    return sendMessage(chatId, msg, env);
  }

  const kb = active.map((l) => {
    const trigger = l.triggerType === 'time' ? `⏰ ${fmtDate(l.triggerValue)}` : `👥 ${l.participants.length}/${l.triggerValue}人`;
    return [{ text: `🎯 ${esc(l.name)}（👥${l.participants.length}・${trigger}）`, callback_data: `lot_view:${l.id}` }];
  });
  kb.push([{ text: '📊 发起投票', callback_data: 'menu:poll' }, { text: '📢 发布公告', callback_data: 'menu:announce' }]);
  kb.push([{ text: '✨ 创建抽奖', callback_data: 'menu:create' }, { text: '🔙 返回菜单', callback_data: 'menu_back' }]);

  const text = `📋 **进行中的抽奖（${active.length}）：**\n\n点击查看详情，可立即开奖 / 结束本次抽奖：`;
  if (msgId) return editMsg(chatId, msgId, text, env, kb);
  return sendMsgKb(chatId, text, kb, env);
}

async function showLotteryDetail(chatId, userId, msgId, lotteryId, env) {
  const raw = await LOTTERY_KV.get(`lottery:${lotteryId}`);
  if (!raw) return editMsg(chatId, msgId, '❌ 抽奖不存在（可能已删除）', env);
  const l = safeJsonParse(raw, {});
  const isCreator = l.creatorId === userId;
  const trigger = l.triggerType === 'time' ? `⏰ ${fmtDate(l.triggerValue)}` : `👥 ${l.participants.length}/${l.triggerValue}人`;
  const prizes = (l.prizes && l.prizes.length) ? l.prizes : [l.prize || ''];
  const text = `🎯 **抽奖详情**（${l.status === 'active' ? '⏳ 进行中' : l.status === 'completed' ? '✅ 已开奖' : '❌ 已取消'}）

📝 **名称：** ${esc(l.name)}
🎁 **奖品：**\n${prizes.map((p, i) => `  ${i + 1}. ${esc(p)}`).join('\n')}
👥 **参与人数：** ${l.participants ? l.participants.length : 0}
${trigger}
🔑 **口令：** \`${esc(l.keyword)}\`
🆔 **ID：** \`${l.id}\``;

  const kb = [];
  if (isCreator && l.status === 'active') {
    if (l.participants && l.participants.length > 0) {
      kb.push([{ text: '🎲 立即开奖', callback_data: `lot_draw:${l.id}` }]);
    }
    kb.push([{ text: '❌ 结束本次抽奖', callback_data: `lot_end:${l.id}` }]);
  }
  kb.push([{ text: '🔙 返回列表', callback_data: 'menu:list' }, { text: '🏠 主菜单', callback_data: 'menu_back' }]);
  return editMsg(chatId, msgId, text, env, kb);
}

async function refreshGroupsCmd(chatId, userId, env) {
  const groups = await getBotGroups(env);
  if (groups.length === 0) {
    return sendMessage(chatId, '🤖 我还没有加入任何群组。\n\n请把机器人**加入目标群组**（设为管理员），然后再次发送 /groups。', env);
  }
  const list = groups.map(g => `• \`${g.id}\` ${g.title ? `（${esc(g.title)}）` : ''}`).join('\n');
  return sendMessage(chatId, `🤖 我已加入的群组（${groups.length} 个）：\n\n${list}`, env);
}

function securePick(arr, count) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    let rand = 0;
    for (let b = 0; b < 4; b++) rand = rand * 256 + buf[b];
    const j = Math.abs(rand % (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

let TZ_OFFSET_HOURS = 8;

async function loadTzOffset(env) {
  try {
    const raw = await LOTTERY_KV.get('bot_timezone');
    if (!raw) { TZ_OFFSET_HOURS = 8; return; }
    const parsed = parseInt(raw);
    TZ_OFFSET_HOURS = isNaN(parsed) ? 8 : parsed;
  } catch {
    TZ_OFFSET_HOURS = 8;
  }
}

function fmtDate(ts) {
  const d = new Date((ts || 0) + TZ_OFFSET_HOURS * 60 * 60 * 1000);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function parseLocalTime(y, m, d, h, min) {
  return Date.UTC(+y, +m - 1, +d, +h - TZ_OFFSET_HOURS, +min, 0);
}

function parseRelativeTime(text) {
  const t = (text || '').trim();
  const m = t.match(/^(\d{1,4})\s*(分钟|小时|天|周|星期|min|h|d|w|m)\s*(后)?$/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  const now = Date.now();
  if (unit === '分钟' || unit === 'min' || unit === 'm') return now + n * 60 * 1000;
  if (unit === '小时' || unit === 'h') return now + n * 60 * 60 * 1000;
  if (unit === '天' || unit === 'd') return now + n * 24 * 60 * 60 * 1000;
  if (unit === '周' || unit === '星期' || unit === 'w') return now + n * 7 * 24 * 60 * 60 * 1000;
  return null;
}

function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

async function checkBotInChat(chatId, env) {
  try {
    const botToken = process.env.BOT_TOKEN || '';
    const botId = botToken.split(':')[0];
    if (!botId) return false;
    const res = await tgApi(env, 'getChatMember', {
      chat_id: chatId,
      user_id: parseInt(botId),
    });
    if (!res.ok) return false;
    return ['member', 'administrator', 'creator', 'restricted'].includes(res.result.status);
  } catch {
    return false;
  }
}

async function getBotUsername(env) {
  try {
    const cached = await LOTTERY_KV.get('bot_username');
    if (cached) return cached;
    const res = await tgApi(env, 'getMe', {});
    if (res.ok && res.result?.username) {
      const uname = res.result.username;
      await LOTTERY_KV.put('bot_username', uname);
      return uname;
    }
  } catch {}
  return '';
}

async function notifyButton(env) {
  const uname = await getBotUsername(env);
  if (!uname) return null;
  return [
    [{ text: '🔔 开启中奖私信提醒', url: `https://t.me/${uname}?start=notify` }],
    [{ text: '🎟️ 兑奖', url: `https://t.me/${uname}?start=redeem` }],
  ];
}

async function handleRedeemStart(chatId, userId, env) {
  const redeemKey = `my_redeem:${userId}`;
  const rawR = await LOTTERY_KV.get(redeemKey);
  let list = [];
  if (rawR) {
    try { list = JSON.parse(rawR); } catch {}
  }
  if (!list || list.length === 0) {
    return sendMessage(chatId, '🎟️ 你目前**没有待兑奖的奖品**。\n\n💡 参与抽奖并中奖后，bot 会私信通知你，点击通知里的「立即兑奖」即可完成兑奖～', env);
  }
  const lines = list.map((x, i) => `${i + 1}. **${esc(x.name)}**\n   🎁 ${esc(x.prize)}${x.code ? ` · 🎟️ \`${esc(x.code)}\`` : ''}\n   📅 ${fmtDate(x.drawnAt)}\n   · ${esc(x.groupName || '')}`).join('\n\n');
  const kb = [[{ text: '✅ 全部标记已领取', callback_data: 'redeem_clear' }]];
  return sendMsgKb(chatId, `🎟️ **你的中奖记录**：\n\n${lines}\n\n📌 兑奖码已在上方展示；点击「全部标记已领取」可清空本列表。`, kb, env);
}

async function addToGroupIndex(env, groupId, lotteryId) {
  const raw = await LOTTERY_KV.get(`group:${groupId}:lotteries`);
  let ids = safeJsonParse(raw, []);
  ids = ids.filter(id => id !== lotteryId);
  ids.unshift(lotteryId);
  ids = ids.slice(0, 50);
  await LOTTERY_KV.put(`group:${groupId}:lotteries`, JSON.stringify(ids));
}

async function tgApi(env, method, body, retries = 3) {
  const token = process.env.BOT_TOKEN;
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  let retry429 = 0;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (data.ok) return data;
      if (res.status === 429) {
        retry429++;
        if (retry429 > 3) {
          console.warn('[tgApi] 429 重试超限，放弃:', url);
          return null;
        }
        const wait = parseInt(res.headers.get('Retry-After') || '1');
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      console.warn(`TG ${method} error:`, data);
      return data;
    } catch (err) {
      console.warn(`TG ${method} attempt ${i + 1}: ${err?.cause?.code || err?.message || err}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 200 * 2 ** i));
      else throw err;
    }
  }
}

// ---------- 订阅信息查询（妙妙屋X 面板；群内展示，不含订阅链接） ----------
let panelUsersCache = null; // { at, users }
const PANEL_CACHE_TTL = 5 * 60 * 1000;

function mdSafe(s) {
  return String(s ?? '').replace(/[*_`\[\]]/g, '');
}

async function fetchPanelUsers() {
  if (panelUsersCache && Date.now() - panelUsersCache.at < PANEL_CACHE_TTL) return panelUsersCache.users;
  const url = process.env.PANEL_MCP_URL || '';
  const token = process.env.PANEL_MCP_TOKEN || '';
  if (!url || !token) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1000000, method: 'tools/call', params: { name: 'user_list', arguments: {} } }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  const text = data?.result?.content?.[0]?.text;
  if (!text) throw new Error('面板响应异常');
  const users = safeJsonParse(text, {}).users || [];
  panelUsersCache = { at: Date.now(), users };
  return users;
}

async function showMySubscription(chatId, userId, tgUsername, env) {
  let users;
  try {
    users = await fetchPanelUsers();
  } catch (err) {
    return sendMessage(chatId, '⚠️ 查询面板失败，请稍后再试。（' + (err?.cause?.code || err?.message || err) + '）', env);
  }
  if (!users) return sendMessage(chatId, '⚠️ 面板查询未配置（PANEL_MCP_URL / PANEL_MCP_TOKEN）。', env);
  const u = users.find(x => x.telegram_id === userId)
    || users.find(x => x.telegram_username && tgUsername && String(x.telegram_username).toLowerCase() === tgUsername.toLowerCase());
  if (!u) return sendMessage(chatId, '❌ 未找到与你 Telegram 绑定的订阅账号。\n请先到面板「个人设置」绑定 Telegram 后再试。', env);
  const gb = b => (b || 0) / 1073741824;
  const used = gb(u.traffic_used);
  const limit = gb(u.traffic_limit);
  const remain = Math.max(0, limit - used);
  const end = u.package_end_date || '未知';
  let days = null;
  if (u.package_end_date) days = Math.floor((new Date(end + 'T00:00:00+08:00') - Date.now()) / 86400000);
  const lines = [
    '📊 *我的订阅信息*',
    '',
    `👤 ${mdSafe(u.nickname || u.username)}`,
    `📦 套餐：${mdSafe(u.package_name || '无')}`,
    `📈 流量：已用 *${used.toFixed(2)} GB* / 共 ${u.traffic_limit_gb || (limit ? limit.toFixed(0) : '∞')} GB`,
    `余量：剩余 *${remain.toFixed(2)} GB*`,
  ];
  if (u.is_reset && u.reset_day) lines.push(`🔄 每月 ${u.reset_day} 日重置流量`);
  lines.push(days !== null ? `⏳ 到期：${end}${days >= 0 ? `（剩 ${days} 天）` : '（已到期）'}` : `⏳ 到期：${end}`);
  if (u.is_over_limit) lines.push('⚠️ 流量已超额，速度可能受限');
  if (u.is_active === false) lines.push('⛔ 账号已停用，请联系管理员');
  lines.push('', '🔗 订阅链接请到面板「个人设置」查看（为保护账号安全，群内不展示）');
  return sendMessage(chatId, lines.join('\n'), env);
}

async function trafficRankCmd(chatId, userId, tgUsername, env) {
  let users;
  try {
    users = await fetchPanelUsers();
  } catch (err) {
    return sendMessage(chatId, '⚠️ 查询面板失败，请稍后再试。（' + (err?.cause?.code || err?.message || err) + '）', env);
  }
  if (!users) return sendMessage(chatId, '⚠️ 面板查询未配置（PANEL_MCP_URL / PANEL_MCP_TOKEN）。', env);
  const gb = b => (Number(b) || 0) / 1073741824;
  const rows = users
    .filter(u => u && u.username && u.username !== 'admin' && u.is_active !== false)
    .map(u => ({
      name: u.nickname || u.username,
      username: u.username,
      used: gb(u.traffic_used),
      limit: gb(u.traffic_limit),
      tg: u.telegram_id,
      tgName: u.telegram_username,
    }))
    .sort((a, b) => b.used - a.used);
  if (!rows.length) return sendMessage(chatId, '📊 暂无流量数据。', env);
  const maskName = (raw) => {
    const s = String(raw || '');
    const chars = [...s];
    if (chars.length <= 2) return mdSafe(s);
    if (chars.length === 3) return mdSafe(chars[0] + '＊＊' + chars[2]);
    const mid = Math.floor((chars.length - 2) / 2);
    return mdSafe(chars.slice(0, mid).join('') + '＊＊' + chars.slice(mid + 2).join(''));
  };
  const medals = ['🥇', '🥈', '🥉'];
  const topN = Math.min(15, rows.length);
  const lines = [`📊 *流量使用排行榜*（前 ${topN}）\n`];
  for (let i = 0; i < topN; i++) {
    const r = rows[i];
    const mark = medals[i] || `${i + 1}.`;
    const lim = r.limit > 0 ? r.limit.toFixed(0) : '∞';
    const me = (r.tg && Number(r.tg) === Number(userId))
      || (tgUsername && r.tgName && String(r.tgName).toLowerCase() === String(tgUsername).toLowerCase());
    const shown = me ? mdSafe(r.name) : maskName(r.name);
    lines.push(`${mark} ${me ? '*' : ''}${shown}${me ? '*' : ''}  ${r.used.toFixed(2)} / ${lim} GB`);
  }
  const myIdx = rows.findIndex(r =>
    (r.tg && Number(r.tg) === Number(userId))
    || (tgUsername && r.tgName && String(r.tgName).toLowerCase() === String(tgUsername).toLowerCase())
  );
  if (myIdx >= 0) {
    const me = rows[myIdx];
    const lim = me.limit > 0 ? me.limit.toFixed(0) : '∞';
    lines.push('', `📍 你：第 ${myIdx + 1} 名 · ${me.used.toFixed(2)} / ${lim} GB`);
  }
  lines.push('', '数据来自面板已用流量，约 5 分钟刷新一次。');
  return sendMessage(chatId, lines.join('\n'), env);
}

// ---------- BUG 与建议反馈系统 ----------
const FB_STATUS = { open: '🟠 待处理', doing: '🔵 处理中', done: '✅ 已解决' };

// ---------- 管理员判定缓存（群成员状态查询较慢，60 秒内复用结果） ----------
const fbAdminCache = new Map(); // key: chatId:userId → { at, ok }
const FB_ADMIN_CACHE_TTL = 60 * 1000;

async function isFbAdmin(chatId, userId, env) {
  if (fbAdminIds().includes(userId)) return true;
  if (Number(userId) === 1087968824 && chatId < 0) return true; // 匿名群管理员身份
  if (chatId < 0) {
    const ck = chatId + ':' + userId;
    const hit = fbAdminCache.get(ck);
    if (hit && Date.now() - hit.at < FB_ADMIN_CACHE_TTL) return hit.ok;
    const st = await getChatMemberStatus(chatId, userId, env);
    const ok = isAdminStatus(st);
    fbAdminCache.set(ck, { at: Date.now(), ok });
    // LRU 逐条淘汰，避免一次性 clear 导致的性能突刺
    if (fbAdminCache.size > 2000) {
      let count = 0;
      for (const key of fbAdminCache.keys()) {
        fbAdminCache.delete(key);
        count++;
        if (count >= 200) break;
      }
    }
    return ok;
  }
  return false;
}
function fbAdminIds() {
  return String(process.env.BOT_ADMIN_IDS || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
}

async function fbList(filter) {
  const raw = await LOTTERY_KV.get('fb_index');
  const ids = safeJsonParse(raw, []);
  const fbIds = ids.slice(-200);
  const fbs = await Promise.all(fbIds.map(id => kvGetJson(`fb:${id}`, null)));
  const out = [];
  for (const t of fbs) {
    if (t) {
      if (filter === 'all' || t.from.id === filter) out.push(t);
    }
  }
  return out.reverse();
}

function fbFormat(t, showFrom) {
  const type = t.type === 'bug' ? '🐞 BUG' : '💡 建议';
  const prev = mdSafe(t.content.length > 80 ? t.content.slice(0, 80) + '…' : t.content);
  let line = `${type} *#${t.id}* ${FB_STATUS[t.status] || t.status}\n${prev}`;
  if (showFrom) line += `\n来自:${mdSafe(t.from.name)}${t.from.username ? ' @' + mdSafe(t.from.username) : ''}${t.chat ? ' · ' + mdSafe(t.chat) : ''}`;
  if (t.reply) line += `\n💬 回复:${mdSafe(t.reply)}`;
  return line;
}

async function feedbackCmd(chatId, userId, fromName, username, type, content, chatTitle, env) {
  content = (content || '').trim();
  if (!content) return sendMessage(chatId, type === 'bug' ? '用法:/bug 内容 — 提交 BUG\n示例:/bug 抽奖按钮点了没反应' : '用法:/suggest 内容 — 提交建议\n示例:/suggest 希望支持定时开奖', env);
  if (content.length > 1000) content = content.slice(0, 1000);
  const raw = await LOTTERY_KV.get('fb_index');
  const ids = safeJsonParse(raw, []);
  const id = ids.length ? Math.max(...ids) + 1 : 1;
  ids.push(id);
  await LOTTERY_KV.put('fb_index', JSON.stringify(ids));
  const ticket = { id, type, content, from: { id: userId, name: fromName, username: username || '' }, chat: chatTitle || '', chatId, status: 'open', reply: '', created_at: Date.now(), rewarded: false };
  await LOTTERY_KV.put(`fb:${id}`, JSON.stringify(ticket));
  await sendMessage(chatId, `✅ ${type === 'bug' ? 'BUG' : '建议'} *#${id}* 已提交！\n\n${mdSafe(content.slice(0, 200))}\n\n处理进度可随时用 /issues 查看。`, env);
  const admins = fbAdminIds();
  for (const aid of admins) {
    if (aid === userId) continue;
    const nkb = [[{ text: '✅ 已解决', callback_data: `fbnote|${id}|done` }, { text: '🔵 处理中', callback_data: `fbnote|${id}|doing` }, { text: '📋 全部', callback_data: 'fball' }]];
    await sendMsgKb(aid, `🔔 ${type === 'bug' ? '🐞 新 BUG' : '💡 新建议'} *#${id}*\n来自:${mdSafe(fromName)}${username ? ' @' + mdSafe(username) : ''}\n群:${mdSafe(chatTitle || '私聊')}\n\n${mdSafe(content.slice(0, 500))}`, nkb, env);
  }
}

async function myIssuesCmd(chatId, userId, env) {
  const list = (await fbList(userId)).slice(0, 10);
  if (!list.length) return sendMessage(chatId, '📭 你还没有提交过 BUG 或建议。\n\n/bug 内容 — 提交 BUG\n/suggest 内容 — 提交建议', env);
  let text = '📋 *我的反馈进度*\n\n' + list.map(t => fbFormat(t, false)).join('\n\n');
  if (list.length >= 10) text += '\n\n(仅显示最近 10 条)';
  if (await isFbAdmin(chatId, userId, env)) text += '\n\n🛠 管理员:查看全部反馈 /ibugs';
  return sendMessage(chatId, text, env);
}

const FB_PAGE_SIZE = 5;
async function fbRenderAll(chatId, msgId, env, opts) {
  opts = opts || {};
  const adminV = opts.admin === true;
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const list = await fbList('all');
  const pages = Math.max(1, Math.ceil(list.length / FB_PAGE_SIZE));
  const pg = Math.min(page, pages);
  const chunk = list.slice((pg - 1) * FB_PAGE_SIZE, pg * FB_PAGE_SIZE);
  let text;
  const kb = [];
  if (!chunk.length) {
    text = '📭 还没有用户提交 BUG 或建议。';
    if (msgId) return editMsg(chatId, msgId, text, env);
    return sendMessage(chatId, text, env);
  }
  text = `🐞 *全部反馈*（第 ${pg}/${pages} 页 · 共 ${list.length} 条）\n\n` + chunk.map(t => fbFormat(t, adminV)).join('\n\n');
  if (adminV) {
    for (const t of chunk) {
      if (t.status !== 'done') kb.push([{ text: `🔵处理中#${t.id}`, callback_data: `fbset|${t.id}|doing` }, { text: `✅已解决#${t.id}`, callback_data: `fbset|${t.id}|done` }]);
    }
  }
  const nav = [];
  if (pg > 1) nav.push({ text: '⬅️', callback_data: `fbpage|${pg - 1}|${adminV ? 1 : 0}` });
  nav.push({ text: `${pg}/${pages}`, callback_data: 'noop' });
  if (pg < pages) nav.push({ text: '➡️', callback_data: `fbpage|${pg + 1}|${adminV ? 1 : 0}` });
  if (nav.length > 1) kb.push(nav);
  if (msgId) return editMsg(chatId, msgId, text, env, kb);
  return sendMsgKb(chatId, text, kb, env);
}

// ---------- 每日签到（对接抽奖中心，签到有几率掉落抽奖次数） ----------
function cnDateStr() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }

async function luckyApi(path, body) {
  const base = process.env.LUCKY_API_URL || 'http://127.0.0.1:3100';
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-admin-pw': process.env.LUCKY_ADMIN_PASSWORD || '' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

async function cmdCheckin(chatId, userId, fromName, msgId, env) {
  const r = await lucky.checkin(userId, fromName || '');
  if (!r || r.ok === false) {
    if (r && r.needPrivate) return sendMessage(chatId, '❌ 请先私聊机器人发任意消息完成初始化，再回群使用 /checkin。', env);
    return sendMessage(chatId, (r && r.error) || '签到失败，请稍后再试。', env);
  }
  let text = `✅ *${mdSafe(fromName)}* 签到成功！\n`;
  text += '📈 签到送积分 +10（当前 ' + r.points + '）\n';
  if (r.gotDraw) {
    text += '🎉 恭喜！掉落 1 次抽奖机会！\n🍀 下次掉落概率：1%（已重置）';
  } else {
    text += '🎲 本次未掉落\n🍀 下次掉落概率：' + r.nextProb + '%';
  }
  text += '\n\n🎰 剩余抽奖次数：' + r.drawLeft;
  return sendMessage(chatId, text, env);
}
async function bindLuckyCmd(chatId, userId, args, env) {
  return sendMessage(chatId, 'ℹ️ 抽奖中心已停用，无需再绑定抽奖中心账号。\n\n签到/抽奖直接可用：/checkin、/draw\n兑换流量或时长请先绑定 mmwx：/bindmmwx 你的mmwx用户名', env);
}

async function drawUnitPrice() {
  const items = await getMall();
  const it = items.find(x => x.type === 'draws' && x.value > 0);
  if (it) return Math.max(1, Math.ceil(it.price / it.value));
  return 15;
}

async function ensureDrawTickets(userId, need, username) {
  lucky.ensureUser(userId, username || '');
  const bag = await lucky.getUserBag(userId);
  const have = (bag && bag.ok) ? (bag.drawLeft || 0) : 0;
  if (have >= need) return { ok: true, spent: 0, left: parseInt(await LOTTERY_KV.get(`points:${userId}`) || '0', 10) };
  const missing = need - have;
  const unit = await drawUnitPrice();
  const cost = missing * unit;
  const k = `points:${userId}`;
  const my = parseInt(await LOTTERY_KV.get(k) || '0', 10);
  if (my < cost) {
    return {
      ok: false,
      error: `❌ 抽奖次数不足（剩余 ${have} 次）。\n商城积分：${my}，再抽 ${missing} 次需要 ${cost} 积分（${unit} 积分/次）。\n群内发言可赚积分，或先 /mall 兑换。`,
    };
  }
  await LOTTERY_KV.put(k, String(my - cost));
  lucky.adminGrantDraws(userId, missing);
  return { ok: true, spent: cost, granted: missing, left: my - cost };
}

async function luckyDrawCmd(chatId, userId, fromName, arg, env) {
  arg = (arg || '').trim();
  lucky.ensureUser(userId, fromName || '');
  const bag = await lucky.getUserBag(userId);
  const have = (bag && bag.ok) ? (bag.drawLeft || 0) : 0;
  let count;
  if (arg) {
    count = parseInt(arg, 10);
    if (!count || count < 1) return sendMessage(chatId, '用法：/lottery（使用剩余次数，单次上限100）或 /lottery 次数（1-100）', env);
    if (count > 100) count = 100;
  } else {
    count = have > 0 ? Math.min(have, 100) : 1;
  }
  const pay = await ensureDrawTickets(userId, count, fromName);
  if (!pay.ok) return sendMessage(chatId, pay.error, env);
  const r = await lucky.draw(userId, count, fromName);
  if (!r.ok) return sendMessage(chatId, r.error, env);
  const agg = new Map();
  for (const p of r.prizes) {
    const key = `${p.icon} ${p.name}`;
    agg.set(key, (agg.get(key) || 0) + (p.count || 1));
  }
  const summary = [...agg.entries()].map(([k, v]) => `${mdSafe(k)} ×${v}`).join('\n') || '（本轮无中奖）';
  const lines = [
    `🎰 *${mdSafe(fromName)}* 的抽奖结果`,
    `共抽奖 ${count} 次：`,
    summary,
  ];
  lines.push('', `🎰 剩余抽奖次数：${r.drawLeft}` + (pay.spent ? `\n💰 本次用商城积分兑换 ${pay.granted} 次（-${pay.spent} 分，余额 ${pay.left}）` : ''), '背包：/bag · 再抽：/draw');
  return sendMessage(chatId, lines.join('\n'), env);
}

async function luckyBagCmd(chatId, userId, env) {
  const r = await lucky.getUserBag(userId);
  if (!r.ok) return sendMessage(chatId, '❌ 请先私聊机器人发任意消息完成初始化。', env);
  const mallPts = parseInt(await LOTTERY_KV.get(`points:${userId}`) || '0', 10);
  let lines = [`🎒 *${mdSafe(userId)}* 的背包\n`];
  lines.push(`💰 商城积分：${mallPts}（群内发言获得，可 /mall 兑换）`);
  lines.push(`🎰 抽奖次数：${r.drawLeft}`);
  if (r.inventory.length) {
    lines.push('\n物品：');
    for (const it of r.inventory.slice(0, 20)) {
      lines.push(`· ${mdSafe(it.icon || '')} ${mdSafe(it.name)} ×${it.count}`);
    }
    if (r.inventory.length > 20) lines.push(`…其余 ${r.inventory.length - 20} 类省略`);
  } else {
    lines.push('\n背包是空的，快去 /checkin 赢抽奖次数吧！');
  }
  lines.push('\n抽奖：/draw · 兑换流量/时长：/exchange 物品名（先 /bindmmwx 绑定）');
  return sendMessage(chatId, lines.join('\n'), env);
}

// ---------- 积分与积分商城 ----------
function fmtEffect(type, value) {
  if (type === 'draws') return `抽奖次数 +${value}`;
  if (type === 'traffic') return `流量 +${value}G`;
  if (type === 'days') return `时长 +${value} 天`;
  return type || '无';
}

async function getMall() {
  const raw = await LOTTERY_KV.get('mall_list');
  return safeJsonParse(raw, []);
}

async function pointsCmd(chatId, userId, env) {
  const my = await getPoints(userId);
  // 优先用内存排行榜快照
  if (pointsRankCache.length > 0) {
    const top = pointsRankCache.slice(0, 10).map(x => ({ uid: x.uid, v: x.points, name: x.name || `用户${x.uid}` }));
    let text = `💰 *我的积分：${my}*\n\n🏆 积分排行\n`;
    text += (top.slice(0, 5).map((t, i) => `${i + 1}. ${t.name} — ${t.v} 分`).join('\n') || '暂无');
    text += '\n\n🛒 商城：/mall';
    return sendMessage(chatId, text, env);
  }
  // 快照为空，回退到 N+1 查询（Promise.all 并发）
  const idxRaw = await LOTTERY_KV.get('points_index');
  const idx = [...new Set((safeJsonParse(idxRaw, [])).map(x => String(x)))];
  const results = await Promise.all(idx.map(async uid => ({
    uid,
    v: parseInt(await LOTTERY_KV.get(`points:${uid}`) || '0', 10),
    name: await LOTTERY_KV.get(`points_name:${uid}`) || `用户${uid}`
  })));
  const top = results.filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  let text = `💰 *我的积分：${my}*\n\n🏆 积分排行\n`;
  text += (top.slice(0, 5).map((t, i) => `${i + 1}. ${t.name} — ${t.v} 分`).join('\n') || '暂无');
  text += '\n\n🛒 商城：/mall';
  return sendMessage(chatId, text, env);
}
async function mallCmd(chatId, userId, env) {
  const items = await getMall();
  const my = parseInt(await LOTTERY_KV.get(`points:${userId}`) || '0', 10);
  if (!items.length) return sendMessage(chatId, `🛒 积分商城暂未上架商品。\n\n你的积分：${my}（在群里发言即可赚积分）`, env);
  const adm = await isFbAdmin(chatId, userId, env);
  let text = `🛒 *积分商城*（我的积分：${my}）\n\n`;
  const kb = [];
  items.forEach((it, i) => {
    const n = i + 1;
    text += `*${n}.* ${it.name} — ${it.price} 分\n   效果：${fmtEffect(it.type, it.value)}\n`;
    const row = [{ text: `🎯 兑换 #${n}`, callback_data: `mallbuy|${it.id}` }];
    if (adm) row.push({ text: `🗑 下架 #${n}`, callback_data: `mallrm|${it.id}` });
    kb.push(row);
  });
  if (adm) kb.push([{ text: '➕ 上架商品', callback_data: 'malladd' }]);
  kb.push([{ text: '🔄 刷新', callback_data: 'mallrefresh' }]);
  return sendMsgKb(chatId, text, kb, env);
}

async function buyCmd(chatId, userId, fromName, args, env) {
  const n = parseInt((args || '').trim(), 10);
  if (!n) return sendMessage(chatId, '用法：/buy 序号（先 /mall 查看商城）', env);
  const items = await getMall();
  const it = items[n - 1];
  if (!it) return sendMessage(chatId, '❌ 没有这个商品序号。', env);
  const k = `points:${userId}`;
  const my = parseInt(await LOTTERY_KV.get(k) || '0', 10);
  if (my < it.price) return sendMessage(chatId, `❌ 积分不足（需要 ${it.price}，你有 ${my}）。\n多在群里发言赚积分吧！`, env);
  let okMsg = '';
  if (it.type === 'draws') {
    lucky.ensureUser(userId, fromName || '');
    const r = lucky.adminGrantDraws(userId, it.value);
    if (!r || r.ok === false) return sendMessage(chatId, '⚠️ 发放失败，积分未扣除', env);
    okMsg = `${fmtEffect(it.type, it.value)} 已到账抽奖次数`;
  } else if (it.type === 'traffic' || it.type === 'days') {
    const mmwxName = await lucky.getMmwxBind(userId);
    if (!mmwxName) return sendMessage(chatId, '❌ 请先私聊发送 /bindmmwx 你的mmwx用户名 绑定账号，再兑换流量/时长。', env);
    const gr = await grantToMmwx(mmwxName, { type: it.type, gb: it.type === 'traffic' ? (it.value || 0) : 0, days: it.type === 'days' ? (it.value || 0) : 0 });
    if (!gr.ok) return sendMessage(chatId, '⚠️ 发放失败，积分未扣除：' + gr.error + '\n（可稍后重试 /buy ' + n + '）', env);
    okMsg = gr.message || fmtEffect(it.type, it.value);
  } else {
    okMsg = '兑换成功，请联系管理员领取。';
  }
  await LOTTERY_KV.put(k, String(my - it.price));
  return sendMessage(chatId, `✅ *${mdSafe(fromName)}* 兑换成功！\n${okMsg}\n消耗 ${it.price} 积分，余额 ${my - it.price} 分。`, env);
}

async function mallAddCmd(chatId, args, env) {
  const parts = (args || '').trim().split(/\s+/);
  const price = parseInt(parts[0], 10);
  const effect = parts[parts.length - 1] || '';
  const name = parts.slice(1, parts.length - 1).join(' ');
  if (!price || price < 1 || !name || parts.length < 4) return sendMessage(chatId, '用法：/mall_add 价格 名称 效果\n效果三选一：draws:次数 | traffic:GB | days:天数\n示例：/mall_add 100 10次抽奖 draws:10', env);
  let type = 'none', value = 0;
  const m = effect.match(/^(draws|traffic|days):(\d+)$/);
  if (m) { type = m[1]; value = parseInt(m[2], 10); }
  else if (effect !== 'none') return sendMessage(chatId, '效果格式不对：' + effect + '\n应为 draws:N / traffic:GB / days:N / none', env);
  const items = await getMall();
  const id = items.length ? Math.max(...items.map(x => x.id)) + 1 : 1;
  items.push({ id, name: mdSafe(name), price, type, value });
  await LOTTERY_KV.put('mall_list', JSON.stringify(items));
  return sendMessage(chatId, `✅ 商品已上架 #${items.length}：${mdSafe(name)}（${price} 分，效果：${fmtEffect(type, value)}）\n下架：/mall_del ${items.length}`, env);
}

async function mallDelCmd(chatId, args, env) {
  const n = parseInt((args || '').trim(), 10);
  const items = await getMall();
  if (!n || n < 1 || n > items.length) return sendMessage(chatId, '❌ 没有这个序号。', env);
  const rm = items.splice(n - 1, 1)[0];
  await LOTTERY_KV.put('mall_list', JSON.stringify(items));
  return sendMessage(chatId, `✅ 已下架 #${n} ${rm.name}`, env);
}

// ---------- 奖池同步与参与（对接抽奖中心，消耗群聊积分） ----------
async function poolAnnounceTargets() {
  const custom = String(process.env.POOL_ANNOUNCE_CHATS || '').split(',').map(x => parseInt(x.trim(), 10)).filter(n => n < 0);
  if (custom.length) return custom;
  const groups = await getBotGroups(null);
  return groups.map(g => g.id);
}

function fmtPoolPrizes(p) {
  return (p.prizes || []).map(z => `${mdSafe(z.name)}×${z.copies}`).join('、');
}

async function announcePoolOpen(p) {
  const targets = await poolAnnounceTargets();
  const text = [
    '🎊 *新抽奖池开启！*',
    `🏷 ${mdSafe(p.title)}`,
    `🎁 奖品：${fmtPoolPrizes(p)}`,
    `🎫 ${p.ticketCost} 积分/张（群聊发言赚积分）`,
    `👥 已参与 ${p.participants.length} 人 · 已售 ${p.ticketsSold} 张`,
    `⏰ 开奖时间：${fmtDate(p.drawAt)}`,
    '',
    '参与方式：/pool 查看奖池 → /pool ' + p.id + ' 张数',
].join('\n');
  for (const cid of targets) { if (await grpFeature(cid, 'pool')) await sendMessage(cid, text, null).catch(() => null); }
}

async function announcePoolDraw(p) {
  const targets = await poolAnnounceTargets();
  const winners = p.winners || [];
  const lines = ['🏆 *抽奖池开奖！*', `🏷 ${mdSafe(p.title)}`, ''];
  if (winners.length) {
    lines.push('🎁 中奖名单：');
    for (const w of winners) {
      const pname = (w.prizeName || (w.prize && w.prize.name) || '奖品');
      const flag = w.ok ? '✅' : (!w.mname ? '⚠️ 未绑定mmwx（请 /bindmmwx 后找管理员补发）' : `⚠️ 发放失败：${mdSafe(w.err || '未知错误')}`);
      const mention = w.tgId ? `<a href="tg://user?id=${w.tgId}">${mdSafe(w.username)}</a>` : mdSafe(w.username);
      lines.push(`🏆 ${mention} 恭喜获得 ${mdSafe(String(pname))} ${flag}`);
    }
    lines.push('', '奖品已自动发放到中奖者的 mmwx 账号（未绑定的请 /bindmmwx 后找管理员补发）');
  } else {
    lines.push('本轮无中奖。');
  }
  const text = lines.join('\n');
  for (const cid of targets) { if (await grpFeature(cid, 'pool')) await sendHtml(cid, text, null).catch(() => null); }
}

async function handlePoolCancelled(p) {
  const targets = await poolAnnounceTargets();
  let refunded = 0;
  for (const pp of (p.participants || [])) {
    const tg = pp.tgId ? String(pp.tgId) : await LOTTERY_KV.get(`lucky_bind_rev:${pp.username}`);
    if (!tg) continue;
    const k = `points:${tg}`;
    const cur = parseInt(await LOTTERY_KV.get(k) || '0', 10);
    const back = (pp.tickets || 0) * (p.ticketCost || 0);
    await LOTTERY_KV.put(k, String(cur + back));
    refunded += back;
  }
  const note = p.note ? `（${mdSafe(p.note)}）` : '';
  const text = `⚠️ 抽奖池「${mdSafe(p.title)}」已取消${note}\n${refunded > 0 ? `已退还群聊积分共 ${refunded} 分` : '参与记录无需退款'}`;
  for (const cid of targets) { if (await grpFeature(cid, 'pool')) await sendMessage(cid, text, null).catch(() => null); }
}

// 本地开奖：按奖券加权随机，逐人发放到 mmwx（发奖直连，不经抽奖中心）
async function localPoolDraw(p) {
  const allTickets = [];
  for (const pp of (p.participants || [])) {
    const n = pp.tickets || 0;
    for (let i = 0; i < n; i++) allTickets.push(pp);
  }
  const winners = [];
  if (allTickets.length) {
    const pool = [...allTickets];
    let prizeIdx = 0, prizeLeft = p.prizes[0] ? p.prizes[0].copies : 0;
    while (prizeIdx < p.prizes.length && pool.length) {
      const idx = Math.floor(Math.random() * pool.length);
      const wpp = pool.splice(idx, 1)[0];
      const pz = p.prizes[prizeIdx];
      // 发放到中奖者的 mmwx 账号
      let ok = false, mname = null, gerr = '';
      if (wpp.tgId) mname = await lucky.getMmwxBind(wpp.tgId);
      if (mname) {
        const gr = await grantToMmwx(mname, { type: pz.type, gb: pz.gb || 0, days: pz.days || 0 });
        ok = gr.ok;
        gerr = gr.ok ? '' : (gr.error || '发放失败');
      }
      winners.push({ username: mname || ('TG ' + wpp.tgId), tgId: wpp.tgId, prizeName: pz.name, prize: pz, ok, mname, err: gerr });
      prizeLeft--;
      if (prizeLeft <= 0) { prizeIdx++; prizeLeft = p.prizes[prizeIdx] ? p.prizes[prizeIdx].copies : 0; }
    }
  }
  p.status = 'drawn';
  p.winners = winners;
  p.drawnAt = Date.now();
  p.grantResults = winners.map(w => ({ name: w.username, ok: w.ok, err: w.err }));
  // 同步回本地列表
  const list = safeJsonParse(await LOTTERY_KV.get('pool_list'), []);
  const li = list.findIndex(x => String(x.id) === String(p.id));
  if (li >= 0) list[li] = p; else list.push(p);
  await LOTTERY_KV.put('pool_list', JSON.stringify(list));
  await LOTTERY_KV.put(`pool_state:${p.id}`, JSON.stringify(p));
  await announcePoolDraw(p);
}

// 奖池同步：本地池开奖检测（替代抽奖中心 /api/pools 轮询）
async function poolSyncTick() {
  try {
    const now = Date.now();
    const list = safeJsonParse(await LOTTERY_KV.get('pool_list'), []);
    for (const p of list) {
      if (p.status === 'open' && p.drawAt && now >= p.drawAt) {
        await localPoolDraw(p);
      }
    }
  } catch (err) {
    console.error('[pool-sync] error:', err?.message || err);
  }
}

async function poolCmd(chatId, userId, fromName, args, env) {
  const arg = (args || '').trim();
  const allPools = safeJsonParse(await LOTTERY_KV.get('pool_list'), []);
  const now = Date.now();
  const pools = allPools.filter(x => x.status === 'open' && (!x.drawAt || now < x.drawAt));
  if (arg) {
    const parts = arg.split(/\s+/);
    const pid = parts[0];
    const count = Math.max(1, parseInt(parts[1] || '1', 10));
    let p = pools.find(x => String(x.id) === pid);
    if (!p) {
      const anyP = allPools.find(x => String(x.id) === pid);
      if (anyP && anyP.status === 'cancelled') return sendMessage(chatId, '⏰ 该奖池已取消' + (anyP.note ? '（' + mdSafe(anyP.note) + '）' : '') + '。', env);
      if (anyP && (anyP.status === 'drawn' || (anyP.drawAt && now >= anyP.drawAt))) return sendMessage(chatId, '🏁 该奖池已开奖，请看上方的开奖播报。', env);
      return sendMessage(chatId, '❌ 奖池不存在。请用 /pool 查看进行中的奖池编号。', env);
    }
    const cost = count * (p.ticketCost || POOL_TICKET_COST);
    const k = `points:${userId}`;
    const my = parseInt(await LOTTERY_KV.get(k) || '0', 10);
    if (my < cost) return sendMessage(chatId, `❌ 积分不足（需 ${cost}，你有 ${my}）。在群里发言可赚积分！`, env);
    // 记录参与（本地，按 tgId）
    if (!p.participants) p.participants = [];
    const existing = p.participants.find(x => String(x.tgId) === String(userId));
    if (existing) { existing.tickets = (existing.tickets || 0) + count; existing.joinedAt = now; }
    else { p.participants.push({ tgId: userId, tickets: count, joinedAt: now }); }
    p.ticketsSold = (p.ticketsSold || 0) + count;
    p.status = 'open';
    const list = safeJsonParse(await LOTTERY_KV.get('pool_list'), []);
    const li = list.findIndex(x => String(x.id) === String(p.id));
    if (li >= 0) list[li] = p; else list.push(p);
    await LOTTERY_KV.put('pool_list', JSON.stringify(list));
    await LOTTERY_KV.put(k, String(my - cost));
    const mention = `<a href="tg://user?id=${userId}">${mdSafe(fromName)}</a>`;
    return sendHtml(chatId, `✅ ${mention} 参与成功！祝你好运 🍀\n🎟 奖券 +${count}（当前 ${existing ? existing.tickets : count} 张）\n消耗 ${cost} 积分，余额 ${my - cost} 分\n⏰ 开奖：${fmtDate(p.drawAt)}\n\n（中奖后自动发放到你绑定的 mmwx 账号，未绑定请先 /bindmmwx）`, env);
  }
  let text = '🎟 *抽奖奖池*（消耗群聊积分参与，中奖自动发到 mmwx）\n';
  if (!pools.length) text += '\n暂无进行中的奖池。';
  pools.slice(0, 10).forEach(x => {
    const cap = x.maxTicketsPerUser > 9999 ? '不限' : `每人${x.maxTicketsPerUser}张`;
    text += `\n*#${x.id}* ${mdSafe(x.title)}\n🎁 ${fmtPoolPrizes(x)}\n🎫 ${x.ticketCost} 积分/张 · ${cap} · 参与 ${x.participants.length} 人 · 已售 ${x.ticketsSold} 张\n⏰ 开奖：${fmtDate(x.drawAt)}\n参与：/pool ${x.id} 张数\n`;
  });
  return sendMessage(chatId, text, env);
}

// ---------- 群功能开关(管理员 /settings) ----------
const GRP_FEATURES = [
  ['checkin', '📅 签到'],
  ['lottery', '🎰 幸运抽奖/背包'],
  ['pool', '🎟 奖池'],
  ['points', '💰 发言积分'],
  ['mall', '🛒 积分商城'],
  ['subinfo', '📊 订阅查询'],
  ['traffic', '📊 流量排行'],
  ['feedback', '🐞 BUG反馈'],
  ['autodelete', '🗑 指令30秒删除'],
];
const GRP_CMD_FEAT = { '/checkin': 'checkin', '/lottery': 'lottery', '/抽奖': 'lottery', '/choujiang': 'lottery', '/bag': 'lottery', '/pool': 'pool', '/subinfo': 'subinfo', '/traffic': 'traffic', '/流量': 'traffic', '/流量榜': 'traffic', '/points': 'points', '/积分': 'points', '/mall': 'mall', '/商城': 'mall', '/buy': 'mall', '/bug': 'feedback', '/suggest': 'feedback', '/issues': 'feedback' };
async function grpFeature(chatId, key) {
  const raw = await LOTTERY_KV.get(`grp_settings:${chatId}`);
  if (!raw) return true;
  try { const st = JSON.parse(raw); return st[key] !== false; } catch (e) { return true; }
}

async function grpSettingsRender(chatId, msgId, env) {
  const raw = await LOTTERY_KV.get(`grp_settings:${chatId}`);
  let st = {};
  try { st = raw ? JSON.parse(raw) : {}; } catch (e) {}
  const rows = [];
  for (let i = 0; i < GRP_FEATURES.length; i += 2) {
    rows.push(GRP_FEATURES.slice(i, i + 2).map(([k, label]) => ({ text: (st[k] !== false ? '✅ ' : '⛔ ') + label, callback_data: `gset|${k}` })));
  }
  rows.push([{ text: '✅ 完成并关闭', callback_data: 'gsetdone' }]);
  const text = '⚙️ *功能开关（本群）*\n\n点击切换开/关，立即生效。\n关闭后本群成员使用对应指令会提示已关闭。';
  if (msgId) return editMsg(chatId, msgId, text, env, rows);
  return sendMsgKb(chatId, text, rows, env);
}

// 反馈解决确认:管理员标记已解决后,发回来源群让提交人确认(确认奖励抽奖;此消息不自动删除)
async function fbNotifyResolved(t, env) {
  if (!t.chatId || t.status !== 'done') return;
  if (t.confirmSent) return;
  const raw2 = await LOTTERY_KV.get(`fb:${t.id}`);
  if (raw2) {
    const cur = safeJsonParse(raw2, {});
    if (cur.confirmSent) { t.confirmSent = true; return; }
    cur.confirmSent = true;
    await LOTTERY_KV.put(`fb:${t.id}`, JSON.stringify(cur));
  }
  const ckb = [[{ text: '✅ 已解决(领奖励)', callback_data: `fbconfirm|${t.id}|yes` }, { text: '❌ 未解决', callback_data: `fbconfirm|${t.id}|no` }]];
  const text = `🔧 管理员已将你的反馈 *#${t.id}* 标记为已解决\n「${mdSafe((t.content || '').slice(0, 100))}」\n\n提交人请确认问题是否解决（确认后奖励 1 次抽奖机会）:`;
  await sendMsgKb(t.chatId, text, ckb, env).catch(() => null);
}

// ---------- 奖池创建(同步生成到抽奖中心;券价固定2积分,单人投入无上限) ----------
function parsePoolPrizes(spec) {
  const out = [];
  for (const part of spec.split(/[,，]/)) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.+?)\s*[xX×]\s*(\d+)$/);
    const name = (m ? m[1] : s).trim();
    const copies = m ? parseInt(m[2], 10) : 1;
    let type = null, gb = 0, days = 0;
    let mm = name.match(/^(\d+)\s*G\s*流量$/);
    if (mm) { type = 'traffic'; gb = parseInt(mm[1], 10); }
    mm = name.match(/^(\d+)\s*天\s*时长$/);
    if (mm) { type = 'days'; days = parseInt(mm[1], 10); }
    if (!type) return { error: '奖品格式无法识别：「' + s + '」（示例：5G流量x2 或 1天时长x3）' };
    out.push({ name: (gb ? gb + 'G 流量' : days + ' 天时长'), type, gb, days, copies });
  }
  return { prizes: out };
}

const POOL_TICKET_COST = 2;       // 每张奖券消耗群聊积分
const POOL_MAX_PER_USER = 999999; // 单人投入无上限(只要有积分)

async function poolCreateCmd(chatId, userId, args, env) {
  const parts = (args || '').split('|').map(x => x.trim());
  const title = parts[0] || '';
  const minutes = parseInt(parts[1], 10);
  const prizeSpec = parts[2] || '';
  const ticketCost = parts[3] ? parseInt(parts[3], 10) : POOL_TICKET_COST;
  if (!title || !parts[1] || !prizeSpec) return sendMessage(chatId, '用法：/poolcreate 标题 | 开奖分钟 | 奖品列表 | 券价(可选,默认2)\n\n示例：/poolcreate 周末大奖 | 60 | 5G流量x2, 1天时长x3 | 10\n（第4段=每张券消耗积分,不填默认2；单人投入无上限；奖品示例：5G流量x2、1天时长x3）', env);
  if (parts[3] && (!ticketCost || ticketCost < 1)) return sendMessage(chatId, '❌ 券价必须 ≥ 1 积分（第 4 段）。', env);
  if (!minutes || minutes < 1) return sendMessage(chatId, '❌ 开奖分钟至少为 1。', env);
  const pp = parsePoolPrizes(prizeSpec);
  if (pp.error) return sendMessage(chatId, '❌ ' + pp.error, env);
  if (!pp.prizes.length) return sendMessage(chatId, '❌ 至少需要一个奖品。', env);
  // 本地建池（不再同步到抽奖中心）
  const list = safeJsonParse(await LOTTERY_KV.get('pool_list'), []);
  const pid = list.length ? Math.max(...list.map(x => x.id)) + 1 : 1;
  const p = {
    id: pid,
    title: mdSafe(title),
    drawAt: Date.now() + minutes * 60000,
    prizes: pp.prizes,
    ticketCost: ticketCost,
    maxTicketsPerUser: POOL_MAX_PER_USER,
    status: 'open',
    participants: [],
    ticketsSold: 0,
    winners: [],
    createdAt: Date.now(),
  };
  list.push(p);
  await LOTTERY_KV.put('pool_list', JSON.stringify(list));
  await LOTTERY_KV.put(`pool_state:${pid}`, JSON.stringify(p));
  const prizeText = pp.prizes.map(z => `${z.name}×${z.copies}`).join('、');
  await announcePoolOpen(p);
  return sendMessage(chatId, `✅ 奖池已创建（本地开奖，中奖自动发到 mmwx）！\n🏷 ${mdSafe(title)}\n🎁 ${prizeText}\n🎫 ${ticketCost} 积分/张 · 单人投入无上限\n⏰ ${minutes} 分钟后开奖\n编号:${pid}\n\n群内已播报，成员用 /pool ${pid} 张数 参与`, env);
}

// ---------- mmwx 绑定管理(管理员) ----------
async function bindingsCmd(chatId, msgId, env) {
  const listed = await LOTTERY_KV.list({ prefix: 'mmwx_bind:' });
  const tgIds = listed.keys.map(k => k.name.slice('mmwx_bind:'.length));
  if (!tgIds.length) {
    const empty = '📭 还没有任何 TG 账号绑定 mmwx。\n绑定命令：/bindmmwx 你的mmwx用户名（兑换流量/时长、奖池中奖发放都靠它）';
    if (msgId) return editMsg(chatId, msgId, empty, env);
    return sendMessage(chatId, empty, env);
  }
  const lines = ['🔗 *TG ↔ mmwx 绑定列表*（共 ' + tgIds.length + '）\n'];
  const kb = [];
  for (const tg of tgIds) {
    const uname = await LOTTERY_KV.get(`mmwx_bind:${tg}`);
    const pname = (await LOTTERY_KV.get(`points_name:${tg}`)) || ('TG ' + tg);
    lines.push(`👤 ${mdSafe(pname)} ↔ 📦 ${mdSafe(uname || '?')}`);
    kb.push([{ text: `🔓 解绑 ${mdSafe(uname || tg)}`, callback_data: `unmmwx|${tg}` }]);
  }
  const text = lines.join('\n');
  if (msgId) return editMsg(chatId, msgId, text, env, kb);
  return sendMsgKb(chatId, text, kb, env);
}

// ---------- 管理员发放积分 ----------
async function giveCmd(chatId, userId, fromName, msg, args, chatType, env) {
  if (!(await isFbAdmin(chatId, userId, env))) return sendMessage(chatId, '⛔ 仅管理员可用 /give。', env);
  const parts = (args || '').trim().split(/\s+/).filter(Boolean);
  const replied = msg.reply_to_message;
  let targetId = null, targetLabel = '', amount = 0;
  if (parts.length === 1 && /^\d+$/.test(parts[0]) && replied && replied.from) {
    // 回复某人消息:/give 数量
    targetId = String(replied.from.id);
    amount = parseInt(parts[0], 10);
    targetLabel = mdSafe(replied.from.first_name || replied.from.username || targetId);
  } else if (parts.length >= 2) {
    amount = parseInt(parts[parts.length - 1], 10);
    const tgt = parts[0];
    if (/^-?\d+$/.test(tgt)) {
      targetId = String(parseInt(tgt, 10));
      targetLabel = 'TG ' + targetId;
    } else if (tgt.startsWith('@')) {
      // @用户名:当前群成员注册表反查
      const rawGM = await LOTTERY_KV.get(`gm:${chatId}`);
      let gm = {};
      try { gm = rawGM ? JSON.parse(rawGM) : {}; } catch (e) {}
      const entry = Object.entries(gm).find(([id, info]) => (info.name || '').toLowerCase() === tgt.slice(1).toLowerCase());
      if (!entry) return sendMessage(chatId, '❌ 在本群成员中找不到 ' + tgt + '（对方需要在群里发过言）。也可以直接用数字 ID：/give 用户ID 数量', env);
      targetId = entry[0];
      targetLabel = mdSafe(entry[1].name || tgt);
    } else return sendMessage(chatId, '用法：/give @用户名 数量 或 /give 用户ID 数量，或回复某人消息发 /give 数量', env);
  } else return sendMessage(chatId, '用法：/give @用户名 数量 或 /give 用户ID 数量，或回复某人消息发 /give 数量', env);
  if (!targetId || !amount || amount <= 0) return sendMessage(chatId, '❌ 数量需为正整数。', env);
  const k = `points:${targetId}`;
  const cur = parseInt(await LOTTERY_KV.get(k) || '0', 10);
  await LOTTERY_KV.put(k, String(cur + amount));
  const pn = await LOTTERY_KV.get(`points_name:${targetId}`);
  if (!pn && targetLabel) await LOTTERY_KV.put(`points_name:${targetId}`, targetLabel);
  const idxRaw = await LOTTERY_KV.get('points_index');
  const idx = safeJsonParse(idxRaw, []);
  if (!idx.includes(targetId)) { idx.push(targetId); await LOTTERY_KV.put('points_index', JSON.stringify(idx)); }
  await sendMessage(chatId, `✅ *${mdSafe(fromName)}* 给 ${targetLabel} 发放 *${amount} 积分*\n（目标余额：${cur + amount} 分）`, env);
    await sendMessage(targetId, `🎁 管理员给你发放了 ${amount} 积分！\n当前余额：${cur + amount} 分`, env).catch(() => null);
}

async function checkinCmd(chatId, userId, username, env) {
  const r = await lucky.checkin(userId, username);
  if (!r || r.ok === false) return sendMessage(chatId, (r && r.error) || '签到失败，请稍后再试。', env);
  let text = '📅 签到成功！\n';
  text += '📈 当前积分：' + r.points + '\n';
  if (r.gotDraw) {
    text += '🎁 恭喜！获得 1 次抽奖机会！\n';
    text += '🍀 下次签到掉落概率：1%（已重置）\n';
  } else {
    text += '🎲 本次未掉落抽奖机会\n';
    text += '🍀 下次签到掉落概率：' + r.nextProb + '%\n';
  }
  text += '🎰 剩余抽奖次数：' + r.drawLeft;
  return sendMessage(chatId, text, env);
}

async function drawCmd(chatId, userId, countStr, username, env) {
  const count = Math.max(1, Math.min(parseInt(countStr || '1', 10) || 1, 10));
  const pay = await ensureDrawTickets(userId, count, username);
  if (!pay.ok) return sendMessage(chatId, pay.error, env);
  const r = await lucky.draw(userId, count, username);
  if (!r.ok) return sendMessage(chatId, r.error, env);
  let text = '🎰 抽奖结果（' + count + '次）：\n';
  for (const p of r.prizes) {
    text += p.icon + ' ' + p.name + ' x' + p.count + '\n';
  }
  text += '\n🎰 剩余抽奖次数：' + r.drawLeft;
  if (pay.spent) text += `\n💰 本次用商城积分兑换 ${pay.granted} 次（-${pay.spent} 分，余额 ${pay.left}）`;
  return sendMessage(chatId, text, env);
}

async function prizesCmd(chatId, userId, username, env) {
  const prizes = await lucky.listPrizes();
  let text = '🎁 奖品列表：\n\n';
  for (const p of prizes) {
    text += p.icon + ' ' + p.name + ' - 概率：' + p.probability + '%\n';
    text += '   ' + (p.description || '') + '\n\n';
  }
  return sendMessage(chatId, text, env);
}

async function bagCmd(chatId, userId, username, env) {
  const r = await lucky.getUserBag(userId);
  if (!r.ok) return sendMessage(chatId, r.error, env);
  const mallPts = parseInt(await LOTTERY_KV.get(`points:${userId}`) || '0', 10);
  let text = '🎒 我的背包\n\n';
  text += '💰 商城积分：' + mallPts + '（群内发言获得，可 /mall 兑换）\n';
  text += '🎰 抽奖次数：' + r.drawLeft + '\n\n';
  if (r.inventory.length === 0) {
    text += '背包是空的，快去抽奖吧！';
  } else {
    text += '物品：\n';
    for (const item of r.inventory) {
      text += item.icon + ' ' + item.name + ' x' + item.count + '\n';
    }
  }
  return sendMessage(chatId, text, env);
}

async function bindmmwxCmd(chatId, userId, username, env) {
  // 已绑定：再次发送时显示当前绑定状态（无参数时优先展示）
  const cur = await lucky.getMmwxBind(userId);
  if (!username && cur) return sendMessage(chatId, `🔗 你当前已绑定 mmwx 账号：**${mdSafe(cur)}**\n\n如需更换：/bindmmwx 新用户名`, env);
  if (!username) return sendMessage(chatId, '用法：/bindmmwx 你的mmwx用户名', env);
  await lucky.bindMmwx(userId, username);
  return sendMessage(chatId, '✅ 已绑定mmwx账号：' + username, env);
}

async function exchangeCmd(chatId, userId, args, username, env) {
  const [itemName] = args.split(' ');
  if (!itemName) return sendMessage(chatId, '用法：/exchange 物品名\n例：/exchange 5G流量', env);
  const r = await lucky.exchangeItem(userId, itemName);
  if (!r.ok) return sendMessage(chatId, r.error, env);
  let text = '✅ 兑换成功！' + itemName;
  if (r.message) text += '\n📦 ' + r.message;
  return sendMessage(chatId, text, env);
}

function isAdmin(userId, env) {
  const ADMIN_IDS = [7027439863];
  return ADMIN_IDS.includes(Number(userId));
}

async function grantPointsCmd(chatId, userId, args, env) {
  if (!isAdmin(userId, env)) return sendMessage(chatId, '⛔ 只有管理员可以使用这个命令', env);
  const [username, amountStr] = args;
  if (!username || !amountStr) return sendMessage(chatId, '用法：/grantpoints 用户名 数量\n例：/grantpoints zhangsan 100', env);
  const amount = parseInt(amountStr, 10);
  if (!amount) return sendMessage(chatId, '数量必须是数字', env);
  const tgId = lucky.findUserByUsername(username);
  if (!tgId) return sendMessage(chatId, '❌ 找不到用户：' + username, env);
  const r = lucky.adminGrantPoints(tgId, amount);
  return sendMessage(chatId, '✅ 已给用户 ' + username + ' 加 ' + amount + ' 积分\n当前积分：' + r.points, env);
}

async function grantDrawsCmd(chatId, userId, args, env) {
  if (!isAdmin(userId, env)) return sendMessage(chatId, '⛔ 只有管理员可以使用这个命令', env);
  const [username, countStr] = args;
  if (!username || !countStr) return sendMessage(chatId, '用法：/grantdraws 用户名 数量\n例：/grantdraws zhangsan 10', env);
  const count = parseInt(countStr, 10);
  if (!count) return sendMessage(chatId, '数量必须是数字', env);
  const tgId = lucky.findUserByUsername(username);
  if (!tgId) return sendMessage(chatId, '❌ 找不到用户：' + username, env);
  const r = lucky.adminGrantDraws(tgId, count);
  return sendMessage(chatId, '✅ 已给用户 ' + username + ' 加 ' + count + ' 次抽奖机会\n剩余次数：' + r.drawLeft, env);
}

async function grantItemCmd(chatId, userId, args, env) {
  if (!isAdmin(userId, env)) return sendMessage(chatId, '⛔ 只有管理员可以使用这个命令', env);
  const [username, ...itemParts] = args;
  const itemName = itemParts.join(' ');
  if (!username || !itemName) return sendMessage(chatId, '用法：/grantitem 用户名 物品名\n例：/grantitem zhangsan 5G流量', env);
  const tgId = lucky.findUserByUsername(username);
  if (!tgId) return sendMessage(chatId, '❌ 找不到用户：' + username, env);
  const r = lucky.adminGrantItem(tgId, itemName, 1);
  if (!r.ok) return sendMessage(chatId, '❌ ' + r.error, env);
  return sendMessage(chatId, '✅ 已给用户 ' + username + ' 发放物品：' + itemName, env);
}

async function grantAllPointsCmd(chatId, userId, args, env) {
  if (!isAdmin(userId, env)) return sendMessage(chatId, '⛔ 只有管理员可以使用这个命令', env);
  const amountStr = args[0];
  if (!amountStr) return sendMessage(chatId, '用法：/grantallpoints 数量\n例：/grantallpoints 100', env);
  const amount = parseInt(amountStr, 10);
  if (!amount) return sendMessage(chatId, '数量必须是数字', env);
  const users = lucky.adminListUsers();
  for (const u of users) {
    lucky.adminGrantPoints(u.tgId, amount);
  }
  return sendMessage(chatId, '✅ 已给所有 ' + users.length + ' 个用户各发 ' + amount + ' 积分', env);
}

async function grantAllDrawsCmd(chatId, userId, args, env) {
  if (!isAdmin(userId, env)) return sendMessage(chatId, '⛔ 只有管理员可以使用这个命令', env);
  const countStr = args[0];
  if (!countStr) return sendMessage(chatId, '用法：/grantalldraws 数量\n例：/grantalldraws 10', env);
  const count = parseInt(countStr, 10);
  if (!count) return sendMessage(chatId, '数量必须是数字', env);
  const users = lucky.adminListUsers();
  for (const u of users) {
    lucky.adminGrantDraws(u.tgId, count);
  }
  return sendMessage(chatId, '✅ 已给所有 ' + users.length + ' 个用户各发 ' + count + ' 次抽奖机会', env);
}
async function sendMessage(chatId, text, env) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  const r = await tgApi(env, 'sendMessage', payload);
  // Markdown 解析失败(用户内容含特殊符号)→ 自动降级纯文本重发
  if (r && r.ok === false && /can't parse entities|message is not formatted/i.test(r.description || '')) {
    const p2 = Object.assign({}, payload);
    delete p2.parse_mode;
    return tgApi(env, 'sendMessage', p2);
  }
  return r;
}

async function sendMsgKb(chatId, text, kb, env) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: kb },
  };
  const r2 = await tgApi(env, 'sendMessage', payload);
  if (r2 && r2.ok === false && /can't parse entities|message is not formatted/i.test(r2.description || '')) {
    const p2 = Object.assign({}, payload);
    delete p2.parse_mode;
    return tgApi(env, 'sendMessage', p2);
  }
  return r2;
}

async function showOrEdit(chatId, msgId, text, env, kb) {
  if (msgId) return editMsg(chatId, msgId, text, env, kb);
  return kb ? sendMsgKb(chatId, text, kb, env) : sendMessage(chatId, text, env);
}

async function editMsg(chatId, msgId, text, env, kb) {
  const payload = {
    chat_id: chatId,
    message_id: msgId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}),
  };
  const r = await tgApi(env, 'editMessageText', payload);
  if (r && r.ok === false && /can't parse entities|message is not formatted/i.test(r.description || '')) {
    const p2 = Object.assign({}, payload);
    delete p2.parse_mode;
    return tgApi(env, 'editMessageText', p2);
  }
  return r;
}

async function answerCb(cbId, text, env) {
  return tgApi(env, 'answerCallbackQuery', { callback_query_id: cbId, text });
}

// 奖池同步:每 60 秒检查开启/开奖/取消并播报到群
let poolTickStarted = false;
if (!poolTickStarted) {
  poolTickStarted = true;
  setTimeout(() => poolSyncTick().catch(e => console.error('[pool-sync] init:', e?.message || e)), 10000);
  setInterval(() => poolSyncTick().catch(e => console.error('[pool-sync] error:', e?.message || e)), 60 * 1000);
}
