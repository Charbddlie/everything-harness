@echo off
setlocal
rem Windows 安装入口，编码 GBK。
chcp 936 >nul
set "PYTHONIOENCODING=gbk:backslashreplace"
if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" "%~dp0tui\bootstrap.py" %*
    goto done
)
where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%~dp0tui\bootstrap.py" %*
    goto done
)
python "%~dp0tui\bootstrap.py" %*
:done
exit /b %errorlevel%
