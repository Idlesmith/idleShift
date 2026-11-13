@echo off
rem Open IdleShift. Starts the service if needed and restarts it automatically when the code changed.
setlocal
set "APP=%~dp0bin\idleshift.mjs"
set "NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if defined IDLESHIFT_NODE if exist "%IDLESHIFT_NODE%" set "NODE=%IDLESHIFT_NODE%"
if not defined NODE (
  echo Node.js was not found. Running IdleShift from source needs Node.js 22.13 or later.
  echo Get it from https://nodejs.org/ and reopen this window after installing.
  echo To use a node.exe that is not on PATH, set IDLESHIFT_NODE to its full path.
  pause
  exit /b 1
)
if /i "%~1"=="restart" "%NODE%" "%APP%" stop
"%NODE%" "%APP%" gui
if errorlevel 1 pause
