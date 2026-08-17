@echo off
setlocal
set "PROFILE=%~1"
if "%PROFILE%"=="" set "PROFILE=web"
where dsh >nul 2>nul
if errorlevel 1 (
  echo [ERROR] dsh CLI not found in PATH. Install DeepSeek Harness first.
  exit /b 1
)
echo [1/2] Installing dsh-auto-scheduler into profile "%PROFILE%" ...
call dsh plugin --profile "%PROFILE%" add github:Cheng-xiu/dsh-auto-scheduler#v0.1.1
if errorlevel 1 (
  echo.
  echo [ERROR] Install failed. If pnpm printed a store/allowBuilds message,
  echo         follow its hint and re-run this script.
  exit /b 1
)
echo [2/2] Verifying bundle entry ...
findstr /c:"dsh-auto-scheduler" "%USERPROFILE%\.dsh\profiles\%PROFILE%\package.json" >nul 2>nul
if errorlevel 1 (
  echo [WARN] package.json check failed; run: type "%USERPROFILE%\.dsh\profiles\%PROFILE%\package.json"
) else (
  echo [OK] Installed.
  echo.
  echo Next step: RESTART dsh web. The sidebar entry "Auto Work / Zi Dong Gong Zuo"
  echo appears after restart (host scheduler and client panel are injected at boot).
)
endlocal
