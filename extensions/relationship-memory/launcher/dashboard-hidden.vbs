' Hidden launcher for 520 memory panel
Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")

KitDir = WshShell.ExpandEnvironmentStrings("%CYBERBOSS_MEMORY_KIT_DIR%")
If KitDir = "%CYBERBOSS_MEMORY_KIT_DIR%" Or KitDir = "" Then
  KitDir = Fso.GetAbsolutePathName(Fso.BuildPath(Fso.GetParentFolderName(WScript.ScriptFullName), "..\memory-kit"))
End If

PythonCommand = WshShell.ExpandEnvironmentStrings("%CYBERBOSS_DASHBOARD_PYTHON%")
If PythonCommand = "%CYBERBOSS_DASHBOARD_PYTHON%" Or PythonCommand = "" Then
  PythonCommand = "pythonw.exe"
End If

DashboardEntry = Fso.BuildPath(KitDir, "dashboard_continuity.py")
If Not Fso.FileExists(DashboardEntry) Then
  DashboardEntry = Fso.BuildPath(KitDir, "dashboard.py")
End If
If Not Fso.FileExists(DashboardEntry) Then
  WScript.Quit 2
End If

WshShell.CurrentDirectory = KitDir
Command = Chr(34) & PythonCommand & Chr(34) & " " & Chr(34) & DashboardEntry & Chr(34)
WshShell.Run Command, 0, False
