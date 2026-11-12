@echo off
rem Kaplya: start the app. The first start downloads what is needed (about 130 MB,
rem a few minutes); after that it starts at once.
rem
rem   run.bat            start
rem   run.bat --check    only prepare everything and say whether it worked
setlocal
cd /d "%~dp0"
set "ROOT=%~dp0"
set "TOOLS=%ROOT%.tools"
set "NODE_VER=v22.21.1"
set "NODE_NAME=node-%NODE_VER%-win-x64"
set "LOG=%ROOT%install.log"
set "CHECK="
if /i "%~1"=="--check" set "CHECK=1"

rem ---- 1. Node.js: the one installed on this computer, or our own copy in .tools
set "HAVE_NODE="
if exist "%TOOLS%\node\node.exe" set "PATH=%TOOLS%\node;%PATH%"
node "%ROOT%tools\check-node.js" >nul 2>nul && set "HAVE_NODE=1"
if defined HAVE_NODE goto libs

echo ================================================================
echo  First start: downloading Node.js (about 30 MB) into this folder.
echo  Nothing is installed into Windows itself.
echo ================================================================
echo node download started %DATE% %TIME% > "%LOG%"
if not exist "%TOOLS%" mkdir "%TOOLS%"
curl.exe -L --fail --retry 3 -o "%TOOLS%\node.zip" "https://nodejs.org/dist/%NODE_VER%/%NODE_NAME%.zip" >> "%LOG%" 2>&1
if errorlevel 1 goto nonode
if exist "%TOOLS%\%NODE_NAME%" rmdir /s /q "%TOOLS%\%NODE_NAME%"
tar.exe -xf "%TOOLS%\node.zip" -C "%TOOLS%" >> "%LOG%" 2>&1
if errorlevel 1 goto nonode
if exist "%TOOLS%\node" rmdir /s /q "%TOOLS%\node"
ren "%TOOLS%\%NODE_NAME%" node
del "%TOOLS%\node.zip"
set "PATH=%TOOLS%\node;%PATH%"
node "%ROOT%tools\check-node.js" >nul 2>nul
if errorlevel 1 goto nonode

:libs
rem ---- 2. libraries: once, and again when the list of them changes
if not exist "%ROOT%node_modules\electron\dist\electron.exe" goto install
fc /b "%ROOT%package-lock.json" "%ROOT%node_modules\.kaplya-lock" >nul 2>nul
if errorlevel 1 goto install
goto start

:install
echo ================================================================
echo  Installing Kaplya (about 100 MB, a couple of minutes).
echo  This happens once. Details are written to install.log
echo ================================================================
echo install started %DATE% %TIME% >> "%LOG%"
call npm ci --no-audit --no-fund >> "%LOG%" 2>&1
if errorlevel 1 call npm install --no-audit --no-fund >> "%LOG%" 2>&1
if errorlevel 1 goto fail
rem Electron fetches its program on first use; do it now, while the window is open.
node "%ROOT%node_modules\electron\install.js" >> "%LOG%" 2>&1
if not exist "%ROOT%node_modules\electron\dist\electron.exe" goto fail
copy /y "%ROOT%package-lock.json" "%ROOT%node_modules\.kaplya-lock" >nul
echo Installed.

:start
if defined CHECK goto check
start "" "%ROOT%node_modules\electron\dist\electron.exe" "%ROOT%."
exit /b 0

:check
"%ROOT%node_modules\electron\dist\electron.exe" --version
if errorlevel 1 goto fail
echo Kaplya is ready to start.
exit /b 0

:nonode
echo.
echo Node.js could not be downloaded (no internet, or the site is blocked).
echo Install Node.js LTS from https://nodejs.org and run run.bat again.
if not defined CHECK pause
exit /b 1

:fail
echo.
echo Installation failed. The last lines of install.log:
powershell -NoProfile -Command "Get-Content -Tail 25 '%LOG%'"
echo.
echo See README.md, section "Esli chto-to ne tak" (if something goes wrong).
if not defined CHECK pause
exit /b 1
