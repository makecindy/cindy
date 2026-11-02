import { useCallback, useContext, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useRecyclingState } from '@legendapp/list/react-native';
import { Text } from '@/components/AppText';
import { canOpenChatPathChip, resolveChatAbsPath, toWorkdirRel, type ChatPathCandidate } from '@/session/chatPathCandidate';
import { ChatFilePathContext, type ChatFilePathTarget } from '@/session/chatFilePathContext';
import { peekRemotePathVerdict, peekRemotePathVerdictForRender, remotePathVerdictKey, subscribeRemotePathVerdictChange, verifyRemotePathCached, type RemotePathVerdict } from '@/session/remotePathVerdict';

type PathStateHook = <T>(initial: T | (() => T)) => readonly [T, Dispatch<SetStateAction<T>>];

/**
 * 文件/目录路径 chip 的共享执行体(远程会话文件交互,对齐桌面 #631 的 chip 点亮
 * 语义)。inline code 与本地路径链接两种形态共用:候选先经被控端精确 stat 验证——
 * 文件/目录点亮可点(文件 → Quick Look 预览页;目录 → 文件浏览器定位)。
 * 自动识别的不存在路径保持纯文本；作者显式写出的链接保留点击与长按菜单，
 * 文件读取和失败反馈交给原有预览页。链路断等无法判定时按形状决定自动引用的点亮。
 * workdir 外的绝对路径同样候选(对齐桌面):文件走被控端 absPath 取件通道预览,
 * 目录因文件浏览器只认 workdir 内而保持纯文本(canOpenChatPathChip)。
 * 无会话上下文(context null) → plainStyle 纯文本渲染；流式中不发起预检。
 */
export function ChatPathChipSpan({
  candidate,
  chipStyle,
  display,
  plainStyle,
  SpanText,
  streaming,
  explicitLink = false,
  usePathState = useRecyclingState,
}: {
  candidate: ChatPathCandidate | null;
  chipStyle: StyleProp<TextStyle>;
  /** span 显示文本(code 形态 = 原文;链接形态 = 链接 label)。 */
  display: string;
  plainStyle: StyleProp<TextStyle>;
  SpanText: typeof Text;
  streaming?: boolean;
  /** Authored Markdown links retain an open action even when the file is missing. */
  explicitLink?: boolean;
  /** Composer cards live outside LegendList, whose state setters require a list item. */
  usePathState?: PathStateHook;
}) {
  const ctx = useContext(ChatFilePathContext);
  // workdir 外候选不再一票否决:relPath 为 null 表示 workdir 外,文件仍可经
  // absPath 通道打开,可开性由 canOpenChatPathChip 在 verdict 定 kind 后裁决。
  const target = useMemo(() => {
    if (!ctx || !candidate) return null;
    const absPath = resolveChatAbsPath(candidate.href, ctx.workdir);
    return { absPath, relPath: toWorkdirRel(ctx.workdir, absPath) };
  }, [candidate, ctx]);
  const actionScope = useRef<{ ctx: typeof ctx; target: typeof target } | null>(null);
  useEffect(() => {
    actionScope.current = { ctx, target };
    return () => { actionScope.current = null; };
  }, [ctx, target]);
  // verdict 是**缓存的纯派生**,chip 不自己存结论:ForRender 版会把 TTL 未过期的负缓存
  // 回成 'unknown',于是断链期间的乐观点亮也来自缓存。自存一份的话收不到缓存变化 ——
  // 同一路径出现在多个 chip 上时,A 按 unknown 点亮、B 拿到确定的 nonfile,A 会一直
  // 带着下划线可点(PR #1144 review 实捉,桌面同款)。
  const readVerdict = useCallback(
    () =>
      ctx && target
        ? peekRemotePathVerdictForRender(ctx.deviceId, ctx.workdir, target.absPath)
        : undefined,
    [ctx, target],
  );
  const [verdict, setVerdict] = usePathState<RemotePathVerdict | undefined>(readVerdict);

  // 本 key 的缓存变化(确定态落库 / 负缓存到期)→ 递增,**驱动下面的验证副作用重跑**。
  // 按 key 过滤:一屏几十个 chip 各自订阅,全量广播会让首屏 N 次 stat 引发 N×N 次重渲染。
  //
  // ⚠️ 这里必须递增一个计数、不能只 setVerdict(readVerdict()):`readVerdict` 是
  // `[ctx, target]` 的稳定 useCallback,通知**不改变验证副作用的任何依赖**,那个副作用
  // 就不会重跑 → 再也不发 verifyRemotePathCached。TTL 到期时负缓存已被删、又没有确定态,
  // ForRender 回 undefined,于是 chip 只完成「降级成纯文本」、没完成「重验」,挂载期间
  // 永不自愈 —— 比重构前(一直乐观点亮)更糟。桌面同一处把 cacheGen 放进了验证副作用的
  // 依赖,手机漏了这一环(PR #1144 review 实捉:第 10 轮重构只做对了桌面那一半)。
  const [cacheGen, setCacheGen] = usePathState(0);
  useEffect(() => {
    if (!ctx || !target) return;
    const mine = remotePathVerdictKey(ctx.deviceId, ctx.workdir, target.absPath);
    return subscribeRemotePathVerdictChange((key) => {
      if (key === mine) setCacheGen((n) => n + 1);
    });
  }, [ctx, target]);

  useEffect(() => {
    // 无条件按当前缓存重新派生(升级 / 降级同一条路)。
    setVerdict(readVerdict());
    if (!ctx || !target) return;
    // 有确定结论就不必重验;unknown 的限流由 verifyRemotePathCached 的负缓存承担。
    if (peekRemotePathVerdict(ctx.deviceId, ctx.workdir, target.absPath)) return;
    // 流式中不发验证:半截路径会产生大量无意义 stat(与桌面 isStreaming gate 同理)。
    if (streaming) return;
    let cancelled = false;
    void verifyRemotePathCached(ctx.deviceId, ctx.workdir, target.absPath, ctx.statPath).then(() => {
      // 不看返回值:结论已落缓存,统一重新派生。
      if (!cancelled) setVerdict(readVerdict());
    });
    return () => {
      cancelled = true;
    };
    // cacheGen:本 key 的缓存状态变化(TTL 到期 / 别处写入确定态)→ 重新派生 + 必要时重验。
  }, [ctx, streaming, target, readVerdict, cacheGen]);

  // 点亮门槛分两档(见 ChatPathCandidate.ambiguousShape 的说明):
  //   - 形状明确是路径(绝对路径 / 尾斜杠目录 / 分隔符+扩展名):unknown(链路断 /
  //     stat 异常)照旧乐观点亮,绝不因断链把整条消息的 chip 全灭掉;
  //   - 歧义形状(裸名 `array.map`、分隔符无扩展 `and/or`——与 `package.json`、
  //     `src/components` 词法同形,分不开):必须等远端明确回 file / directory 才点亮。
  //     否则链路一抖,满屏普通行内 code 都变成可点的假链接——「可点」的视觉信号一旦
  //     不可信,加强它只会让误判更醒目(DESIGN.md §14.5 规则 5)。
  const verdictAllowsLit = candidate?.ambiguousShape
    ? verdict === 'file' || verdict === 'directory'
    : verdict !== undefined && verdict !== 'nonfile';
  const lit = !!ctx && !!candidate && !!target && (explicitLink || verdictAllowsLit);
  if (!lit) {
    return <SpanText style={plainStyle}>{display}</SpanText>;
  }
  const kind: 'file' | 'directory' =
    verdict === 'directory' || (verdict !== 'file' && candidate.directoryShape) ? 'directory' : 'file';
  if (!canOpenChatPathChip(kind, target.relPath)) {
    return <SpanText style={plainStyle}>{display}</SpanText>;
  }
  const activate = async (action: (value: ChatFilePathTarget) => void) => {
    let actionKind = kind;
    if (explicitLink) {
      // A visible authored link may be tapped before background verification,
      // or after a cached miss. Resolve the kind before opening or building its
      // menu; a directory without a trailing slash must not enter file preview.
      try {
        const stat = await ctx.statPath(target.absPath);
        if (stat.kind === 'dir') actionKind = 'directory';
        else if (stat.kind === 'file') actionKind = 'file';
      } catch {
        // Preserve the existing preview/browser failure UX and copy menu when
        // the host is unavailable; no local lookup or connection reset.
      }
      if (actionScope.current?.ctx !== ctx || actionScope.current.target?.absPath !== target.absPath) return;
    }
    if (!canOpenChatPathChip(actionKind, target.relPath)) return;
    action({
      kind: actionKind,
      relPath: target.relPath,
      absPath: target.absPath,
      ...(actionKind === 'file' && candidate.line !== undefined ? { line: candidate.line } : {}),
    });
  };
  return (
    <SpanText
      onLongPress={ctx.onLongPressPath ? () => { void activate(ctx.onLongPressPath!); } : undefined}
      onPress={() => { void activate(ctx.onOpenPath); }}
      style={chipStyle}
      testID="message.markdownPathChip"
    >
      {display}
    </SpanText>
  );
}
