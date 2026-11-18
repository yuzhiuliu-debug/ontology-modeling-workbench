#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "  [错误] 没有检测到 Node.js，请先安装： https://nodejs.org/"
  read -r -p "按回车键退出..." _
  exit 1
fi
node check.mjs
echo ""
read -r -p "按回车键退出..." _
