# 群组管家 v6.7.11（服务器版 / VPS 版）

> 从 Cloudflare Workers 改造而来，可直接部署到普通 VPS / 云服务器运行。
> 使用 **Express + 本地 JSON 存储**，无需 Cloudflare 账号和 KV。

群组管家 Bot：**私聊**向我发起所有操作，发布到你选择的群。
内置**抽奖**、**入群验证**、**管理员公告**、**群投票**、**群管工具**五大模块，并支持**默认群/频道**与**时区**设置。

---

## 🚀 快速开始

### 环境要求
- Node.js ≥ 18
- 公网可访问的服务器（用于 Webhook）

### 本地运行

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填写 BOT_TOKEN

# 3. 启动
npm start
```

服务启动后监听 `http://localhost:3000`。

### 服务器部署

详细部署教程请参考 **[DEPLOY_SERVER.md](./DEPLOY_SERVER.md)**，包含：
- 一键部署脚本
- Nginx 反向代理配置
- systemd / PM2 进程管理
- SSL 证书申请
- 数据备份方案

---

## 功能

### 🏠 主菜单（/start 内联键盘）
发送 `/start` 弹出内联键盘菜单：
- ✨ 创建抽奖 · 📢 发布公告 · 📊 发起投票 · 📋 我的抽奖
- 🛡️ 群管理 · 📢 频道管理
- ⚙️ 设置群组 / 设置频道 · 🌏 设置时区

### 🎁 抽奖模块
- 📝 私聊创建向导（共 10 步）
- 🎁 多奖品：按中奖顺序一一对应发放
- 🎟️ 中奖兑奖：开奖时自动私信发放兑换码
- ⏰ 定时开奖 / 👥 人数开奖
- 📢 发布到群 + 频道，自动置顶
- 🔑 口令参与
- 📣 强制加频道验证

### 🛡️ 入群验证模块
- 新成员加入自动禁言，发送数学验证题
- 答对自动解禁，10分钟未验证自动移出
- 按群开关：`/verify on|off`

### 🛠️ 群管理模块
- 私聊发起，交互式操作
- 禁言 / 解除禁言 / 踢出 / 封禁 / 解封
- 警告（满3次自动踢出）/ 查警告
- 设置群规 / 欢迎语 / 修改群名 / 全员禁言
- 管理员列表 / 群信息

### 📢 管理员公告
- 私聊发起，自动校验管理员身份
- 发布后自动置顶

### 📊 投票
- 私聊发起，匿名投票
- 支持多选

---

## 配置说明

所有配置通过 `.env` 文件设置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BOT_TOKEN` | Telegram Bot Token（必填） | - |
| `PORT` | 服务监听端口 | `3000` |
| `WEBHOOK_PATH` | Webhook 接收路径 | `/webhook` |
| `WEBHOOK_SECRET` | Webhook 验证密钥（推荐设置） | - |
| `KV_DATA_DIR` | 数据存储目录 | `./data` |

---

## 常用命令

```bash
# 启动服务
npm start

# 开发模式（自动重启）
npm run dev

# 设置 Webhook
node scripts/setWebhook.mjs <BOT_TOKEN> https://你的域名/webhook <WEBHOOK_SECRET>

# 设置命令菜单
node scripts/setCommands.mjs <BOT_TOKEN>
```

---

## 数据存储

所有数据存储在 `data/kv-store.json` 文件中，包含：
- 抽奖活动数据
- 用户配置（默认群/频道/时区）
- 群配置（验证开关/群规/欢迎语）
- 入群验证待处理记录
- 操作草稿（公告/投票/群管/抽奖向导）
- 警告记录

> 💡 建议定期备份此文件。

---

## 与 Workers 版的区别

| 项目 | Workers 版 | 服务器版 |
|------|-----------|---------|
| 运行环境 | Cloudflare Workers | Node.js (≥18) |
| 存储 | Cloudflare KV | 本地 JSON 文件 |
| 定时任务 | Cron Triggers | setInterval |
| 部署方式 | wrangler deploy | npm start / systemd |
| 域名 | workers.dev 子域 | 自有域名 + Nginx |

---

## 许可证

MIT
