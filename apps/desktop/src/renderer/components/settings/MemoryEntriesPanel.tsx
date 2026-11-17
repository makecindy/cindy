/**
 * MemoryEntriesPanel — 设置 › 个性化 › 记忆 里的「查看记忆」子页（Cindy 记忆，普通任务用的那一套）。
 *
 * Cindy 记忆分范围存放：「关于你」一份（账号级，每个项目都生效），每个项目一份。这里先选范围，
 * 再用与伙伴记忆页相同的列表 / 详情 / 编辑（`MemoryEntriesView`）查看、搜索、修改、删除。
 * 总开关关闭时已存的记忆仍可查看和删除。运行中的任务在启动时冻结了记忆目录，这里的改动
 * 不通知它们。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MemoryEntriesView,
  type MemoryEntriesSource,
  type MemoryEntriesTexts,
} from '@/components/memory/MemoryEntriesView';
import { Button } from '@/components/ui/button';
import { Select, type SelectOption } from '@/components/ui/select';
import { SettingsPageHeader, SettingsPageScope } from '@/components/ui/settings-rows';
import { useMemorySettings } from '@/hooks/useMemorySettings';
import { extractIpcError } from '@/utils/ipcError';
import type {
  MakerMemoryScopeSummary,
  MakerMemoryTaskLocation,
} from '../../../shared/makerMemoryEntries';

const api = () => window.electronAPI.maker.memoryEntries;

/** 项目范围的第二行文字：路径；SSH 项目前面带主机。 */
const scopeLocation = (scope: MakerMemoryScopeSummary) =>
  scope.host ? `${scope.host} · ${scope.path ?? ''}` : (scope.path ?? '');

export function MemoryEntriesPanel({
  initialTask,
  onBack,
  backRef,
  leaveRef,
}: {
  /**
   * 从保存回执点开时：写入记忆的那个任务在哪里。打开时先选中它的项目那一份；
   * 没有、或那个项目还没有记忆时落在第一项「关于你」。
   */
  initialTask?: MakerMemoryTaskLocation | null;
  /** 返回键：先在页内回退，已在列表时回到「个性化」。 */
  onBack: () => void;
  backRef: MutableRefObject<(() => Promise<boolean>) | null>;
  leaveRef: MutableRefObject<(() => Promise<boolean>) | null>;
}) {
  const { t } = useTranslation();
  const { makerEnabled } = useMemorySettings();
  const [scopes, setScopes] = useState<MakerMemoryScopeSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const selectedRef = useRef(scopeKey);
  selectedRef.current = scopeKey;
  // 只在第一次读取范围时带上任务位置：之后的刷新不必再解析它的项目。
  const taskRef = useRef(initialTask ?? null);

  const loadScopes = useCallback(async () => {
    try {
      const { scopes: next, taskScopeKey } = await api().scopes(taskRef.current ?? undefined);
      taskRef.current = null;
      setScopes((previous) => {
        // 删掉项目里最后一条记忆后，主机不再列出该项目；这里把它留着（0 条），页面不跳走。
        const kept = previous?.find((scope) => scope.scopeKey === selectedRef.current);
        return kept && !next.some((scope) => scope.scopeKey === kept.scopeKey)
          ? [...next, { ...kept, count: 0 }]
          : next;
      });
      setScopeKey((current) => current ?? taskScopeKey ?? next[0]?.scopeKey ?? null);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void loadScopes();
  }, [loadScopes]);

  const selected = scopes?.find((scope) => scope.scopeKey === scopeKey) ?? null;
  const scopeName = useCallback(
    (scope: MakerMemoryScopeSummary) =>
      scope.kind === 'user' ? t('settings.memory.entries.userScope') : (scope.name ?? scope.scopeKey),
    [t],
  );

  const source = useMemo<MemoryEntriesSource | null>(
    () =>
      scopeKey
        ? {
            key: scopeKey,
            list: async (query) => {
              try {
                return await api().list(scopeKey, query);
              } catch (error) {
                // 这个范围已经没有记忆（刚删完）：按空列表显示。
                if (extractIpcError(error)?.code === 'NOT_FOUND') return [];
                throw error;
              }
            },
            read: (filename) => api().read(scopeKey, filename),
            update: (input) => api().update({ scopeKey, ...input }),
            delete: (input) => api().delete({ scopeKey, ...input }),
          }
        : null,
    [scopeKey],
  );
  const texts = useMemo<MemoryEntriesTexts>(
    () => ({
      deleteDescription: (title) => t('settings.memory.entries.deleteConfirm', { title }),
      changed: t('settings.memory.entries.changed'),
    }),
    [t],
  );
  const options = useMemo<SelectOption[]>(
    () =>
      (scopes ?? []).map((scope) => ({
        value: scope.scopeKey,
        label: scopeName(scope),
        title: scope.kind === 'user' ? undefined : scopeLocation(scope),
        endAdornment: (
          <>
            {scope.kind === 'project' ? (
              <span className="max-w-[320px] truncate text-12 text-[var(--text-tertiary)]">
                {scopeLocation(scope)}
              </span>
            ) : null}
            <span className="min-w-4 text-right text-12 tabular-nums text-[var(--text-tertiary)]">
              {scope.count}
            </span>
          </>
        ),
      })),
    [scopeName, scopes],
  );

  return (
    <SettingsPageScope>
      <section
        className="flex min-w-0 max-w-[720px] flex-col"
        aria-label={t('settings.memory.entries.title')}
      >
        <SettingsPageHeader
          title={t('settings.memory.entries.title')}
          description={t('settings.memory.entries.description')}
          onBack={onBack}
          backLabel={t('settings.back')}
          backProps={{ 'data-settings-search-action': 'Return from the saved memories subpage' }}
        />
        <div className="mt-6 min-w-0">
          {failed && !scopes ? (
            <div
              className="flex flex-col items-center gap-3 py-10 text-13 text-[var(--text-secondary)]"
              role="alert"
            >
              {t('bots.memory.loadFailed')}
              <Button
                data-settings-search-action="Retry loading the saved memories"
                variant="secondary"
                size="md"
                onClick={() => void loadScopes()}
              >
                {t('commonUi.retry')}
              </Button>
            </div>
          ) : source && selected ? (
            <MemoryEntriesView
              source={source}
              texts={texts}
              dimmed={!makerEnabled}
              onDeleted={() => void loadScopes()}
              backRef={backRef}
              leaveRef={leaveRef}
              listHeader={
                <>
                  {!makerEnabled ? (
                    <p
                      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-12 leading-[1.5] text-[var(--text-secondary)]"
                      role="status"
                    >
                      {t('settings.memory.entries.disabledNotice')}
                    </p>
                  ) : null}
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Select
                      data-settings-search-action="Choose which saved memories to show"
                      label={t('settings.memory.entries.scope')}
                      value={selected.scopeKey}
                      options={options}
                      onValueChange={setScopeKey}
                      truncateOptions
                      width="full"
                      triggerAdornment={
                        <span className="text-12 tabular-nums text-[var(--text-tertiary)]">
                          {selected.count}
                        </span>
                      }
                    />
                    <p
                      className="truncate px-1 text-12 leading-[1.5] text-[var(--text-secondary)]"
                      title={selected.kind === 'project' ? scopeLocation(selected) : undefined}
                    >
                      {selected.kind === 'user'
                        ? t('settings.memory.entries.userScopeNote')
                        : scopeLocation(selected)}
                    </p>
                  </div>
                </>
              }
            />
          ) : null}
        </div>
      </section>
    </SettingsPageScope>
  );
}
