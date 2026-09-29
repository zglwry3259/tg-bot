const fs = require('fs');
const f = '/opt/tg-group-bot/src/bot-live.js';
let lines = fs.readFileSync(f, 'utf8').split('\n');

function chk(idx, expect) {
  if (!lines[idx] || !lines[idx].includes(expect)) {
    console.error('LINE MISMATCH idx=' + idx + ' expected~[' + expect + '] actual=[' + lines[idx] + ']');
    process.exit(1);
  }
}

// 绝对行号(1基): prizeSpec=4987 用法=4988 赋值=5001 文案=5014 → 0基: 4986/4987/5000/5013
// 从大往小处理，splice 只影响更小行号，不破坏已改的大行

// 1) 5013(idx) 成功文案
chk(5013, 'POOL_TICKET_COST');
lines[5013] = lines[5013].replace('${POOL_TICKET_COST} 积分/张', '${ticketCost} 积分/张');
if (!lines[5013].includes('${ticketCost} 积分/张')) { console.error('文案替换失败'); process.exit(1); }

// 2) 5000(idx) 建池对象赋值
chk(5000, 'ticketCost: POOL_TICKET_COST');
lines[5000] = lines[5000].replace('ticketCost: POOL_TICKET_COST', 'ticketCost: ticketCost');

// 3) 4987(idx) 用法行：替换 + 其后插入券价校验
chk(4987, '用法：/poolcreate');
lines[4987] = "  if (!title || !parts[1] || !prizeSpec) return sendMessage(chatId, '用法：/poolcreate 标题 | 开奖分钟 | 奖品列表 | 券价(可选,默认2)\\n\\n示例：/poolcreate 周末大奖 | 60 | 5G流量x2, 1天时长x3 | 10\\n（第4段=每张券消耗积分,不填默认2；单人投入无上限；奖品示例：5G流量x2、1天时长x3）', env);";
lines.splice(4988, 0, "  if (parts[3] && (!ticketCost || ticketCost < 1)) return sendMessage(chatId, '❌ 券价必须 ≥ 1 积分（第 4 段）。', env);");

// 4) 4986(idx) prizeSpec 行：其后插入 ticketCost 解析
chk(4986, 'const prizeSpec = parts[2]');
lines.splice(4987, 0, "  const ticketCost = parts[3] ? parseInt(parts[3], 10) : POOL_TICKET_COST;");

fs.writeFileSync(f, lines.join('\n'));
console.log('PATCH OK: 4 changes applied');
