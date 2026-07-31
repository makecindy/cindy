export const BROWSER_COMMENT_CHANNELS = {
  ENTER_MODE: 'browser-comment:enter-mode',
  EXIT_MODE: 'browser-comment:exit-mode',
  CANCEL_PENDING: 'browser-comment:cancel-pending',
  PREPARE_SCREENSHOT: 'browser-comment:prepare-screenshot',
  COMMIT_PENDING: 'browser-comment:commit-pending',
  DESIGN_PREVIEW: 'browser-comment:design-preview',
  DESIGN_RESET: 'browser-comment:design-reset',
  COMMAND_RESULT: 'browser-comment:command-result',
  ELEMENT_SELECTED: 'browser-comment:element-selected',
  MODE_EXITED: 'browser-comment:mode-exited',
} as const;

export type BrowserCommentChannel =
  typeof BROWSER_COMMENT_CHANNELS[keyof typeof BROWSER_COMMENT_CHANNELS];
