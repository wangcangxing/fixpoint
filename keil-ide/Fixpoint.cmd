@echo off
setlocal
rem --- Fixpoint launcher ------------------------------------------------------
rem 1) Some shells export ELECTRON_RUN_AS_NODE=1. Electron then starts as plain
rem    Node and dies with: "does not provide an export named 'BrowserWindow'".
rem    `set VAR=` deletes the variable for this process tree.
rem 2) %~dp0 ends with a backslash, and a quoted argument ending in `\` escapes
rem    its closing quote on Windows, so Electron would receive a broken app path
rem    and show an "Error" dialog. Strip the trailing backslash first.
set "ELECTRON_RUN_AS_NODE="
set "HERE=%~dp0"
set "APPDIR=%HERE:~0,-1%"
if not exist "%APPDIR%\node_modules\electron\dist\electron.exe" (
  echo [Fixpoint] Electron not found. Run "pnpm install" in:
  echo            %APPDIR%
  pause
  exit /b 1
)
start "" "%APPDIR%\node_modules\electron\dist\electron.exe" "%APPDIR%"
