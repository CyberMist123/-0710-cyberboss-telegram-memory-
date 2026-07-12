' Hidden launcher for WeChat line.
Set WshShell = CreateObject("WScript.Shell")
WechatRoot = WshShell.ExpandEnvironmentStrings("%CYBERBOSS_WECHAT_ROOT%")
WechatStart = WshShell.ExpandEnvironmentStrings("%CYBERBOSS_WECHAT_START_COMMAND%")
If WechatRoot = "%CYBERBOSS_WECHAT_ROOT%" Or WechatRoot = "" Then
  WScript.Quit 1
End If
If WechatStart = "%CYBERBOSS_WECHAT_START_COMMAND%" Or WechatStart = "" Then
  WScript.Quit 1
End If
WshShell.CurrentDirectory = WechatRoot
WshShell.Run "cmd.exe /c """ & WechatStart & """", 0, False
