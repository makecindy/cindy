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
import { View } from 'react-native';
import { Bot, CircleStop, UserPlus } from 'lucide-react-native';
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
  ContextSheetNote,
  ContextSheetRow,
  ContextSheetTextField,
} from '@/session/ContextSheet';
import {
  orcaAgentLabel,
  orcaWorkerDisplayName,
  orcaWorkerStatusLabel,
  type OrcaWorkerFormValue,
} from '@/session/orcaTeam';
import { iconSize, iconStroke, lineHeight, radius, typeScale, useTheme } from '@/theme';

const CUSTOM_ROLE = '__custom__';

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
  return form.role.trim().length > 0 && orcaWorkerFormErrorKey(form, customRoleMode) === null;
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
  busy: boolean;
  notice?: string | null;
  error?: string | null;
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
  busy,
  notice,
  error,
}: OrcaWorkerFormViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const roleOptions = [
    ...ORCA_PREDEFINED_WORKER_ROLES.map((role) => ({ id: role as string, label: role as string })),
    { id: CUSTOM_ROLE, label: t('session.collab.customRole') },
  ];
  const validation = orcaWorkerFormErrorKey(form, customRoleMode);
  const modelLabel = form.model?.id ?? t('session.collab.modelDefault');
  return (
    <>
      <ContextSheetGroup label={t('session.collab.roleLabel')}>
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
        <ContextSheetNote text={validation ? t(validation) : t('session.collab.roleHint')} tone={validation ? 'error' : 'secondary'} />
      </ContextSheetGroup>
      <ContextSheetGroup label={t('session.collab.agentLabel')}>
        <ContextSheetChoiceRow
          disabled={busy || agents.length < 2}
          label={t('session.collab.agentLabel')}
          onChange={onAgentChange}
          options={agents.map((agent) => ({ id: agent, label: orcaAgentLabel(agent) }))}
          testID="collab.agentOptions"
          value={form.agent}
        />
        <ContextSheetRow
          detail={form.model ? undefined : t('session.collab.modelDefaultHint')}
          // iOS 原生 sheet 不能叠开:先收起 + 面板再打开模型选择器。
          dismissBeforePress
          disabled={busy}
          icon={<Bot color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
          label={t('session.collab.modelLabel')}
          onPress={onPickModel}
          testID="collab.modelRow"
          trailing={(
            <Text numberOfLines={1} style={{ color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, maxWidth: 180 }}>
              {modelLabel}
            </Text>
          )}
        />
      </ContextSheetGroup>
      <ContextSheetGroup label={t('session.collab.permissionLabel')}>
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
        <ContextSheetNote text={t(form.permissionMode === 'auto'
          ? 'session.collab.permissionAutoHint'
          : 'session.collab.permissionFullHint')}
        />
      </ContextSheetGroup>
      <ContextSheetGroup label={t('session.collab.initialTaskLabel')}>
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
      {notice || error ? (
        <ContextSheetGroup label="">
          {notice ? <ContextSheetNote text={notice} /> : null}
          {error ? <ContextSheetNote text={error} tone="error" testID="collab.formError" /> : null}
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
            detail={[
              orcaAgentLabel(worker.agentKind),
              worker.model,
            ].filter(Boolean).join(' · ')}
            disabled={busy}
            icon={<WorkerStatusDot status={worker.status} />}
            key={worker.workerId}
            label={orcaWorkerDisplayName(worker)}
            onLongPress={() => onWorkerLongPress(worker)}
            onPress={() => onWorkerPress(worker)}
            testID={`collab.worker.${worker.workerId}`}
            trailing={(
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
      <ContextSheetGroup label={t('session.collab.manageGroup')}>
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
      <ContextSheetGroup label="">
        {createHint ? <ContextSheetNote text={createHint} /> : null}
        {settings ? (
          <ContextSheetNote text={t('session.collab.limitSummary', {
            soft: settings.workerSoftLimit,
            hard: settings.workerHardLimit,
          })}
          />
        ) : null}
        {error ? <ContextSheetNote text={error} tone="error" testID="collab.teamError" /> : null}
      </ContextSheetGroup>
    </>
  );
}
