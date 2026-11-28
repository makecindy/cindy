import fs from 'node:fs';
import path from 'node:path';
import { performance as realPerf } from 'node:perf_hooks';

export const DEFAULT_ASR_HINTS_CASES = [
  {
    id: 'zh-litellm-feishu',
    voice: 'Tingting (中文（中国大陆）)',
    spokenText: '我们今天测一下飞书多维表格和 LiteLLM 的语音输入效果。',
    targetTerms: ['飞书多维表格', 'LiteLLM'],
    dictionaryEntries: [
      { text: '飞书多维表格', source: 'manual', frequency: 12 },
      { text: 'LiteLLM', source: 'manual', frequency: 20 },
      { text: 'Cindy', source: 'manual', frequency: 30 },
    ],
    recentHistory: ['昨天把 LiteLLM 网关切换到了新的路由配置。'],
    language: 'zh',
  },
  {
    id: 'zh-sherpa-prosemirror',
    voice: 'Tingting (中文（中国大陆）)',
    spokenText: '请检查一下 Sherpa ONNX 声纹模型和 ProseMirror 编辑器的撤销事务。',
    targetTerms: ['Sherpa', 'ONNX', 'ProseMirror'],
    dictionaryEntries: [
      { text: 'Sherpa ONNX', source: 'manual', frequency: 10 },
      { text: 'ProseMirror', source: 'manual', frequency: 14 },
      { text: 'TipTap', source: 'manual', frequency: 8 },
    ],
    recentHistory: ['编辑器润色撤销需要在 ProseMirror 拆成两个事务。'],
    language: 'zh',
  },
  {
    id: 'zh-antigravity-worktree',
    voice: 'Eddy (中文（中国大陆）)',
    spokenText: '把 Antigravity 的这个分支切到 Cindy 托管的 worktree 里去跑回归。',
    targetTerms: ['Antigravity', 'Cindy', 'worktree'],
    dictionaryEntries: [
      { text: 'Antigravity', source: 'manual', frequency: 18 },
      { text: 'Cindy', source: 'manual', frequency: 25 },
      { text: 'worktree', source: 'manual', frequency: 15 },
    ],
    recentHistory: ['派任务时要让 Cindy 建托管 worktree，不要手工 git worktree add。'],
    language: 'zh',
  },
  {
    id: 'zh-volcengine-sauc',
    voice: 'Tingting (中文（中国大陆）)',
    spokenText: '火山引擎的 Seed ASR 二点零支持通过 corpus context 传入热词列表。',
    targetTerms: ['Seed ASR', 'corpus context'],
    dictionaryEntries: [
      { text: 'Seed ASR', source: 'manual', frequency: 16 },
      { text: 'corpus context', source: 'manual', frequency: 9 },
      { text: 'Volcengine SAUC', source: 'manual', frequency: 11 },
    ],
    recentHistory: ['我们在排查 Volcengine SAUC 首包建连参数。'],
    language: 'zh',
  },
  {
    id: 'zh-openclaw-tiptap',
    voice: 'Eddy (中文（中国大陆）)',
    spokenText: 'OpenClaw 和 Claude Code 在 TipTap 聊天框里共享同一套语音润色逻辑。',
    targetTerms: ['OpenClaw', 'Claude Code', 'TipTap'],
    dictionaryEntries: [
      { text: 'OpenClaw', source: 'manual', frequency: 12 },
      { text: 'Claude Code', source: 'manual', frequency: 22 },
      { text: 'TipTap', source: 'manual', frequency: 14 },
    ],
    recentHistory: ['今天重点看 OpenClaw 和 Claude Code 的接入。'],
    language: 'zh',
  },
  {
    id: 'zh-xindong-bitable',
    voice: 'Tingting (中文（中国大陆）)',
    spokenText: '心动网络内部用飞书 Bitable 追踪 Kubernetes 和 PostgreSQL 的灰度发布。',
    targetTerms: ['心动网络', 'Bitable', 'Kubernetes', 'PostgreSQL'],
    dictionaryEntries: [
      { text: '心动网络', source: 'manual', frequency: 20 },
      { text: 'Bitable', source: 'manual', frequency: 11 },
      { text: 'Kubernetes', source: 'manual', frequency: 15 },
      { text: 'PostgreSQL', source: 'manual', frequency: 15 },
    ],
    recentHistory: ['灰度状态已经同步到飞书 Bitable。'],
    language: 'zh',
  },
  {
    id: 'zh-codex-fastapi',
    voice: 'Eddy (中文（中国大陆）)',
    spokenText: '让 Codex 帮忙把 FastAPI 服务的 WebSocket 鉴权改成单步握手。',
    targetTerms: ['Codex', 'FastAPI', 'WebSocket'],
    dictionaryEntries: [
      { text: 'Codex', source: 'manual', frequency: 24 },
      { text: 'FastAPI', source: 'manual', frequency: 13 },
      { text: 'WebSocket', source: 'manual', frequency: 18 },
    ],
    recentHistory: ['单步 WebSocket 握手可以省去一次 REST RTT。'],
    language: 'zh',
  },
  {
    id: 'zh-tailscale-cindy',
    voice: 'Tingting (中文（中国大陆）)',
    spokenText: '通过 Tailscale 连上测试机之后，用 pnpm 跑一遍 vitest 单元测试。',
    targetTerms: ['Tailscale', 'pnpm', 'vitest'],
    dictionaryEntries: [
      { text: 'Tailscale', source: 'manual', frequency: 14 },
      { text: 'pnpm', source: 'manual', frequency: 25 },
      { text: 'vitest', source: 'manual', frequency: 17 },
    ],
    recentHistory: ['所有 CI 前都要用 pnpm 跑 vitest 回归。'],
    language: 'zh',
  },
  {
    id: 'zh-elevenlabs-qwen',
    voice: 'Eddy (中文（中国大陆）)',
    spokenText: 'ElevenLabs 的 Scribe 和 Qwen ASR 在长语音场景下表现差异很大。',
    targetTerms: ['ElevenLabs', 'Scribe', 'Qwen'],
    dictionaryEntries: [
      { text: 'ElevenLabs', source: 'manual', frequency: 10 },
      { text: 'Scribe', source: 'manual', frequency: 9 },
      { text: 'Qwen ASR', source: 'manual', frequency: 16 },
    ],
    recentHistory: ['正在对比 ElevenLabs Scribe 和 Qwen ASR 的识别准确率。'],
    language: 'zh',
  },
  {
    id: 'zh-myers-diff',
    voice: 'Tingting (中文（中国大陆）)',
    spokenText: '词典学习改用 Myers diff 之后，首尾同时改两个术语不会被拦截。',
    targetTerms: ['Myers diff'],
    dictionaryEntries: [
      { text: 'Myers diff', source: 'manual', frequency: 8 },
      { text: 'DictationDictionaryAdvisor', source: 'manual', frequency: 7 },
    ],
    recentHistory: ['DictationDictionaryAdvisor 的 large_rewrite 门禁之前是单跨度。'],
    language: 'zh',
  },
];

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return Number(sorted[idx].toFixed(4));
}

export function normalizeTextForCer(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’()（）[\]【】\-_/]/g, '');
}

export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function computeCer(reference, hypothesis) {
  const ref = normalizeTextForCer(reference);
  const hyp = normalizeTextForCer(hypothesis);
  if (!ref) return 0;
  return Number((editDistance(ref, hyp) / ref.length).toFixed(4));
}

export function evaluateTermHits(transcript, targetTerms) {
  const compactTranscript = String(transcript ?? '').toLowerCase().replace(/[\s\-_.]/g, '');
  const matched = [];
  const missed = [];
  for (const term of targetTerms ?? []) {
    const compactTerm = String(term).toLowerCase().replace(/[\s\-_.]/g, '');
    if (compactTerm && compactTranscript.includes(compactTerm)) matched.push(term);
    else missed.push(term);
  }
  return {
    hits: matched.length,
    total: (targetTerms ?? []).length,
    matched,
    missed,
  };
}

export function normalizeAsrHints(input) {
  if (!input) return undefined;
  const rawHotwords = Array.isArray(input.hotwords)
    ? input.hotwords
    : Array.isArray(input.dictionaryEntries)
      ? input.dictionaryEntries.map((entry) => (typeof entry === 'string' ? entry : entry?.text))
      : [];
  const hotwords = [];
  const seenHotwords = new Set();
  for (const raw of rawHotwords) {
    const cleaned = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length > 50) continue;
    const key = cleaned.toLowerCase();
    if (seenHotwords.has(key)) continue;
    seenHotwords.add(key);
    hotwords.push(cleaned);
    if (hotwords.length >= 50) break;
  }

  const rawContext = Array.isArray(input.recentContext)
    ? input.recentContext
    : Array.isArray(input.recentHistory)
      ? input.recentHistory
      : [];
  const recentContext = [];
  const seenContext = new Set();
  for (const raw of rawContext) {
    const cleaned = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seenContext.has(key)) continue;
    seenContext.add(key);
    recentContext.push(cleaned.slice(0, 120));
    if (recentContext.length >= 4) break;
  }

  if (hotwords.length === 0 && recentContext.length === 0) return undefined;
  return { hotwords, recentContext };
}

export function buildVolcengineCorpusContextFromHints(hintsInput) {
  const hints = normalizeAsrHints(hintsInput);
  if (!hints) return undefined;
  const hotwords = hints.hotwords.slice(0, 50).map((word) => ({ word }));
  const contextData = hints.recentContext.slice(0, 4).map((text) => ({ text }));
  if (hotwords.length === 0 && contextData.length === 0) return undefined;
  return JSON.stringify({
    ...(hotwords.length > 0 ? { hotwords } : {}),
    ...(contextData.length > 0 ? { context_type: 'dialog_ctx', context_data: contextData } : {}),
  });
}

export function buildQwenCorpusTextFromHints(hintsInput) {
  const hints = normalizeAsrHints(hintsInput);
  if (!hints) return undefined;
  const parts = [];
  if (hints.hotwords.length > 0) parts.push(hints.hotwords.join(', '));
  if (hints.recentContext.length > 0) parts.push(hints.recentContext.join(' '));
  const text = parts.join('\n').trim();
  return text ? text.slice(0, 800).trim() : undefined;
}

/**
 * Formats compact OpenAI transcription prompt hints. Defaults to hotwords-only
 * so full historical sentences do not trigger prompt-echo hallucinations on
 * unclear audio.
 */
export function buildOpenAiPromptFromHints(hintsInput, options = {}) {
  const hints = normalizeAsrHints(hintsInput);
  if (!hints) return undefined;
  const includeRecentContext = options.includeRecentContext === true;
  const parts = [];
  if (hints.hotwords.length > 0) parts.push(hints.hotwords.join(', '));
  if (includeRecentContext && hints.recentContext.length > 0) {
    parts.push(hints.recentContext.join(' '));
  }
  const text = parts.join('. ').trim();
  return text ? text.slice(0, 600).trim() : undefined;
}

export function makeSinePcm16(sampleRate, durationMs, freqHz, rmsTarget) {
  const count = Math.round((sampleRate * durationMs) / 1000);
  const amp = Math.min(32700, Math.round(rmsTarget * Math.SQRT2));
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp);
  }
  return samples.buffer;
}

export function makeGaussianNoisePcm16(sampleRate, durationMs, rmsTarget, seed = 42) {
  const count = Math.round((sampleRate * durationMs) / 1000);
  const samples = new Int16Array(count);
  let state = seed >>> 0;
  const nextRand = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
  for (let i = 0; i < count; i += 1) {
    const u1 = nextRand();
    const u2 = nextRand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(g * rmsTarget)));
  }
  return samples.buffer;
}

export function mixPcm16(a, b) {
  const sa = new Int16Array(a);
  const sb = new Int16Array(b);
  const len = Math.min(sa.length, sb.length);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = Math.max(-32768, Math.min(32767, sa[i] + sb[i]));
  }
  return out.buffer;
}

export function slicePcmChunks(buf, sampleRate, chunkMs) {
  const chunkBytes = Math.max(2, Math.round((sampleRate * 2 * chunkMs) / 1000));
  const aligned = chunkBytes - (chunkBytes % 2);
  const u8 = new Uint8Array(buf);
  const chunks = [];
  for (let off = 0; off < u8.byteLength; off += aligned) {
    chunks.push(u8.slice(off, Math.min(u8.byteLength, off + aligned)).buffer);
  }
  return chunks;
}

function makeSyllableLikeSpeechPcm16(sampleRate, durationMs, targetRms) {
  // Speech-like amplitude-modulated harmonic signal (~4 Hz syllable rate) for
  // deterministic cross-platform offline tests without requiring macOS `say`.
  const count = Math.round((sampleRate * durationMs) / 1000);
  const raw = new Float64Array(count);
  let sumSq = 0;
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 3.5 * t)), 0.7);
    const carrier = 0.6 * Math.sin(2 * Math.PI * 220 * t)
      + 0.3 * Math.sin(2 * Math.PI * 440 * t)
      + 0.1 * Math.sin(2 * Math.PI * 880 * t);
    const value = envelope * carrier;
    raw[i] = value;
    sumSq += value * value;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, count));
  const gain = rms > 0 ? targetRms / rms : 0;
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(raw[i] * gain)));
  }
  return out.buffer;
}

function evalDictionaryGate(coreModule, repoRoot, latencyRounds) {
  const fixtureFiles = [
    path.join('scripts', 'fixtures', 'voice-dictionary-v1.json'),
    path.join('scripts', 'fixtures', 'voice-dictionary-v2.json'),
    path.join('scripts', 'fixtures', 'voice-dictionary-v3.json'),
    path.join('scripts', 'fixtures', 'voice-dictionary-v4.json'),
  ];
  const officialCases = [];
  for (const rel of fixtureFiles) {
    const full = path.join(repoRoot, rel);
    if (!fs.existsSync(full)) continue;
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    for (const c of data.cases ?? []) {
      officialCases.push({ id: c.id, category: c.category, file: path.basename(rel), input: c.input });
    }
  }

  const stressCases = [
    {
      id: 'multi-zh-2pt-80ch',
      expectedBlocked: false,
      input: {
        beforeText: '我们今天上午把心迪的语音识别链路全部过了一遍，确认延迟瓶颈主要在握手阶段，下午准备再核对一下飞书多维表割的同步逻辑。',
        afterText: '我们今天上午把Cindy的语音识别链路全部过了一遍，确认延迟瓶颈主要在握手阶段，下午准备再核对一下飞书多维表格的同步逻辑。',
      },
    },
    {
      id: 'multi-zh-3pt-140ch',
      expectedBlocked: false,
      input: {
        beforeText: '这一批先做立特模型网关的鉴权整理，中间把工作区隔离逻辑统一到主干标准，最后再补全火山隐情的流式首包参数配置，确保桌面端和手机端在弱网环境下都能稳定恢复并且不丢失已经说出口的音频片段。',
        afterText: '这一批先做LiteLLM网关的鉴权整理，中间把worktree隔离逻辑统一到主干标准，最后再补全火山引擎的流式首包参数配置，确保桌面端和手机端在弱网环境下都能稳定恢复并且不丢失已经说出口的音频片段。',
      },
    },
    {
      id: 'multi-en-2pt-150ch',
      expectedBlocked: false,
      input: {
        beforeText: 'Please check the Litellm gateway routing table first so every request hits the right region, and then update the ProseMiror transaction handler before release.',
        afterText: 'Please check the LiteLLM gateway routing table first so every request hits the right region, and then update the ProseMirror transaction handler before release.',
      },
    },
    {
      id: 'multi-zh-2pt-240ch',
      expectedBlocked: false,
      input: {
        beforeText: '今天开会讨论了三个重点事项，第一是把沙帕声纹识别在安卓设备上的冷启动耗时再压缩一半，第二是把本地历史记录搜索加上关键词高亮和原文润色对比视图方便排查问题，第三是在客户端发包前统一验证一下端侧离线模型的校验和与下载回退逻辑，避免弱网环境下出现不可用状态，另外记得同步更新一下爱提格拉维提的插件文档。',
        afterText: '今天开会讨论了三个重点事项，第一是把Sherpa声纹识别在安卓设备上的冷启动耗时再压缩一半，第二是把本地历史记录搜索加上关键词高亮和原文润色对比视图方便排查问题，第三是在客户端发包前统一验证一下端侧离线模型的校验和与下载回退逻辑，避免弱网环境下出现不可用状态，另外记得同步更新一下Antigravity的插件文档。',
      },
    },
    {
      id: 'multi-mixed-2pt-110ch',
      expectedBlocked: false,
      input: {
        beforeText: '先用泰尔斯凯尔连上公司内网那台测试机，拉完最新分支之后直接跑一遍完整回归，跑完把报告发到斯莱克群里让大家看一下。',
        afterText: '先用Tailscale连上公司内网那台测试机，拉完最新分支之后直接跑一遍完整回归，跑完把报告发到Slack群里让大家看一下。',
      },
    },
    {
      id: 'multi-zh-2pt-names',
      expectedBlocked: false,
      input: {
        beforeText: '麻烦把这份季度复盘发给达什审阅一下，里面提到的几个核心指标都已经按最新的口径重新核算完毕，抄送给辛迪团队的同学。',
        afterText: '麻烦把这份季度复盘发给Dash审阅一下，里面提到的几个核心指标都已经按最新的口径重新核算完毕，抄送给Cindy团队的同学。',
      },
    },
    {
      id: 'multi-zh-2pt-short-fix',
      expectedBlocked: false,
      input: {
        beforeText: '代码里的科德克斯配置需要改成最新的参数，另外客户端界面上那个提示谈过一次的问题也顺手修一下。',
        afterText: '代码里的Codex配置需要改成最新的参数，另外客户端界面上那个提示弹过一次的问题也顺手修一下。',
      },
    },
    {
      id: 'multi-zh-3pt-small',
      expectedBlocked: false,
      input: {
        beforeText: '欧鹏克劳目前已经接通了，接下来把梯普塔普编辑器里的选区状态同步好，再去测一下库伯奈提斯集群的扩容速度。',
        afterText: 'OpenClaw目前已经接通了，接下来把TipTap编辑器里的选区状态同步好，再去测一下Kubernetes集群的扩容速度。',
      },
    },
    {
      id: 'rewrite-heavy-edit-zh',
      expectedBlocked: true,
      input: {
        beforeText: '我本来想说这个方案可以直接上线，但是仔细想了想还是有很多边界条件没有覆盖到，需要再补测试。',
        afterText: '评审结论是暂缓发布：性能压测未达标、灰度回滚脚本缺失、跨区配置存在明显冲突，下周三复审。',
      },
    },
    {
      id: 'rewrite-heavy-edit-en',
      expectedBlocked: true,
      input: {
        beforeText: 'We initially planned to deploy the mobile voice update on Friday afternoon after smoke testing.',
        afterText: 'Deployment has been cancelled because telemetry showed severe packet loss across regional relays.',
      },
    },
    {
      id: 'rewrite-massive-append',
      expectedBlocked: true,
      input: {
        beforeText: '明天开会讨论一下语音输入。',
        afterText: '明天开会讨论一下语音输入，具体议程包括第一季度用户留存分析、各大语音识别厂商的延迟与成本对比、客户端离线模型的分发策略以及跨平台快捷键冲突的系统性治理方案。',
      },
    },
    {
      id: 'rewrite-massive-delete',
      expectedBlocked: true,
      input: {
        beforeText: '这个版本我们一共修复了十五个线上遗留缺陷，包括弱网重连丢字、多屏浮窗定位偏移、剪贴板内容恢复失败以及部分旧设备触觉反馈异常等问题，请大家重点回归。',
        afterText: '请大家重点回归。',
      },
    },
    {
      id: 'rewrite-mid-paragraph-overhaul',
      expectedBlocked: true,
      input: {
        beforeText: '关于这次架构升级，我们决定先保持现有单库方案不变，只在应用层加一层本地缓存来缓解读压力，等明年业务翻倍再评估分库。',
        afterText: '关于这次架构升级，我们改为直接拆分读写分离集群并引入分布式消息队列异步落盘，同时把旧的批处理任务全部迁移到流式计算框架。',
      },
    },
  ];

  let officialGateLimitTotal = 0;
  let officialGateLimitBlocked = 0;
  let officialLargeRewriteBlocked = 0;
  for (const c of officialCases) {
    const reason = coreModule.getDictationDictionaryAdviceSkipReason(c.input);
    if (reason === 'large_rewrite') officialLargeRewriteBlocked += 1;
    if (c.category === 'gate_limit') {
      officialGateLimitTotal += 1;
      if (reason === 'large_rewrite') officialGateLimitBlocked += 1;
    }
  }

  let validMultiTotal = 0;
  let validMultiFalseBlocked = 0;
  let genuineRewriteTotal = 0;
  let genuineRewriteTrueBlocked = 0;
  for (const sc of stressCases) {
    const blocked = coreModule.getDictationDictionaryAdviceSkipReason(sc.input) === 'large_rewrite';
    if (!sc.expectedBlocked) {
      validMultiTotal += 1;
      if (blocked) validMultiFalseBlocked += 1;
    } else {
      genuineRewriteTotal += 1;
      if (blocked) genuineRewriteTrueBlocked += 1;
    }
  }

  const samplesMs = [];
  for (let round = 0; round < latencyRounds; round += 1) {
    for (const sc of stressCases) {
      const t0 = realPerf.now();
      coreModule.getDictationDictionaryAdviceSkipReason(sc.input);
      samplesMs.push(realPerf.now() - t0);
    }
  }

  return {
    officialCasesTotal: officialCases.length,
    officialGateLimitTotal,
    officialGateLimitBlocked,
    officialLargeRewriteBlocked,
    validMultiEditTotal: validMultiTotal,
    validMultiEditFalseBlocked: validMultiFalseBlocked,
    validMultiEditFalseBlockRate: Number((validMultiFalseBlocked / Math.max(1, validMultiTotal)).toFixed(4)),
    genuineRewriteTotal,
    genuineRewriteTrueBlocked,
    genuineRewriteTrueBlockRate: Number((genuineRewriteTrueBlocked / Math.max(1, genuineRewriteTotal)).toFixed(4)),
    latencyP50Ms: percentile(samplesMs, 0.5),
    latencyP95Ms: percentile(samplesMs, 0.95),
  };
}

async function evalDictionaryMatching(coreModule, latencyRounds) {
  const coreHints = [
    { term: 'Slack', frequency: 25, aliases: [{ text: 'Slate', count: 3 }] },
    { term: 'Codex', frequency: 30, aliases: [{ text: '科德克斯', count: 2 }] },
    { term: 'LiteLLM', frequency: 28, aliases: [] },
    { term: 'Next.js', frequency: 18, aliases: [] },
    { term: 'TypeScript', frequency: 24, aliases: [] },
    { term: 'ProseMirror', frequency: 16, aliases: [] },
    { term: 'Volcengine', frequency: 20, aliases: [] },
    { term: 'Antigravity', frequency: 22, aliases: [] },
    { term: 'Kubernetes', frequency: 19, aliases: [] },
    { term: 'PostgreSQL', frequency: 17, aliases: [] },
    { term: 'sherpa-onnx', frequency: 15, aliases: [] },
    { term: '飞书Bitable', frequency: 14, aliases: [] },
    { term: '飞书多维表格', frequency: 21, aliases: [] },
    { term: '火山引擎', frequency: 23, aliases: [] },
    { term: '心动网络', frequency: 26, aliases: [] },
    { term: '林晨', frequency: 12, aliases: [] },
    { term: '声纹过滤', frequency: 15, aliases: [] },
    { term: '语音输入', frequency: 29, aliases: [] },
    { term: '润色撤销', frequency: 11, aliases: [] },
    { term: '张伟明', frequency: 13, aliases: [] },
    { term: '陈思远', frequency: 10, aliases: [] },
    { term: '高并发队列', frequency: 9, aliases: [] },
    { term: 'Tailscale', frequency: 16, aliases: [] },
    { term: 'ElevenLabs', frequency: 14, aliases: [] },
    { term: 'WebSocket', frequency: 27, aliases: [] },
  ];
  const fillerTerms = Array.from({ length: 177 }, (_, idx) => (
    idx % 2 === 0 ? `SyntheticTerm${idx}` : `示例词条${idx}`
  ));
  const allHints = [
    ...coreHints,
    ...fillerTerms.map((term, idx) => ({ term, frequency: (idx % 5) + 1, aliases: [] })),
  ];
  const userDictionary = allHints.map((h) => h.term).join('\n');

  const cases = [
    { id: 'exact-1', category: 'exact_alias', dictationText: '把报告发到 Slate 群里看一下。', expectedTerm: 'Slack' },
    { id: 'exact-2', category: 'exact_alias', dictationText: '先用科德克斯把测试补全。', expectedTerm: 'Codex' },
    { id: 'comp-1', category: 'compound_split', dictationText: '帮我看下 lite llm 的路由配置。', expectedTerm: 'LiteLLM' },
    { id: 'comp-2', category: 'compound_split', dictationText: '前端升级到了 next js 最新版本。', expectedTerm: 'Next.js' },
    { id: 'comp-3', category: 'compound_split', dictationText: '把数据同步到飞书 bitable 里面。', expectedTerm: '飞书Bitable' },
    { id: 'comp-4', category: 'compound_split', dictationText: '我们本地跑 sherpa onnx 模型。', expectedTerm: 'sherpa-onnx' },
    { id: 'comp-5', category: 'compound_split', dictationText: '代码全部迁移成 type script 了。', expectedTerm: 'TypeScript' },
    { id: 'comp-6', category: 'compound_split', dictationText: '检查一下 web socket 的心跳超时。', expectedTerm: 'WebSocket' },
    { id: 'hom-1', category: 'cjk_homophone', dictationText: '今天测一下飞书多维表割的导出功能。', expectedTerm: '飞书多维表格' },
    { id: 'hom-2', category: 'cjk_homophone', dictationText: '新动网络这周要发一个大版本。', expectedTerm: '心动网络' },
    { id: 'hom-3', category: 'cjk_homophone', dictationText: '帮我转告一下林臣下午三点开会。', expectedTerm: '林晨' },
    { id: 'hom-4', category: 'cjk_homophone', dictationText: '这次优化重点解决语音数入的延迟。', expectedTerm: '语音输入' },
    { id: 'hom-5', category: 'cjk_homophone', dictationText: '加一个润涩撤销的快捷操作。', expectedTerm: '润色撤销' },
    { id: 'hom-6', category: 'cjk_homophone', dictationText: '找张伟名确认一下发布窗口。', expectedTerm: '张伟明' },
    { id: 'near-1', category: 'cjk_near_homophone', dictationText: '火山隐情那边回复了工单。', expectedTerm: '火山引擎' },
    { id: 'near-2', category: 'cjk_near_homophone', dictationText: '请陈思元帮忙看一下这个 PR。', expectedTerm: '陈思远' },
    { id: 'near-3', category: 'cjk_near_homophone', dictationText: '检查一下生纹过滤的首窗逻辑。', expectedTerm: '声纹过滤' },
    { id: 'near-4', category: 'cjk_near_homophone', dictationText: '看看高并发队裂有没有积压。', expectedTerm: '高并发队列' },
    { id: 'ed-1', category: 'latin_edit_distance', dictationText: 'Check the LiteLM proxy configuration.', expectedTerm: 'LiteLLM' },
    { id: 'ed-2', category: 'latin_edit_distance', dictationText: 'Update Antigravty plugin manifest.', expectedTerm: 'Antigravity' },
    { id: 'ed-3', category: 'latin_edit_distance', dictationText: 'Debug Volcengne streaming handshake.', expectedTerm: 'Volcengine' },
    { id: 'ed-4', category: 'latin_edit_distance', dictationText: 'Fix ProseMiror undo history step.', expectedTerm: 'ProseMirror' },
    { id: 'ed-5', category: 'latin_edit_distance', dictationText: 'Deploy Kuberntes ingress rules.', expectedTerm: 'Kubernetes' },
    { id: 'ed-6', category: 'latin_edit_distance', dictationText: 'Migrate PostgeSQL schema cleanly.', expectedTerm: 'PostgreSQL' },
    { id: 'neg-1', category: 'negative_trap', dictationText: 'Check the call stack trace in Chrome.', expectedTerm: null },
    { id: 'neg-2', category: 'negative_trap', dictationText: 'Return HTTP status codes cleanly.', expectedTerm: null },
    { id: 'neg-3', category: 'negative_trap', dictationText: 'LiteLLM and Volcengine are already spelled right here.', expectedTerm: null },
    { id: 'neg-4', category: 'negative_trap', dictationText: '今天中午吃什么比较方便，大家有没有推荐的餐厅。', expectedTerm: null },
    { id: 'neg-5', category: 'negative_trap', dictationText: '我们下午把季度预算和招聘计划再过一遍。', expectedTerm: null },
    { id: 'neg-6', category: 'negative_trap', dictationText: 'The black cat slept on the warm rack all morning.', expectedTerm: null },
  ];

  const extractMatches = async (dictationText) => {
    let captured;
    const refiner = new coreModule.DictationRefiner({
      model: 'bench',
      contextProvider: () => ({ userDictionary, dictionaryAliasHints: allHints }),
      client: {
        async requestJson(req) {
          captured = req.user?.userDictionaryMatches;
          return { text: dictationText };
        },
      },
    });
    await refiner.refine({ text: dictationText, runId: 'bench', segmentIds: [] });
    return captured;
  };

  let positiveTotal = 0;
  let tp = 0;
  let trapTotal = 0;
  let fpOnTraps = 0;
  const byCategory = {};
  for (const c of cases) {
    byCategory[c.category] ??= { total: 0, hit: 0, fp: 0 };
    byCategory[c.category].total += 1;
    const matchedBlock = await extractMatches(c.dictationText);
    if (c.expectedTerm) {
      positiveTotal += 1;
      if (matchedBlock && matchedBlock.includes(`“${c.expectedTerm}”`)) {
        tp += 1;
        byCategory[c.category].hit += 1;
      }
    } else {
      trapTotal += 1;
      if (matchedBlock && matchedBlock.trim().length > 0) {
        fpOnTraps += 1;
        byCategory[c.category].fp += 1;
      }
    }
  }

  const latSamples = [];
  const probeTexts = [cases[2].dictationText, cases[8].dictationText, cases[18].dictationText, cases[24].dictationText];
  const rounds = Math.max(5, Math.min(40, latencyRounds));
  for (let r = 0; r < rounds; r += 1) {
    for (const txt of probeTexts) {
      const t0 = realPerf.now();
      if (typeof coreModule.buildFuzzyUserDictionaryMatches === 'function') {
        coreModule.buildFuzzyUserDictionaryMatches(txt, allHints, userDictionary);
      } else {
        await extractMatches(txt);
      }
      latSamples.push(realPerf.now() - t0);
    }
  }

  return {
    dictionaryEntries: allHints.length,
    fuzzyMatcherSupported: typeof coreModule.buildFuzzyUserDictionaryMatches === 'function',
    positiveTotal,
    tp,
    recall: Number((tp / Math.max(1, positiveTotal)).toFixed(4)),
    trapTotal,
    fpOnTraps,
    trapFalsePositiveRate: Number((fpOnTraps / Math.max(1, trapTotal)).toFixed(4)),
    precision: Number((tp / Math.max(1, tp + fpOnTraps)).toFixed(4)),
    latencyP50Ms: percentile(latSamples, 0.5),
    latencyP95Ms: percentile(latSamples, 0.95),
    byCategory,
  };
}

async function evalAcousticAndSpeaker(coreModule) {
  const sampleRate = 16_000;
  const quietSpeech = makeSyllableLikeSpeechPcm16(sampleRate, 1600, 420);
  const normalSpeech = makeSyllableLikeSpeechPcm16(sampleRate, 1600, 2200);
  const makeChunks = (buf, startCueEchoWindow = false) =>
    slicePcmChunks(buf, sampleRate, 40).map((pcm) => ({ pcm, startCueEchoWindow }));

  const silenceScenarios = [
    { id: 'pure-silence-room', expectedHasSound: false, chunks: makeChunks(makeGaussianNoisePcm16(sampleRate, 1600, 8, 101)) },
    { id: 'office-ac-gaussian-rms120', expectedHasSound: false, chunks: makeChunks(makeGaussianNoisePcm16(sampleRate, 1600, 120, 102)) },
    { id: 'fan-cafe-gaussian-rms300', expectedHasSound: false, chunks: makeChunks(makeGaussianNoisePcm16(sampleRate, 1600, 300, 103)) },
    {
      id: 'start-cue-bleed-rms200-160ms',
      expectedHasSound: false,
      chunks: [
        ...makeChunks(makeSinePcm16(sampleRate, 160, 920, 200), true),
        ...makeChunks(makeGaussianNoisePcm16(sampleRate, 1200, 10, 104), false),
      ],
    },
    {
      id: 'start-cue-bleed-rms600-240ms',
      expectedHasSound: false,
      chunks: [
        ...makeChunks(makeSinePcm16(sampleRate, 240, 920, 600), true),
        ...makeChunks(makeGaussianNoisePcm16(sampleRate, 1200, 12, 105), false),
      ],
    },
    {
      id: 'start-cue-plus-immediate-speech',
      expectedHasSound: true,
      chunks: [
        ...makeChunks(mixPcm16(makeSinePcm16(sampleRate, 240, 920, 500), normalSpeech.slice(0, 16000 * 2 * 0.24)), true),
        ...makeChunks(normalSpeech.slice(16000 * 2 * 0.24, 16000 * 2 * 1.2), false),
      ],
    },
    {
      id: 'quiet-speech-in-quiet-room',
      expectedHasSound: true,
      chunks: [
        ...makeChunks(makeGaussianNoisePcm16(sampleRate, 400, 10, 106), false),
        ...makeChunks(quietSpeech, false),
      ],
    },
    {
      id: 'normal-speech-in-office-ac',
      expectedHasSound: true,
      chunks: [
        ...makeChunks(makeGaussianNoisePcm16(sampleRate, 400, 120, 107), false),
        ...makeChunks(mixPcm16(makeGaussianNoisePcm16(sampleRate, 1600, 120, 108), normalSpeech), false),
      ],
    },
    {
      id: 'normal-speech-in-loud-fan',
      expectedHasSound: true,
      chunks: [
        ...makeChunks(makeGaussianNoisePcm16(sampleRate, 400, 300, 109), false),
        ...makeChunks(mixPcm16(makeGaussianNoisePcm16(sampleRate, 1600, 300, 110), normalSpeech), false),
      ],
    },
  ];

  const hasRecordingSoundDetector = typeof coreModule.RecordingSoundDetector === 'function';
  const silenceDetails = silenceScenarios.map((sc) => {
    let hasSound = false;
    if (hasRecordingSoundDetector) {
      const detector = new coreModule.RecordingSoundDetector();
      for (const ch of sc.chunks) {
        detector.append(ch.pcm, { sampleRate, durationMs: 40, startCueEchoWindow: ch.startCueEchoWindow });
      }
      hasSound = detector.hasSound;
    } else {
      for (const ch of sc.chunks) {
        if (coreModule.hasPcmSound(ch.pcm)) hasSound = true;
      }
    }
    return {
      id: sc.id,
      expectedHasSound: sc.expectedHasSound,
      hasSound,
      correct: hasSound === sc.expectedHasSound,
    };
  });

  // StopSoundActivity fast-stop under steady Gaussian noise
  const stopFastFinish = [
    { id: 'quiet-room-rms10', noiseRms: 10 },
    { id: 'office-ac-rms120', noiseRms: 120 },
    { id: 'cafe-fan-rms280', noiseRms: 280 },
  ].map(({ id, noiseRms }) => {
    const tracker = new coreModule.StopSoundActivity(sampleRate);
    const preNoise = makeGaussianNoisePcm16(sampleRate, 600, noiseRms, 201);
    const speech = mixPcm16(makeGaussianNoisePcm16(sampleRate, 1600, noiseRms, 202), normalSpeech);
    const postNoise = makeGaussianNoisePcm16(sampleRate, 2400, noiseRms, 203);
    const totalMs = 4600;
    for (const part of [preNoise, speech, postNoise]) {
      for (const ch of slicePcmChunks(part, sampleRate, 40)) {
        tracker.append(new Uint8Array(ch));
      }
    }
    const quietTailMs = Math.round(totalMs - tracker.lastSoundEndMs);
    return { id, noiseRms, quietTailMs, fastStopEligible: quietTailMs >= 2000 };
  });

  // Voiced detector false chunks under RMS 340 fan noise
  const fanChunks = slicePcmChunks(makeGaussianNoisePcm16(sampleRate, 3000, 340, 301), sampleRate, 40);
  let fanFalseVoicedChunks = 0;
  if (typeof coreModule.AdaptiveVoicedDetector === 'function') {
    const detector = new coreModule.AdaptiveVoicedDetector();
    for (const ch of fanChunks) {
      if (detector.observe(ch, { sampleRate, durationMs: 40 }).voiced) fanFalseVoicedChunks += 1;
    }
  } else {
    for (const ch of fanChunks) {
      const s = new Int16Array(ch);
      let sq = 0;
      for (let i = 0; i < s.length; i += 1) sq += s[i] * s[i];
      if (Math.sqrt(sq / s.length) >= 300) fanFalseVoicedChunks += 1;
    }
  }

  // SpeakerGate short initial utterance vs bystander
  const enrolled = new Float32Array([1, 0, 0, 0]);
  const makeEmb = (cos) => new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos)), 0, 0]);
  const runSpeakerGate = async (speechMs, embedResult) => {
    const emitted = [];
    const gate = new coreModule.SpeakerGate({
      enrolledEmbedding: enrolled,
      threshold: 0.5,
      continueThreshold: 0.4,
      windowSec: 1.5,
      minVerifySec: 1.0,
      prerollSec: 0.2,
      engine: {
        async resetVad() {},
        async detectSpeech(samples) {
          const frames = Math.floor(samples.length / 512);
          return Array.from({ length: frames }, (_, idx) => {
            let sq = 0;
            for (let i = 0; i < 512; i += 1) {
              const v = samples[idx * 512 + i];
              sq += v * v;
            }
            return Math.sqrt(sq / 512) > 0.02;
          });
        },
        async embed() { return embedResult; },
      },
    });
    gate.begin((chunk) => emitted.push(new Int16Array(chunk.slice(0))));
    const parts = [
      new ArrayBuffer(16000 * 2 * 0.2),
      makeSinePcm16(16000, speechMs, 300, 3000),
      new ArrayBuffer(16000 * 2 * 0.3),
    ];
    for (const part of parts) {
      for (const ch of slicePcmChunks(part, 16000, 32)) gate.push(ch);
    }
    await gate.finish();
    let voicedSamples = 0;
    for (const arr of emitted) {
      for (let i = 0; i < arr.length; i += 1) {
        if (Math.abs(arr[i]) > 100) voicedSamples += 1;
      }
    }
    return voicedSamples > 0;
  };

  return {
    adaptiveSilenceSupported: hasRecordingSoundDetector,
    silenceAccuracy: Number((silenceDetails.filter((d) => d.correct).length / silenceDetails.length).toFixed(4)),
    silentFalseTriggers: silenceDetails.filter((d) => !d.expectedHasSound && d.hasSound).length,
    speechRecall: Number(
      (
        silenceDetails.filter((d) => d.expectedHasSound && d.hasSound).length
        / Math.max(1, silenceDetails.filter((d) => d.expectedHasSound).length)
      ).toFixed(4),
    ),
    silenceDetails,
    stopFastFinishEligibleUnderNoise: stopFastFinish.filter((s) => s.noiseRms >= 100 && s.fastStopEligible).length,
    stopFastFinishNoiseCases: stopFastFinish.filter((s) => s.noiseRms >= 100).length,
    stopFastFinish,
    fanVoicedFalseChunkRate: Number((fanFalseVoicedChunks / fanChunks.length).toFixed(4)),
    fanFalseVoicedChunks,
    fanTotalChunks: fanChunks.length,
    speakerGate: {
      ownerShortDepressedCos044Accepted: await runSpeakerGate(480, makeEmb(0.44)),
      ownerShortNullEmbeddingAccepted: await runSpeakerGate(400, null),
      bystanderCos012Rejected: !(await runSpeakerGate(480, makeEmb(0.12))),
    },
  };
}

async function evalLongSpeechAndRotation(coreModule) {
  const origPerfNow = globalThis.performance.now.bind(globalThis.performance);
  const origDateNow = Date.now;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  let nowMs = 1_000_000;
  let nextId = 1;
  const tasks = new Map();

  const installFakeClock = () => {
    nowMs = 1_000_000;
    tasks.clear();
    globalThis.performance.now = () => nowMs;
    Date.now = () => nowMs;
    globalThis.setTimeout = (fn, ms = 0) => {
      const id = nextId++;
      tasks.set(id, { id, at: nowMs + Math.max(0, ms), fn, cancelled: false });
      return id;
    };
    globalThis.clearTimeout = (id) => {
      const t = tasks.get(id);
      if (t) { t.cancelled = true; tasks.delete(id); }
    };
    globalThis.setInterval = (fn, ms = 0) => {
      const id = nextId++;
      const step = Math.max(1, ms);
      tasks.set(id, { id, at: nowMs + step, interval: step, fn, cancelled: false });
      return id;
    };
    globalThis.clearInterval = (id) => {
      const t = tasks.get(id);
      if (t) { t.cancelled = true; tasks.delete(id); }
    };
  };

  const restoreClock = () => {
    globalThis.performance.now = origPerfNow;
    Date.now = origDateNow;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  };

  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  const advanceClock = async (deltaMs) => {
    const target = nowMs + deltaMs;
    while (true) {
      let earliest = null;
      for (const t of tasks.values()) {
        if (!t.cancelled && t.at <= target && (!earliest || t.at < earliest.at)) earliest = t;
      }
      if (!earliest) break;
      nowMs = earliest.at;
      if (earliest.interval !== undefined) earliest.at += earliest.interval;
      else tasks.delete(earliest.id);
      earliest.fn();
      await flushMicrotasks();
    }
    nowMs = target;
    await flushMicrotasks();
  };

  const sampleSentences = [
    '嗯那个我们今天先看一下语音输入系统的长语音稳定性问题。',
    '目前在桌面端和移动端连续说话超过三分钟的时候，服务端会因为连接时长上限强制断开。',
    '而且每次停顿润色都会把前面已经润色过的整段文字全部重新发一遍给大模型。',
    '这样不仅浪费了大量的输入输出令牌，在字数超过八百字以后还会撞上输出上限导致截断。',
    '截断之后润色结果解析失败，整段文字就会退回原始口水话，用户体验非常割裂。',
    '改成增量分段润色以后，已经确认的前缀段落会直接冻结保留，只把新增的尾句发给模型。',
    '同时在会话接近一百五十秒的停顿窗口主动轮换一条新连接，把旧会话的已确认文本无缝拼起来。',
    '如果用户一直连续说没有停顿，到一百六十五秒也会在后台触发强制轮换并且保住缓冲帧不丢字。',
  ];

  const supportsRotationAndIncremental = typeof coreModule.splitLongDeltaForRefinement === 'function';
  const MAX_SERVER_SESSION_MS = 180_000;
  const SERVER_REFINE_TRUNCATION_CHARS = 780;

  const runScenario = async (spec) => {
    installFakeClock();
    try {
      let asrCallback = () => {};
      let sessionIndex = 1;
      let sessionStartAt = nowMs;
      let serverHardClosed = false;
      let cumulativeTranscript = '';
      let rotations = 0;
      let refineCalls = 0;
      let refineTotalInputChars = 0;
      let refineMaxSingleInputChars = 0;
      let refineTruncations = 0;
      let finalSubmittedText = '';
      let finalRefinedText = '';
      let failedError = null;

      const voicedPcm = makeSinePcm16(16000, 40, 400, 2000);
      const silentPcm = new ArrayBuffer(16000 * 2 * 0.04);

      const asr = {
        onEvent(cb) { asrCallback = cb; },
        async start() {
          sessionStartAt = nowMs;
          serverHardClosed = false;
          asrCallback({ type: 'connected', at: nowMs });
        },
        appendAudio() {
          if (serverHardClosed) return;
          if (nowMs - sessionStartAt >= MAX_SERVER_SESSION_MS) {
            serverHardClosed = true;
            asrCallback({ type: 'error', message: 'session duration limit (1008)', at: nowMs });
            asrCallback({ type: 'disconnected', at: nowMs });
          }
        },
        async flushAudio() {
          if (!serverHardClosed && cumulativeTranscript) {
            asrCallback({ type: 'stable', text: cumulativeTranscript, at: nowMs });
          }
        },
        async stop() {},
        ...(supportsRotationAndIncremental
          ? {
              async rotateSession() {
                rotations += 1;
                sessionIndex += 1;
                sessionStartAt = nowMs;
                serverHardClosed = false;
              },
            }
          : {}),
      };

      const refiner = {
        async refine(input) {
          refineCalls += 1;
          refineTotalInputChars += input.text.length;
          refineMaxSingleInputChars = Math.max(refineMaxSingleInputChars, input.text.length);
          const simMs = 120 + Math.round(input.text.length * 1.5);
          await new Promise((resolve) => setTimeout(resolve, simMs));
          if (input.text.length > SERVER_REFINE_TRUNCATION_CHARS) {
            refineTruncations += 1;
            throw new Error(`Simulated 1024-token truncation (input=${input.text.length} chars)`);
          }
          const cleaned = input.text.replace(/嗯那个/g, '').replace(/\s+/g, ' ').trim();
          return {
            accepted: true,
            sourceSegmentIds: input.segmentIds,
            basedOnText: input.text,
            refinedText: cleaned,
            elapsedMs: simMs,
          };
        },
      };

      const controller = new coreModule.VoiceInputController({
        asr,
        refiner,
        logger: new coreModule.VoiceTimelineLogger(),
        pauseRefinementEnabled: true,
        refineRequestBudget: () => ({ sessionKey: `s-${sessionIndex}`, limit: 12 }),
        ...(supportsRotationAndIncremental
          ? { sessionRotation: { softRotateAfterMs: 150_000, hardRotateAfterMs: 165_000, pauseQuietMs: 800 } }
          : {}),
        callbacks: {
          onStateChanged() {},
          onDraftChanged() {},
          onSubmitted(text, segment) {
            finalSubmittedText = text;
            return { id: 'r1', segmentIds: [segment.id], startOffset: 0, endOffset: text.length, userTouched: false };
          },
          applyRefinement(_range, refinedText) {
            finalRefinedText = refinedText;
            return true;
          },
          onError(msg) { failedError = msg; },
        },
      });

      await controller.start();

      for (let u = 0; u < spec.utterances; u += 1) {
        if (failedError) break;
        const sentence = sampleSentences[u % sampleSentences.length];
        for (let t = 0; t < 4000; t += 200) {
          controller.appendAudio(voicedPcm, { chunkIndex: u * 100 + t, sampleRate: 16000, durationMs: 200 });
          await advanceClock(200);
          if (failedError) break;
        }
        if (failedError) break;
        if (!serverHardClosed) {
          cumulativeTranscript = cumulativeTranscript ? `${cumulativeTranscript}${sentence}` : sentence;
          asrCallback({ type: 'partial', text: cumulativeTranscript, at: nowMs });
          asrCallback({ type: 'stable', text: cumulativeTranscript, at: nowMs });
        }
        for (let t = 0; t < spec.intervalBetweenUtterancesMs; t += 200) {
          controller.appendAudio(spec.pauseBetweenUtterances ? silentPcm : voicedPcm, {
            chunkIndex: u * 1000 + t,
            sampleRate: 16000,
            durationMs: 200,
          });
          await advanceClock(200);
          if (failedError) break;
        }
      }

      const stopStartedAt = nowMs;
      const stopPromise = controller.stop();
      for (let step = 0; step < 30; step += 1) await advanceClock(500);
      await stopPromise;

      const deliveredText = finalRefinedText || finalSubmittedText;
      const expectedRefinedLength = Array.from(
        { length: spec.utterances },
        (_, i) => sampleSentences[i % sampleSentences.length].replace(/嗯那个/g, ''),
      ).join('').length;

      return {
        scenario: spec.id,
        simulatedDurationSec: Math.round((stopStartedAt - 1_000_000) / 1000),
        survived: !serverHardClosed && !failedError,
        failedError,
        rotations,
        refineCalls,
        refineTotalInputChars,
        refineMaxSingleInputChars,
        refineTruncations,
        finalRefinedApplied: Boolean(finalRefinedText),
        deliveredChars: deliveredText.length,
        expectedChars: expectedRefinedLength,
        charRetention: Math.min(1, Number((deliveredText.length / Math.max(1, expectedRefinedLength)).toFixed(4))),
      };
    } finally {
      restoreClock();
    }
  };

  const scenarios = [
    { id: '90s-paused-dictation', utterances: 10, intervalBetweenUtterancesMs: 5000, pauseBetweenUtterances: true },
    { id: '150s-continuous-1050ch', utterances: 28, intervalBetweenUtterancesMs: 1200, pauseBetweenUtterances: false },
    { id: '210s-paused-long-dictation', utterances: 24, intervalBetweenUtterancesMs: 5000, pauseBetweenUtterances: true },
    { id: '240s-continuous-monologue', utterances: 36, intervalBetweenUtterancesMs: 2600, pauseBetweenUtterances: false },
  ];
  const results = [];
  for (const s of scenarios) results.push(await runScenario(s));
  return {
    incrementalAndRotationSupported: supportsRotationAndIncremental,
    scenarios: results,
  };
}

async function evalFeatureGuards(coreModule) {
  // Failed audio retention
  let failedAudioRetention = { supported: false };
  if (typeof coreModule.FailedVoiceAudioAccumulator === 'function') {
    const speechBuf = makeSinePcm16(16000, 2000, 440, 1500);
    const silentBuf = new ArrayBuffer(16000 * 2 * 2);
    const acc = new coreModule.FailedVoiceAudioAccumulator({ sampleRate: 16000 });
    for (const ch of slicePcmChunks(speechBuf, 16000, 40)) acc.append(ch);
    const snap = acc.snapshot('bench-1', 1000);
    const replayed = snap ? coreModule.sliceRetainedAudioForReplay(snap) : [];
    const replayedBytes = replayed.reduce((s, c) => s + c.pcm.byteLength, 0);

    const accSilent = new coreModule.FailedVoiceAudioAccumulator({ sampleRate: 16000 });
    for (const ch of slicePcmChunks(silentBuf, 16000, 40)) accSilent.append(ch);
    failedAudioRetention = {
      supported: true,
      byteExactRecovery: snap !== null && replayedBytes === speechBuf.byteLength,
      silentRejected: accSilent.snapshot('bench-silent', 1000) === null,
    };
  }

  // ASR hints budget
  let asrHints = { supported: false };
  if (typeof coreModule.buildAsrRecognitionHints === 'function') {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      text: i < 15 ? `ManualTerm${i}` : `AutoTerm${i}`,
      source: i < 15 ? 'manual' : 'automatic',
      frequency: 200 - i,
    }));
    const t0 = realPerf.now();
    const hints = coreModule.buildAsrRecognitionHints({
      dictionaryEntries: entries,
      recentHistory: ['昨天排查了 LiteLLM 路由配置。', '今天验证 ProseMirror 撤销事务。'],
    });
    const volc = coreModule.buildVolcengineSaucCorpusContext?.(hints) ?? '';
    const qwen = coreModule.buildQwenAsrCorpusText?.(hints) ?? '';
    const openai = coreModule.buildOpenAiTranscriptionPrompt?.(hints) ?? '';
    const eleven = coreModule.buildElevenLabsScribeKeyterms?.(hints) ?? [];
    asrHints = {
      supported: true,
      elapsedMs: Number((realPerf.now() - t0).toFixed(3)),
      volcBytes: Buffer.byteLength(volc, 'utf8'),
      qwenChars: qwen.length,
      openaiChars: openai.length,
      openaiIncludesFullHistorySentence: openai.includes('昨天排查了'),
      elevenKeyterms: eleven.length,
    };
  }

  // activeApp sanitization + warmup prefix identity
  let activeApp = { supported: false };
  if (typeof coreModule.sanitizeActiveAppContext === 'function') {
    const sanitized = coreModule.sanitizeActiveAppContext({
      processName: 'Cursor',
      bundleId: 'com.todesktop.230313mzl4w4u92',
    });
    const urlBlocked = coreModule.sanitizeActiveAppContext('https://internal.example.com/secret') === undefined;
    let refineReq;
    const refiner = new coreModule.DictationRefiner({
      model: 'bench',
      contextProvider: () => ({ uiLanguage: 'zh-CN', activeApp: sanitized, userDictionary: 'LiteLLM' }),
      client: {
        async requestJson(req) {
          refineReq = req;
          return { text: '测试结果。' };
        },
      },
    });
    const warmup = refiner.buildWarmupRequest();
    await refiner.refine({ text: '测试结果', runId: 'r1', segmentIds: [] });
    const warmupPrefix = JSON.stringify(warmup.user).split('"dictationText"')[0];
    const refinePrefix = JSON.stringify(refineReq.user).split('"dictationText"')[0];
    activeApp = {
      supported: true,
      sanitizedCursor: sanitized,
      urlBlocked,
      warmupRefinePrefixIdentical: warmupPrefix === refinePrefix,
    };
  }

  // Voice rewrite guard separation
  let voiceRewrite = { supported: false };
  if (typeof coreModule.DictationRewriter === 'function') {
    const expanded = '各位同事好，受上游接口联调影响，原定今日发布的版本将顺延两天至本周五上线，期间核心功能验证将持续推进，感谢理解与支持。';
    const rewriter = new coreModule.DictationRewriter({
      model: 'bench',
      contextProvider: () => ({ selectedText: '今天项目延期两天。', uiLanguage: 'zh-CN' }),
      client: { async requestJson() { return { text: expanded }; } },
    });
    const rw = await rewriter.refine({ text: '帮我扩写成正式通知', runId: 'rw', segmentIds: ['s1'] });
    const defaultRefiner = new coreModule.DictationRefiner({
      model: 'bench',
      contextProvider: () => ({ selectedText: '今天项目延期两天。', uiLanguage: 'zh-CN' }),
      client: { async requestJson() { return { text: expanded }; } },
    });
    const df = await defaultRefiner.refine({ text: '帮我扩写成正式通知', runId: 'df', segmentIds: ['s1'] });
    voiceRewrite = {
      supported: true,
      explicitRewriterAccepted: rw.accepted,
      defaultRefinerBlockedDivergence: !df.accepted && df.rejectionReason === 'diverged_too_far',
    };
  }

  return { failedAudioRetention, asrHints, activeApp, voiceRewrite };
}

export async function runCoreOptimizationEval({ coreModule, label = 'current', repoRoot, latencyRounds = 50 }) {
  const dictionaryGate = evalDictionaryGate(coreModule, repoRoot, latencyRounds);
  const dictionaryMatching = await evalDictionaryMatching(coreModule, latencyRounds);
  const acousticAndSpeaker = await evalAcousticAndSpeaker(coreModule);
  const longSpeech = await evalLongSpeechAndRotation(coreModule);
  const featureGuards = await evalFeatureGuards(coreModule);
  return {
    label,
    dictionaryGate,
    dictionaryMatching,
    acousticAndSpeaker,
    longSpeech,
    featureGuards,
  };
}

export function compareCoreEvalReports(baseline, candidate) {
  const b90 = baseline.longSpeech.scenarios.find((s) => s.scenario === '90s-paused-dictation');
  const c90 = candidate.longSpeech.scenarios.find((s) => s.scenario === '90s-paused-dictation');
  const b150 = baseline.longSpeech.scenarios.find((s) => s.scenario === '150s-continuous-1050ch');
  const c150 = candidate.longSpeech.scenarios.find((s) => s.scenario === '150s-continuous-1050ch');
  const b210 = baseline.longSpeech.scenarios.find((s) => s.scenario === '210s-paused-long-dictation');
  const c210 = candidate.longSpeech.scenarios.find((s) => s.scenario === '210s-paused-long-dictation');

  return {
    dictionaryGateFalseBlockRateDeltaPp: Number(
      ((candidate.dictionaryGate.validMultiEditFalseBlockRate - baseline.dictionaryGate.validMultiEditFalseBlockRate) * 100).toFixed(1),
    ),
    dictionaryMatchingRecallDeltaPp: Number(
      ((candidate.dictionaryMatching.recall - baseline.dictionaryMatching.recall) * 100).toFixed(1),
    ),
    dictionaryMatchingTrapFprDeltaPp: Number(
      ((candidate.dictionaryMatching.trapFalsePositiveRate - baseline.dictionaryMatching.trapFalsePositiveRate) * 100).toFixed(1),
    ),
    silenceAccuracyDeltaPp: Number(
      ((candidate.acousticAndSpeaker.silenceAccuracy - baseline.acousticAndSpeaker.silenceAccuracy) * 100).toFixed(1),
    ),
    fanVoicedFalseRateDeltaPp: Number(
      ((candidate.acousticAndSpeaker.fanVoicedFalseChunkRate - baseline.acousticAndSpeaker.fanVoicedFalseChunkRate) * 100).toFixed(1),
    ),
    longSpeech90sRefineCharsDeltaPct: b90 && c90 && b90.refineTotalInputChars > 0
      ? Number((((c90.refineTotalInputChars - b90.refineTotalInputChars) / b90.refineTotalInputChars) * 100).toFixed(1))
      : 0,
    longSpeech150sTruncationEliminated: Boolean(b150?.refineTruncations > 0 && c150?.refineTruncations === 0),
    longSpeech210sSurvivalGained: Boolean(!b210?.survived && c210?.survived),
  };
}
