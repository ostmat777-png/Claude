@echo off
rem Kaplya: start the app. The first start downloads what is needed (about 130 MB,
rem a few minutes); after that it starts at once.
rem
rem   run.bat            start
rem   run.bat --check    only prepare everything and say whether it worked
rem
rem Everything below uses paths relative to this folder. Some of the tools used
rem here (tar) cannot open a path with letters outside the system code page, and
rem this folder may well have Russian letters somewhere in its path.
setlocal
cd /d "%~dp0"
set "NODE_VER=v22.21.1"
set "NODE_NAME=node-%NODE_VER%-win-x64"
set "CHECK="
if /i "%~1"=="--check" set "CHECK=1"

rem ---- 1. Node.js: the one installed on this computer, or our own copy in .tools
set "HAVE_NODE="
if exist ".tools\node\node.exe" set "PATH=%~dp0.tools\node;%PATH%"
node tools\check-node.js >nul 2>nul && set "HAVE_NODE=1"
if defined HAVE_NODE goto libs

echo ================================================================
echo  First start: downloading Node.js (about 30 MB) into this folder.
echo  Nothing is installed into Windows itself.
echo ================================================================
echo node download started %DATE% %TIME% > install.log
if not exist ".tools" mkdir ".tools"
pushd ".tools"
curl.exe -L --fail --retry 3 -o node.zip "https://nodejs.org/dist/%NODE_VER%/%NODE_NAME%.zip" >> ..\install.log 2>&1
if errorlevel 1 (popd & goto nonode)
if exist "%NODE_NAME%" rmdir /s /q "%NODE_NAME%"
tar.exe -xf node.zip >> ..\install.log 2>&1
if errorlevel 1 (popd & goto nonode)
if exist node rmdir /s /q node
ren "%NODE_NAME%" node
del node.zip
popd
set "PATH=%~dp0.tools\node;%PATH%"
node tools\check-node.js >nul 2>nul
if errorlevel 1 goto nonode

:libs
rem ---- 2. libraries: once, and again when the list of them changes
if not exist "node_modules\electron\dist\electron.exe" goto install
fc /b package-lock.json node_modules\.kaplya-lock >nul 2>nul
if errorlevel 1 goto install
goto start

:install
echo ================================================================
echo  Installing Kaplya (about 100 MB, a couple of minutes).
echo  This happens once. Details are written to install.log
echo ================================================================
echo install started %DATE% %TIME% >> install.log
call npm ci --no-audit --no-fund >> install.log 2>&1
if errorlevel 1 call npm install --no-audit --no-fund >> install.log 2>&1
if errorlevel 1 goto fail
rem Electron fetches its program on first use; do it now, while the window is open.
node node_modules\electron\install.js >> install.log 2>&1
if not exist "node_modules\electron\dist\electron.exe" goto fail
copy /y package-lock.json node_modules\.kaplya-lock >nul
echo Installed.

:start
if defined CHECK goto check
start "" node_modules\electron\dist\electron.exe .
exit /b 0

:check
node_modules\electron\dist\electron.exe --version
if errorlevel 1 goto fail
echo Kaplya is ready to start.
exit /b 0

:nonode
echo.
echo Node.js could not be downloaded or unpacked (no internet, or the site is blocked).
if exist install.log powershell -NoProfile -Command "Get-Content -Tail 8 install.log"
echo.
echo Install Node.js LTS from https://nodejs.org and run run.bat again.
if not defined CHECK pause
exit /b 1

:fail
echo.
echo Installation failed. The last lines of install.log:
powershell -NoProfile -Command "Get-Content -Tail 25 install.log"
echo.
echo See README.md, the section about problems ("Esli chto-to ne tak").
if not defined CHECK pause
exit /b 1
