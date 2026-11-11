export interface ChatFolderUploadInput {
  deviceId: string;
  file: File;
  requestId: string;
}

export type ChatFolderUploadResult =
  | { ok: true; path: string; size: number }
  | { ok: false; code: 'REMOTE_UNSUPPORTED' | 'TRANSFER_FAILED' };

/** The native File is the capability; never accept a renderer-chosen source path. */
export function createChatFolderUpload(
  getPathForFile: (file: File) => string,
  upload: (args: {
    deviceId: string;
    sourcePath: string;
    requestId: string;
  }) => Promise<ChatFolderUploadResult>,
) {
  return async (input: ChatFolderUploadInput): Promise<ChatFolderUploadResult> => {
    let sourcePath: string;
    try {
      // Electron returns an empty path for synthetic Files and rejects non-Files.
      sourcePath = getPathForFile(input.file);
      if (!sourcePath) return { ok: false, code: 'TRANSFER_FAILED' };
    } catch {
      return { ok: false, code: 'TRANSFER_FAILED' };
    }
    return upload({ deviceId: input.deviceId, requestId: input.requestId, sourcePath });
  };
}
