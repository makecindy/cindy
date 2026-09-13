import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { i18n } from '@/i18n';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { fontWeight, iconSize, lineHeight, radius, typeScale } from '@/theme/tokens';

type Worker = { id?: string; label?: string; role?: string; status?: string; sessionId?: string };

function workersFrom(value: unknown): Worker[] {
  if (Array.isArray(value)) return value.filter((v): v is Worker => !!v && typeof v === 'object');
  if (value && typeof value === 'object' && Array.isArray((value as { workers?: unknown }).workers)) {
    return workersFrom((value as { workers: unknown }).workers);
  }
  return [];
}

export function OrcaWorkerStatusCard({ leadSessionId, maker }: { leadSessionId: string; maker: MobileMakerTransport }) {
  const { colors } = useTheme();
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = workersFrom(await maker.listOrcaWorkersByLead(leadSessionId));
      if (request === requestRef.current) setWorkers(next);
    } catch {
      if (workers === null && request === requestRef.current) setWorkers([]);
    }
  }, [leadSessionId, maker, workers]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [load]);
  if (workers === null) return <View style={[styles.card, { backgroundColor: colors.surface }]}><ActivityIndicator /></View>;
  if (!workers.length) return null;
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.textPrimary }]}>Workers ({workers.length})</Text>
    {workers.map((worker, index) => <View key={worker.id ?? worker.sessionId ?? index} style={styles.row}>
      <View style={[styles.dot, { backgroundColor: worker.status === 'error' ? colors.statusError : worker.status === 'done' ? colors.statusDone : colors.statusAccent }]} />
      <Text numberOfLines={1} style={[styles.name, { color: colors.textPrimary }]}>{worker.label ?? worker.role ?? `Worker ${index + 1}`}</Text>
      <Text style={[styles.status, { color: colors.textSecondary }]}>{i18n.t(`session.presentation.collaboration.workerStatus.${worker.status ?? 'unknown'}`)}</Text>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({ card: { marginHorizontal: 12, marginBottom: 8, padding: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container }, title: { fontSize: typeScale.body, fontWeight: fontWeight.semibold, marginBottom: 6 }, row: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: lineHeight.listBody }, dot: { width: iconSize.sm, height: iconSize.sm, borderRadius: radius.micro }, name: { flex: 1, fontSize: typeScale.body }, status: { fontSize: typeScale.caption, textTransform: 'capitalize' } });
