/**
 * A plugin live screen as a video track: H.264 messages are decoded with
 * WebCodecs (hardware when available), drawn upright on a canvas and handed to
 * the existing WebRTC sender, which keeps owning bitrate, loss recovery and
 * background tiers. Still images are the plugin's fallback path.
 *
 * Messages are `[type][payload]`: 0x01 avcC, 0x02 keyframe, 0x03 delta,
 * 0x04 JPEG, 0x06 PNG, 0x10 `{"type":"screen","width","height","rotation"}`.
 */
const DESCRIPTION = 0x01;
const KEY = 0x02;
const DELTA = 0x03;
const JPEG = 0x04;
const PNG = 0x06;
const SCREEN = 0x10;
const FIRST_PICTURE_MS = 10_000;
/** A still screen sends nothing; repeat the picture so a joining encoder has one. */
const REFRESH_MS = 1_000;
const MAX_DECODE_QUEUE = 8;

/** `avc1.PPCCLL` from an avcC record (profile, compatibility, level). */
export function avcCodec(description: Uint8Array): string | null {
  if (description.length < 7 || description[0] !== 1) return null;
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  return `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
}

/** Quarter turns clockwise from a `screen` message; anything else keeps the current one. */
export function screenRotation(payload: Uint8Array, current: number): number {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as {
      type?: unknown;
      rotation?: unknown;
    };
    return value?.type === 'screen' &&
      Number.isInteger(value.rotation) &&
      (value.rotation as number) >= 0 &&
      (value.rotation as number) <= 3
      ? (value.rotation as number)
      : current;
  } catch {
    return current;
  }
}

export async function liveScreenStream(
  read: (keyframe: boolean) => Promise<Uint8Array[] | null>,
  alive: () => boolean,
  failed: () => void,
): Promise<{ stream: MediaStream; stop(): void }> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
  canvas.width = canvas.height = 2;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!track) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
  let stopped = false;
  let rotation = 0;
  let decoder: VideoDecoder | null = null;
  /** The plugin sends the avcC once per stream, so a rebuilt decoder needs ours. */
  let description: Uint8Array | null = null;
  let awaitingKey = true;
  let wantKey = false;
  let timestamp = 0;
  let painted = false;
  /** Still pictures: one decode at a time, newest waiting, so a slow decode never queues up. */
  let imageBusy = false;
  let imageNext: { type: number; payload: Uint8Array<ArrayBuffer> } | null = null;
  let resolveFirst: (() => void) | null = null;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });

  const paint = (picture: VideoFrame | ImageBitmap, width: number, height: number) => {
    if (stopped) return;
    const turned = rotation % 2 === 1;
    const w = turned ? height : width;
    const h = turned ? width : height;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.translate(w / 2, h / 2);
    context.rotate((rotation * Math.PI) / 2);
    context.drawImage(picture, -width / 2, -height / 2, width, height);
    track.requestFrame();
    if (!painted) {
      painted = true;
      resolveFirst?.();
    }
  };
  const resetDecoder = () => {
    try {
      decoder?.close();
    } catch {
      /* already closed */
    }
    decoder = null;
    awaitingKey = true;
    wantKey = true;
    // Rebuild from the last configuration: the keyframe asked for next has
    // nothing to decode it otherwise and the picture would stay stuck.
    if (description && !stopped) {
      try {
        configure(description);
      } catch {
        /* stays without a decoder until the plugin sends a new configuration */
      }
    }
  };
  const configure = (record: Uint8Array) => {
    description = record;
    const codec = avcCodec(record);
    if (!codec) return;
    try {
      decoder?.close();
    } catch {
      /* already closed */
    }
    const current = new VideoDecoder({
      output: (frame) => {
        try {
          if (decoder === current) paint(frame, frame.displayWidth, frame.displayHeight);
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (decoder === current) resetDecoder();
      },
    });
    current.configure({
      codec,
      description: record.slice().buffer,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
    });
    decoder = current;
    awaitingKey = true;
  };
  const handle = (message: Uint8Array) => {
    const type = message[0];
    const payload = message.subarray(1);
    if (type === SCREEN) rotation = screenRotation(payload, rotation);
    else if (type === DESCRIPTION) configure(payload);
    else if (type === KEY || type === DELTA) {
      if (!decoder || decoder.state !== 'configured') return;
      if (type === DELTA && awaitingKey) return;
      // A decoder that cannot keep up would only add delay: start over from a keyframe.
      if (type === DELTA && decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
        awaitingKey = true;
        wantKey = true;
        return;
      }
      if (type === KEY) awaitingKey = false;
      try {
        decoder.decode(
          new EncodedVideoChunk({ type: type === KEY ? 'key' : 'delta', timestamp, data: payload }),
        );
        timestamp += 16_667;
      } catch {
        resetDecoder();
      }
    } else if (type === JPEG || type === PNG) {
      imageNext = { type, payload: payload.slice() };
      if (!imageBusy) void drawImages();
    }
  };
  const drawImages = async () => {
    imageBusy = true;
    try {
      while (imageNext && !stopped) {
        const { type, payload } = imageNext;
        imageNext = null;
        try {
          const bitmap = await createImageBitmap(
            new Blob([payload], { type: type === JPEG ? 'image/jpeg' : 'image/png' }),
          );
          try {
            paint(bitmap, bitmap.width, bitmap.height);
          } finally {
            bitmap.close();
          }
        } catch {
          /* a bad picture is skipped */
        }
      }
    } finally {
      imageBusy = false;
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(refresh);
    try {
      decoder?.close();
    } catch {
      /* already closed */
    }
    decoder = null;
    track.stop();
    canvas.width = canvas.height = 1;
  };
  const refresh = setInterval(() => {
    if (!painted || stopped) return;
    // A canvas that has not been drawn on since its last capture gives no frame,
    // whatever is requested: draw the picture onto itself so there is one to take.
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'copy';
    context.drawImage(canvas, 0, 0);
    context.restore();
    track.requestFrame();
  }, REFRESH_MS);
  void (async () => {
    try {
      while (!stopped && alive()) {
        const keyframe = wantKey;
        wantKey = false;
        const messages = await read(keyframe);
        if (messages === null) throw new Error('DESKTOP_SCREEN_ENDED');
        if (stopped || !alive()) break;
        for (const message of messages) if (message.length) handle(message);
      }
      stop();
    } catch {
      stop();
      if (alive()) failed();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      first,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DESKTOP_VIDEO_UNAVAILABLE')), FIRST_PICTURE_MS);
      }),
    ]);
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (stopped) throw new Error('DESKTOP_VIDEO_STOPPED');
  return { stream, stop };
}
