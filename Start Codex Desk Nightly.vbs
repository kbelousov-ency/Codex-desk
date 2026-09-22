Option Explicit
Dim shell, fs, root, exe
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
exe = root & "\release\nightly\Codex Desk.exe"
If fs.FileExists(exe) Then
  shell.Run Chr(34) & exe & Chr(34), 1, False
Else
  MsgBox "Nightly is not installed. Run npm run package.", 48, "Codex Desk - Nightly"
End If
