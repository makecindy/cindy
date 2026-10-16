import { expect, it } from 'vitest';
import { microphoneDiagnostic } from '../microphoneDiagnostics';

it('keeps only actual processing settings and finite numeric capture metadata', () => {
  expect(
    microphoneDiagnostic('stream_started', {
      tracks: [
        {
          label: 'personal device',
          settings: {
            deviceId: 'private-id',
            groupId: 'private-group',
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: 'unsupported',
            sampleRate: 48000,
            channelCount: 1,
            latency: Infinity,
          },
        },
        null,
      ],
    }),
  ).toEqual({
    event: 'stream_started',
    tracks: [
      {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: null,
        sampleRate: 48000,
        channelCount: 1,
        latency: null,
      },
      {
        echoCancellation: null,
        noiseSuppression: null,
        autoGainControl: null,
        sampleRate: null,
        channelCount: null,
        latency: null,
      },
    ],
  });
});

it('does not spread raw errors, device identities or arbitrary context states into diagnostics', () => {
  const privateDetails = {
    label: 'private',
    deviceId: 'private',
    error: new Error('private'),
    state: 'private',
    sampleRate: NaN,
    tracks: [{ label: 'private' }],
  };
  for (const event of [
    'audio_worklet_ready',
    'audio_worklet_fallback',
    'script_processor_ready',
    'track_ended',
    'track_muted',
    'track_unmuted',
  ])
    expect(microphoneDiagnostic(event, privateDetails)).toEqual({ event });
  expect(microphoneDiagnostic('context_ready', privateDetails)).toEqual({
    event: 'context_ready',
    state: null,
    sampleRate: null,
  });
  expect(
    microphoneDiagnostic('audio_frame_stalled', {
      ...privateDetails,
      elapsedMs: 2000,
      contextState: 'suspended',
    }),
  ).toEqual({ event: 'audio_frame_stalled', elapsedMs: 2000, state: 'suspended' });
  expect(microphoneDiagnostic('unknown', privateDetails)).toBeNull();
});
