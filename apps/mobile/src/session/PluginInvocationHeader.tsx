import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, View } from 'react-native';
import { useRecyclingState } from '@legendapp/list/react-native';
import { Check, ChevronDown, ChevronUp, Ghost } from 'lucide-react-native';
import Svg, { Circle } from 'react-native-svg';
import { Text } from '@/components/AppText';
import { useTranslation } from 'react-i18next';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { iconSize, iconStroke, radius, lineHeight, spacing, typeScale, useTheme } from '@/theme';
import { useSessionPluginResource } from './usePluginResultCard';
import type { PluginInvocation } from './pluginInvocations';

// Registered summon-seal cycle: DESIGN §14.4, identical to Desktop.
const SUMMON_CYCLE_MS = 2400;

export function PluginInvocationHeader({ plugins, running, deviceId, sessionId }: {
  plugins: readonly PluginInvocation[]; running: boolean; deviceId?: string; sessionId: string;
}) {
  return <View>{plugins.map((plugin) => <PluginInvocationRow key={plugin.id} plugin={plugin} running={running && plugin.hasPendingCalls} deviceId={deviceId} sessionId={sessionId} />)}</View>;
}

function PluginInvocationRow({ plugin, running, deviceId, sessionId }: {
  plugin: PluginInvocation; running: boolean; deviceId?: string; sessionId: string;
}) {
  const identity = useSessionPluginResource(deviceId, sessionId, plugin.id, 'plugin-identities', 'plugin');
  const name = identity.title || plugin.name;
  const icon = (identity.blocks?.find((block) => block.id === 'icon')?.data as { url?: unknown } | undefined)?.url;
  const iconUrl = typeof icon === 'string' && icon.length <= 256_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon) ? icon : undefined;
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useRecyclingState(false);
  const reduced = useReduceMotionEnabled();
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!running || reduced !== false) { rotation.setValue(0); return; }
    const animation = Animated.loop(Animated.timing(rotation, {
      toValue: 1, duration: SUMMON_CYCLE_MS, easing: Easing.linear,
      useNativeDriver: true, isInteraction: false,
    }));
    animation.start();
    return () => { animation.stop(); rotation.setValue(0); };
  }, [running, reduced, rotation]);
  const state = t(running ? 'message.pluginInvocation.status.running' : 'message.pluginInvocation.status.called');
  return <View style={[styles.container, { borderBottomColor: colors.border }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={`${name} · ${state}`}
      onPress={() => setExpanded(!expanded)} style={styles.header}>
      <View style={styles.seal}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, {
          transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
        }]}>
          <Svg width={28} height={28} viewBox="0 0 28 28">
            <Circle cx={14} cy={14} r={13} fill="none" stroke={colors.textTertiary} strokeWidth={iconStroke.thin}
              strokeDasharray={running ? '68 14' : undefined} />
            <Circle cx={14} cy={14} r={10.5} fill="none" stroke={colors.textTertiary} strokeWidth={iconStroke.thin}
              strokeDasharray={running ? '26 40' : undefined} />
          </Svg>
        </Animated.View>
        <View>{iconUrl ? <Image source={{ uri: iconUrl }} style={{ width: 18, height: 18, borderRadius: radius.pill }} /> : <Ghost size={iconSize.sm} color={colors.textSecondary} />}</View>
        {!running && <View style={[styles.check, { backgroundColor: colors.statusDone }]}>
          <Check size={iconSize.xs} color={colors.surface} strokeWidth={iconStroke.regular} />
        </View>}
      </View>
      <Text style={[styles.name, { color: colors.textSecondary }]}>{name}</Text>
      <Text style={[styles.status, { color: colors.textTertiary }]}>{state}</Text>
      {expanded ? <ChevronUp size={iconSize.sm} color={colors.textTertiary} /> : <ChevronDown size={iconSize.sm} color={colors.textTertiary} />}
    </Pressable>
    {expanded && <View style={styles.details}>
      <Text selectable
        style={[styles.detail, { color: colors.textSecondary }]}>
        {`${name}\n${plugin.tools.join(' · ')}`}
      </Text>
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  container: { borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: spacing.sm, paddingBottom: spacing.xs },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  seal: { width: 28, height: 28, justifyContent: 'center', alignItems: 'center' },
  check: { position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  name: { flexShrink: 1, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  status: { fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  details: { gap: spacing.sm, paddingVertical: spacing.sm },
  detail: { fontSize: typeScale.caption, lineHeight: lineHeight.caption },
});
