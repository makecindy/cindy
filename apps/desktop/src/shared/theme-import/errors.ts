/**
 * 主题色板能够被解析，但无法满足 Cindy 导入契约时抛出的领域错误。
 * Main adapter 会将它映射为稳定的 IPC 错误码；纯转换层不依赖 Electron/Main。
 */
export class UnsupportedThemePaletteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedThemePaletteError';
  }
}
