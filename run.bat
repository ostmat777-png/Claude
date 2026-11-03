@echo off
setlocal
cd /d "%~dp0"
set "ROOT=%~dp0"
set "VENV=%ROOT%.venv"
set "PY=%VENV%\Scripts\python.exe"
set "TOOLS=%ROOT%.tools"
set "UV=%TOOLS%\uv.exe"
set "LOG=%ROOT%install.log"

rem ---- already installed: update libraries if requirements.txt changed, then start
if exist "%VENV%\.installed" goto checkupdate

echo ================================================================
echo  First start: installing Python 3.12, PyTorch (CUDA 12.8) and libraries.
echo  This happens only once and takes 5-15 minutes (about 3-4 GB).
echo  Details are written to install.log
echo ================================================================
echo install started %DATE% %TIME% > "%LOG%"
if exist "%VENV%" rmdir /s /q "%VENV%"

rem ---- 1. uv (fast installer) into .tools, no PATH changes needed
if exist "%UV%" goto haveuv
echo [1/5] Downloading uv installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:UV_INSTALL_DIR='%TOOLS%'; $env:UV_NO_MODIFY_PATH='1'; irm https://astral.sh/uv/install.ps1 | iex" >> "%LOG%" 2>&1
if exist "%UV%" goto haveuv
if exist "%TOOLS%\bin\uv.exe" set "UV=%TOOLS%\bin\uv.exe"
if exist "%UV%" goto haveuv
echo uv could not be downloaded - trying the Python already installed on this computer...
goto pipinstall

:haveuv
echo [2/5] Creating Python 3.12 environment...
"%UV%" venv "%VENV%" --python 3.12 >> "%LOG%" 2>&1
if errorlevel 1 goto pipinstall
echo [3/5] Installing PyTorch with CUDA 12.8 (RTX 50xx / Blackwell), ~3 GB...
"%UV%" pip install --python "%PY%" torch torchvision --index-url https://download.pytorch.org/whl/cu128 >> "%LOG%" 2>&1
if errorlevel 1 goto fail
echo [4/5] Installing libraries...
"%UV%" pip install --python "%PY%" -r requirements.txt >> "%LOG%" 2>&1
if errorlevel 1 goto fail
goto models

:pipinstall
set "SYSPY="
py -3.12 -c "import sys" >nul 2>nul && set "SYSPY=py -3.12"
if not defined SYSPY py -3 -c "import sys" >nul 2>nul && set "SYSPY=py -3"
if not defined SYSPY python -c "import sys" >nul 2>nul && set "SYSPY=python"
if not defined SYSPY goto nopython
echo [2/5] Creating environment with %SYSPY% ...
if exist "%VENV%" rmdir /s /q "%VENV%"
%SYSPY% -m venv "%VENV%" >> "%LOG%" 2>&1
if errorlevel 1 goto fail
"%PY%" -m pip install --upgrade pip >> "%LOG%" 2>&1
echo [3/5] Installing PyTorch with CUDA 12.8 (RTX 50xx / Blackwell), ~3 GB...
"%PY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128 >> "%LOG%" 2>&1
if errorlevel 1 goto fail
echo [4/5] Installing libraries...
"%PY%" -m pip install -r requirements.txt >> "%LOG%" 2>&1
if errorlevel 1 goto fail

:models
copy /y "requirements.txt" "%VENV%\req.txt" >nul
echo [5/5] Downloading neural models (DINOv2, SigLIP, ~1 GB)...
"%PY%" -m zabroshki prefetch-models
echo ok> "%VENV%\.installed"
echo Installation finished.
goto run

:checkupdate
fc /b "requirements.txt" "%VENV%\req.txt" >nul 2>nul
if not errorlevel 1 goto run
echo Updating libraries...
if exist "%UV%" goto updateuv
"%PY%" -m pip install -r requirements.txt >> "%LOG%" 2>&1
goto updated
:updateuv
"%UV%" pip install --python "%PY%" -r requirements.txt >> "%LOG%" 2>&1
:updated
copy /y "requirements.txt" "%VENV%\req.txt" >nul

:run
"%PY%" -m zabroshki %*
if errorlevel 1 pause
exit /b 0

:nopython
echo.
echo Could not download uv and no Python found on this computer.
echo Install Python 3.12 from https://www.python.org/downloads/ (tick "Add python.exe to PATH")
echo and run run.bat again.
pause
exit /b 1

:fail
echo.
echo Installation failed. The last lines of install.log:
powershell -NoProfile -Command "Get-Content -Tail 25 '%LOG%'"
echo.
echo Send install.log to the developer / see README.md ("If something goes wrong").
pause
exit /b 1
