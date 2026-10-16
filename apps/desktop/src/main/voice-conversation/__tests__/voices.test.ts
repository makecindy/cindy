import { describe, expect, it, vi } from 'vitest';
import { loadSpeechVoices } from '../voices.js';
import { normalizeVoiceConversationSelection } from '../../../shared/voiceConversation.js';
import type { SpeechConnection } from '../speech.js';

const connection = (protocol: SpeechConnection['protocol']): SpeechConnection => ({
  baseUrl: 'https://provider.test/prefix/v1',
  protocol,
  headers:
    protocol === 'elevenlabs' ? { 'xi-api-key': 'test-key' } : { authorization: 'Bearer test-key' },
});
const json = (value: unknown) => new Response(JSON.stringify(value));

describe('provider voice catalogs', () => {
  it('supports real MiniMax IDs and keeps malformed IDs out of persisted selections', () => {
    for (const voice of [
      'Chinese (Mandarin)_News_Anchor',
      'Cantonese_ProfessionalHost (F)',
      'my.voice:1',
    ]) {
      expect(normalizeVoiceConversationSelection({ modelId: 'tts', voice })?.voice).toBe(voice);
    }
    for (const voice of [
      '',
      ' '.repeat(3),
      '../voice',
      'voice\\id',
      'voice\nname',
      'x'.repeat(129),
    ]) {
      expect(normalizeVoiceConversationSelection({ modelId: 'tts', voice })).toBeUndefined();
    }
    expect(normalizeVoiceConversationSelection({ modelId: 'tts', voice: ' alloy ' })?.voice).toBe(
      'alloy',
    );
  });

  it('uses model-specific OpenAI references without inventing a network catalog or voices for unknown models', async () => {
    const fetcher = vi.fn();
    const full = await loadSpeechVoices(connection('openai'), 'gpt-4o-mini-tts', fetcher, () => {});
    expect(full.source).toBe('reference');
    expect(full.voices).toHaveLength(13);
    expect(full.voices.map((v) => v.id)).toContain('cedar');
    const legacy = await loadSpeechVoices(connection('openai'), 'tts-1-hd', fetcher, () => {});
    expect(legacy.voices).toHaveLength(9);
    expect(legacy.voices.map((v) => v.id)).not.toContain('cedar');
    expect(await loadSpeechVoices(connection('openai'), 'custom-tts', fetcher, () => {})).toEqual({
      source: 'manual',
      voices: [],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('paginates ElevenLabs within the selected origin/prefix and preserves account voices regardless of high-quality labels', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          voices: [
            { voice_id: 'one', name: 'First', high_quality_base_model_ids: ['different-model'] },
            { voice_id: 'bad/path', name: 'Invalid' },
          ],
          has_more: true,
          next_page_token: 'opaque + token',
        }),
      )
      .mockResolvedValueOnce(
        json({ voices: [{ voice_id: 'two', name: 'Second' }], has_more: false }),
      );
    const result = await loadSpeechVoices(connection('elevenlabs'), 'eleven_v3', fetcher, () => {});
    expect(result.voices).toEqual([
      { id: 'one', name: 'First' },
      { id: 'two', name: 'Second' },
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://provider.test/prefix/v2/voices?page_size=100',
      expect.objectContaining({
        method: 'GET',
        headers: { 'xi-api-key': 'test-key' },
        redirect: 'error',
      }),
    );
    expect(String(fetcher.mock.calls[1][0])).toContain('next_page_token=opaque+%2B+token');
  });

  it('reads MiniMax system, cloned and generated voices without persisting preview URLs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        base_resp: { status_code: 0 },
        system_voice: [{ voice_id: 'Chinese (Mandarin)_News_Anchor', voice_name: 'News Anchor' }],
        voice_cloning: [{ voice_id: 'clone-1', preview_url: 'https://untrusted.test' }],
        voice_generation: [{ voice_id: 'generated-1' }],
      }),
    );
    const result = await loadSpeechVoices(
      connection('minimax'),
      'speech-2.8-hd',
      fetcher,
      () => {},
    );
    expect(result.voices).toEqual([
      { id: 'Chinese (Mandarin)_News_Anchor', name: 'News Anchor' },
      { id: 'clone-1', name: 'clone-1' },
      { id: 'generated-1', name: 'generated-1' },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://provider.test/prefix/v1/get_voice',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ voice_type: 'all' }),
        redirect: 'error',
      }),
    );
  });

  it('rejects business errors, malformed pagination and oversized responses', async () => {
    await expect(
      loadSpeechVoices(
        connection('minimax'),
        'tts',
        vi.fn().mockResolvedValue(
          json({
            base_resp: { status_code: 1004, status_msg: 'private diagnostic' },
            system_voice: [],
          }),
        ),
        () => {},
      ),
    ).rejects.toThrow('voice_catalog_unavailable');
    await expect(
      loadSpeechVoices(
        connection('elevenlabs'),
        'tts',
        vi.fn().mockResolvedValue(
          json({
            voices: [],
            has_more: true,
          }),
        ),
        () => {},
      ),
    ).rejects.toThrow('invalid_voice_pagination');
    await expect(
      loadSpeechVoices(
        connection('elevenlabs'),
        'tts',
        vi.fn().mockResolvedValue(new Response(' '.repeat(2 * 1024 * 1024 + 1))),
        () => {},
      ),
    ).rejects.toThrow('voice_catalog_too_large');
  });

  it('rechecks the connection before returning a private voice list', async () => {
    let current = true;
    const fetcher = vi.fn(async () => {
      current = false;
      return json({ voices: [{ voice_id: 'private', name: 'Private' }] });
    });
    await expect(
      loadSpeechVoices(connection('elevenlabs'), 'tts', fetcher, () => {
        if (!current) throw new Error('changed');
      }),
    ).rejects.toThrow('changed');
  });

  it('cancels a stalled catalog body at the total deadline', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled })));
      const pending = loadSpeechVoices(connection('elevenlabs'), 'tts', fetcher, () => {});
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(cancelled).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
