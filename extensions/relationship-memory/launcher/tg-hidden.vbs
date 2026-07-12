' Hidden launcher for TG line.
' No black window. start-safe.ps1 handles pidfile check + hidden Node.
Set WshShell = CreateObject("WScript.Shell")
Set Fso = CreateObject("Scripting.FileSystemObject")
RepoRoot = WshShell.ExpandEnvironmentStrings("%CYBERBOSS_REPO_ROOT%")
If RepoRoot = "%CYBERBOSS_REPO_ROOT%" Or RepoRoot = "" Then
  RepoRoot = Fso.GetAbsolutePathName(Fso.BuildPath(Fso.GetParentFolderName(WScript.ScriptFullName), "..\..\.."))
End If
WshShell.CurrentDirectory = RepoRoot
WshShell.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & Fso.BuildPath(RepoRoot, "extensions\windows-launcher\start-safe.ps1") & """", 0, False
