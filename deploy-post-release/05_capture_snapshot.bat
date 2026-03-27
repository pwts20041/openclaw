@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"
set "SNAPSHOT_SCRIPT=%BASE_DIR%\capture_snapshot.ps1"
set "PROJECT_DIR=%BASE_DIR%\.."
if defined OPENCLAW_DEPLOY_DIR (
  set "DEPLOY_DIR=%OPENCLAW_DEPLOY_DIR%"
) else (
  set "DEPLOY_DIR=D:\OpenClaw\deploy"
)

if not exist "%SNAPSHOT_SCRIPT%" (
  echo [ERROR] Missing script: %SNAPSHOT_SCRIPT%
  exit /b 1
)

echo [STEP] Capture environment snapshot
powershell -NoProfile -ExecutionPolicy Bypass -File "%SNAPSHOT_SCRIPT%" -ProjectDir "%PROJECT_DIR%" -DeployDir "%DEPLOY_DIR%" -BaseDir "%BASE_DIR%"
if errorlevel 1 (
  echo [ERROR] Snapshot capture failed.
  exit /b 1
)

echo [OK] Snapshot capture completed.
exit /b 0
