; NSIS runs before Electron/i18next. Keep the supported client languages here, with
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
    ${Case} 1034 ; es
    ${Case} 3082 ; es-ES modern sort
    ${Case} 2058 ; es-MX
      StrCpy $cindyDirectoryMessage "${${KEY}_es}"
      ${Break}
    ${Case} 1036 ; fr
      StrCpy $cindyDirectoryMessage "${${KEY}_fr}"
      ${Break}
    ${Case} 1031 ; de
      StrCpy $cindyDirectoryMessage "${${KEY}_de}"
      ${Break}
    ${Case} 2070 ; pt-PT
      StrCpy $cindyDirectoryMessage "${${KEY}_pt_PT}"
      ${Break}
    ${Case} 1046 ; pt-BR
      StrCpy $cindyDirectoryMessage "${${KEY}_pt_BR}"
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

!define cindyDirectoryNotWritable_es "Cindy no puede escribir en este directorio de instalación. Elige otro directorio o cierra las aplicaciones que usen sus archivos y revisa tu software de seguridad antes de volver a intentarlo."
!define cindyDirectoryNotWritable_fr "Cindy ne peut pas écrire dans ce dossier d’installation. Choisissez un autre dossier, ou fermez les applications qui utilisent ses fichiers et vérifiez votre logiciel de sécurité avant de réessayer."
!define cindyDirectoryNotWritable_de "Cindy kann nicht in dieses Installationsverzeichnis schreiben. Wähle ein anderes Verzeichnis oder schließe Apps, die auf dessen Dateien zugreifen, und überprüfe deine Sicherheitssoftware, bevor du es erneut versuchst."
!define cindyDirectoryNotWritable_pt_PT "O Cindy não consegue escrever neste diretório de instalação. Escolha outro diretório ou feche as aplicações que utilizam os respetivos ficheiros e verifique o seu software de segurança antes de tentar novamente."
!define cindyDirectoryNotWritable_pt_BR "O Cindy não pode gravar neste diretório de instalação. Escolha outro diretório ou feche os aplicativos que usam os arquivos dele e verifique seu software de segurança antes de tentar novamente."
!define cindyDirectoryDifferentUser_es "La autorización de Windows usó una cuenta diferente. Para mantener Cindy instalado en tu cuenta, elige un directorio en el que puedas escribir. Para instalarlo para todos los usuarios, vuelve atrás y selecciona esa opción."
!define cindyDirectoryDifferentUser_fr "L’autorisation Windows a utilisé un autre compte. Pour que Cindy reste installé pour votre compte, choisissez un dossier dans lequel vous pouvez écrire. Pour l’installer pour tous les utilisateurs, revenez en arrière et sélectionnez cette option."
!define cindyDirectoryDifferentUser_de "Bei der Windows-Autorisierung wurde ein anderes Konto verwendet. Damit Cindy für dein Konto installiert bleibt, wähle ein Verzeichnis, in das du schreiben kannst. Um die Installation für alle Benutzer durchzuführen, gehe zurück und wähle diese Option."
!define cindyDirectoryDifferentUser_pt_PT "A autorização do Windows utilizou uma conta diferente. Para manter o Cindy instalado na sua conta, escolha um diretório no qual possa escrever. Para instalar para todos os utilizadores, volte atrás e selecione essa opção."
!define cindyDirectoryDifferentUser_pt_BR "A autorização do Windows usou uma conta diferente. Para manter o Cindy instalado na sua conta, escolha um diretório no qual você tenha permissão de gravação. Para instalar para todos os usuários, volte e selecione essa opção."
