@echo off
chcp 65001 >nul
title 本体建模工作台
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有检测到 Node.js
  echo   请先安装 Node.js 22 或更高版本： https://nodejs.org/
  echo   安装完成后，重新打开本窗口再双击此脚本。
  echo.
  pause
  exit /b 1
)
echo   正在启动，请稍候…… 浏览器会自动打开。
echo   若要停止服务，在本窗口按 Ctrl + C
echo.
set STUDIO_OPEN=1
node server.mjs
echo.
echo   服务已停止。
pause
