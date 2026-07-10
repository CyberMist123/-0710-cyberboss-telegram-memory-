' Hidden launcher for TG line (cyberboss-deepseek-test)
' No black window. start-safe.ps1 handles pidfile check + hidden Node.
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-test"
WshShell.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-test\scripts\windows\start-safe.ps1""", 0, False
