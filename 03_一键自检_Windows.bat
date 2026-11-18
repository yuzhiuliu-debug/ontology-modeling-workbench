@echo off
chcp 65001 >nul
title 本体建模工作台 - 一键自检
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有检测到 Node.js，请先安装： https://nodejs.org/
  pause
  exit /b 1
)
node check.mjs
echo.
pause
