import { describe, expect, it } from 'vitest';
import { publishErrorDetail, serverPublishErrorCode } from '../skillhubPublishErrors';

describe('SkillHub publish error classification', () => {
  it.each([
    ['SKILL_DELETED', 409, '同名 Skill 已删除', 'SKILL_DELETED'],
    ['FORBIDDEN', 403, '已删除的 Skill 不能继续发布', 'SKILL_DELETED'],
    ['FORBIDDEN', 403, '没有权限', 'PERMISSION_DENIED'],
    ['HTTP_403', 403, 'private diagnostic', 'PERMISSION_DENIED'],
    ['UNAUTHORIZED', 401, '登录过期', 'AUTH_REQUIRED'],
    ['INVALID_PARAMS', 400, 'tags 包含不存在的标签', 'INVALID_PARAMS'],
    ['MANIFEST_INVALID', 400, '缺少 description', 'MANIFEST_INVALID'],
    ['UPLOAD_SESSION_EXPIRED', 409, '上传会话过期', 'OSS_PUT_EXPIRED'],
    ['STORAGE_UNAVAILABLE', 503, '存储不可用', 'SERVICE_UNAVAILABLE'],
    ['ORG_ROUTING_UNAVAILABLE', 503, '无法确认组织路由', 'SERVICE_UNAVAILABLE'],
    ['NETWORK_ERROR', 0, 'network failure', 'NETWORK_ERROR'],
    ['RATE_LIMITED', 429, '请求过多', 'RATE_LIMITED'],
    ['NEW_VALIDATION_ERROR', 422, '业务原因', 'REQUEST_REJECTED'],
    ['INTERNAL_ERROR', 500, 'private diagnostic', 'INTERNAL'],
    ['NEW_SERVER_FAILURE', 502, 'private diagnostic', 'INTERNAL'],
  ])('maps %s without collapsing business failures into INTERNAL', (code, status, message, expected) => {
    expect(serverPublishErrorCode(String(code), String(message), Number(status))).toBe(expected);
  });

  it('keeps a short actionable reason', () => {
    expect(publishErrorDetail('MANIFEST_INVALID', '缺少 description')).toBe('缺少 description');
    expect(publishErrorDetail('INVALID_PARAMS', '  标签不存在  ')).toBe('标签不存在');
  });

  it.each(['INTERNAL', 'PACK_FAILED', 'OSS_PUT_FAILED', 'NETWORK_ERROR', 'CANCELLED',
    'SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'AUTH_REQUIRED', 'PERMISSION_DENIED', 'NOT_AUTHOR',
    'API_KEY_MISSING', 'SKILL_HUB_READ_ONLY', 'OSS_PUT_EXPIRED', 'OSS_OBJECT_NOT_FOUND', 'PUBLISH_BUSY'] as const)(
    'does not display raw diagnostics for %s', (code) => {
      expect(publishErrorDetail(code, 'private diagnostic')).toBe('');
    },
  );
});
