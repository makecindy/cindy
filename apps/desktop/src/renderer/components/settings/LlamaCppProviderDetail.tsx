import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  validLlamaCppRepo,
  type LlamaCppDownloadInput,
  type LlamaCppFile,
  type LlamaCppSnapshot,
} from '../../../shared/llamaCpp';
import { DownloadMeter, formatDownloadBytes } from './DownloadMeter';
import {
  LlamaCppCandidates,
  sameLlamaCppDownload,
  type LlamaCppDownloadState,
} from './LlamaCppCandidates';
import {
  LocalDownloadActions,
  LocalModelCard,
  LocalModelDownloadButton,
  LocalModelManualDownload,
  LocalRuntimeInstallView,
  localModelInputClass,
  localModelInputStyle,
} from './LocalModelDownloadUI';

export function LlamaCppProviderDetail({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LlamaCppSnapshot>();
  const [repo, setRepo] = useState('');
  const [files, setFiles] = useState<LlamaCppFile[]>([]);
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState<'install' | 'start' | 'files' | 'download' | 'stop'>();
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<LlamaCppDownloadInput>();
  const [failed, setFailed] = useState<LlamaCppDownloadInput>();
  const alive = useRef(true);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const api = window.electronAPI.maker;
  const refresh = async () => {
    const current = ++revision.current;
    const next = await api.llamaCppStatus();
    if (alive.current && current === revision.current) setState(next);
  };
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        await refresh();
      } catch {
        if (!disposed) setError(true);
      }
      if (!disposed) timer = setTimeout(() => void read(), 1000);
    };
    void read();
    return () => {
      disposed = true;
      alive.current = false;
      revision.current++;
      clearTimeout(timer);
    };
  }, [api]);
  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setError(false);
    try {
      await fn();
      await refresh();
      if (alive.current) onChanged();
    } catch (cause) {
      const parsed = extractIpcError(cause);
      if (parsed?.message === 'OPERATION_CANCELLED') return;
      if (alive.current) {
        setError(true);
        toast.error(
          t(
            parsed?.code === 'INVALID_PARAMS'
              ? 'settings.providers.llamacpp.invalid'
              : 'settings.providers.llamacpp.failed',
          ),
        );
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(undefined);
    }
  };
  const download = (input: LlamaCppDownloadInput) => {
    if (inFlight.current) return;
    setPending(input);
    setFailed(undefined);
    void run('download', async () => {
      try {
        await api.llamaCppDownload(input);
        if (alive.current) toast.success(t('settings.providers.local.added'));
      } catch (cause) {
        if (alive.current && extractIpcError(cause)?.message !== 'OPERATION_CANCELLED')
          setFailed(input);
        throw cause;
      } finally {
        if (alive.current) setPending(undefined);
      }
    });
  };
  const controlDownload = (action: 'cancel' | 'pause' | 'resume') => {
    void api
      .llamaCppCancel(action)
      .then(refresh)
      .catch(() => setError(true));
  };
  const cancel = () => controlDownload('cancel');
  const operation = state?.operation;
  const activeInput = operation?.kind === 'download' ? (operation.model ?? pending) : pending;
  const currentDownload: LlamaCppDownloadState | undefined = activeInput
    ? {
        input: activeInput,
        progress: {
          label: t(
            operation?.paused
              ? 'settings.providers.local.pullPhase.paused'
              : operation?.total && operation.completed >= operation.total
                ? 'settings.providers.local.pullPhase.verifying'
                : 'settings.providers.local.pullPhase.downloading',
          ),
          completed: operation?.completed,
          total: operation?.total,
          bytesPerSecond: operation?.bytesPerSecond,
          paused: operation?.paused,
        },
      }
    : failed
      ? {
          input: failed,
          failed: true,
          progress: { label: t('settings.providers.llamacpp.failed'), error: true },
        }
      : undefined;
  const locked = !!busy || !!operation;
  const catalog = state?.catalog ?? [];
  const customDownload =
    currentDownload &&
    !catalog.some((entry) =>
      entry.variants.some((v) => sameLlamaCppDownload(v, currentDownload.input)),
    )
      ? currentDownload
      : undefined;
  const installing = busy === 'install' || operation?.kind === 'install';
  return (
    <div
      className="flex flex-col gap-6 border-t px-5 py-5"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      {error && !failed && (
        <p role="alert" className="text-12" style={{ color: 'var(--error-flat)' }}>
          {t('settings.providers.llamacpp.failed')}
        </p>
      )}
      {(!state?.installed || installing) && (
        <LocalRuntimeInstallView
          description={t(
            state?.supported === false
              ? 'settings.providers.llamacpp.unsupported'
              : 'settings.providers.llamacpp.installDescription',
          )}
          canInstall={state?.supported === true}
          installing={installing}
          progress={
            installing
              ? {
                  label: t(`settings.providers.llamacpp.progress.${operation?.kind ?? 'install'}`),
                  completed: operation?.completed,
                  total: operation?.total,
                }
              : undefined
          }
          onInstall={() => void run('install', () => api.llamaCppInstall())}
          onCancel={cancel}
        />
      )}
      <LlamaCppCandidates
        catalog={catalog}
        recommendation={state?.recommendation}
        models={state?.models ?? []}
        locked={locked || !state?.installed}
        onDownload={download}
        download={currentDownload}
        onCancel={cancel}
        onPause={state?.canPauseDownload ? () => controlDownload('pause') : undefined}
        onResume={state?.canPauseDownload ? () => controlDownload('resume') : undefined}
      />
      <LocalModelManualDownload
        id="llamacpp-manual-download"
        value={repo}
        onChange={(value) => {
          setRepo(value.trim());
          setFiles([]);
          setFile('');
        }}
        placeholder="owner/model-GGUF"
        disabled={locked || !state?.installed || !validLlamaCppRepo(repo)}
        buttonLabel={t('settings.providers.llamacpp.findFiles')}
        onSubmit={() =>
          void run('files', async () => {
            const found = await api.llamaCppFiles(repo);
            if (alive.current) {
              setFiles(found);
              setFile(found[0]?.name ?? '');
              if (!found.length) setError(true);
            }
          })
        }
      >
        {files.length > 0 && (
          <div className="flex gap-2">
            <select
              aria-label={t('settings.providers.llamacpp.file')}
              className={`${localModelInputClass} flex-1`}
              style={localModelInputStyle}
              value={file}
              disabled={locked}
              onChange={(event) => setFile(event.target.value)}
            >
              {files.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name} · {formatDownloadBytes(item.size)}
                </option>
              ))}
            </select>
            <LocalModelDownloadButton
              disabled={locked || !file}
              onClick={() => download({ repo, file })}
            />
          </div>
        )}
      </LocalModelManualDownload>
      {customDownload && (
        <LocalModelCard
          name={t('settings.providers.local.pullingTitle', { name: customDownload.input.file })}
          actions={
            customDownload.failed ? (
              <LocalModelDownloadButton
                failed
                disabled={locked}
                onClick={() => download(customDownload.input)}
              />
            ) : (
              <LocalDownloadActions
                active
                paused={customDownload.progress.paused}
                onCancel={cancel}
                onPause={state?.canPauseDownload ? () => controlDownload('pause') : undefined}
                onResume={state?.canPauseDownload ? () => controlDownload('resume') : undefined}
              />
            )
          }
          progress={<DownloadMeter progress={customDownload.progress} />}
        />
      )}
      {state?.running && state.canManageRuntime === true && (
        <details className="text-12" style={{ color: 'var(--text-secondary)' }}>
          <summary className="cursor-pointer">
            {t('settings.providers.llamacpp.manageRuntime')}
          </summary>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span>{state.version}</span>
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => void run('start', () => api.llamaCppStart())}
            >
              {t('settings.providers.llamacpp.restart')}
            </Button>
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => void run('stop', () => api.llamaCppStop())}
            >
              {t('settings.providers.llamacpp.stop')}
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}
