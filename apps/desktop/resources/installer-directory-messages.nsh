; NSIS runs before Electron/i18next. Keep the five client languages here, with
; English fallback for other installer languages. Windows styles the dialogs.
!macro cindyDirectoryMessage KEY
  ${Switch} $LANGUAGE
    ${Case} 2052 ; zh-CN
      StrCpy $cindyDirectoryMessage "${${KEY}_zh_CN}"
      ${Break}
    ${Case} 1028 ; zh-TW
      StrCpy $cindyDirectoryMessage "${${KEY}_zh_TW}"
      ${Break}
    ${Case} 1041 ; ja
      StrCpy $cindyDirectoryMessage "${${KEY}_ja}"
      ${Break}
    ${Case} 1042 ; ko
      StrCpy $cindyDirectoryMessage "${${KEY}_ko}"
      ${Break}
    ${Default}
      StrCpy $cindyDirectoryMessage "${${KEY}_en}"
      ${Break}
  ${EndSwitch}
!macroend

!define cindyDirectoryNotWritable_en "Cindy cannot write to this installation directory. Choose another directory, or close apps using its files and check your security software before trying again."
!define cindyDirectoryNotWritable_zh_CN "Cindy 无法写入这个安装目录。请选择其他目录，或关闭占用文件的程序并检查安全软件后重试。"
!define cindyDirectoryNotWritable_zh_TW "Cindy 無法寫入這個安裝目錄。請選擇其他目錄，或關閉占用檔案的程式並檢查安全軟體後重試。"
!define cindyDirectoryNotWritable_ja "このインストール先に Cindy を書き込めません。別のディレクトリを選ぶか、ファイルを使用中のアプリを閉じ、セキュリティソフトを確認してから再試行してください。"
!define cindyDirectoryNotWritable_ko "이 설치 디렉터리에 Cindy를 쓸 수 없습니다. 다른 디렉터리를 선택하거나 파일을 사용 중인 앱을 닫고 보안 소프트웨어를 확인한 후 다시 시도하세요."

!define cindyDirectoryDifferentUser_en "Windows authorization used a different account. To keep Cindy installed for your account, choose a directory you can write to. To install for all users, go back and select that option."
!define cindyDirectoryDifferentUser_zh_CN "Windows 授权使用了另一个账号。如需仅为当前账号安装 Cindy，请选择可写入的目录；如需为所有用户安装，请返回并选择该选项。"
!define cindyDirectoryDifferentUser_zh_TW "Windows 授權使用了另一個帳號。如需僅為目前帳號安裝 Cindy，請選擇可寫入的目錄；如需為所有使用者安裝，請返回並選擇該選項。"
!define cindyDirectoryDifferentUser_ja "Windows の認証に別のアカウントが使われました。現在のアカウントにのみ Cindy をインストールするには、書き込み可能なディレクトリを選んでください。すべてのユーザーにインストールするには、前の画面でそのオプションを選んでください。"
!define cindyDirectoryDifferentUser_ko "Windows 인증에 다른 계정이 사용되었습니다. 현재 계정에만 Cindy를 설치하려면 쓰기 가능한 디렉터리를 선택하세요. 모든 사용자에게 설치하려면 이전 화면으로 돌아가 해당 옵션을 선택하세요."
