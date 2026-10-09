/**
 * 另一台电脑上的供应商(自己其他电脑的远程供应商、别人分享给我的供应商)在设置右栏里的
 * 只读模型清单：开关与排序都由那台电脑决定，这里只列出它开放的模型。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { AgentKind, ProviderView } from '@cindy/model-providers';

import { isDeviceModelVisible } from '@/lib/providerModels';

export interface ReadOnlyProviderModel {
  id: string;
  name: string;
}

const AGENT_ORDER: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/** 那台电脑上这个供应商开放的模型：去掉停用与隐藏的，按 Agent 顺序去重。 */
export function readOnlyProviderModels(
  provider: ProviderView | null,
  overrides: Record<string, boolean> | undefined,
): ReadOnlyProviderModel[] {
  if (!provider) return [];
  const seen = new Set<string>();
  const rows: ReadOnlyProviderModel[] = [];
  for (const agent of AGENT_ORDER) {
    for (const model of provider.models[agent] ?? []) {
      if (model.disabled || seen.has(model.id)) continue;
      if (!isDeviceModelVisible(overrides, agent, provider.id, model)) continue;
      seen.add(model.id);
      rows.push({ id: model.id, name: model.name || model.id });
    }
  }
  return rows;
}

/** 「可用的模型」一节；note 非空时以一句说明代替清单(读取中、读不到、暂停等)，action 跟在说明下面。 */
export function ReadOnlyProviderModelSection({
  title,
  models,
  note,
  action,
  testId,
}: {
  title: string;
  models: readonly ReadOnlyProviderModel[];
  note: string | null;
  action?: ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-t"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <div className="flex shrink-0 items-baseline gap-2 px-5 pb-2 pt-3">
        <span className="text-13 font-medium" style={{ color: 'var(--settings-section-title)' }}>
          {title}
        </span>
        {note === null && (
          <span className="text-12 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.models.modelCount', { count: models.length })}
          </span>
        )}
      </div>
      {note !== null ? (
        <div className="flex flex-col items-start gap-2 px-5 pb-4">
          <p className="text-13 leading-[1.5]" style={{ color: 'var(--text-tertiary)' }}>
            {note}
          </p>
          {action}
        </div>
      ) : (
        <ul data-testid={testId} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {models.map((model) => (
            <li
              key={model.id}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-13"
              style={{ color: 'var(--text-primary)' }}
            >
              <span className="min-w-0 flex-1 truncate">{model.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
