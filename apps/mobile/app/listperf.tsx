/**
 * DEV-only 列表性能 harness(临时,profiling 结束后删)。
 * 直接用合成数据渲染真正的 MessageRenderer,隔离列表渲染性能,绕开 auth / device-link / 网络。
 * 顶层路由(不在 (auth) 组)→ 已登录用户可直接访问,auth 守卫不拦。
 *
 * 用法(deeplink):
 *   lizcn://listperf?turns=300&media=1&auto=1&vel=45&recycle=1
 *   - turns: 轮数(每轮 1 user + 1 assistant),默认 300
 *   - media: 1=含 mermaid/math(WebView),0=纯文本(隔离 WebView 成本),默认 1
 *   - auto:  1=进入后自动做一次「底→顶」匀速滚动扫描并测帧,默认 0
 *   - vel:   滚动速度 px/帧(模拟 fling),默认 45
 *   - recycle: 0=关闭 cell 回收做 A/B,默认 1
 */
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { buildListPerfRenderItems } from '@/debug/listPerfFixture';
import { runScrollSweep, type FrameStats } from '@/debug/scrollProfiler';
import { MessageRenderer } from '@/session/MessageRenderer';
import type { MobileMessageWebViewMetrics } from '@/session/mobileMessageWebViewMetrics';
import {
  resetMobileMarkdownRenderMetrics,
  type MobileMarkdownRenderMetrics,
} from '@/session/mobileMarkdownRenderMetrics';

type ListApi = {
  scrollTo: (y: number) => void;
  getMetrics: () => { contentHeight: number; offsetY: number; viewportHeight: number };
  getWebViewMetrics: () => MobileMessageWebViewMetrics;
  getMarkdownMetrics: () => MobileMarkdownRenderMetrics;
};

export default function ListPerfHarness() {
  const params = useLocalSearchParams<{ turns?: string; media?: string; auto?: string; vel?: string; recycle?: string; run?: string }>();
  const turns = Math.max(1, Math.min(2000, Number(params.turns) || 300));
  const media = params.media !== '0';
  const auto = params.auto === '1';
  const recycle = params.recycle !== '0';
  const pxPerFrame = Math.max(5, Math.min(200, Number(params.vel) || 45));

  const items = useMemo(() => buildListPerfRenderItems(turns, { media }), [turns, media]);
  const runKey = `${turns}|${media ? 1 : 0}|${pxPerFrame}|${recycle ? 1 : 0}|${params.run ?? '0'}`;
  const apiRef = useRef<ListApi | null>(null);
  const startedKeyRef = useRef<string | null>(null);
  const [stats, setStats] = useState<FrameStats | null>(null);
  const [webViewMetrics, setWebViewMetrics] = useState<MobileMessageWebViewMetrics | null>(null);
  const [markdownMetrics, setMarkdownMetrics] = useState<MobileMarkdownRenderMetrics | null>(null);
  const [phase, setPhase] = useState<string>(auto ? 'waiting…' : 'manual');

  const devExposeList = useCallback((api: ListApi) => {
    apiRef.current = api;
  }, []);

  useEffect(() => {
    if (!auto || startedKeyRef.current === runKey) return undefined;
    let cancelled = false;
    setStats(null);
    setWebViewMetrics(null);
    setMarkdownMetrics(null);
    // Counters are process-global so repeated A/B deeplinks must start from a
    // clean window; otherwise B includes all parses performed by A.
    resetMobileMarkdownRenderMetrics();
    // 轮询等列表布局稳定(contentHeight 被 onContentSizeChange/onScroll 填好),再开扫。
    const waitAndRun = (attempt: number) => {
      if (cancelled) return;
      const api = apiRef.current;
      const m = api?.getMetrics();
      const ready = !!m && m.contentHeight > m.viewportHeight * 2 && m.viewportHeight > 0;
      if (!ready) {
        if (attempt > 40) { setPhase('list never settled'); return; }
        setTimeout(() => waitAndRun(attempt + 1), 200);
        return;
      }
      startedKeyRef.current = runKey;
      // 从顶向下匀速扫:持续挂载「尚未渲染」的 cell(变高虚拟化下 contentHeight 会低估,
      // 不能靠它算底部;从顶向下 +vel 推进 maxFrames 帧,保证测的是冷挂载稳态)。
      setPhase(`sweeping top→down @${pxPerFrame}px/f`);
      api!.scrollTo(0);
      setTimeout(() => {
        runScrollSweep({
          label: `list=Legend turns=${turns} media=${media ? 1 : 0} recycle=${recycle ? 1 : 0} vel=${pxPerFrame}`,
          fromY: 0,
          toY: 1_000_000,
          pxPerFrame,
          maxFrames: 150,
          scrollTo: (y) => apiRef.current?.scrollTo(y),
          onDone: (s) => {
            if (cancelled) return;
            setStats(s);
            const currentWebViewMetrics = apiRef.current?.getWebViewMetrics();
            if (currentWebViewMetrics) setWebViewMetrics(currentWebViewMetrics);
            const currentMarkdownMetrics = apiRef.current?.getMarkdownMetrics();
            if (currentMarkdownMetrics) setMarkdownMetrics(currentMarkdownMetrics);
            setPhase('done');
            // 打到 Metro 日志,便于抓取。
            // eslint-disable-next-line no-console
            console.log(`[PERF] ${s.label} | frames=${s.frames} dur=${s.durationMs}ms fps=${s.fps} avg=${s.avgMs} p50=${s.p50} p95=${s.p95} p99=${s.p99} max=${s.maxMs} jank>32ms=${s.jank32} jank>50ms=${s.jank50}`);
          },
        });
      }, 400);
    };
    waitAndRun(0);
    return () => { cancelled = true; };
  }, [auto, pxPerFrame, media, turns, runKey]);

  if (!__DEV__) {
    return (
      <SafeAreaView style={styles.fill}>
        <Text style={styles.notice}>List perf harness is DEV-only.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.fill} edges={['top']}>
      <View style={styles.bar}>
        <Text style={styles.barText}>
          PERF · LegendList · turns={turns} · items={items.length} · media={media ? 1 : 0} · recycle={recycle ? 1 : 0} · {phase}
        </Text>
        {stats ? (
          <Text style={styles.statText}>
            fps={stats.fps} avg={stats.avgMs}ms p50={stats.p50} p95={stats.p95} p99={stats.p99} max={stats.maxMs} | jank&gt;32={stats.jank32}/{stats.frames} &gt;50={stats.jank50}
          </Text>
        ) : null}
        {webViewMetrics ? (
          <Text style={styles.statText}>
            webview mounted={webViewMetrics.mounted} mermaid={webViewMetrics.mountedByKind.mermaid} math={webViewMetrics.mountedByKind.math} media={webViewMetrics.mountedByKind.media} composer={webViewMetrics.mountedByKind.composer}
          </Text>
        ) : null}
        {markdownMetrics ? (
          <Text style={styles.statText}>
            markdown full={markdownMetrics.fullParseCount} incremental={markdownMetrics.incrementalParseCount} reusedBlocks={markdownMetrics.reusedBlockCount} parsedUtf16={markdownMetrics.parsedSourceUtf16Length} parseMs={markdownMetrics.parseDurationMsTotal.toFixed(1)} maxMs={markdownMetrics.parseDurationMsMax.toFixed(1)} renderItems={markdownMetrics.renderItemRebuildCount}
          </Text>
        ) : null}
      </View>
      <View style={styles.fill}>
        <MessageRenderer
          items={items}
          devRecycleItems={recycle}
          testID="perf.list"
          devExposeList={devExposeList}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#1e293b' },
  barText: { color: '#e2e8f0', fontSize: 11, fontVariant: ['tabular-nums'] },
  statText: { color: '#fbbf24', fontSize: 12, marginTop: 3, fontVariant: ['tabular-nums'] },
  notice: { padding: 24, fontSize: 16 },
});
