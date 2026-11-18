#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [错误] 没有检测到 Node.js"
  echo "  请先安装 Node.js 22 或更高版本： https://nodejs.org/"
  echo ""
  read -r -p "按回车键退出..." _
  exit 1
fi
echo "  正在启动，请稍候…… 浏览器会自动打开。"
echo "  若要停止服务，在本窗口按 Ctrl + C"
echo ""
export STUDIO_OPEN=1
node server.mjs
echo ""
echo "  服务已停止。"
