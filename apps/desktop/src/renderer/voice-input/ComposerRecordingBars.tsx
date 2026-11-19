import { useLayoutEffect, useState, type RefObject } from 'react';

export type RecordingSamplesRef = RefObject<((pcm: ArrayBuffer) => void) | null>;

const quiet = [0, 0, 0];
const samplesPerBar = 640; // 40 ms at the capture stream's 16 kHz rate.

export function ComposerRecordingBars({ samplesRef }: { samplesRef?: RecordingSamplesRef }) {
  const [levels, setLevels] = useState(quiet);
  const [starting, setStarting] = useState(false);
  useLayoutEffect(() => {
    let waitingForSound = Boolean(samplesRef);
    setStarting(waitingForSound);
    setLevels(quiet);
    if (!samplesRef) return;
    let count = 0;
    let energy = 0;
    samplesRef.current = (pcm) => {
      for (const sample of new Int16Array(pcm)) {
        energy += sample * sample;
        if (++count < samplesPerBar) continue;
        // Map RMS from -54 to -12 dBFS into the icon's visible range.
        const db = 10 * Math.log10(energy / (samplesPerBar * 32768 ** 2));
        const level = Math.max(0, Math.min(1, (db + 54) / 42));
        if (waitingForSound && level > 0) {
          waitingForSound = false;
          setStarting(false);
        }
        setLevels((previous) =>
          previous.every((value) => value === level) ? previous : [previous[1], previous[2], level],
        );
        count = 0;
        energy = 0;
      }
    };
    return () => { samplesRef.current = null; };
  }, [samplesRef]);

  return levels.map((level, index) => (
    <span
      key={index}
      className="composer-recording-bar rounded-full"
      data-starting={starting || undefined}
      style={{ transform: `scaleY(${(2 + 12 * level) / 14})` }}
    />
  ));
}
