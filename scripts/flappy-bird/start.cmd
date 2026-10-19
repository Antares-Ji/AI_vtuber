@echo off
setlocal
set "FLAPPY_PYTHON=%~dp0..\..\runtime\flappy-bird\.venv\Scripts\python.exe"
if not exist "%FLAPPY_PYTHON%" (
    echo Flappy Bird Python environment is missing. See docs\flappy-bird-ai.md for installation.
    pause
    exit /b 1
)
"%FLAPPY_PYTHON%" "%~dp0launch.py" %*
if errorlevel 1 (
    pause
    exit /b 1
)
exit /b 0
