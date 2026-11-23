import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEGAL_TERMS_VERSION } from '../../../shared/legalTermsVersion';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: object, consentVersion?: unknown) => unknown>(),
  trustedRenderer: vi.fn(),
  target: vi.fn(),
  consentReadable: vi.fn(),
  readAnalytics: vi.fn(),
  collect: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => 'mock-user-data',
    getVersion: () => '0.1.0',
    getLocale: () => 'en',
  },
  ipcMain: {
    handle: (channel: string, fn: (event: object, consentVersion?: unknown) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../../authManager', () => ({
  getAuthState: () => ({}),
  getDeviceId: () => 'test-device',
}));
vi.mock('../../analytics-settings-store', () => ({
  isAnalyticsConsentRecordReadable: mocks.consentReadable,
  readAnalyticsSettings: mocks.readAnalytics,
  refreshAnalyticsSettingsFromDisk: vi.fn(),
}));
vi.mock('../../lifecycle', () => ({
  isFatalShutdownReason: vi.fn(),
  onFatalShutdown: vi.fn(),
  onQuit: vi.fn(),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
  getLogDir: () => 'mock-logs',
}));
vi.mock('../../startup-diagnostics', () => ({ getPreviousRunReports: vi.fn() }));
vi.mock('../../maker-host/outbound-fetch.desktop', () => ({ outboundFetch: vi.fn() }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.trustedRenderer,
}));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: vi.fn() }));
vi.mock('../../performance-trace/upload', () => ({ submitPerformanceReport: vi.fn() }));
vi.mock('../collectRuntime', () => ({ collectLogsFromDisk: mocks.collect }));
vi.mock('../logSink', () => ({ sendLogs: mocks.send }));
vi.mock('../logUploadTarget', () => ({ resolveLogUploadTarget: mocks.target }));
vi.mock('../logUploadSettingsStore', () => ({
  isCrashAutoUploadEnabled: vi.fn(),
  isCrashAutoUploadCustomized: vi.fn(),
  refreshLogUploadSettingsFromDisk: vi.fn(),
}));
vi.mock('../pendingMarkers', () => ({
  PendingMarkerStore: class { clearAll() {} },
}));

import { initLogUploadService } from '../index';

const upload = (consentVersion?: unknown) =>
  mocks.handlers.get('log-upload:upload-now')!({}, consentVersion);

beforeAll(initLogUploadService);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.target.mockReturnValue({});
  mocks.consentReadable.mockReturnValue(true);
  mocks.readAnalytics.mockReturnValue({ privacyConsentAccepted: false });
  mocks.collect.mockResolvedValue({
    records: [{ msg: 'sample diagnostic record' }],
    coveredAnchors: [],
    stats: { lookbackDays: 1, bytesRead: 25, droppedBySource: 0, droppedByCap: 0 },
  });
  mocks.send.mockResolvedValue({ ok: true, records: 1, batches: 1 });
});

describe('manual log upload IPC', () => {
  it.each([
    [true, false, false, true],
    [true, true, true, false],
    [false, false, false, false],
  ])('projects manual upload and consent actions from the readable local record', (readable, accepted, available, offersConsent) => {
    mocks.consentReadable.mockReturnValue(readable);
    mocks.readAnalytics.mockReturnValue({ privacyConsentAccepted: accepted });
    expect(mocks.handlers.get('log-upload:settings-get')!({})).toMatchObject({
      manualUploadAvailable: available,
      manualUploadConsentRequired: offersConsent,
    });
  });

  it('uses explicit current-policy consent once and leaves the next plain request blocked', async () => {
    await expect(upload(LEGAL_TERMS_VERSION)).resolves.toMatchObject({ recordCount: 1 });
    await expect(upload()).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('uploads without an explicit policy version when consent is already saved', async () => {
    mocks.readAnalytics.mockReturnValue({ privacyConsentAccepted: true });
    await expect(upload()).resolves.toMatchObject({ recordCount: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each([true, 'stale-policy-version'])('rejects invalid consent %s before collection', async (value) => {
    await expect(upload(value)).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('still blocks collection when the existing consent record is unreadable', async () => {
    mocks.consentReadable.mockReturnValue(false);
    await expect(upload(LEGAL_TERMS_VERSION)).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('still blocks collection when no upload target is configured', async () => {
    mocks.target.mockReturnValue(null);
    await expect(upload(LEGAL_TERMS_VERSION)).rejects.toThrow('[LOG_UPLOAD_UNAVAILABLE]');
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('rejects an untrusted renderer before evaluating one-time consent', async () => {
    mocks.trustedRenderer.mockImplementationOnce(() => { throw new Error('untrusted renderer'); });
    await expect(upload(LEGAL_TERMS_VERSION)).rejects.toThrow('untrusted renderer');
    expect(mocks.consentReadable).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});
