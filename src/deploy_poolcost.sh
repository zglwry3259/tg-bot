set -e
cd /opt/tg-group-bot/src
TS=$(date +%Y%m%dT%H%M%S)
# 1) 备份（带时间戳）
cp bot-live.js "bot-live.js.bak-poolcost-$TS"
echo "BACKUP: bot-live.js.bak-poolcost-$TS"

# 2) 应用补丁
node patch.cjs

# 3) 语法校验（不过就不重启）
node --check bot-live.js
echo "SYNTAX OK"

# 4) 校验改动确实落地（grep 到新变量）
grep -n "ticketCost = parts\[3\]" bot-live.js
grep -n "券价必须" bot-live.js
grep -n "ticketCost} 积分/张" bot-live.js

# 5) 重启
systemctl restart tg-group-bot
sleep 3

# 6) 状态 + 启动日志（看是否 SyntaxError）
systemctl is-active tg-group-bot
journalctl -u tg-group-bot --no-pager -n 15 | grep -iE "error|SyntaxError|listen|轮询|polling" || true
echo "=== DONE ==="
