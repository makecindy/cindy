// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceSpeakerFilterStatus } from '../../../../shared/voiceSpeakerFilter';
import { initialDownloadProgress } from '../../../../shared/downloadProgress';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

import { VoiceSpeakerFilterCard } from '../VoiceSpeakerFilterCard';

const baseStatus: VoiceSpeakerFilterStatus = {
  supported: true,
  modelState: 'missing',
  downloadedBytes: 0,
  totalBytes: 28_925_018,
  enrolled: false,
};

let pushStatus: ((status: VoiceSpeakerFilterStatus) => void) | null = null;
const api = {
  getStatus: vi.fn(),
  downloadModels: vi.fn(),
  cancelDownload: vi.fn(),
  enroll: vi.fn(),
  deleteProfile: vi.fn(),
  onStatusChanged: vi.fn((callback: (status: VoiceSpeakerFilterStatus) => void) => {
    pushStatus = callback;
    return () => {
      pushStatus = null;
    };
  }),
};

function mockStatus(status: VoiceSpeakerFilterStatus): void {
  api.getStatus.mockResolvedValue(status);
  api.downloadModels.mockResolvedValue({ ...status, modelState: 'downloading' });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin', voiceInput: { speakerFilter: api } },
  });
});

function renderCard(props: Partial<React.ComponentProps<typeof VoiceSpeakerFilterCard>> = {}) {
  const onEnabledChange = vi.fn();
  render(
    <VoiceSpeakerFilterCard
      enabled={false}
      strictness="standard"
      strictnessCustomized={false}
      microphoneDeviceId={null}
      onEnabledChange={onEnabledChange}
      onStrictnessChange={vi.fn()}
      onStrictnessReset={vi.fn(async () => true)}
      {...props}
    />,
  );
  return { onEnabledChange };
}

describe('VoiceSpeakerFilterCard', () => {
  it('turning the filter on for the first time starts the model download', async () => {
    mockStatus(baseStatus);
    const { onEnabledChange } = renderCard();
    const toggle = await screen.findByRole('switch', { name: 'settings.voiceInput.speakerFilter.ariaLabel' });
    await vi.waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(onEnabledChange).toHaveBeenCalledWith(true);
    expect(api.downloadModels).toHaveBeenCalledTimes(1);
  });

  it('shows the shared download meter while models download and still lets the user cancel', async () => {
    mockStatus({
      ...baseStatus,
      modelState: 'downloading',
      downloadedBytes: 14_000_000,
      download: {
        ...initialDownloadProgress('retrying', baseStatus.totalBytes),
        loaded: 14_000_000,
        percent: 48,
        attempt: 2,
        retryReason: 'network',
      },
    });
    renderCard({ enabled: true });
    expect((await screen.findByRole('progressbar')).getAttribute('aria-valuenow')).toBe('48');
    expect(screen.getByText('downloadProgress.retry.network')).toBeTruthy();
    fireEvent.click(screen.getByText('settings.voiceInput.speakerFilter.model.cancel'));
    expect(api.cancelDownload).toHaveBeenCalledOnce();
  });

  it('does not download again when the models are already there', async () => {
    mockStatus({ ...baseStatus, modelState: 'ready' });
    renderCard();
    const toggle = await screen.findByRole('switch', { name: 'settings.voiceInput.speakerFilter.ariaLabel' });
    await vi.waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(api.downloadModels).not.toHaveBeenCalled();
  });

  it('asks for a voiceprint before showing strictness', async () => {
    mockStatus({ ...baseStatus, modelState: 'ready' });
    renderCard({ enabled: true });
    expect(await screen.findByText('settings.voiceInput.speakerFilter.profile.missing')).toBeTruthy();
    expect(screen.queryByText('settings.voiceInput.speakerFilter.strictness.label')).toBeNull();

    act(() => pushStatus?.({ ...baseStatus, modelState: 'ready', enrolled: true, enrolledAt: 1 }));
    expect(await screen.findByText('settings.voiceInput.speakerFilter.profile.enrolled')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'settings.voiceInput.speakerFilter.strictness.label' })).toBeTruthy();
  });

  it('keeps delete available after the filter is turned off', async () => {
    mockStatus({ ...baseStatus, modelState: 'ready', enrolled: true, enrolledAt: 1 });
    api.deleteProfile.mockResolvedValue({ ...baseStatus, modelState: 'ready' });
    renderCard({ enabled: false });
    const remove = await screen.findByRole('button', { name: 'settings.voiceInput.speakerFilter.profile.delete' });
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(api.deleteProfile).toHaveBeenCalledTimes(1);
  });

  it('disables the switch where voiceprints are unsupported', async () => {
    mockStatus({ ...baseStatus, supported: false });
    renderCard();
    expect(await screen.findByText('settings.voiceInput.speakerFilter.unsupported')).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: 'settings.voiceInput.speakerFilter.ariaLabel' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});
