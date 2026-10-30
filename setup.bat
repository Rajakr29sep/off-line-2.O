@echo off
rem One-time setup (needs internet). Installs Node and Python packages only.
rem Large assets (maps, knowledge pack, voice models, Ollama models) are prepared with separate, explicit commands - see README.
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || (echo Install Node.js 22+ first: https://nodejs.org & exit /b 1)
call npm install || exit /b 1
if not exist "python_service\.venv\Scripts\python.exe" (
  py -3.11 -m venv python_service\.venv || (echo Python 3.11 not found. Install it from python.org or run: winget install Python.Python.3.11 & exit /b 1)
)
python_service\.venv\Scripts\python.exe -m pip install -r python_service\requirements.txt || exit /b 1
if not exist ".env" copy .env.example .env >nul
echo.
echo Setup complete. Next (only if the files are missing):
echo   python_service\.venv\Scripts\python.exe scripts\build_zim_pack.py      (knowledge pack from knowledge_base\*.pdf)
echo   python_service\.venv\Scripts\python.exe scripts\prepare_map.py         (OSM places + road graph)
echo   tools\pmtiles.exe extract ...                                          (basemap - see README)
echo   python_service\.venv\Scripts\python.exe scripts\prepare_voice.py       (optional voice models)
echo Then run start.bat
