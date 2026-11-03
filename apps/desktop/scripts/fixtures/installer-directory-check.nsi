; Native preflight contract harness. Real Win32 file/SID calls; simulated UAC
; outcomes so automated checks never launch secure-desktop authorization.
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${TEST_ROOT}\directory-check.exe"
!include MUI2.nsh
!include nsDialogs.nsh
!include "installer-directory.nsh"

!define APP_FILENAME CindyInstallerProbe
Var installMode
Var hasPerUserInstallation
Var hasPerMachineInstallation
Var testCase
Var testAdmin
Var testInner
Var testElevationResult
Var testChildExit
Var testElevationCalls
Var testPrepareCalls
Var testFailed
Var testLock

!macroundef _UAC_IsAdmin
!macro _UAC_IsAdmin _a _b _t _f
  !insertmacro _= $testAdmin 1 `${_t}` `${_f}`
!macroend
!macroundef _UAC_IsInnerInstance
!macro _UAC_IsInnerInstance _a _b _t _f
  !insertmacro _= $testInner 1 `${_t}` `${_f}`
!macroend
!macroundef UAC_RunElevated
!macro UAC_RunElevated
  IntOp $testElevationCalls $testElevationCalls + 1
  StrCpy $0 $testElevationResult
  StrCpy $1 1
  StrCpy $2 $testChildExit
!macroend
!macroundef UAC_AsUser_GetGlobalVar
!macro UAC_AsUser_GetGlobalVar VAR
  ; Inputs are already supplied by case.ini instead of a real outer process.
!macroend
!define isUpdated `"" HarnessIsUpdated ""`
!macro _HarnessIsUpdated _a _b _t _f
  !insertmacro _= 0 1 `${_t}` `${_f}`
!macroend
!macro customCheckAppRunning
  IntOp $testPrepareCalls $testPrepareCalls + 1
!macroend

!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English
!insertmacro customHeader

Section
  ReadINIStr $testCase "${TEST_ROOT}\case.ini" input case
  ReadINIStr $INSTDIR "${TEST_ROOT}\case.ini" input directory
  ReadINIStr $testAdmin "${TEST_ROOT}\case.ini" input admin
  ReadINIStr $testElevationResult "${TEST_ROOT}\case.ini" input elevationResult
  ReadINIStr $testChildExit "${TEST_ROOT}\case.ini" input childExit
  StrCpy $testElevationCalls 0
  StrCpy $testPrepareCalls 0
  StrCpy $installMode CurrentUser

  ${If} $testCase == "locked"
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\uninstallerIcon.ico", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p.r0'
    StrCpy $testLock $0
  ${EndIf}

  ${If} $testCase == "resume-user"
  ${OrIf} $testCase == "resume-other"
  ${OrIf} $testCase == "resume-all"
    StrCpy $testInner 1
    StrCpy $cindyDirectoryElevation 1
    StrCpy $cindyRequestedDirectory $INSTDIR
    StrCpy $INSTDIR "wrong directory from stock multi-user page"
    StrCpy $cindyRequestedMode CurrentUser
    Call CindyGetUserSid
    StrCpy $cindyRequestedUserSid $cindyUserSid
    ${If} $testCase == "resume-other"
    ${OrIf} $testCase == "resume-all"
      StrCpy $cindyRequestedUserSid "S-1-5-21-0-0-0-1000"
    ${EndIf}
    ${If} $testCase == "resume-all"
      StrCpy $cindyRequestedMode all
    ${EndIf}
    !insertmacro cindyDirectoryInit
  ${Else}
    Call CindyEnsureDirectoryWritable
  ${EndIf}
  StrCpy $testFailed 0
  ${If} ${Errors}
    StrCpy $testFailed 1
  ${EndIf}
  ${If} $testCase == "locked"
    System::Call 'kernel32::CloseHandle(p $testLock)'
  ${EndIf}
  Call CindyGetUserSid
  WriteINIStr "${TEST_ROOT}\result.ini" result error $cindyDirectoryError
  WriteINIStr "${TEST_ROOT}\result.ini" result failed $testFailed
  WriteINIStr "${TEST_ROOT}\result.ini" result elevations $testElevationCalls
  WriteINIStr "${TEST_ROOT}\result.ini" result prepare $testPrepareCalls
  WriteINIStr "${TEST_ROOT}\result.ini" result directory $INSTDIR
  WriteINIStr "${TEST_ROOT}\result.ini" result mode $installMode
  WriteINIStr "${TEST_ROOT}\result.ini" result sid $cindyUserSid
SectionEnd
