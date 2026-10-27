import { describe, expect, it } from 'vitest';
import { chatErrorDiagnostic, chatGroupFailure, missingGroupCode } from '../chatServerErrors.js';

describe('chat group errors', () => {
  it.each([
    ['MENTION_UNAVAILABLE', 'MENTION_UNAVAILABLE'],
    ['MEMBER_UNAVAILABLE', 'MEMBER_UNAVAILABLE'], ['INVALID_ATTACHMENT', 'INVALID_ATTACHMENT'],
    ['FILE_PEER_TIMEOUT', 'ATTACHMENT_UNAVAILABLE'], ['ATTACHMENT_TOO_LARGE', 'ATTACHMENT_TOO_LARGE'],
    ['MEDIA_UPLOAD_FAILED', 'MEDIA_UPLOAD_FAILED'], ['INVALID_MEDIA_URL', 'MEDIA_UPLOAD_FAILED'],
    ['AUTH_REQUIRED', 'AUTH_REQUIRED'], ['CHAT_ENDPOINT_UNAVAILABLE', 'CHAT_UNAVAILABLE'],
    ['IMPORT_PENDING', 'IMPORT_PENDING'], ['REQUEST_TIMEOUT', 'REQUEST_TIMEOUT'],
    ['REVISION_CONFLICT', 'REVISION_CONFLICT'],
    ['ROLE_REQUIRED', 'PERMISSION_DENIED'], ['CONVERSATION_ARCHIVED', 'GROUP_ARCHIVED'],
    ['CONVERSATION_NOT_FOUND', 'NOT_FOUND'], ['NOT_A_GROUP', 'NOT_FOUND'], ['untrusted /private/path?token=secret', 'SERVICE_ERROR'],
  ])('classifies %s without exposing exception text', (code, expected) => {
    expect(chatGroupFailure(new Error(code))).toEqual({ ok: false, errorCode: expected, message: expected });
  });
  it('answers a non-group room exactly like a missing room on every entry point', () => {
    expect(missingGroupCode('NOT_A_GROUP')).toBe('CONVERSATION_NOT_FOUND');
    expect(missingGroupCode('ROLE_REQUIRED')).toBe('ROLE_REQUIRED');
    expect(chatGroupFailure(new Error('NOT_A_GROUP'))).toEqual(chatGroupFailure(new Error('CONVERSATION_NOT_FOUND')));
  });
  it('keeps only diagnostic code and HTTP status', () => {
    expect(chatErrorDiagnostic(Object.assign(new Error('private URL https://x/?token=secret'), { status: 500 })))
      .toEqual({ code: 'UNKNOWN', status: 500 });
    expect(chatErrorDiagnostic(Object.assign(new Error('arbitrary message'), { code: 'ECONNRESET' })))
      .toEqual({ code: 'ECONNRESET' });
    expect(chatGroupFailure(new DOMException('signed URL', 'TimeoutError')).errorCode).toBe('REQUEST_TIMEOUT');
  });
});
