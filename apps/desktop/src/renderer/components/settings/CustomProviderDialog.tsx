/**
 * CustomProviderDialog —— 自定义供应商「新建 / 编辑」表单弹窗（按 .pen pQrpu/Fxstc 还原）。
 *
 * 结构：顶部「显示名称」(供应商身份,跨 runtime 共享) + Runtime 分段 Tab(Claude Code / Codex)。
 * **每个 Tab 是独立配置**：基础 URL / API 密钥 / 模型 / 请求头 都属于当前 Tab 的那个 runtime。
 * 只配需要的那个,也可两个都配(该来源同时供两端)。至少配一个 Tab。
 *
 * 「提供商 ID」内部句柄由显示名自动 slug 派生 + 去重,对用户隐藏(密钥名/文件名不能含 . 或 /)。
 * 配置经 maker IPC 入 localDb；密钥按 runtime 经 safeStorage 存(见 lib/customProviders)。
 * 编辑态密钥遮罩、留空 = 不改；id 不可改。颜色全走主题 token。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { extractIpcError } from '@/utils/ipcError';
import {
  createCustomProvider,
  readCustomProviderKey,
  replaceCustomProviderModelId,
  updateCustomProvider,
  type RuntimeKeys,
} from '@/lib/customProviders';
import { uniqueCustomProviderId } from '@/lib/customProviderId';
import {
  areProviderRequestUrlsAllowed,
  providerConnectionTestRequestSignature,
  providerModelFetchRequestSignature,
  stripCredentialHeaders,
  type CustomProviderAuthMode,
} from '@/lib/providerModelFetch';
import {
  CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS,
  customProviderCodexWireProtocolOption,
  type CustomProviderCodexWireProtocol,
} from '@/lib/customProviderWireProtocols';

import { isProviderRequestPath, sortPresetsForLocale } from '@cindy/model-providers';
import type {
  AgentKind,
  CustomProviderConfig,
  ProviderPreset,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
} from '@cindy/model-providers';

const AGENTS: AgentKind[] = ['claude-code', 'codex'];

const VISIBLE_AGENTS: AgentKind[] = AGENTS;

const TAB_META: Record<AgentKind, { Mark: typeof ClaudeMark; labelKey: string; helpKey: string }> =
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
  };

interface CustomProviderDialogProps {
  initial?: CustomProviderConfig;
  /** 已占用的全部 provider id（内置 anthropic/openai/xd + 全部自定义）；新建时自动生成 id 时避让，防撞内置保留 id。 */
  existingIds?: string[];
  onSaved: () => void;
  onClose: () => void;
}

type ModelRow = ProviderRuntimeModelConfig;
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

function emptyRuntime(agent: AgentKind): RuntimeFields {
  return {
    baseUrl: '',
    requestPath: '',
    apiKey: '',
    wireProtocol: agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses',
    models: [{ id: '', name: '' }],
    headers: [{ name: '', value: '' }],
    modelsUrl: '',
  };
}

function initRuntimes(initial?: CustomProviderConfig): Record<AgentKind, RuntimeFields> {
  const out: Record<AgentKind, RuntimeFields> = {
    'claude-code': emptyRuntime('claude-code'),
    codex: emptyRuntime('codex'),
  };
  if (initial) {
    for (const a of AGENTS) {
      const rc = initial.runtimes[a];
      if (!rc) continue;
      out[a] = {
        baseUrl: rc.baseUrl,
        requestPath: rc.requestPath ?? '',
        apiKey: '',
        wireProtocol:
          rc.wireProtocol ?? (a === 'claude-code' ? 'anthropic-messages' : 'openai-responses'),
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

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  trailing,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="relative">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'h-[40px] w-full rounded-[10px] pl-[12px] text-14 outline-none transition-colors',
          trailing ? 'pr-9' : 'pr-[12px]',
          'text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
          'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] focus:border-[var(--settings-input-border-focus)]',
        )}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      />
      {trailing}
    </div>
  );
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
}: {
  presets: ProviderPreset[];
  appliedPreset: string | null;
  onApply: (p: ProviderPreset) => void;
  label: string;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = presets.find((p) => p.id === appliedPreset) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
            {selected ? selected.name : placeholder}
          </span>
          <ChevronDown size={16} className="shrink-0 text-[var(--settings-eye-icon)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
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
                  setOpen(false);
                }}
                className={cn(
                  // 菜单项 hover 不加 transition——渐变会让高亮拖尾跟不上指针,菜单应瞬时切换
                  'flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left',
                  'hover:bg-[var(--cmd-palette-item-hover)]',
                  isSelected && 'bg-[var(--cmd-palette-item-hover)]',
                )}
              >
                <span className="truncate text-13 font-medium text-[var(--settings-input-text)]">
                  {p.name}
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
  const [rt, setRt] = useState<Record<AgentKind, RuntimeFields>>(() => initRuntimes(initial));
  const [activeTab, setActiveTab] = useState<AgentKind>(
    () => (initial && VISIBLE_AGENTS.find((a) => initial.runtimes[a])) || 'claude-code',
  );
  const [showKey, setShowKey] = useState(false);
  const [hasKey, setHasKey] = useState<Record<AgentKind, boolean>>({
    'claude-code': false,
    codex: false,
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
  // 预设模板（仅新建态展示；目录 presets 段，随 OSS 热更）。
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);
  // per-runtime 测试连接状态。
  const [test, setTest] = useState<Record<AgentKind, TestState>>({
    'claude-code': IDLE_TEST,
    codex: IDLE_TEST,
  });
  // per-runtime「获取模型列表」进行中标记（按钮瞬态 spinner）。
  const [fetchingModels, setFetchingModels] = useState<Record<AgentKind, boolean>>({
    'claude-code': false,
    codex: false,
  });
  // 拉取成功后的勾选弹层：行集合 = 拉取结果 ∪ 表单已填（后者默认勾选、保留用户显示名）。
  const [picker, setPicker] = useState<{
    agent: AgentKind;
    models: ModelRow[];
    selected: Set<string>;
    query: string;
  } | null>(null);
  // 最新 runtime 表单状态镜像：拉取响应到达时据此构建弹层行/预勾选，而不是用请求发出时的
  // 闭包快照——在途期间被用户删除的行不得复活。镜像在每个 setRt updater 内**同步**更新
  // （见 setRtSynced），不用被动 useEffect——effect 在 commit 后才跑，IPC 响应若落在
  // 状态更新与 effect 之间会读到旧值。
  const rtRef = useRef(rt);
  /** 唯一的 rt 写入口：状态更新的同时同步镜像进 rtRef（updater 幂等，StrictMode 双调无害）。 */
  const setRtSynced = useCallback(
    (fn: (prev: Record<AgentKind, RuntimeFields>) => Record<AgentKind, RuntimeFields>) => {
      setRt((prev) => {
        const next = fn(prev);
        rtRef.current = next;
        return next;
      });
    },
    [],
  );

  // 新建态拉取预设模板（本地 IPC 极快返回；失败静默 —— 没有预设也不影响手填，规则 7 不做 loading）。
  // 区域感知排序：zh-CN 用户国内端点预设靠前、其它语言国际端点靠前（只排序不过滤，
  // 用户不需要理解「地区」概念，可达性由测试连接实测裁决）。
  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    void window.electronAPI.maker
      .listProviderPresets()
      .then((r) => {
        if (!cancelled) setPresets(sortPresetsForLocale(r.presets, i18n.language));
      })
      .catch(() => {
        /* 预设缺失不影响手填 */
      });
    return () => {
      cancelled = true;
    };
  }, [editing, i18n.language]);

  /** 应用预设：预填显示名 + 各 runtime 的 baseUrl / 模型 / headers（创建时快照，之后与预设脱钩）。 */
  const applyPreset = useCallback(
    (p: ProviderPreset) => {
      setAppliedPreset(p.id);
      setName(p.name);
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
            wireProtocol:
              rc.wireProtocol ?? (a === 'claude-code' ? 'anthropic-messages' : 'openai-responses'),
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
      setTest({ 'claude-code': IDLE_TEST, codex: IDLE_TEST });
      const first = AGENTS.find((a) => p.runtimes[a]);
      if (first) setActiveTab(first);
    },
    [setRtSynced],
  );

  // 编辑态：回填各已配置 runtime 的已存明文密钥（用户本机自己的 key）——
  // 让密钥框「能看」(eye 显形 / 可核对)，而非空白遮罩；据此点亮「已保存」徽标。
  useEffect(() => {
    if (!editing || !initial) return;
    let cancelled = false;
    void (async () => {
      const nextHas: Record<AgentKind, boolean> = { 'claude-code': false, codex: false };
      const fetched: Partial<Record<AgentKind, string>> = {};
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
    (agent: AgentKind, fn: (f: RuntimeFields) => RuntimeFields) => {
      setRtSynced((prev) => ({ ...prev, [agent]: fn(prev[agent]) }));
      setTest((prev) => ({ ...prev, [agent]: IDLE_TEST }));
    },
    [setRtSynced],
  );

  /** 切换协议时保留用户已填写的 endpoint，仅使旧测试结果失效。 */
  const changeCodexWireProtocol = useCallback(
    (wireProtocol: CustomProviderCodexWireProtocol) => {
      setRtSynced((prev) => ({
        ...prev,
        codex: { ...prev.codex, wireProtocol },
      }));
      setTest((prev) => ({ ...prev, codex: IDLE_TEST }));
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
    setTest((prev) => ({ ...prev, [agent]: { status: 'testing' } }));
    try {
      const result = await window.electronAPI.maker.testProviderConnection({
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
      });
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
  }, [activeTab, authMode, rt, t]);

  // 拉取单飞：任一 runtime 在途时两个 Tab 的拉取按钮都禁用——两个并发请求会竞争同一个
  // 勾选弹层（后到的覆盖先开的、确认还会写进另一个 runtime），单飞直接消掉这类竞态。
  const anyFetching = fetchingModels['claude-code'] || fetchingModels.codex;

  /** 获取模型列表：用当前 Tab 表单值 GET 列模型端点（key 仅内存透传），成功后开勾选弹层。 */
  const handleFetchModels = useCallback(async () => {
    const agent = activeTab;
    const rf = rt[agent];
    if (fetchingModels['claude-code'] || fetchingModels.codex) return; // 单飞（按钮已禁用，兜底）
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
            return {
              id: m.id,
              name: cur?.name || m.name,
              ...(cur?.contextWindow !== undefined ? { contextWindow: cur.contextWindow } : {}),
              ...(cur?.defaultEnabled === false ? { defaultEnabled: false } : {}),
            };
          }),
        ];
        setPicker({ agent, models: rows, selected: new Set(currentById.keys()), query: '' });
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
  }, [activeTab, authMode, rt, fetchingModels, t]);

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
    patch(picker.agent, (x) => {
      const latestById = new Map<string, ModelRow>();
      for (const m of x.models) {
        const id = m.id.trim();
        if (id && !latestById.has(id)) latestById.set(id, m);
      }
      const merged: ModelRow[] = chosen.map((m) => {
        const latest = latestById.get(m.id);
        const contextWindow = latest?.contextWindow ?? m.contextWindow;
        const defaultEnabled = latest?.defaultEnabled ?? m.defaultEnabled;
        return {
          id: m.id,
          name: latest?.name.trim() ? latest.name.trim() : m.name,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(defaultEnabled === false ? { defaultEnabled: false } : {}),
        };
      });
      for (const m of x.models) {
        const id = m.id.trim();
        if (id && !pickerIds.has(id) && !merged.some((r) => r.id === id)) {
          merged.push({
            id,
            name: m.name.trim() || id,
            ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
            ...(m.defaultEnabled === false ? { defaultEnabled: false } : {}),
          });
        }
      }
      return { ...x, models: merged };
    });
    setPicker(null);
  }, [picker, patch]);

  const handleSave = useCallback(async () => {
    // 校验失败统一走 toast(规则 7:不在弹窗里塞会撑高/缩回的内联错误条,避免布局抖动闪烁)。
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('settings.providers.custom.errors.nameRequired'));
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
      const defaultProtocol = a === 'claude-code' ? 'anthropic-messages' : 'openai-responses';
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
    t,
  ]);

  const keyPlaceholder = hasKey[activeTab]
    ? t('settings.providers.custom.fields.apiKeyEditPlaceholder')
    : t('settings.providers.custom.fields.apiKeyPlaceholder');

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--overlay-modal)]">
      <div
        className={cn(
          'flex max-h-[88vh] w-[600px] flex-col rounded-[16px]',
          'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-3 py-3">
          <div className="flex items-center gap-2.5 pl-2">
            <Sparkles size={20} className="text-[var(--settings-section-title)]" />
            <h2 className="text-18 font-semibold text-[var(--settings-section-title)]">
              {editing
                ? t('settings.providers.custom.dialog.editTitle')
                : t('settings.providers.custom.dialog.createTitle')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.providers.custom.cancel')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body (scrollable) */}
        <div className="flex flex-col gap-[18px] overflow-y-auto px-6 pb-2 pt-1">
          <p className="text-13 leading-[1.55] text-[var(--settings-section-desc)]">
            {t('settings.providers.custom.dialog.desc')}
          </p>

          {/* 预设模板（仅新建态、有预设时显示）：下拉选择，选中即预填 baseUrl / 模型清单，
              用户只补 key。列表已按厂商首字母分组排序（同厂商国内/海外相邻，见 sortPresetsForLocale）。 */}
          {!editing && presets.length > 0 && (
            <div className="flex flex-col gap-2">
              <FieldLabel>{t('settings.providers.custom.presets.label')}</FieldLabel>
              <PresetDropdown
                presets={presets}
                appliedPreset={appliedPreset}
                onApply={applyPreset}
                label={t('settings.providers.custom.presets.label')}
                placeholder={t('settings.providers.custom.presets.placeholder')}
              />
            </div>
          )}

          {/* 显示名称（共享） */}
          <div className="flex flex-col gap-[7px]">
            <FieldLabel>{t('settings.providers.custom.fields.name')}</FieldLabel>
            <TextInput
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
                    setTest({ 'claude-code': IDLE_TEST, codex: IDLE_TEST });
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
                    <TextInput
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
            {activeTab === 'codex' && (
              <div className="flex flex-col gap-[7px]">
                <FieldLabel>{t('settings.providers.custom.fields.wireProtocol')}</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => changeCodexWireProtocol(option.value)}
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
                      {t(option.labelKey)}
                    </button>
                  ))}
                </div>
                <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                  {t(customProviderCodexWireProtocolOption(f.wireProtocol).helpKey)}
                </span>
              </div>
            )}

            {/* 基础 URL */}
            <div className="flex flex-col gap-[7px]">
              <FieldLabel>{t('settings.providers.custom.fields.baseUrl')}</FieldLabel>
              <TextInput
                value={f.baseUrl}
                onChange={(v) => patch(activeTab, (x) => ({ ...x, baseUrl: v }))}
                placeholder={t('settings.providers.custom.fields.baseUrlPlaceholder')}
              />
            </div>

            {/* 精确推理路径：给非标准兼容端点使用；留空仍按所选协议推导。 */}
            <div className="flex flex-col gap-[7px]">
              <FieldLabel>{t('settings.providers.custom.fields.requestPath')}</FieldLabel>
              <TextInput
                value={f.requestPath}
                onChange={(v) => patch(activeTab, (x) => ({ ...x, requestPath: v }))}
                placeholder={
                  activeTab === 'claude-code'
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
                <TextInput
                  value={f.apiKey}
                  onChange={(v) => patch(activeTab, (x) => ({ ...x, apiKey: v }))}
                  placeholder={keyPlaceholder}
                  type={showKey ? 'text' : 'password'}
                  trailing={
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-[12px] top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)] transition-colors hover:text-[var(--settings-eye-icon-hover)]"
                      aria-label={
                        showKey ? t('settings.apiKey.hideKey') : t('settings.apiKey.showKey')
                      }
                    >
                      {showKey ? <Eye size={16} /> : <EyeOff size={16} />}
                    </button>
                  }
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
                    <div key={i} className="flex items-center gap-2">
                      <div className="flex-1">
                        <TextInput
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
                        <TextInput
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
                      <button
                        type="button"
                        onClick={() =>
                          patch(activeTab, (x) => ({
                            ...x,
                            models: x.models.filter((_, j) => j !== i),
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
                        <TextInput
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
                        <TextInput
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
          onChange={setPicker}
          onConfirm={applyPicker}
          onClose={() => setPicker(null)}
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
  picker: { agent: AgentKind; models: ModelRow[]; selected: Set<string>; query: string };
  onChange: (next: {
    agent: AgentKind;
    models: ModelRow[];
    selected: Set<string>;
    query: string;
  }) => void;
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
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-[var(--overlay-modal)]">
      <div
        className={cn(
          'flex max-h-[72vh] w-[460px] flex-col rounded-[16px]',
          'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
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
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.providers.custom.cancel')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            <X size={16} />
          </button>
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
