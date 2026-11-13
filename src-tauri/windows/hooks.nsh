; Additions to the installer that Tauri generates.
;
; The uninstaller asks whether to "Delete the application data". When that
; box is ticked it removes the library and the WebView's files, which are
; folders. The pCloud login is not in a folder: it is an entry in Windows
; Credential Manager, written by src/credentials.rs under the name below.
; It goes with the rest, so that nothing of Bever is left.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    nsExec::Exec 'cmdkey /delete:pcloud.io.github.balakrishnangithub.bever'
    Pop $0
  ${EndIf}
!macroend
