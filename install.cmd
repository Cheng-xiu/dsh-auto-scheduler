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
call dsh plugin --profile "%PROFILE%" add github:Cheng-xiu/dsh-auto-scheduler#v0.1.4
if errorlevel 1 (
  echo.
  echo [ERROR] Install failed. Follow the pnpm hint printed above and re-run.
  exit /b 1
)
echo [2/2] Verifying bundle entry ...
set "PKGFILE=%USERPROFILE%\.dsh\profiles\%PROFILE%\package.json"
findstr /c:dsh-auto-scheduler "%PKGFILE%" >nul 2>nul
if errorlevel 1 (
  echo [WARN] Could not verify package.json entry. Inspect the file manually.
) else (
  echo [OK] Installed.
  echo.
  echo Next step: RESTART dsh web. The sidebar entry appears after restart
  echo (host scheduler and client panel are injected at boot).
)
endlocal
