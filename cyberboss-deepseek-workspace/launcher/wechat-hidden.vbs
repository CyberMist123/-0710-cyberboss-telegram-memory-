' Hidden launcher for WeChat line (cyberboss + shared app server 8785)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\18717\Documents\cyberlink\cyberboss"
WshShell.Run "cmd.exe /c ""C:\Users\18717\.cyberboss\start-cyberboss-wechat-telegram.bat""", 0, False
