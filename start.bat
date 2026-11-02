@echo off
cd /d "%~dp0"
title Muse Manager

where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Tai ban 24 tro len tai https://nodejs.org roi chay lai file nay.
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo Chua cai ffmpeg. Mo PowerShell va chay: winget install Gyan.FFmpeg
  pause
  exit /b 1
)

if not exist node_modules (
  echo Dang cai dat lan dau, vui long cho...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Cai dat that bai.
    pause
    exit /b 1
  )
)

node src\main.js
if errorlevel 1 pause
