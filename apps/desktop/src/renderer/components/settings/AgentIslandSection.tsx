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
const MASCOT_KEY_BORDER_RADIUS = `${(0.12 / 1.8) * 100}% / ${(0.12 / 0.7) * 100}%`;
const MASCOT_KEY_RECTS = Array.from({ length: 12 }, (_, index) => index);

// 眼睛几何与配色必须与原生侧 SpriteMascotConfig 保持一致
// (native/agent-island/macos-agent-island-helper.swift)，否则设置页预览和灵动岛实际渲染会不一样。
const MASCOT_PREVIEW_CONFIGS: Record<Exclude<AgentIslandMascotSkin, 'pululu'>, MascotPreviewConfig> = {
  cindy: {
    keyboardBase: 'rgb(38 43 69)',
    keyboardKey: 'rgb(103 118 240)',
    eyeColor: 'rgb(107 61 50)',
    eyeLeftX: 6.71,
    eyeRightX: 9.3,
    eyeY: 9.5,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  blackcat: {
    keyboardBase: 'rgb(31 36 41)',
    keyboardKey: 'rgb(103 118 240)',
    eyeColor: 'rgb(253 207 69)',
    eyeLeftX: 5.95,
    eyeRightX: 10.05,
    eyeY: 9.05,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  erika: {
    keyboardBase: 'rgb(51 71 77)',
    keyboardKey: 'rgb(90 156 170)',
    eyeColor: 'rgb(135 93 66)',
    eyeLeftX: 6.84,
    eyeRightX: 9.16,
    eyeY: 10.75,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  tarara: {
    keyboardBase: '#00615c',
    keyboardKey: '#00d9c5',
    eyeColor: 'rgb(61 114 228)',
    eyeLeftX: 6.9,
    eyeRightX: 9.7,
    eyeY: 10.4,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  boli: {
    keyboardBase: '#292e3a',
    keyboardKey: '#707d94',
    eyeColor: 'black',
    eyeLeftX: 5.63,
    eyeRightX: 10.63,
    eyeY: 8.13,
    eyeRx: 0.88,
    eyeRy: 0.88,
    imageScale: 0.8,
  },
  whitesnow: {
    keyboardBase: '#292e3a',
    keyboardKey: '#707d94',
    eyeColor: 'black',
    eyeLeftX: 6.86,
    eyeRightX: 9.5,
    eyeY: 9.64,
    eyeRx: 0.465,
    eyeRy: 1.02,
  },
  annie: {
    keyboardBase: '#2e6b8f',
    keyboardKey: '#77c4ea',
    eyeColor: 'rgb(174 33 70)',
    eyeLeftX: 6.31,
    eyeRightX: 9.56,
    eyeY: 11.69,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  chaku: {
    keyboardBase: 'rgb(115 82 8)',
    keyboardKey: 'rgb(253 207 69)',
    eyeColor: 'rgb(253 207 69)',
    eyeLeftX: 6.19,
    eyeRightX: 9.69,
    eyeY: 9.69,
    eyeRx: 0.585,
    eyeRy: 0.98,
  },
  muffin: {
    keyboardBase: 'rgb(48 61 97)',
    keyboardKey: 'rgb(125 153 213)',
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
  keyboardBase: string;
  keyboardKey: string;
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
  const [soundResetPending, setSoundResetPending] = useState(false);
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

  if (!supported) {
    return (
      <div className="flex flex-col gap-[14px]">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.agentIsland.title')}
        </h2>
        <SettingsCard>
          <p className="text-13 leading-[1.45] text-[var(--settings-section-sublabel)] opacity-75">
            {t('settings.agentIsland.unsupported')}
          </p>
        </SettingsCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.agentIsland.title')}
      </h2>

      <SettingsCard className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
            {t('settings.agentIsland.enableLabel')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.agentIsland.enableHint')}
          </p>
        </div>

        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('settings.agentIsland.enableAria')}
        />
      </SettingsCard>

      {enabled && (
        <>
          <SettingsCard className="flex flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.agentIsland.displayLabel')}
              </p>
              <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.agentIsland.displayHint')}
              </p>
            </div>
            <div className="relative min-w-0">
              <select
                value={displayTargetToOptionValue(displayTarget)}
                onChange={(event) => setDisplayTarget(displayTargetFromOptionValue(event.target.value))}
                className={cn(
                  'h-9 w-full min-w-0 appearance-none rounded-full border py-0 pl-3 pr-9 text-12 outline-none',
                  'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                  'border-[var(--settings-input-border)] focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
                )}
                aria-label={t('settings.agentIsland.displaySelectAria')}
              >
                <option value={DISPLAY_ALL_OPTION_VALUE}>
                  {t('settings.agentIsland.displayAll')}
                </option>
                {displayOptions.map((option) => (
                  <option
                    key={option.id}
                    value={displayTargetToOptionValue({ mode: 'display', displayId: option.id })}
                  >
                    {displayOptionLabels.get(option.id)}
                  </option>
                ))}
                {selectedDisplayMissing && (
                  <option value={displayTargetToOptionValue(displayTarget)}>
                    {t('settings.agentIsland.displayMissing', { id: displayTarget.displayId })}
                  </option>
                )}
              </select>
              <ChevronDown
                size={15}
                className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--settings-input-text)] opacity-75"
                aria-hidden="true"
              />
            </div>
          </SettingsCard>

          <SettingsCard className="flex flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.agentIsland.skinLabel')}
              </p>
              <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.agentIsland.skinHint')}
              </p>
            </div>

            <div className="grid gap-2">
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
            </div>
          </SettingsCard>

          <SettingsCard className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                  {t('settings.agentIsland.soundLabel')}
                </p>
                <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                  {t('settings.agentIsland.soundHint')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <DefaultOverrideControls
                  isCustomized={soundCustomized}
                  disabled={soundResetPending}
                  onReset={() => void handleResetSoundSettings()}
                />
                <Switch
                  checked={soundSettings.enabled}
                  disabled={soundResetPending}
                  onCheckedChange={setSoundEnabled}
                  aria-label={t('settings.agentIsland.soundAria')}
                />
              </div>
            </div>

            {soundSettings.enabled && (
              <div className="grid gap-2 border-t border-[var(--settings-theme-card-border)] pt-4">
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
              </div>
            )}
          </SettingsCard>
        </>
      )}
    </div>
  );
}

function SettingsCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
        className,
      )}
    >
      {children}
    </div>
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
      <button
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
        <p className="mt-1 line-clamp-2 text-12 leading-[1.35] text-[var(--settings-section-sublabel)] opacity-65">
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
 * Sprite 皮肤预览:键盘与眼睛全部用绝对定位 HTML 元素表达(原为内联 SVG),
 * 让 keyboard-tap / key-flash / eye-focus 常驻动画挂在 HTML 上(规则 7)。
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
        className="agent-island-mascot-keyboard pointer-events-none absolute inset-0"
        aria-hidden="true"
      >
        <span
          className="absolute block rounded-[50%] bg-black"
          style={{
            ...mascotViewBoxStyle(8 - 4.2, 14.3 - 0.48, 4.2 * 2, 0.48 * 2),
            opacity: 0.28,
          }}
        />
        <span
          className="absolute block"
          style={{
            ...mascotViewBoxStyle(0.5, 13, 15, 3),
            backgroundColor: config.keyboardBase,
          }}
        />
        {MASCOT_KEY_RECTS.map((index) => {
          const row = Math.floor(index / 6);
          const col = index % 6;
          return (
            <span
              key={index}
              className="agent-island-mascot-key absolute block"
              style={{
                ...mascotViewBoxStyle(1 + col * 2.4, 13.5 + row * 1.2, 1.8, 0.7),
                '--agent-island-key-delay': `${index * 38}ms`,
                backgroundColor: index === 2 ? 'white' : config.keyboardKey,
                borderRadius: MASCOT_KEY_BORDER_RADIUS,
                opacity: index === 2 ? 0.9 : 1,
              } as CSSProperties}
            />
          );
        })}
      </div>
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
        className="truncate text-12 text-[var(--settings-section-sublabel)] opacity-80"
        htmlFor={`agent-island-sound-${event}`}
      >
        {t(`settings.agentIsland.soundEvents.${event}`)}
      </label>
      <div className="relative min-w-0">
        <select
          id={`agent-island-sound-${event}`}
          value={selectValue}
          onChange={async (e) => {
            const next = e.target.value;
            if (next === CUSTOM_SOUND_OPTION_VALUE) {
              const customSound = await onSelectCustom();
              if (customSound) onChange(customSound);
              return;
            }
            onChange({ type: 'builtin', id: next as AgentIslandSoundId });
          }}
          className={cn(
            'h-8 w-full min-w-0 appearance-none rounded-full border py-0 pl-3 pr-8 text-12 outline-none',
            'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
            'border-[var(--settings-input-border)] focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
          )}
          aria-label={t('settings.agentIsland.soundSelectAria', {
            event: t(`settings.agentIsland.soundEvents.${event}`),
          })}
        >
          {AGENT_ISLAND_SOUND_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {t(`settings.agentIsland.soundOptions.${option}`)}
            </option>
          ))}
          <option value={CUSTOM_SOUND_OPTION_VALUE}>
            {value.type === 'custom'
              ? t('settings.agentIsland.soundOptions.customSelected', { name: value.name })
              : t('settings.agentIsland.soundOptions.custom')}
          </option>
        </select>
        <ChevronDown
          size={14}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--settings-input-text)] opacity-75"
          aria-hidden="true"
        />
      </div>
      <button
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
        <Volume2 size={14} />
      </button>
    </div>
  );
}
