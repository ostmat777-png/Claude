@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"

rem ---- already installed: update libraries only if requirements.txt changed, then start
if exist "%VENV%\.installed" (
  fc /b "requirements.txt" "%VENV%\req.txt" >/dev/null 2>nul
  if errorlevel 1 call :update
  goto run
)

echo ================================================================
echo  First start: installing Python 3.12, PyTorch (CUDA 12.8) and libraries.
echo  This happens only once and takes 5-15 minutes (about 3-4 GB).
echo ================================================================
call :finduv || goto fail
%UVCMD% venv "%VENV%" --python 3.12 || goto fail
echo Installing PyTorch with CUDA 12.8 (RTX 50xx / Blackwell)...
%UVCMD% pip install --python "%PY%" torch torchvision --index-url https://download.pytorch.org/whl/cu128 || goto fail
echo Installing libraries...
%UVCMD% pip install --python "%PY%" -r requirements.txt || goto fail
copy /y "requirements.txt" "%VENV%\req.txt" >nul
echo Downloading neural models (DINOv2, SigLIP)...
"%PY%" -m zabroshki prefetch-models
echo ok> "%VENV%\.installed"

:run
"%PY%" -m zabroshki %*
if errorlevel 1 pause
goto :eof

:update
echo Updating libraries...
call :finduv || exit /b 0
%UVCMD% pip install --python "%PY%" -r requirements.txt && copy /y "requirements.txt" "%VENV%\req.txt" >nul
exit /b 0

:finduv
where uv >/dev/null 2>nul
if not errorlevel 1 ( set "UVCMD=uv" & exit /b 0 )
if exist "%USERPROFILE%\.local\bin\uv.exe" ( set UVCMD="%USERPROFILE%\.local\bin\uv.exe"& exit /b 0 )
if exist "%USERPROFILE%\.cargo\bin\uv.exe" ( set UVCMD="%USERPROFILE%\.cargo\bin\uv.exe"& exit /b 0 )
echo Installing uv package manager...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
if exist "%USERPROFILE%\.local\bin\uv.exe" ( set UVCMD="%USERPROFILE%\.local\bin\uv.exe"& exit /b 0 )
if exist "%USERPROFILE%\.cargo\bin\uv.exe" ( set UVCMD="%USERPROFILE%\.cargo\bin\uv.exe"& exit /b 0 )
py -3 -m pip install --user uv && ( set "UVCMD=py -3 -m uv" & exit /b 0 )
echo Could not install uv.
exit /b 1

:fail
echo.
echo Installation failed. See README.md (section "If something goes wrong").
pause
exit /b 1
