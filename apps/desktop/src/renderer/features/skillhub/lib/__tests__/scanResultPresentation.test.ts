import { describe, expect, it } from 'vitest';
import { isPublicationProcessingFailure, publicationProcessingErrorCode } from '../scanResultPresentation';

describe('scan result presentation', () => {
  it('distinguishes a server processing error from a security rejection', () => {
    expect(isPublicationProcessingFailure([{ name: 'INTERNAL_ERROR' }])).toBe(true);
    expect(isPublicationProcessingFailure([{ name: 'MANIFEST_INVALID' }])).toBe(true);
    expect(isPublicationProcessingFailure([{ name: 'SKILL_DELETED' }])).toBe(true);
    expect(isPublicationProcessingFailure([{ name: 'security-scan' }])).toBe(false);
    expect(isPublicationProcessingFailure(undefined)).toBe(false);
  });

  it('recognizes issue codes under a normal gate name, before the legacy gate fallback', () => {
    expect(publicationProcessingErrorCode([{ name: 'package-validation', status: 'failed',
      issues: [{ severity: 'error', code: 'MANIFEST_INVALID' }] }])).toBe('MANIFEST_INVALID');
    expect(publicationProcessingErrorCode([{ name: 'INTERNAL_ERROR', status: 'failed',
      issues: [{ code: 'SKILL_DELETED' }] }])).toBe('SKILL_DELETED');
    expect(publicationProcessingErrorCode([{ name: 'publication', status: 'failed',
      issues: [{ code: 'FORBIDDEN', message: '已删除的 Skill 不能继续发布' }] }])).toBe('SKILL_DELETED');
  });

  it('does not turn passed gates or warning findings into a publication failure', () => {
    expect(isPublicationProcessingFailure([{ name: 'package-validation', status: 'passed',
      issues: [{ severity: 'error', code: 'MANIFEST_INVALID' }] }])).toBe(false);
    expect(isPublicationProcessingFailure([{ name: 'security-scan', status: 'failed',
      issues: [{ severity: 'warning', code: 'MANIFEST_INVALID' }, { severity: 'error', code: 'UNSAFE_PATH' }] }])).toBe(false);
    expect(publicationProcessingErrorCode([{ name: 'publication', status: 'failed',
      issues: [null, 'legacy finding', { severity: 'error', code: 'INVALID_PARAMS' }] }])).toBe('INVALID_PARAMS');
  });

  it.each(['warn', 'warning', ' WARNING ', 'pending', 'scanning'])('excludes non-failing %s gates before reading issue codes or legacy gate names', (status) => {
    expect(isPublicationProcessingFailure([{ name: 'MANIFEST_INVALID', status }])).toBe(false);
    expect(isPublicationProcessingFailure([{ name: 'package-validation', status,
      issues: [{ severity: 'error', code: 'MANIFEST_INVALID' }] }])).toBe(false);
  });

  it('uses the safe fallback for unknown processing codes while retaining security findings', () => {
    expect(publicationProcessingErrorCode([{ name: 'package-validation', status: 'failed',
      issues: [{ severity: 'error', code: 'FUTURE_PROCESSOR_FAILURE' }] }])).toBe('INTERNAL');
    expect(publicationProcessingErrorCode([{ name: 'archive-safety', status: 'failed',
      issues: [{ severity: 'error', code: 'UNSAFE_PATH' }] }])).toBeUndefined();
  });
});
