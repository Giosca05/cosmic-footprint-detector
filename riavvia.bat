@echo off
cd /d "%~dp0"
echo Closing any Cosmic Footprint Detector server left open...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*src.web_server*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000 " ^| findstr LISTENING') do taskkill /F /PID %%p
timeout /t 1 /nobreak >nul
python -m src.web_server
pause
