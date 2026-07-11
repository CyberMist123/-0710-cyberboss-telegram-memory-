' The sole Telegram auto-recovery owner. Configuration comes from deployment/current.json.
Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
LauncherDir = Fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = LauncherDir
CyberlinkRoot = Fso.GetParentFolderName(Fso.GetParentFolderName(LauncherDir))
DescriptorPath = Fso.BuildPath(Fso.BuildPath(CyberlinkRoot, "deployment"), "current.json")
PythonExe = WshShell.ExpandEnvironmentStrings("%CYBERBOSS_PYTHONW%")
If PythonExe = "%CYBERBOSS_PYTHONW%" Or PythonExe = "" Then PythonExe = "pythonw.exe"
WshShell.Run """" & PythonExe & """ """ & Fso.BuildPath(LauncherDir, "watchdog.py") & """ --descriptor """ & DescriptorPath & """", 0, False
