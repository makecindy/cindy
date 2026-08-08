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
    case 'GHOST_SOURCE_CONFLICT':
      return 'settings.ghosts.errors.sourceConflict';
    case 'NOT_FOUND':
      return 'settings.ghosts.errors.sourceMissing';
    default:
      return 'settings.ghosts.errors.generic';
  }
}
