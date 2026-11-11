import { agentIslandSettings } from './AgentIslandSection.settings-search';
/**
 * AgentIslandSection — macOS Agent Island settings.
 *
 * The island is a native macOS surface, but renderer owns user preferences and
 * synchronizes them to main through the Agent Island preload API.
 */

import { useTranslation } from 'react-i18next';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, Volume2 } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';

import { SettingsBlock, SettingsCard, SettingsField, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useAgentIslandSettings } from '@/hooks/useAgentIslandSettings';
import anniePreviewUrl from '@/assets/agent-island-annie.png?url';
import blackcatPreviewUrl from '@/assets/agent-island-blackcat.png?url';
import boliPreviewUrl from '@/assets/agent-island-boli.png?url';
import chakuPreviewUrl from '@/assets/agent-island-chaku.png?url';
import cindyPreviewUrl from '@/assets/agent-island-cindy.png?url';
import erikaPreviewUrl from '@/assets/agent-island-erika.png?url';
import muffinPreviewUrl from '@/assets/agent-island-muffin.png?url';
import pululuPreviewUrl from '@/assets/agent-island-pululu.svg?url';
import tararaPreviewUrl from '@/assets/agent-island-tarara.png?url';
import whitesnowPreviewUrl from '@/assets/agent-island-whitesnow.png?url';
import {
  AGENT_ISLAND_MASCOT_SKINS,
  AGENT_ISLAND_SOUND_EVENTS,
  AGENT_ISLAND_SOUND_OPTIONS,
  type AgentIslandDisplayTarget,
  type AgentIslandMascotSkin,
  type AgentIslandSoundChoice,
  type AgentIslandSoundEvent,
  type AgentIslandSoundId,
  isSilentAgentIslandSoundChoice,
} from '../../../shared/agentIsland';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';

const MASCOT_PREVIEW_URLS: Record<AgentIslandMascotSkin, string> = {
  cindy: cindyPreviewUrl,
  blackcat: blackcatPreviewUrl,
  erika: erikaPreviewUrl,
  pululu: pululuPreviewUrl,
  tarara: tararaPreviewUrl,
  boli: boliPreviewUrl,
  whitesnow: whitesnowPreviewUrl,
  annie: anniePreviewUrl,
  chaku: chakuPreviewUrl,
  muffin: muffinPreviewUrl,
};

const CUSTOM_SOUND_OPTION_VALUE = '__custom__';
const DISPLAY_ALL_OPTION_VALUE = 'all';
const DISPLAY_OPTION_PREFIX = 'display:';
const MASCOT_ANIMATION_MODES = ['idle', 'working', 'waitingApproval', 'completed'] as const;
type MascotAnimationMode = typeof MASCOT_ANIMATION_MODES[number];
type MascotAnimationSteps = Record<AgentIslandMascotSkin, number>;
const MASCOT_PREVIEW_VIEWBOX_SIZE = 16;
/** 键帽圆角:原 SVG rect rx=0.12(键帽 1.8x0.7),换算成 CSS 双轴百分比。 */

// 眼睛几何与配色必须与原生侧 SpriteMascotConfig 保持一致
// (native/agent-island/macos-agent-island-helper.swift)，否则设置页预览和灵动岛实际渲染会不一样。
const MASCOT_PREVIEW_CONFIGS: Record<Exclude<AgentIslandMascotSkin, 'pululu'>, MascotPreviewConfig> = {
  cindy: {
    eyeColor: 'rgb(107 61 50)',
    eyeLeftX: 6.71,
    eyeRightX: 9.3,
    eyeY: 9.5,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  blackcat: {
    eyeColor: 'rgb(253 207 69)',
    eyeLeftX: 5.95,
    eyeRightX: 10.05,
    eyeY: 9.05,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  erika: {
    eyeColor: 'rgb(135 93 66)',
    eyeLeftX: 6.84,
    eyeRightX: 9.16,
    eyeY: 10.75,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  tarara: {
    eyeColor: 'rgb(61 114 228)',
    eyeLeftX: 6.9,
    eyeRightX: 9.7,
    eyeY: 10.4,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  boli: {
    eyeColor: 'black',
    eyeLeftX: 5.63,
    eyeRightX: 10.63,
    eyeY: 8.13,
    eyeRx: 0.88,
    eyeRy: 0.88,
    imageScale: 0.8,
  },
  whitesnow: {
    eyeColor: 'black',
    eyeLeftX: 6.86,
    eyeRightX: 9.5,
    eyeY: 9.64,
    eyeRx: 0.465,
    eyeRy: 1.02,
  },
  annie: {
    eyeColor: 'rgb(174 33 70)',
    eyeLeftX: 6.31,
    eyeRightX: 9.56,
    eyeY: 11.69,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  chaku: {
    eyeColor: 'rgb(253 207 69)',
    eyeLeftX: 6.19,
    eyeRightX: 9.69,
    eyeY: 9.69,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  muffin: {
    eyeColor: 'black',
    eyeLeftX: 5.56,
    eyeRightX: 10.56,
    eyeY: 9.31,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
};

/** 让各角色的预览动画错峰起步(按皮肤顺序轮转到不同动画模式)，新增皮肤自动纳入。 */
const DEFAULT_MASCOT_ANIMATION_STEPS: MascotAnimationSteps = Object.fromEntries(
  AGENT_ISLAND_MASCOT_SKINS.map((skin, index) => [skin, index % MASCOT_ANIMATION_MODES.length]),
) as MascotAnimationSteps;

interface MascotPreviewConfig {
  eyeColor: string;
  eyeLeftX: number;
  eyeRightX: number;
  eyeY: number;
  eyeRx: number;
  eyeRy: number;
  imageScale?: number;
}

export function AgentIslandSection() {
  const {
    enabled,
    setEnabled,
    subtleReminders,
    subtleRemindersCustomized,
    setSubtleReminders,
    resetSubtleReminders,
    liveActivity,
    liveActivityCustomized,
    liveActivitySupported,
    setLiveActivity,
    resetLiveActivity,
    soundSettings,
    soundCustomized,
    mascotSkin,
    displayTarget,
    displayOptions,
    setSoundEnabled,
    setSound,
    resetSoundSettings,
    setMascotSkin,
    setDisplayTarget,
    previewSound,
    selectSoundFile,
    supported,
  } = useAgentIslandSettings();
  const { t } = useTranslation();
  const [animationSteps, setAnimationSteps] = useState<MascotAnimationSteps>(DEFAULT_MASCOT_ANIMATION_STEPS);
  // The character list is a disclosure: the card shows only the current character until opened.
  const [skinsOpen, setSkinsOpen] = useState(false);
  const { entry: searchEntry, activation: searchActivation } = useSettingsSearchNavigation();
  useEffect(() => {
    // Searching a character name lands here; never hide what the search pointed at.
    if (searchEntry?.id === agentIslandSettings.skinLabel.id) setSkinsOpen(true);
  }, [searchEntry, searchActivation]);
  const [soundResetPending, setSoundResetPending] = useState(false);
  const [subtleRemindersPending, setSubtleRemindersPending] = useState(false);
  const handleSubtleRemindersChange = async (next: boolean) => {
    setSubtleRemindersPending(true);
    try {
      if (!await setSubtleReminders(next)) toast.error(t('settings.agentIsland.subtleRemindersFailed'));
    } finally {
      setSubtleRemindersPending(false);
    }
  };
  const [liveActivityPending, setLiveActivityPending] = useState(false);
  const handleLiveActivityChange = async (next: boolean) => {
    setLiveActivityPending(true);
    try {
      if (!await setLiveActivity(next)) toast.error(t('settings.agentIsland.liveActivityFailed'));
    } finally {
      setLiveActivityPending(false);
    }
  };
  const handleResetLiveActivity = async () => {
    setLiveActivityPending(true);
    try {
      if (await resetLiveActivity()) toast.success(t('settings.defaults.restored'));
      else toast.error(t('settings.defaults.restoreFailed'));
    } finally {
      setLiveActivityPending(false);
    }
  };
  const handleResetSubtleReminders = async () => {
    setSubtleRemindersPending(true);
    try {
      if (await resetSubtleReminders()) toast.success(t('settings.defaults.restored'));
      else toast.error(t('settings.defaults.restoreFailed'));
    } finally {
      setSubtleRemindersPending(false);
    }
  };
  const displayOptionLabels = useMemo(() => {
    return new Map(displayOptions.map((option) => {
      const resolution = `${Math.round(option.bounds.width)} x ${Math.round(option.bounds.height)}`;
      const name = option.name.trim() || t('settings.agentIsland.displayNameFallback', { index: option.index });
      const tags = [
        option.isPrimary ? t('settings.agentIsland.displayPrimary') : null,
        option.internal ? t('settings.agentIsland.displayInternal') : null,
      ].filter(Boolean);
      const base = t('settings.agentIsland.displayOption', {
        name,
        resolution,
      });
      return [
        option.id,
        tags.length > 0 ? `${base} · ${tags.join(' · ')}` : base,
      ];
    }));
  }, [displayOptions, t]);
  const selectedDisplayMissing = displayTarget.mode === 'display'
    && !displayOptions.some((option) => option.id === displayTarget.displayId);

  const handleResetSoundSettings = useCallback(async () => {
    setSoundResetPending(true);
    try {
      const restored = await resetSoundSettings();
      if (restored) {
        toast.success(t('settings.defaults.restored'));
      } else {
        toast.error(t('settings.defaults.restoreFailed'));
      }
    } finally {
      setSoundResetPending(false);
    }
  }, [resetSoundSettings, t]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setAnimationSteps((current) => advanceAllMascotAnimationSteps(current));
    }, 1_700);
    return () => window.clearInterval(timer);
  }, []);

  const handleNextMascotAnimation = useCallback((skin: AgentIslandMascotSkin) => {
    setAnimationSteps((current) => advanceMascotAnimationStep(current, skin));
  }, []);

  // Character and sounds stay reachable when only the Live Activity is on.
  const sharedVisible = enabled || (liveActivitySupported && liveActivity);

  if (!supported) {
    return (
      <SettingsSection variant="page" title={t('settings.agentIsland.title')}>
        <SettingsCard>
          <SettingsBlock>
            <p className="text-13 leading-[1.45] text-[var(--text-secondary)]">
              {t('settings.agentIsland.unsupported')}
            </p>
          </SettingsBlock>
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection variant="page" title={t('settings.agentIsland.title')}>
      {/* 几张卡片同属一组，彼此 14px */}
      <SettingsSection>
        {/* Agent Notch's own options grow out of its card, so they read as part of it. */}
        <SettingsCard className="flex flex-col">
          <SettingsRow
            title={<span id={agentIslandSettings.enableLabel.targetId}>{t(agentIslandSettings.enableLabel.titleKey)}</span>}
            hint={t(agentIslandSettings.enableLabel.descriptionKey)}
            trailing={
              <Switch data-setting-id={agentIslandSettings.enableLabel.id}
                checked={enabled}
                onCheckedChange={setEnabled}
                aria-label={t('settings.agentIsland.enableAria')}
              />
            }
          />
          {enabled && (
            <>
              <SettingsRow
                title={<span id={agentIslandSettings.subtleRemindersLabel.targetId}>{t(agentIslandSettings.subtleRemindersLabel.titleKey)}</span>}
                hint={t(agentIslandSettings.subtleRemindersLabel.descriptionKey)}
                trailing={
                  <div className="flex shrink-0 items-center gap-2">
                    <DefaultOverrideControls
                      isCustomized={subtleRemindersCustomized}
                      disabled={subtleRemindersPending}
                      onReset={() => void handleResetSubtleReminders()}
                    />
                    <Switch
                      data-setting-id={agentIslandSettings.subtleRemindersLabel.id}
                      checked={subtleReminders}
                      disabled={subtleRemindersPending}
                      onCheckedChange={handleSubtleRemindersChange}
                      aria-label={t('settings.agentIsland.subtleRemindersLabel')}
                    />
                  </div>
                }
              />
              {/* 显示器选择整宽放在说明下面，不是左右一行 */}
              <SettingsField
                title={<span id={agentIslandSettings.displayLabel.targetId}>{t(agentIslandSettings.displayLabel.titleKey)}</span>}
                hint={t(agentIslandSettings.displayLabel.descriptionKey)}
              >
                <Select data-setting-id={agentIslandSettings.displayLabel.id}
                  width="full"
                  value={displayTargetToOptionValue(displayTarget)}
                  onValueChange={(value) => setDisplayTarget(displayTargetFromOptionValue(value))}
                  label={t('settings.agentIsland.displaySelectAria')}
                  options={[
                    { value: DISPLAY_ALL_OPTION_VALUE, label: t('settings.agentIsland.displayAll') },
                    ...displayOptions.map((option) => ({
                      value: displayTargetToOptionValue({ mode: 'display', displayId: option.id }),
                      label: displayOptionLabels.get(option.id) ?? '',
                    })),
                    ...(selectedDisplayMissing
                      ? [{
                          value: displayTargetToOptionValue(displayTarget),
                          label: t('settings.agentIsland.displayMissing', { id: displayTarget.displayId }),
                        }]
                      : []),
                  ]}
                />
              </SettingsField>
            </>
          )}
        </SettingsCard>

        {/* Independent of our own island: the system shows it even when ours is off. */}
        {liveActivitySupported && (
          <SettingsCard>
            <SettingsRow
              title={<span id={agentIslandSettings.liveActivityLabel.targetId}>{t(agentIslandSettings.liveActivityLabel.titleKey)}</span>}
              hint={t(agentIslandSettings.liveActivityLabel.descriptionKey)}
              trailing={
                <div className="flex shrink-0 items-center gap-2">
                  <DefaultOverrideControls
                    isCustomized={liveActivityCustomized}
                    disabled={liveActivityPending}
                    onReset={() => void handleResetLiveActivity()}
                  />
                  <Switch
                    data-setting-id={agentIslandSettings.liveActivityLabel.id}
                    checked={liveActivity}
                    disabled={liveActivityPending}
                    onCheckedChange={(next) => void handleLiveActivityChange(next)}
                    aria-label={t('settings.agentIsland.liveActivityLabel')}
                  />
                </div>
              }
            />
          </SettingsCard>
        )}

        {/* Character and event sounds serve Agent Notch and the Live Activity alike; they
        show whenever either is on, so no heading is needed. */}
        {sharedVisible && (
          <>
            <SettingsCard className="flex flex-col">
              <SettingsRow
                data-setting-id={agentIslandSettings.skinLabel.id}
                aria-expanded={skinsOpen}
                aria-controls="settings-agent-island-skins"
                onClick={() => setSkinsOpen((open) => !open)}
                title={<span id={agentIslandSettings.skinLabel.targetId}>{t(agentIslandSettings.skinLabel.titleKey)}</span>}
                hint={t(agentIslandSettings.skinLabel.descriptionKey)}
                trailing={
                  <span className="flex shrink-0 items-center gap-2">
                    {/* The list's own preview, scaled down: sprite PNGs carry no eyes on their own. */}
                    <span className="relative h-8 w-9 overflow-hidden rounded-lg" aria-hidden="true">
                      <span className="absolute left-0 top-0 origin-top-left scale-[0.64]">
                        <MascotPreview skin={mascotSkin} mode={animationModeForStep(animationSteps[mascotSkin])} />
                      </span>
                    </span>
                    <span className="text-13 text-[var(--text-secondary)]">
                      {t(`settings.agentIsland.skins.${mascotSkin}.name`)}
                    </span>
                    <ChevronDown
                      size={15}
                      className={cn('text-[var(--text-secondary-mid)] transition-transform', skinsOpen && 'rotate-180')}
                      aria-hidden="true"
                    />
                  </span>
                }
              />
              {skinsOpen && (
                <>
                  <SettingsBlock id="settings-agent-island-skins" className="grid gap-2">
                    {AGENT_ISLAND_MASCOT_SKINS.map((skin) => (
                      <AgentIslandSkinRow
                        key={skin}
                        skin={skin}
                        animationMode={animationModeForStep(animationSteps[skin])}
                        onNextAnimation={handleNextMascotAnimation}
                        selected={mascotSkin === skin}
                        onSelect={setMascotSkin}
                      />
                    ))}
                  </SettingsBlock>
                </>
              )}
            </SettingsCard>

            <SettingsCard className="flex flex-col">
              <SettingsRow
                title={<span id={agentIslandSettings.soundLabel.targetId}>{t(agentIslandSettings.soundLabel.titleKey)}</span>}
                hint={t(agentIslandSettings.soundLabel.descriptionKey)}
                trailing={
                  <div className="flex shrink-0 items-center gap-2">
                    <DefaultOverrideControls
                      isCustomized={soundCustomized}
                      disabled={soundResetPending}
                      onReset={() => void handleResetSoundSettings()}
                    />
                    <Switch data-setting-id={agentIslandSettings.soundLabel.id}
                      checked={soundSettings.enabled}
                      disabled={soundResetPending}
                      onCheckedChange={setSoundEnabled}
                      aria-label={t('settings.agentIsland.soundAria')}
                    />
                  </div>
                }
              />

              {soundSettings.enabled && (
                <SettingsBlock className="grid gap-2">
                  {AGENT_ISLAND_SOUND_EVENTS.map((event) => (
                    <AgentIslandSoundRow
                      key={event}
                      event={event}
                      value={soundSettings.sounds[event]}
                      onChange={(sound) => setSound(event, sound)}
                      onSelectCustom={selectSoundFile}
                      onPreview={previewSound}
                    />
                  ))}
                </SettingsBlock>
              )}
            </SettingsCard>
          </>
        )}
      </SettingsSection>
    </SettingsSection>
  );
}

function AgentIslandSkinRow({
  skin,
  animationMode,
  onNextAnimation,
  selected,
  onSelect,
}: {
  skin: AgentIslandMascotSkin;
  animationMode: MascotAnimationMode;
  onNextAnimation: (skin: AgentIslandMascotSkin) => void;
  selected: boolean;
  onSelect: (skin: AgentIslandMascotSkin) => void;
}) {
  const { t } = useTranslation();
  const skinName = t(`settings.agentIsland.skins.${skin}.name`);
  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect(skin);
  };
  const handlePreviewClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onNextAnimation(skin);
  };

  return (
    <div
      role="button"
      data-setting-id={agentIslandSettings.skinLabel.id}
      tabIndex={0}
      onClick={() => onSelect(skin)}
      onKeyDown={handleRowKeyDown}
      className={cn(
        'grid cursor-pointer grid-cols-[64px_minmax(0,1fr)_20px] items-center gap-3 rounded-xl border p-3 text-left outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        selected
          ? 'border-[var(--settings-menu-border-selected)] bg-[var(--settings-menu-bg-selected)]'
          : 'border-[var(--settings-theme-card-border)] hover:bg-[var(--settings-menu-bg-hover)]',
      )}
      aria-pressed={selected}
    >
      <button data-settings-search-action="Preview the next mascot animation"
        type="button"
        onClick={handlePreviewClick}
        className={cn(
          'flex h-12 w-14 items-center justify-center rounded-lg outline-none transition-colors',
          'bg-[var(--surface-chip)] hover:bg-[var(--settings-menu-bg-hover)]',
          'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        )}
        aria-label={t('settings.agentIsland.skinAnimationAria', { skin: skinName })}
      >
        <MascotPreview skin={skin} mode={animationMode} />
      </button>
      <div className="min-w-0">
        <p className="truncate text-13 font-medium text-[var(--settings-section-sublabel)]">
          {skinName}
        </p>
        <p className="mt-1 line-clamp-2 text-12 leading-[1.35] text-[var(--text-secondary)]">
          {t(`settings.agentIsland.skins.${skin}.description`)}
        </p>
      </div>
      <span
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-full border',
          selected
            ? 'border-[var(--settings-menu-border-selected)] text-[var(--settings-menu-text-selected)]'
            : 'border-[var(--settings-theme-card-border)] text-transparent',
        )}
      >
        <Check size={13} />
      </span>
    </div>
  );
}

function MascotPreview({
  skin,
  mode,
}: {
  skin: AgentIslandMascotSkin;
  mode: MascotAnimationMode;
}) {
  const sparkleCount = mode === 'completed' ? 3 : mode === 'waitingApproval' ? 2 : 0;
  return (
    <div
      className="agent-island-mascot-stage relative flex h-12 w-14 items-center justify-center overflow-hidden rounded-lg"
      data-motion={mode}
    >
      {Array.from({ length: sparkleCount }, (_, index) => (
        <span
          key={index}
          className="agent-island-mascot-sparkle"
          style={{ '--agent-island-sparkle-delay': `${index * 95}ms` } as CSSProperties}
          aria-hidden="true"
        />
      ))}
      {skin === 'pululu' ? (
        <MascotPreviewImage src={MASCOT_PREVIEW_URLS[skin]} animated />
      ) : (
        <SpriteMascotPreview src={MASCOT_PREVIEW_URLS[skin]} config={MASCOT_PREVIEW_CONFIGS[skin]} />
      )}
    </div>
  );
}

function MascotPreviewImage({
  src,
  animated = false,
}: {
  src: string;
  animated?: boolean;
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn(
        'h-10 w-10 select-none object-contain',
        animated && 'agent-island-mascot-character',
      )}
    />
  );
}

/**
 * Sprite 皮肤预览:眼睛用绝对定位 HTML 元素表达(原为内联 SVG),
 * 让 eye-focus 等常驻动画挂在 HTML 上(规则 7)。
 * props(src / config)均为模块常量,memo 让 1.7s 轮播 tick 不再重渲此子树
 * (动画模式切换走父级 data-motion 属性,不经过本组件)。
 */
const SpriteMascotPreview = memo(function SpriteMascotPreview({
  src,
  config,
}: {
  src: string;
  config: MascotPreviewConfig;
}) {
  const eyesBox = getMascotEyesBox(config);
  return (
    <div className="relative h-10 w-10">
      <div
        className="agent-island-mascot-character absolute inset-0 flex items-center justify-center"
        style={{ '--agent-island-mascot-scale': config.imageScale ?? 1 } as CSSProperties}
      >
        <MascotPreviewImage src={src} />
        <div
          className="agent-island-mascot-eyes pointer-events-none absolute"
          style={mascotViewBoxStyle(eyesBox.x, eyesBox.y, eyesBox.width, eyesBox.height)}
          aria-hidden="true"
        >
          {/* 眼睛盒左边界 = 左眼左缘、右边界 = 右眼右缘,两眼贴边定位即可 */}
          {(['left', 'right'] as const).map((side) => (
            <span
              key={side}
              className="absolute top-0 block h-full rounded-[50%]"
              style={{
                [side]: 0,
                width: pct(config.eyeRx * 2, eyesBox.width),
                backgroundColor: config.eyeColor,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

/** viewBox 坐标(x/y/宽/高)→ 相对父容器的百分比定位样式。 */
function mascotViewBoxStyle(
  x: number,
  y: number,
  width: number,
  height: number,
): CSSProperties {
  return {
    left: pct(x),
    top: pct(y),
    width: pct(width),
    height: pct(height),
  };
}

/** 两眼外接盒(即原 SVG <g> 的 fill-box,eye-focus 的 scaleY 以其中心为原点)。 */
function getMascotEyesBox(config: MascotPreviewConfig) {
  const left = config.eyeLeftX - config.eyeRx;
  const top = config.eyeY - config.eyeRy;
  return {
    x: left,
    y: top,
    width: config.eyeRightX + config.eyeRx - left,
    height: config.eyeRy * 2,
  };
}

function pct(value: number, base: number = MASCOT_PREVIEW_VIEWBOX_SIZE): string {
  return `${(value / base) * 100}%`;
}

function animationModeForStep(step: number): MascotAnimationMode {
  return MASCOT_ANIMATION_MODES[step % MASCOT_ANIMATION_MODES.length] ?? 'idle';
}

function advanceMascotAnimationStep(
  current: MascotAnimationSteps,
  skin: AgentIslandMascotSkin,
): MascotAnimationSteps {
  return {
    ...current,
    [skin]: current[skin] + 1,
  };
}

function advanceAllMascotAnimationSteps(current: MascotAnimationSteps): MascotAnimationSteps {
  return Object.fromEntries(
    AGENT_ISLAND_MASCOT_SKINS.map((skin) => [skin, current[skin] + 1]),
  ) as MascotAnimationSteps;
}

function displayTargetToOptionValue(target: AgentIslandDisplayTarget): string {
  return target.mode === 'display'
    ? `${DISPLAY_OPTION_PREFIX}${target.displayId}`
    : DISPLAY_ALL_OPTION_VALUE;
}

function displayTargetFromOptionValue(value: string): AgentIslandDisplayTarget {
  if (value.startsWith(DISPLAY_OPTION_PREFIX)) {
    const displayId = Number(value.slice(DISPLAY_OPTION_PREFIX.length));
    if (Number.isFinite(displayId)) {
      return { mode: 'display', displayId };
    }
  }
  return { mode: 'all' };
}

function AgentIslandSoundRow({
  event,
  value,
  onChange,
  onSelectCustom,
  onPreview,
}: {
  event: AgentIslandSoundEvent;
  value: AgentIslandSoundChoice;
  onChange: (sound: AgentIslandSoundChoice) => void;
  onSelectCustom: () => Promise<AgentIslandSoundChoice | null>;
  onPreview: (sound: AgentIslandSoundChoice) => void;
}) {
  const { t } = useTranslation();
  const selectValue = value.type === 'builtin' ? value.id : CUSTOM_SOUND_OPTION_VALUE;
  return (
    <div className="grid grid-cols-[minmax(88px,1fr)_minmax(150px,220px)_32px] items-center gap-2">
      <label
        className="truncate text-12 text-[var(--text-secondary)]"
        htmlFor={`agent-island-sound-${event}`}
      >
        {t(`settings.agentIsland.soundEvents.${event}`)}
      </label>
      {/* Dense per-event list: compact 32px trigger filling its grid column. */}
      <Select data-setting-id={agentIslandSettings.soundLabel.id}
        id={`agent-island-sound-${event}`}
        size="compact"
        width="full"
        truncateOptions
        value={selectValue}
        onValueChange={async (next) => {
          if (next === CUSTOM_SOUND_OPTION_VALUE) {
            const customSound = await onSelectCustom();
            if (customSound) onChange(customSound);
            return;
          }
          onChange({ type: 'builtin', id: next as AgentIslandSoundId });
        }}
        label={t('settings.agentIsland.soundSelectAria', {
          event: t(`settings.agentIsland.soundEvents.${event}`),
        })}
        options={[
          ...AGENT_ISLAND_SOUND_OPTIONS.map((option) => ({
            value: option,
            label: t(`settings.agentIsland.soundOptions.${option}`),
          })),
          {
            value: CUSTOM_SOUND_OPTION_VALUE,
            label: value.type === 'custom'
              ? t('settings.agentIsland.soundOptions.customSelected', { name: value.name })
              : t('settings.agentIsland.soundOptions.custom'),
          },
        ]}
      />
      <Tip
        text={t('settings.agentIsland.soundPreviewAria', {
          event: t(`settings.agentIsland.soundEvents.${event}`),
        })}
        side="top"
      >
        <button data-settings-search-action="Preview the selected notification sound"
          type="button"
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
            'border-[var(--settings-input-border)] text-[var(--settings-section-sublabel)]',
            'hover:bg-[var(--surface-chip)] disabled:cursor-default disabled:opacity-35',
          )}
          disabled={isSilentAgentIslandSoundChoice(value)}
          onClick={() => onPreview(value)}
          aria-label={t('settings.agentIsland.soundPreviewAria', {
            event: t(`settings.agentIsland.soundEvents.${event}`),
          })}
        >
          <Volume2 size={14} aria-hidden />
        </button>
      </Tip>
    </div>
  );
}
