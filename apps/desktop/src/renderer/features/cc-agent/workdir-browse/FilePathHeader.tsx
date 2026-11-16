import { useTranslation } from 'react-i18next';
import { useFileContent } from './hooks/useFileContent';
import { basename, fileDisplayPath, hasCindyTemplateRule, isTemplateRulePath } from './lib/fileMeta';

/** Shared by the full file view and embedded browser, including loading/error states. */
export function FilePathHeader({ workdir, relPath, remoteHostId = null, deviceId = null }: {
  workdir: string;
  relPath: string;
  remoteHostId?: string | null;
  deviceId?: string | null;
}) {
  const { t } = useTranslation();
  // Only root rule candidates need provenance. Keep the real endpoint/workdir scope
  // stable: disabling this read must not evict the shared file-body cache.
  // Reuse the endpoint-scoped reader; never probe SSH/device-link paths locally.
  const { content: record } = useFileContent(
    workdir,
    isTemplateRulePath(relPath) ? '.cindy/template.json' : null,
    remoteHostId,
    deviceId,
  );
  const fromTemplate = record.kind === 'text' && !record.truncated
    && hasCindyTemplateRule(relPath, record.content);
  const path = fileDisplayPath(workdir, relPath);
  return (
    <header className="shrink-0 border-b border-[var(--border-default)] px-4 py-2 select-text" data-file-path-header>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="min-w-0 break-all text-13 font-medium text-[var(--text-primary)]">{basename(relPath)}</span>
        {fromTemplate && (
          <span className="text-12 text-[var(--text-secondary)]" title=".cindy/template.json" data-file-rule-source>
            {t('ccAgent.workdirBrowse.fileBody.templateRules')}
          </span>
        )}
      </div>
      <div className="break-all text-12 leading-normal text-[var(--text-secondary)]" title={path} data-file-display-path>{path}</div>
    </header>
  );
}
