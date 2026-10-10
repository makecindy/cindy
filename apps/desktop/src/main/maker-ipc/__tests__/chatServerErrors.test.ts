import { describe, expect, it } from 'vitest';
import { chatErrorDiagnostic, chatGroupFailure } from '../chatServerErrors.js';

describe('chat group errors', () => {
  it.each([
    ['MEMBER_UNAVAILABLE', 'MEMBER_UNAVAILABLE'], ['INVALID_ATTACHMENT', 'INVALID_ATTACHMENT'],
    ['FILE_PEER_TIMEOUT', 'ATTACHMENT_UNAVAILABLE'], ['ATTACHMENT_TOO_LARGE', 'ATTACHMENT_TOO_LARGE'],
    ['MEDIA_UPLOAD_FAILED', 'MEDIA_UPLOAD_FAILED'], ['INVALID_MEDIA_URL', 'MEDIA_UPLOAD_FAILED'],
    ['AUTH_REQUIRED', 'AUTH_REQUIRED'], ['CHAT_ENDPOINT_UNAVAILABLE', 'CHAT_UNAVAILABLE'],
    ['IMPORT_PENDING', 'IMPORT_PENDING'], ['REQUEST_TIMEOUT', 'REQUEST_TIMEOUT'],
    ['ROLE_REQUIRED', 'PERMISSION_DENIED'], ['CONVERSATION_ARCHIVED', 'GROUP_ARCHIVED'],
    ['CONVERSATION_NOT_FOUND', 'NOT_FOUND'], ['untrusted /private/path?token=secret', 'SERVICE_ERROR'],
  ])('classifies %s without exposing exception text', (code, expected) => {
    expect(chatGroupFailure(new Error(code))).toEqual({ ok: false, errorCode: expected, message: expected });
  });
  it('keeps only diagnostic code and HTTP status', () => {
    expect(chatErrorDiagnostic(Object.assign(new Error('private URL https://x/?token=secret'), { status: 500 })))
      .toEqual({ code: 'UNKNOWN', status: 500 });
    expect(chatErrorDiagnostic(Object.assign(new Error('arbitrary message'), { code: 'ECONNRESET' })))
      .toEqual({ code: 'ECONNRESET' });
    expect(chatGroupFailure(new DOMException('signed URL', 'TimeoutError')).errorCode).toBe('REQUEST_TIMEOUT');
  });
});
