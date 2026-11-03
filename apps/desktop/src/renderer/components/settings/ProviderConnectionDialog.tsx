import { withSpeechApiPresets } from '../../../shared/speechProviderSetup';
import { ProviderNameSearch } from './ProviderNameSearch';
import { providerSearchChoices, type ProviderSearchTarget } from './providerSearch';
import { useDialogExit } from '@/hooks/useDialogExit';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { providerEndpointBindings, canonicalProviderEndpoint, BUNDLED_CATALOG, mergeModelMetadata } from '@cindy/model-providers';
import { matchOfficialProviders, bindDetectedProvider, isAgentSelectableModel, isLoopbackProviderUrl } from '@cindy/model-providers';
import type { ProviderConnectionTestResult } from '../../../shared/providerConnectionTest';
import type { DetectedProviderDraft, DetectionCatalog } from '../../../shared/providerDetection';
import { OFFICIAL_API_PRESETS } from './AddProviderWizard';
let detectionRequestSequence = 0;
/**
 * Connection credentials and advanced routing only. Model capabilities are imported into the
 * shared catalog and edited through standard model settings. Stored per-runtime credentials,
 * OAuth definitions and user overrides are preserved. Model routes follow endpoint
 * edits while retaining their independent protocol and path overrides.
 */

import * as Dialog from '@radix-ui/react-dialog';
import {
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  CircleHelp,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { FormField } from '@/components/ui/form-field';
import { Tip } from '@/components/ui/tooltip';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import {
  CustomProviderRuntimeFillOverlay,
  type RuntimeFillDialogState,
} from '@/components/settings/CustomProviderRuntimeFillOverlay';
import { extractIpcError } from '@/utils/ipcError';
import {
  createCustomProvider,
  customProviderWireProtocolForSave,
  piCatalogProviderIdAfterRouteEdit,
  readCustomProviderKey,
  updateCustomProvider,
  type RuntimeKeys,
} from '@/lib/customProviders';
import type { CodexImageGenerationRestartPolicy } from '@/../shared/customProviderUpdate';
import { uniqueCustomProviderId } from '@/lib/customProviderId';
import { modelsAfterProviderEndpointEdit } from '@/lib/customProviderEndpointEdit';
import {
  areProviderRequestUrlsAllowed,
  canSendHydratedApiKey,
  connectionTestCanUseSaved,
  modelFetchCanReuseSavedCredentials,
  firstProviderChatModel,
  providerConnectionTestRequestSignature,
  providerModelFetchRequestSignature,
  resolveProviderConnectionProbeRoute,
  restoreHydratedApiKey,
  stripCredentialHeaders,
  type CustomProviderAuthMode,
  type ProviderConnectionTestSignatureFields,
  type SavedProviderProbeBaseline,
} from '@/lib/providerModelFetch';
import {
  CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS,
  customProviderCodexWireProtocolOption,
} from '@/lib/customProviderWireProtocols';
import {
  applyRuntimeFillFields,
  buildRuntimeFillDiffs,
  cloneRuntimeFillDraft,
  mergeHydratedRuntimeKeys,
  normalizeRuntimeFillSelection,
  runtimeFillEndpointUrlsChanged,
  runtimeFillFieldsForToggle,
  runtimeFillHasUnreviewedConflict,
  runtimeFillSelectedTargetChanged,
  runtimeFillTargetAgents,
  type RuntimeFillDraft,
  type RuntimeFillField,
} from '@/lib/customProviderRuntimeFill';

import {
  isProviderRequestPath,
  presetDisplayName,
  sortPresetsForRegion,
} from '@cindy/model-providers';
import type {
  AgentKind,
  CustomProviderConfig,
  ProviderPreset,
  ProviderRuntimeModelConfig,
  ProviderView,
  ProviderWireProtocol,
} from '@cindy/model-providers';
import { SettingsTextInput } from './SettingsTextInput';
import { CURRENT_CINDY_REGION } from '@/../shared/brandRegion';
import {
  configuredPresetAgents,
  isConfiguredPresetRuntime,
} from '@/../shared/piRuntimeInitialization';

/**
 * 本面板配置 claude / codex / pi 三个 runtime。pi 是多协议 harness:BYOM 自定义/本地模型
 * 走 pi 原生 provider 直连(不过 anthropic-compat 代理),故 pi tab 额外提供显式 api 选择器。
 */
type DialogAgentKind = Extract<AgentKind, 'claude-code' | 'codex' | 'pi'>;

const AGENTS: DialogAgentKind[] = ['claude-code', 'codex', 'pi'];

const VISIBLE_AGENTS: DialogAgentKind[] = AGENTS;

const TAB_META: Record<
  DialogAgentKind,
  { Mark: typeof ClaudeMark; labelKey: string; helpKey: string }
> = {
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

function modelTypeLabelKey(mode: string | undefined): string {
  if (mode === 'chat') return 'settings.providers.models.kindFilter.chat';
  const category: Record<string, string> = {
    image_generation: 'image', video_generation: 'video', audio_speech: 'tts',
    audio_transcription: 'stt', audio_generation: 'audio', realtime: 'realtime', embedding: 'embedding',
  };
  return mode && category[mode] ? `newChat.modelSelector.category.${category[mode]}`
    : 'settings.providers.connection.modelTypeAutomatic';
}

function bindAddPageProvider(preset: ProviderPreset, baseUrl: string): ProviderPreset | undefined {
  const runtimes = Object.assign({}, ...AGENTS.map(agent =>
    bindDetectedProvider(preset, agent, baseUrl)?.runtimes ?? {}));
  return Object.keys(runtimes).length ? { ...preset, runtimes } : undefined;
}

interface ProviderConnectionDialogProps {
  draft?: DetectedProviderDraft;
  onDetected?: (draft: DetectedProviderDraft) => void;
  initial?: CustomProviderConfig;
  /** Effective modes from the same connection's active catalog, separate from editable overrides. */
  catalogModels?: ProviderView['models'];
  providers?: ProviderView[];
  suspended?: boolean;
  onSelectProvider?: (target: ProviderSearchTarget) => void;
  /** 已占用的全部 provider id（内置 anthropic/openai/xd + 全部自定义）；新建时自动生成 id 时避让，防撞内置保留 id。 */
  existingIds?: string[];
  /** Stable fallback for transitions whose immediate opener unmounts before this dialog mounts. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  focusAgent?: AgentKind;
  onSaved: () => void;
  onClose: () => void;
}

interface ImageGenerationReloadConfirmation {
  config: CustomProviderConfig;
  keys: RuntimeKeys;
  busyCount: number;
}

type ModelRow = ProviderRuntimeModelConfig;
interface ModelPickerState {
  agent: DialogAgentKind;
  models: ModelRow[];
  selected: Set<string>;
  query: string;
}
type DialogChildLayer =
  | { kind: 'preset-menu' }
  | { kind: 'provider-search' }
  | { kind: 'model-picker'; value: ModelPickerState }
  | null;
interface HeaderRow {
  name: string;
  value: string;
}
interface RuntimeFields extends RuntimeFillDraft {
  models: ModelRow[];
  /** Draft-only provenance: model routes may come from a preset or another runtime. */
  modelRouteBaseUrl?: string;
  headers: HeaderRow[];
  /** 隐藏字段：列模型端点（预设 / 已存配置快照进来），「获取模型列表」用；不在表单展示。 */
  modelsUrl: string;
  /** 隐藏字段：从 Pi 官方目录生成该 runtime；编辑保存必须无损保留。 */
  piCatalogProviderId?: string;
  catalogPresetId?: string;
  /** Codex Responses runtime 级原生图片生成能力。 */
  supportsImageGeneration: boolean;
  /** Standalone Images API, independent of the Codex Responses hosted tool. */
  imageApi?: 'openai-images';
  videoApi?: 'xai-videos';
}

function followsDefaultConnection(agent: DialogAgentKind, value: RuntimeFields, source: RuntimeFields): boolean {
  return value.baseUrl.trim() === source.baseUrl.trim() && value.apiKey === source.apiKey &&
    JSON.stringify(value.headers) === JSON.stringify(source.headers) &&
    JSON.stringify(value.models) === JSON.stringify(source.models) &&
    value.wireProtocol === defaultWireFor(agent) && !value.requestPath && !value.modelsUrl &&
    !value.catalogPresetId && !value.piCatalogProviderId && !value.imageApi && !value.videoApi && !value.supportsImageGeneration;
}

function runtimeProbeFields(
  agent: DialogAgentKind,
  runtime: RuntimeFields,
  catalogModels?: ProviderConnectionTestSignatureFields['catalogModels'],
): RuntimeFields & Pick<ProviderConnectionTestSignatureFields, 'catalogModels'> {
  return {
    ...runtime,
    catalogModels,
    requestPath: agent === 'pi' ? '' : runtime.requestPath,
    models: modelsAfterProviderEndpointEdit(runtime.models, runtime.modelRouteBaseUrl, runtime.baseUrl),
  };
}

function canRuntimeUseNativeImageGeneration(runtime: RuntimeFields): boolean {
  return (
    runtime.wireProtocol === 'openai-responses' ||
    runtime.models.some((model) => model.route?.wireProtocol === 'openai-responses')
  );
}

/**
 * Runtime 表单的唯一图片能力归一化入口。任何编辑一旦移除最后一个 Responses 前门，
 * 立即清掉声明；之后重新加入 Responses 也不会替用户静默恢复，需要显式重新开启。
 */
function normalizeRuntimeImageGenerationCapability(
  agent: DialogAgentKind,
  runtime: RuntimeFields,
): RuntimeFields {
  if (
    agent === 'codex' &&
    runtime.supportsImageGeneration &&
    !canRuntimeUseNativeImageGeneration(runtime)
  ) {
    return { ...runtime, supportsImageGeneration: false };
  }
  return runtime;
}

/** 每个 runtime Tab 的「测试连接」状态（idle → testing → ok/fail）。 */
interface TestState {
  status: 'idle' | 'testing' | 'ok' | 'fail';
  /** 失败分类码（providerError.<code> i18n 键）。 */
  code?: string;
  latencyMs?: number;
  decision?: ProviderConnectionTestResult['decision'];
  attempts?: ProviderConnectionTestResult['attempts'];
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
    piCatalogProviderId: undefined,
    supportsImageGeneration: false,
  };
}

/**
 * 这个 runtime 上是否存在「保存时会悄悄丢掉」的协议选择。
 *
 * 未填写 baseUrl 的 runtime 会被保存逻辑整段跳过（视为未配置）。对打开时就没有端点的
 * runtime，跳过等于丢掉用户刚点选的协议——按钮已高亮、保存返回成功、重开却回到默认。
 * 这种草稿必须报错拦下。
 *
 * 但清空 baseUrl 也是用户移除一个已配置 runtime 的方式；此时丢弃是用户的意图，不能拦。
 * 两者的分界是打开时该 runtime 有没有端点。
 */
function runtimeHasUnsavedProtocolChoice(
  agent: DialogAgentKind,
  runtime: RuntimeFields,
  hadConfiguredEndpoint: boolean,
): boolean {
  return !hadConfiguredEndpoint && runtime.wireProtocol !== defaultWireFor(agent);
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
      out[a] = normalizeRuntimeImageGenerationCapability(a, {
        baseUrl: rc.baseUrl,
        modelRouteBaseUrl: rc.baseUrl,
        requestPath: a === 'pi' ? '' : (rc.requestPath ?? ''),
        apiKey: '',
        wireProtocol: rc.wireProtocol ?? defaultWireFor(a),
        models: rc.models.length ? rc.models.map((m) => ({ ...m })) : [{ id: '', name: '' }],
        headers:
          rc.headers && Object.keys(rc.headers).length > 0
            ? Object.entries(rc.headers).map(([n, v]) => ({ name: n, value: v }))
            : [{ name: '', value: '' }],
        modelsUrl: rc.modelsUrl ?? '',
        piCatalogProviderId: rc.piCatalogProviderId,
        catalogPresetId: rc.catalogPresetId,
        supportsImageGeneration: a === 'codex' && rc.supportsImageGeneration === true,
        imageApi: rc.imageApi,
        videoApi: rc.videoApi,
        headersState: rc.headersState,
      });
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

export function ProviderConnectionDialog({
  draft,
  onDetected,
  initial,
  catalogModels,
  providers = [],
  suspended = false,
  onSelectProvider,
  existingIds,
  returnFocusRef,
  focusAgent,
  onSaved: notifySaved,
  onClose: notifyClosed,
}: ProviderConnectionDialogProps) {
  const { t, i18n } = useTranslation();
  const dialog = useDialogExit(returnFocusRef);
  const suspendedRef = useRef(suspended);
  useLayoutEffect(() => { suspendedRef.current = suspended; }, [suspended]);
  const onClose = useCallback(() => dialog.close(notifyClosed), [dialog.close, notifyClosed]);
  const onSaved = useCallback(() => dialog.close(notifySaved), [dialog.close, notifySaved]);
  const editing = !!initial;
  const simpleAdding = !editing && !!onDetected;
  const [manualOpen, setManualOpen] = useState(false);
  const catalogModelsRef = useRef(catalogModels);
  const initialOAuth = initial?.auth?.method === 'oauth' ? initial.auth.oauth : undefined;

  const formId = useId();
  const fieldId = (key: string) => `${formId}-${key}`;
  const [fieldError, setFieldError] = useState<{ id: string; message: string } | null>(null);
  const errorFor = (key: string) =>
    fieldError?.id === fieldId(key) ? fieldError.message : undefined;
  // UI identity is held outside business drafts and never enters saved configuration.
  const rowIds = useRef(new WeakMap<object, number>());
  const nextRowId = useRef(0);
  const rowId = useCallback((row: object) => {
    let key = rowIds.current.get(row);
    if (key === undefined) {
      key = nextRowId.current++;
      rowIds.current.set(row, key);
    }
    return key;
  }, []);
  const reportFieldError = useCallback(
    (key: string, message: string) => {
      if (key.includes(':manualModel') || key.endsWith(':add-model')) setManualOpen(true);
      if (key.includes(':header:') || key.endsWith(':requestPath') || key.endsWith(':wireProtocol')) setShowAdvanced(true);
      setFieldError({ id: `${formId}-${key}`, message });
    },
    [formId],
  );
  useLayoutEffect(() => {
    if (!fieldError) return;
    const input = document.getElementById(fieldError.id);
    input?.focus();
    input?.scrollIntoView?.({ block: 'nearest' });
  }, [fieldError]);
  const [name, setName] = useState(initial?.name ?? draft?.config.name ?? '');
  const [manualModel, setManualModel] = useState('');
  const [manualModelMode, setManualModelMode] = useState('inherit');
  const [rt, setRt] = useState<Record<DialogAgentKind, RuntimeFields>>(() => {
    const fields = initRuntimes(initial ?? draft?.config);
    if (simpleAdding && !draft) for (const a of AGENTS) fields[a].headers = [];
    if (draft) {
      for (const a of AGENTS) fields[a].apiKey = draft.keys?.[a] ?? (a === draft.agent ? draft.apiKey : '');
      if (simpleAdding) for (const a of AGENTS) if (!draft.config.runtimes[a]) {
        const source = fields[draft.agent as DialogAgentKind];
        fields[a] = { ...fields[a], baseUrl: source.baseUrl, apiKey: source.apiKey,
          headers: source.headers, models: source.models };
      }
    }
    return fields;
  });
  const [activeTab, setActiveTab] = useState<DialogAgentKind>(
    () =>
      draft?.agent ?? (focusAgent && VISIBLE_AGENTS.includes(focusAgent as DialogAgentKind) ? focusAgent as DialogAgentKind : null) ??
      ((initial && VISIBLE_AGENTS.find((a) => initial.runtimes[a])) || (simpleAdding ? 'pi' : 'claude-code')),
  );
  const [hasKey, setHasKey] = useState<Record<DialogAgentKind, boolean>>({
    'claude-code': false,
    codex: false,
    pi: false,
  });
  const [saving, setSaving] = useState(false);
  const [imageGenerationReloadConfirmation, setImageGenerationReloadConfirmation] =
    useState<ImageGenerationReloadConfirmation | null>(null);
  // 鉴权形态：API key（默认）/ OAuth / 无鉴权（本机或受信自托管代理）。
  const [selectedAuthMode, setAuthModeState] = useState<CustomProviderAuthMode>(
    initial?.auth?.method === 'oauth'
      ? 'oauth'
      : (initial ?? draft?.config)?.auth?.method === 'none'
        ? 'none'
        : 'apiKey',
  );
  // The simplified add form has no auth selector. Infer no-auth only for an
  // entirely local, credential-free draft; independent engines must not lose auth.
  // Keep the key input visible so adding credentials switches back to API-key mode.
  const authMode: CustomProviderAuthMode = simpleAdding && selectedAuthMode !== 'oauth'
    ? rt[activeTab].baseUrl.trim() && Object.values(rt).every(fields =>
        !fields.apiKey.trim() && !fields.headers.some(header => header.name.trim()) &&
        (!fields.baseUrl.trim() || isLoopbackProviderUrl(fields.baseUrl.trim())) &&
        (!fields.modelsUrl.trim() || isLoopbackProviderUrl(fields.modelsUrl.trim())))
      ? 'none' : 'apiKey'
    : selectedAuthMode;
  const authModeRef = useRef(authMode);
  authModeRef.current = authMode;
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
  const [showImageGenerationAdvanced, setShowImageGenerationAdvanced] = useState(false);
  const [imageGenerationHelpPinned, setImageGenerationHelpPinned] = useState(false);
  const [imageGenerationHelpHovered, setImageGenerationHelpHovered] = useState(false);
  const [imageGenerationHelpFocused, setImageGenerationHelpFocused] = useState(false);
  // 预设模板（仅新建态展示；目录 presets 段，随 OSS 热更）。
  const [presets, setPresets] = useState<ProviderPreset[]>(() => [...(BUNDLED_CATALOG.presets ?? [])]);
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
  const [runtimeFill, setRuntimeFill] = useState<RuntimeFillDialogState | null>(null);
  const picker = childLayer?.kind === 'model-picker' ? childLayer.value : null;
  const providerChoices = useMemo(() => providerSearchChoices(providers, sortPresetsForRegion(withSpeechApiPresets(presets), CURRENT_CINDY_REGION), i18n.language, t('settings.providers.local.title'), t('settings.providers.llamacpp.title'), OFFICIAL_API_PRESETS), [providers, presets, i18n.language, t]);
  const presetMenuOpen = childLayer?.kind === 'preset-menu';
  const [keyHydrationReady, setKeyHydrationReady] = useState(!editing);
  const [keyHydrationFailed, setKeyHydrationFailed] = useState<Record<DialogAgentKind, boolean>>({
    'claude-code': false,
    codex: false,
    pi: false,
  });
  const runtimeFillTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const imageGenerationHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const imageGenerationHelpPointerLeaveTimerRef = useRef<number | null>(null);
  const imageGenerationHelpFocusPreviewSuppressedRef = useRef(false);
  const imageGenerationHelpPointerPreviewSuppressedRef = useRef(false);
  const imageGenerationHelpPointerInsideRef = useRef(false);
  const imageGenerationHelpPointerSuppressionFrameRef = useRef<number | null>(null);
  const imageGenerationHelpPointerSuppressionGenerationRef = useRef(0);
  const modelFetchInFlightRef = useRef(false);
  const dialogPanelRef = useRef<HTMLDivElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  // 原生 window listener 的生命周期不跟着每次 render 重绑；layout effect 只把
  // 已提交的层状态写入 ref，既避开 passive effect 延迟，也不暴露被放弃的并发 render。
  const childLayerRef = useRef(childLayer);
  const runtimeFillRef = useRef(runtimeFill);
  const savingRef = useRef(saving);
  const imageGenerationReloadConfirmationRef = useRef(imageGenerationReloadConfirmation);
  const onCloseRef = useRef(onClose);
  const showImageGenerationHelp =
    imageGenerationHelpPinned || imageGenerationHelpHovered || imageGenerationHelpFocused;

  const cancelImageGenerationHelpPointerLeave = useCallback(() => {
    if (imageGenerationHelpPointerLeaveTimerRef.current === null) return;
    window.clearTimeout(imageGenerationHelpPointerLeaveTimerRef.current);
    imageGenerationHelpPointerLeaveTimerRef.current = null;
  }, []);
  const cancelImageGenerationHelpPointerSuppression = useCallback(() => {
    imageGenerationHelpPointerSuppressionGenerationRef.current += 1;
    if (imageGenerationHelpPointerSuppressionFrameRef.current !== null) {
      window.cancelAnimationFrame(imageGenerationHelpPointerSuppressionFrameRef.current);
      imageGenerationHelpPointerSuppressionFrameRef.current = null;
    }
    imageGenerationHelpPointerPreviewSuppressedRef.current = false;
  }, []);
  const suppressImageGenerationHelpPointerForExitFrame = useCallback(() => {
    cancelImageGenerationHelpPointerSuppression();
    if (!imageGenerationHelpPointerInsideRef.current) return;
    imageGenerationHelpPointerPreviewSuppressedRef.current = true;
    const generation = imageGenerationHelpPointerSuppressionGenerationRef.current;
    imageGenerationHelpPointerSuppressionFrameRef.current = window.requestAnimationFrame(() => {
      if (imageGenerationHelpPointerSuppressionGenerationRef.current !== generation) return;
      imageGenerationHelpPointerSuppressionFrameRef.current = null;
      imageGenerationHelpPointerPreviewSuppressedRef.current = false;
    });
  }, [cancelImageGenerationHelpPointerSuppression]);
  const closeImageGenerationHelp = useCallback(() => {
    cancelImageGenerationHelpPointerLeave();
    setImageGenerationHelpPinned(false);
    setImageGenerationHelpHovered(false);
    setImageGenerationHelpFocused(false);
  }, [cancelImageGenerationHelpPointerLeave]);
  const resetImageGenerationHelp = useCallback(() => {
    cancelImageGenerationHelpPointerSuppression();
    imageGenerationHelpFocusPreviewSuppressedRef.current = false;
    imageGenerationHelpPointerInsideRef.current = false;
    closeImageGenerationHelp();
  }, [cancelImageGenerationHelpPointerSuppression, closeImageGenerationHelp]);
  const dismissImageGenerationHelp = useCallback(
    (restoreTriggerFocus: boolean) => {
      // Popover 退场和回焦可能在同一物理 focus / hover 周期内再次派发事件。
      // focus 防护延续到真实 blur；pointer 防护仅覆盖指针确实位于交互区时的
      // 退场帧，不能变成等待未来 pointerLeave 才解除的长期闩锁。
      imageGenerationHelpFocusPreviewSuppressedRef.current = true;
      suppressImageGenerationHelpPointerForExitFrame();
      closeImageGenerationHelp();
      if (restoreTriggerFocus) {
        imageGenerationHelpTriggerRef.current?.focus({ preventScroll: true });
      }
    },
    [closeImageGenerationHelp, suppressImageGenerationHelpPointerForExitFrame],
  );
  const previewImageGenerationHelp = useCallback(() => {
    cancelImageGenerationHelpPointerLeave();
    setImageGenerationHelpHovered(true);
  }, [cancelImageGenerationHelpPointerLeave]);
  const scheduleImageGenerationHelpPointerLeave = useCallback(() => {
    cancelImageGenerationHelpPointerLeave();
    imageGenerationHelpPointerLeaveTimerRef.current = window.setTimeout(() => {
      imageGenerationHelpPointerLeaveTimerRef.current = null;
      setImageGenerationHelpHovered(false);
    }, 100);
  }, [cancelImageGenerationHelpPointerLeave]);
  useEffect(() => {
    return () => {
      cancelImageGenerationHelpPointerLeave();
      cancelImageGenerationHelpPointerSuppression();
      imageGenerationHelpFocusPreviewSuppressedRef.current = false;
      imageGenerationHelpPointerInsideRef.current = false;
    };
  }, [cancelImageGenerationHelpPointerLeave, cancelImageGenerationHelpPointerSuppression]);
  useLayoutEffect(() => {
    childLayerRef.current = childLayer;
    runtimeFillRef.current = runtimeFill;
    savingRef.current = saving;
    imageGenerationReloadConfirmationRef.current = imageGenerationReloadConfirmation;
    onCloseRef.current = onClose;
  }, [childLayer, imageGenerationReloadConfirmation, onClose, runtimeFill, saving]);

  // Dismissible form contract:一个关闭输入只结算最上层一次。runtime fill / 模型选择器
  // 优先于预设菜单，最后才是表单；Cancel 仍直接表示用户要关闭表单，且无重复 ×。
  const dismissTopmostLayer = useCallback(() => {
    if (imageGenerationReloadConfirmationRef.current) {
      if (savingRef.current) return;
      imageGenerationReloadConfirmationRef.current = null;
      setImageGenerationReloadConfirmation(null);
      return;
    }
    if (runtimeFillRef.current) {
      runtimeFillRef.current = null;
      setRuntimeFill((current) => (current ? null : current));
      return;
    }
    const activeLayer = childLayerRef.current;
    if (activeLayer) {
      // 同一事件周期内先同步更新 owner，避免快速连续输入重复结算旧层。
      childLayerRef.current = null;
      setChildLayer((current) => (current === activeLayer ? null : current));
      return;
    }
    if (savingRef.current) return;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (suspended) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // IME 候选窗的 Escape 是组合输入控制，不是弹层关闭意图。
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (imageGenerationReloadConfirmationRef.current) {
        event.preventDefault();
        event.stopPropagation();
        dismissTopmostLayer();
        return;
      }
      if (showImageGenerationHelp) {
        event.preventDefault();
        event.stopPropagation();
        dismissImageGenerationHelp(true);
        return;
      }
      // 在 Radix 的 document capture 之前由唯一 owner 结算；否则菜单的 80ms
      // 退场层仍可能 preventDefault，吞掉刚打开的模型选择器的 Escape。
      event.preventDefault();
      event.stopPropagation();
      dismissTopmostLayer();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dismissImageGenerationHelp, dismissTopmostLayer, showImageGenerationHelp, suspended]);

  // 最新 runtime 表单状态镜像：拉取响应到达时据此构建弹层行/预勾选，而不是用请求发出时的
  // 闭包快照——在途期间被用户删除的行不得复活。镜像在每个 setRt updater 内**同步**更新
  // （见 setRtSynced），不用被动 useEffect——effect 在 commit 后才跑，IPC 响应若落在
  // 状态更新与 effect 之间会读到旧值。
  const rtRef = useRef(rt);
  useLayoutEffect(() => {
    const previousCatalogModels = catalogModelsRef.current;
    catalogModelsRef.current = catalogModels;
    const changedAgents = AGENTS.filter(agent =>
      firstProviderChatModel(rtRef.current[agent].models, previousCatalogModels?.[agent])?.id !==
      firstProviderChatModel(rtRef.current[agent].models, catalogModels?.[agent])?.id);
    if (changedAgents.length) setTest(previous => {
      const next = { ...previous };
      for (const agent of changedAgents) next[agent] = IDLE_TEST;
      return next;
    });
  }, [catalogModels]);
  /** 唯一的 rt 写入口：状态更新的同时同步镜像进 rtRef（updater 幂等，StrictMode 双调无害）。 */
  const setRtSynced = useCallback(
    (
      fn: (prev: Record<DialogAgentKind, RuntimeFields>) => Record<DialogAgentKind, RuntimeFields>,
    ) => {
      setRt((prev) => {
        const updated = { ...fn(prev) };
        // The add page edits one default connection. Keep independently configured
        // draft fields, but let untouched engines follow this connection.
        if (simpleAdding) {
          const source = activeTab;
          for (const agent of AGENTS) {
            if (agent === source || !followsDefaultConnection(agent, prev[agent], prev[source])) continue;
            const next = { ...updated[agent] };
            for (const field of ['baseUrl', 'apiKey', 'headers', 'models'] as const) {
              if (JSON.stringify(prev[agent][field]) === JSON.stringify(prev[source][field]) &&
                  JSON.stringify(updated[agent][field]) === JSON.stringify(prev[agent][field])) {
                Object.assign(next, { [field]: updated[source][field] });
              }
            }
            updated[agent] = next;
          }
        }
        const normalized = Object.fromEntries(
          AGENTS.map((agent) => [
            agent,
            normalizeRuntimeImageGenerationCapability(agent, updated[agent]),
          ]),
        ) as Record<DialogAgentKind, RuntimeFields>;
        // Do not consume the catalog marker while the user is still editing.
        // A temporary route/model change can be reverted before Save; marker
        // ownership is decided once below from the persisted baseline and the
        // final serialized values.
        for (const agent of AGENTS) {
          for (const kind of ['models', 'headers'] as const) {
            const before = prev[agent][kind];
            const after = normalized[agent][kind];
            if (before.length !== after.length) continue;
            after.forEach((row, index) => {
              if (!rowIds.current.has(row)) rowIds.current.set(row, rowId(before[index]));
            });
          }
        }
        rtRef.current = normalized;
        return normalized;
      });
    },
    [rowId, simpleAdding, activeTab],
  );

  // 编辑态回填的已存明文 key(按 agent);测试连接据此判定凭证材料是否被改动。
  const loadedKeyRef = useRef<Record<DialogAgentKind, string>>({
    'claude-code': '',
    codex: '',
    pi: '',
  });
  // A late safeStorage response must not overwrite a key edited or copied while
  // hydration was in flight. Revisions only change for explicit key mutations.
  const keyEditRevisionRef = useRef<Record<DialogAgentKind, number>>({
    'claude-code': 0,
    codex: 0,
    pi: 0,
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
        requestPath: agent === 'pi' ? '' : (rc.requestPath ?? ''),
        modelsUrl: rc.modelsUrl ?? '',
        wireProtocol: rc.wireProtocol ?? defaultWireFor(agent),
        authMode: savedAuthMode,
        apiKey: loadedKeyRef.current[agent] ?? '',
        ...(agent === 'pi'
          ? { modelPiApi: firstProviderChatModel(rc.models, catalogModels?.[agent])?.piApi }
          : {}),
        modelRoute: firstProviderChatModel(rc.models, catalogModels?.[agent])?.route,
        modelApi: firstProviderChatModel(rc.models, catalogModels?.[agent])?.api,
        catalogPresetId: rc.catalogPresetId,
        headers:
          rc.headers && Object.keys(rc.headers).length > 0
            ? Object.entries(rc.headers).map(([n, v]) => ({ name: n, value: v }))
            : [],
      };
    },
    [editing, initial, catalogModels],
  );

  // URL edits temporarily clear an untouched hydrated key so it cannot be
  // sent to a new endpoint. If the user returns to the saved credential
  // target before editing the key, restore the in-memory hydration instead of
  // forcing an unnecessary re-entry (or sending apiKey: null to model fetch).
  const restoreHydratedKey = useCallback(
    (agent: DialogAgentKind, draft: RuntimeFields): RuntimeFields => {
      const savedBaseline = savedBaselineFor(agent);
      if (!savedBaseline) return draft;
      return restoreHydratedApiKey(
        draft,
        { ...savedBaseline, apiKey: loadedKeyRef.current[agent] },
        authModeRef.current,
        keyEditRevisionRef.current[agent],
      );
    },
    [savedBaselineFor],
  );

  const changeAuthMode = useCallback(
    (mode: CustomProviderAuthMode) => {
      setAuthMode(mode);
      if (mode !== 'apiKey') return;
      setRtSynced(
        (prev) =>
          Object.fromEntries(
            AGENTS.map((agent) => [agent, restoreHydratedKey(agent, prev[agent])]),
          ) as Record<DialogAgentKind, RuntimeFields>,
      );
    },
    [restoreHydratedKey, setRtSynced],
  );

  // 新建和编辑态拉取预设模板（本地 IPC 极快返回；失败静默 —— 没有预设也不影响手填，规则 7 不做 loading）。
  // 按实际构建区域排序，不随 UI 语言变化（只排序不过滤，可达性由测试连接实测裁决）。
  useEffect(() => {
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
          if (!isConfiguredPresetRuntime(a, rc)) {
            next[a] = emptyRuntime(a);
            continue;
          }
          next[a] = {
            baseUrl: rc.baseUrl,
            modelRouteBaseUrl: rc.baseUrl,
            requestPath: a === 'pi' ? '' : (rc.requestPath ?? ''),
            apiKey: prev[a].apiKey, // 已填的 key 保留
            wireProtocol: rc.wireProtocol ?? defaultWireFor(a),
            models: rc.models.length
              ? rc.models.map((m) => ({
                  id: m.id,
                  name: m.name,
                  discoveredMetadata: {},
                  ...(m.mode ? { mode: m.mode } : {}),
                  ...(m.modalities ? { modalities: { input: [...m.modalities.input], output: [...m.modalities.output] } } : {}),
                  ...(m.officialDocs ? { officialDocs: m.officialDocs } : {}),
                  ...(m.interfaceId ? { interfaceId: m.interfaceId } : {}),
                  ...(m.api ? { api: m.api } : {}),
                  ...(m.piApi ? { piApi: m.piApi } : {}),
                  ...(m.route ? { route: m.route } : {}),
                }))
              : [{ id: '', name: '' }],
            headers:
              rc.headers && Object.keys(rc.headers).length > 0
                ? Object.entries(rc.headers).map(([n, v]) => ({ name: n, value: v }))
                : [{ name: '', value: '' }],
            modelsUrl: rc.modelsUrl ?? '',
            piCatalogProviderId: rc.piCatalogProviderId,
            catalogPresetId: p.id,
            supportsImageGeneration: a === 'codex' && rc.supportsImageGeneration === true,
          };
        }
        return next;
      });
      setTest({ 'claude-code': IDLE_TEST, codex: IDLE_TEST, pi: IDLE_TEST });
      // 预设整体替换所有 runtime 的 models 数组(含清空未声明的 runtime),旧行号
      // 全部失效——不清空的话陈旧草稿(如 -5)会挂在无关的新行、或挂在被预设清空
      // 的 runtime 上,handleSave 的守卫拦不住"用户已经看不到"的这条草稿,表单
      // 卡死报错却找不到对应输入框(review P1)。
      const first = configuredPresetAgents(p)[0];
      if (first) setActiveTab(first);
      // 预设整体替换名称/鉴权/全部 runtime:任何既有字段错误的指向(字段值、
      // 行结构、tab)都已失效。程序化赋值不触发输入的 change,须在此显式清除
      // (review P1)。
      setFieldError(null);
    },
    [i18n.language, setRtSynced],
  );

  const [detection, setDetection] = useState<{ signature: string; preset?: ProviderPreset; pending?: boolean; ambiguous?: boolean; code?: string } | null>(null);
  const discoveryCache = useRef(new Map<DialogAgentKind, { signature: string; promise: Promise<DetectionCatalog> }>(
    draft?.catalog ? [[draft.agent, { signature: `${draft.agent}:${providerModelFetchRequestSignature(rt[draft.agent], authMode)}`,
      promise: Promise.resolve(draft.catalog) }]] : [],
  ));
  const importedOnce = useRef(new Set<DialogAgentKind>(draft ? [draft.agent] : []));
  const detectionSignature = `${activeTab}:${providerModelFetchRequestSignature(rt[activeTab], authMode)}`;
  const detectionContext = useRef({ name, activeTab, onDetected, signature: detectionSignature });
  const previousDetectionSignatures = useRef(new Map<DialogAgentKind, string>());
  detectionContext.current = { name, activeTab, onDetected, signature: detectionSignature };

  const enterDetectedProvider = useCallback((preset: ProviderPreset) => {
    if (savingRef.current || childLayerRef.current || runtimeFillRef.current || connectionTestRef.current) return;
    const context = detectionContext.current;
    const sourceAgent = context.activeTab;
    const fields = rtRef.current[sourceAgent];
    const agent = preset.runtimes[sourceAgent] ? sourceAgent : AGENTS.find(a =>
      preset.runtimes[a] && followsDefaultConnection(a, rtRef.current[a], fields));
    if (!agent) return;
    const runtimes: CustomProviderConfig['runtimes'] = {};
    const keys: Partial<Record<AgentKind, string>> = {};
    for (const a of AGENTS) {
      const value = rtRef.current[a];
      if (!value.baseUrl.trim()) continue;
      const inherits = followsDefaultConnection(a, value, fields);
      if (!preset.runtimes[a] && inherits) continue;
      keys[a] = value.apiKey;
      runtimes[a] = { baseUrl: value.baseUrl.trim(), models: value.models.filter(m => m.id.trim()),
        wireProtocol: customProviderWireProtocolForSave(a, value.wireProtocol, defaultWireFor(a)),
        headers: Object.fromEntries(value.headers.filter(h => h.name.trim()).map(h => [h.name.trim(), h.value])),
        ...(value.requestPath ? { requestPath: value.requestPath } : {}),
        ...(value.modelsUrl.trim() ? { modelsUrl: value.modelsUrl.trim() } : {}),
        ...(value.catalogPresetId ? { catalogPresetId: value.catalogPresetId } : {}),
        ...(value.piCatalogProviderId ? { piCatalogProviderId: value.piCatalogProviderId } : {}),
        ...(value.imageApi ? { imageApi: value.imageApi } : {}),
        ...(value.videoApi ? { videoApi: value.videoApi } : {}),
        ...(a === 'codex' && value.supportsImageGeneration && canRuntimeUseNativeImageGeneration(value) ? { supportsImageGeneration: true } : {}),
      };
    }
    const bound: ProviderPreset = { ...preset, authMethod: authModeRef.current === 'none' ? 'none' : 'apiKey',
      runtimes: Object.fromEntries(AGENTS.flatMap(a => {
        const runtime = preset.runtimes[a];
        if (!runtime) return [];
        const value = rtRef.current[a];
        const independent = a !== sourceAgent && !followsDefaultConnection(a, value, fields);
        // The existing wizard has one shared key. Never enroll independent
        // drafts into its fetch/save loop; they remain in config/keys untouched.
        if (independent) return [];
        // Inherited connections use each engine's provider defaults.
        return [[a, { ...runtime,
          headers: { ...runtime.headers, ...runtimes[a]?.headers },
          ...(value.requestPath ? { requestPath: value.requestPath } : {}),
          ...(value.modelsUrl.trim() ? { modelsUrl: value.modelsUrl.trim() } : {}),
          ...(runtimes[a]?.supportsImageGeneration ? { supportsImageGeneration: true } : {}),
          ...(value.wireProtocol !== defaultWireFor(a) || runtimes[a]?.supportsImageGeneration ? { wireProtocol: value.wireProtocol } : {}),
        }]];
      })),
    };
    // The cache is settled before announcing a match; no credentials enter saved detection data.
    const cache = discoveryCache.current.get(sourceAgent);
    void (cache?.signature === context.signature ? cache.promise : Promise.resolve(undefined)).then(catalog => {
      if (detectionContext.current.signature !== context.signature || savingRef.current || childLayerRef.current || runtimeFillRef.current) return;
      context.onDetected?.({ preset: bound, agent, apiKey: fields.apiKey, keys, catalog,
        config: { id: 'draft', name: context.name, auth: { method: bound.authMethod ?? 'apiKey' }, runtimes } });
    });
  }, []);

  useEffect(() => {
    if (editing || !onDetected || authMode === 'oauth' || saving || !dialog.open) return;
    let live = true;
    // Correlation only, scoped to this renderer; randomUUID requires a secure context.
    const requestId = `detect-${Date.now()}-${++detectionRequestSequence}`;
    const agent = activeTab;
    const fields = rt[agent];
    const signature = detectionSignature;
    const previousSignature = previousDetectionSignatures.current.get(agent);
    previousDetectionSignatures.current.set(agent, signature);
    if (previousSignature && previousSignature !== signature) {
      setRtSynced(prev => ({ ...prev, [agent]: { ...prev[agent], models: prev[agent].models.map(model => {
        const { discoveredMetadata: _metadata, discoveredCost: _cost, ...userFields } = model;
        return userFields;
      }) } }));
    }
    setDetection(null);
    const timer = setTimeout(() => {
      if (modelFetchInFlightRef.current || !fields.baseUrl.trim() || !areProviderRequestUrlsAllowed(authMode, fields.baseUrl)) return;
      if (draft?.catalog && discoveryCache.current.get(agent)?.signature === signature) {
        setDetection({ signature });
        return;
      }
      setDetection({ signature, pending: true });
      const all = [...presets, ...Object.values(OFFICIAL_API_PRESETS).filter(p => !presets.some(existing => existing.id === p.id))];
      const official = matchOfficialProviders(fields.baseUrl.trim(), all);
      const headers = Object.fromEntries(fields.headers.filter(h => h.name.trim()).map(h => [h.name.trim(), h.value]));
      const spec = { agent, baseUrl: fields.baseUrl.trim(), apiKey: fields.apiKey.trim() || null,
        authMethod: authMode, headers, wireProtocol: fields.wireProtocol };
      const work = (async () => {
        if (official.length) {
          const preset = official.length === 1 ? bindAddPageProvider(official[0], spec.baseUrl) : undefined;
          if (!preset) return { preset, ambiguous: official.length > 1, catalog: undefined };
          const fetchAgent = preset.runtimes[agent] ? agent : AGENTS.find(a =>
            preset.runtimes[a] && followsDefaultConnection(a, rtRef.current[a], fields));
          if (!fetchAgent) return { preset: undefined, catalog: undefined };
          const runtime = preset.runtimes[fetchAgent]!;
          const catalog = await window.electronAPI.maker.fetchProviderModels({ ...spec, agent: fetchAgent,
            allowEmpty: true, redirect: 'error',
            baseUrl: runtime.baseUrl, modelsUrl: fields.modelsUrl.trim() || runtime.modelsUrl, wireProtocol: runtime.wireProtocol ?? defaultWireFor(fetchAgent),
            headers: { ...runtime.headers, ...headers } });
          return { preset, catalog };
        }
        const result = await window.electronAPI.maker.detectProvider?.({ ...spec, requestId });
        const preset = result?.candidates.length === 1 ? all.find(p => p.id === result.candidates[0]) : undefined;
        return { preset: preset && bindAddPageProvider(preset, spec.baseUrl), catalog: result?.catalog, ambiguous: result?.reason === 'conflict' };
      })().catch(() => ({ preset: undefined, catalog: undefined, ambiguous: false }));
      discoveryCache.current.set(agent, { signature, promise: work.then(r => r.catalog ?? { ok: false }) });
      void work.then(({ preset, catalog, ambiguous }) => {
        if (!live || detectionContext.current.signature !== signature) return;
        if (catalog?.ok && catalog.models) {
          const first = !importedOnce.current.has(agent);
          importedOnce.current.add(agent);
          setRtSynced(prev => ({ ...prev, [agent]: { ...prev[agent], models: [
            ...prev[agent].models.filter(m => m.id.trim()).map(model => {
              const fresh = catalog.models!.find(m => m.id === model.id);
              // Refresh discovered facts after credentials/endpoint changes, without
              // replacing explicit overrides or reselecting models the user removed.
              return fresh ? { ...model,
                discoveredMetadata: fresh.discoveredMetadata ?? { contextWindow: fresh.contextWindow },
                discoveredCost: fresh.discoveredCost,
              } : model;
            }),
            ...(first ? catalog.models!.filter(m => !prev[agent].models.some(row => row.id === m.id) && isAgentSelectableModel({ id: m.id, mode: m.discoveredMetadata?.mode })).map(m => ({
              id: m.id, name: m.name, discoveredMetadata: m.discoveredMetadata ?? { contextWindow: m.contextWindow }, discoveredCost: m.discoveredCost,
            })) : []),
          ] } }));
        }
        if (preset && !AGENTS.some(a => preset!.runtimes[a] &&
            (a === agent || followsDefaultConnection(a, rtRef.current[a], rtRef.current[agent])))) preset = undefined;
        setDetection({ signature, preset, ambiguous, code: catalog && !catalog.ok ? (catalog.code ?? 'UNKNOWN') : undefined });
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
      void window.electronAPI.maker.detectProvider?.({ requestId, cancel: true }).catch(() => undefined);
    };
    // A model selection/name change is not a new connection or a reason to restart detection.
  }, [detectionSignature, presets, editing, authMode, saving, dialog.open, !!onDetected, setRtSynced]);

  // 编辑态：回填各已配置 runtime 的已存明文密钥（用户本机自己的 key）——
  // 让密钥框「能看」(eye 显形 / 可核对)，而非空白遮罩；据此点亮「已保存」徽标。
  // 鉴权请求头是 main-only 密文,不回读进表单;未显式改动时由 main 侧 update 保留旧值。
  useEffect(() => {
    if (!editing || !initial) {
      setKeyHydrationReady(true);
      return;
    }
    let cancelled = false;
    setKeyHydrationReady(false);
    setKeyHydrationFailed({ 'claude-code': false, codex: false, pi: false });
    const revisionAtStart = { ...keyEditRevisionRef.current };
    void (async () => {
      const nextHas: Record<DialogAgentKind, boolean> = {
        'claude-code': false,
        codex: false,
        pi: false,
      };
      const fetched: Partial<Record<DialogAgentKind, string>> = {};
      const failed: Record<DialogAgentKind, boolean> = {
        'claude-code': false,
        codex: false,
        pi: false,
      };
      for (const a of AGENTS) {
        if (!initial.runtimes[a]) continue;
        let k: string | null = null;
        try {
          k = await readCustomProviderKey(initial.id, a);
        } catch {
          failed[a] = true;
        }
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
      setRtSynced((prev) =>
        mergeHydratedRuntimeKeys(
          prev,
          fetched,
          Object.fromEntries(
            AGENTS.flatMap((agent) => {
              const baseline = savedBaselineFor(agent);
              return baseline
                ? [[agent, { baseUrl: baseline.baseUrl, modelsUrl: baseline.modelsUrl }] as const]
                : [];
            }),
          ),
          revisionAtStart,
          keyEditRevisionRef.current,
        ),
      );
      setKeyHydrationFailed(failed);
      setKeyHydrationReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [editing, initial, savedBaselineFor]);

  const patch = useCallback(
    (agent: DialogAgentKind, fn: (f: RuntimeFields) => RuntimeFields) => {
      setRtSynced((prev) => {
        const current = prev[agent];
        const next = restoreHydratedKey(agent, fn(current));
        const endpointChanged =
          current.baseUrl.trim() !== next.baseUrl.trim() ||
          current.modelsUrl.trim() !== next.modelsUrl.trim();
        return {
          ...prev,
          [agent]:
            endpointChanged &&
            keyEditRevisionRef.current[agent] === 0 &&
            next.apiKey === current.apiKey
              ? { ...next, apiKey: '' }
              : next,
        };
      });
      setTest((prev) => ({ ...prev, [agent]: IDLE_TEST }));
    },
    [restoreHydratedKey, setRtSynced],
  );

  const openRuntimeFill = useCallback(() => {
    if (modelFetchInFlightRef.current || picker) {
      toast.info(t('settings.providers.custom.runtimeFill.modelsBusy'));
      return;
    }
    const source = activeTab;
    const usesApiKey = authModeRef.current === 'apiKey';
    if (usesApiKey && !keyHydrationReady) {
      toast.info(t('settings.providers.custom.runtimeFill.loadingKeys'));
      return;
    }
    if (usesApiKey && AGENTS.some((agent) => keyHydrationFailed[agent])) {
      toast.info(t('settings.providers.custom.runtimeFill.keysUnavailable'));
      return;
    }
    const includeApiKey = usesApiKey;

    const oauthPiUnavailable = authModeRef.current === 'oauth' && source !== 'pi';
    const sourceFields = rtRef.current[source];
    const sourceDraft = cloneRuntimeFillDraft({
      ...sourceFields,
      models: modelsAfterProviderEndpointEdit(
        sourceFields.models, sourceFields.modelRouteBaseUrl, sourceFields.baseUrl,
      ),
    });
    const allTargets = runtimeFillTargetAgents(source, {
      includePi: authModeRef.current !== 'oauth',
    }).map((agent) => ({
      agent,
      draft: cloneRuntimeFillDraft(rtRef.current[agent]),
      diffs: buildRuntimeFillDiffs(sourceDraft, rtRef.current[agent], {
        includeApiKey,
        sourceAgent: source,
        targetAgent: agent,
      }),
    }));
    if (!allTargets.some((target) => target.diffs.length > 0)) {
      toast.info(t('settings.providers.custom.runtimeFill.nothingToFill'));
      return;
    }
    const targets = allTargets.filter((target) =>
      target.diffs.some((diff) => diff.targetState !== 'same'),
    );
    if (targets.length === 0) {
      toast.info(t('settings.providers.custom.runtimeFill.alreadySame'));
      return;
    }
    if (
      !targets.some((target) =>
        target.diffs.some(
          (diff) => diff.targetState === 'empty' || diff.targetState === 'conflict',
        ),
      )
    ) {
      toast.info(t('settings.providers.custom.runtimeFill.noCompatibleFields'));
      return;
    }

    const selected: Partial<Record<DialogAgentKind, RuntimeFillField[]>> = {};
    for (const target of targets) {
      selected[target.agent] = normalizeRuntimeFillSelection(
        target.diffs
          .filter((diff) => diff.targetState === 'empty' || diff.targetState === 'conflict')
          .map((diff) => diff.field),
        target.diffs,
      );
    }
    childLayerRef.current = null;
    setChildLayer(null);
    setRuntimeFill({
      source,
      sourceDraft,
      includeApiKey,
      oauthPiUnavailable,
      stage: 'review',
      targets,
      selected,
    });
  }, [activeTab, keyHydrationFailed, keyHydrationReady, picker, t]);

  const applyRuntimeFill = useCallback(() => {
    if (!runtimeFill) return;
    const changedTargets = runtimeFill.targets.filter(
      (target) => (runtimeFill.selected[target.agent]?.length ?? 0) > 0,
    );
    if (changedTargets.length === 0) return;

    // Re-read targets immediately before applying. Background async work should not
    // turn an empty field into an unconfirmed overwrite after the review snapshot.
    const freshTargets = runtimeFill.targets.map((target) => {
      const draft = cloneRuntimeFillDraft(rtRef.current[target.agent]);
      return {
        ...target,
        draft,
        diffs: buildRuntimeFillDiffs(runtimeFill.sourceDraft, draft, {
          includeApiKey: runtimeFill.includeApiKey,
          sourceAgent: runtimeFill.source,
          targetAgent: target.agent,
        }),
      };
    });
    const hasUnreviewedConflict = freshTargets.some((target) => {
      const previous = runtimeFill.targets.find((candidate) => candidate.agent === target.agent);
      const selectedFields = runtimeFill.selected[target.agent] ?? [];
      return (
        runtimeFillHasUnreviewedConflict(previous?.diffs ?? [], target.diffs, selectedFields) ||
        (previous != null &&
          runtimeFillSelectedTargetChanged(
            previous.draft,
            target.draft,
            selectedFields,
            target.agent,
          ))
      );
    });
    if (hasUnreviewedConflict) {
      setRuntimeFill((prev) =>
        prev ? { ...prev, stage: 'confirm', targets: freshTargets } : prev,
      );
      return;
    }

    for (const target of changedTargets) {
      if (runtimeFill.selected[target.agent]?.includes('apiKey')) {
        keyEditRevisionRef.current[target.agent] += 1;
      }
    }
    setRtSynced((prev) => {
      const next = { ...prev };
      for (const target of changedTargets) {
        const selectedFields = runtimeFill.selected[target.agent] ?? [];
        const filled = applyRuntimeFillFields(
          prev[target.agent],
          runtimeFill.sourceDraft,
          selectedFields,
          { sourceAgent: runtimeFill.source, targetAgent: target.agent },
        );
        const endpointChanged = runtimeFillEndpointUrlsChanged(prev[target.agent], filled);
        const endpointSafeFilled =
          endpointChanged &&
          !selectedFields.includes('apiKey') &&
          keyEditRevisionRef.current[target.agent] === 0
            ? { ...filled, apiKey: '' }
            : filled;
        const restored = restoreHydratedKey(target.agent, {
          ...prev[target.agent],
          ...endpointSafeFilled,
          ...(selectedFields.includes('models')
            ? { modelRouteBaseUrl: runtimeFill.sourceDraft.baseUrl }
            : {}),
        });
        next[target.agent] = restored;
      }
      return next;
    });
    setTest((prev) => {
      const next = { ...prev };
      for (const target of changedTargets) next[target.agent] = IDLE_TEST;
      return next;
    });
    toast.success(
      t('settings.providers.custom.runtimeFill.filledToast', {
        targets: new Intl.ListFormat(i18n.language, {
          style: 'short',
          type: 'conjunction',
        }).format(changedTargets.map((target) => t(TAB_META[target.agent].labelKey))),
      }),
    );
    setRuntimeFill(null);
  }, [i18n.language, restoreHydratedKey, runtimeFill, setRtSynced, t]);

  const continueRuntimeFill = useCallback(() => {
    if (!runtimeFill) return;
    const hasOverwrite = runtimeFill.targets.some((target) =>
      target.diffs.some(
        (diff) =>
          diff.targetState === 'conflict' &&
          (runtimeFill.selected[target.agent]?.includes(diff.field) ?? false),
      ),
    );
    if (hasOverwrite) setRuntimeFill((prev) => (prev ? { ...prev, stage: 'confirm' } : prev));
    else applyRuntimeFill();
  }, [applyRuntimeFill, runtimeFill]);

  const toggleRuntimeFillField = useCallback((agent: DialogAgentKind, field: RuntimeFillField) => {
    setRuntimeFill((prev) => {
      if (!prev) return prev;
      const target = prev.targets.find((candidate) => candidate.agent === agent);
      if (!target) return prev;
      const current = prev.selected[agent] ?? [];
      const toggledFields = runtimeFillFieldsForToggle(field, target.diffs);
      const allSelected = toggledFields.every((candidate) => current.includes(candidate));
      const nextFields = allSelected
        ? current.filter((candidate) => !toggledFields.includes(candidate))
        : normalizeRuntimeFillSelection([...current, ...toggledFields], target.diffs);
      return { ...prev, selected: { ...prev.selected, [agent]: nextFields } };
    });
  }, []);

  /** 切换协议时保留用户已填写的 endpoint，仅使旧测试结果失效。 */
  const changeWireProtocol = useCallback(
    (agent: DialogAgentKind, wireProtocol: ProviderWireProtocol) => {
      setRtSynced((prev) => prev[agent].catalogPresetId || prev[agent].wireProtocol === wireProtocol ? prev : ({
        ...prev,
        [agent]: {
          ...prev[agent],
          wireProtocol,
          requestPath: '',
        },
      }));
      setTest((prev) => ({ ...prev, [agent]: IDLE_TEST }));
    },
    [setRtSynced],
  );

  const f = rt[activeTab];
  const mediaOnly = f.models.some(model => model.id.trim()) && !firstProviderChatModel(f.models, catalogModels?.[activeTab]);
  const boundPreset = presets.find(preset => preset.id === f.catalogPresetId);
  const templateBound = Boolean(f.catalogPresetId);
  const endpointTemplate = boundPreset?.runtimes[activeTab]?.baseUrl;
  // 只有 Pi runtime 的端点对用户开放改写；Claude / Codex 的模板绑定端点保持只读。
  const fixedTemplateEndpoint = activeTab !== 'pi' && templateBound && !endpointTemplate?.includes('{');
  // Google inference and discovery already resolve to this native endpoint. The old
  // compatibility base remains stored as a template reference, never an editable choice.
  const displayedBaseUrl = fixedTemplateEndpoint && f.catalogPresetId === 'google-gemini-api'
    ? resolveProviderConnectionProbeRoute(activeTab, f, presets)?.baseUrl ?? f.baseUrl : f.baseUrl;
  const canShowImageGenerationAdvanced =
    activeTab === 'codex' && canRuntimeUseNativeImageGeneration(f);
  useEffect(() => {
    if (canShowImageGenerationAdvanced && showImageGenerationAdvanced) return;
    resetImageGenerationHelp();
  }, [canShowImageGenerationAdvanced, resetImageGenerationHelp, showImageGenerationAdvanced]);

  // Account/location edits must stay within the declared endpoint template.
  const matchesEndpointTemplate = useCallback((agent: DialogAgentKind, fields: RuntimeFields) => {
    const template = presets.find(preset => preset.id === fields.catalogPresetId)?.runtimes[agent]?.baseUrl;
    return !template?.includes('{') || providerEndpointBindings(template, fields.baseUrl.trim()) !== null;
  }, [presets]);

  const connectionTestRef = useRef<{ id: string; agent: DialogAgentKind; signature: string } | null>(null);
  const connectionSignature = providerConnectionTestRequestSignature(runtimeProbeFields(activeTab, rt[activeTab], catalogModels?.[activeTab]), authMode);
  const cancelConnectionTest = useCallback(() => {
    const current = connectionTestRef.current;
    if (!current) return;
    connectionTestRef.current = null;
    void window.electronAPI.maker.testProviderConnection({ kind: 'cancel', requestId: current.id }).catch(() => undefined);
  }, []);
  useLayoutEffect(() => {
    const current = connectionTestRef.current;
    if (current && (!dialog.open || current.agent !== activeTab || current.signature !== connectionSignature)) {
      cancelConnectionTest();
      setTest(previous => ({ ...previous, [current.agent]: IDLE_TEST }));
    }
  }, [activeTab, connectionSignature, dialog.open, cancelConnectionTest]);
  useEffect(() => () => cancelConnectionTest(), [cancelConnectionTest]);

  const handleTest = useCallback(async () => {
    if (connectionTestRef.current || modelFetchInFlightRef.current || picker) return;
    const agent = activeTab;
    const rf = rt[agent];
    const probeFields = runtimeProbeFields(agent, rf, catalogModels?.[agent]);
    const defaultBaseUrl = rf.baseUrl.trim();
    const firstModelConfig = firstProviderChatModel(rf.models, catalogModels?.[agent]);
    const firstModel = firstModelConfig?.id.trim();
    if (!matchesEndpointTemplate(agent, rf)) {
      toast.error(t('settings.providers.custom.errors.baseUrlInvalid'));
      return;
    }
    if (!defaultBaseUrl || !firstModel) {
      toast.error(t('settings.providers.custom.test.needFields'));
      return;
    }
    const probeRoute = resolveProviderConnectionProbeRoute(agent, probeFields, presets);
    if (!probeRoute) {
      toast.error(t('settings.providers.custom.test.unsupportedProtocol'));
      return;
    }
    const { baseUrl, wireProtocol: probeWireProtocol, requestPath: probeRequestPath } = probeRoute;
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
    const requestSig = providerConnectionTestRequestSignature(probeFields, authMode);
    // 编辑态且端点/协议/鉴权模式与凭证材料相对已存配置都未改动时,走受控 saved 探测:
    // 它整体按已存 spec 发起,能带上不回读进表单的 main-only 密文鉴权头(否则纯密文头
    // 供应商会因缺头而失败)。任一改动则回落 adhoc,测用户新填的值。
    const savedBaseline = savedBaselineFor(agent);
    const canSendApiKey =
      authMode !== 'apiKey' ||
      !savedBaseline ||
      canSendHydratedApiKey(
        probeFields,
        savedBaseline,
        authMode,
        keyEditRevisionRef.current[agent],
      );
    const useSaved = Boolean(
      initial?.id &&
      savedBaseline &&
      connectionTestCanUseSaved(probeFields, savedBaseline, authMode),
    );
    const originalModel = draft?.config.runtimes[agent]?.models.find(model => model.id.trim() === firstModel);
    const automatic = simpleAdding && agent === 'pi' && !rf.catalogPresetId && !rf.requestPath
      && !originalModel?.api && !originalModel?.piApi && !originalModel?.route;
    const cancellable = simpleAdding && agent === 'pi' && !rf.catalogPresetId
      && (!probeRoute.api || ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(probeRoute.api));
    const requestId = cancellable ? 'connection-' + Date.now() + '-' + (++detectionRequestSequence) : undefined;
    if (requestId) {
      connectionTestRef.current = { id: requestId, agent, signature: requestSig };
    }
    setTest((prev) => ({ ...prev, [agent]: { status: 'testing' } }));
    try {
      const result = await window.electronAPI.maker.testProviderConnection(
        useSaved
          ? { kind: 'saved', providerId: initial!.id, agent }
          : {
              kind: 'adhoc',
              ...(requestId ? { requestId, ...(automatic ? { strategy: 'auto' as const } : {}) } : {}),
              spec: {
                agent,
                baseUrl,
                modelId: firstModel,
                authMethod: authMode,
                wireProtocol: probeWireProtocol,
                ...(!automatic && probeRoute.api ? { api: probeRoute.api } : {}),
                ...(rf.catalogPresetId ? { catalogPresetId: rf.catalogPresetId } : {}),
                ...(probeRequestPath ? { requestPath: probeRequestPath } : {}),
                apiKey: authMode === 'apiKey' && canSendApiKey ? rf.apiKey.trim() || null : null,
                ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
              },
            },
      );
      if (requestId && connectionTestRef.current?.id !== requestId) return;
      if (
        providerConnectionTestRequestSignature(
          runtimeProbeFields(agent, rtRef.current[agent], catalogModelsRef.current?.[agent]),
          authModeRef.current,
        ) !== requestSig
      )
        return;
      if (requestId) connectionTestRef.current = null;
      if (result.decision === 'cancelled') {
        setTest(previous => ({ ...previous, [agent]: IDLE_TEST }));
        return;
      }
      if (automatic && result.ok && result.selected) {
        const selected = result.selected;
        const api = selected.wireProtocol === 'openai-chat' ? 'openai-completions' as const : selected.wireProtocol;
        setRtSynced(previous => ({ ...previous, [agent]: { ...previous[agent],
          baseUrl: selected.baseUrl, modelRouteBaseUrl: selected.baseUrl, wireProtocol: selected.wireProtocol, requestPath: '',
          models: previous[agent].models.map(model => model.id.trim() === firstModel
            ? { ...model, api, piApi: api, route: { baseUrl: selected.baseUrl, wireProtocol: selected.wireProtocol } } : model),
        } }));
      }
      setTest((prev) => ({
        ...prev,
        [agent]: result.ok
          ? { status: 'ok', latencyMs: result.latencyMs }
          : { status: 'fail', code: result.code ?? 'UNKNOWN', decision: result.decision, attempts: result.attempts },
      }));
    } catch (e) {
      if (requestId && connectionTestRef.current?.id !== requestId) return;
      if (
        providerConnectionTestRequestSignature(
          runtimeProbeFields(agent, rtRef.current[agent], catalogModelsRef.current?.[agent]),
          authModeRef.current,
        ) !== requestSig
      )
        return;
      if (requestId) connectionTestRef.current = null;
      const ipc = extractIpcError(e);
      setTest((prev) => ({ ...prev, [agent]: { status: 'fail', code: 'UNKNOWN' } }));
      if (ipc?.message) toast.error(ipc.message);
    }
  }, [activeTab, authMode, rt, t, savedBaselineFor, initial, presets, matchesEndpointTemplate, catalogModels, simpleAdding, setRtSynced, picker, draft]);

  // 拉取单飞：任一 runtime（含 Pi）在途时所有 Tab 的拉取按钮都禁用——两个并发请求会竞争
  // 同一个勾选弹层（后到的覆盖先开的、确认还会写进另一个 runtime），单飞直接消掉这类竞态。
  const anyFetching = fetchingModels['claude-code'] || fetchingModels.codex || fetchingModels.pi;

  /** 获取模型列表：用当前 Tab 表单值 GET 列模型端点（key 仅内存透传），成功后开勾选弹层。 */
  const handleFetchModels = useCallback(async () => {
    const agent = activeTab;
    const rf = rt[agent];
    if (
      modelFetchInFlightRef.current ||
      runtimeFill ||
      picker ||
      fetchingModels['claude-code'] ||
      fetchingModels.codex ||
      fetchingModels.pi
    )
      return; // 单飞（按钮已禁用，兜底）
    const baseUrl = rf.baseUrl.trim();
    if (!baseUrl) {
      toast.error(t('settings.providers.custom.fetch.needBaseUrl'));
      return;
    }
    if (!matchesEndpointTemplate(agent, rf) || !areProviderRequestUrlsAllowed(authMode, baseUrl, rf.modelsUrl)) {
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
    const canSendApiKey =
      authMode !== 'apiKey' ||
      !savedBaseline ||
      canSendHydratedApiKey(rf, savedBaseline, authMode, keyEditRevisionRef.current[agent]);
    const reuseSaved = Boolean(
      initial?.id &&
      savedBaseline &&
      modelFetchCanReuseSavedCredentials(rf, savedBaseline, authMode),
    );
    modelFetchInFlightRef.current = true;
    setFetchingModels((prev) => ({ ...prev, [agent]: true }));
    try {
      const cached = !editing ? discoveryCache.current.get(agent) : undefined;
      const cachedResult = cached?.signature === `${agent}:${requestSig}` ? await cached.promise : undefined;
      if (providerModelFetchRequestSignature(rtRef.current[agent], authModeRef.current) !== requestSig) return;
      const result = cachedResult?.ok ? cachedResult : await window.electronAPI.maker.fetchProviderModels({
        allowEmpty: !editing,
        agent,
        baseUrl,
        authMethod: authMode,
        ...(rf.wireProtocol ? { wireProtocol: rf.wireProtocol } : {}),
        modelsUrl: rf.modelsUrl.trim() || null,
        apiKey: authMode === 'apiKey' && canSendApiKey ? rf.apiKey.trim() || null : null,
        ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
        ...(reuseSaved ? { savedProviderId: initial!.id } : {}),
      });
      if (
        providerModelFetchRequestSignature(rtRef.current[agent], authModeRef.current) !== requestSig
      )
        return; // 过期响应，静默丢弃
      if (result.ok && result.models) {
        if (!editing) discoveryCache.current.set(agent, { signature: `${agent}:${requestSig}`, promise: Promise.resolve(result) });
        // 用**响应到达时**的最新表单行构建弹层（rtRef），不是请求发出时的 rf 快照。
        const current = rtRef.current[agent].models
          .map((m) => ({
            id: m.id.trim(),
            name: m.name.trim(),
            mode: m.mode,
            nativeApi: m.nativeApi,
            modalities: m.modalities,
            officialDocs: m.officialDocs,
            discoveredMetadata: m.discoveredMetadata,
          discoveredCost: m.discoveredCost,
            nameExplicit: m.nameExplicit,
            ...(m.interfaceId ? { interfaceId: m.interfaceId } : {}),
          ...(m.api ? { api: m.api } : {}),
          ...(agent === 'pi' && m.piApi ? { piApi: m.piApi } : {}),
            ...(m.route ? { route: { ...m.route } } : {}),
            ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
            ...(typeof m.defaultEnabled === 'boolean' ? { defaultEnabled: m.defaultEnabled } : {}),
            ...(m.supportsImageInput !== undefined
              ? { supportsImageInput: m.supportsImageInput }
              : {}),
            ...(m.reasoning !== undefined
              ? {
                  reasoning: m.reasoning,
                  reasoningEfforts: [...(m.reasoningEfforts ?? [])],
                  ...(m.reasoningDefaultEffort
                    ? { reasoningDefaultEffort: m.reasoningDefaultEffort }
                    : {}),
                }
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
            const contextWindow = cur?.contextWindow;
            return {
              id: m.id,
              name: cur?.name || m.name,
              discoveredMetadata: mergeModelMetadata(cur?.discoveredMetadata,
                m.discoveredMetadata ?? { contextWindow: m.contextWindow }),
              discoveredCost: m.discoveredCost,
              mode: cur?.mode,
              nativeApi: cur?.nativeApi,
              modalities: cur?.modalities,
              officialDocs: cur?.officialDocs,
              nameExplicit: cur ? (cur.nameExplicit ?? !cur.discoveredMetadata) : undefined,
              ...(cur?.interfaceId ? { interfaceId: cur.interfaceId } : {}),
              ...(cur?.api ? { api: cur.api } : {}),
              ...(agent === 'pi' && cur?.piApi ? { piApi: cur.piApi } : {}),
              ...(cur?.route ? { route: { ...cur.route } } : {}),
              ...(contextWindow !== undefined ? { contextWindow } : {}),
              ...(typeof cur?.defaultEnabled === 'boolean' ? { defaultEnabled: cur.defaultEnabled } : {}),
              ...(cur?.supportsImageInput !== undefined
                ? { supportsImageInput: cur.supportsImageInput }
                : {}),
              ...(cur?.reasoning !== undefined
                ? {
                    reasoning: cur.reasoning,
                    reasoningEfforts: [...(cur.reasoningEfforts ?? [])],
                    ...(cur.reasoningDefaultEffort
                      ? { reasoningDefaultEffort: cur.reasoningDefaultEffort }
                      : {}),
                  }
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
      modelFetchInFlightRef.current = false;
      setFetchingModels((prev) => ({ ...prev, [agent]: false }));
    }
  }, [activeTab, authMode, rt, fetchingModels, initial, picker, runtimeFill, savedBaselineFor, t, matchesEndpointTemplate]);

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
      const interfaceId = latest ? latest.interfaceId : m.interfaceId;
      const api = latest ? latest.api : m.api;
      const piApi = latest ? latest.piApi : m.piApi;
      const reasoningDefaultEffort = latest
        ? latest.reasoningDefaultEffort
        : m.reasoningDefaultEffort;
      return {
        id: m.id,
        name: latest?.name.trim() ? latest.name.trim() : m.name,
        mode: latest ? latest.mode : m.mode,
        nativeApi: latest ? latest.nativeApi : m.nativeApi,
        modalities: latest?.modalities ?? m.modalities,
        officialDocs: latest?.officialDocs ?? m.officialDocs,
        discoveredMetadata: m.discoveredMetadata ?? latest?.discoveredMetadata,
        discoveredCost: m.discoveredCost ?? latest?.discoveredCost,
        nameExplicit: latest?.nameExplicit ?? m.nameExplicit,
        ...(interfaceId ? { interfaceId } : {}),
        ...(api ? { api } : {}),
        ...(picker.agent === 'pi' && piApi ? { piApi } : {}),
        ...((latest?.route ?? m.route) ? { route: { ...(latest?.route ?? m.route)! } } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(typeof defaultEnabled === 'boolean' ? { defaultEnabled } : {}),
        ...(supportsImageInput !== undefined ? { supportsImageInput } : {}),
        ...(reasoning !== undefined
          ? {
              reasoning,
              reasoningEfforts: [...(reasoningEfforts ?? [])],
              ...(reasoningDefaultEffort ? { reasoningDefaultEffort } : {}),
            }
          : {}),
      };
    });
    for (const m of previousModels) {
      const id = m.id.trim();
      if (id && !pickerIds.has(id) && !merged.some((r) => r.id === id)) {
        merged.push({
          id,
          name: m.name.trim() || id,
          mode: m.mode,
          nativeApi: m.nativeApi,
          modalities: m.modalities,
          officialDocs: m.officialDocs,
          discoveredMetadata: m.discoveredMetadata,
          discoveredCost: m.discoveredCost,
          nameExplicit: m.nameExplicit,
          ...(m.interfaceId ? { interfaceId: m.interfaceId } : {}),
          ...(m.api ? { api: m.api } : {}),
          ...(picker.agent === 'pi' && m.piApi ? { piApi: m.piApi } : {}),
          ...(m.route ? { route: { ...m.route } } : {}),
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
          ...(typeof m.defaultEnabled === 'boolean' ? { defaultEnabled: m.defaultEnabled } : {}),
          ...(m.supportsImageInput !== undefined
            ? { supportsImageInput: m.supportsImageInput }
            : {}),
          ...(m.reasoning !== undefined
            ? {
                reasoning: m.reasoning,
                reasoningEfforts: [...(m.reasoningEfforts ?? [])],
                ...(m.reasoningDefaultEffort
                  ? { reasoningDefaultEffort: m.reasoningDefaultEffort }
                  : {}),
              }
            : {}),
        });
      }
    }
    patch(picker.agent, (x) => ({ ...x, models: merged }));
    setChildLayer((current) =>
      current?.kind === 'model-picker' && current.value === picker ? null : current,
    );
  }, [picker, patch]);

  const handleSave = useCallback(async () => {
    if (savingRef.current || connectionTestRef.current) return;
    setFieldError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      reportFieldError('name', t('settings.providers.custom.errors.nameRequired'));
      return;
    }
    if (initial?.auth?.native) {
      setSaving(true);
      try {
        await updateCustomProvider({ ...initial, name: trimmedName }, {});
        onSaved();
      } catch { toast.error(t('settings.providers.custom.toast.saveFailed')); }
      finally { setSaving(false); }
      return;
    }
    if (editing && authMode === 'apiKey' && !keyHydrationReady) {
      toast.info(t('settings.providers.custom.runtimeFill.loadingKeys'));
      return;
    }
    if (editing && authMode === 'apiKey') {
      const failedEndpointEdit = VISIBLE_AGENTS.find((agent) => {
        if (!keyHydrationFailed[agent]) return false;
        const baseline = savedBaselineFor(agent);
        const draft = rt[agent];
        return (
          baseline != null &&
          (draft.baseUrl.trim() !== baseline.baseUrl.trim() ||
            draft.modelsUrl.trim() !== baseline.modelsUrl.trim())
        );
      });
      if (failedEndpointEdit) {
        setActiveTab(failedEndpointEdit);
        toast.error(t('settings.providers.custom.runtimeFill.keysUnavailable'));
        return;
      }
    }
    const runtimes: CustomProviderConfig['runtimes'] = {};
    const keys: RuntimeKeys = {};
    for (const a of VISIBLE_AGENTS) {
      const rf = rt[a];
      // 上游规则：pi 目录预选时，仍跟随默认连接、未独立配置的 runtime 整段跳过。
      if (simpleAdding && activeTab === 'pi' && !rt.pi.catalogPresetId && a !== 'pi'
        && (!draft?.config.runtimes[a] || followsDefaultConnection(a, rf, rt.pi))) continue;
      if (!rf.baseUrl.trim()) {
        // 未配置的 runtime 整段跳过。但用户若已在这里选过协议，跳过即静默丢弃该选择；
        // 要求补全基础 URL，让「改了协议却没保存上」变成一个看得见的错误。
        if (
          runtimeHasUnsavedProtocolChoice(
            a,
            rf,
            Boolean(initial?.runtimes[a]?.baseUrl.trim()),
          )
        ) {
          setActiveTab(a);
          reportFieldError(`${a}:baseUrl`, t('settings.providers.custom.errors.baseUrlRequired'));
          return;
        }
        continue; // 该 runtime 未配置
      }
      try {
        const u = new URL(rf.baseUrl.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          setActiveTab(a);
          reportFieldError(`${a}:baseUrl`, t('settings.providers.custom.errors.baseUrlInvalid'));
          return;
        }
      } catch {
        setActiveTab(a);
        reportFieldError(`${a}:baseUrl`, t('settings.providers.custom.errors.baseUrlInvalid'));
        return;
      }
      if (!areProviderRequestUrlsAllowed(authMode, rf.baseUrl, rf.modelsUrl)) {
        setActiveTab(a);
        reportFieldError(`${a}:baseUrl`, t('settings.providers.custom.errors.baseUrlInvalid'));
        return;
      }
      if (!matchesEndpointTemplate(a, rf)) {
        setActiveTab(a);
        reportFieldError(`${a}:baseUrl`, t('settings.providers.custom.errors.baseUrlInvalid'));
        return;
      }
      const models = modelsAfterProviderEndpointEdit(rf.models, rf.modelRouteBaseUrl, rf.baseUrl)
        .map((m) => ({
          id: m.id.trim(),
          name: m.name.trim(),
          mode: m.mode,
          nativeApi: m.nativeApi,
          modalities: m.modalities,
          officialDocs: m.officialDocs,
          discoveredMetadata: m.discoveredMetadata,
          discoveredCost: m.discoveredCost,
          nameExplicit: m.nameExplicit,
          ...(m.interfaceId ? { interfaceId: m.interfaceId } : {}),
          ...(m.api ? { api: m.api } : {}),
          ...(a === 'pi' && m.piApi ? { piApi: m.piApi } : {}),
          ...(m.route ? { route: { ...m.route } } : {}),
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
          ...(typeof m.defaultEnabled === 'boolean' ? { defaultEnabled: m.defaultEnabled } : {}),
          ...(m.supportsImageInput !== undefined
            ? { supportsImageInput: m.supportsImageInput }
            : {}),
          ...(m.reasoning !== undefined
            ? {
                reasoning: m.reasoning,
                reasoningEfforts: [...(m.reasoningEfforts ?? [])],
                ...(m.reasoningDefaultEffort
                  ? { reasoningDefaultEffort: m.reasoningDefaultEffort }
                  : {}),
              }
            : {}),
        }))
        .filter((m) => m.id && m.name);
      const requestPath = a === 'pi' ? '' : rf.requestPath.trim();
      if (requestPath && !isProviderRequestPath(requestPath)) {
        setActiveTab(a);
        reportFieldError(
          `${a}:requestPath`,
          t('settings.providers.custom.errors.requestPathInvalid'),
        );
        return;
      }
      // OAuth 形态模型可留空——授权成功后自动发现并持久化（与内置订阅统一）。
      if (models.length === 0 && authMode !== 'oauth') {
        setManualOpen(true);
        setActiveTab(a);
        reportFieldError(
          `${a}:manualModel`,
          t('settings.providers.custom.errors.modelRequired'),
        );
        return;
      }
      const headers: Record<string, string> = {};
      for (const h of rf.headers) {
        const n = h.name.trim();
        if (n) headers[n] = h.value.trim();
      }
      const savedHeaders = authMode === 'none' ? stripCredentialHeaders(headers) : headers;
      const defaultProtocol = defaultWireFor(a);
      const savedWireProtocol = customProviderWireProtocolForSave(
        a,
        rf.wireProtocol,
        defaultProtocol,
      );
      const endpointTemplate = presets.find(preset => preset.id === rf.catalogPresetId)?.runtimes[a]?.baseUrl;
      const typedBaseUrl = rf.baseUrl.trim();
      const baseUrl = endpointTemplate?.includes('{')
        ? canonicalProviderEndpoint(endpointTemplate, typedBaseUrl) ?? typedBaseUrl
        : typedBaseUrl;
      runtimes[a] = {
        baseUrl,
        ...(rf.catalogPresetId ? { catalogPresetId: rf.catalogPresetId } : {}),
        ...(requestPath ? { requestPath } : {}),
        ...(savedWireProtocol ? { wireProtocol: savedWireProtocol } : {}),
        ...(a === 'codex' && rf.supportsImageGeneration && canRuntimeUseNativeImageGeneration(rf)
          ? { supportsImageGeneration: true }
          : {}),
        ...(rf.imageApi ? { imageApi: rf.imageApi } : {}),
        ...(rf.videoApi ? { videoApi: rf.videoApi } : {}),
        models,
        ...(Object.keys(savedHeaders).length > 0 ? { headers: savedHeaders } : {}),
        ...(rf.modelsUrl.trim() ? { modelsUrl: rf.modelsUrl.trim() } : {}),
        ...(a === 'pi' && rf.piCatalogProviderId
          ? { piCatalogProviderId: rf.piCatalogProviderId }
          : {}),
      };
      if (a === 'pi' && initial?.runtimes.pi?.piCatalogProviderId) {
        const savedPiCatalogProviderId = piCatalogProviderIdAfterRouteEdit(
          a,
          initial.runtimes.pi,
          runtimes.pi!,
        );
        if (savedPiCatalogProviderId) {
          runtimes.pi!.piCatalogProviderId = savedPiCatalogProviderId;
        } else {
          delete runtimes.pi!.piCatalogProviderId;
        }
      }
      // OAuth 形态不收集 per-runtime API key（鉴权走 Runner 的 Bearer）。
      if (
        authMode === 'apiKey' &&
        rf.apiKey.trim() &&
        (!editing || keyEditRevisionRef.current[a] > 0)
      ) {
        keys[a] = rf.apiKey.trim();
      }
    }
    if (Object.keys(runtimes).length === 0) {
      reportFieldError(
        `${activeTab}:baseUrl`,
        t('settings.providers.custom.errors.runtimeRequired'),
      );
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
        !httpsOk(flowUrl) ||
        !httpsOk(tokenUrl)
      ) {
        const invalid =
          !flowUrl || !httpsOk(flowUrl)
            ? oauthFlow === 'device-code'
              ? 'deviceAuthorizationUrl'
              : 'authorizeUrl'
            : !tokenUrl || !httpsOk(tokenUrl)
              ? 'tokenUrl'
              : 'clientId';
        reportFieldError(`oauth:${invalid}`, t('settings.providers.custom.errors.oauthInvalid'));
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
    savingRef.current = true;
    setSaving(true);
    try {
      if (editing) {
        const result = await updateCustomProvider(config, keys, { source: 'manual-settings' });
        if (result?.ok === false) {
          setImageGenerationReloadConfirmation({ config, keys, busyCount: result.busyCount });
          savingRef.current = false;
          setSaving(false);
          return;
        }
        toast.success(t('settings.providers.custom.toast.updated'));
      } else {
        const result = await createCustomProvider(config, keys, { source: 'manual-settings' });
        if (result?.ok === false) {
          setImageGenerationReloadConfirmation({ config, keys, busyCount: result.busyCount });
          savingRef.current = false;
          setSaving(false);
          return;
        }
        toast.success(t('settings.providers.custom.toast.created'));
      }
      // 成功:onSaved 关闭弹窗(父级 setDialog(null) 卸载本组件)。不在此 setSaving(false)——
      // 让按钮维持 spinner 直到卸载,避免「spinner→普通态」闪一帧(规则 7)。
      onSaved();
    } catch (e) {
      const ipc = extractIpcError(e);
      toast.error(ipc?.message ?? t('settings.providers.custom.toast.saveFailed'));
      savingRef.current = false;
      setSaving(false); // 仅失败时复位:弹窗仍在,允许改后重试
    }
  }, [
    name,
    activeTab,
    simpleAdding,
    draft,
    rowId,
    reportFieldError,
    keyHydrationReady,
    rt,
    authMode,
    oauthFlow,
    oauthFields,
    initialOAuth,
    editing,
    initial,
    existingIds,
    matchesEndpointTemplate,
    onSaved,
    keyHydrationFailed,
    showAdvanced,
    savedBaselineFor,
    t,
  ]);

  const saveWithImageGenerationRestartPolicy = useCallback(
    async (policy: CodexImageGenerationRestartPolicy) => {
      const pending = imageGenerationReloadConfirmationRef.current;
      if (!pending || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        const options = {
          source: 'manual-settings' as const,
          codexImageGenerationRestartPolicy: policy,
        };
        const result = editing
          ? await updateCustomProvider(pending.config, pending.keys, options)
          : await createCustomProvider(pending.config, pending.keys, options);
        if (result.ok === false) {
          const next = { ...pending, busyCount: result.busyCount };
          imageGenerationReloadConfirmationRef.current = next;
          setImageGenerationReloadConfirmation(next);
          savingRef.current = false;
          setSaving(false);
          return;
        }
        toast.success(
          t(
            editing
              ? 'settings.providers.custom.toast.updated'
              : 'settings.providers.custom.toast.created',
          ),
        );
        onSaved();
      } catch (error) {
        const ipc = extractIpcError(error);
        toast.error(ipc?.message ?? t('settings.providers.custom.toast.saveFailed'));
        savingRef.current = false;
        setSaving(false);
      }
    },
    [editing, onSaved, t],
  );

  const detectionAuthFailed = !editing && detection?.signature === detectionSignature &&
    authMode === 'apiKey' && detection.code === 'AUTH_INVALID';
  const detectionKeyMissing = detectionAuthFailed && !f.apiKey.trim();

  const activeSavedBaseline = savedBaselineFor(activeTab);
  // 共享判据：当前表单的端点相对已存基线是否未变。密钥与请求头都只在
  // 端点未变时继续有效——main 侧改端点后会清掉已存头，renderer 的徽标
  // 必须同步消失，否则继续宣称「已配置」会误导用户。
  const activeSavedEndpointUnchanged =
    activeSavedBaseline != null &&
    f.baseUrl.trim() === activeSavedBaseline.baseUrl.trim() &&
    f.modelsUrl.trim() === activeSavedBaseline.modelsUrl.trim();
  const activeKeyCanRemainSaved = hasKey[activeTab] && activeSavedEndpointUnchanged;
  // 已存密文头徽标的判据：端点未变 + 仍是 apiKey 鉴权（none 模式会剥凭证头）
  // + 确实配置过头。headersState 是不可变初值，端点一变就必须隐藏。
  const activeHeadersCanRemainSaved =
    initial?.runtimes[activeTab]?.headersState === 'configured' &&
    authMode === 'apiKey' &&
    activeSavedEndpointUnchanged;
  const keyPlaceholder = activeKeyCanRemainSaved
    ? t('settings.providers.custom.fields.apiKeyEditPlaceholder')
    : t('settings.providers.custom.fields.apiKeyPlaceholder');

  const renderImageGenerationHelpContent = () => {
    const idPrefix = 'custom-provider-image-generation-help';
    return (
      <div className="flex flex-col gap-3">
        <section aria-labelledby={`${idPrefix}-condition`} className="flex flex-col gap-1">
          <div
            id={`${idPrefix}-condition`}
            className="text-12 font-semibold text-[var(--text-primary)]"
          >
            {t('settings.providers.custom.fields.runtimeSupportsImageGenerationConditionTitle')}
          </div>
          <p className="leading-5">
            {t('settings.providers.custom.fields.runtimeSupportsImageGenerationCondition')}
          </p>
        </section>
        <section aria-labelledby={`${idPrefix}-endpoints`} className="flex flex-col gap-1">
          <div
            id={`${idPrefix}-endpoints`}
            className="text-12 font-semibold text-[var(--text-primary)]"
          >
            {t('settings.providers.custom.fields.runtimeSupportsImageGenerationEndpointsTitle')}
          </div>
          <p className="leading-5">
            {t('settings.providers.custom.fields.runtimeSupportsImageGenerationEndpoints')}
          </p>
          <div className="flex flex-col items-start gap-1.5">
            <code className="max-w-full break-all rounded-md bg-[var(--surface-chip)] px-2 py-1 font-mono text-11 leading-4 text-[var(--text-primary)]">
              /images/generations
            </code>
            <code className="max-w-full break-all rounded-md bg-[var(--surface-chip)] px-2 py-1 font-mono text-11 leading-4 text-[var(--text-primary)]">
              /images/edits
            </code>
          </div>
        </section>
        <section aria-labelledby={`${idPrefix}-permissions`} className="flex flex-col gap-1">
          <div
            id={`${idPrefix}-permissions`}
            className="text-12 font-semibold text-[var(--text-primary)]"
          >
            {t('settings.providers.custom.fields.runtimeSupportsImageGenerationPermissionsTitle')}
          </div>
          <p className="leading-5">
            {t('settings.providers.custom.fields.runtimeSupportsImageGenerationPermissions')}
          </p>
        </section>
      </div>
    );
  };

  if (suspended) return null;

  return (
    <Dialog.Root open={dialog.open} onOpenChange={(open) => { if (!open) dismissTopmostLayer(); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-custom-provider-dialog-scrim="true"
          className="modal-scrim fixed inset-0 z-[10000]"
          style={WINDOW_DRAG_STYLE}
        />
      <Dialog.Content
        ref={dialogPanelRef}
        aria-describedby={undefined}
        aria-labelledby="custom-provider-dialog-title"
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          dialog.onOpenAutoFocus();
          event.preventDefault();
          dialogPanelRef.current?.querySelector<HTMLInputElement>('input')?.focus();
        }}
        onCloseAutoFocus={event => { if (suspendedRef.current) event.preventDefault(); else dialog.onCloseAutoFocus(event); }}
        onEscapeKeyDown={(event) => {
          // The existing window-capture owner handles child layers and IME first.
          event.preventDefault();
        }}
        style={WINDOW_NO_DRAG_STYLE}
        onChangeCapture={(event) => {
          // 错误清除粒度(review P2/P1 双向约束):
          // - 报错字段自身被编辑时清除——改其它字段(名称/密钥/别的 runtime 行)
          //   不得清掉当前字段的错误提示与 aria-invalid,保留到再次保存重新校验;
          // - 例外是列表级错误(`${agent}:add-model`,模型列表为空,提示挂在
          //   「添加模型」按钮旁、不依赖任何行存在):用户点该按钮新增行并填写
          //   内容时,change 目标是新行输入而非按钮本身,这条填空路径正是对
          //   列表错误的修正,须同步清除,否则提示要滞留到再次保存。
          const target = event.target;
          if (!(target instanceof HTMLElement) || !fieldError) return;
          if (target.id === fieldError.id) {
            setFieldError(null);
            return;
          }
          const key = fieldError.id.slice(formId.length + 1);
          const agent = key.slice(0, key.indexOf(':'));
          if (
            key === `${agent}:add-model` &&
            target.id.startsWith(`${formId}-${agent}:model:`)
          ) {
            setFieldError(null);
          }
        }}
        className={cn(
          'modal-panel fixed inset-0 z-[10000] m-auto flex h-fit max-h-[88vh] w-[min(600px,calc(100vw-32px))] flex-col outline-none',
          '[&_button:focus-visible]:outline-none [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-[var(--focus-ring)]',
        )}
      >
        {/* Header bar */}
        <div className="flex items-center px-3 py-3">
          <div className="flex items-center gap-2.5 pl-2">
            <Sparkles size={20} className="text-[var(--settings-section-title)]" />
            <Dialog.Title asChild><h2
              id="custom-provider-dialog-title"
              className="text-18 font-semibold text-[var(--settings-section-title)]"
            >
              {editing
                ? t('settings.providers.custom.dialog.editTitle')
                : t('settings.providers.custom.dialog.createTitle')}
            </h2></Dialog.Title>
          </div>
        </div>

        {/* Body (scrollable) */}
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-4">
          <p className="text-13 leading-[1.55] text-[var(--settings-section-desc)]">
            {t('settings.providers.custom.dialog.desc')}
          </p>

          {/* 预设模板（仅新建态、有预设时显示）：下拉选择，选中即预填 baseUrl / 模型清单，
              用户只补 key。列表已按厂商首字母分组排序（同厂商国内/海外相邻，按构建区域排序）。 */}
          {!editing && !simpleAdding && presets.length > 0 && (
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
            <FormField
              id={fieldId('name')}
              label={t('settings.providers.custom.fields.name')}
              className={simpleAdding ? '[&>div>p:last-child]:!min-h-4' : undefined}
              error={errorFor('name')}
              required
              reserveFeedback
            >
              {(control) => (
                !editing && onSelectProvider ? (
                  <ProviderNameSearch {...control} surface="ivory" value={name} onChange={setName}
                    placeholder={t('settings.providers.custom.fields.namePlaceholder')}
                    choices={providerChoices} disabled={saving} open={!saving && childLayer?.kind === 'provider-search'}
                    onOpenChange={open => setChildLayer(current => open
                      ? (current?.kind === 'model-picker' ? current : { kind: 'provider-search' })
                      : current?.kind === 'provider-search' ? null : current)}
                    onSelect={target => { if (!savingRef.current) onSelectProvider(target); }} />
                ) : (
                <SettingsTextInput
                  {...control}
                  surface="ivory"
                  size={simpleAdding ? 'md' : undefined}
                  value={name}
                  onChange={setName}
                  placeholder={t('settings.providers.custom.fields.namePlaceholder')}
                />
                )
              )}
            </FormField>
          </div>

          {/* 鉴权形态：API 密钥 / OAuth / 无鉴权。 */}
          {!initial?.auth?.native && <>
          {!simpleAdding && <div className="flex flex-col gap-2">
            <FieldLabel>{t('settings.providers.custom.authMode.label')}</FieldLabel>
            <SegmentedControl
              aria-label={t('settings.providers.custom.authMode.label')}
              value={authMode}
              height={38}
              optionHeight={32}
              onValueChange={(mode) => {
                changeAuthMode(mode);
                setTest({ 'claude-code': IDLE_TEST, codex: IDLE_TEST, pi: IDLE_TEST });
              }}
              options={(['apiKey', 'oauth', 'none'] as const).map((mode) => ({
                value: mode,
                label: t(`settings.providers.custom.authMode.${mode}`),
              }))}
            />
            {authMode === 'oauth' && (
              <>
                <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                  {t('settings.providers.custom.authMode.oauthHelp')}
                </span>
                <div className="flex flex-col gap-[7px]">
                  <FieldLabel>{t('settings.providers.custom.authMode.flowLabel')}</FieldLabel>
                  <SegmentedControl
                    aria-label={t('settings.providers.custom.authMode.flowLabel')}
                    value={oauthFlow}
                    onValueChange={setOauthFlow}
                    height={38}
                    optionHeight={32}
                    options={(['authorization-code', 'device-code'] as const).map((flow) => ({
                      value: flow,
                      label: t(`settings.providers.custom.authMode.flow.${flow}`),
                    }))}
                  />
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
                    <FormField
                      id={fieldId(`oauth:${field}`)}
                      label={t(`settings.providers.custom.authMode.fields.${field}`)}
                      error={errorFor(`oauth:${field}`)}
                      required
                      reserveFeedback
                    >
                      {(control) => (
                        <SettingsTextInput
                          {...control}
                          surface="ivory"
                          value={oauthFields[field]}
                          onChange={(v) => setOauthFields((prev) => ({ ...prev, [field]: v }))}
                          placeholder={ph}
                        />
                      )}
                    </FormField>
                  </div>
                ))}
              </>
            )}
            {authMode === 'none' && (
              <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                {t('settings.providers.custom.authMode.noneHelp')}
              </span>
            )}
          </div>}

          {/* Runtime 分段 Tab：Claude Code 与 Codex 各自维护端点、协议、模型与凭证。 */}
          {!simpleAdding && <div className="flex flex-col gap-2">
            <FieldLabel>{t('settings.providers.custom.fields.protocols')}</FieldLabel>
            <SegmentedControl
              role="tablist"
              aria-label={t('settings.providers.custom.fields.protocols')}
              value={activeTab}
              onValueChange={(agent) => {
                setChildLayer(null);
                setActiveTab(agent);
              }}
              fullWidth
              height={36}
              optionHeight={26}
              optionClassName="text-13 px-2"
              options={VISIBLE_AGENTS.map((agent) => {
                const meta = TAB_META[agent];
                const Mark = meta.Mark;
                return {
                  value: agent,
                  label: (
                    <>
                      <Mark size={14} className="shrink-0" />
                      <span className="whitespace-nowrap">{t(meta.labelKey)}</span>
                      {rt[agent].baseUrl.trim().length > 0 && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--remote-status-ready)]" />
                      )}
                    </>
                  ),
                };
              })}
            />
            <span className="text-12 leading-snug text-[var(--text-tertiary)]">
              {templateBound ? (boundPreset ? presetDisplayName(boundPreset, i18n.language) : name) : !editing && onDetected ? t('settings.providers.detection.hint') : activeTab === 'codex' ? (
                <>
                  <span>{t('settings.providers.custom.protocol.codexUpstream')}</span>
                  <span>{t(customProviderCodexWireProtocolOption(f.wireProtocol).labelKey)}</span>
                </>
              ) : t(TAB_META[activeTab].helpKey)}
            </span>
          </div>}

          {/* 当前 Tab 的独立配置面板 */}
          <div
            className="flex flex-col gap-4 rounded-[12px] p-4"
            style={{
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--settings-theme-card-border)',
            }}
          >
            {/* 基础 URL */}
            <div className="flex flex-col gap-[7px]">
              <FormField
                id={fieldId(`${activeTab}:baseUrl`)}
                label={t('settings.providers.custom.fields.baseUrl')}
                error={errorFor(`${activeTab}:baseUrl`)}
                labelAction={!simpleAdding && !templateBound && (
                  <button
                    ref={runtimeFillTriggerRef}
                    type="button"
                    onClick={openRuntimeFill}
                    className="shrink-0 rounded-full px-1 py-0.5 text-11 font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--settings-section-title)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    {t('settings.providers.custom.runtimeFill.action')}
                  </button>
                )}
                reserveFeedback={!simpleAdding}
              >
                {(control) => (
                  <SettingsTextInput
                    {...control}
                    surface="ivory"
                    size={simpleAdding ? 'md' : undefined}
                    value={displayedBaseUrl}
                    readOnly={fixedTemplateEndpoint}
                    onChange={(v) => {
                      if (!fixedTemplateEndpoint) patch(activeTab, (x) => ({ ...x, baseUrl: v }));
                    }}
                    placeholder={t('settings.providers.custom.fields.baseUrlPlaceholder')}
                  />
                )}
              </FormField>
            </div>

            {/* API 密钥（OAuth 形态隐藏——鉴权走 Runner 的 Bearer，不收集 key） */}
            {(simpleAdding || authMode === 'apiKey') && (
              <div className="flex flex-col gap-[7px]">
                <FormField
                  id={fieldId(`${activeTab}:apiKey`)}
                  label={t('settings.providers.custom.fields.apiKey')}
                  error={errorFor(`${activeTab}:apiKey`) ?? (detectionAuthFailed && !detectionKeyMissing ? t('settings.providers.detection.authRejected') : undefined)}
                  hint={detectionKeyMissing ? t('settings.providers.detection.keyRequired') : simpleAdding ? undefined : t('settings.providers.custom.fields.apiKeyHelp')}
                  labelAction={
                    activeKeyCanRemainSaved &&
                    f.apiKey.trim() && (
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
                    )
                  }
                >
                  {(control) => (
                    <SettingsTextInput
                      {...control}
                      key={activeTab}
                      surface="ivory"
                      size={simpleAdding ? 'md' : undefined}
                      value={f.apiKey}
                      onChange={(v) => {
                        keyEditRevisionRef.current[activeTab] += 1;
                        patch(activeTab, (x) => ({ ...x, apiKey: v }));
                      }}
                      placeholder={keyPlaceholder}
                      mono={!simpleAdding}
                      secret
                      secretTipContentClassName="z-[10001]"
                    />
                  )}
                </FormField>
              </div>
            )}

          {!editing && detection?.signature === detectionSignature && (!detectionAuthFailed || detection.preset) && (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-3 text-13 text-[var(--text-secondary)]" role="status">
              <span>{detection.pending ? t('settings.providers.detection.pending') : detection.preset
                ? t('settings.providers.detection.matched', { name: presetDisplayName(detection.preset, i18n.language) })
                : t(detection.ambiguous ? 'settings.providers.detection.ambiguous' : 'settings.providers.detection.custom')}</span>
              {detection.code && !detectionAuthFailed && <span className="text-[var(--error-fg)]">{t(`providerError.${detection.code}`)}</span>}
              {detection.preset && <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => enterDetectedProvider(detection.preset!)}>{t('settings.providers.detection.configure')}</Button>
                <Button type="button" variant="secondary" tone="quiet" onClick={() => setDetection(null)}>{t('settings.providers.detection.keepCustom')}</Button>
              </div>}
            </div>
          )}
                <div className="flex flex-col gap-2 text-13 text-[var(--text-secondary)]">
                  <span>{t('settings.providers.connection.modelCount', { count: f.models.filter((model) => model.id.trim()).length })}</span>
                  {!simpleAdding && <span className="text-12">{t('settings.providers.connection.modelsAutomatic')}</span>}
                  {simpleAdding && <>
                    {f.models.filter(model => model.id.trim()).map(model => (
                      <div key={model.id} className="flex items-center justify-between gap-2 border-b border-[var(--border-default)] py-2">
                        <span className="min-w-0 break-words text-[var(--text-primary)]">
                          {model.id}{' '}
                          <span className="inline-flex rounded-full border border-[var(--border-default)] px-2 py-0.5 text-11 text-[var(--text-secondary)]">
                            {t(modelTypeLabelKey(model.mode ?? model.discoveredMetadata?.mode))}
                          </span>
                        </span>
                        <Button type="button" variant="secondary" size="sm" className="shrink-0"
                          onClick={() => patch(activeTab, value => ({ ...value, models: value.models.filter(row => row.id !== model.id) }))}>
                          {t('settings.providers.connection.removeModel')}
                        </Button>
                      </div>
                    ))}
                  </>}
                    <Button type="button" variant="secondary" className="w-full justify-between [--button-face-bg:transparent]"
                      aria-expanded={manualOpen} aria-controls={fieldId('manual-fields')}
                      onClick={() => setManualOpen(open => !open)}>
                      {t('settings.providers.connection.manualAdd')}
                      <ChevronDown size={14} aria-hidden className={cn('shrink-0', manualOpen && 'rotate-180')} />
                    </Button>
                  {manualOpen && <div id={fieldId('manual-fields')} className="flex flex-col gap-3">
                  <FormField id={fieldId(`${activeTab}:manualModel`)} label={t(simpleAdding ? 'settings.providers.connection.manualId' : 'settings.providers.connection.manualModel')} error={errorFor(`${activeTab}:manualModel`)}>
                        {(control) => (
                          <SettingsTextInput {...control} surface="ivory" value={manualModel}
                      onChange={setManualModel} />
                        )}
                  </FormField>
                  <FormField id={fieldId(`${activeTab}:manualModelMode`)}
                    label={t('settings.providers.custom.fields.modelType')}
                    hint={t('settings.providers.connection.manualModelTypeHint')}>
                    {(control) => (
                      <Select {...control} label={t('settings.providers.custom.fields.modelType')}
                        value={manualModelMode} onValueChange={setManualModelMode}
                        options={[
                          { value: 'inherit', label: t('settings.providers.connection.modelTypeAutomatic') },
                          { value: 'chat', label: t('settings.providers.models.kindFilter.chat') },
                          ...([
                            ['image_generation', 'image'], ['video_generation', 'video'],
                            ['audio_speech', 'tts'], ['audio_transcription', 'stt'],
                            ['audio_generation', 'audio'], ['realtime', 'realtime'], ['embedding', 'embedding'],
                          ] as const).map(([value, category]) => ({ value, label: t(`newChat.modelSelector.category.${category}`) })),
                        ]} />
                    )}
                  </FormField>
                  <Button variant="secondary" disabled={!manualModel.trim()} onClick={() => {
                    const ids = [...new Set(manualModel.split(/[,\n]/).map((id) => id.trim()).filter(Boolean))];
                    patch(activeTab, (runtime) => ({ ...runtime, models: [
                      ...runtime.models.filter((model) => model.id.trim()).map(model =>
                        ids.includes(model.id) ? { ...model, mode: manualModelMode === 'inherit' ? undefined : manualModelMode } : model),
                      ...ids.filter((id) => !runtime.models.some((model) => model.id === id))
                        .map((id) => ({ id, name: id, ...(manualModelMode === 'inherit' ? {} : { mode: manualModelMode }) })),
                    ] }));
                    setManualModel('');
                    setManualModelMode('inherit');
                    setFieldError(null);
                  }}>{t('settings.providers.custom.fields.addModel')}</Button>
                  </div>}
                </div>

            <button
              type="button"
              onClick={() => setShowAdvanced(open => !open)}
              aria-expanded={showAdvanced}
              aria-controls={fieldId('advanced-fields')}
              className="flex min-h-8 items-center gap-1 self-start text-13 font-medium text-[var(--settings-section-title)]"
            >
              <ChevronDown size={14} aria-hidden className={cn('transition-transform', showAdvanced && 'rotate-180')} />
              {t('settings.providers.custom.advanced.label')}
            </button>
            {showAdvanced && (
              <div id={fieldId('advanced-fields')} className="flex flex-col gap-4">
            {(editing || !onDetected) && !templateBound && (
              <div className="flex flex-col gap-[7px]">
                <FieldLabel>{t('settings.providers.custom.fields.wireProtocol')}</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {CUSTOM_PROVIDER_CODEX_WIRE_PROTOCOLS.map((option) => (
                    <button
                      key={option.value}
                      aria-pressed={f.wireProtocol === option.value}
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
                      {t(
                        activeTab !== 'codex' && option.value !== 'google-generative-ai'
                          ? `settings.providers.custom.wireProtocol.pi${
                              option.value === 'anthropic-messages'
                                ? 'Anthropic'
                                : option.value === 'openai-responses'
                                  ? 'Responses'
                                  : 'Chat'
                            }`
                          : option.labelKey,
                      )}
                    </button>
                  ))}
                </div>
                {activeTab !== 'claude-code' && (
                <span className="text-12 leading-snug text-[var(--text-tertiary)]">
                  {t(
                    activeTab === 'pi' && f.wireProtocol !== 'google-generative-ai'
                      ? `settings.providers.custom.wireProtocol.pi${
                          f.wireProtocol === 'anthropic-messages'
                            ? 'AnthropicHelp'
                            : f.wireProtocol === 'openai-chat'
                              ? 'ChatHelp'
                              : 'ResponsesHelp'
                        }`
                      : customProviderCodexWireProtocolOption(f.wireProtocol).helpKey,
                  )}
                </span>
                )}
              </div>
            )}

            {/* 精确推理路径：给非标准兼容端点使用；留空仍按所选协议推导。 */}
            {(editing || !onDetected) && !templateBound && activeTab !== 'pi' && f.wireProtocol !== 'google-generative-ai' && (
              <div className="flex flex-col gap-[7px]">
                <FormField
                  id={fieldId(`${activeTab}:requestPath`)}
                  label={t('settings.providers.custom.fields.requestPath')}
                  error={errorFor(`${activeTab}:requestPath`)}
                  hint={t('settings.providers.custom.fields.requestPathHelp')}
                  reserveFeedback
                >
                  {(control) => (
                    <SettingsTextInput
                      {...control}
                      surface="ivory"
                      value={f.requestPath}
                      onChange={(v) => patch(activeTab, (x) => ({ ...x, requestPath: v }))}
                      placeholder={
                        f.wireProtocol === 'anthropic-messages'
                          ? '/v1/messages'
                          : customProviderCodexWireProtocolOption(f.wireProtocol).defaultRequestPath
                      }
                    />
                  )}
                </FormField>
              </div>
            )}

                {/* 请求头（可选） */}
                <div className={cn('flex flex-col gap-3', simpleAdding && 'border-t border-[var(--border-default)] pt-4')}>
                  <div className="flex items-center gap-2">
                    <FieldLabel>{t('settings.providers.custom.fields.headers')}</FieldLabel>
                    {/* 已存密文头时给明确徽标 —— 明文不回读进 renderer,无徽标会让人误以为没存上。 */}
                    {activeHeadersCanRemainSaved && (
                      <span
                        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium"
                        style={{
                          backgroundColor: 'var(--settings-btn-secondary-bg)',
                          color: 'var(--settings-section-desc)',
                        }}
                      >
                        <Check size={11} strokeWidth={2.5} />
                        {t('settings.providers.custom.runtimeFill.values.configured')}
                      </span>
                    )}
                  </div>
                  {f.headers.map((h, i) => (
                    <div key={`${activeTab}:${rowId(h)}`} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <FormField
                          id={fieldId(`${activeTab}:header:${rowId(h)}:name`)}
                          label={`${t('settings.providers.custom.fields.headerNamePlaceholder')} ${i + 1}`}
                          error={errorFor(`${activeTab}:header:${rowId(h)}:name`)}
                          hideLabel
                        >
                          {(control) => (
                            <SettingsTextInput
                              {...control}
                              surface="ivory"
                              value={h.name}
                              // nameExplicit 同上:与 main #4108 的显式命名语义合并保留。
                              onChange={(v) =>
                                patch(activeTab, (x) => ({
                                  ...x,
                                  headers: x.headers.map((y, j) =>
                                    j === i ? { ...y, name: v, nameExplicit: true } : y,
                                  ),
                                }))
                              }
                              placeholder={t(
                                'settings.providers.custom.fields.headerNamePlaceholder',
                              )}
                            />
                          )}
                        </FormField>
                      </div>
                      <div className="min-w-0 flex-1">
                        <FormField
                          id={fieldId(`${activeTab}:header:${rowId(h)}:value`)}
                          label={`${t('settings.providers.custom.fields.headerValuePlaceholder')} ${i + 1}`}
                          error={errorFor(`${activeTab}:header:${rowId(h)}:value`)}
                          hideLabel
                        >
                          {(control) => (
                            <SettingsTextInput
                              {...control}
                              surface="ivory"
                              value={h.value}
                              onChange={(v) =>
                                patch(activeTab, (x) => ({
                                  ...x,
                                  headers: x.headers.map((y, j) =>
                                    j === i ? { ...y, value: v } : y,
                                  ),
                                }))
                              }
                              placeholder={t(
                                'settings.providers.custom.fields.headerValuePlaceholder',
                              )}
                            />
                          )}
                        </FormField>
                      </div>
                      <Tip
                        text={t('settings.providers.custom.fields.removeRow')}
                        contentClassName="z-[10001]"
                      >
                        <Button
                          variant="secondary"
                          size="lg"
                          type="button"
                          onClick={() => {
                            const next = f.headers[i + 1] ?? f.headers[i - 1];
                            const nextId = fieldId(
                              next
                                ? `${activeTab}:header:${rowId(next)}:name`
                                : `${activeTab}:add-header`,
                            );
                            patch(activeTab, (x) => ({
                              ...x,
                              headers: x.headers.filter((_, j) => j !== i),
                            }));
                            requestAnimationFrame(() => document.getElementById(nextId)?.focus());
                          }}
                          className="w-9 px-0"
                          aria-label={t('settings.providers.custom.fields.removeRow')}
                        >
                          <Trash2 size={16} />
                        </Button>
                      </Tip>
                    </div>
                  ))}
                  <button
                    type="button"
                    id={fieldId(`${activeTab}:add-header`)}
                    onClick={() => {
                      const row = { name: '', value: '' };
                      const nextId = fieldId(`${activeTab}:header:${rowId(row)}:name`);
                      patch(activeTab, (x) => ({ ...x, headers: [...x.headers, row] }));
                      requestAnimationFrame(() => document.getElementById(nextId)?.focus());
                    }}
                    className={cn('flex items-center gap-1.5 self-start text-13 font-medium text-[var(--settings-section-title)]', simpleAdding ? 'h-8 rounded-full border border-[var(--border-default)] px-4' : 'py-0.5')}
                  >
                    <Plus size={14} className="text-[var(--settings-section-desc)]" />
                    {t('settings.providers.custom.fields.addHeader')}
                  </button>
                </div>

                {!simpleAdding && authMode !== 'oauth' && (
                  <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
                    <label className="flex cursor-pointer items-center gap-2 text-13 text-[var(--settings-section-title)]">
                      <input
                        type="checkbox"
                        id={fieldId(`${activeTab}:image-api`)}
                        aria-describedby={fieldId(`${activeTab}:image-api-hint`)}
                        checked={f.imageApi === 'openai-images'}
                        onChange={(event) => {
                          const enabled = event.currentTarget.checked;
                          // One explicit media owner per provider; other chat routes and keys stay intact.
                          setRtSynced((prev) => Object.fromEntries(
                            Object.entries(prev).map(([agent, runtime]) => [agent, {
                              ...runtime,
                              imageApi: agent === activeTab && enabled
                                ? 'openai-images'
                                : enabled || agent === activeTab ? undefined : runtime.imageApi,
                            }]),
                          ) as Record<DialogAgentKind, RuntimeFields>);
                        }}
                        className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--settings-menu-text-selected)]"
                      />
                      {t('settings.providers.custom.fields.openaiImages')}
                    </label>
                    <p
                      id={fieldId(`${activeTab}:image-api-hint`)}
                      className="text-12 leading-5 text-[var(--settings-section-desc)]"
                    >
                      {t('settings.providers.custom.fields.openaiImagesHint')}
                    </p>
                  </div>
                )}

                {!simpleAdding && authMode !== 'oauth' && (
                  <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
                    <label className="flex cursor-pointer items-center gap-2 text-13 text-[var(--settings-section-title)]">
                      <input
                        type="checkbox"
                        id={fieldId(`${activeTab}:video-api`)}
                        aria-describedby={fieldId(`${activeTab}:video-api-hint`)}
                        checked={f.videoApi === 'xai-videos'}
                        onChange={(event) => {
                          const enabled = event.currentTarget.checked;
                          // One explicit media owner per provider; other chat routes and keys stay intact.
                          setRtSynced((prev) => Object.fromEntries(
                            Object.entries(prev).map(([agent, runtime]) => [agent, {
                              ...runtime,
                              videoApi: agent === activeTab && enabled
                                ? 'xai-videos'
                                : enabled || agent === activeTab ? undefined : runtime.videoApi,
                            }]),
                          ) as Record<DialogAgentKind, RuntimeFields>);
                        }}
                        className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--settings-menu-text-selected)]"
                      />
                      {t('settings.providers.custom.fields.xaiVideos')}
                    </label>
                    <p
                      id={fieldId(`${activeTab}:video-api-hint`)}
                      className="text-12 leading-5 text-[var(--settings-section-desc)]"
                    >
                      {t('settings.providers.custom.fields.xaiVideosHint')}
                    </p>
                  </div>
                )}

                {/* Codex Responses Provider 级能力。放在自定义请求头之后，默认收起；
                    同一张说明卡片支持 hover/focus 临时预览和 click/tap 固定。 */}
                {!simpleAdding && canShowImageGenerationAdvanced && (
                  <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (showImageGenerationAdvanced) resetImageGenerationHelp();
                        setShowImageGenerationAdvanced((open) => !open);
                      }}
                      aria-expanded={showImageGenerationAdvanced}
                      aria-controls="custom-provider-image-generation-advanced"
                      className="group flex w-full items-center justify-between gap-3 text-left"
                    >
                      <span className="text-13 font-medium text-[var(--settings-section-title)]">
                        {t('settings.providers.custom.fields.runtimeAdvanced')}
                      </span>
                      <ChevronDown
                        size={14}
                        aria-hidden
                        className={cn(
                          'shrink-0 text-[var(--text-tertiary)] transition-transform group-hover:text-[var(--text-primary)]',
                          showImageGenerationAdvanced && 'rotate-180',
                        )}
                      />
                    </button>
                    {showImageGenerationAdvanced && (
                      <div
                        id="custom-provider-image-generation-advanced"
                        className="flex min-h-11 items-center justify-between gap-3 rounded-lg bg-[var(--surface-elevated)] px-3 py-2.5"
                      >
                        <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[var(--settings-section-desc)]">
                          <input
                            type="checkbox"
                            checked={f.supportsImageGeneration}
                            onChange={(event) => {
                              const supportsImageGeneration = event.currentTarget.checked;
                              patch('codex', (runtime) => ({
                                ...runtime,
                                supportsImageGeneration,
                              }));
                            }}
                            className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--settings-menu-text-selected)]"
                          />
                          <span className="text-12 font-medium leading-5 text-[var(--settings-section-sublabel)]">
                            {t('settings.providers.custom.fields.runtimeSupportsImageGeneration')}
                          </span>
                        </label>
                        <Popover
                          open={showImageGenerationHelp}
                          onOpenChange={(open) => {
                            if (!open) closeImageGenerationHelp();
                          }}
                        >
                          <PopoverAnchor asChild>
                            <button
                              ref={imageGenerationHelpTriggerRef}
                              type="button"
                              aria-label={t(
                                'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
                              )}
                              aria-expanded={showImageGenerationHelp}
                              aria-controls="custom-provider-image-generation-help-card"
                              onPointerEnter={() => {
                                imageGenerationHelpPointerInsideRef.current = true;
                                if (imageGenerationHelpPointerPreviewSuppressedRef.current) return;
                                previewImageGenerationHelp();
                              }}
                              onPointerLeave={() => {
                                imageGenerationHelpPointerInsideRef.current = false;
                                scheduleImageGenerationHelpPointerLeave();
                              }}
                              onFocus={() => {
                                if (imageGenerationHelpFocusPreviewSuppressedRef.current) return;
                                setImageGenerationHelpFocused(true);
                              }}
                              onBlur={() => {
                                imageGenerationHelpFocusPreviewSuppressedRef.current = false;
                                setImageGenerationHelpFocused(false);
                              }}
                              onClick={() => {
                                if (imageGenerationHelpPinned) {
                                  dismissImageGenerationHelp(false);
                                  return;
                                }
                                cancelImageGenerationHelpPointerLeave();
                                imageGenerationHelpFocusPreviewSuppressedRef.current = false;
                                imageGenerationHelpPointerPreviewSuppressedRef.current = false;
                                setImageGenerationHelpPinned(true);
                              }}
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                            >
                              <CircleHelp size={15} aria-hidden />
                            </button>
                          </PopoverAnchor>
                          <PopoverContent
                            id="custom-provider-image-generation-help-card"
                            side="top"
                            align="end"
                            sideOffset={8}
                            collisionPadding={12}
                            role={imageGenerationHelpPinned ? 'dialog' : 'tooltip'}
                            aria-label={t(
                              'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
                            )}
                            onOpenAutoFocus={(event) => event.preventDefault()}
                            onCloseAutoFocus={(event) => event.preventDefault()}
                            onPointerEnter={() => {
                              imageGenerationHelpPointerInsideRef.current = true;
                              if (imageGenerationHelpPointerPreviewSuppressedRef.current) return;
                              previewImageGenerationHelp();
                            }}
                            onPointerLeave={() => {
                              imageGenerationHelpPointerInsideRef.current = false;
                              scheduleImageGenerationHelpPointerLeave();
                            }}
                            onPointerDownOutside={(event) => {
                              if (
                                imageGenerationHelpTriggerRef.current?.contains(
                                  event.target as Node,
                                )
                              ) {
                                event.preventDefault();
                              }
                            }}
                            onFocusOutside={(event) => {
                              if (imageGenerationHelpPinned) event.preventDefault();
                            }}
                            className="z-[10001] w-72 max-w-[calc(100vw-2rem)] rounded-xl border-[var(--border-default)] bg-[var(--surface-elevated)] p-3 text-12 text-[var(--text-secondary)]"
                          >
                            {renderImageGenerationHelpContent()}
                          </PopoverContent>
                        </Popover>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

                {/* 预设模板（仅新建态、有预设时显示）：下拉选择，选中即预填 baseUrl / 模型清单，
                    用户只补 key。列表已按厂商首字母分组排序（同厂商国内/海外相邻，按构建区域排序）。 */}
            {authMode !== 'oauth' && (
              <div className="flex min-h-[32px] flex-wrap items-center gap-2.5 border-t border-[var(--border-default)] pt-4">
                    {!mediaOnly && <Button
                      variant="secondary"
                      size="sm"
                      compact
                      loading={test[activeTab].status === 'testing'}
                  type="button"
                  onClick={() => void handleTest()}
                  disabled={Object.values(test).some(value => value.status === 'testing')}
                    >
                      <Plug size={13} />
                      {t('settings.providers.custom.test.button')}
                    </Button>}
                    {/* 预设模板（仅新建态、有预设时显示）：下拉选择，选中即预填 baseUrl / 模型清单，
                        用户只补 key。列表已按厂商首字母分组排序（同厂商国内/海外相邻，按构建区域排序）。 */}
                    <Button
                      variant="secondary"
                      size="sm"
                      compact
                      loading={fetchingModels[activeTab]}
                  ref={modelPickerTriggerRef}
                  type="button"
                  onClick={() => void handleFetchModels()}
                  disabled={anyFetching}
                    >
                      <RefreshCw size={13} />
                      {t('settings.providers.custom.fetch.button')}
                    </Button>
                {!mediaOnly && test[activeTab].status === 'ok' && (
                  <span
                    className="flex items-center gap-1 text-12"
                    style={{ color: 'var(--remote-status-ready)' }}
                  >
                    <Check size={13} strokeWidth={2.5} />
                    {t('settings.providers.custom.test.ok', { ms: test[activeTab].latencyMs ?? 0 })}
                  </span>
                )}
                {!mediaOnly && test[activeTab].status === 'fail' && (
                  <span className="text-12 text-[var(--error-fg)]">
                    {test[activeTab].decision === 'inconclusive'
                      ? t('settings.providers.custom.test.inconclusive')
                      : test[activeTab].decision === 'next'
                        ? t('settings.providers.custom.test.exhausted')
                        : t(`providerError.${test[activeTab].code ?? 'UNKNOWN'}`)}
                  </span>
                )}
                {!mediaOnly && test[activeTab].status === 'testing' && (
                  <span role="status" className="text-12 text-[var(--text-secondary)]">{t('settings.providers.custom.test.testing')}</span>
                )}
                {!mediaOnly && test[activeTab].status === 'testing' && connectionTestRef.current && (
                  <Button variant="secondary" size="sm" compact type="button" onClick={() => {
                    cancelConnectionTest();
                    setTest(previous => ({ ...previous, [activeTab]: IDLE_TEST }));
                  }}>{t('settings.providers.custom.test.stop')}</Button>
                )}
                {!mediaOnly && simpleAdding && (
                  <span className="w-full text-12 text-[var(--text-secondary)]">{t('settings.providers.custom.test.costHint')}</span>
                )}
                {!mediaOnly && test[activeTab].status === 'fail' && Boolean(test[activeTab].attempts?.length) && (
                  <details className="w-full text-12 text-[var(--text-secondary)]">
                    <summary>{t('settings.providers.custom.test.details')}</summary>
                    <ul>{test[activeTab].attempts?.map(attempt => <li key={attempt.wireProtocol}>
                      {attempt.wireProtocol}: {t('providerError.' + (attempt.code ?? 'UNKNOWN'))}
                    </li>)}</ul>
                  </details>
                )}
                {mediaOnly && (
                  <span className="w-full text-12 text-[var(--text-secondary)]">
                    {t('settings.providers.connection.mediaOnlyTestHint')}
                  </span>
                )}
              </div>
            )}
          </div>
          </>}
        </div>

        {/* Footer: only the save request owns this busy state. */}
        <div className="flex shrink-0 flex-wrap justify-end gap-2.5 border-t border-[var(--border-default)] p-4">
          <Button
            variant="secondary"
            size="lg"
            disabled={saving}
            onClick={() => {
              if (!savingRef.current) onClose();
            }}
            palette="confirmation"
          >
            {t('settings.providers.custom.cancel')}
          </Button>
          <Button
            ref={saveButtonRef}
            variant={simpleAdding ? 'cta' : 'primary'}
            size="lg"
            loading={saving}
            disabled={Object.values(test).some(value => value.status === 'testing')}
            onClick={() => void handleSave()}
            palette={simpleAdding ? 'default' : 'confirmation'}
            className="min-w-[96px]"
          >
            {t(simpleAdding ? 'settings.providers.connection.saveProvider' : 'settings.providers.custom.save')}
          </Button>
        </div>
      </Dialog.Content>
      </Dialog.Portal>

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
          returnFocusRef={modelPickerTriggerRef}
        />
      )}
      {runtimeFill && (
        <CustomProviderRuntimeFillOverlay
          state={runtimeFill}
          runtimeNames={
            Object.fromEntries(
              AGENTS.map((agent) => [agent, t(TAB_META[agent].labelKey)]),
            ) as Record<DialogAgentKind, string>
          }
          returnFocusRef={runtimeFillTriggerRef}
          onClose={dismissTopmostLayer}
          onContinue={continueRuntimeFill}
          onBack={() => setRuntimeFill((prev) => (prev ? { ...prev, stage: 'review' } : prev))}
          onToggleField={toggleRuntimeFillField}
          onApply={applyRuntimeFill}
        />
      )}
      {imageGenerationReloadConfirmation && (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open && !savingRef.current) {
              imageGenerationReloadConfirmationRef.current = null;
              setImageGenerationReloadConfirmation(null);
            }
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10002]" />
            <Dialog.Content
              aria-describedby="custom-provider-image-generation-reload-description"
              onPointerDownOutside={(event) => event.preventDefault()}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                document.getElementById('custom-provider-image-generation-reload-primary')?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                saveButtonRef.current?.focus();
              }}
              onEscapeKeyDown={(event) => {
                if (saving) event.preventDefault();
              }}
              className={cn(
                'modal-panel fixed inset-0 z-[10002] m-auto flex h-fit max-h-[85vh] w-[520px] max-w-[calc(100vw-2rem)] flex-col p-4 outline-none',
              )}
            >
              <button
                type="button"
                aria-label={t('settings.providers.custom.imageGenerationReload.close')}
                disabled={saving}
                onClick={() => {
                  imageGenerationReloadConfirmationRef.current = null;
                  setImageGenerationReloadConfirmation(null);
                }}
                className="absolute right-3 top-3 rounded-full p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
              >
                <X size={16} />
              </button>
              <Dialog.Title className="pr-9 text-lg font-medium text-[var(--confirm-title)]">
                {t('settings.providers.custom.imageGenerationReload.title')}
              </Dialog.Title>
              <Dialog.Description
                id="custom-provider-image-generation-reload-description"
                className="mt-2 whitespace-pre-line text-base leading-relaxed text-[var(--confirm-desc)]"
              >
                {t('settings.providers.custom.imageGenerationReload.description')}
              </Dialog.Description>
              <div className="mt-6 flex flex-wrap justify-end gap-2.5">
                <Button
                  variant="secondary"
                  size="lg"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    imageGenerationReloadConfirmationRef.current = null;
                    setImageGenerationReloadConfirmation(null);
                  }}
                  className="min-w-[96px]"
                >
                  {t('settings.providers.custom.imageGenerationReload.cancel')}
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  tone="danger-solid"
                  loading={saving}
                  id="custom-provider-image-generation-reload-primary"
                  type="button"
                  disabled={saving}
                  onClick={() => void saveWithImageGenerationRestartPolicy('interrupt')}
                  className="min-w-[96px]"
                >
                  {t('settings.providers.custom.imageGenerationReload.interrupt')}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </Dialog.Root>
  );
}

/** 勾选弹层内容（搜索 + 全选/清空 + 逐行勾选；> 8 项才显示搜索框，结构对齐 ModelListPanel）。 */
export function ModelPickerOverlay({
  picker,
  onChange,
  onConfirm,
  onClose,
  returnFocusRef,
}: {
  picker: ModelPickerState;
  onChange: (next: ModelPickerState) => void;
  onConfirm: () => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
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
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'modal-scrim fixed inset-0 z-[10001]',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          ref={contentRef}
          aria-describedby="custom-provider-model-picker-description"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (
              searchInputRef.current ??
              contentRef.current?.querySelector<HTMLButtonElement>('[role="checkbox"]') ??
              primaryButtonRef.current
            )?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
          className={cn(
            'modal-panel fixed left-1/2 top-1/2 z-[10001] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[72vh] w-[460px] max-w-[calc(100vw-2rem)] flex-col outline-none',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Header */}
          <div className="flex items-center px-5 pb-1 pt-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Dialog.Title className="text-15 font-semibold text-[var(--settings-section-title)]">
                {t('settings.providers.custom.fetch.pickerTitle', {
                  runtime: t(TAB_META[picker.agent].labelKey),
                })}
              </Dialog.Title>
              <Dialog.Description
                id="custom-provider-model-picker-description"
                className="text-12 text-[var(--text-tertiary)]"
              >
                {t('settings.providers.custom.fetch.pickerCount', {
                  selected: picker.selected.size,
                  total: picker.models.length,
                })}
              </Dialog.Description>
            </div>
          </div>
          {/* 搜索（项目多才显示）+ 全选/清空（作用于当前过滤结果） */}
          <div className="flex flex-col gap-2 px-5 pt-2">
            {picker.models.length > 8 && (
              <input
                ref={searchInputRef}
                value={picker.query}
                onChange={(e) => onChange({ ...picker, query: e.target.value })}
                placeholder={t('settings.providers.custom.fetch.searchPlaceholder')}
                className={cn(
                  'h-[34px] w-full rounded-[9px] px-[11px] text-13 outline-none transition-colors',
                  'text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
                  'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] focus:border-[var(--settings-input-border-focus)]',
                  'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                )}
                style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
              />
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setAllFiltered(true)}
                className="text-12 font-medium text-[var(--settings-section-title)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {t('settings.providers.custom.fetch.selectAll')}
              </button>
              <button
                type="button"
                onClick={() => setAllFiltered(false)}
                className="text-12 font-medium text-[var(--text-secondary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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
                    className="flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2 text-left hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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
            <Button variant="secondary" size="md" compact type="button" onClick={onClose}>
              {t('settings.providers.custom.cancel')}
            </Button>
            <Button
              variant="cta"
              size="md"
              compact
              ref={primaryButtonRef}
              type="button"
              onClick={onConfirm}
              disabled={picker.selected.size === 0}
            >
              {t('settings.providers.custom.fetch.confirm', { count: picker.selected.size })}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
