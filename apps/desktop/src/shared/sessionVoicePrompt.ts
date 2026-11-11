export interface SessionVoicePromptTarget {
  sessionId: string;
  title: string;
  sourceDeviceId: string | null;
  displayId: number | null;
}

export interface SessionVoicePromptContext {
  requestId: string;
  sessionId: string;
  title: string;
}

export type SessionVoicePromptErrorCode =
  | 'NO_TARGET'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'TARGET_NOT_FOUND'
  | 'REMOTE_UNAVAILABLE'
  | 'SEND_FAILED';

export type SessionVoicePromptResult =
  | { ok: true }
  | { ok: false; errorCode: SessionVoicePromptErrorCode };
