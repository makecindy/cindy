import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Folder, X } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import { observeFileTransferProgress } from '@/lib/fileTransferProgress';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { PendingFolder } from '@/hooks/useAttachments';
import type { AttachedFile } from '@/lib/fileTypes';
import { CHAT_FOLDER_MIME } from '../../../shared/chatFolderAttachment';
import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';

interface Transfer {
  id: string;
  source: string;
  name: string;
  message: string;
  failed: boolean;
  cancelled: boolean;
  cancel(): void;
  done: Promise<boolean>;
}

export function useComposerFolderTransfers(options: {
  scope: string;
  deviceId?: string | null;
  remoteHostId?: string | null;
  insert(path: string, name: string): void;
  attach(file: AttachedFile): void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Transfer[]>([]);
  const jobs = useRef(new Map<string, Transfer>());
  const ownerScope = getDataOwnerGeneration();
  const current = useRef(options);
  current.current = options;
  const refresh = useCallback(() => setRows([...jobs.current.values()]), []);
  const cancelAll = useCallback(() => {
    for (const job of jobs.current.values()) job.cancel();
    jobs.current.clear();
    setRows([]);
  }, []);
  useLayoutEffect(
    () => cancelAll,
    [options.scope, ownerScope.dataOwnerId, ownerScope.generation, cancelAll],
  );

  const add = useCallback(
    (pending: PendingFolder) => {
      const target = current.current;
      const source = typeof pending === 'string' ? pending : pending.path;
      const name = source.split(/[\\/]/).filter(Boolean).at(-1) ?? source;
      if (
        (typeof pending !== 'string' && pending.source === 'task') ||
        (!target.deviceId && !target.remoteHostId)
      ) {
        target.insert(source, name);
        return;
      }
      // Dropping the same folder again retries its failed copy without leaving
      // an old rejection blocking Send.
      for (const previous of jobs.current.values()) {
        if (previous.source !== source) continue;
        if (!previous.failed) return;
        previous.cancel();
        jobs.current.delete(previous.id);
      }
      const owner = getDataOwnerGeneration();
      const isCurrent = () =>
        current.current.scope === target.scope && isDataOwnerGenerationCurrent(owner);
      let resolveCancellation!: (value: boolean) => void;
      const cancellation = new Promise<boolean>((resolve) => {
        resolveCancellation = resolve;
      });
      const progress = observeFileTransferProgress((event) => {
        // This card covers local preparation only. Sending the resulting archive
        // uses the ordinary attachment upload.
        if (!isCurrent() || job.cancelled || event.phase !== 'pack') return;
        job.message = t('chat.remoteFile.folderPacking', { size: formatBytes(event.received) });
        refresh();
      });
      const job: Transfer = {
        id: progress.requestId,
        source,
        name,
        message: t('chat.remoteFile.folderPreparing'),
        failed: false,
        cancelled: false,
        done: Promise.resolve(false),
        cancel() {
          job.cancelled = true;
          resolveCancellation(false);
          progress.dispose();
          void window.electronAPI.fileBrowser.chatCancel(job.id).catch(() => {});
        },
      };
      jobs.current.set(job.id, job);
      refresh();
      job.done = Promise.race([
        cancellation,
        (async () => {
          try {
            if (!target.deviceId || target.remoteHostId || isSharedTaskPeer(target.deviceId))
              throw new Error('CONNECTION_UNSUPPORTED');
            if (typeof pending === 'string' || pending.source !== 'local')
              throw new Error('TRANSFER_FAILED');
            const result = await window.electronAPI.fileBrowser.uploadChatFolder({
              deviceId: target.deviceId,
              file: pending.file,
              requestId: job.id,
            });
            if (job.cancelled || !isCurrent()) {
              if (result.ok) cleanupStagedChatAttachmentFiles([{ path: result.path }]);
              return false;
            }
            if (!result.ok) throw new Error(result.code);
            target.attach({
              id: job.id,
              name,
              originalName: name,
              path: result.path,
              size: result.size,
              category: 'file',
              ext: '',
              mimeType: CHAT_FOLDER_MIME,
            });
            jobs.current.delete(job.id);
            refresh();
            return true;
          } catch (error) {
            if (job.cancelled || !isCurrent()) return false;
            job.failed = true;
            job.message = t(
              String(error).includes('CONNECTION_UNSUPPORTED')
                ? 'chat.remoteFile.folderConnectionUnsupported'
                : String(error).includes('REMOTE_UNSUPPORTED')
                  ? 'chat.remoteFile.folderUnsupported'
                  : 'chat.remoteFile.folderFailed',
            );
            refresh();
            return false;
          } finally {
            progress.dispose();
          }
        })(),
      ]);
    },
    [refresh, t],
  );

  const remove = useCallback(
    (id: string) => {
      jobs.current.get(id)?.cancel();
      jobs.current.delete(id);
      refresh();
    },
    [refresh],
  );
  const wait = useCallback(async () => {
    const scope = current.current.scope;
    const owner = getDataOwnerGeneration();
    while (current.current.scope === scope && isDataOwnerGenerationCurrent(owner)) {
      const pending = [...jobs.current.values()];
      if (!pending.length) return true;
      const results = await Promise.all(pending.map((job) => job.done));
      if (!results.every(Boolean)) return false;
      // Outer chat drop zones can enqueue another folder while Send is waiting.
      // Drain those jobs too before allowing the editor snapshot to be sent.
    }
    return false;
  }, []);
  return { rows, add, remove, wait, hasPending: rows.length > 0 };
}

export function ComposerFolderTransfers({
  rows,
  onRemove,
}: {
  rows: Transfer[];
  onRemove(id: string): void;
}) {
  const { t } = useTranslation();
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1 pb-2" aria-live="polite">
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
        >
          {row.failed ? <Folder className="h-4 w-4 shrink-0" /> : <Spinner size={16} />}
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-12"
              title={row.name}
              style={{ color: 'var(--text-primary)' }}
            >
              {row.name}
            </div>
            <div className="text-11">{row.message}</div>
          </div>
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
            aria-label={t('chat.remoteFile.cancelFolderPreparation')}
            onClick={() => onRemove(row.id)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
