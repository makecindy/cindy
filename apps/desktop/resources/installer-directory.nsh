; Replace only the assisted directory page. Keep electron-builder's install
; section, registry layout and UAC broker, including current-user installs.
!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
!include FileFunc.nsh
!include UAC.nsh
!include StrContains.nsh

Var cindyDirectoryElevation
Var cindyRequestedDirectory
Var cindyRequestedMode
Var cindyRequestedUserSid
Var cindyUserSid
Var cindyDirectoryError
Var cindyDirectoryMessage

!define CINDY_ELEVATION_DIFFERENT_USER 49617

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE CindyDirectoryPre
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE CindyDirectoryLeave
  !insertmacro MUI_PAGE_DIRECTORY
  !define MUI_PAGE_CUSTOMFUNCTION_PRE CindyDirectoryBeforeInstall
  ; Preserve the stock shortcut policy. Define AFTER the stock page branch,
  ; otherwise electron-builder would insert a second directory page.
  !define allowToChangeInstallationDirectory
!macroend

!macro cindyDirectoryInit
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_GetGlobalVar $cindyDirectoryElevation
    ${If} $cindyDirectoryElevation == "1"
      !insertmacro UAC_AsUser_GetGlobalVar $cindyRequestedDirectory
      !insertmacro UAC_AsUser_GetGlobalVar $cindyRequestedMode
      !insertmacro UAC_AsUser_GetGlobalVar $cindyRequestedUserSid
      ; Other-account elevation must not put a current-user install into the
      ; administrator's HKCU/profile. Compare OS identities, not account names.
      ${If} $cindyRequestedMode == "CurrentUser"
        Call CindyGetUserSid
        ${If} $cindyUserSid == ""
        ${OrIf} $cindyUserSid != $cindyRequestedUserSid
          SetErrorLevel ${CINDY_ELEVATION_DIFFERENT_USER}
          Quit
        ${EndIf}
      ${EndIf}
      Call CindyRestoreDirectory
    ${EndIf}
  ${EndIf}
  ; Silent installs skip page callbacks. Check before uninstalling an old
  ; version, and preserve their /D directory verbatim as the stock installer does.
  ${If} ${Silent}
    Call CindyEnsureDirectoryWritable
    ${If} ${Errors}
      SetErrorLevel 5
      Quit
    ${EndIf}
    ${If} ${UAC_IsInnerInstance}
      !insertmacro customCheckAppRunning
    ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !include "${BUILD_RESOURCES_DIR}\installer-directory-messages.nsh"

    Function CindyGetUserSid
      StrCpy $cindyUserSid ""
      System::Call 'kernel32::GetCurrentProcess() p.r0'
      System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i.r2'
      ${If} $2 != 0
        ; TOKEN_USER starts with a SID pointer.
        System::Call 'advapi32::GetTokenInformation(p r1, i 1, p 0, i 0, *i .r2)'
        System::Alloc $2
        Pop $3
        ${If} $3 != 0
          System::Call 'advapi32::GetTokenInformation(p r1, i 1, p r3, i r2, *i .r4) i.r5'
          ${If} $5 != 0
            System::Call '*$3(p .r4)'
            System::Call 'advapi32::ConvertSidToStringSidW(p r4, *p .r5) i.r6'
            ${If} $6 != 0
              System::Call '*$5(&w${NSIS_MAX_STRLEN} .r6)'
              StrCpy $cindyUserSid $6
              System::Call 'kernel32::LocalFree(p r5)'
            ${EndIf}
          ${EndIf}
          System::Free $3
        ${EndIf}
        System::Call 'kernel32::CloseHandle(p r1)'
      ${EndIf}
    FunctionEnd

    Function CindyRestoreDirectory
      StrCpy $INSTDIR $cindyRequestedDirectory
      StrCpy $installMode $cindyRequestedMode
      ${If} $installMode == "CurrentUser"
        SetShellVarContext current
        StrCpy $hasPerUserInstallation "1"
        StrCpy $hasPerMachineInstallation "0"
      ${Else}
        SetShellVarContext all
        StrCpy $hasPerUserInstallation "0"
        StrCpy $hasPerMachineInstallation "1"
      ${EndIf}
    FunctionEnd

    Function CindyNormalizeDirectory
      ; Match the stock assisted installer's application subdirectory behavior.
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
    FunctionEnd

    Function CindyDirectoryPre
      ${If} $cindyDirectoryElevation == "1"
        ; The stock mode page assumes every UAC child is machine-wide. Restore
        ; the real choice after that page and resume without asking for it again.
        Call CindyRestoreDirectory
        Abort
      ${EndIf}
      ${If} ${isUpdated}
        Abort
      ${EndIf}
    FunctionEnd

    Function CindyDirectoryLeave
      ; NSIS commits the edit control to INSTDIR AFTER this callback. Read the
      ; current text so the probe checks the new choice, not the old directory.
      ${NSD_GetText} $mui.DirectoryPage.Directory $INSTDIR
      Call CindyNormalizeDirectory
      ${NSD_SetText} $mui.DirectoryPage.Directory $INSTDIR
      Call CindyEnsureDirectoryWritable
      ${If} ${Errors}
        Abort ; keep the directory page and selection when authorization fails
      ${EndIf}
    FunctionEnd

    Function CindyDirectoryBeforeInstall
      Call CindyNormalizeDirectory
      Call CindyEnsureDirectoryWritable
      ${If} ${Errors}
        ; Abort in an instfiles PRE would skip to the finish page. Quit instead.
        SetErrorLevel 5
        Quit
      ${EndIf}
      ${If} ${UAC_IsInnerInstance}
        !insertmacro customCheckAppRunning
      ${EndIf}
    FunctionEnd

    ; Probe the destination or its nearest existing parent without creating an
    ; installation tree. Delete only the unique file created by GetTempFileName.
    Function CindyProbeDirectory
      StrCpy $cindyDirectoryError 0
      StrCpy $0 $INSTDIR
      cindy_probe_parent:
        System::Call 'kernel32::GetFileAttributesW(w r0) i.r1 ?e'
        Pop $2
        ${If} $1 == -1
          ${If} $2 != 2
          ${AndIf} $2 != 3
            StrCpy $cindyDirectoryError $2
            Return
          ${EndIf}
          ${GetParent} "$0" $1
          ${If} $1 == ""
          ${OrIf} $1 == $0
            StrCpy $cindyDirectoryError 3
            Return
          ${EndIf}
          StrCpy $0 $1
          Goto cindy_probe_parent
        ${EndIf}
        IntOp $1 $1 & 0x10
        ${If} $1 == 0
          StrCpy $cindyDirectoryError 267 ; ERROR_DIRECTORY
          Return
        ${EndIf}
        System::Call 'kernel32::GetTempFileNameW(w r0, w "cdy", i 0, w .r1) i.r2 ?e'
        Pop $3
        ${If} $2 == 0
          StrCpy $cindyDirectoryError $3
          Return
        ${EndIf}
        System::Call 'kernel32::DeleteFileW(w r1) i.r2 ?e'
        Pop $3
        ${If} $2 == 0
          StrCpy $cindyDirectoryError $3
          Return
        ${EndIf}
      ; Also catch a read-only/locked old icon in an otherwise writable directory.
      ; OPEN_EXISTING requests write access without changing any existing bytes.
      IfFileExists "$INSTDIR\uninstallerIcon.ico" 0 cindy_probe_done
        System::Call 'kernel32::CreateFileW(w "$INSTDIR\uninstallerIcon.ico", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p.r1 ?e'
        Pop $2
        ${If} $1 == -1
          StrCpy $cindyDirectoryError $2
        ${Else}
          System::Call 'kernel32::CloseHandle(p r1)'
        ${EndIf}
      cindy_probe_done:
    FunctionEnd

    Function CindyEnsureDirectoryWritable
      ClearErrors
      Call CindyProbeDirectory
      ${If} $cindyDirectoryError == 0
        Return
      ${EndIf}
      ; Only ACCESS_DENIED may be repaired by elevation. Do not prompt for a
      ; locked file, invalid path, full disk, or an already elevated process.
      ${If} $cindyDirectoryError == 5
      ${AndIfNot} ${UAC_IsAdmin}
        Call CindyGetUserSid
        ${If} $cindyUserSid != ""
          StrCpy $cindyRequestedUserSid $cindyUserSid
          StrCpy $cindyRequestedDirectory $INSTDIR
          StrCpy $cindyRequestedMode $installMode
          StrCpy $cindyDirectoryElevation "1"
          ShowWindow $HWNDPARENT ${SW_HIDE}
          !insertmacro UAC_RunElevated
          ${If} $0 == 0
          ${AndIf} $1 == 1
            ${If} $2 != ${CINDY_ELEVATION_DIFFERENT_USER}
              SetErrorLevel $2
              Quit ; the child has finished; never install again in the parent
            ${EndIf}
          ${EndIf}
          StrCpy $cindyDirectoryElevation "0"
          ShowWindow $HWNDPARENT ${SW_SHOW}
          BringToFront
          ${If} $0 == 1223
            SetErrors ; UAC cancelled: return to directory selection quietly
            Return
          ${EndIf}
          ${If} $0 == 0
          ${AndIf} $1 == 1
          ${AndIf} $2 == ${CINDY_ELEVATION_DIFFERENT_USER}
            !insertmacro cindyDirectoryMessage cindyDirectoryDifferentUser
            MessageBox MB_OK|MB_ICONEXCLAMATION "$cindyDirectoryMessage" /SD IDOK
            SetErrors
            Return
          ${EndIf}
        ${EndIf}
      ${EndIf}
      !insertmacro cindyDirectoryMessage cindyDirectoryNotWritable
      MessageBox MB_OK|MB_ICONEXCLAMATION "$cindyDirectoryMessage$\r$\n$\r$\n$INSTDIR$\r$\n($cindyDirectoryError)" /SD IDOK
      SetErrors
    FunctionEnd
  !endif
!macroend

!endif ; BUILD_UNINSTALLER
