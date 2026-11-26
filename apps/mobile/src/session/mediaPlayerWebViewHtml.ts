import { lightColors } from '@/theme/tokens';

export type MobileMediaPlayerKind = 'video' | 'audio';
export type MobileMediaPlayerCommand = 'pause' | 'reset' | 'play' | 'seek' | 'skip' | 'mute' | 'rate';
export const AUDIO_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type MobileMediaPlayerState = 'ready' | 'playing' | 'paused' | 'waiting' | 'ended' | 'error';

export interface MobileMediaPlayerStatus {
  type: 'xdt-media-player/status';
  state: MobileMediaPlayerState;
  currentTime?: number;
  duration?: number;
  paused?: boolean;
  canStart?: boolean;
  canSeek?: boolean;
  advanced?: boolean;
  muted?: boolean;
  rate?: number;
  canRoute?: boolean;
  wireless?: boolean;
  error?: string;
}

export function buildMediaPlayerWebViewCommand(command: MobileMediaPlayerCommand, value?: number | boolean): string {
  return JSON.stringify({
    type: 'xdt-media-player/command',
    command,
    ...(command === 'seek' || command === 'skip' ? { seconds: value } : { value }),
  });
}

export function buildMediaPlayerWebViewHtml({
  kind,
  mimeType,
  title,
  url,
  surface,
  chip,
  externalAudioControls = false,
  audioRouteLabel,
}: {
  kind: MobileMediaPlayerKind;
  mimeType?: string;
  title?: string;
  url: string;
  /** 页面底色(可选,缺省 light;调用方从 useTheme().colors.surface 注入)。 */
  surface?: string;
  /** video 元素底色(可选,缺省 light;来自 colors.surfaceChip)。 */
  chip?: string;
  externalAudioControls?: boolean;
  audioRouteLabel?: string;
}): string {
  const externalControls = kind === 'audio' && externalAudioControls;
  const routeButton = externalControls && audioRouteLabel
    ? `<button id="audio-route" type="button" aria-label="${escapeHtml(audioRouteLabel)}" hidden></button>`
    : '';
  const bodyBg = surface ?? lightColors.surface;
  const videoBg = chip ?? lightColors.surfaceChip;
  const escapedUrl = escapeHtml(url);
  const escapedTitle = escapeHtml(title || mediaKindLabel(kind));
  const escapedType = mimeType ? ` type="${escapeHtml(mimeType)}"` : '';
  const media = kind === 'video'
    ? `<video controls playsinline preload="metadata" aria-label="${escapedTitle}"><source src="${escapedUrl}"${escapedType}></video>`
    : `<audio${externalControls ? '' : ' controls'} preload="auto" aria-label="${escapedTitle}"><source src="${escapedUrl}"${escapedType}></audio>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <style>
    html, body {
      background: ${externalControls ? 'transparent' : bodyBg};
      height: 100%;
      margin: 0;
      width: 100%;
    }
    body {
      align-items: center;
      display: flex;
      justify-content: center;
      overflow: hidden;
    }
    video {
      background: ${videoBg};
      height: 100%;
      object-fit: contain;
      width: 100%;
    }
    audio {
      width: min(92vw, 680px);
    }
    ${routeButton ? `
    #audio-route {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      padding: 0;
      border: 0;
      background: transparent;
    }` : ''}
  </style>
</head>
<body>
  ${media}
  ${routeButton}
  <script>
    (function () {
      var media = document.querySelector('${kind}');
      var lastTimeUpdate = 0;
      ${externalControls ? `
      var hasPlayed = false;
      var canPlay = false;
      var routeButton = ${routeButton ? "document.getElementById('audio-route')" : 'null'};
      var canRoute = !!routeButton && typeof media.webkitShowPlaybackTargetPicker === 'function';
      var isBuffering = false;
      var previousPlaybackPosition;
      var reportedAdvancement = false;
      function didAdvance() {
        var advanced = !media.seeking && media.currentTime > previousPlaybackPosition;
        previousPlaybackPosition = media.currentTime;
        if (!advanced || reportedAdvancement) return false;
        reportedAdvancement = true;
        return true;
      }
      function canSeek() {
        var ranges = media.seekable;
        return Number.isFinite(media.duration) && media.duration > 0 && ranges.length === 1
          && ranges.start(0) <= 0.05 && ranges.end(0) >= media.duration - 0.05;
      }
      function audioState() {
        if (media.ended) return 'ended';
        if (!canPlay || (!media.paused && (!hasPlayed || isBuffering))) return 'waiting';
        return media.paused ? 'paused' : 'playing';
      }` : ''}
      function finite(value) {
        return Number.isFinite(value) ? Math.max(0, value) : undefined;
      }
      function emit(state, error, force, advanced) {
        var now = Date.now();
        if (!force && !advanced && state === 'playing' && now - lastTimeUpdate < 1000) return;
        if (state === 'playing') lastTimeUpdate = now;
        var payload = {
          type: 'xdt-media-player/status',
          state: state,
          currentTime: finite(media.currentTime),
          duration: finite(media.duration),
          error: error || undefined
        };
        ${externalControls ? `
        payload.paused = media.paused;
        payload.canStart = media.readyState >= media.HAVE_METADATA;
        payload.canSeek = canSeek();
        payload.muted = media.muted;
        payload.rate = media.playbackRate;
        payload.canRoute = canRoute;
        payload.wireless = !!media.webkitCurrentPlaybackTargetIsWireless;
        if (advanced) payload.advanced = true;` : ''}
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      }
      function readCommand(data) {
        if (typeof data !== 'string') return null;
        try {
          var parsed = JSON.parse(data);
          if (!parsed || parsed.type !== 'xdt-media-player/command') return null;
          return parsed;
        } catch (error) {
          return null;
        }
      }
      function handleCommand(event) {
        var message = readCommand(event && event.data);
        if (!message) return;
        var command = message.command;
        ${externalControls ? `
        if (command === 'play') {
          media.play().catch(function (error) {
            if (error.name !== 'AbortError') emit('error', error.name || 'play failed', true);
          });
          return;
        }
        if (command === 'mute' && typeof message.value === 'boolean') {
          media.muted = message.value;
          emit(audioState(), undefined, true);
          return;
        }
        if (command === 'rate' && ${JSON.stringify(AUDIO_PLAYBACK_RATES)}.includes(message.value)) {
          media.playbackRate = message.value;
          emit(audioState(), undefined, true);
          return;
        }
        if ((command === 'seek' || command === 'skip') && Number.isFinite(message.seconds) && canSeek()) {
          var requestedTime = command === 'skip' ? media.currentTime + message.seconds : message.seconds;
          var target = Math.max(0, Math.min(media.duration, requestedTime));
          previousPlaybackPosition = undefined;
          try { media.currentTime = target; } catch (error) {}
          emit(audioState(), undefined, true);
          return;
        }` : ''}
        if (command === 'pause') {
          if (!media.paused) media.pause();
          emit(${externalControls ? "audioState()" : "media.ended ? 'ended' : 'paused'"}, undefined, true);
          return;
        }
        if (command === 'reset') {
          media.pause();
          try {
            media.currentTime = 0;
          } catch (error) {}
          emit('paused', undefined, true);
        }
      }
      if (!media) return;
      window.addEventListener('message', handleCommand);
      document.addEventListener('message', handleCommand);
      media.addEventListener('${kind === 'audio' ? 'canplay' : 'loadedmetadata'}', function () {
        ${externalControls ? 'canPlay = true;' : ''}
        ${kind === 'audio' ? 'if (!media.paused || media.ended) return;' : ''}
        emit('ready', undefined, true);
      });
      media.addEventListener('${kind === 'audio' ? 'playing' : 'play'}', function () {
        ${externalControls ? 'canPlay = true; hasPlayed = true; isBuffering = false; previousPlaybackPosition = media.currentTime;' : ''}
        emit('playing', undefined, true);
      });
      media.addEventListener('timeupdate', function () {
        ${externalControls ? `
        var state = audioState();
        emit(state, undefined, false, state === 'playing' && didAdvance());`
          : "emit(media.paused ? 'paused' : 'playing', undefined, false);"}
      });
      media.addEventListener('pause', function () {
        emit(${externalControls ? "audioState()" : "media.ended ? 'ended' : 'paused'"}, undefined, true);
      });
      media.addEventListener('waiting', function () {
        ${externalControls ? 'isBuffering = true;' : ''}
        emit('waiting', undefined, true);
      });
      ${externalControls ? `
      media.addEventListener('play', function () {
        isBuffering = true;
        emit(audioState(), undefined, true);
      });
      function reportPosition() { emit(audioState(), undefined, true); }
      media.addEventListener('loadedmetadata', reportPosition);
      media.addEventListener('volumechange', reportPosition);
      media.addEventListener('ratechange', reportPosition);
      if (canRoute) {
        routeButton.hidden = false;
        routeButton.addEventListener('click', function () {
          // Called on the current media element from a genuine WKWebView user gesture.
          media.webkitShowPlaybackTargetPicker();
        });
        media.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', reportPosition);
      }
      media.addEventListener('seeked', function () {
        previousPlaybackPosition = media.currentTime;
        reportPosition();
      });
      media.addEventListener('durationchange', reportPosition);
      media.addEventListener('progress', reportPosition);
      ` : ''}
      media.addEventListener('ended', function () {
        emit('ended', undefined, true${externalControls ? ', didAdvance()' : ''});
      });
      function reportMediaError() {
        var err = media.error ? String(media.error.code || media.error.message || 'media error') : 'media error';
        emit('error', err, true);
      }
      media.addEventListener('error', reportMediaError);
      // The only source can fail without bubbling an error to the media element.
      var source = media.querySelector('source');
      if (source) source.addEventListener('error', reportMediaError);
    })();
  </script>
</body>
</html>`;
}

export function parseMediaPlayerWebViewMessage(data: string): MobileMediaPlayerStatus | null {
  try {
    const value = JSON.parse(data) as Partial<MobileMediaPlayerStatus> | null;
    if (!value || value.type !== 'xdt-media-player/status' || !isMediaPlayerState(value.state)) return null;
    return {
      type: 'xdt-media-player/status',
      state: value.state,
      currentTime: finiteNumber(value.currentTime),
      duration: finiteNumber(value.duration),
      ...(typeof value.paused === 'boolean' ? { paused: value.paused } : {}),
      ...(typeof value.canStart === 'boolean' ? { canStart: value.canStart } : {}),
      ...(typeof value.canSeek === 'boolean' ? { canSeek: value.canSeek } : {}),
      ...(value.advanced === true ? { advanced: true } : {}),
      ...(typeof value.muted === 'boolean' ? { muted: value.muted } : {}),
      ...(typeof value.rate === 'number' && Number.isFinite(value.rate) && value.rate > 0 ? { rate: value.rate } : {}),
      ...(typeof value.canRoute === 'boolean' ? { canRoute: value.canRoute } : {}),
      ...(typeof value.wireless === 'boolean' ? { wireless: value.wireless } : {}),
      error: typeof value.error === 'string' ? value.error : undefined,
    };
  } catch {
    return null;
  }
}

function mediaKindLabel(kind: MobileMediaPlayerKind): string {
  return kind === 'video' ? 'Video' : 'Audio';
}

function isMediaPlayerState(value: unknown): value is MobileMediaPlayerState {
  return value === 'ready'
    || value === 'playing'
    || value === 'paused'
    || value === 'waiting'
    || value === 'ended'
    || value === 'error';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
