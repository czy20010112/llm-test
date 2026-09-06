' 停止判题服务（无窗口）：调用 scripts\service\stop-service.ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & root & "\scripts\service\stop-service.ps1""", 0, False
