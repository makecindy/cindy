/**
 * + 面板的「协同模式」二级视图(会话页与新建任务页共用)。
 *
 *  - OrcaWorkerFormView:开启协同 / 创建新 Worker 的表单(角色、Agent、模型、权限、初始任务)。
 *    提交按钮由页面放在 ContextSheet 的 footer 槽。
 *  - OrcaTeamPanelView:Lead 任务的 Worker 列表 + 创建 / 结束协同。
 *
 * 两者只用 ContextSheet 的跨平台原语(Group / Row / Note / ChoiceRow / TextField)拼装,
 * iOS 原生面板与 Android 面板共用本文件。团队真身在被控端,这里只渲染镜像并回调页面。
 */
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { CircleStop, UserPlus } from 'lucide-react-native';
import {
  ORCA_PREDEFINED_WORKER_ROLES,
  ORCA_WORKER_ROLE_MAX_LENGTH,
  orcaWorkerSlotState,
  type OrcaCollaborationSettings,
  type OrcaTeamWorker,
  type OrcaWorkerAgentKind,
  type OrcaWorkerPermissionMode,
} from '@cindy/maker-shared/orca-team';
import { Text } from '@/components/AppText';
import {
  ContextSheetChoiceRow,
  ContextSheetGroup,
  ContextSheetError,
  ContextSheetNote,
  ContextSheetRow,
  ContextSheetSelectRow,
  ContextSheetTextField,
} from '@/session/ContextSheet';
import {
  orcaAgentLabel,
  orcaWorkerDisplayName,
  orcaWorkerStatusLabel,
  isAbsoluteOrcaWorkerDir,
  type OrcaWorkerFormValue,
} from '@/session/orcaTeam';
import { iconSize, iconStroke, lineHeight, radius, typeScale, useTheme } from '@/theme';
import type { OrcaExecutionDeviceView } from '@cindy/device-link';

const CUSTOM_ROLE = '__custom__';

/** iOS 的下拉行(Picker menu)自带行名、分段控件选项自明;Android 的药丸 / 选择行没有行名,要靠分组标题。 */
const ROW_NAMES_ITSELF = Platform.OS === 'ios';

export function isPredefinedOrcaRole(role: string): boolean {
  return (ORCA_PREDEFINED_WORKER_ROLES as readonly string[]).includes(role);
}

/** 自定义角色名与预设重名时的错误文案 key;其余情况 null。 */
export function orcaWorkerFormErrorKey(form: OrcaWorkerFormValue, customRoleMode: boolean): string | null {
  const role = form.role.trim();
  return customRoleMode && role && isPredefinedOrcaRole(role.toLowerCase())
    ? 'session.collab.customRolePredefinedError'
    : null;
}

export function canSubmitOrcaWorkerForm(form: OrcaWorkerFormValue, customRoleMode: boolean): boolean {
  return form.role.trim().length > 0 && orcaWorkerFormErrorKey(form, customRoleMode) === null
    && (!form.executionDeviceId || form.remoteDirMode !== 'path' || isAbsoluteOrcaWorkerDir(form.remoteDir ?? ''));
}

export interface OrcaWorkerFormViewProps {
  form: OrcaWorkerFormValue;
  /** 自定义角色模式(页面持有,以便选中「自定义」后清空的角色名仍停留在自定义输入)。 */
  customRoleMode: boolean;
  onCustomRoleModeChange(next: boolean): void;
  onChange(patch: Partial<OrcaWorkerFormValue>): void;
  /** 切 Agent 交给页面:带出该 Agent 上次记住的模型 / 推理强度 / Fast。 */
  onAgentChange(agent: OrcaWorkerAgentKind): void;
  /** 权限切换交给页面:进入完全访问前需要确认。 */
  onPermissionChange(mode: OrcaWorkerPermissionMode): void;
  agents: readonly OrcaWorkerAgentKind[];
  onPickModel(): void;
  onPickDirectory(): void;
  busy: boolean;
  notice?: string | null;
  error?: string | null;
  executionDevices?: readonly OrcaExecutionDeviceView[];
  executionDevicesLoading?: boolean;
  executionDevicesError?: string | null;
}

export function OrcaWorkerFormView({
  form,
  customRoleMode,
  onCustomRoleModeChange,
  onChange,
  onAgentChange,
  onPermissionChange,
  agents,
  onPickModel,
  onPickDirectory,
  busy,
  notice,
  error,
  executionDevices = [],
  executionDevicesLoading = false,
  executionDevicesError,
}: OrcaWorkerFormViewProps) {
  const { t } = useTranslation();
  const roleOptions = [
    ...ORCA_PREDEFINED_WORKER_ROLES.map((role) => ({ id: role as string, label: role as string })),
    { id: CUSTOM_ROLE, label: t('session.collab.customRole') },
  ];
  const validation = orcaWorkerFormErrorKey(form, customRoleMode);
  const modelLabel = form.model?.id ?? t('session.collab.modelDefault');
  const remoteDirInvalid = form.remoteDirMode === 'path' && !!form.remoteDir && !isAbsoluteOrcaWorkerDir(form.remoteDir);
  // 设置类分组:卡片里只放「名称 + 取值」,说明与校验提示写在卡片下方(一组一段)。
  const title = (label: string) => (ROW_NAMES_ITSELF ? '' : label);
  return (
    <>
      <ContextSheetGroup
        footer={validation ? t(validation) : t('session.collab.roleHint')}
        footerTone={validation ? 'error' : 'secondary'}
        label={title(t('session.collab.roleLabel'))}
      >
        <ContextSheetChoiceRow
          disabled={busy}
          label={t('session.collab.roleLabel')}
          onChange={(next) => {
            if (next === CUSTOM_ROLE) {
              onCustomRoleModeChange(true);
              onChange({ role: '' });
              return;
            }
            onCustomRoleModeChange(false);
            onChange({ role: next });
          }}
          options={roleOptions}
          testID="collab.roleOptions"
          value={customRoleMode ? CUSTOM_ROLE : form.role}
        />
        {customRoleMode ? (
          <ContextSheetTextField
            accessibilityLabel={t('session.collab.customRole')}
            disabled={busy}
            maxLength={ORCA_WORKER_ROLE_MAX_LENGTH}
            onChange={(role) => onChange({ role })}
            placeholder={t('session.collab.customRolePlaceholder')}
            testID="collab.customRoleInput"
            value={form.role}
          />
        ) : null}
      </ContextSheetGroup>
      {/* 工作电脑与模型电脑独立选择。 */}
      {(executionDevices.length > 0 || form.executionDeviceId) ? (
        <ContextSheetGroup
          footer={t('session.collab.executionDeviceHint')}
          label={title(t('session.collab.executionDeviceLabel'))}
        >
          <ContextSheetSelectRow
            disabled={busy || executionDevicesLoading}
            label={t('session.collab.executionDeviceLabel')}
            options={[
              { id: '__lead__', label: t('session.collab.leadComputer') },
              ...(form.executionDeviceId && !executionDevices.some((device) => device.deviceId === form.executionDeviceId)
                ? [{ id: form.executionDeviceId, label: t('session.collab.deviceUnavailable'), disabled: true }]
                : []),
              ...executionDevices.map((device) => ({
                id: device.deviceId,
                label: device.name,
                detail: t(device.supported ? 'session.collab.deviceOnline' : 'session.collab.deviceNeedsUpdate'),
                disabled: !device.supported,
              })),
            ]}
            value={form.executionDeviceId ?? '__lead__'}
            onChange={(id) => onChange({ executionDeviceId: id === '__lead__' ? undefined : id })}
            testID="collab.executionDevice"
          />
        </ContextSheetGroup>
      ) : null}
      {form.executionDeviceId ? (
        <ContextSheetGroup
          footer={t(form.remoteDirMode === 'path'
            ? remoteDirInvalid ? 'session.collab.remoteDirInvalid' : 'session.collab.remoteDirPathHint'
            : 'session.collab.remoteDirChatHint')}
          footerTone={remoteDirInvalid ? 'error' : 'secondary'}
          label={title(t('session.collab.remoteDirLabel'))}
        >
          <ContextSheetChoiceRow
            disabled={busy}
            label={t('session.collab.remoteDirLabel')}
            options={[
              { id: 'dialogue', label: t('session.collab.remoteDirChat') },
              { id: 'path', label: t('session.collab.remoteDirPath') },
            ]}
            value={form.remoteDirMode ?? 'dialogue'}
            onChange={(remoteDirMode) => onChange({ remoteDirMode })}
            testID="collab.remoteDirMode"
          />
          {form.remoteDirMode === 'path' ? (
            <ContextSheetRow
              label={t('session.new.selectWorkspace')}
              value={form.remoteDir || t('session.new.chooseOtherFolder')}
              dismissBeforePress
              disabled={busy}
              onPress={onPickDirectory}
              trailing="chevron"
              testID="collab.remoteDirPicker"
            />
          ) : null}
        </ContextSheetGroup>
      ) : null}
      {executionDevicesError ? <ContextSheetGroup label={t('session.collab.executionDeviceLabel')}>
        <ContextSheetError text={executionDevicesError} />
      </ContextSheetGroup> : null}
      <ContextSheetGroup
        footer={form.model ? null : t('session.collab.modelDefaultHint')}
        label={title(t('session.collab.agentLabel'))}
      >
        <ContextSheetChoiceRow
          disabled={busy || agents.length < 2}
          label={t('session.collab.agentLabel')}
          onChange={onAgentChange}
          options={agents.map((agent) => ({ id: agent, label: orcaAgentLabel(agent) }))}
          testID="collab.agentOptions"
          value={form.agent}
        />
        <ContextSheetRow
          // iOS 原生 sheet 不能叠开:先收起 + 面板再打开模型选择器。
          dismissBeforePress
          disabled={busy}
          label={t('session.collab.modelLabel')}
          onPress={onPickModel}
          testID="collab.modelRow"
          trailing="chevron"
          value={modelLabel}
        />
      </ContextSheetGroup>
      <ContextSheetGroup
        footer={t(form.permissionMode === 'auto'
          ? 'session.collab.permissionAutoHint'
          : 'session.collab.permissionFullHint')}
        label={title(t('session.collab.permissionLabel'))}
      >
        <ContextSheetChoiceRow
          disabled={busy}
          label={t('session.collab.permissionLabel')}
          onChange={onPermissionChange}
          options={[
            { id: 'auto' as const, label: t('session.collab.permissionAuto') },
            { id: 'bypassPermissions' as const, label: t('session.collab.permissionFull') },
          ]}
          testID="collab.permissionOptions"
          value={form.permissionMode}
        />
      </ContextSheetGroup>
      <ContextSheetGroup footer={notice} label={t('session.collab.initialTaskLabel')}>
        <ContextSheetTextField
          accessibilityLabel={t('session.collab.initialTaskLabel')}
          disabled={busy}
          multiline
          onChange={(initialTask) => onChange({ initialTask })}
          placeholder={t('session.collab.initialTaskPlaceholder')}
          testID="collab.initialTaskInput"
          value={form.initialTask}
        />
      </ContextSheetGroup>
      {error ? (
        <ContextSheetGroup label="">
          <ContextSheetError text={error} testID="collab.formError" />
        </ContextSheetGroup>
      ) : null}
    </>
  );
}

export interface OrcaTeamPanelViewProps {
  workers: readonly OrcaTeamWorker[];
  /** null = 还没读到被控端设置:不在手机上判名额,由被控端裁决。 */
  settings: OrcaCollaborationSettings | null;
  loading: boolean;
  busy: boolean;
  error?: string | null;
  /** 点按:直接打开 Worker 任务。 */
  onWorkerPress(worker: OrcaTeamWorker): void;
  /** 长按:设为焦点 / 归档等管理操作。 */
  onWorkerLongPress(worker: OrcaTeamWorker): void;
  onCreateWorker(): void;
  onEndTeam(): void;
}

function WorkerStatusDot({ status }: { status: OrcaTeamWorker['status'] }) {
  const { colors } = useTheme();
  const color = status === 'running'
    ? colors.statusAccent
    : status === 'done'
      ? colors.statusDone
      : status === 'error'
        ? colors.statusError
        : colors.textTertiary;
  return (
    <View style={{ width: iconSize.lg, alignItems: 'center' }}>
      <View style={{ width: 8, height: 8, borderRadius: radius.pill, backgroundColor: color }} />
    </View>
  );
}

export function OrcaTeamPanelView({
  workers,
  settings,
  loading,
  busy,
  error,
  onWorkerPress,
  onWorkerLongPress,
  onCreateWorker,
  onEndTeam,
}: OrcaTeamPanelViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const running = workers.filter((worker) => worker.status === 'running').length;
  const slot = settings ? orcaWorkerSlotState(workers, settings) : 'ok';
  const createHint = settings && slot === 'hard'
    ? t('session.collab.hardLimitHint', { limit: settings.workerHardLimit })
    : settings && slot === 'soft'
      ? t('session.collab.softLimitHint', { limit: settings.workerSoftLimit })
      : null;
  return (
    <>
      <ContextSheetGroup label={t('session.collab.workerCountSummary', { count: workers.length, running })}>
        {workers.map((worker) => (
          <ContextSheetRow
            detail={(worker.executionDevice
              ? [
                  worker.executionDevice.deviceName ?? t('session.collab.otherComputer'),
                  ...(worker.executionDevice.reachable === false
                    ? [t('session.collab.deviceUnreachable')]
                    : [orcaAgentLabel(worker.agentKind), worker.model]),
                ]
              : [orcaAgentLabel(worker.agentKind), worker.model]
            ).filter(Boolean).join(' · ')}
            disabled={busy}
            icon={<WorkerStatusDot status={worker.status} />}
            key={worker.workerId}
            label={orcaWorkerDisplayName(worker)}
            onLongPress={() => onWorkerLongPress(worker)}
            onPress={() => onWorkerPress(worker)}
            testID={`collab.worker.${worker.workerId}`}
            trailing={worker.executionDevice?.reachable === false ? undefined : (
              <Text style={{ color: worker.status === 'error' ? colors.statusError : colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption }}>
                {orcaWorkerStatusLabel(worker.status)}
              </Text>
            )}
          />
        ))}
        {workers.length === 0 ? (
          <ContextSheetNote text={loading ? t('session.collab.loading') : t('session.collab.noWorkers')} />
        ) : null}
      </ContextSheetGroup>
      <ContextSheetGroup
        footer={[createHint, settings
          ? t('session.collab.limitSummary', { soft: settings.workerSoftLimit, hard: settings.workerHardLimit })
          : null].filter(Boolean).join('\n') || null}
        label={t('session.collab.manageGroup')}
      >
        <ContextSheetRow
          accessibilityHint={createHint ?? undefined}
          disabled={busy || slot === 'hard'}
          icon={<UserPlus color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
          label={t('session.collab.createWorkerTitle')}
          onPress={onCreateWorker}
          testID="collab.createWorkerRow"
          trailing="chevron"
        />
        <ContextSheetRow
          destructive
          disabled={busy}
          icon={<CircleStop color={colors.destructive} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
          label={t('session.collab.stop')}
          onPress={onEndTeam}
          testID="collab.stopRow"
        />
      </ContextSheetGroup>
      {error ? (
        <ContextSheetGroup label="">
          <ContextSheetError text={error} testID="collab.teamError" />
        </ContextSheetGroup>
      ) : null}
    </>
  );
}
