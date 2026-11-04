@echo off
setlocal
cd /d "%~dp0"
set "ROOT=%~dp0"
set "VENV=%ROOT%.venv"
set "PY=%VENV%\Scripts\python.exe"
set "TOOLS=%ROOT%.tools"
set "UV=%TOOLS%\uv.exe"
set "LOG=%ROOT%install.log"
set "BACKEND="
set "GPUDESC="
set "REINSTALL="
set "ARGS="

rem ---- own options: --reinstall, --backend cu128|cu126|cu118|xpu|directml|cpu ; everything else goes to the program
:args
if "%~1"=="" goto argsdone
if /i "%~1"=="--reinstall" (set "REINSTALL=1" & shift & goto args)
if /i "%~1"=="--backend" (set "BACKEND=%~2" & set "REINSTALL=1" & shift & shift & goto args)
set "ARGS=%ARGS% %1"
shift
goto args
:argsdone
if defined REINSTALL if exist "%VENV%\.installed" del "%VENV%\.installed"

rem ---- already installed: update libraries if requirements.txt changed, then start
if exist "%VENV%\.installed" goto checkupdate

echo ================================================================
echo  First start: installing Python 3.12, PyTorch and libraries.
echo  This happens only once and takes 5-15 minutes (1-4 GB).
echo  Details are written to install.log
echo ================================================================
echo install started %DATE% %TIME% > "%LOG%"
if exist "%VENV%" rmdir /s /q "%VENV%"

rem ---- 0. which compute device: NVIDIA (CUDA) / AMD, Intel (DirectML) / Intel Arc (XPU) / CPU
if defined BACKEND goto havebackend
for /f "usebackq tokens=1,* delims=|" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\detect_gpu.ps1"`) do (
  set "BACKEND=%%a"
  set "GPUDESC=%%b"
)
if not defined BACKEND set "BACKEND=cpu"
:havebackend
echo Video adapter: %GPUDESC%
echo PyTorch build: %BACKEND%   (override: run.bat --backend cu128^|cu126^|cu118^|xpu^|directml^|cpu)
echo backend %BACKEND% / %GPUDESC% >> "%LOG%"

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
set PIP="%UV%" pip install --python "%PY%"
goto libs

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
set PIP="%PY%" -m pip install

:libs
echo [3/5] Installing PyTorch for %BACKEND% ...
call :torch
if errorlevel 1 goto torchfallback
"%PY%" -c "import torch" >> "%LOG%" 2>&1
if errorlevel 1 goto torchfallback
goto torchok
:torchfallback
echo PyTorch for %BACKEND% could not be installed - falling back to the CPU version.
set "BACKEND=cpu"
call :torch
if errorlevel 1 echo WARNING: PyTorch is not available on this computer - the program will work without neural networks (OSM + classic image features).
:torchok
echo [4/5] Installing libraries...
if /i "%BACKEND%"=="directml" goto libsdml
%PIP% -r requirements.txt >> "%LOG%" 2>&1
if errorlevel 1 goto fail
goto models
:libsdml
%PIP% -r requirements.txt -c tools\constraints-directml.txt >> "%LOG%" 2>&1
if errorlevel 1 goto fail

:models
copy /y "requirements.txt" "%VENV%\req.txt" >nul
echo %BACKEND%> "%VENV%\backend.txt"
echo ok> "%VENV%\.installed"
echo [5/5] Downloading neural models (DINOv2, SigLIP, ~1 GB) and testing the device...
echo       (if it hangs: close the window and start run.bat again)
"%PY%" -m zabroshki prefetch-models
echo Installation finished.
goto run

:torch
if /i "%BACKEND%"=="directml" (
  %PIP% torch-directml >> "%LOG%" 2>&1
  exit /b
)
set "IDX=https://download.pytorch.org/whl/%BACKEND%"
%PIP% torch torchvision --index-url %IDX% >> "%LOG%" 2>&1
exit /b

:checkupdate
fc /b "requirements.txt" "%VENV%\req.txt" >nul 2>nul
if not errorlevel 1 goto run
echo Updating libraries...
set "CONSTR="
set "OLDBACKEND="
if exist "%VENV%\backend.txt" set /p OLDBACKEND=<"%VENV%\backend.txt"
if /i "%OLDBACKEND%"=="directml" set "CONSTR=-c tools\constraints-directml.txt"
if exist "%UV%" (
  "%UV%" pip install --python "%PY%" -r requirements.txt %CONSTR% >> "%LOG%" 2>&1
) else (
  "%PY%" -m pip install -r requirements.txt %CONSTR% >> "%LOG%" 2>&1
)
copy /y "requirements.txt" "%VENV%\req.txt" >nul

:run
"%PY%" -m zabroshki %ARGS%
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
