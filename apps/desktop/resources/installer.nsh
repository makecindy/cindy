; 区域身份参数化:本文件不再硬编码 Cindy 字面量,
; 一律走 electron-builder 在 common.nsh 里注入的宏——
;   ${APP_EXECUTABLE_FILENAME} = <productName>.exe(cn/global Cindy.exe / dev CindyDev.exe)
;   ${PRODUCT_FILENAME}        = productName(cn/global Cindy / dev CindyDev)
;   ${SHORTCUT_NAME}           = forge.config nsis.shortcutName(与 exe 基名同源)
; 2026-07-26 起 cn/global exe 名同值(显示名统一,双装文件层互抢已被 owner
; 接受);dev 仍独立名,dev 安装器绝不误伤同机并存的正式安装。注册表键名
; Windows 大小写不敏感,shell 键 "Cindy" 与历史写入的 "cindy" 是同一个键,
; 行为零变化。
!macro customInit
  ; Check if the app is already running
  check_running:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
        "${PRODUCT_FILENAME} 正在运行，请先关闭后再继续安装。$\n$\n点击「确定」将在关闭后继续。" \
        IDOK kill_app
      Abort
      kill_app:
        nsProcess::_KillProcess "${APP_EXECUTABLE_FILENAME}"
        Sleep 1000
        Goto check_running
    ${EndIf}

  ; 删旧快捷方式：老 .lnk 里 IconLocation 仍指向上一版 exe 的资源索引，
  ; 新版 .ico 内多尺寸顺序/数量变化后那个索引会落到另一张图。
  ; 让 NSIS 在后续步骤中重建 .lnk，新的 IconLocation 自然指向当前 exe 的索引 0。
  ; ⚠️ 只清理本产品(本区域身份)自己的快捷方式——同机可能并存老 XDMaker 安装
  ; 或另一区域的 Cindy 安装,它们的 .lnk 指向别的 exe,不属于本安装器,绝不能删。
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}\${SHORTCUT_NAME}.lnk"

  ; 同步清掉 PinnedTaskbar 里的副本（任务栏固定项也会缓存图标）
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
!macroend

!macro customInstall
  ; 注册文件夹右键菜单 "通过 <区域名> 打开" (与 main/folderContextMenu.ts 写的是同一组键)。
  ; 双重保险:installer 写一次让首装即可用, app 启动时的 registerFolderContextMenu()
  ; 也会校验+修复, 覆盖 "升级后路径漂移" / "组策略清掉注册表" 等场景。
  ;
  ; 用 HKCU 不用 HKLM:不需要管理员权限, 多用户机器上每个用户启动 app 时自注册。
  ; %V 在 Directory\shell / Directory\Background\shell 两种上下文里都解析为
  ; "用户右键所在的目录" 路径, argv 直传不做 URL 编解码 (deep link 走 cindy:// 另一套)。
  ; 键名用 ${PRODUCT_FILENAME}(区域身份):cn/global 'Cindy' 与历史 'cindy'
  ; 键大小写不敏感同键(2026-07-26 起两区同键,双装互写已被 owner 接受);
  ; dev 'CindyDev' 独立键;都与老 XDMaker 安装的 xdt-maker 键并存。
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_FILENAME}" "" "通过 ${PRODUCT_FILENAME} 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_FILENAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_FILENAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-folder "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_FILENAME}" "" "通过 ${PRODUCT_FILENAME} 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_FILENAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_FILENAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-folder "%V"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\${PRODUCT_FILENAME}" "" "通过 ${PRODUCT_FILENAME} 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\${PRODUCT_FILENAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\${PRODUCT_FILENAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-share-file "%1"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\${PRODUCT_FILENAME}" "" "通过 ${PRODUCT_FILENAME} 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\${PRODUCT_FILENAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\${PRODUCT_FILENAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-share-file "%1"'

  ; 广播 SHCNE_ASSOCCHANGED 让 Explorer 失效图标缓存，新图标无需注销/重启就能生效
  ; 0x08000000 = SHCNE_ASSOCCHANGED, 0 = SHCNF_IDLIST
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  ; 卸载时清理本产品自己的快捷方式(不碰并存的老 XDMaker / 另一区域安装)
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}\${SHORTCUT_NAME}.lnk"
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
  ; 清理右键菜单注册表项 (子键 \command 必须先删 / 用 DeleteRegKey 整树删)。
  ; 老版本 (未引入此功能) 这两条键不存在, DeleteRegKey 静默 no-op 不抛错。
  DeleteRegKey HKCU "Software\Classes\Directory\shell\${PRODUCT_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.cshare\shell\${PRODUCT_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.xdtshare\shell\${PRODUCT_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
