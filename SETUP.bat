@echo off
setlocal EnableDelayedExpansion
title Voice Notes - Setup
color 0B

echo.
echo  =====================================================
echo    Voice Notes - First Time Setup
echo  =====================================================
echo.
echo  This will:
echo    1. Check that Node.js is installed
echo    2. Download all required components
echo    3. Create a desktop shortcut for you
echo.
echo  Please keep this window open until it finishes.
echo  =====================================================
echo.

:: ── Check for Node.js ──────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js was not found on this computer.
    echo.
    echo  Please install Node.js first:
    echo.
    echo    1. Open your web browser
    echo    2. Go to:  https://nodejs.org
    echo    3. Click the big green button to download
    echo    4. Run the downloaded file and click Next until done
    echo    5. Come back here and double-click SETUP.bat again
    echo.
    echo  Press any key to open the Node.js download page now...
    pause >nul
    start https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version 2^>^&1') do set NODE_VER=%%v
echo  [OK] Node.js found: %NODE_VER%
echo.

:: ── Install npm packages ───────────────────────────────────────────────────
echo  [>>] Downloading required components...
echo       (This may take a few minutes the first time)
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo  [!] Something went wrong during installation.
    echo      Please check your internet connection and try again.
    echo.
    pause
    exit /b 1
)
echo.
echo  [OK] All components installed successfully.
echo.

:: ── Create desktop shortcut ────────────────────────────────────────────────
echo  [>>] Creating desktop shortcut...

set "APP_DIR=%~dp0"
:: Remove trailing backslash
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "VBS_FILE=%APP_DIR%\launch.vbs"
set "SHORTCUT=%USERPROFILE%\Desktop\Voice Notes.lnk"
set "ELECTRON_EXE=%APP_DIR%\node_modules\.bin\electron.cmd"

:: Write the shortcut using PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$WshShell = New-Object -comObject WScript.Shell; " ^
  "$s = $WshShell.CreateShortcut('%SHORTCUT%'); " ^
  "$s.TargetPath = 'wscript.exe'; " ^
  "$s.Arguments = '\""%VBS_FILE%\"\"'; " ^
  "$s.WorkingDirectory = '%APP_DIR%'; " ^
  "$s.Description = 'Voice Notes - Speak and the words appear on screen'; " ^
  "$s.IconLocation = '%APP_DIR%\assets\icon.ico'; " ^
  "$s.Save()"

if %errorlevel% neq 0 (
    echo  [!] Could not create shortcut automatically.
    echo      You can still launch the app by double-clicking launch.vbs
    echo      in this folder.
) else (
    echo  [OK] Desktop shortcut created: "Voice Notes"
)
echo.

:: ── Done ───────────────────────────────────────────────────────────────────
echo  =====================================================
echo    Setup complete!
echo.
echo    A "Voice Notes" icon is now on your Desktop.
echo    Double-click it any time to open the app.
echo.
echo    NOTE: The first time you open the app it will
echo    download the voice recognition model (~40 MB).
echo    This only happens once - after that it works
echo    without any internet connection.
echo  =====================================================
echo.

set /p LAUNCH="  Open Voice Notes now? (Y/N): "
if /i "%LAUNCH%"=="Y" (
    echo.
    echo  Starting Voice Notes...
    start "" wscript.exe "%VBS_FILE%"
    timeout /t 2 >nul
)

echo.
echo  You can close this window.
echo.
pause
endlocal
