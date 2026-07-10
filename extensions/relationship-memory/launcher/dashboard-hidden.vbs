' Hidden launcher for 520 memory panel
Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
KitDir = WshShell.ExpandEnvironmentStrings("%CYBERBOSS_MEMORY_KIT_DIR%")
If KitDir = "%CYBERBOSS_MEMORY_KIT_DIR%" Or KitDir = "" Then
  KitDir = Fso.GetAbsolutePathName(Fso.BuildPath(Fso.GetParentFolderName(WScript.ScriptFullName), "..\memory-kit"))
End If
WshShell.CurrentDirectory = KitDir
WshShell.Run "pythonw.exe """ & Fso.BuildPath(KitDir, "dashboard.py") & """", 0, False
