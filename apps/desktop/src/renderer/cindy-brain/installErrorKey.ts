/**
 * 意识装入的 IPC 错误码 → i18n 文案 key。
 * 插件页装入与窗口拖入(GlobalDropImportListener)共用,
 * 两个入口报错口径一致。
 */
export function ghostInstallErrorKey(code: string | undefined): string {
  switch (code) {
    case 'GHOST_FILE_INVALID':
      return 'settings.ghosts.errors.fileInvalid';
    case 'ALREADY_EXISTS':
      return 'settings.ghosts.errors.alreadyInstalled';
    case 'GHOST_COMMAND_CONFLICT':
      return 'settings.ghosts.errors.commandConflict';
    case 'GHOST_ID_RESERVED':
      return 'settings.ghosts.errors.idReserved';
    case 'NOT_FOUND':
      return 'settings.ghosts.errors.sourceMissing';
    // 批准状态相关的前置条件失败在这条链路上只有一种下一步动作:重新确认权限。
    // 缺少批准记录(启用存量安装)与批准态在确认后变化(更新)都归到这里。
    case 'PRECONDITION_FAILED':
      return 'settings.ghosts.errors.approvalRequired';
    default:
      return 'settings.ghosts.errors.generic';
  }
}
