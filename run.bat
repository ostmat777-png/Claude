@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"

rem ---- already installed: start immediately
if exist "%VENV%\.installed" goto run

echo ================================================================
echo  First start: installing Python 3.12, PyTorch (CUDA 12.8) and libraries.
echo  This happens only once and takes 5-15 minutes (about 3 GB).
echo ================================================================

where uv >nul 2>nul
if errorlevel 1 (
  echo Installing uv package manager...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)
where uv >nul 2>nul
if errorlevel 1 (
  py -3 -m pip install --user uv
  set "UVCMD=py -3 -m uv"
) else (
  set "UVCMD=uv"
)

%UVCMD% venv "%VENV%" --python 3.12 || goto fail
echo Installing PyTorch with CUDA 12.8 (RTX 50xx / Blackwell)...
%UVCMD% pip install --python "%PY%" torch torchvision --index-url https://download.pytorch.org/whl/cu128 || goto fail
echo Installing libraries...
%UVCMD% pip install --python "%PY%" -r requirements.txt || goto fail
echo Downloading neural models (DINOv2, SigLIP)...
"%PY%" -m zabroshki prefetch-models
echo ok> "%VENV%\.installed"

:run
"%PY%" -m zabroshki %*
if errorlevel 1 pause
goto :eof

:fail
echo.
echo Installation failed. See README.md (section "Если что-то пошло не так").
pause
exit /b 1
