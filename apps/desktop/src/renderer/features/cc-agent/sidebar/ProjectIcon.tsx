import {
  PROJECT_AUTO_ICON_CHANNEL,
  parseAutomaticProjectIcon,
  type AutomaticProjectIcon,
} from '@cindy/maker-shared/project-alias-sync';
import { isDeviceUnresponsiveRemoteError, isTransientRemoteError } from '@cindy/maker-shared/device-link-contract';
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
  const imageIdentity = JSON.stringify([
    getDataOwnerGeneration(),
    deviceId ?? null,
    projectKey,
    value,
  ]);
  const [loaded, setLoaded] = useState<{ identity: string; data: string } | null>(null);
  useEffect(() => {
    if (!isProjectImage(value)) return;
    let active = true;
    const owner = getDataOwnerGeneration();
    const read = sharedIconRequest(imageIdentity, () =>
      Promise.resolve(
        deviceId
          ? window.electronAPI.deviceLink.invoke(
              deviceId,
              PROJECT_ICON_IMAGE_CHANNEL,
              [{ projectKey }],
              { background: true },
            )
          : window.electronAPI.localDb.projectAliases.iconImage({ projectKey }),
      ).then((data) => (typeof data === 'string' ? data : null)),
    );
    void read.promise
      .then((data) => {
        if (active && isDataOwnerGenerationCurrent(owner))
          setLoaded(typeof data === 'string' ? { identity: imageIdentity, data } : null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [imageIdentity]);
  const cachedImage = iconCache.get(imageIdentity)?.value;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source =
    value === null && !automatic.result?.candidate
      ? automatic.result?.image
      : isProjectImageDraft(value)
        ? value
        : loaded?.identity === imageIdentity
          ? loaded.data
          : typeof cachedImage === 'string' ? cachedImage : null;
  if (source && source !== failedSource)
    return (
      <img
        src={source}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-[25%] object-cover"
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
        <svg viewBox="0 0 32 32" className="size-full" focusable="false">
          <text
            x="16"
            y="16"
            dominantBaseline="central"
            textAnchor="middle"
            fill="currentColor"
            fontSize="16"
            fontWeight="600"
            textLength={Array.from(letters.text).length > 1 ? 22 : 12}
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
type IconValue = AutomaticProjectIcon | string | null;
interface IconEntry {
  until: number;
  value?: IconValue;
  promise: Promise<IconValue>;
}
const iconCache = new Map<string, IconEntry>();
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
    const item = sharedIconRequest(identity, () =>
      Promise.resolve(
        deviceId
          ? window.electronAPI.deviceLink.invoke(
              deviceId,
              PROJECT_AUTO_ICON_CHANNEL,
              [{ projectKey }],
              { background: true },
            )
          : window.electronAPI.localDb.projectAliases.autoIcon({ projectKey }),
      ).then(parseAutomaticProjectIcon),
    );
    void item.promise.then((result) => {
      if (live && isDataOwnerGenerationCurrent(owner))
        setState({ identity, result: typeof result === 'string' ? null : result, loading: false });
    });
    return () => {
      live = false;
    };
  }, [identity, enabled]);
  const cached = enabled ? iconCache.get(identity)?.value : undefined;
  if (enabled && state?.identity === identity) return state;
  return { result: cached && typeof cached !== 'string' ? cached : null, loading: enabled && cached === undefined };
}

function sharedIconRequest(
  identity: string,
  read: () => Promise<AutomaticProjectIcon | string | null>,
) {
  let item = iconCache.get(identity);
  if (!item || item.until < Date.now()) {
    const previous = item?.value;
    if (!item && iconCache.size >= 256) {
      const oldest = iconCache.keys().next();
      if (!oldest.done) iconCache.delete(oldest.value);
    }
    const entry: IconEntry = {
      until: Infinity,
      value: previous,
      promise: Promise.resolve().then(read).then(value => {
        entry.value = value;
        return value;
      }).catch((error: unknown) => {
        entry.value = isTransientRemoteError(error) || isDeviceUnresponsiveRemoteError(error)
          ? previous : null;
        return entry.value ?? null;
      }).finally(() => {
        entry.until = Date.now() + 60_000;
      }),
    };
    iconCache.set(identity, entry);
    return entry;
  }
  return item;
}
