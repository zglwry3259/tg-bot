#!/bin/bash
# ========================================
# 群组管家 Bot - 一键部署脚本（Ubuntu/Debian）
# 用法: sudo bash deploy.sh
# ========================================

set -e

APP_DIR="/opt/tg-group-bot"
SERVICE_NAME="tg-bot"
NODE_VERSION="20"

echo "========================================"
echo "  群组管家 Bot - 服务器部署脚本"
echo "========================================"
echo ""

# 1. 检查是否为 root
if [ "$EUID" -ne 0 ]; then
    echo "❌ 请使用 root 或 sudo 运行此脚本"
    exit 1
fi

# 2. 安装 Node.js
if ! command -v node &> /dev/null; then
    echo "📦 正在安装 Node.js ${NODE_VERSION}..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
    echo "✅ Node.js 安装完成: $(node --version)"
else
    echo "✅ Node.js 已安装: $(node --version)"
fi

# 3. 创建应用目录
echo "📁 创建应用目录: ${APP_DIR}"
mkdir -p ${APP_DIR}
mkdir -p ${APP_DIR}/data

# 4. 复制文件（假设脚本在项目根目录运行）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "📋 复制项目文件..."
cp -r ${SCRIPT_DIR}/src ${APP_DIR}/
cp -r ${SCRIPT_DIR}/scripts ${APP_DIR}/
cp ${SCRIPT_DIR}/package.json ${APP_DIR}/
cp ${SCRIPT_DIR}/.env.example ${APP_DIR}/.env.example

# 5. 安装依赖
echo "📦 安装 npm 依赖..."
cd ${APP_DIR}
npm install --production

# 6. 设置权限
echo "🔐 设置文件权限..."
chown -R www-data:www-data ${APP_DIR}
chmod 600 ${APP_DIR}/.env 2>/dev/null || true

# 7. 配置 systemd 服务
echo "⚙️  配置 systemd 服务..."
cp ${SCRIPT_DIR}/deploy/${SERVICE_NAME}.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ${SERVICE_NAME}

echo ""
echo "========================================"
echo "  ✅ 基础部署完成！"
echo "========================================"
echo ""
echo "📝 接下来请完成以下步骤："
echo ""
echo "1. 配置环境变量:"
echo "   nano ${APP_DIR}/.env"
echo "   （参考 .env.example，填写 BOT_TOKEN 等）"
echo ""
echo "2. 启动服务:"
echo "   systemctl start ${SERVICE_NAME}"
echo "   systemctl status ${SERVICE_NAME}"
echo ""
echo "3. 配置 Nginx 反向代理（参考 deploy/nginx.conf）"
echo "   并使用 certbot 申请 SSL 证书"
echo ""
echo "4. 设置 Webhook:"
echo "   cd ${APP_DIR}"
echo "   node scripts/setWebhook.mjs <BOT_TOKEN> https://你的域名/webhook <WEBHOOK_SECRET>"
echo ""
echo "5. 查看日志:"
echo "   journalctl -u ${SERVICE_NAME} -f"
echo ""
