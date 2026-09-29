import 'dotenv/config';

// 设置 Bot 菜单按钮为 Mini App
// 用法: node scripts/setMenu.mjs [app_url]
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const APP_URL = process.argv[2] || 'https://tg.fa2.cc.cd/app';
const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org:18443';

const r = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/setChatMenuButton`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ menu_button: { type: 'web_app', text: '📊 管理面板', url: APP_URL } }),
});
const d = await r.json();
console.log(JSON.stringify(d));
if (d.ok) console.log('✅ 菜单按钮已设置为 Mini App:', APP_URL);
else console.log('❌ 设置失败:', d.description || '未知错误');
