export interface DocsOutputParentIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

export interface DocsOutputWriteRequest {
  expectedParent: DocsOutputParentIdentity;
  targetName: string;
  data: Uint8Array;
  overwrite: boolean;
}

export type DocsOutputWriteResult =
  | { ok: true }
  | {
      ok: false;
      errorCode: 'FILE_EXISTS' | 'PATH_NOT_ALLOWED' | 'INTERNAL';
      message: string;
    };
