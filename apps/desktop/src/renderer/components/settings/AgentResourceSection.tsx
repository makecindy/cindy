/**
 * AgentResourceSection — Agent 资源占用设置(命令并发上限/进程优先级/工具链限核)。
 *
 * 三档预设(全速/均衡/后台)只是三个底层字段的组合快捷方式,不单独持久化档位名;
 * 字段与任何预设组合都不匹配时,预设条不高亮(= 自定义状态)。
 * 均衡档的并发值按本机核数派生,换机器后读出的旧值可能不再匹配预设 —— 属预期,
 * 显示为自定义即可,不做迁移。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';

type Wire = AgentResourceSettingsWire;
type SettingKey = 'maxConcurrentCommands' | 'processPriority' | 'capToolchainThreads';

type PresetId = 'full' | 'balanced' | 'background';

const PRIORITY_OPTIONS: AgentResourceProcessPriority[] = ['normal', 'low', 'lowest'];
const MAX_CONCURRENT_CAP = 64;

/**
 * 均衡档并发值:本机核数的一半,至少 2(与 main 侧 toolchain-thread-cap 的口径一致),
 * 且不超过 IPC 校验上限 —— 超高核数工作站(>128 核)算出的值若越过 cap,首个 IPC 写
 * 会被硬拒,预设应用直接失败(bot review P1)。
 */
function balancedConcurrency(): number {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 8;
  return Math.min(MAX_CONCURRENT_CAP, Math.max(2, Math.ceil(cores / 2)));
}

function presetValues(id: PresetId): Pick<Wire, SettingKey> {
  switch (id) {
    case 'full':
      return { maxConcurrentCommands: 0, processPriority: 'normal', capToolchainThreads: false };
    case 'balanced':
      return {
        maxConcurrentCommands: balancedConcurrency(),
        processPriority: 'low',
        capToolchainThreads: true,
      };
    case 'background':
      return { maxConcurrentCommands: 2, processPriority: 'lowest', capToolchainThreads: true };
  }
}

function matchPreset(s: Pick<Wire, SettingKey>): PresetId | null {
  for (const id of ['full', 'balanced', 'background'] as const) {
    const p = presetValues(id);
    if (
      s.maxConcurrentCommands === p.maxConcurrentCommands &&
      s.processPriority === p.processPriority &&
      s.capToolchainThreads === p.capToolchainThreads
    ) {
      return id;
    }
  }
  return null;
}

export function AgentResourceSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Wire | null>(null);
  // 预设三键写入的 in-flight 闸:防并发点击交错出"杂交档位"落盘。
  const [applyingPreset, setApplyingPreset] = useState(false);
  // 并发上限输入框的本地草稿:一切编辑中间态(清空、"10"删掉首位剩"0"等)都
  // 只进草稿,blur/Enter 才校验提交 —— 任何 onChange 即写盘的变体都会把中间值
  // 瞬态落成"0=不限"并放行排队命令(bot review 连续四轮触碰同一根因,改为
  // 提交制一次收口)。
  const [maxDraft, setMaxDraft] = useState<string | null>(null);
  // 写序号:每次以写类 IPC 响应落地 settings 时 +1。失败回读的 GET 是异步的,
  // 且发起后操作闸已解除 —— 期间用户的成功修改不能被迟到的旧 GET 快照覆盖,
  // 回读响应只在序号未前进时生效(bot review P1)。
  const writeSeqRef = useRef(0);

  const applyServerState = (next: Wire) => {
    writeSeqRef.current += 1;
    setSettings(next);
  };

  useEffect(() => {
    void window.electronAPI.maker
      .agentResourceSettingsGet()
      .then((s) => {
        if (s && typeof s.maxConcurrentCommands === 'number') setSettings(s);
      })
      .catch(() => {
        // 读失败时按默认态渲染,写路径仍可用(main 侧会兜底校验)
        setSettings({
          maxConcurrentCommands: 0,
          processPriority: 'normal',
          capToolchainThreads: false,
          isCustomized: false,
          customizedKeys: [],
          defaults: {
            maxConcurrentCommands: 0,
            processPriority: 'normal',
            capToolchainThreads: false,
          },
        });
      });
  }, []);

  const activePreset = useMemo(() => (settings ? matchPreset(settings) : null), [settings]);

  /**
   * 写失败后从 main 重新拉权威状态,替换乐观值 —— UI 与磁盘不留分叉。
   * 迟到守卫:发起后若有新的写响应落地(写序号前进),本次回读结果作废,
   * 不覆盖用户随后的成功修改。
   */
  const refetchAuthoritative = () => {
    const seqAtIssue = writeSeqRef.current;
    void window.electronAPI.maker
      .agentResourceSettingsGet()
      .then((s) => {
        if (writeSeqRef.current === seqAtIssue) setSettings(s);
      })
      .catch(() => {});
  };

  const persist = (key: SettingKey, value: number | string | boolean) => {
    if (applyingPreset) return; // 预设三键序列在途时所有控件已禁用,这里兜底防交错
    setSettings((prev) => (prev ? { ...prev, [key]: value, isCustomized: true } : prev));
    void window.electronAPI.maker
      .agentResourceSettingsSet(key, value)
      .then((next) => applyServerState(next))
      .catch(() => {
        // IPC 错误统一显示本地化文案,不透出原始异常(可能含内部路径)
        toast.error(t('settings.agentResource.saveFailed'));
        refetchAuthoritative();
      });
  };

  const applyPreset = async (id: PresetId) => {
    if (applyingPreset) return; // 三键序列非原子,靠 in-flight 闸禁止交错
    setApplyingPreset(true);
    setMaxDraft(null); // 预设接管并发值,废弃输入框草稿
    const values = presetValues(id);
    setSettings((prev) => (prev ? { ...prev, ...values } : prev));
    try {
      await window.electronAPI.maker.agentResourceSettingsSet(
        'maxConcurrentCommands',
        values.maxConcurrentCommands,
      );
      await window.electronAPI.maker.agentResourceSettingsSet(
        'processPriority',
        values.processPriority,
      );
      const next = await window.electronAPI.maker.agentResourceSettingsSet(
        'capToolchainThreads',
        values.capToolchainThreads,
      );
      applyServerState(next);
    } catch {
      // 中途失败 = 只落了部分字段;拉回权威状态,不让乐观值假装写成功了
      toast.error(t('settings.agentResource.saveFailed'));
      refetchAuthoritative();
    } finally {
      setApplyingPreset(false);
    }
  };

  // 取数时序契约(engineering-conventions §7):本地 IPC 数据毫秒级到达,获取期间
  // 界面不发生变化、不做 loading 态 —— 瞬时占位行会在数据到达时被更高的控件顶开,
  // 造成后续 section 可见位移。
  if (!settings) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.agentResource.title')}
        </h2>
        <DefaultOverrideControls
          isCustomized={Boolean(settings.isCustomized)}
          disabled={applyingPreset}
          onReset={() => {
            if (applyingPreset) return;
            void window.electronAPI.maker
              .agentResourceSettingsReset()
              .then((next) => {
                applyServerState(next);
                toast.success(t('settings.defaults.restored'));
              })
              .catch(() => {
                toast.error(t('settings.defaults.restoreFailed'));
              });
          }}
        />
      </div>

      <p className="text-11 leading-relaxed text-[var(--text-tertiary)]">
        {t('settings.agentResource.description')}
      </p>

      {/* 预设条:三个字段的组合快捷方式;都不匹配 = 自定义,均不高亮 */}
      <div className="flex flex-col gap-1.5">
        <span className="text-12 font-medium text-[var(--text-primary)]">
          {t('settings.agentResource.preset')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('settings.agentResource.preset')}
          className="flex w-fit shrink-0 items-center gap-0.5 rounded-full border border-[var(--settings-theme-card-border)] p-0.5"
        >
          {(['full', 'balanced', 'background'] as const).map((id) => {
            const active = activePreset === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={applyingPreset}
                onClick={() => void applyPreset(id)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'bg-[var(--chat-input-chip-bg)] font-medium text-[var(--msg-assistant-text)]'
                    : 'text-[var(--settings-section-sublabel)] hover:bg-sidebar-item-hover',
                  applyingPreset && 'opacity-60',
                )}
              >
                {t(`settings.agentResource.presets.${id}`)}
              </button>
            );
          })}
        </div>
        <span className="text-11 text-[var(--text-tertiary)]">
          {activePreset
            ? t(`settings.agentResource.presetHints.${activePreset}`)
            : t('settings.agentResource.presetHints.custom')}
        </span>
      </div>

      {/* 并发命令上限 */}
      <label className="flex flex-col gap-1.5">
        <span className="text-12 font-medium text-[var(--text-primary)]">
          {t('settings.agentResource.maxConcurrent')}
        </span>
        <span className="text-11 text-[var(--text-tertiary)]">
          {t('settings.agentResource.maxConcurrentHint')}
        </span>
        <input
          type="number"
          min={0}
          max={MAX_CONCURRENT_CAP}
          disabled={applyingPreset}
          value={maxDraft ?? String(settings.maxConcurrentCommands)}
          onChange={(e) => setMaxDraft(e.target.value)}
          onBlur={() => {
            // 唯一提交点(DESIGN §14.3:Settings 单行编辑器 Enter 不得提交):
            // 仅 0..64 的整数且与当前值不同才写盘;非法/未变草稿作废,
            // 回显权威值(clamp 会绕过 main 侧硬拒语义,一律拒绝不改写)
            const text = (maxDraft ?? '').trim();
            setMaxDraft(null);
            if (!/^\d+$/.test(text)) return;
            const raw = Number(text);
            if (raw > MAX_CONCURRENT_CAP) return;
            if (raw === settings.maxConcurrentCommands) return;
            persist('maxConcurrentCommands', raw);
          }}
          className="mt-0.5 w-24 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-13 text-[var(--settings-input-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
        />
      </label>

      {/* 进程优先级 */}
      <div className="flex flex-col gap-1.5">
        <span className="text-12 font-medium text-[var(--text-primary)]">
          {t('settings.agentResource.priority')}
        </span>
        <span className="text-11 text-[var(--text-tertiary)]">
          {t('settings.agentResource.priorityHint')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('settings.agentResource.priority')}
          className="mt-0.5 flex w-fit shrink-0 items-center gap-0.5 rounded-full border border-[var(--settings-theme-card-border)] p-0.5"
        >
          {PRIORITY_OPTIONS.map((tier) => {
            const active = settings.processPriority === tier;
            return (
              <button
                key={tier}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={applyingPreset}
                onClick={() => persist('processPriority', tier)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'bg-[var(--chat-input-chip-bg)] font-medium text-[var(--msg-assistant-text)]'
                    : 'text-[var(--settings-section-sublabel)] hover:bg-sidebar-item-hover',
                )}
              >
                {t(`settings.agentResource.priorityOptions.${tier}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* 工具链限核 */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-12 font-medium text-[var(--text-primary)]">
            {t('settings.agentResource.capThreads')}
          </span>
          <span className="text-11 text-[var(--text-tertiary)]">
            {t('settings.agentResource.capThreadsHint')}
          </span>
        </div>
        <Switch
          checked={settings.capToolchainThreads}
          disabled={applyingPreset}
          onCheckedChange={(next) => persist('capToolchainThreads', next)}
          aria-label={t('settings.agentResource.capThreads')}
        />
      </div>
    </div>
  );
}
