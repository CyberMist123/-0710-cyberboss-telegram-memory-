' Hidden launcher for the watchdog (long-lived, polls the three lines)
Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
LauncherDir = Fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = LauncherDir
WshShell.Run "pythonw.exe """ & Fso.BuildPath(LauncherDir, "watchdog.py") & """", 0, False
