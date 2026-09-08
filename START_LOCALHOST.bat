@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20+ first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing Node.js dependencies...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Created .env from .env.example.
  echo Add MONGODB_URI, GEMINI_API_KEY and FIREBASE_API_KEY.
  echo.
  notepad .env
  pause
)
start "FakeNewsDetect Server" cmd /k "cd /d ""%~dp0"" && npm start"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:5600/Page/index.html
exit /b 0
