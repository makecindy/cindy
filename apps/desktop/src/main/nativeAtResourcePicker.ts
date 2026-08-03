import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';

export type NativeAtResourceKind = 'file' | 'directory';

export interface NativeAtResourcePickerResult {
  path: string | null;
  kind: NativeAtResourceKind | null;
}

interface NativeAtResourcePickerDeps {
  platform: NodeJS.Platform;
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  isDirectory: (selectedPath: string) => boolean;
}

/**
 * Open the platform-native picker used by the fixed @ resource action.
 * macOS supports a combined file/directory dialog; Windows and Linux do not,
 * so those platforms intentionally match Codex by opening a file dialog.
 */
export async function pickNativeAtResource(
  deps: NativeAtResourcePickerDeps,
  defaultPath?: string,
): Promise<NativeAtResourcePickerResult> {
  const properties: NonNullable<OpenDialogOptions['properties']> =
    deps.platform === 'darwin'
      ? ['openFile', 'openDirectory']
      : ['openFile'];
  const result = await deps.showOpenDialog({
    properties,
    ...(defaultPath ? { defaultPath } : {}),
  });
  const selectedPath = result.canceled ? undefined : result.filePaths[0];
  if (!selectedPath) return { path: null, kind: null };
  return {
    path: selectedPath,
    kind: deps.isDirectory(selectedPath) ? 'directory' : 'file',
  };
}
