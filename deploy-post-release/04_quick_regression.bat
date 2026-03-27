@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"

echo [STEP] Run quick regression (self-check + verify)
call "%BASE_DIR%\00_post_release_menu.bat" quick-regression
if errorlevel 1 (
  echo [ERROR] Quick regression failed.
  exit /b 1
)

echo [OK] Quick regression passed.
exit /b 0
