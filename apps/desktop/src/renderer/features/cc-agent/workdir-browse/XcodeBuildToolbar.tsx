import {
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Hammer,
  LoaderCircle,
  Monitor,
  Play,
  RefreshCw,
  RotateCw,
  Smartphone,
  Square,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';
import type { UseXcodeBuildReturn } from './hooks/useXcodeBuild';

const TOOLBAR_BUTTON_CLASS =
  'flex size-6 items-center justify-center rounded-full text-[var(--settings-section-desc)] transition-colors hover:bg-[var(--chat-input-chip-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-40';

export function XcodeBuildToolbar({ xcode }: { xcode: UseXcodeBuildReturn }) {
  const { t } = useTranslation();
  const running = xcode.build?.status === 'running';
  const canHotAction = Boolean(
    running && xcode.build?.phase === 'launched' && xcode.build.supportsHotReload,
  );
  // 原生 iOS/Android 产物启动后没有热重载通道(只有 Flutter 有),此时再点编译
  // 的语义是「重新编译并安装」:主进程会先结束已启动的旧进程再重跑 build/install/launch。
  // 没有这一条时,原生 App 一旦启动就只剩「停止」可点,编译按钮永久禁用。
  const canRelaunch = Boolean(
    running && xcode.build?.phase === 'launched' && !xcode.build.supportsHotReload,
  );
  const canBuild = Boolean(
    !xcode.loading &&
      xcode.selectedScheme &&
      xcode.selectedDestination &&
      (!running || canRelaunch),
  );
  const selectedProject = xcode.projects.find(
    (project) => project.containerPath === xcode.selectedContainerPath,
  );
  const simulators = xcode.destinations.filter((destination) => destination.kind === 'simulator');
  const devices = xcode.destinations.filter((destination) => destination.kind === 'device');

  return (
    <div
      className="flex min-w-0 shrink-0 select-none items-center justify-end gap-1 px-2"
      style={WINDOW_NO_DRAG_STYLE}
    >
      {xcode.error && (
        <Tip text={xcode.error} side="bottom">
          <span
            className="flex size-6 items-center justify-center text-[var(--text-danger)]"
            role="img"
            aria-label={xcode.error}
          >
            <CircleAlert size={14} strokeWidth={2} />
          </span>
        </Tip>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={running || xcode.loading}
            className={cn(
              'flex h-6 max-w-[220px] min-w-0 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-2',
              'bg-[var(--surface-elevated)] text-12 text-[var(--text-primary)]',
              'transition-colors hover:bg-[var(--button-secondary-hover)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              'disabled:cursor-default disabled:opacity-70',
            )}
            aria-label={t('ccAgent.workdirBrowse.xcode.target')}
          >
            {running && xcode.build?.phase !== 'launched' ? (
              <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
            ) : xcode.selectedDestination?.kind === 'simulator' ? (
              <Monitor size={13} strokeWidth={2} />
            ) : (
              <Smartphone size={13} strokeWidth={2} />
            )}
            <span className="min-w-0 truncate">
              {xcode.selectedDestination?.name ??
                (xcode.loading
                  ? t('ccAgent.workdirBrowse.xcode.findingTargets')
                  : t('ccAgent.workdirBrowse.xcode.noTarget'))}
            </span>
            <ChevronDown size={12} strokeWidth={2} className="shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="max-h-[70vh] w-64 overflow-y-auto"
        >
          {xcode.projects.length > 1 && (
            <>
              <DropdownMenuLabel>{t('ccAgent.workdirBrowse.xcode.project')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={xcode.selectedContainerPath ?? ''}
                onValueChange={(value) => void xcode.selectProject(value)}
              >
                {xcode.projects.map((project) => (
                  <DropdownMenuRadioItem key={project.containerPath} value={project.containerPath}>
                    <span className="min-w-0 truncate" title={project.containerPath}>
                      {project.containerPath}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel>{t('ccAgent.workdirBrowse.xcode.scheme')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={xcode.selectedScheme ?? ''}
            onValueChange={(value) => void xcode.selectScheme(value)}
          >
            {xcode.schemes.map((scheme) => (
              <DropdownMenuRadioItem key={scheme} value={scheme}>
                <span className="min-w-0 truncate">{scheme}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <XcodeDestinationGroup
            label={t('ccAgent.workdirBrowse.xcode.simulators')}
            destinations={simulators}
            selectedId={xcode.selectedDestination?.id ?? null}
            onSelect={xcode.selectDestination}
          />
          {simulators.length > 0 && devices.length > 0 && <DropdownMenuSeparator />}
          <XcodeDestinationGroup
            label={t('ccAgent.workdirBrowse.xcode.devices')}
            destinations={devices}
            selectedId={xcode.selectedDestination?.id ?? null}
            onSelect={xcode.selectDestination}
          />
          {xcode.destinations.length === 0 && (
            <div className="px-2.5 py-2 text-12 text-[var(--text-secondary)]">
              {t('ccAgent.workdirBrowse.xcode.noTargets')}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Tip text={t('ccAgent.workdirBrowse.xcode.build')} side="bottom">
        <button
          type="button"
          aria-label={t('ccAgent.workdirBrowse.xcode.build')}
          disabled={!canBuild}
          onClick={() => void xcode.startBuild()}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <Play size={13} strokeWidth={2.2} fill="currentColor" />
        </button>
      </Tip>
      <Tip text={t('ccAgent.workdirBrowse.xcode.stop')} side="bottom">
        <button
          type="button"
          aria-label={t('ccAgent.workdirBrowse.xcode.stop')}
          disabled={!running}
          onClick={() => void xcode.stopBuild()}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <Square size={12} strokeWidth={2.2} fill="currentColor" />
        </button>
      </Tip>

      {running && xcode.build?.supportsHotReload && (
        <>
          <Tip text={t('ccAgent.workdirBrowse.xcode.hotReload')} side="bottom">
            <button
              type="button"
              aria-label={t('ccAgent.workdirBrowse.xcode.hotReload')}
              disabled={!canHotAction}
              onClick={() => void xcode.hotReload()}
              className={TOOLBAR_BUTTON_CLASS}
            >
              <RefreshCw size={13} strokeWidth={2} />
            </button>
          </Tip>
          <Tip text={t('ccAgent.workdirBrowse.xcode.hotRestart')} side="bottom">
            <button
              type="button"
              aria-label={t('ccAgent.workdirBrowse.xcode.hotRestart')}
              disabled={!canHotAction}
              onClick={() => void xcode.hotRestart()}
              className={TOOLBAR_BUTTON_CLASS}
            >
              <RotateCw size={13} strokeWidth={2} />
            </button>
          </Tip>
        </>
      )}

      {xcode.build && (
        <Tip text={t('ccAgent.workdirBrowse.xcode.output')} side="bottom">
          <button
            type="button"
            aria-label={t('ccAgent.workdirBrowse.xcode.output')}
            aria-pressed={xcode.outputExpanded}
            onClick={xcode.toggleOutput}
            className={TOOLBAR_BUTTON_CLASS}
          >
            <TerminalSquare size={14} strokeWidth={2} />
          </button>
        </Tip>
      )}

      <span
        className="flex size-5 items-center justify-center"
        aria-hidden
        title={selectedProject?.name}
      >
        {xcode.build?.status === 'succeeded' ? (
          <CheckCircle2 size={14} strokeWidth={2} />
        ) : xcode.build?.status === 'failed' ? (
          <XCircle size={14} strokeWidth={2} />
        ) : xcode.build?.status === 'cancelled' ? (
          <Ban size={14} strokeWidth={2} />
        ) : (
          <Hammer size={14} strokeWidth={2} />
        )}
      </span>
    </div>
  );
}

function XcodeDestinationGroup({
  label,
  destinations,
  selectedId,
  onSelect,
}: {
  label: string;
  destinations: UseXcodeBuildReturn['destinations'];
  selectedId: string | null;
  onSelect: (destinationId: string) => void;
}) {
  if (destinations.length === 0) return null;
  return (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={selectedId ?? ''} onValueChange={onSelect}>
        {destinations.map((destination) => (
          <DropdownMenuRadioItem
            key={`${destination.platform}:${destination.id}`}
            value={destination.id}
          >
            {destination.kind === 'simulator' ? (
              <Monitor size={13} strokeWidth={2} className="shrink-0" />
            ) : (
              <Smartphone size={13} strokeWidth={2} className="shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{destination.name}</span>
            {destination.osVersion && (
              <span className="ml-auto shrink-0 text-11 text-[var(--text-secondary)]">
                {destination.osVersion}
              </span>
            )}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
