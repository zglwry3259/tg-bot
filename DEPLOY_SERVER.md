# 🚀 群组管家 v6.7.11 - 服务器部署指南（VPS 版）

> 本文档适用于将群组管家 Bot 部署到普通 VPS / 云服务器（Ubuntu / Debian / CentOS 等 Linux 系统）。
> 与 Cloudflare Workers 版相比，服务器版使用 **Express + 本地 JSON 存储**，无需 Cloudflare 账号和 KV。

---

## 一、功能说明

服务器版完整保留了 Workers 版的所有功能：
- 🎁 **抽奖模块**：多奖品、兑奖码、定时/人数开奖、口令参与
- 🛡️ **入群验证**：数学题验证、自动禁言、超时移出
- 📢 **管理员公告**：私聊发起、自动置顶
- 📊 **投票模块**：匿名投票、多选支持
- 🛠️ **群管工具**：禁言/踢出/封禁/警告/群规/欢迎语
- 📢 **全局广播**：一键广播到所有群
- 🌏 **时区设置**：支持多时区

**与 Workers 版的区别：**
| 项目 | Workers 版 | 服务器版 |
|------|-----------|---------|
| 运行环境 | Cloudflare Workers | Node.js (≥18) |
| 存储 | Cloudflare KV | 本地 JSON 文件 |
| 定时任务 | Cron Triggers | setInterval（每分钟） |
| 反向代理 | 无需 | Nginx（推荐） |
| 进程管理 | 平台托管 | systemd / pm2 |

---

## 二、准备工作

### 1. 服务器要求
- **操作系统**：Ubuntu 20.04+ / Debian 11+ / CentOS 8+（推荐 Ubuntu 22.04）
- **配置**：1核1G 起步（推荐 2核2G）
- **网络**：公网 IP，可访问 Telegram API（api.telegram.org）
- **域名**：一个已解析到服务器 IP 的域名（用于 HTTPS Webhook）

> ⚠️ **重要**：如果服务器在中国大陆，需要确保能正常访问 `api.telegram.org`，否则 Bot 无法工作。

### 2. 创建 Telegram Bot
1. 在 Telegram 搜索 **@BotFather**
2. 发送 `/newbot`，按提示设置名字和用户名
3. 保存返回的 **BOT_TOKEN**（格式：`123456789:ABCdef...`）
4. 把 Bot 拉进你的群组，**设为管理员**（勾选所有权限）

### 3. 域名解析
将你的域名（如 `bot.example.com`）A 记录解析到服务器公网 IP。

---

## 三、快速部署（推荐：一键脚本）

项目自带一键部署脚本，适用于 Ubuntu / Debian：

```bash
# 1. 上传项目到服务器，解压后进入目录
cd tg-bot-server

# 2. 运行部署脚本
sudo bash deploy.sh
```

脚本会自动完成：
- 安装 Node.js 20
- 创建 `/opt/tg-group-bot` 目录
- 复制项目文件、安装依赖
- 配置 systemd 服务（开机自启）

脚本执行完成后，继续下面的「配置环境变量」步骤。

---

## 四、手动部署

### 1. 安装 Node.js

**Ubuntu / Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node --version  # 验证安装
```

**CentOS / RHEL:**
```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
```

### 2. 上传项目并安装依赖

```bash
# 创建应用目录
sudo mkdir -p /opt/tg-group-bot
sudo chown $USER:$USER /opt/tg-group-bot

# 上传项目文件到该目录（scp / rsync / git clone）
# 假设文件已在当前目录
cp -r src scripts package.json .env.example /opt/tg-group-bot/
cd /opt/tg-group-bot

# 安装依赖
npm install --production
```

### 3. 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑配置
nano .env
```

填写以下内容：
```env
BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
PORT=3000
WEBHOOK_PATH=/webhook
WEBHOOK_SECRET=your-random-secret-string
```

> 💡 `WEBHOOK_SECRET` 可以用 `openssl rand -hex 32` 生成随机字符串。

### 4. 配置 Nginx 反向代理（推荐）

```bash
# 安装 Nginx
sudo apt-get install -y nginx

# 复制配置模板
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tg-bot

# 编辑配置，替换域名
sudo nano /etc/nginx/sites-available/tg-bot

# 启用站点
sudo ln -s /etc/nginx/sites-available/tg-bot /etc/nginx/sites-enabled/
sudo nginx -t  # 测试配置
sudo systemctl reload nginx
```

### 5. 申请 SSL 证书（HTTPS 必需）

```bash
# 安装 certbot
sudo apt-get install -y certbot python3-certbot-nginx

# 申请证书（自动配置 Nginx）
sudo certbot --nginx -d bot.example.com
```

### 6. 配置 systemd 服务

```bash
# 复制服务文件
sudo cp deploy/tg-bot.service /etc/systemd/system/

# 编辑服务文件，确认路径和用户正确
sudo nano /etc/systemd/system/tg-bot.service

# 重新加载并启用
sudo systemctl daemon-reload
sudo systemctl enable tg-bot
sudo systemctl start tg-bot

# 查看状态
sudo systemctl status tg-bot
```

### 7. 设置 Webhook

```bash
cd /opt/tg-group-bot
node scripts/setWebhook.mjs <BOT_TOKEN> https://bot.example.com/webhook <WEBHOOK_SECRET>
```

成功后会显示 Webhook 信息，`pending_update_count: 0` 即为正常。

---

## 五、使用 PM2 管理（可选，替代 systemd）

如果你更熟悉 PM2：

```bash
# 安装 PM2
sudo npm install -g pm2

# 启动应用
cd /opt/tg-group-bot
pm2 start src/server.js --name tg-bot

# 设置开机自启
pm2 startup
pm2 save

# 常用命令
pm2 logs tg-bot    # 查看日志
pm2 restart tg-bot # 重启
pm2 stop tg-bot    # 停止
```

---

## 六、验证部署

按顺序测试：

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 访问 `https://bot.example.com/` | 返回 JSON 状态信息 |
| 2 | 私聊 Bot 发送 `/start` | 返回欢迎菜单 |
| 3 | 私聊发送 `/groups` | 显示 Bot 已加入的群 |
| 4 | 私聊发送 `/create` | 进入抽奖创建向导 |
| 5 | 在群里发口令 | 提示参与成功 |
| 6 | 私聊 `/diag` | 显示诊断信息（Webhook/群/管理员状态） |

---

## 七、数据备份

所有数据存储在 `data/kv-store.json` 文件中，定期备份即可：

```bash
# 手动备份
cp /opt/tg-group-bot/data/kv-store.json /backup/kv-store-$(date +%Y%m%d).json

# 设置定时备份（每天凌晨3点）
crontab -e
# 添加：
0 3 * * * cp /opt/tg-group-bot/data/kv-store.json /backup/kv-store-$(date +\%Y\%m\%d).json
```

---

## 八、常见问题排查

### 1. Bot 不响应消息
```bash
# 查看服务日志
sudo journalctl -u tg-bot -f --no-pager

# 检查 Webhook 状态
cd /opt/tg-group-bot
node -e "fetch('https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/getWebhookInfo').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)))"
```

常见原因：
- Webhook URL 错误或不可访问
- 服务器无法访问 api.telegram.org
- Nginx 配置错误
- 防火墙未放行 443 端口

### 2. 入群验证不生效
- 确认 Bot 是群管理员
- 确认 Webhook 包含 `chat_member` 更新（使用脚本设置会自动包含）
- 私聊 Bot 发送 `/diag` 查看诊断信息
- 在群内发送 `/verify on` 开启验证

### 3. 定时开奖不触发
- 确认服务正常运行（`systemctl status tg-bot`）
- 查看日志是否有定时任务报错
- 服务器版使用 setInterval，只要进程在运行就会执行

### 4. 数据丢失
- 检查 `data/kv-store.json` 是否存在
- 确认服务用户对 `data` 目录有读写权限
- 从备份恢复

### 5. 端口被占用
```bash
# 查看端口占用
sudo netstat -tlnp | grep 3000

# 修改 .env 中的 PORT 为其他端口
# 同时更新 Nginx 配置中的 proxy_pass 端口
```

---

## 九、更新升级

```bash
cd /opt/tg-group-bot

# 备份数据
cp data/kv-store.json data/kv-store.backup.json

# 上传新代码覆盖 src/ 目录
# 安装新依赖（如果 package.json 有变化）
npm install --production

# 重启服务
sudo systemctl restart tg-bot
```

---

## 十、目录结构

```
tg-bot-server/
├── src/
│   ├── server.js      # Express 服务器入口
│   ├── bot.js         # Bot 业务逻辑（从 Workers 改造）
│   └── kv-store.js    # 本地 JSON KV 存储兼容层
├── scripts/
│   ├── setWebhook.mjs # 设置 Webhook
│   └── setCommands.mjs# 设置命令菜单
├── deploy/
│   ├── tg-bot.service # systemd 服务配置
│   └── nginx.conf     # Nginx 反向代理配置
├── data/
│   └── kv-store.json  # 数据存储（运行后自动生成）
├── deploy.sh           # 一键部署脚本
├── package.json
├── .env.example        # 环境变量模板
├── .gitignore
├── README.md
└── DEPLOY_SERVER.md    # 本文档
```

---

## 十一、安全建议

1. **环境变量文件权限**：`chmod 600 .env`，防止其他用户读取
2. **防火墙**：只开放 22（SSH）、80（HTTP）、443（HTTPS）端口
3. **定期更新**：保持 Node.js 和系统包最新
4. **数据备份**：每日自动备份 `kv-store.json`
5. **Webhook Secret**：务必设置 `WEBHOOK_SECRET`，防止伪造请求

---

> 📌 如有问题，先查看日志 `journalctl -u tg-bot -f`，大部分问题都能在日志中找到原因。
