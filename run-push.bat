@echo off
set "PATH=%USERPROFILE%\AppData\Local\Microsoft\WinGet\Packages\Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe\cmd;%PATH%"
git add -A
git commit -m "feat: add clear test orders and reset dummy data"
git push origin main
