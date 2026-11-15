import {
  PROJECT_AUTO_ICON_CHANNEL,
  parseAutomaticProjectIcon,
  type AutomaticProjectIcon,
} from '@cindy/maker-shared/project-alias-sync';
import { useEffect, useState } from 'react';
import { Folder } from 'lucide-react';
import {
  parseProjectSymbol,
  parseProjectLetters,
  defaultProjectLetters,
  defaultProjectColor,
  isProjectImage,
  isProjectImageDraft,
  PROJECT_ICON_IMAGE_CHANNEL,
} from '@cindy/maker-shared/project-alias-sync';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { projectSymbolIcons } from './projectSymbolIcons';
export function ProjectIcon({
  value,
  projectKey,
  projectName,
  deviceId,
  automaticEnabled = true,
  size = 20,
}: {
  value: string | null;
  projectKey: string;
  projectName: string;
  automaticEnabled?: boolean;
  deviceId?: string | null;
  size?: number;
}) {
  const automatic = useAutomaticProjectIcon(
    projectKey,
    deviceId,
    value === null && automaticEnabled && !!projectKey,
  );
  const [loaded, setLoaded] = useState<{ value: string; data: string } | null>(null);
  useEffect(() => {
    if (!isProjectImage(value)) return;
    let active = true;
    const owner = getDataOwnerGeneration();
    const read = deviceId
      ? window.electronAPI.deviceLink.invoke(deviceId, PROJECT_ICON_IMAGE_CHANNEL, [{ projectKey }])
      : window.electronAPI.localDb.projectAliases.iconImage({ projectKey });
    void read
      .then((data) => {
        if (active && typeof data === 'string' && isDataOwnerGenerationCurrent(owner))
          setLoaded({ value, data });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [value, projectKey, deviceId]);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source =
    value === null && !automatic.result?.candidate
      ? automatic.result?.image
      : isProjectImageDraft(value)
        ? value
        : loaded?.value === value
          ? loaded.data
          : null;
  if (source && source !== failedSource)
    return (
      <img
        src={source}
        alt=""
        width={size}
        height={size}
        className="shrink-0 object-cover"
        onError={() => setFailedSource(source)}
      />
    );
  if (value?.startsWith('symbol:')) {
    const symbol = parseProjectSymbol(value);
    const Icon = symbol ? projectSymbolIcons[symbol.name] : Folder;
    if (symbol?.color === 'white')
      return (
        <span
          className="inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--task-tag-white)] text-[var(--task-tag-white-check)]"
          style={{ width: size, height: size }}
        >
          <Icon size={size * 0.75} strokeWidth={1.6} />
        </span>
      );
    return (
      <Icon
        size={size}
        strokeWidth={1.6}
        style={
          symbol && symbol.color !== 'default'
            ? { color: `var(--task-tag-${symbol.color})` }
            : { color: 'var(--text-primary)' }
        }
      />
    );
  }
  const letters =
    parseProjectLetters(value) ??
    (!value || isProjectImage(value) || isProjectImageDraft(value)
      ? { text: defaultProjectLetters(projectName), color: defaultProjectColor(projectName) }
      : null);
  if (letters) {
    const white = letters.color === 'white';
    return (
      <span
        data-project-monogram
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[25%] ${white ? 'border border-[var(--border-default)] bg-[var(--task-tag-white)]' : '[--project-contrast:black] dark:[--project-contrast:white]'}`}
        style={{
          width: size,
          height: size,
          backgroundColor: white ? undefined : 'color-mix(in srgb, currentColor 14%, transparent)',
          color: white
            ? 'var(--task-tag-white-check)'
            : letters.color === 'default'
              ? 'var(--text-primary)'
              : `color-mix(in srgb, var(--task-tag-${letters.color}) 80%, var(--project-contrast))`,
        }}
        aria-hidden
      >
        <svg viewBox="0 0 16 16" className="size-full" focusable="false">
          <text
            x="8"
            y="8"
            dominantBaseline="central"
            textAnchor="middle"
            fill="currentColor"
            fontSize="8"
            fontWeight="600"
            textLength={Array.from(letters.text).length > 1 ? 11 : 6}
            lengthAdjust="spacingAndGlyphs"
          >
            {letters.text}
          </text>
        </svg>
      </span>
    );
  }
  if (value)
    return (
      <span
        className={`flex items-center justify-center ${size >= 32 ? 'text-28' : size >= 24 ? 'text-20' : 'text-15'}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        {value}
      </span>
    );
  return <Folder size={size} strokeWidth={1.6} color="var(--text-primary)" />;
}

// Shared by list and settings previews: one host request per account/device/project.
const automaticCache = new Map<
  string,
  { until: number; promise: Promise<AutomaticProjectIcon | null> }
>();
export function useAutomaticProjectIcon(
  projectKey: string,
  deviceId: string | null | undefined,
  enabled = true,
) {
  const owner = getDataOwnerGeneration();
  const identity = JSON.stringify([owner, deviceId, projectKey]);
  const [state, setState] = useState<{
    identity: string;
    result: AutomaticProjectIcon | null;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState({ identity, result: null, loading: true });
    let item = automaticCache.get(identity);
    if (!item || item.until < Date.now()) {
      if (automaticCache.size >= 256) automaticCache.clear();
      const promise = Promise.resolve()
        .then(() =>
          deviceId
            ? window.electronAPI.deviceLink.invoke(
                deviceId,
                PROJECT_AUTO_ICON_CHANNEL,
                [{ projectKey }],
                { background: true },
              )
            : window.electronAPI.localDb.projectAliases.autoIcon({ projectKey }),
        )
        .then(parseAutomaticProjectIcon)
        .catch(() => null);
      item = { until: Date.now() + 60_000, promise };
      automaticCache.set(identity, item);
    }
    void item.promise.then((result) => {
      if (live && isDataOwnerGenerationCurrent(owner))
        setState({ identity, result, loading: false });
    });
    return () => {
      live = false;
    };
  }, [identity, enabled]);
  return state?.identity === identity ? state : { result: null, loading: enabled };
}
