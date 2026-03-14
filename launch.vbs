' launch.vbs — Silent launcher for Voice Notes
'
' This file is what the Desktop shortcut points to.
' It starts the app WITHOUT showing a command-prompt window.
'
' Do NOT move or rename this file.

Option Explicit

Dim objShell, objFSO, strDir

Set objFSO   = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("WScript.Shell")

' Get the folder where this .vbs file lives
strDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Change to that directory
objShell.CurrentDirectory = strDir

' Run npm start with no visible window (0 = hidden, False = don't wait)
objShell.Run "cmd /c npm start", 0, False

' Clean up
Set objShell = Nothing
Set objFSO   = Nothing
