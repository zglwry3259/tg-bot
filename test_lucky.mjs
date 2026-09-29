
import * as lucky from '/opt/tg-group-bot/src/lucky.js';

// 测试签到
const r = lucky.signin(7027439863);
console.log('签到结果:', JSON.stringify(r));

// 测试抽奖
const d = lucky.draw(7027439863, 1);
console.log('抽奖结果:', JSON.stringify(d));
