/**
 * Pi 0.84.4 RPC UI contract, shared by dispatch and Settings inspection.
 * Pure display requests are intentionally silent. Native RPC stubs retain
 * Pi's own return values; we do not rewrite extensions or disable packages.
 * See docs/dev-rules/pi-extension-ui.md for the upstream capability audit.
 */
export const PI_EXTENSION_UI_CAPABILITIES = {
  select: { handling: 'dialog', issue: null },
  confirm: { handling: 'dialog', issue: null },
  input: { handling: 'dialog', issue: null },
  editor: { handling: 'dialog', issue: null },
  notify: { handling: 'notification', issue: null },
  setStatus: { handling: 'ignore', issue: 'status-display' },
  setWidget: { handling: 'ignore', issue: 'widgets' },
  setTitle: { handling: 'ignore', issue: 'terminal-title' },
  setEditorText: { handling: 'ignore', issue: 'editor-integration' },
  pasteToEditor: { handling: 'ignore', issue: 'editor-integration' },
  setWorkingMessage: { handling: 'native', issue: 'status-display' },
  setWorkingVisible: { handling: 'native', issue: 'status-display' },
  setWorkingIndicator: { handling: 'native', issue: 'status-display' },
  setHiddenThinkingLabel: { handling: 'native', issue: 'status-display' },
  getEditorText: { handling: 'native', issue: 'editor-integration' },
  getEditorComponent: { handling: 'native', issue: 'editor-integration' },
  addAutocompleteProvider: { handling: 'native', issue: 'editor-integration' },
  setEditorComponent: { handling: 'native', issue: 'editor-integration' },
  setFooter: { handling: 'native', issue: 'tui-layout' },
  setHeader: { handling: 'native', issue: 'tui-layout' },
  setToolsExpanded: { handling: 'native', issue: 'tui-layout' },
  getToolsExpanded: { handling: 'native', issue: 'tui-layout' },
  custom: { handling: 'native', issue: 'custom-ui' },
  getAllThemes: { handling: 'native', issue: 'theme-control' },
  getTheme: { handling: 'native', issue: 'theme-control' },
  setTheme: { handling: 'native', issue: 'theme-control' },
  // RPC exposes the real theme object; reading/formatting is not switching.
  theme: { handling: 'native', issue: null },
  onTerminalInput: { handling: 'native', issue: 'terminal-input' },
  registerShortcut: { handling: 'native', issue: 'tui-rendering' },
  registerFlag: { handling: 'native', issue: 'cli-flags' },
  registerMessageRenderer: { handling: 'native', issue: 'tui-rendering' },
  registerMarkdownTransformer: { handling: 'native', issue: 'tui-rendering' },
  registerEntryRenderer: { handling: 'native', issue: 'tui-rendering' },
} as const;

export type PiExtensionUiApi = keyof typeof PI_EXTENSION_UI_CAPABILITIES;

/** SDK camelCase and RPC wire names differ for editor writes. */
export function getPiExtensionUiCapability(method: string) {
  const api = method === 'set_editor_text' ? 'setEditorText' : method;
  return Object.hasOwn(PI_EXTENSION_UI_CAPABILITIES, api)
    ? PI_EXTENSION_UI_CAPABILITIES[api as PiExtensionUiApi]
    : undefined;
}
