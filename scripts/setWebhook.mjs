#!/usr/bin/env node
/**
 * 设置 Telegram Webhook（服务器版）
 * 用法：node scripts/setWebhook.mjs <BOT_TOKEN> <WEBHOOK_URL> [WEBHOOK_SECRET]
 * 例：  node scripts/setWebhook.mjs 123456:ABC-xxx https://your-domain.com/webhook mysecret
 *
 * 注意：WEBHOOK_URL 必须是公网可访问的 HTTPS 地址，路径需与 .env 中 WEBHOOK_PATH 一致。
 */
const [token, url, secret] = process.argv.slice(2);
if (!token || !url) {
  console.error('用法: node scripts/setWebhook.mjs <BOT_TOKEN> <WEBHOOK_URL> [WEBHOOK_SECRET]');
  process.exit(1);
}

const body = { url, allowed_updates: ['message', 'callback_query', 'my_chat_member', 'chat_member', 'channel_post'] };
if (secret) body.secret_token = secret;

const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org';

const res = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));

if (data.ok) {
  const info = await (await fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`)).json();
  console.log('\nWebhook 信息:');
  console.log('  url:', info.result?.url);
  console.log('  pending_update_count:', info.result?.pending_update_count);
  console.log('  last_error_message:', info.result?.last_error_message || '无');
} else {
  console.error('设置失败:', data.description);
  process.exit(1);
}
