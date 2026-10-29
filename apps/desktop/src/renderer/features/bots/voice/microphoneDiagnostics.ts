/** Select capture diagnostics explicitly: engine events can contain device names,
 * stable identifiers and raw errors, none of which belong in voice-call logs. */
export function microphoneDiagnostic(
  event: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> | null {
  if (event === 'stream_started') {
    const tracks = Array.isArray(details.tracks) ? details.tracks : [];
    return {
      event,
      tracks: tracks.map((track) => {
        const settings = track?.settings ?? {};
        return {
          echoCancellation:
            typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null,
          noiseSuppression:
            typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
          autoGainControl:
            typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : null,
          sampleRate: finite(settings.sampleRate),
          channelCount: finite(settings.channelCount),
          latency: finite(settings.latency),
        };
      }),
    };
  }
  if (
    [
      'context_created',
      'context_ready',
      'context_state_changed',
      'shared_audio_context_used',
    ].includes(event)
  )
    return { event, state: audioState(details.state), sampleRate: finite(details.sampleRate) };
  if (
    [
      'audio_worklet_ready',
      'audio_worklet_fallback',
      'script_processor_ready',
      'track_ended',
      'track_muted',
      'track_unmuted',
    ].includes(event)
  )
    return { event };
  if (event === 'audio_frame_stalled')
    return { event, elapsedMs: finite(details.elapsedMs), state: audioState(details.contextState) };
  return null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function audioState(value: unknown): string | null {
  return typeof value === 'string' &&
    ['running', 'suspended', 'closed', 'interrupted'].includes(value)
    ? value
    : null;
}
