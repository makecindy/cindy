; Only invoked by --updated installs. $PLUGINSDIR is private to this installer
; attempt and NSIS cleans it on exit. Copy bytes, not freshly created links, so
; taskbar pin identity, arguments and AUMID survive an old uninstaller.
!include FileFunc.nsh
!macro cindyBackupLink SOURCE NAME
  ${If} ${FileExists} "${SOURCE}"
    ClearErrors
    CopyFiles /SILENT "${SOURCE}" "$PLUGINSDIR\cindy-shortcuts\${NAME}.lnk"
    ${If} ${Errors}
      ; Stop before the old uninstaller can destroy the only copy.
      DetailPrint "Could not preserve an existing shortcut; upgrade cancelled."
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro cindyCheckShortcutRestore DESTINATION
  ${If} ${Errors}
    Pop $R0
    ; The app may already be replaced. Do not report a successful upgrade
    ; when an existing shortcut could not be restored.
    DetailPrint "Could not restore shortcut: ${DESTINATION}"
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

!macro cindyRestoreLink DESTINATION NAME
  ${If} ${FileExists} "$PLUGINSDIR\cindy-shortcuts\${NAME}.lnk"
  ${AndIfNot} ${FileExists} "${DESTINATION}"
    Push $R0
    ${GetParent} "${DESTINATION}" $R0
    ClearErrors
    CreateDirectory "$R0"
    !insertmacro cindyCheckShortcutRestore "${DESTINATION}"
    CopyFiles /SILENT "$PLUGINSDIR\cindy-shortcuts\${NAME}.lnk" "${DESTINATION}"
    !insertmacro cindyCheckShortcutRestore "${DESTINATION}"
    Pop $R0
  ${EndIf}
!macroend

!macro cindyUpgradeLinks OPERATION
  !insertmacro ${OPERATION} "$DESKTOP\${SHORTCUT_NAME}.lnk" "desktop"
  !insertmacro ${OPERATION} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "start-menu"
  !insertmacro ${OPERATION} "$SMPROGRAMS\${PRODUCT_FILENAME}\${SHORTCUT_NAME}.lnk" "start-menu-folder"
  ; Pins always belong to the current user, even in an /allusers install.
  SetShellVarContext current
  !insertmacro ${OPERATION} "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk" "taskbar"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend

!macro cindyBackupUpgradeShortcuts
  InitPluginsDir
  CreateDirectory "$PLUGINSDIR\cindy-shortcuts"
  !insertmacro cindyUpgradeLinks cindyBackupLink
!macroend

!macro cindyRestoreUpgradeShortcuts
  ; The per-link restore creates missing parent directories only for saved links.
  !insertmacro cindyUpgradeLinks cindyRestoreLink
!macroend
