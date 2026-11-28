import fs, { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEGAL_TERMS_VERSION } from '../../../shared/legalTermsVersion';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: object, consentVersion?: unknown) => unknown>(),
  trustedRenderer: vi.fn(),
  target: vi.fn(),
  consentReadable: vi.fn(),
  readAnalyticsConsent: vi.fn(),
  readAnalytics: vi.fn(),
  collect: vi.fn(),
  send: vi.fn(),
  broadcast: vi.fn(),
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => '0.1.0',
    getLocale: () => 'en',
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.broadcast } }],
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
  readAnalyticsConsentFromDisk: mocks.readAnalyticsConsent,
  readAnalyticsSettings: mocks.readAnalytics,
  refreshAnalyticsSettingsFromDisk: vi.fn(),
}));
vi.mock('../../lifecycle', () => ({
  isFatalShutdownReason: vi.fn(),
  onFatalShutdown: vi.fn(),
  onQuit: vi.fn(),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
vi.mock('../pendingMarkers', () => ({
  PendingMarkerStore: class { clearAll() {} },
}));

import { __testing as logUploadTesting, initLogUploadService } from '../index';
import { __testing as storeTesting } from '../logUploadSettingsStore';

const upload = (consentVersion?: unknown) =>
  mocks.handlers.get('log-upload:upload-now')!({}, consentVersion);
const accept = (version: unknown = LEGAL_TERMS_VERSION) =>
  mocks.handlers.get('log-upload:accept-manual-consent')!({}, version);
const settings = () => mocks.handlers.get('log-upload:settings-get')!({});
const settingsFile = () => join(mocks.userData, 'log-upload-settings.json');
const consentFile = () => join(mocks.userData, 'manual-log-upload-consent.json');

beforeAll(initLogUploadService);
beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'manual-log-upload-'));
  storeTesting.resetProbe();
  vi.clearAllMocks();
  mocks.target.mockReturnValue({});
  mocks.consentReadable.mockReturnValue(true);
  mocks.readAnalyticsConsent.mockResolvedValue(false);
  mocks.readAnalytics.mockReturnValue({ privacyConsentAccepted: false });
  mocks.collect.mockResolvedValue({
    records: [{ msg: 'sample diagnostic record' }],
    coveredAnchors: [],
    stats: { lookbackDays: 1, bytesRead: 25, droppedBySource: 0, droppedByCap: 0 },
  });
  mocks.send.mockResolvedValue({ ok: true, records: 1, batches: 1 });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(mocks.userData, { recursive: true, force: true });
});

describe('manual log upload IPC', () => {
  it.each([
    [false, false, true],
    [true, true, false],
    [null, false, false],
  ])('projects manual upload and consent actions from the readable local record', async (consent, available, offersConsent) => {
    mocks.readAnalyticsConsent.mockResolvedValue(consent);
    await expect(settings()).resolves.toMatchObject({
      manualUploadAvailable: available,
      manualUploadConsentRequired: offersConsent,
    });
    expect(mocks.consentReadable).not.toHaveBeenCalled();
    expect(mocks.readAnalyticsConsent).toHaveBeenCalledOnce();
  });

  it('saves manual consent without sending logs or changing crash settings', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ crashAutoUploadEnabled: true }));
    // A previous renderer's upload argument must never count as consent.
    await expect(upload(LEGAL_TERMS_VERSION)).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    await expect(accept()).resolves.toMatchObject({
      privacyConsentAccepted: false,
      crashAutoUploadEnabled: true,
      crashAutoUploadCustomized: true,
      manualUploadAvailable: true,
      manualUploadConsentRequired: false,
    });
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.consentReadable).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({
      crashAutoUploadEnabled: true,
    });
    expect(JSON.parse(readFileSync(consentFile(), 'utf8'))).toBe(LEGAL_TERMS_VERSION);
    expect(mocks.broadcast).toHaveBeenCalledWith('log-upload:settings-change', expect.objectContaining({
      privacyConsentAccepted: false,
      manualUploadAvailable: true,
    }));
    logUploadTesting.handleFatalShutdown('test-crash');
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    await expect(upload()).resolves.toMatchObject({ recordCount: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('reads the current grant even if another instance changes or removes it', async () => {
    writeFileSync(consentFile(), JSON.stringify('older-policy'));
    await expect(settings()).resolves.toMatchObject({
      manualUploadAvailable: false, manualUploadConsentRequired: true,
    });
    await expect(upload()).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    writeFileSync(consentFile(), JSON.stringify(LEGAL_TERMS_VERSION));
    await expect(settings()).resolves.toMatchObject({
      manualUploadAvailable: true, manualUploadConsentRequired: false,
    });
    await expect(upload()).resolves.toMatchObject({ recordCount: 1 });
    rmSync(consentFile());
    await expect(settings()).resolves.toMatchObject({
      manualUploadAvailable: false, manualUploadConsentRequired: true,
    });
    await expect(upload()).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
  });

  it('preserves a grant from another instance when updating or resetting the crash preference', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ crashAutoUploadEnabled: true }));
    await expect(settings()).resolves.toMatchObject({ crashAutoUploadEnabled: true });
    writeFileSync(consentFile(), JSON.stringify(LEGAL_TERMS_VERSION));

    await expect(mocks.handlers.get('log-upload:set-crash-auto')!({}, false)).resolves.toMatchObject({
      manualUploadAvailable: true, crashAutoUploadEnabled: false, crashAutoUploadCustomized: true,
    });
    await expect(mocks.handlers.get('log-upload:reset-crash-auto')!({})).resolves.toMatchObject({
      manualUploadAvailable: true, crashAutoUploadEnabled: false, crashAutoUploadCustomized: false,
    });
    expect(JSON.parse(readFileSync(consentFile(), 'utf8'))).toBe(LEGAL_TERMS_VERSION);
  });

  it('uploads without an explicit policy version when consent is already saved', async () => {
    mocks.readAnalytics.mockReturnValue({ privacyConsentAccepted: true });
    mocks.readAnalyticsConsent.mockResolvedValue(true);
    await expect(settings()).resolves.toMatchObject({
      manualUploadAvailable: true, manualUploadConsentRequired: false,
    });
    expect(mocks.readAnalyticsConsent).not.toHaveBeenCalled();
    await expect(upload()).resolves.toMatchObject({ recordCount: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each([true, 'stale-policy-version'])('rejects invalid consent %s before collection', async (value) => {
    await expect(accept(value)).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('still blocks collection when the existing consent record is unreadable', async () => {
    mocks.readAnalyticsConsent.mockResolvedValue(null);
    await expect(accept()).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    await expect(upload()).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('keeps a damaged manual grant unavailable and preserves its file', async () => {
    writeFileSync(consentFile(), '{corrupt');
    await expect(accept()).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    await expect(upload()).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    expect(readFileSync(consentFile(), 'utf8')).toBe('{corrupt');
    await expect(settings()).resolves.toMatchObject({
      manualUploadAvailable: false, manualUploadConsentRequired: false,
    });
  });

  it('preserves the prior grant and does not unlock upload when atomic replacement fails', async () => {
    writeFileSync(consentFile(), JSON.stringify('older-policy'));
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('file locked'), { code: 'EPERM' }),
    );
    await expect(accept()).rejects.toThrow('[INTERNAL]');
    expect(JSON.parse(readFileSync(consentFile(), 'utf8'))).toBe('older-policy');
    expect(readdirSync(mocks.userData)).toEqual(['manual-log-upload-consent.json']);
    expect(mocks.broadcast).not.toHaveBeenCalled();
    await expect(upload()).rejects.toThrow('[PRIVACY_CONSENT_REQUIRED]');
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('still blocks collection when no upload target is configured', async () => {
    mocks.target.mockReturnValue(null);
    await expect(accept()).rejects.toThrow('[LOG_UPLOAD_UNAVAILABLE]');
    await expect(upload()).rejects.toThrow('[LOG_UPLOAD_UNAVAILABLE]');
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('rejects an untrusted renderer before recording consent', async () => {
    mocks.trustedRenderer.mockImplementationOnce(() => { throw new Error('untrusted renderer'); });
    await expect(accept()).rejects.toThrow('untrusted renderer');
    expect(mocks.readAnalyticsConsent).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});
