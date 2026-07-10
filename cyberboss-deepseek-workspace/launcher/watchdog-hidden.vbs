' Hidden launcher for the watchdog (long-lived, polls the three lines)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-workspace\launcher"
WshShell.Run "pythonw.exe ""C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-workspace\launcher\watchdog.py""", 0, False
