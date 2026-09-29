#!/usr/bin/env node
/**
 * 设置 Telegram Bot 指令菜单（setMyCommands，按场景区分）
 * 用法：node scripts/setCommands.mjs <BOT_TOKEN>
 */
const token = process.argv[2];
if (!token) {
  console.error('用法: node scripts/setCommands.mjs <BOT_TOKEN>');
  process.exit(1);
}

const API = 'https://api.telegram.org';

// 私聊 / 群聊分别的指令
const scopes = [
  {
    name: '私聊（默认）',
    // 不传 scope 即为 default：私聊时显示
    body: {
      commands: [
        { command: 'create', description: '✨ 创建抽奖（10步向导）' },
        { command: 'list', description: '📋 查看我创建的抽奖' },
        { command: 'draw', description: '🎲 手动开奖 用法: /draw <ID>' },
        { command: 'cancel', description: '❌ 取消抽奖 用法: /cancel <ID>' },
        { command: 'groups', description: '🤖 查看可发布群组' },
        { command: 'start', description: '📖 帮助说明' },
      ],
    },
  },
  {
    name: '群聊',
    body: {
      scope: { type: 'all_group_chats' },
      commands: [
        { command: 'list', description: '📋 查看本群抽奖' },
        { command: 'draw', description: '🎲 手动开奖 用法: /draw <ID>' },
        { command: 'cancel', description: '❌ 取消抽奖 用法: /cancel <ID>' },
      ],
    },
  },
  {
    name: '私聊（仅创建者）',
    body: {
      scope: { type: 'chat', chat_id: 0 }, // 占位，实际由 --creator 参数指定
      commands: [],
    },
  },
];

async function call(scopeBody) {
  const res = await fetch(`${API}/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scopeBody),
  });
  return res.json();
}

// 处理第三个特殊 scope：创建者可指定 chat_id
const creatorArg = process.argv[3];
const activeScopes = [scopes[0], scopes[1]];
if (creatorArg && creatorArg !== '--creator') {
  scopes[2].body.scope.chat_id = parseInt(creatorArg);
  activeScopes.push(scopes[2]);
} else if (creatorArg === '--creator') {
  console.error('用法: node scripts/setCommands.mjs <BOT_TOKEN> [创建者chat_id]\n  例: node scripts/setCommands.mjs 123:ABC 987654321');
  process.exit(1);
}

for (const s of activeScopes) {
  const data = await call(s.body);
  console.log(`${data.ok ? '✅' : '❌'} ${s.name}: ${data.ok ? 'OK' : (data.description || JSON.stringify(data))}`);
}