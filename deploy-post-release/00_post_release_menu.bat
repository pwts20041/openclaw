@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"
set "PROJECT_DIR=%BASE_DIR%\.."
if defined OPENCLAW_DEPLOY_DIR (
  set "DEPLOY_DIR=%OPENCLAW_DEPLOY_DIR%"
) else (
  set "DEPLOY_DIR=D:\OpenClaw\deploy"
)
set "LOG_FILE=%DEPLOY_DIR%\gateway.log"
set "PORT=18789"
set "VERIFY_SCRIPT=%BASE_DIR%\verify_post_release.ps1"
set "SNAPSHOT_SCRIPT=%BASE_DIR%\capture_snapshot.ps1"
set "DEPLOY_MENU=%PROJECT_DIR%\deploy_menu.bat"
set "LOG_TAIL=80"

rem Numeric argument mode
if "%~1"=="1" goto do_publish_once
if "%~1"=="2" goto do_restart_once
if "%~1"=="3" goto do_release_verify_once
if "%~1"=="4" goto do_verify_once
if "%~1"=="5" goto do_logs_once
if "%~1"=="6" goto do_self_check_once
if "%~1"=="7" goto do_quick_regression_once
if "%~1"=="8" goto do_snapshot_once
if "%~1"=="0" goto done

rem Keyword argument mode
if /I "%~1"=="publish" goto do_publish_once
if /I "%~1"=="restart" goto do_restart_once
if /I "%~1"=="release-verify" goto do_release_verify_once
if /I "%~1"=="verify" goto do_verify_once
if /I "%~1"=="logs" goto do_logs_once
if /I "%~1"=="self-check" goto do_self_check_once
if /I "%~1"=="quick-regression" goto do_quick_regression_once
if /I "%~1"=="snapshot" goto do_snapshot_once
if /I "%~1"=="docs" goto do_docs_once

:menu
cls
echo ==============================================================
echo   OpenClaw Post-Release Toolkit
echo   Dir: %BASE_DIR%
echo ==============================================================
echo [1] Publish only
echo [2] Restart only
echo [3] Publish + Restart + Verify (recommended)
echo [4] Verify only
echo [5] Show gateway log tail
echo [6] Self-check toolkit prerequisites
echo [7] Quick regression (self-check + verify)
echo [8] Capture environment snapshot
echo [D] Open post-release docs
echo [0] Exit
set "CHOICE="
set /p "CHOICE=Select [0-8, D]: " || goto done
if not defined CHOICE goto done

if "%CHOICE%"=="1" goto run_publish
if "%CHOICE%"=="2" goto run_restart
if "%CHOICE%"=="3" goto run_release_verify
if "%CHOICE%"=="4" goto run_verify
if "%CHOICE%"=="5" goto show_logs
if "%CHOICE%"=="6" goto run_self_check
if "%CHOICE%"=="7" goto run_quick_regression
if "%CHOICE%"=="8" goto run_snapshot
if /I "%CHOICE%"=="D" goto open_docs
if "%CHOICE%"=="0" goto done

echo [WARN] Invalid input. Please enter 0-8 or D.
pause
goto menu

:run_publish
if not exist "%BASE_DIR%\01_publish_only.bat" (
  echo [ERROR] Missing script: %BASE_DIR%\01_publish_only.bat
  pause
  goto menu
)
call "%BASE_DIR%\01_publish_only.bat"
call :pause_result
goto menu

:do_publish_once
if not exist "%BASE_DIR%\01_publish_only.bat" (
  echo [ERROR] Missing script: %BASE_DIR%\01_publish_only.bat
  exit /b 1
)
call "%BASE_DIR%\01_publish_only.bat"
if errorlevel 1 exit /b 1
exit /b 0

:run_restart
if not exist "%BASE_DIR%\02_restart_only.bat" (
  echo [ERROR] Missing script: %BASE_DIR%\02_restart_only.bat
  pause
  goto menu
)
call "%BASE_DIR%\02_restart_only.bat"
call :pause_result
goto menu

:do_restart_once
if not exist "%BASE_DIR%\02_restart_only.bat" (
  echo [ERROR] Missing script: %BASE_DIR%\02_restart_only.bat
  exit /b 1
)
call "%BASE_DIR%\02_restart_only.bat"
if errorlevel 1 exit /b 1
exit /b 0

:run_release_verify
if not exist "%BASE_DIR%\03_publish_restart_verify.bat" (
  echo [ERROR] Missing script: %BASE_DIR%\03_publish_restart_verify.bat
  pause
  goto menu
)
call "%BASE_DIR%\03_publish_restart_verify.bat"
call :pause_result
goto menu

:do_release_verify_once
if not exist "%BASE_DIR%\03_publish_restart_verify.bat" (
  echo [ERROR] Missing script: %BASE_DIR%\03_publish_restart_verify.bat
  exit /b 1
)
call "%BASE_DIR%\03_publish_restart_verify.bat"
if errorlevel 1 exit /b 1
exit /b 0

:run_verify
if not exist "%VERIFY_SCRIPT%" (
  echo [ERROR] Missing script: %VERIFY_SCRIPT%
  pause
  goto menu
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%VERIFY_SCRIPT%" -ProjectDir "%PROJECT_DIR%" -DeployDir "%DEPLOY_DIR%" -Port %PORT%
call :pause_result
goto menu

:do_verify_once
if not exist "%VERIFY_SCRIPT%" (
  echo [ERROR] Missing script: %VERIFY_SCRIPT%
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%VERIFY_SCRIPT%" -ProjectDir "%PROJECT_DIR%" -DeployDir "%DEPLOY_DIR%" -Port %PORT%
if errorlevel 1 exit /b 1
exit /b 0

:run_self_check
call :self_check
call :pause_result
goto menu

:do_self_check_once
call :self_check
if errorlevel 1 exit /b 1
exit /b 0

:run_quick_regression
call :quick_regression
call :pause_result
goto menu

:do_quick_regression_once
call :quick_regression
if errorlevel 1 exit /b 1
exit /b 0

:run_snapshot
call :capture_snapshot
call :pause_result
goto menu

:do_snapshot_once
call :capture_snapshot
if errorlevel 1 exit /b 1
exit /b 0

:show_logs
if not exist "%LOG_FILE%" (
  echo [WARN] Log file not found: %LOG_FILE%
) else (
  call :print_log_tail
)
pause
goto menu

:do_logs_once
if not exist "%LOG_FILE%" (
  echo [WARN] Log file not found: %LOG_FILE%
  exit /b 1
)
call :print_log_tail
if errorlevel 1 exit /b 1
exit /b 0

:open_docs
if exist "%BASE_DIR%\DEPLOYMENT_POST_RELEASE.md" (
  start "" "%BASE_DIR%\DEPLOYMENT_POST_RELEASE.md"
) else (
  echo [WARN] Document not found: %BASE_DIR%\DEPLOYMENT_POST_RELEASE.md
  pause
)
goto menu

:do_docs_once
if not exist "%BASE_DIR%\DEPLOYMENT_POST_RELEASE.md" (
  echo [ERROR] Document not found: %BASE_DIR%\DEPLOYMENT_POST_RELEASE.md
  exit /b 1
)
start "" "%BASE_DIR%\DEPLOYMENT_POST_RELEASE.md"
if errorlevel 1 exit /b 1
exit /b 0

:self_check
set "SC_FAILED=0"
echo [CHECK] Required scripts and docs in deploy-post-release
for %%F in ("00_post_release_menu.bat" "01_publish_only.bat" "02_restart_only.bat" "03_publish_restart_verify.bat" "verify_post_release.ps1" "DEPLOYMENT_POST_RELEASE.md") do (
  if exist "%BASE_DIR%\%%~F" (
    echo [PASS] %%~F
  ) else (
    echo [FAIL] %%~F is missing
    set "SC_FAILED=1"
  )
)

echo [CHECK] Project/deploy entry files
if exist "%DEPLOY_MENU%" (
  echo [PASS] deploy_menu.bat exists
) else (
  echo [FAIL] deploy_menu.bat missing: %DEPLOY_MENU%
  set "SC_FAILED=1"
)
if exist "%DEPLOY_DIR%\config.runtime.json" (
  echo [PASS] config.runtime.json exists
) else (
  echo [WARN] config.runtime.json missing: %DEPLOY_DIR%\config.runtime.json
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo [FAIL] powershell is not available in PATH
  set "SC_FAILED=1"
) else (
  echo [PASS] powershell is available
)

where node >nul 2>nul
if errorlevel 1 (
  echo [WARN] node is not available in PATH
) else (
  echo [PASS] node is available
)

if "%SC_FAILED%"=="1" exit /b 1
echo [OK] Self-check passed.
exit /b 0

:quick_regression
call :capture_snapshot_soft
call :self_check
if errorlevel 1 (
  echo [ERROR] Self-check failed. Skip verify.
  exit /b 1
)
if not exist "%VERIFY_SCRIPT%" (
  echo [ERROR] Missing script: %VERIFY_SCRIPT%
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%VERIFY_SCRIPT%" -ProjectDir "%PROJECT_DIR%" -DeployDir "%DEPLOY_DIR%" -Port %PORT%
if errorlevel 1 exit /b 1
echo [OK] Quick regression passed.
exit /b 0

:capture_snapshot
if not exist "%SNAPSHOT_SCRIPT%" (
  echo [ERROR] Missing script: %SNAPSHOT_SCRIPT%
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SNAPSHOT_SCRIPT%" -ProjectDir "%PROJECT_DIR%" -DeployDir "%DEPLOY_DIR%" -BaseDir "%BASE_DIR%"
if errorlevel 1 exit /b 1
exit /b 0

:capture_snapshot_soft
if not exist "%SNAPSHOT_SCRIPT%" (
  echo [WARN] Snapshot script not found: %SNAPSHOT_SCRIPT%
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SNAPSHOT_SCRIPT%" -ProjectDir "%PROJECT_DIR%" -DeployDir "%DEPLOY_DIR%" -BaseDir "%BASE_DIR%"
if errorlevel 1 (
  echo [WARN] Snapshot capture failed. Continue regression.
)
exit /b 0

:print_log_tail
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%LOG_FILE%'; $n=%LOG_TAIL%; try { Get-Content -Path $p -Tail $n -Encoding UTF8 -ErrorAction Stop } catch { Get-Content -Path $p -Tail $n }"
if errorlevel 1 exit /b 1
exit /b 0

:pause_result
if errorlevel 1 (
  echo.
  echo [RESULT] Failed.
) else (
  echo.
  echo [RESULT] Success.
)
pause
exit /b 0

:done
echo Exit post-release toolkit.
endlocal
exit /b 0
