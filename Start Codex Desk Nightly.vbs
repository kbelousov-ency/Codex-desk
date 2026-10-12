Option Explicit
Dim shell, fs, root, exe
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
exe = root & "\release\nightly\Kuzmich.exe"
If Not fs.FileExists(exe) Then exe = root & "\release\nightly\Codex Desk.exe"
If fs.FileExists(exe) Then
  shell.Run Chr(34) & exe & Chr(34), 1, False
Else
  MsgBox "Кузьмич Nightly не установлен. Запустите npm run package.", 48, "Кузьмич - Nightly"
End If
