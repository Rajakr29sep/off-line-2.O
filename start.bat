@echo off
setlocal EnableExtensions EnableDelayedExpansion
title OfflineAid launcher
cd /d "%~dp0"

echo.
echo  ============================================================
echo    OfflineAid  -  Prepare. Navigate. Respond. Even Offline.
echo  ============================================================
echo.

set "FAIL=0"
if not exist ".env" if exist ".env.example" copy /y ".env.example" ".env" >nul
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  set "line=%%A"
  if not "!line:~0,1!"=="#" if not "%%B"=="" set "%%A=%%B"
)
if not defined PORT set "PORT=3000"
if not defined OLLAMA_MODEL set "OLLAMA_MODEL=llama3.2:3b"
if not defined OLLAMA_EMBEDDING_MODEL set "OLLAMA_EMBEDDING_MODEL=nomic-embed-text"

rem ---------------------------------------------------------------- 1. Node.js
where node >nul 2>&1 || (echo [X] Node.js not found. Install Node.js 22+ from nodejs.org, then run setup.bat. & set "FAIL=1" & goto :summary)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v
if not exist "node_modules\express" (echo [X] Node packages missing. Run setup.bat first. & set "FAIL=1" & goto :summary)

rem ---------------------------------------------------------------- 2. Python venv
set "PY=python_service\.venv\Scripts\python.exe"
if not exist "%PY%" (echo [X] Python environment missing. Run setup.bat first ^(needs Python 3.11^). & set "FAIL=1" & goto :summary)
for /f "delims=" %%v in ('"%PY%" --version') do echo [OK] %%v ^(python_service\.venv^)

rem ---------------------------------------------------------------- 3. Directories and data assets
for %%D in (data data\uploads data\zim data\maps data\ai_cache) do if not exist "%%D" mkdir "%%D"
echo [OK] Data directories present
if exist "data\maps\region.pmtiles" (echo [OK] Offline basemap data\maps\region.pmtiles) else (echo [!] Offline basemap missing - see README "Map package preparation")
if exist "data\maps\roadgraph.json" (echo [OK] Road graph data\maps\roadgraph.json) else (echo [!] Road graph missing - run: %PY% scripts\prepare_map.py)
if exist "data\zim\offlineaid_emergency_en.zim" (echo [OK] Knowledge pack data\zim\offlineaid_emergency_en.zim) else (echo [!] Knowledge pack missing - run: %PY% scripts\build_zim_pack.py)

rem ---------------------------------------------------------------- 4. SQLite
node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('create virtual table t using fts5(a)')" >nul 2>&1 && (echo [OK] SQLite with FTS5 ^(node:sqlite^)) || (echo [X] node:sqlite unavailable. Use Node.js 22.13+ or 24. & set "FAIL=1" & goto :summary)

rem ---------------------------------------------------------------- 5-8. Ollama + models (never downloaded automatically)
where ollama >nul 2>&1 || (echo [X] Ollama is not installed. Install it from ollama.com, then: ollama pull %OLLAMA_MODEL% and ollama pull %OLLAMA_EMBEDDING_MODEL% & set "FAIL=1" & goto :summary)
ollama list >nul 2>&1
if errorlevel 1 (
  echo [..] Ollama not running - starting "ollama serve" in the background
  start "OfflineAid-Ollama" /min cmd /c "ollama serve"
  set "OA_STARTED_OLLAMA=1"
  powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){try{Invoke-RestMethod http://127.0.0.1:11434/api/tags -TimeoutSec 2|Out-Null;exit 0}catch{Start-Sleep 1}};exit 1" || (echo [X] Ollama did not start. & set "FAIL=1" & goto :summary)
)
echo [OK] Ollama running
ollama list | findstr /i /c:"%OLLAMA_MODEL%" >nul && (echo [OK] LLM %OLLAMA_MODEL% available) || (echo [X] %OLLAMA_MODEL% not found in "ollama list". Run once while online: ollama pull %OLLAMA_MODEL% & set "FAIL=1")
ollama list | findstr /i /c:"%OLLAMA_EMBEDDING_MODEL%" >nul && (echo [OK] Embeddings %OLLAMA_EMBEDDING_MODEL% available) || (echo [X] %OLLAMA_EMBEDDING_MODEL% not found. Run once while online: ollama pull %OLLAMA_EMBEDDING_MODEL% & set "FAIL=1")
if "%FAIL%"=="1" goto :summary

rem ---------------------------------------------------------------- 9. FastAPI AI service
set "ANONYMIZED_TELEMETRY=False"
powershell -NoProfile -Command "try{Invoke-RestMethod http://127.0.0.1:8000/health -TimeoutSec 2|Out-Null;exit 0}catch{exit 1}" && (echo [OK] AI service already running on :8000) || (
  echo [..] Starting AI service ^(FastAPI^) on 127.0.0.1:8000
  start "OfflineAid-AI" /min cmd /c ""%PY%" -m uvicorn main:app --app-dir python_service --host 127.0.0.1 --port 8000"
)

rem ---------------------------------------------------------------- 10. Express
powershell -NoProfile -Command "try{Invoke-RestMethod http://127.0.0.1:%PORT%/api/health -TimeoutSec 2|Out-Null;exit 0}catch{exit 1}" && (echo [OK] Web server already running on :%PORT%) || (
  echo [..] Starting web server ^(Express^) on port %PORT%
  start "OfflineAid-Web" /min cmd /c "node server.js"
)

rem ---------------------------------------------------------------- 11. Wait for both health endpoints
echo [..] Waiting for services ^(the AI model warms up on first start^)...
powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{$a=Invoke-RestMethod http://127.0.0.1:8000/health -TimeoutSec 3;$n=Invoke-RestMethod http://127.0.0.1:%PORT%/api/health -TimeoutSec 3;if($a.llm.warm){exit 0}}catch{};Start-Sleep 1};exit 1"
if errorlevel 1 (echo [!] Services slow to become ready - check the minimised OfflineAid-AI / OfflineAid-Web windows.) else (echo [OK] Web server and AI service healthy, model loaded)

rem ---------------------------------------------------------------- 12-13. URLs
echo.
echo  Open on this laptop:   http://localhost:%PORT%
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | ForEach-Object { $_.IPAddress }"`) do echo  Phones on same Wi-Fi:  http://%%I:%PORT%
echo.
echo  Demo logins: admin/1111  officer/2222  emp1/3333  emp2/4444  citizen/5555  gov/6666
echo.
if not defined OA_NO_BROWSER start "" "http://localhost:%PORT%"
echo  Press any key in THIS window to stop OfflineAid...
pause >nul

rem ---------------------------------------------------------------- graceful shutdown
echo Stopping OfflineAid...
taskkill /FI "WINDOWTITLE eq OfflineAid-Web*" /T >nul 2>&1
taskkill /FI "WINDOWTITLE eq OfflineAid-AI*" /T >nul 2>&1
ping -n 3 127.0.0.1 >nul
taskkill /FI "WINDOWTITLE eq OfflineAid-Web*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq OfflineAid-AI*" /T /F >nul 2>&1
if defined OA_STARTED_OLLAMA taskkill /FI "WINDOWTITLE eq OfflineAid-Ollama*" /T /F >nul 2>&1
echo Stopped. Data is kept in the data\ folder.
goto :eof

:summary
echo.
if "%FAIL%"=="1" (echo  Startup stopped - fix the [X] items above and run start.bat again.)
pause
exit /b 1
