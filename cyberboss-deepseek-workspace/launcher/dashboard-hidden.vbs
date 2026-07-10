' Hidden launcher for 520 memory panel
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-workspace\memory-kit"
WshShell.Run "pythonw.exe ""C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-workspace\memory-kit\dashboard.py""", 0, False
