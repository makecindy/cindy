/**
 * CustomProviderDialog —— 自定义供应商「新建 / 编辑」表单弹窗（按 .pen pQrpu/Fxstc 还原）。
 *
 * 结构：顶部「显示名称」(供应商身份,跨 runtime 共享) + Runtime 分段 Tab(Claude Code / Codex)。
 * **每个 Tab 是独立配置**：基础 URL / API 密钥 / 模型 / 请求头 都属于当前 Tab 的那个 runtime。
 * 只配需要的那个,也可两个都配(该来源同时供两端)。至少配一个 Tab。
 *
 * 「提供商 ID」内部句柄由显示名自动 slug 派生 + 去重,对用户隐藏(密钥名/文件名不能含 . 或 /)。
 * 配置经 maker IPC 入 localDb；密钥按 runtime 经 safeStorage 存(见 lib/customProviders)。
 * 编辑态回填已存密钥(默认遮罩,eye 可显形核对)、留空 = 不改；id 不可改。颜色全走主题 token。
 *
 * 本弹窗的输入统一传 `surface="ivory"`：面板是白色(`--surface-elevated`),ivory 底给出 fill
 * 抬升,这是收敛进 SettingsTextInput 之前就有的底色,原样保留。共享组件的默认底色是
 * DESIGN.md §4 规定的 `--surface-elevated`(压在 ivory settings 卡上的输入必须用它)。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Plug, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import { extractIpcError } from '@/utils/ipcError';
import {
  createCustomProvider,
  readCustomProviderKey,
  replaceCustomProviderModelId,
  setCustomProviderModelReasoning,
  setCustomProviderModelReasoningEffort,
  setCustomProviderModelSupportsImageInput,
  updateCustomProvider,
  type RuntimeKeys,
} from '@/lib/customProviders';
import { uniqueCustomProviderId } from '@/lib/customProviderId';
import {
  areProviderRequestUrlsAllowed,
  connectionTestCanUseSaved,
  modelFetchCanReuseSavedCredentials,
  providerConnectionTestRequestSignature,
  providerModelFetchRequestSignature,
  stripCredentialHeaders,
  type CustomProviderAuthMode,
  type SavedProviderProbeBaseline,
} from '@/lib/providerModelFetch';
import {
  CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS,
  customProviderCodexWireProtocolOption,
} from '@/lib/customProviderWireProtocols';

import {
  isProviderRequestPath,
  PI_REASONING_EFFORTS,
  presetDisplayName,
  sortPresetsForRegion,
} from '@cindy/model-providers';
import type {
  AgentKind,
  CustomProviderConfig,
  ProviderPreset,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
} from '@cindy/model-providers';
import { SettingsTextInput } from './SettingsTextInput';
import { CURRENT_CINDY_REGION } from '@/../shared/brandRegion';

/**
 * 本面板配置 claude / codex / pi 三个 runtime。pi 是多协议 harness:BYOM 自定义/本地模型
 * 走 pi 原生 provider 直连(不过 anthropic-compat 代理),故 pi tab 额外提供显式 api 选择器。
 */
type DialogAgentKind = Extract<AgentKind, 'claude-code' | 'codex' | 'pi'>;

const AGENTS: DialogAgentKind[] = ['claude-code', 'codex', 'pi'];

const VISIBLE_AGENTS: DialogAgentKind[] = AGENTS;

const TAB_META: Record<DialogAgentKind, { Mark: typeof ClaudeMark; labelKey: string; helpKey: string }> =
  {
    'claude-code': {
      Mark: ClaudeMark,
      labelKey: 'settings.providers.custom.protocol.claude',
      helpKey: 'settings.providers.custom.protocol.claudeDesc',
    },
    codex: {
      Mark: CodexMark,
      labelKey: 'settings.providers.custom.protocol.codex',
      helpKey: 'settings.providers.custom.protocol.codexDesc',
    },
    pi: {
      Mark: PiMark,
      labelKey: 'settings.providers.custom.protocol.pi',
      helpKey: 'settings.providers.custom.protocol.piDesc',
    },
  };

/** pi 默认 wire protocol:BYOM 本地端点(Ollama/vLLM 的 /v1/chat/completions)最常见。 */
const PI_DEFAULT_WIRE: ProviderWireProtocol = 'openai-chat';

/** 某 agent runtime 的默认 wire protocol。 */
function defaultWireFor(agent: DialogAgentKind): ProviderWireProtocol {
  if (agent === 'claude-code') return 'anthropic-messages';
  if (agent === 'pi') return PI_DEFAULT_WIRE;
  return 'openai-responses';
}

interface CustomProviderDialogProps {
  initial?: CustomProviderConfig;
  /** 已占用的全部 provider id（内置 anthropic/openai/xd + 全部自定义）；新建时自动生成 id 时避让，防撞内置保留 id。 */
  existingIds?: string[];
  onSaved: () => void;
  onClose: () => void;
}

type ModelRow = ProviderRuntimeModelConfig;
interface ModelPickerState {
  agent: DialogAgentKind;
  models: ModelRow[];
  selected: Set<string>;
  query: string;
}
type DialogChildLayer =
  { kind: 'preset-menu' } | { kind: 'model-picker'; value: ModelPickerState } | null;
interface HeaderRow {
  name: string;
  value: string;
}
interface RuntimeFields {
  baseUrl: string;
  requestPath: string;
  apiKey: string;
  wireProtocol: ProviderWireProtocol;
  models: ModelRow[];
  headers: HeaderRow[];
  /** 隐藏字段：列模型端点（预设 / 已存配置快照进来），「获取模型列表」用；不在表单展示。 */
  modelsUrl: string;
}

/** 每个 runtime Tab 的「测试连接」状态（idle → testing → ok/fail）。 */
interface TestState {
  status: 'idle' | 'testing' | 'ok' | 'fail';
  /** 失败分类码（providerError.<code> i18n 键）。 */
  code?: string;
  latencyMs?: number;
}
const IDLE_TEST: TestState = { status: 'idle' };

function emptyRuntime(agent: DialogAgentKind): RuntimeFields {
  return {
    baseUrl: '',
    requestPath: '',
    apiKey: '',
    wireProtocol: defaultWireFor(agent),
    models: [{ id: '', name: '' }],
    headers: [{ name: '', value: '' }],
    modelsUrl: '',
  };
}

function initRuntimes(initial?: CustomProviderConfig): Record<DialogAgentKind, RuntimeFields> {
  const out: Record<DialogAgentKind, RuntimeFields> = {
    'claude-code': emptyRuntime('claude-code'),
    codex: emptyRuntime('codex'),
    pi: emptyRuntime('pi'),
  };
  if (initial) {
    for (const a of AGENTS) {
      const rc = initial.runtimes[a];
      if (!rc) continue;
      out[a] = {
        baseUrl: rc.baseUrl,
        requestPath: rc.requestPath ?? '',
        apiKey: '',
        wireProtocol: rc.wireProtocol ?? defaultWireFor(a),
        models: rc.models.length ? rc.models.map((m) => ({ ...m })) : [{ id: '', name: '' }],
        headers:
          rc.headers && Object.keys(rc.headers).length > 0
            ? Object.entries(rc.headers).map(([n, v]) => ({ name: n, value: v }))
            : [{ name: '', value: '' }],
        modelsUrl: rc.modelsUrl ?? '',
      };
    }
  }
  return out;
}

// ── 小组件 ──────────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-13 font-medium text-[var(--settings-section-title)]">{children}</span>
  );
}

/** 上下文窗口文本是否可提交:空 = 清除窗口;非空须整体合法(分组分隔符 + BigInt 上界)。 */
function isCommittableWindowText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  if (!/^[0-9]+(?:[,_ ][0-9]+)*$/.test(trimmed)) return false;
  const parsed = BigInt(trimmed.replace(/[,_ ]/g, ''));
  return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
}

/**
 * 预设模板下拉——统一的 Popover 菜单(与外观设置 FamilyDropdown 同款样式)。
 * 不用原生 <select>:其展开菜单由系统绘制,不吃主题 token,视觉与应用内其它下拉不一致。
 */
function PresetDropdown({
  presets,
  appliedPreset,
  onApply,
  label,
  placeholder,
  locale,
  open,
  onOpenChange,
}: {
  presets: ProviderPreset[];
  appliedPreset: string | null;
  onApply: (p: ProviderPreset) => void;
  label: string;
  placeholder: string;
  locale: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selected = presets.find((p) => p.id === appliedPreset) ?? null;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'flex h-[40px] w-full items-center justify-between rounded-[10px] border pl-[12px] pr-3 text-14 outline-none transition-colors',
            'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] focus:border-[var(--settings-input-border-focus)]',
          )}
        >
          <span
            className={cn(
              'truncate text-left',
              selected
                ? 'text-[var(--settings-input-text)]'
                : 'text-[var(--settings-input-placeholder)]',
            )}
          >
            {selected ? presetDisplayName(selected, locale) : placeholder}
          </span>
          <ChevronDown size={16} className="shrink-0 text-[var(--settings-eye-icon)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onEscapeKeyDown={(event) => {
          // Radix 自己也是该层的 dismiss owner；组合输入期间阻止它先于表单
          // 的统一判据关闭菜单。
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
        }}
        className={cn(
          // z-[10001]: 宿主弹窗 overlay 是 z-[10000],默认 z-50 会被盖住。
          // 底/hover 用 cmd-palette 菜单 token 对——settings-menu-bg-hover 在深色下
          // 与卡片底同色,hover 会看不出来。
          'z-[10001] max-h-[280px] w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-xl p-2',
          'border border-[var(--cmd-palette-border)]',
          'bg-[var(--cmd-palette-bg)] shadow-[var(--shadow-menu)]',
        )}
      >
        <div className="flex flex-col gap-[2px]" role="listbox" aria-label={label}>
          {presets.map((p) => {
            const isSelected = appliedPreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onApply(p);
                  onOpenChange(false);
                }}
                className={cn(
                  // 菜单项 hover 不加 transition——渐变会让高亮拖尾跟不上指针,菜单应瞬时切换
                  'flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left',
                  'hover:bg-[var(--cmd-palette-item-hover)]',
                  isSelected && 'bg-[var(--cmd-palette-item-hover)]',
                )}
              >
                <span className="truncate text-13 font-medium text-[var(--settings-input-text)]">
                  {presetDisplayName(p, locale)}
                </span>
                {isSelected ? (
                  <Check size={16} className="shrink-0 text-[var(--settings-theme-icon-active)]" />
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── 主组件 ─────────────────────────────────────────────────────────────────

export function CustomProviderDialog({
  initial,
  existingIds,
  onSaved,
  onClose,
}: CustomProviderDialogProps) {
  const { t, i18n } = useTranslation();
  const editing = !!initial;
  const initialOAuth = initial?.auth?.method === 'oauth' ? initial.auth.oauth : undefined;

  const [name, setName] = useState(initial?.name ?? '');
  const [rt, setRt] = useState<Record<DialogAgentKind, RuntimeFields>>(() => initRuntimes(initial));
  const [activeTab, setActiveTab] = useState<DialogAgentKind>(
    () => (initial && VISIBLE_AGENTS.find((a) => initial.runtimes[a])) || 'claude-code',
  );
  const [hasKey, setHasKey] = useState<Record<DialogAgentKind, boolean>>({
    'claude-code': false,
    codex: false,
    pi: false,
  });
  const [saving, setSaving] = useState(false);
  // 鉴权形态：API key（默认）/ OAuth / 无鉴权（本机或受信自托管代理）。
  const [authMode, setAuthModeState] = useState<CustomProviderAuthMode>(
    initial?.auth?.method === 'oauth'
      ? 'oauth'
      : initial?.auth?.method === 'none'
        ? 'none'
        : 'apiKey',
  );
  const authModeRef = useRef(authMode);
  const setAuthMode = useCallback((mode: CustomProviderAuthMode) => {
    authModeRef.current = mode;
    setAuthModeState(mode);
  }, []);
  const [oauthFlow, setOauthFlow] = useState<'authorization-code' | 'device-code'>(
    initialOAuth?.flow === 'device-code' ? 'device-code' : 'authorization-code',
  );
  const [oauthFields, setOauthFields] = useState({
    authorizeUrl:
      initialOAuth && initialOAuth.flow !== 'device-code' ? initialOAuth.authorizeUrl : '',
    deviceAuthorizationUrl:
      initialOAuth?.flow === 'device-code' ? initialOAuth.deviceAuthorizationUrl : '',
    tokenUrl: initialOAuth?.tokenUrl ?? '',
    clientId: initialOAuth?.clientId ?? '',
    scopes: initialOAuth?.scopes ?? '',
  });
  // OAuth 模式下模型 / 请求头收进默认折叠的「高级配置」——模型授权后自动发现,普通用户无需碰。
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 上下文窗口输入的行级草稿:受控输入若只回显已提交值,逐字符键入 `1,` 这类
  // 合法中间态会被整体校验拒绝后回滚,声明支持的分组格式只能粘贴、无法键入
  // (review P1)。草稿承载显示文本;合法完整值仍即时提交,失焦只清可提交
  // 草稿。key = `agent:行号`;删行时只重映射该 runtime 的行号,别行草稿保留。
  const [windowDrafts, setWindowDrafts] = useState<Record<string, string>>({});
  // 预设模板（仅新建态展示；目录 presets 段，随 OSS 热更）。
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);
  // 嵌套 dismiss layer 互斥且由表单统一持有：Radix Popover 只负责呈现，
  // 不再让退场中的菜单与新打开的模型选择器同时成为 Escape owner。
  const [childLayer, setChildLayer] = useState<DialogChildLayer>(null);
  // per-runtime 测试连接状态。
  const [test, setTest] = useState<Record<DialogAgentKind, TestState>>({
    'claude-code': IDLE_TEST,
    codex: IDLE_TEST,
    pi: IDLE_TEST,
  });
  // per-runtime「获取模型列表」进行中标记（按钮瞬态 spinner）。
  const [fetchingModels, setFetchingModels] = useState<Record<DialogAgentKind, boolean>>({
    'claude-code': false,
    codex: false,
    pi: false,
  });
  // 拉取成功后的勾选弹层：行集合 = 拉取结果 ∪ 表单已填（后者默认勾选、保留用户显示名）。
  const picker = childLayer?.kind === 'model-picker' ? childLayer.value : null;
  const presetMenuOpen = childLayer?.kind === 'preset-menu';
  // 原生 window listener 的生命周期不跟着每次 render 重绑；layout effect 只把
  // 已提交的层状态写入 ref，既避开 passive effect 延迟，也不暴露被放弃的并发 render。
  const childLayerRef = useRef(childLayer);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    childLayerRef.current = childLayer;
    onCloseRef.current = onClose;
  }, [childLayer, onClose]);

  // Dismissible form contract:一个关闭输入只结算最上层一次。模型选择器优先于
  // 预设菜单，最后才是表单；Cancel 仍直接表示用户要关闭表单，且无重复 ×。
  const dismissTopmostLayer = useCallback(() => {
    const activeLayer = childLayerRef.current;
    if (activeLayer) {
      // 同一事件周期内先同步更新 owner，避免快速连续输入重复结算旧层。
      childLayerRef.current = null;
      setChildLayer((current) => (current === activeLayer ? null : current));
      return;
    }
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // IME 候选窗的 Escape 是组合输入控制，不是弹层关闭意图。
      if (event.isComposing || event.keyCode === 229) return;
      // 在 Radix 的 document capture 之前由唯一 owner 结算；否则菜单的 80ms
      // 退场层仍可能 preventDefault，吞掉刚打开的模型选择器的 Escape。
      event.preventDefault();
      event.stopPropagation();
      dismissTopmostLayer();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dismissTopmostLayer]);
  // 最新 runtime 表单状态镜像：拉取响应到达时据此构建弹层行/预勾选，而不是用请求发出时的
  // 闭包快照——在途期间被用户删除的行不得复活。镜像在每个 setRt updater 内**同步**更新
  // （见 setRtSynced），不用被动 useEffect——effect 在 commit 后才跑，IPC 响应若落在
  // 状态更新与 effect 之间会读到旧值。
  const rtRef = useRef(rt);
  /** 唯一的 rt 写入口：状态更新的同时同步镜像进 rtRef（updater 幂等，StrictMode 双调无害）。 */
  const setRtSynced = useCallback(
    (fn: (prev: Record<DialogAgentKind, RuntimeFields>) => Record<DialogAgentKind, RuntimeFields>) => {
      setRt((prev) => {
        const next = fn(prev);
        rtRef.current = next;
        return next;
      });
    },
    [],
  );

  // 编辑态回填的已存明文 key(按 agent);测试连接据此判定凭证材料是否被改动。
  const loadedKeyRef = useRef<Record<DialogAgentKind, string>>({
    'claude-code': '',
    codex: '',
    pi: '',
  });

  // 已存供应商在编辑态的基线快照:端点/协议/鉴权模式取自已存配置,apiKey 取回填值,
  // headers 取已存非密文头(自定义鉴权头是 main-only 密文,不回读进表单)。测试连接 /
  // 获取模型列表据此判定能否复用不回读的密文头(经 saved 探测 / savedProviderId 让 main
  // 并入),而非把密钥回读到 renderer。非编辑态或该 runtime 未配置时返回 null。
  const savedBaselineFor = useCallback(
    (agent: DialogAgentKind): SavedProviderProbeBaseline | null => {
      if (!editing || !initial) return null;
      const rc = initial.runtimes[agent];
      if (!rc) return null;
      const savedAuthMode: CustomProviderAuthMode =
        initial.auth?.method === 'oauth'
          ? 'oauth'
          : initial.auth?.method === 'none'
            ? 'none'
            : 'apiKey';
      return {
        baseUrl: rc.baseUrl,
        requestPath: rc.requestPath ?? '',
        modelsUrl: rc.modelsUrl ?? '',
        wireProtocol: rc.wireProtocol ?? defaultWireFor(agent),
        authMode: savedAuthMode,
        apiKey: loadedKeyRef.current[agent] ?? '',
        headers:
          rc.headers && Object.keys(rc.headers).length > 0
            ? Object.entries(rc.headers).map(([n, v]) => ({ name: n, value: v }))
            : [],
      };
    },
    [editing, initial],
  );

  // 新建态拉取预设模板（本地 IPC 极快返回；失败静默 —— 没有预设也不影响手填，规则 7 不做 loading）。
  // 按实际构建区域排序，不随 UI 语言变化（只排序不过滤，可达性由测试连接实测裁决）。
  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    void window.electronAPI.maker
      .listProviderPresets()
      .then((r) => {
        if (!cancelled) setPresets(sortPresetsForRegion(r.presets, CURRENT_CINDY_REGION));
      })
      .catch(() => {
        /* 预设缺失不影响手填 */
      });
    return () => {
      cancelled = true;
    };
  }, [editing]);

  /** 应用预设：预填显示名 + 各 runtime 的 baseUrl / 模型 / headers（创建时快照，之后与预设脱钩）。 */
  const applyPreset = useCallback(
    (p: ProviderPreset) => {
      setAppliedPreset(p.id);
      setName(presetDisplayName(p, i18n.language));
      setAuthMode(p.authMethod ?? 'apiKey');
      setRtSynced((prev) => {
        const next = { ...prev };
        for (const a of AGENTS) {
          const rc = p.runtimes[a];
          if (!rc) {
            next[a] = emptyRuntime(a);
            continue;
          }
          next[a] = {
            baseUrl: rc.baseUrl,
            requestPath: rc.requestPath ?? '',
            apiKey: prev[a].apiKey, // 已填的 key 保留
            wireProtocol: rc.wireProtocol ?? defaultWireFor(a),
            models: rc.models.length ? rc.models.map((m) => ({ ...m })) : [{ id: '', name: '' }],
            headers:
              rc.headers && Object.keys(rc.headers).length > 0
                ? Object.entries(rc.headers).map(([n, v]) => ({ name: n, value: v }))
                : [{ name: '', value: '' }],
            modelsUrl: rc.modelsUrl ?? '',
          };
        }
        return next;
      });
      setTest({ 'claude-code': IDLE_TEST, codex: IDLE_TEST, pi: IDLE_TEST });
      // 预设整体替换所有 runtime 的 models 数组(含清空未声明的 runtime),旧行号
      // 全部失效——不清空的话陈旧草稿(如 -5)会挂在无关的新行、或挂在被预设清空
      // 的 runtime 上,handleSave 的守卫拦不住"用户已经看不到"的这条草稿,表单
      // 卡死报错却找不到对应输入框(review P1)。
      setWindowDrafts({});
      const first = AGENTS.find((a) => p.runtimes[a]);
      if (first) setActiveTab(first);
    },
    [i18n.language, setRtSynced],
  );

  // 编辑态：回填各已配置 runtime 的已存明文密钥（用户本机自己的 key）——
  // 让密钥框「能看」(eye 显形 / 可核对)，而非空白遮罩；据此点亮「已保存」徽标。
  // 鉴权请求头是 main-only 密文,不回读进表单;未显式改动时由 main 侧 update 保留旧值。
  useEffect(() => {
    if (!editing || !initial) return;
    let cancelled = false;
    void (async () => {
      const nextHas: Record<DialogAgentKind, boolean> = { 'claude-code': false, codex: false, pi: false };
      const fetched: Partial<Record<DialogAgentKind, string>> = {};
      for (const a of AGENTS) {
        if (!initial.runtimes[a]) continue;
        const k = await readCustomProviderKey(initial.id, a);
        if (k) {
          nextHas[a] = true;
          fetched[a] = k;
        }
      }
      if (cancelled) return;
      setHasKey(nextHas);
      // 记下回填的已存明文 key 作为基线:测试连接判定「凭证材料是否被改动」时用来决定
      // 走受控 saved 探测还是 adhoc(headers 是 main-only 密文,基线取自 initial 的非密文头)。
      for (const a of AGENTS) loadedKeyRef.current[a] = fetched[a] ?? '';
      setRtSynced((prev) => {
        const next = { ...prev };
        for (const a of AGENTS) {
          if (fetched[a] != null) next[a] = { ...next[a], apiKey: fetched[a] as string };
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [editing, initial]);

  const patch = useCallback(
    (agent: DialogAgentKind, fn: (f: RuntimeFields) => RuntimeFields) => {
      setRtSynced((prev) => ({ ...prev, [agent]: fn(prev[agent]) }));
      setTest((prev) => ({ ...prev, [agent]: IDLE_TEST }));
    },
    [setRtSynced],
  );

  /** 切换协议时保留用户已填写的 endpoint，仅使旧测试结果失效。 */
  const changeWireProtocol = useCallback(
    (agent: DialogAgentKind, wireProtocol: ProviderWireProtocol) => {
      setRtSynced((prev) => ({
        ...prev,
        [agent]: { ...prev[agent], wireProtocol },
      }));
      setTest((prev) => ({ ...prev, [agent]: IDLE_TEST }));
    },
    [setRtSynced],
  );

  const f = rt[activeTab];

  /** 测试当前 Tab 的表单值（未保存也能测；key 仅内存透传给 main，不落盘）。 */
  const handleTest = useCallback(async () => {
    const agent = activeTab;
    const rf = rt[agent];
    const baseUrl = rf.baseUrl.trim();
    const firstModel = rf.models.map((m) => m.id.trim()).find((id) => id.length > 0);
    if (!baseUrl || !firstModel) {
      toast.error(t('settings.providers.custom.test.needFields'));
      return;
    }
    if (!areProviderRequestUrlsAllowed(authMode, baseUrl)) {
      toast.error(t('settings.providers.custom.errors.baseUrlInvalid'));
      return;
    }
    const headers: Record<string, string> = {};
    for (const h of rf.headers) {
      const n = h.name.trim();
      if (n) headers[n] = h.value.trim();
    }
    const requestHeaders = authMode === 'none' ? stripCredentialHeaders(headers) : headers;
    const requestSig = providerConnectionTestRequestSignature(rf, authMode);
    // 编辑态且端点/协议/鉴权模式与凭证材料相对已存配置都未改动时,走受控 saved 探测:
    // 它整体按已存 spec 发起,能带上不回读进表单的 main-only 密文鉴权头(否则纯密文头
    // 供应商会因缺头而失败)。任一改动则回落 adhoc,测用户新填的值。
    const savedBaseline = savedBaselineFor(agent);
    const useSaved = Boolean(
      initial?.id && savedBaseline && connectionTestCanUseSaved(rf, savedBaseline, authMode),
    );
    setTest((prev) => ({ ...prev, [agent]: { status: 'testing' } }));
    try {
      const result = await window.electronAPI.maker.testProviderConnection(
        useSaved
          ? { kind: 'saved', providerId: initial!.id, agent }
          : {
              kind: 'adhoc',
              spec: {
                agent,
                baseUrl,
                modelId: firstModel,
                authMethod: authMode,
                wireProtocol: rf.wireProtocol,
                ...(rf.requestPath.trim() ? { requestPath: rf.requestPath.trim() } : {}),
                apiKey: authMode === 'apiKey' ? rf.apiKey.trim() || null : null,
                ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
              },
            },
      );
      if (
        providerConnectionTestRequestSignature(rtRef.current[agent], authModeRef.current) !==
        requestSig
      )
        return;
      setTest((prev) => ({
        ...prev,
        [agent]: result.ok
          ? { status: 'ok', latencyMs: result.latencyMs }
          : { status: 'fail', code: result.code ?? 'UNKNOWN' },
      }));
    } catch (e) {
      if (
        providerConnectionTestRequestSignature(rtRef.current[agent], authModeRef.current) !==
        requestSig
      )
        return;
      const ipc = extractIpcError(e);
      setTest((prev) => ({ ...prev, [agent]: { status: 'fail', code: 'UNKNOWN' } }));
      if (ipc?.message) toast.error(ipc.message);
    }
  }, [activeTab, authMode, rt, t, savedBaselineFor, initial]);

  // 拉取单飞：任一 runtime（含 Pi）在途时所有 Tab 的拉取按钮都禁用——两个并发请求会竞争
  // 同一个勾选弹层（后到的覆盖先开的、确认还会写进另一个 runtime），单飞直接消掉这类竞态。
  const anyFetching = fetchingModels['claude-code'] || fetchingModels.codex || fetchingModels.pi;

  /** 获取模型列表：用当前 Tab 表单值 GET 列模型端点（key 仅内存透传），成功后开勾选弹层。 */
  const handleFetchModels = useCallback(async () => {
    const agent = activeTab;
    const rf = rt[agent];
    if (fetchingModels['claude-code'] || fetchingModels.codex || fetchingModels.pi) return; // 单飞（按钮已禁用，兜底）
    const baseUrl = rf.baseUrl.trim();
    if (!baseUrl) {
      toast.error(t('settings.providers.custom.fetch.needBaseUrl'));
      return;
    }
    if (!areProviderRequestUrlsAllowed(authMode, baseUrl, rf.modelsUrl)) {
      toast.error(t('settings.providers.custom.errors.baseUrlInvalid'));
      return;
    }
    const headers: Record<string, string> = {};
    for (const h of rf.headers) {
      const n = h.name.trim();
      if (n) headers[n] = h.value.trim();
    }
    const requestHeaders = authMode === 'none' ? stripCredentialHeaders(headers) : headers;
    // 请求参数签名：响应回来时若该 runtime 的端点/凭证/请求头已被改动，响应按过期丢弃——
    // 不能把旧端点的模型清单当成新端点的填进表单（成功和失败 toast 都不展示）。
    const requestSig = providerModelFetchRequestSignature(rf, authMode);
    // 编辑态且请求目标端点(baseUrl/modelsUrl)与鉴权模式相对已存配置未改动时,带上
    // savedProviderId,让 main 侧并入不回读进 renderer 的 main-only 密文鉴权头(表单显式
    // 填的头/key 仍由 main 以 renderer 值优先);端点一改就不带,避免把已存凭证外泄给新主机。
    const savedBaseline = savedBaselineFor(agent);
    const reuseSaved = Boolean(
      initial?.id && savedBaseline && modelFetchCanReuseSavedCredentials(rf, savedBaseline, authMode),
    );
    setFetchingModels((prev) => ({ ...prev, [agent]: true }));
    try {
      const result = await window.electronAPI.maker.fetchProviderModels({
        agent,
        baseUrl,
        authMethod: authMode,
        ...(rf.wireProtocol ? { wireProtocol: rf.wireProtocol } : {}),
        modelsUrl: rf.modelsUrl.trim() || null,
        apiKey: authMode === 'apiKey' ? rf.apiKey.trim() || null : null,
        ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
        ...(reuseSaved ? { savedProviderId: initial!.id } : {}),
      });
      if (
        providerModelFetchRequestSignature(rtRef.current[agent], authModeRef.current) !== requestSig
      )
        return; // 过期响应，静默丢弃
      if (result.ok && result.models && result.models.length > 0) {
        // 用**响应到达时**的最新表单行构建弹层（rtRef），不是请求发出时的 rf 快照。
        const current = rtRef.current[agent].models
          .map((m) => ({
            id: m.id.trim(),
            name: m.name.trim(),
            ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
            ...(m.defaultEnabled === false ? { defaultEnabled: false } : {}),
            ...(m.supportsImageInput === true ? { supportsImageInput: true } : {}),
            ...(m.reasoning === true && m.reasoningEfforts?.length
              ? { reasoning: true, reasoningEfforts: [...m.reasoningEfforts] }
              : {}),
          }))
          .filter((m) => m.id.length > 0);
        const currentById = new Map(current.map((m) => [m.id, m]));
        const fetchedIds = new Set(result.models.map((m) => m.id));
        // 行集合 = 表单已填但不在拉取结果里的（置顶保留）+ 拉取结果（撞 id 时保留用户显示名）。
        const rows: ModelRow[] = [
          ...current
            .filter((m) => !fetchedIds.has(m.id))
            .map((m) => ({ ...m, name: m.name || m.id })),
          ...result.models.map((m) => {
            const cur = currentById.get(m.id);
            // contextWindow:表单已有的行以用户当前值为准——包括「显式清空」
            // (cur 存在但无值时不得被发现值回填,review P1);只有表单没见过的
            // 新模型才带上端点声明的发现值(否则保存后回落 200K,review P1)。
            const contextWindow = cur ? cur.contextWindow : m.contextWindow;
            return {
              id: m.id,
              name: cur?.name || m.name,
              ...(contextWindow !== undefined ? { contextWindow } : {}),
              ...(cur?.defaultEnabled === false ? { defaultEnabled: false } : {}),
              ...(cur?.supportsImageInput === true ? { supportsImageInput: true } : {}),
              ...(cur?.reasoning === true && cur.reasoningEfforts?.length
                ? { reasoning: true, reasoningEfforts: [...cur.reasoningEfforts] }
                : {}),
            };
          }),
        ];
        setChildLayer({
          kind: 'model-picker',
          value: { agent, models: rows, selected: new Set(currentById.keys()), query: '' },
        });
        // 弹层锁定所属 runtime：把背景 Tab 同步切回请求的 runtime（标题也带 runtime 名），
        // 请求期间切过 Tab 也不会在错误上下文里确认。
        setActiveTab(agent);
      } else {
        toast.error(t(`providerError.${result.code ?? 'UNKNOWN'}`));
      }
    } catch (e) {
      if (
        providerModelFetchRequestSignature(rtRef.current[agent], authModeRef.current) !== requestSig
      )
        return; // 过期失败同样静默
      const ipc = extractIpcError(e);
      toast.error(ipc?.message ?? t('settings.providers.custom.fetch.failed'));
    } finally {
      setFetchingModels((prev) => ({ ...prev, [agent]: false }));
    }
  }, [activeTab, authMode, rt, fetchingModels, t, savedBaselineFor, initial]);

  /**
   * 勾选弹层确认：勾选集写回该 runtime 的模型行。基于**确认时的最新表单行**合并，
   * 不用拉取时的快照整体替换——拉取在途/弹层打开期间用户对模型行的编辑不能被静默冲掉：
   *   - 弹层见过且勾选的 id 保留（显示名若被用户后改过，跟随最新值）；
   *   - 弹层见过但未勾选的 id 移除（明确的用户意图）；
   *   - 弹层没见过的 id（之后新手填的行）原样保留。
   */
  const applyPicker = useCallback(() => {
    if (!picker) return;
    const chosen = picker.models.filter((m) => picker.selected.has(m.id));
    if (chosen.length === 0) return;
    const pickerIds = new Set(picker.models.map((m) => m.id));
    // 重映射靠 id 而不是行号:picker 确认会任意增删/重排该 runtime 的行,旧行号
    // 不能直接套到新数组。合并结果必须同步算出一份普通数组,同时喂给状态更新和
    // 草稿重映射——不能指望 patch() 调用后立即读 rtRef 拿到刚提交的值:rtRef 只
    // 在 setRtSynced 传给 setRt 的函数式 updater**内部**才写,而 React 不保证这个
    // updater 会在 setRt() 调用后的下一行同步跑完;picker 移除/重排行、且 setRt
    // 已有排队工作时,这次读到的可能仍是 previousModels,导致草稿按旧下标错配到
    // 一个已经不存在的行上(review P1)。
    const previousModels = rtRef.current[picker.agent].models;
    const latestById = new Map<string, ModelRow>();
    for (const pm of previousModels) {
      const id = pm.id.trim();
      if (id && !latestById.has(id)) latestById.set(id, pm);
    }
    const merged: ModelRow[] = chosen.map((m) => {
      const latest = latestById.get(m.id);
      const contextWindow = latest?.contextWindow ?? m.contextWindow;
      const defaultEnabled = latest?.defaultEnabled ?? m.defaultEnabled;
      const supportsImageInput = latest ? latest.supportsImageInput : m.supportsImageInput;
      const reasoning = latest ? latest.reasoning : m.reasoning;
      const reasoningEfforts = latest ? latest.reasoningEfforts : m.reasoningEfforts;
      return {
        id: m.id,
        name: latest?.name.trim() ? latest.name.trim() : m.name,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(defaultEnabled === false ? { defaultEnabled: false } : {}),
        ...(supportsImageInput === true ? { supportsImageInput: true } : {}),
        ...(reasoning === true && reasoningEfforts?.length
          ? { reasoning: true, reasoningEfforts: [...reasoningEfforts] }
          : {}),
      };
    });
    for (const m of previousModels) {
      const id = m.id.trim();
      if (id && !pickerIds.has(id) && !merged.some((r) => r.id === id)) {
        merged.push({
          id,
          name: m.name.trim() || id,
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
          ...(m.defaultEnabled === false ? { defaultEnabled: false } : {}),
          ...(m.supportsImageInput === true ? { supportsImageInput: true } : {}),
          ...(m.reasoning === true && m.reasoningEfforts?.length
            ? { reasoning: true, reasoningEfforts: [...m.reasoningEfforts] }
            : {}),
        });
      }
    }
    patch(picker.agent, (x) => ({ ...x, models: merged }));
    const oldIndexToId = new Map(previousModels.map((m, i) => [i, m.id.trim()]));
    const newIndexById = new Map<string, number>();
    merged.forEach((m, i) => {
      if (!newIndexById.has(m.id)) newIndexById.set(m.id, i);
    });
    // 合并逻辑(上面的 latestById / 第二个 for 循环)对重复 id 都是「先遇到的旧行
    // 赢」——按 previousModels 的原始顺序扫到的第一条。存活进 merged 的就是那
    // 一条,不是随便哪条同 id 旧行。草稿重映射必须认准同一条,否则会把已被丢弃的
    // 重复行的草稿错配到存活行上(review P1 ×2)。
    const survivingOldIndexById = new Map<string, number>();
    previousModels.forEach((m, i) => {
      const id = m.id.trim();
      if (id && !survivingOldIndexById.has(id)) survivingOldIndexById.set(id, i);
    });
    setWindowDrafts((drafts) => {
      const next: Record<string, string> = {};
      for (const [key, text] of Object.entries(drafts)) {
        const sep = key.lastIndexOf(':');
        const agent = key.slice(0, sep);
        if (agent !== picker.agent) {
          next[key] = text;
          continue;
        }
        // 仍保留的行(id 未变)把草稿迁到新行号;被 picker 移出的行(取消勾选)
        // 丢弃草稿——不合法草稿只应因它对应的行真的消失才清除。
        const oldIdx = Number(key.slice(sep + 1));
        const id = oldIndexToId.get(oldIdx);
        // 空 id(未填完的手填行)没有稳定身份可追踪,直接丢弃;非空 id 只有
        // 「合并时实际存活的那条旧行」的草稿才允许迁移——同 id 的其它旧行本就
        // 在合并时被丢弃,它们的草稿也该丢弃,不能顶替到存活行上。
        if (!id || survivingOldIndexById.get(id) !== oldIdx) continue;
        const newIdx = newIndexById.get(id);
        if (newIdx === undefined) continue;
        next[`${agent}:${newIdx}`] = text;
      }
      return next;
    });
    setChildLayer((current) =>
      current?.kind === 'model-picker' && current.value === picker ? null : current,
    );
  }, [picker, patch]);

  const handleSave = useCallback(async () => {
    // 校验失败统一走 toast(规则 7:不在弹窗里塞会撑高/缩回的内联错误条,避免布局抖动闪烁)。
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('settings.providers.custom.errors.nameRequired'));
      return;
    }
    // 上下文窗口草稿必须已可提交:输入框还挂着 `1,` / `-5` 这类未完成/非法文本时
    // 点保存,已提交值(或隐式 200K 默认)与用户可见文本不一致——静默存旧值等于
    // 改掉用户显式输入(review P1 ×2)。定位到首个问题 tab 并报错拦下。
    for (const [draftKey, draftText] of Object.entries(windowDrafts)) {
      if (isCommittableWindowText(draftText)) continue;
      const sep = draftKey.lastIndexOf(':');
      const draftAgent = draftKey.slice(0, sep) as AgentKind;
      if (!VISIBLE_AGENTS.includes(draftAgent)) continue;
      // 该 runtime 未配置 baseUrl、或该行 id/name 为空:两者都会在下面序列化时
      // 被丢弃,不会写进最终配置,草稿再非法也不该挡住一个原本有效的保存
      // (review P1)。
      const rf = rt[draftAgent];
      if (!rf.baseUrl.trim()) continue;
      const row = rf.models[Number(draftKey.slice(sep + 1))];
      if (!row || !row.id.trim() || !row.name.trim()) continue;
      setActiveTab(draftAgent);
      // OAuth 鉴权模式下模型列表(含窗口输入)折在「高级」里;不展开的话用户看不到
      // 需要修的这个输入框,报错后无从下手,只能瞎猜着点开(review P1)。
      if (authMode === 'oauth' && !showAdvanced) setShowAdvanced(true);
      toast.error(t('settings.providers.custom.errors.contextWindowInvalid'));
      return;
    }
    const runtimes: CustomProviderConfig['runtimes'] = {};
    const keys: RuntimeKeys = {};
    for (const a of VISIBLE_AGENTS) {
      const rf = rt[a];
      if (!rf.baseUrl.trim()) continue; // 该 runtime 未配置
      try {
        const u = new URL(rf.baseUrl.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          setActiveTab(a);
          toast.error(t('settings.providers.custom.errors.baseUrlInvalid'));
          return;
        }
      } catch {
        setActiveTab(a);
        toast.error(t('settings.providers.custom.errors.baseUrlInvalid'));
        return;
      }
      if (!areProviderRequestUrlsAllowed(authMode, rf.baseUrl, rf.modelsUrl)) {
        setActiveTab(a);
        toast.error(t('settings.providers.custom.errors.baseUrlInvalid'));
        return;
      }
      const models = rf.models
        .map((m) => ({
          id: m.id.trim(),
          name: m.name.trim(),
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
          ...(m.defaultEnabled === false ? { defaultEnabled: false } : {}),
          ...(m.supportsImageInput === true ? { supportsImageInput: true } : {}),
          ...(m.reasoning === true && m.reasoningEfforts?.length
            ? { reasoning: true, reasoningEfforts: [...m.reasoningEfforts] }
            : {}),
        }))
        .filter((m) => m.id && m.name);
      const requestPath = rf.requestPath.trim();
      if (requestPath && !isProviderRequestPath(requestPath)) {
        setActiveTab(a);
        toast.error(t('settings.providers.custom.errors.requestPathInvalid'));
        return;
      }
      // OAuth 形态模型可留空——授权成功后自动发现并持久化（与内置订阅统一）。
      if (models.length === 0 && authMode !== 'oauth') {
        setActiveTab(a);
        toast.error(t('settings.providers.custom.errors.modelRequired'));
        return;
      }
      const headers: Record<string, string> = {};
      for (const h of rf.headers) {
        const n = h.name.trim();
        if (n) headers[n] = h.value.trim();
      }
      const savedHeaders = authMode === 'none' ? stripCredentialHeaders(headers) : headers;
      const defaultProtocol = defaultWireFor(a);
      runtimes[a] = {
        baseUrl: rf.baseUrl.trim(),
        ...(requestPath ? { requestPath } : {}),
        ...(rf.wireProtocol !== defaultProtocol ? { wireProtocol: rf.wireProtocol } : {}),
        models,
        ...(Object.keys(savedHeaders).length > 0 ? { headers: savedHeaders } : {}),
        ...(rf.modelsUrl.trim() ? { modelsUrl: rf.modelsUrl.trim() } : {}),
      };
      // OAuth 形态不收集 per-runtime API key（鉴权走 Runner 的 Bearer）。
      if (authMode === 'apiKey' && rf.apiKey.trim()) keys[a] = rf.apiKey.trim();
    }
    if (Object.keys(runtimes).length === 0) {
      toast.error(t('settings.providers.custom.errors.runtimeRequired'));
      return;
    }
    // OAuth 形态：四个必填字段 + 端点必须 https（与 main 侧校验同规则，先在表单挡住）。
    let auth: CustomProviderConfig['auth'];
    if (authMode === 'oauth') {
      const tokenUrl = oauthFields.tokenUrl.trim();
      const clientId = oauthFields.clientId.trim();
      const scopes = oauthFields.scopes.trim();
      const httpsOk = (u: string) => {
        try {
          const url = new URL(u);
          return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
          return false;
        }
      };
      const flowUrl =
        oauthFlow === 'device-code'
          ? oauthFields.deviceAuthorizationUrl.trim()
          : oauthFields.authorizeUrl.trim();
      if (
        !flowUrl ||
        !tokenUrl ||
        !clientId ||
        !scopes ||
        !httpsOk(flowUrl) ||
        !httpsOk(tokenUrl)
      ) {
        toast.error(t('settings.providers.custom.errors.oauthInvalid'));
        return;
      }
      auth = {
        method: 'oauth',
        oauth:
          oauthFlow === 'device-code'
            ? {
                ...(initialOAuth?.flow === 'device-code' && initialOAuth.extraDeviceParams
                  ? { extraDeviceParams: { ...initialOAuth.extraDeviceParams } }
                  : {}),
                ...(initialOAuth?.modelsDiscoveryUrl
                  ? { modelsDiscoveryUrl: initialOAuth.modelsDiscoveryUrl }
                  : {}),
                flow: 'device-code',
                deviceAuthorizationUrl: flowUrl,
                tokenUrl,
                clientId,
                scopes,
              }
            : {
                ...(initialOAuth && initialOAuth.flow !== 'device-code'
                  ? {
                      ...(initialOAuth.redirectPort !== undefined
                        ? { redirectPort: initialOAuth.redirectPort }
                        : {}),
                      ...(initialOAuth.extraAuthParams
                        ? { extraAuthParams: { ...initialOAuth.extraAuthParams } }
                        : {}),
                    }
                  : {}),
                ...(initialOAuth?.modelsDiscoveryUrl
                  ? { modelsDiscoveryUrl: initialOAuth.modelsDiscoveryUrl }
                  : {}),
                flow: 'authorization-code',
                authorizeUrl: flowUrl,
                tokenUrl,
                clientId,
                scopes,
              },
      };
    } else if (authMode === 'none') {
      auth = { method: 'none' };
    }
    const id =
      editing && initial
        ? initial.id
        : uniqueCustomProviderId(trimmedName, new Set(existingIds ?? []));
    const config: CustomProviderConfig = {
      id,
      name: trimmedName,
      ...(auth ? { auth } : {}),
      runtimes,
    };
    setSaving(true);
    try {
      if (editing) {
        await updateCustomProvider(config, keys);
        toast.success(t('settings.providers.custom.toast.updated'));
      } else {
        await createCustomProvider(config, keys);
        toast.success(t('settings.providers.custom.toast.created'));
      }
      // 成功:onSaved 关闭弹窗(父级 setDialog(null) 卸载本组件)。不在此 setSaving(false)——
      // 让按钮维持 spinner 直到卸载,避免「spinner→普通态」闪一帧(规则 7)。
      onSaved();
    } catch (e) {
      const ipc = extractIpcError(e);
      toast.error(ipc?.message ?? t('settings.providers.custom.toast.saveFailed'));
      setSaving(false); // 仅失败时复位:弹窗仍在,允许改后重试
    }
  }, [
    name,
    rt,
    authMode,
    oauthFlow,
    oauthFields,
    initialOAuth,
    editing,
    initial,
    existingIds,
    onSaved,
    windowDrafts,
    showAdvanced,
    t,
  ]);

  const keyPlaceholder = hasKey[activeTab]
    ? t('settings.providers.custom.fields.apiKeyEditPlaceholder')
    : t('settings.providers.custom.fields.apiKeyPlaceholder');

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--overlay-modal)]"
      onPointerDown={(event) => {
        // pointerdown 时先按当前层级结算，避免 Popover 的 outside-dismiss 在随后
        // click 前把状态改成 closed，令同一次手势继续误关底层表单。
        if (event.button === 0 && event.target === event.currentTarget) dismissTopmostLayer();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'flex max-h-[88vh] w-[600px] flex-col rounded-[16px]',
          'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        {/* Header bar */}
        <div className="flex items-center px-3 py-3">
          <div className="flex items-center gap-2.5 pl-2">
            <Sparkles size={20} className="text-[var(--settings-section-title)]" />
            <h2 className="text-18 font-semibold text-[var(--settings-section-title)]">
              {editing
                ? t('settings.providers.custom.dialog.editTitle')
                : t('settings.providers.custom.dialog.createTitle')}
            </h2>
          </div>
        </div>

        {/* Body (scrollable) */}
        <div className="flex flex-col gap-[18px] overflow-y-auto px-6 pb-2 pt-1">
          <p className="text-13 leading-[1.55] text-[var(--settings-section-desc)]">
            {t('settings.providers.custom.dialog.desc')}
          </p>

          {/* 预设模板（仅新建态、有预设时显示）：下拉选择，选中即预填 baseUrl / 模型清单，
              用户只补 key。列表已按厂商首字母分组排序（同厂商国内/海外相邻，按构建区域排序）。 */}
          {!editing && presets.length > 0 && (
            <div className="flex flex-col gap-2">
              <FieldLabel>{t('settings.providers.custom.presets.label')}</FieldLabel>
              <PresetDropdown
                presets={presets}
                appliedPreset={appliedPreset}
                onApply={applyPreset}
                label={t('settings.providers.custom.presets.label')}
                placeholder={t('settings.providers.custom.presets.placeholder')}
                locale={i18n.language}
                open={presetMenuOpen}
                onOpenChange={(open) => {
                  setChildLayer((current) => {
                    if (open) {
                      return current?.kind === 'model-picker' ? current : { kind: 'preset-menu' };
                    }
                    return current?.kind === 'preset-menu' ? null : current;
                  });
                }}
              />
            </div>
          )}

          {/* 显示名称（共享） */}
          <div className="flex flex-col gap-[7px]">
            <FieldLabel>{t('settings.providers.custom.fields.name')}</FieldLabel>
            <SettingsTextInput
              surface="ivory"
              value={name}
              onChange={setName}
              placeholder={t('settings.providers.custom.fields.namePlaceholder')}
            />
          </div>

          {/* 鉴权形态：API 密钥 / OAuth / 无鉴权。 */}
          <div className="flex flex-col gap-2">
            <FieldLabel>{t('settings.providers.custom.authMode.label')}</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {(['apiKey', 'oauth', 'none'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setAuthMode(m);
                    setTest({ 'claude-code': IDLE_TEST, codex: IDLE_TEST, pi: IDLE_TEST });
                  }}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-12 font-medium transition-colors',
                    authMode === m
                      ? 'border-[var(--settings-input-border-focus)] text-[var(--settings-section-title)]'
                      : 'border-[var(--settings-input-border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                  )}
                  style={
                    authMode === m ? { backgroundColor: 'var(--surface-elevated)' } : undefined
                  }
                >
                  {t(`settings.providers.custom.authMode.${m}`)}
                </button>
              ))}
            </div>
            {authMode === 'oauth' && (
              <>
                <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                  {t('settings.providers.custom.authMode.oauthHelp')}
                </span>
                <div className="flex flex-col gap-[7px]">
                  <FieldLabel>{t('settings.providers.custom.authMode.flowLabel')}</FieldLabel>
                  <div className="flex gap-1.5">
                    {(['authorization-code', 'device-code'] as const).map((flow) => (
                      <button
                        key={flow}
                        type="button"
                        onClick={() => setOauthFlow(flow)}
                        className={cn(
                          'rounded-full border px-3 py-1.5 text-12 font-medium transition-colors',
                          oauthFlow === flow
                            ? 'border-[var(--settings-input-border-focus)] text-[var(--settings-section-title)]'
                            : 'border-[var(--settings-input-border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                        )}
                        style={
                          oauthFlow === flow
                            ? { backgroundColor: 'var(--surface-elevated)' }
                            : undefined
                        }
                      >
                        {t(`settings.providers.custom.authMode.flow.${flow}`)}
                      </button>
                    ))}
                  </div>
                </div>
                {(
                  [
                    [
                      oauthFlow === 'device-code' ? 'deviceAuthorizationUrl' : 'authorizeUrl',
                      oauthFlow === 'device-code'
                        ? 'https://auth.example.com/oauth2/device'
                        : 'https://auth.example.com/oauth2/authorize',
                    ],
                    ['tokenUrl', 'https://auth.example.com/oauth2/token'],
                    ['clientId', 'client_id'],
                    ['scopes', 'openid offline_access ...'],
                  ] as const
                ).map(([field, ph]) => (
                  <div key={field} className="flex flex-col gap-[7px]">
                    <FieldLabel>
                      {t(`settings.providers.custom.authMode.fields.${field}`)}
                    </FieldLabel>
                    <SettingsTextInput
                      surface="ivory"
                      value={oauthFields[field]}
                      onChange={(v) => setOauthFields((prev) => ({ ...prev, [field]: v }))}
                      placeholder={ph}
                    />
                  </div>
                ))}
              </>
            )}
            {authMode === 'none' && (
              <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                {t('settings.providers.custom.authMode.noneHelp')}
              </span>
            )}
          </div>

          {/* Runtime 分段 Tab：Claude Code 与 Codex 各自维护端点、协议、模型与凭证。 */}
          <div className="flex flex-col gap-2">
            <FieldLabel>{t('settings.providers.custom.fields.protocols')}</FieldLabel>
            <div
              className="flex h-9 items-center gap-0.5 rounded-full p-[3px]"
              style={{ backgroundColor: 'var(--surface-chip)' }}
              role="tablist"
            >
              {VISIBLE_AGENTS.map((a) => {
                const meta = TAB_META[a];
                const Mark = meta.Mark;
                const active = activeTab === a;
                const configured = rt[a].baseUrl.trim().length > 0;
                return (
                  <button
                    key={a}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveTab(a)}
                    className={cn(
                      'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-13 leading-none transition-colors',
                      active ? 'font-medium' : 'font-normal',
                    )}
                    style={
                      active
                        ? {
                            backgroundColor: 'var(--surface-elevated)',
                            border: '1px solid var(--border-default)',
                            color: 'var(--settings-section-title)',
                          }
                        : { color: 'var(--text-secondary)' }
                    }
                  >
                    <Mark size={14} className="shrink-0" />
                    <span className="whitespace-nowrap">{t(meta.labelKey)}</span>
                    {configured && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: 'var(--remote-status-ready)' }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
            <span className="text-12 leading-snug text-[var(--text-tertiary)]">
              {t(TAB_META[activeTab].helpKey)}
            </span>
          </div>

          {/* 当前 Tab 的独立配置面板 */}
          <div
            className="flex flex-col gap-4 rounded-[12px] p-4"
            style={{
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--settings-theme-card-border)',
            }}
          >
            {(activeTab === 'codex' || activeTab === 'pi') && (
              <div className="flex flex-col gap-[7px]">
                <FieldLabel>{t('settings.providers.custom.fields.wireProtocol')}</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => changeWireProtocol(activeTab, option.value)}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-12 font-medium transition-colors',
                        f.wireProtocol === option.value
                          ? 'border-[var(--settings-input-border-focus)] text-[var(--settings-section-title)]'
                          : 'border-[var(--settings-input-border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                      )}
                      style={
                        f.wireProtocol === option.value
                          ? { backgroundColor: 'var(--surface-elevated)' }
                          : undefined
                      }
                    >
                      {t(activeTab === 'pi'
                        ? `settings.providers.custom.wireProtocol.pi${
                            option.value === 'anthropic-messages'
                              ? 'Anthropic'
                              : option.value === 'openai-responses'
                                ? 'Responses'
                                : 'Chat'
                          }`
                        : option.labelKey)}
                    </button>
                  ))}
                </div>
                <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                  {t(activeTab === 'pi'
                    ? `settings.providers.custom.wireProtocol.pi${
                        f.wireProtocol === 'anthropic-messages'
                          ? 'AnthropicHelp'
                          : f.wireProtocol === 'openai-chat'
                            ? 'ChatHelp'
                            : 'ResponsesHelp'
                      }`
                    : customProviderCodexWireProtocolOption(f.wireProtocol).helpKey)}
                </span>
              </div>
            )}

            {/* 基础 URL */}
            <div className="flex flex-col gap-[7px]">
              <FieldLabel>{t('settings.providers.custom.fields.baseUrl')}</FieldLabel>
              <SettingsTextInput
                surface="ivory"
                value={f.baseUrl}
                onChange={(v) => patch(activeTab, (x) => ({ ...x, baseUrl: v }))}
                placeholder={t('settings.providers.custom.fields.baseUrlPlaceholder')}
              />
            </div>

            {/* 精确推理路径：给非标准兼容端点使用；留空仍按所选协议推导。 */}
            <div className="flex flex-col gap-[7px]">
              <FieldLabel>{t('settings.providers.custom.fields.requestPath')}</FieldLabel>
              <SettingsTextInput
                surface="ivory"
                value={f.requestPath}
                onChange={(v) => patch(activeTab, (x) => ({ ...x, requestPath: v }))}
                placeholder={
                  activeTab === 'claude-code' || f.wireProtocol === 'anthropic-messages'
                    ? '/v1/messages'
                    : customProviderCodexWireProtocolOption(f.wireProtocol).defaultRequestPath
                }
              />
              <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                {t('settings.providers.custom.fields.requestPathHelp')}
              </span>
            </div>

            {/* API 密钥（OAuth 形态隐藏——鉴权走 Runner 的 Bearer，不收集 key） */}
            {authMode === 'apiKey' && (
              <div className="flex flex-col gap-[7px]">
                <div className="flex items-center gap-2">
                  <FieldLabel>{t('settings.providers.custom.fields.apiKey')}</FieldLabel>
                  {/* 已存密钥时给明确徽标 —— 编辑态字段是遮罩空白(留空=不改),无徽标会让人误以为没存上。 */}
                  {hasKey[activeTab] && (
                    <span
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium"
                      style={{
                        backgroundColor: 'var(--settings-btn-secondary-bg)',
                        color: 'var(--settings-section-desc)',
                      }}
                    >
                      <Check size={11} strokeWidth={2.5} />
                      {t('settings.providers.custom.fields.apiKeySaved')}
                    </span>
                  )}
                </div>
                <SettingsTextInput
                  surface="ivory"
                  value={f.apiKey}
                  onChange={(v) => patch(activeTab, (x) => ({ ...x, apiKey: v }))}
                  placeholder={keyPlaceholder}
                  mono
                  secret
                />
                <span className="text-12 text-[var(--text-tertiary)]">
                  {t('settings.providers.custom.fields.apiKeyHelp')}
                </span>
              </div>
            )}

            {/* OAuth 形态:模型清单授权成功后自动发现（与内置订阅统一）,模型 / 请求头
                收进默认折叠的「高级配置」——普通用户不需要看到这些字段。 */}
            {authMode === 'oauth' && (
              <div className="flex flex-col gap-1.5">
                <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                  {t('settings.providers.custom.authMode.modelsAutoNote')}
                </span>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex items-center gap-1 self-start py-0.5 text-13 font-medium text-[var(--settings-section-title)]"
                >
                  <ChevronDown
                    size={14}
                    className={cn('transition-transform', showAdvanced && 'rotate-180')}
                  />
                  {t('settings.providers.custom.advanced.label')}
                </button>
              </div>
            )}

            {(authMode !== 'oauth' || showAdvanced) && (
              <>
                {/* 模型 */}
                <div className="flex flex-col gap-2">
                  <FieldLabel>{t('settings.providers.custom.fields.models')}</FieldLabel>
                  {f.models.map((m, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <div className="flex-1">
                        <SettingsTextInput
                          surface="ivory"
                          value={m.id}
                          onChange={(v) =>
                            patch(activeTab, (x) => ({
                              ...x,
                              models: x.models.map((y, j) =>
                                j === i ? replaceCustomProviderModelId(y, v) : y,
                              ),
                            }))
                          }
                          placeholder={t('settings.providers.custom.fields.modelIdPlaceholder')}
                        />
                      </div>
                      <div className="flex-1">
                        <SettingsTextInput
                          surface="ivory"
                          value={m.name}
                          onChange={(v) =>
                            patch(activeTab, (x) => ({
                              ...x,
                              models: x.models.map((y, j) => (j === i ? { ...y, name: v } : y)),
                            }))
                          }
                          placeholder={t('settings.providers.custom.fields.modelNamePlaceholder')}
                        />
                      </div>
                      <div
                        className="w-28 shrink-0"
                        title={t('settings.providers.custom.fields.modelContextWindowTitle')}
                      >
                        {/* 上下文窗口(tokens):留空 = 保守默认 200K(#386)。整体校验:
                            只接受正整数(允许逗号/下划线/空格做分隔),其它字符直接
                            拒绝本次变更(保持原值)——绝不剥字符再拼数字,-5 / 1e6 /
                            262144.9 这类输入不得被静默纠正成另一个合法值(review P1)。 */}
                        <SettingsTextInput
                          surface="ivory"
                          value={
                            windowDrafts[`${activeTab}:${i}`]
                            ?? (m.contextWindow != null ? String(m.contextWindow) : '')
                          }
                          onBlur={() =>
                            setWindowDrafts((drafts) => {
                              const draftText = drafts[`${activeTab}:${i}`];
                              // 只清可提交草稿(显示回落到已提交规范值);不可提交
                              // 草稿必须保留——输入框失焦先于保存按钮 click,清掉
                              // 会让保存守卫看不到非法文本、静默存旧值(review P1)。
                              if (draftText === undefined || !isCommittableWindowText(draftText)) {
                                return drafts;
                              }
                              const { [`${activeTab}:${i}`]: _drop, ...rest } = drafts;
                              return rest;
                            })
                          }
                          onChange={(v) => {
                            setWindowDrafts((drafts) => ({ ...drafts, [`${activeTab}:${i}`]: v }));
                            patch(activeTab, (x) => ({
                              ...x,
                              models: x.models.map((y, j) => {
                                if (j !== i) return y;
                                const trimmed = v.trim();
                                if (trimmed === '') {
                                  const { contextWindow: _drop, ...rest } = y;
                                  return rest;
                                }
                                // 整体校验(分隔符只允许单个、夹在数字组之间;BigInt 精确
                                // 校验上界防 parseInt 先舍入):不合法的中间态/非法值只
                                // 留在草稿,不提交、不剥字符拼数字(review P1 ×2)。
                                if (!isCommittableWindowText(trimmed)) return y;
                                return {
                                  ...y,
                                  contextWindow: Number(BigInt(trimmed.replace(/[,_ ]/g, ''))),
                                };
                              }),
                            }));
                          }}
                          placeholder={t(
                            'settings.providers.custom.fields.modelContextWindowPlaceholder',
                          )}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          // 只重映射受影响 runtime 的草稿键(删行后同 tab 后续行号
                          // 前移),其它行/另一 runtime 的未提交草稿必须原样保留——
                          // 全量清空会让保存守卫看不到别行的非法文本而静默存旧值
                          // (review P1)。
                          setWindowDrafts((drafts) => {
                            const next: Record<string, string> = {};
                            for (const [key, text] of Object.entries(drafts)) {
                              const sep = key.lastIndexOf(':');
                              const agent = key.slice(0, sep);
                              const idx = Number(key.slice(sep + 1));
                              if (agent !== activeTab) {
                                next[key] = text;
                              } else if (idx < i) {
                                next[key] = text;
                              } else if (idx > i) {
                                next[`${agent}:${idx - 1}`] = text;
                              }
                            }
                            return next;
                          });
                          patch(activeTab, (x) => ({
                            ...x,
                            models: x.models.filter((_, j) => j !== i),
                          }));
                        }}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
                        aria-label={t('settings.providers.custom.fields.removeRow')}
                      >
                        <Trash2 size={16} />
                      </button>
                      {activeTab === 'pi' && (
                        <div className="flex basis-full flex-col gap-2 pr-12 text-[var(--settings-section-desc)]">
                          <label className="flex cursor-pointer items-start gap-2">
                            <input
                              type="checkbox"
                              checked={m.supportsImageInput === true}
                              onChange={(event) => {
                                const supportsImageInput = event.currentTarget.checked;
                                patch(activeTab, (x) => ({
                                  ...x,
                                  models: setCustomProviderModelSupportsImageInput(
                                    x.models,
                                    i,
                                    supportsImageInput,
                                  ),
                                }));
                              }}
                              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--settings-menu-text-selected)]"
                            />
                            <span className="flex flex-col gap-0.5 leading-snug">
                              <span className="text-12 font-medium text-[var(--settings-section-sublabel)]">
                                {t('settings.providers.custom.fields.modelSupportsImageInput')}
                              </span>
                              <span className="text-11">
                                {t('settings.providers.custom.fields.modelSupportsImageInputHelp')}
                              </span>
                            </span>
                          </label>
                          <label className="flex cursor-pointer items-start gap-2">
                            <input
                              type="checkbox"
                              checked={m.reasoning === true}
                              onChange={(event) => {
                                const reasoning = event.currentTarget.checked;
                                patch(activeTab, (x) => ({
                                  ...x,
                                  models: setCustomProviderModelReasoning(x.models, i, reasoning),
                                }));
                              }}
                              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--settings-menu-text-selected)]"
                            />
                            <span className="flex flex-col gap-0.5 leading-snug">
                              <span className="text-12 font-medium text-[var(--settings-section-sublabel)]">
                                {t('settings.providers.custom.fields.modelSupportsReasoning')}
                              </span>
                              <span className="text-11">
                                {t('settings.providers.custom.fields.modelSupportsReasoningHelp')}
                              </span>
                            </span>
                          </label>
                          {m.reasoning === true && (
                            <div className="ml-6 flex flex-col gap-1.5">
                              <span className="text-11 font-medium text-[var(--settings-section-sublabel)]">
                                {t('settings.providers.custom.fields.modelReasoningEfforts')}
                              </span>
                              <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                                {PI_REASONING_EFFORTS.map((effort) => {
                                  const selected = m.reasoningEfforts?.includes(effort) === true;
                                  const lastSelected = selected && m.reasoningEfforts?.length === 1;
                                  return (
                                    <label
                                      key={effort}
                                      className={cn(
                                        'flex items-center gap-1.5 text-11',
                                        lastSelected
                                          ? 'cursor-not-allowed opacity-50'
                                          : 'cursor-pointer',
                                      )}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selected}
                                        disabled={lastSelected}
                                        onChange={(event) => {
                                          const enabled = event.currentTarget.checked;
                                          patch(activeTab, (x) => ({
                                            ...x,
                                            models: setCustomProviderModelReasoningEffort(
                                              x.models,
                                              i,
                                              effort,
                                              enabled,
                                            ),
                                          }));
                                        }}
                                        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--settings-menu-text-selected)] disabled:cursor-not-allowed"
                                      />
                                      {t(`effortLevels.${effort}`)}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      // 追加在末尾不移动既有行号,别行草稿无需动(review P1)。
                      patch(activeTab, (x) => ({
                        ...x,
                        models: [...x.models, { id: '', name: '' }],
                      }))
                    }
                    className="flex items-center gap-1.5 self-start py-0.5 text-13 font-medium text-[var(--settings-section-title)]"
                  >
                    <Plus size={14} className="text-[var(--settings-section-desc)]" />
                    {t('settings.providers.custom.fields.addModel')}
                  </button>
                </div>

                {/* 请求头（可选） */}
                <div className="flex flex-col gap-2">
                  <FieldLabel>{t('settings.providers.custom.fields.headers')}</FieldLabel>
                  {f.headers.map((h, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="flex-1">
                        <SettingsTextInput
                          surface="ivory"
                          value={h.name}
                          onChange={(v) =>
                            patch(activeTab, (x) => ({
                              ...x,
                              headers: x.headers.map((y, j) => (j === i ? { ...y, name: v } : y)),
                            }))
                          }
                          placeholder={t('settings.providers.custom.fields.headerNamePlaceholder')}
                        />
                      </div>
                      <div className="flex-1">
                        <SettingsTextInput
                          surface="ivory"
                          value={h.value}
                          onChange={(v) =>
                            patch(activeTab, (x) => ({
                              ...x,
                              headers: x.headers.map((y, j) => (j === i ? { ...y, value: v } : y)),
                            }))
                          }
                          placeholder={t('settings.providers.custom.fields.headerValuePlaceholder')}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          patch(activeTab, (x) => ({
                            ...x,
                            headers: x.headers.filter((_, j) => j !== i),
                          }))
                        }
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
                        aria-label={t('settings.providers.custom.fields.removeRow')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      patch(activeTab, (x) => ({
                        ...x,
                        headers: [...x.headers, { name: '', value: '' }],
                      }))
                    }
                    className="flex items-center gap-1.5 self-start py-0.5 text-13 font-medium text-[var(--settings-section-title)]"
                  >
                    <Plus size={14} className="text-[var(--settings-section-desc)]" />
                    {t('settings.providers.custom.fields.addHeader')}
                  </button>
                </div>
              </>
            )}

            {/* 测试连接：用当前 Tab 表单值发最小探测请求（与真实会话同路由口径，未保存也能测）。
                OAuth 形态隐藏——登录前无凭证可测，保存并授权后可在供应商行验证。 */}
            {authMode !== 'oauth' && (
              <div className="flex min-h-[32px] flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => void handleTest()}
                  disabled={test[activeTab].status === 'testing'}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-12 font-medium transition-colors active:scale-[0.98]',
                    'border-[var(--settings-input-border)] text-[var(--settings-section-title)] hover:bg-[var(--surface-hover)]',
                    test[activeTab].status === 'testing' && 'cursor-not-allowed opacity-60',
                  )}
                >
                  {test[activeTab].status === 'testing' ? (
                    <Spinner size={13} />
                  ) : (
                    <Plug size={13} />
                  )}
                  {test[activeTab].status === 'testing'
                    ? t('settings.providers.custom.test.testing')
                    : t('settings.providers.custom.test.button')}
                </button>
                {/* 获取模型列表：GET 该供应商的列模型端点，成功后开勾选弹层填进上方模型行。
                  disabled 用 anyFetching（单飞）：另一 Tab 在途时本 Tab 也不许发起。 */}
                <button
                  type="button"
                  onClick={() => void handleFetchModels()}
                  disabled={anyFetching}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-12 font-medium transition-colors active:scale-[0.98]',
                    'border-[var(--settings-input-border)] text-[var(--settings-section-title)] hover:bg-[var(--surface-hover)]',
                    anyFetching && 'cursor-not-allowed opacity-60',
                  )}
                >
                  {fetchingModels[activeTab] ? <Spinner size={13} /> : <RefreshCw size={13} />}
                  {fetchingModels[activeTab]
                    ? t('settings.providers.custom.fetch.fetching')
                    : t('settings.providers.custom.fetch.button')}
                </button>
                {test[activeTab].status === 'ok' && (
                  <span
                    className="flex items-center gap-1 text-12"
                    style={{ color: 'var(--remote-status-ready)' }}
                  >
                    <Check size={13} strokeWidth={2.5} />
                    {t('settings.providers.custom.test.ok', { ms: test[activeTab].latencyMs ?? 0 })}
                  </span>
                )}
                {test[activeTab].status === 'fail' && (
                  <span className="text-12 text-[var(--error-fg)]">
                    {t(`providerError.${test[activeTab].code ?? 'UNKNOWN'}`)}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2.5 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'inline-flex items-center justify-center rounded-full border bg-transparent px-6 py-2.5 text-13 font-medium transition-colors active:scale-[0.98]',
              'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)] hover:bg-[var(--confirm-btn-secondary-hover)]',
            )}
          >
            {t('settings.providers.custom.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className={cn(
              // min-w + 绝对定位 spinner：saving 切换时按钮宽度恒定,不再撑大挤动取消按钮(规则 7)。
              'relative inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium transition-colors active:scale-[0.98]',
              'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]',
              saving && 'cursor-not-allowed opacity-50',
            )}
          >
            {saving && <Spinner size={14} className="absolute left-[18px]" />}
            {t('settings.providers.custom.save')}
          </button>
        </div>
      </div>

      {/* 「获取模型列表」勾选弹层：可搜索多选，确认后替换该 runtime 的模型行。 */}
      {picker && (
        <ModelPickerOverlay
          picker={picker}
          onChange={(next) => {
            setChildLayer((current) =>
              current?.kind === 'model-picker' ? { kind: 'model-picker', value: next } : current,
            );
          }}
          onConfirm={applyPicker}
          onClose={dismissTopmostLayer}
        />
      )}
    </div>
  );
}

/** 勾选弹层内容（搜索 + 全选/清空 + 逐行勾选；> 8 项才显示搜索框，结构对齐 ModelListPanel）。 */
function ModelPickerOverlay({
  picker,
  onChange,
  onConfirm,
  onClose,
}: {
  picker: ModelPickerState;
  onChange: (next: ModelPickerState) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const q = picker.query.trim().toLowerCase();
  const filtered = q
    ? picker.models.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      )
    : picker.models;
  const toggle = (id: string) => {
    const next = new Set(picker.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...picker, selected: next });
  };
  const setAllFiltered = (on: boolean) => {
    const next = new Set(picker.selected);
    for (const m of filtered) {
      if (on) next.add(m.id);
      else next.delete(m.id);
    }
    onChange({ ...picker, selected: next });
  };
  return (
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-[var(--overlay-modal)]"
      onPointerDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'flex max-h-[72vh] w-[460px] flex-col rounded-[16px]',
          'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        {/* Header */}
        <div className="flex items-center px-5 pb-1 pt-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-15 font-semibold text-[var(--settings-section-title)]">
              {t('settings.providers.custom.fetch.pickerTitle', {
                runtime: t(TAB_META[picker.agent].labelKey),
              })}
            </h3>
            <span className="text-12 text-[var(--text-tertiary)]">
              {t('settings.providers.custom.fetch.pickerCount', {
                selected: picker.selected.size,
                total: picker.models.length,
              })}
            </span>
          </div>
        </div>
        {/* 搜索（项目多才显示）+ 全选/清空（作用于当前过滤结果） */}
        <div className="flex flex-col gap-2 px-5 pt-2">
          {picker.models.length > 8 && (
            <input
              value={picker.query}
              onChange={(e) => onChange({ ...picker, query: e.target.value })}
              placeholder={t('settings.providers.custom.fetch.searchPlaceholder')}
              className={cn(
                'h-[34px] w-full rounded-[9px] px-[11px] text-13 outline-none transition-colors',
                'text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
                'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] focus:border-[var(--settings-input-border-focus)]',
              )}
              style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            />
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setAllFiltered(true)}
              className="text-12 font-medium text-[var(--settings-section-title)] hover:underline"
            >
              {t('settings.providers.custom.fetch.selectAll')}
            </button>
            <button
              type="button"
              onClick={() => setAllFiltered(false)}
              className="text-12 font-medium text-[var(--text-secondary)] hover:underline"
            >
              {t('settings.providers.custom.fetch.clearAll')}
            </button>
          </div>
        </div>
        {/* 列表 */}
        <div className="mt-2 flex-1 overflow-y-auto px-3 pb-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-13 text-[var(--text-tertiary)]">
              {t('settings.providers.custom.fetch.empty')}
            </div>
          ) : (
            filtered.map((m) => {
              const isSelected = picker.selected.has(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  onClick={() => toggle(m.id)}
                  className="flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                      isSelected
                        ? 'border-[var(--settings-input-border-focus)] bg-[var(--surface-elevated)] text-[var(--settings-section-title)]'
                        : 'border-[var(--settings-input-border)] text-transparent',
                    )}
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-13 text-[var(--settings-input-text)]">
                    {m.name}
                  </span>
                  {m.name !== m.id && (
                    <span className="max-w-[45%] truncate text-11 text-[var(--text-tertiary)]">
                      {m.id}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        {/* Footer */}
        <div className="flex justify-end gap-2.5 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'inline-flex items-center justify-center rounded-full border bg-transparent px-5 py-2 text-13 font-medium transition-colors active:scale-[0.98]',
              'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)] hover:bg-[var(--confirm-btn-secondary-hover)]',
            )}
          >
            {t('settings.providers.custom.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={picker.selected.size === 0}
            className={cn(
              'inline-flex items-center justify-center rounded-full px-5 py-2 text-13 font-medium transition-colors active:scale-[0.98]',
              'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]',
              picker.selected.size === 0 && 'cursor-not-allowed opacity-50',
            )}
          >
            {t('settings.providers.custom.fetch.confirm', { count: picker.selected.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
