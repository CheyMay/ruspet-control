@echo off
cd /d "%~dp0"
set UV_THREADPOOL_SIZE=1
set GOMAXPROCS=1
if not exist node_modules call npm ci --no-audit --no-fund
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1
echo Open http://127.0.0.1:4310 after the ready message. Keep this window open.
call npm run dev
pause
