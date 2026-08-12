/**
 * classification 单点语义的行为锁。
 *
 * categorize / groupOf / groupModelsForDisplay 三组用例**原文移植**自
 * apps/desktop/src/renderer/__tests__/sourceSwitch.test.ts —— P1 期间 renderer 原实现暂留,
 * 两份实现由同一套用例锁定等价;P2 renderer 改 re-export 后原测试继续跑这份下沉实现。
 */

import { describe, expect, it } from 'vitest';

import {
  CHATGPT_MODEL_PREFIX,
  SUBSCRIPTION_DIRECT_MODEL_PREFIXES,
  XAI_MODEL_PREFIX,
  categorize,
  classifyModel,
  formatContextWindow,
  groupModelsForDisplay,
  groupOf,
  isAgentSelectableModel,
  isBudgetModel,
  isChatEligible,
  isModelSelectableForNewRoute,
  isSubscriptionDirectModel,
  modelBadges,
  type ModelCategory,
} from '../classification.js';

describe('isModelSelectableForNewRoute', () => {
  it('只允许未停用、未 retired 的 agent 对话模型进入新路由', () => {
    expect(isModelSelectableForNewRoute({ id: 'claude-opus-5' })).toBe(true);
    expect(isModelSelectableForNewRoute({ id: 'claude-opus-5', disabled: true })).toBe(false);
    expect(isModelSelectableForNewRoute({ id: 'claude-opus-5', status: 'retired' })).toBe(false);
    expect(isModelSelectableForNewRoute({ id: 'gpt-image-2', mode: 'image_generation' })).toBe(false);
    expect(
      isModelSelectableForNewRoute(
        { id: 'gpt-image-2', group: 'custom:mine' },
        { userProvider: true },
      ),
    ).toBe(true);
  });
});

// ── 原文移植: sourceSwitch.test.ts 的 categorize / groupOf / groupModelsForDisplay ──

describe('categorize', () => {
  it('按 id 前缀归类', () => {
    expect(categorize('claude-opus-4-8')).toBe('anthropic');
    expect(categorize('gpt-5.4')).toBe('gpt');
    expect(categorize('codex/gpt-5.4')).toBe('gpt-budget');
    expect(categorize('gemini-3-pro')).toBe('google');
    // 认不出厂商 → 中性兜底组(「中国」只由目录 group 产生,见下方专门用例)
    expect(categorize('moonshotai/kimi-k2')).toBe('ungrouped');
  });

  it('非对话类型先于厂商前缀判定(网关杂项模型按类型归组,不误入 gpt/google)', () => {
    expect(categorize('gpt-image-2')).toBe('image');
    expect(categorize('gemini-3-pro-image')).toBe('image');
    expect(categorize('voyage/voyage-context-4')).toBe('embedding');
    expect(categorize('doubao-seedance-2-0-260128')).toBe('video');
    expect(categorize('happyhorse-1.1-t2v')).toBe('video');
    expect(categorize('ai-gateway-doc')).toBe('compression');
  });

  it('订阅直连前缀归组: chatgpt/ → gpt,xai/ → grok', () => {
    expect(categorize(`${CHATGPT_MODEL_PREFIX}gpt-5.5`)).toBe('gpt');
    expect(categorize(`${XAI_MODEL_PREFIX}grok-4`)).toBe('grok');
  });

  it('x-ai/ 命名空间前缀(网关侧,与订阅直连 xai/ 是两回事)归 grok,不落 china(issue #882)', () => {
    expect(categorize('x-ai/grok-4.5')).toBe('grok');
  });

  it('gpt-realtime-* 归 realtime,不再落 gpt 聊天组(issue #882)', () => {
    expect(categorize('gpt-realtime-2')).toBe('realtime');
    expect(categorize('gpt-realtime-mini')).toBe('realtime');
    expect(categorize('gpt-realtime-translate')).toBe('realtime');
    expect(categorize('gemini-omni-flash-preview')).toBe('realtime');
  });

  it('gpt-4o-realtime-* 旧一代命名同样归 realtime(2026-07 review 回归:拆分时漏掉了这个前缀)', () => {
    expect(categorize('gpt-4o-realtime-preview-2024-12-17')).toBe('realtime');
    expect(categorize('gpt-4o-realtime-mini')).toBe('realtime');
  });

  it('语音转写/ASR 类归 stt,即使 id 里带 "realtime" 字样也不误入 realtime(issue #882)', () => {
    expect(categorize('gpt-4o-transcribe')).toBe('stt');
    expect(categorize('gpt-4o-mini-transcribe')).toBe('stt');
    expect(categorize('elevenlabs/scribe_v1')).toBe('stt');
    expect(categorize('elevenlabs/scribe_v1_experimental')).toBe('stt');
    expect(categorize('elevenlabs/scribe_v2')).toBe('stt');
    expect(categorize('gpt-realtime-whisper')).toBe('stt');
    expect(categorize('qwen3-asr-flash-realtime')).toBe('stt');
    expect(categorize('fun-asr-realtime-2026-02-28')).toBe('stt');
  });

  it('语音合成(TTS)归 tts,与同前缀的 elevenlabs STT 模型区分(issue #882)', () => {
    expect(categorize('elevenlabs/eleven_v3')).toBe('tts');
    expect(categorize('elevenlabs/eleven_multilingual_v2')).toBe('tts');
  });

  it('非 elevenlabs 前缀的通用语音合成关键词也归 tts(2026-07 review 回归:不能只认 elevenlabs)', () => {
    expect(categorize('gpt-4o-mini-tts')).toBe('tts');
    expect(categorize('qwen-tts')).toBe('tts');
    expect(categorize('some-vendor-speech-model')).toBe('tts');
  });

  it('带音频输入/输出但走 Chat Completions 的聊天模型不误判为 tts(2026-07 review:通用 "audio" 关键词太宽,会误伤真聊天模型)', () => {
    expect(categorize('gpt-4o-audio-preview')).toBe('gpt');
    expect(isChatEligible({ id: 'gpt-4o-audio-preview' })).toBe(true);
  });

  it('视频生成/编辑类归 video(issue #882)', () => {
    expect(categorize('doubao-seedance-2-0-fast-260128')).toBe('video');
    expect(categorize('happyhorse-1.1-i2v')).toBe('video');
    expect(categorize('happyhorse-1.1-r2v')).toBe('video');
    expect(categorize('happyhorse-1.0-video-edit')).toBe('video');
  });

  it('带视频理解能力但走 Chat Completions 的聊天模型不误判为 video(2026-07 review 第 23 轮:通用 "video" 关键词太宽,会误伤真聊天模型,同 audio 关键词收窄同理)', () => {
    expect(categorize('llava-hf/LLaVA-NeXT-Video-7B-hf')).not.toBe('video');
    expect(isChatEligible({ id: 'llava-hf/LLaVA-NeXT-Video-7B-hf' })).toBe(true);
  });

  it('Embedding 类归 embedding(issue #882)', () => {
    expect(categorize('text-embedding-3-large')).toBe('embedding');
    expect(categorize('text-embedding-3-small')).toBe('embedding');
    expect(categorize('gemini-embedding-2-preview')).toBe('embedding');
    expect(categorize('voyage/voyage-code-3')).toBe('embedding');
    expect(categorize('voyage/voyage-4-large')).toBe('embedding');
    expect(categorize('voyage/voyage-4')).toBe('embedding');
  });

  it('embed-*(Cohere,id 里没有 "embedding" 字样)同样归 embedding、不可聊天(2026-07 review 第 17 轮)', () => {
    expect(categorize('embed-english-v3.0')).toBe('embedding');
    expect(categorize('embed-multilingual-v3.0')).toBe('embedding');
    expect(isChatEligible({ id: 'embed-english-v3.0' })).toBe(false);
    expect(isChatEligible({ id: 'embed-multilingual-v3.0' })).toBe(false);
  });

  it('大小写混用的 id(自定义 OAuth 极简发现常见,如 Qwen/Qwen3-Embedding-8B)兜底判定不区分大小写(2026-07 review 第 20 轮)', () => {
    expect(categorize('Qwen/Qwen3-Embedding-8B')).toBe('embedding');
    expect(categorize('Qwen/Qwen3-Reranker-8B')).toBe('other');
    expect(categorize('DALL-E-3')).toBe('image');
    expect(isChatEligible({ id: 'Qwen/Qwen3-Embedding-8B' })).toBe(false);
    expect(isChatEligible({ id: 'Qwen/Qwen3-Reranker-8B' })).toBe(false);
  });

  it('图像生成类归 image(issue #882)', () => {
    expect(categorize('gemini-3.1-flash-image')).toBe('image');
    expect(categorize('gpt-image-1.5')).toBe('image');
  });

  it('id 里不含类型关键词的知名非聊天模型家族(dall-e / sora / veo)也不误判为可聊天(2026-07 review:走 {id,name} 极简发现的自定义 OAuth 供应商没有 mode/group 兜底,全靠这份正则)', () => {
    expect(categorize('dall-e-3')).toBe('image');
    expect(categorize('dall-e-2')).toBe('image');
    expect(categorize('sora-2')).toBe('video');
    expect(categorize('veo-3')).toBe('video');
    expect(isChatEligible({ id: 'dall-e-3' })).toBe(false);
    expect(isChatEligible({ id: 'sora-2' })).toBe(false);
    expect(isChatEligible({ id: 'veo-3' })).toBe(false);
  });

  it('同一批家族加了供应商命名空间前缀(如 openai/dall-e-3)时,锚定 id 开头的判定不漏网(2026-07 review 第 19 轮)', () => {
    expect(categorize('openai/dall-e-3')).toBe('image');
    expect(categorize('openai/sora-2')).toBe('video');
    expect(categorize('google/veo-3')).toBe('video');
    expect(isChatEligible({ id: 'openai/dall-e-3' })).toBe(false);
    expect(isChatEligible({ id: 'openai/sora-2' })).toBe(false);
    expect(isChatEligible({ id: 'google/veo-3' })).toBe(false);
  });

  it('realtime 与遗留 Completions 家族同样要兼容命名空间前缀(如 openai/gpt-realtime-preview、openai/babbage-002,2026-07 review 第 21 轮)', () => {
    expect(categorize('openai/gpt-realtime-preview')).toBe('realtime');
    expect(categorize('openai/gpt-4o-realtime-preview')).toBe('realtime');
    expect(categorize('openai/babbage-002')).toBe('other');
    expect(isChatEligible({ id: 'openai/gpt-realtime-preview' })).toBe(false);
    expect(isChatEligible({ id: 'openai/babbage-002' })).toBe(false);
  });

  it('embed- 前缀家族同样要兼容命名空间前缀(如 cohere/embed-english-v3.0,2026-07 review 第 22 轮)', () => {
    expect(categorize('cohere/embed-english-v3.0')).toBe('embedding');
    expect(isChatEligible({ id: 'cohere/embed-english-v3.0' })).toBe(false);
  });

  it('嵌套多层命名空间(如 gateway/openai/dall-e-3)同样不漏网:stripNamespace 取最后一段而非只剥一层(2026-07 review 第 24 轮)', () => {
    expect(categorize('gateway/openai/dall-e-3')).toBe('image');
    expect(categorize('gateway/openai/sora-2')).toBe('video');
    expect(categorize('org/cohere/embed-english-v3.0')).toBe('embedding');
    expect(categorize('gateway/openai/gpt-4o-realtime-preview')).toBe('realtime');
    expect(categorize('gateway/openai/babbage-002')).toBe('other');
    expect(isChatEligible({ id: 'gateway/openai/dall-e-3' })).toBe(false);
    expect(isChatEligible({ id: 'org/cohere/embed-english-v3.0' })).toBe(false);
  });

  it('moderation 模型不落进厂商兜底组、不被判定为可聊天(2026-07 review:fresh evidence,不是issue 列出的语义类型之一,落 other 保留)', () => {
    expect(categorize('omni-moderation-latest')).toBe('other');
    expect(categorize('text-moderation-latest')).toBe('other');
    expect(isChatEligible({ id: 'omni-moderation-latest' })).toBe(false);
    expect(isChatEligible({ id: 'text-moderation-latest' })).toBe(false);
  });

  it('遗留 Completions 端点与 Rerank 端点不落进厂商兜底组、不被判定为可聊天(2026-07 review 第 15 轮)', () => {
    expect(categorize('babbage-002')).toBe('other');
    expect(categorize('davinci-002')).toBe('other');
    expect(categorize('gpt-3.5-turbo-instruct')).toBe('other');
    expect(categorize('text-davinci-003')).toBe('other');
    expect(categorize('code-davinci-002')).toBe('other');
    expect(categorize('rerank-v3.5')).toBe('other');
    expect(categorize('rerank-english-v3.0')).toBe('other');
    expect(isChatEligible({ id: 'babbage-002' })).toBe(false);
    expect(isChatEligible({ id: 'davinci-002' })).toBe(false);
    expect(isChatEligible({ id: 'rerank-v3.5' })).toBe(false);
  });

  it('"-instruct" 结尾的正常聊天模型不受遗留 Completions 排除规则误杀(2026-07 review 第 15 轮:避免宽泛后缀误伤开源 instruct 模型)', () => {
    expect(categorize('qwen2.5-72b-instruct')).not.toBe('other');
    expect(categorize('llama-3-70b-instruct')).not.toBe('other');
    expect(isChatEligible({ id: 'qwen2.5-72b-instruct' })).toBe(true);
    expect(isChatEligible({ id: 'llama-3-70b-instruct' })).toBe(true);
  });

  it('认不出厂商的对话模型落中性兜底组 ungrouped,不再被标成「中国」(2026-08)', () => {
    // 兜底改中性前,这批全部落 china —— 分组名是用户直接看见的断言,认不出产地就不该断言。
    expect(categorize('mistral-large-latest')).toBe('ungrouped');
    expect(categorize('llama-3-70b-instruct')).toBe('ungrouped');
    expect(categorize('command-r-plus')).toBe('ungrouped');
    expect(categorize('gemma-3-27b')).toBe('ungrouped'); // Google 出品但不是 gemini- 前缀
    expect(categorize('sonar-pro')).toBe('ungrouped');
    expect(categorize('nova-pro')).toBe('ungrouped');
    // o 系列与 chatgpt-4o-latest 语义上属 OpenAI,但现有前缀规则(gpt- / chatgpt/)认不出,
    // 落中性组是**当前**行为;要归 gpt 需要单独补前缀规则,这里先把现状锁住,避免回归成 china。
    expect(categorize('o3')).toBe('ungrouped');
    expect(categorize('o4-mini')).toBe('ungrouped');
    expect(categorize('chatgpt-4o-latest')).toBe('ungrouped');
    expect(categorize('openai/o3')).toBe('ungrouped');
  });

  it('目录里存量的 group:"other" 仍按旧含义(非对话端点)解读 —— 改名不得单端翻转 wire 语义', () => {
    // 改名前 `other` = 「不能对话的其它端点」。若按新含义(认不出厂商的对话模型)解读,
    // seedream-5 这类 id 不含任何类型关键词、只能靠 group 判定的合成模型会从"硬拒"
    // 变成"可选"(docs/dev-rules/protocol-compatibility.md §1:禁止单端改既有字段语义)。
    expect(groupOf({ id: 'seedream-5', group: 'other' })).toBe('other');
    expect(classifyModel({ id: 'seedream-5', group: 'other' })).toBe('other');
    expect(isChatEligible({ id: 'seedream-5', group: 'other' })).toBe(false);
    expect(isAgentSelectableModel({ id: 'seedream-5', group: 'other' })).toBe(false);
    // 本地 categorize 算出的 `ungrouped` 是独立的新分类,兜底组照常可选。
    expect(categorize('seedream-5')).toBe('ungrouped');
    expect(isChatEligible({ id: 'mistral-large-latest' })).toBe(true);
  });

  it('兜底组仍是对话厂商组:认不出厂商 ≠ 不能对话,不得从 availableModels 消失(2026-08 回归锁)', () => {
    expect(isChatEligible({ id: 'mistral-large-latest' })).toBe(true);
    expect(isChatEligible({ id: 'o3' })).toBe(true);
    expect(isChatEligible({ id: 'some-brand-new-vendor-model' })).toBe(true);
    // 反向:group 显式声明非对话端点时照旧硬拒(方向不对称,见 isChatEligible 注释)。
    expect(isChatEligible({ id: 'some-brand-new-vendor-model', group: 'other' })).toBe(false);
  });

  it('「中国」只认目录下发的 group,客户端不猜产地(2026-08 定案)', () => {
    // 目录标了就进中国(这是「中国」组唯一的来源)。
    expect(classifyModel({ id: 'qwen/qwen3.7-max', group: 'china' })).toBe('china');
    expect(classifyModel({ id: 'z-ai/glm-5.1', group: 'china', mode: 'chat' })).toBe('china');
    // 同一批 id 在**没有** group 时不再被猜成中国来源 —— 产地不是 id 能可靠推断的属性,
    // 猜错等于把别家模型挂到「中国」下面;落中性组由服务端补 group 归位。
    expect(categorize('qwen/qwen3.7-max')).toBe('ungrouped');
    expect(categorize('z-ai/glm-5.1')).toBe('ungrouped');
    expect(categorize('deepseek/deepseek-v4-pro')).toBe('ungrouped');
    expect(categorize('moonshotai/kimi-k2.6')).toBe('ungrouped');
    expect(categorize('doubao-1.8-pro')).toBe('ungrouped');
    // 未标 group 也照旧可选,不会从 availableModels 消失。
    expect(isChatEligible({ id: 'qwen/qwen3.7-max' })).toBe(true);
  });

  it('主厂商前缀认命名空间形态:目录 id 本来就带命名空间,缺 group 时不该整批掉进兜底组', () => {
    // catalog/model-registry.json 里的 id 形态就是这样(2026-08 实测 45 条全部带命名空间)。
    expect(categorize('anthropic/claude-opus-5')).toBe('anthropic');
    expect(categorize('openai/gpt-5.5')).toBe('gpt');
    expect(categorize('openai/gpt-5.4-mini')).toBe('gpt');
    expect(categorize('google/gemini-3.5-flash')).toBe('google');
    expect(categorize('gateway/anthropic/claude-sonnet-5')).toBe('anthropic'); // 多层同样取尾段
    // 折扣路由不能被"认尾段"的 gpt 规则抢走:codex/gpt-5.4 的尾段就是 gpt-5.4。
    expect(categorize('codex/gpt-5.4')).toBe('gpt-budget');
    expect(categorize('codex/gpt-5.6-sol')).toBe('gpt-budget');
    // xd/codex-gpt-* 的尾段是 codex-gpt-*,不以 gpt- 开头,同样不落 gpt 组。
    expect(categorize('xd/codex-gpt-5.5')).not.toBe('gpt');
    expect(groupOf({ id: 'xd/codex-gpt-5.5', group: 'gpt-budget' })).toBe('gpt-budget');
  });

  it('非对话类型判定优先于兜底:qwen 家族的语音/向量/重排端点各归其类,不落对话兜底组', () => {
    expect(categorize('qwen-tts')).toBe('tts');
    expect(categorize('qwen3-asr-flash-realtime')).toBe('stt');
    expect(categorize('Qwen/Qwen3-Embedding-8B')).toBe('embedding');
    expect(categorize('Qwen/Qwen3-Reranker-8B')).toBe('other');
    expect(isChatEligible({ id: 'qwen-tts' })).toBe(false);
  });
});

describe('groupOf — 数据优先,前缀兜底', () => {
  it('合法 group 字段优先于 id 前缀', () => {
    // id 看着像 gpt,但目录把它归到 china → 以 group 为准
    expect(groupOf({ id: 'gpt-weird', group: 'china' })).toBe('china');
    expect(groupOf({ id: 'codex/gpt-5.5', group: 'gpt-budget' })).toBe('gpt-budget');
  });
  it('无 group / 未知 group → 回退 categorize', () => {
    expect(groupOf({ id: 'claude-opus-4-8' })).toBe('anthropic');
    expect(groupOf({ id: 'gemini-3-flash' })).toBe('google');
    expect(groupOf({ id: 'gpt-5.5', group: 'mistral' })).toBe('gpt'); // 未知 group 忽略,按前缀
  });
});

describe('classifyModel — mode 权威,缺省时回退 groupOf(issue #882)', () => {
  const NON_CHAT_MODE_CASES: Array<{ id: string; mode: string; category: ModelCategory }> = [
    { id: 'gemini-3.1-flash-image', mode: 'image_generation', category: 'image' },
    { id: 'gemini-3-pro-image', mode: 'image_generation', category: 'image' },
    { id: 'gpt-image-1.5', mode: 'image_generation', category: 'image' },
    { id: 'gpt-image-2', mode: 'image_generation', category: 'image' },
    { id: 'text-embedding-3-large', mode: 'embedding', category: 'embedding' },
    { id: 'text-embedding-3-small', mode: 'embedding', category: 'embedding' },
    { id: 'gemini-embedding-2-preview', mode: 'embedding', category: 'embedding' },
    { id: 'voyage/voyage-code-3', mode: 'embedding', category: 'embedding' },
    { id: 'voyage/voyage-4-large', mode: 'embedding', category: 'embedding' },
    { id: 'voyage/voyage-4', mode: 'embedding', category: 'embedding' },
    { id: 'voyage/voyage-context-4', mode: 'embedding', category: 'embedding' },
    { id: 'elevenlabs/eleven_v3', mode: 'audio_speech', category: 'tts' },
    { id: 'elevenlabs/eleven_multilingual_v2', mode: 'audio_speech', category: 'tts' },
    { id: 'gpt-4o-transcribe', mode: 'audio_transcription', category: 'stt' },
    { id: 'gpt-4o-mini-transcribe', mode: 'audio_transcription', category: 'stt' },
    { id: 'elevenlabs/scribe_v1', mode: 'audio_transcription', category: 'stt' },
    { id: 'elevenlabs/scribe_v1_experimental', mode: 'audio_transcription', category: 'stt' },
    { id: 'elevenlabs/scribe_v2', mode: 'audio_transcription', category: 'stt' },
    { id: 'gpt-realtime-whisper', mode: 'audio_transcription', category: 'stt' },
    { id: 'qwen3-asr-flash-realtime', mode: 'audio_transcription', category: 'stt' },
    { id: 'fun-asr-realtime-2026-02-28', mode: 'audio_transcription', category: 'stt' },
    { id: 'gpt-realtime-2', mode: 'realtime', category: 'realtime' },
    { id: 'gpt-realtime-mini', mode: 'realtime', category: 'realtime' },
    { id: 'gpt-realtime-translate', mode: 'realtime', category: 'realtime' },
    { id: 'gemini-omni-flash-preview', mode: 'realtime', category: 'realtime' },
    { id: 'doubao-seedance-2-0-260128', mode: 'video_generation', category: 'video' },
    { id: 'doubao-seedance-2-0-fast-260128', mode: 'video_generation', category: 'video' },
    { id: 'happyhorse-1.1-t2v', mode: 'video_generation', category: 'video' },
    { id: 'happyhorse-1.1-i2v', mode: 'video_generation', category: 'video' },
    { id: 'happyhorse-1.1-r2v', mode: 'video_generation', category: 'video' },
    { id: 'happyhorse-1.0-video-edit', mode: 'video_generation', category: 'video' },
  ];

  it.each(NON_CHAT_MODE_CASES)(
    '$id: mode=$mode 权威判定为 $category,忽略 id 正则',
    ({ id, mode, category }) => {
      expect(classifyModel({ id, mode })).toBe(category);
    },
  );

  it('未识别的 mode 值不静默丢弃,落 other(issue #882 第 5 点:无损保留新类型)', () => {
    expect(classifyModel({ id: 'ai-gateway-doc', mode: 'doc_rerank' })).toBe('other');
    expect(classifyModel({ id: 'some-future-model', mode: 'brand-new-capability' })).toBe('other');
  });

  it('mode 缺省时回退 groupOf/categorize(旧缓存兜底,同 issue 点名的具体 bug 修复)', () => {
    expect(classifyModel({ id: 'gpt-realtime-2' })).toBe('realtime');
    expect(classifyModel({ id: 'x-ai/grok-4.5' })).toBe('grok');
    expect(classifyModel({ id: 'ai-gateway-doc' })).toBe('compression');
  });

  it("mode='chat' 只确认是聊天模型,厂商分组仍由 group/id 决定(两层判断独立)", () => {
    expect(classifyModel({ id: 'claude-opus-4-8', mode: 'chat' })).toBe('anthropic');
    expect(classifyModel({ id: 'x-ai/grok-4.5', mode: 'chat' })).toBe('grok');
    expect(classifyModel({ id: 'gpt-weird', group: 'china', mode: 'chat' })).toBe('china');
  });

  it("mode='responses' 与 'chat' 同为聊天可用取值(2026-07 review 第 16 轮:Codex 走 Responses API,不是非聊天端点)", () => {
    expect(classifyModel({ id: 'codex/gpt-5.5', mode: 'responses' })).toBe('gpt-budget');
    expect(classifyModel({ id: 'gpt-5.5', mode: 'responses' })).toBe('gpt');
  });
});

describe('isChatEligible — 决定能否进 Agent availableModels(issue #882 第 3 点)', () => {
  it('mode 权威判定为非 chat 的所有类型模型均不可进 availableModels', () => {
    const nonChatIds = [
      'gemini-3.1-flash-image',
      'gpt-image-2',
      'text-embedding-3-large',
      'voyage/voyage-4',
      'elevenlabs/eleven_v3',
      'elevenlabs/scribe_v2',
      'gpt-4o-transcribe',
      'qwen3-asr-flash-realtime',
      'gpt-realtime-2',
      'gemini-omni-flash-preview',
      'doubao-seedance-2-0-260128',
      'happyhorse-1.1-t2v',
    ];
    for (const id of nonChatIds) {
      expect(isChatEligible({ id, mode: 'embedding' })).toBe(false); // 任意非 chat mode 皆不可用
    }
    expect(isChatEligible({ id: 'ai-gateway-doc', mode: 'doc_rerank' })).toBe(false);
  });

  it('mode 缺省时按修正后的 categorize 兜底判定 —— 同样排除这些具体模型', () => {
    for (const id of [
      'gpt-realtime-2',
      'gpt-realtime-mini',
      'gpt-realtime-translate',
      'gemini-omni-flash-preview',
      'text-embedding-3-large',
      'ai-gateway-doc',
      'elevenlabs/eleven_v3',
      'elevenlabs/scribe_v2',
      'gpt-4o-transcribe',
      'doubao-seedance-2-0-260128',
    ]) {
      expect(isChatEligible({ id })).toBe(false);
    }
  });

  it('聊天模型(含 mode 缺省的网关旧数据)仍判定为可用 —— 回归锁,不能因这次改动消失', () => {
    expect(isChatEligible({ id: 'claude-opus-4-8' })).toBe(true);
    expect(isChatEligible({ id: 'gpt-5.5' })).toBe(true);
    expect(isChatEligible({ id: 'x-ai/grok-4.5' })).toBe(true); // 无 mode 时按修正后的 grok 分组,可用
    expect(isChatEligible({ id: 'moonshotai/kimi-k2' })).toBe(true); // ungrouped 兜底组
    expect(isChatEligible({ id: 'some-gateway-chat-model', mode: 'chat' })).toBe(true);
  });

  it("mode='responses' 判定为可用(2026-07 review 第 16 轮:Codex 原生走 Responses API 的语言模型,不是非聊天端点)", () => {
    expect(isChatEligible({ id: 'codex/gpt-5.5', mode: 'responses' })).toBe(true);
    expect(isChatEligible({ id: 'gpt-5.5', mode: 'responses' })).toBe(true);
  });

  it('mode 缺省时不采信 group 品牌标注,只按 id 能力正则判定(2026-07 review)', () => {
    // group 是展示分组/品牌,不是能力类型(issue #882 明确要求两者独立)——网关完全可能把
    // 图像模型的 group 品牌标成 'gpt'(归到 GPT 家族方便浏览),这不代表它能聊天。
    // groupOf({id:'gpt-image-2', group:'gpt'}) 会信 group 返回 'gpt'(展示分组语义没错),
    // 但 isChatEligible 必须不受骗:categorize('gpt-image-2') 正确识别为 image,判定不可用。
    expect(isChatEligible({ id: 'gpt-image-2', group: 'gpt' })).toBe(false);
    expect(isChatEligible({ id: 'text-embedding-3-large', group: 'china' })).toBe(false);
    // 对照组:group 品牌标注和 id 能力判定一致时,不受影响。
    expect(isChatEligible({ id: 'gpt-5.5', group: 'gpt' })).toBe(true);
  });
});

describe('groupModelsForDisplay — sortOrder 升序 + group 分桶 + 桶序按最小 sortOrder', () => {
  it('按 sortOrder 排序并分桶,桶序 = 桶内首个出现序', () => {
    const out = groupModelsForDisplay([
      { id: 'qwen/q', group: 'china', sortOrder: 40 },
      { id: 'gpt-5.5', group: 'gpt', sortOrder: 20 },
      { id: 'codex/gpt-5.5', group: 'gpt-budget', sortOrder: 10 },
      { id: 'claude-opus-4-8', group: 'anthropic', sortOrder: 0 },
      { id: 'gpt-5.4', group: 'gpt', sortOrder: 21 },
    ]);
    // 桶序:anthropic(0) → gpt-budget(10) → gpt(20) → china(40)
    expect(out.map((g) => g.category)).toEqual(['anthropic', 'gpt-budget', 'gpt', 'china']);
    // gpt 桶内按 sortOrder:5.5(20) 在 5.4(21) 前
    expect(out.find((g) => g.category === 'gpt')!.models.map((m) => m.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });

  it('缺 sortOrder 的排末尾;group 缺省回退前缀', () => {
    const out = groupModelsForDisplay([
      { id: 'gpt-5.5', sortOrder: 20 }, // 无 group → 前缀 gpt
      { id: 'claude-opus-4-8' }, // 无 group 无 sortOrder → anthropic,排末尾
    ]);
    expect(out.map((g) => g.category)).toEqual(['gpt', 'anthropic']);
  });
});

// ── 新增语义 ─────────────────────────────────────────────────────────────────

describe('isSubscriptionDirectModel(下沉自 shared/subscriptionModels,签名一致)', () => {
  it('前缀命中', () => {
    expect(isSubscriptionDirectModel('chatgpt/gpt-5.5')).toBe(true);
    expect(isSubscriptionDirectModel('xai/grok-4')).toBe(true);
    expect(isSubscriptionDirectModel('gpt-5.5')).toBe(false);
  });
  it('null / undefined / 空串 → false(历史签名)', () => {
    expect(isSubscriptionDirectModel(null)).toBe(false);
    expect(isSubscriptionDirectModel(undefined)).toBe(false);
    expect(isSubscriptionDirectModel('')).toBe(false);
  });
  it('前缀清单恒为 chatgpt/ + xai/(路由/记账/排除三方共用,改动即破坏)', () => {
    expect(SUBSCRIPTION_DIRECT_MODEL_PREFIXES).toEqual(['chatgpt/', 'xai/']);
  });
});

describe('isBudgetModel — 目录 group 优先,codex/ 前缀兜底', () => {
  it('group 标注优先(网关新数据)', () => {
    expect(isBudgetModel({ id: 'whatever', group: 'gpt-budget' })).toBe(true);
  });
  it('无 group 时按前缀(网关旧数据)', () => {
    expect(isBudgetModel({ id: 'codex/gpt-5.5' })).toBe(true);
    expect(isBudgetModel({ id: 'gpt-5.5' })).toBe(false);
  });
  // 与 groupOf 同一「数据优先」契约(2026-07 Greptile review):目录显式给出合法的
  // 非 budget 分组时,前缀不再 override —— 否则徽章显示 budget、分组却归非 budget,自相矛盾。
  it('codex/ 前缀 + 合法非 budget 分组 → 尊重目录,不打 budget 徽章', () => {
    expect(isBudgetModel({ id: 'codex/gpt-5.5', group: 'gpt' })).toBe(false);
  });
  it('codex/ 前缀 + 未知 group 值 → 视同缺失,前缀兜底(与 groupOf 的未知回退一致)', () => {
    expect(isBudgetModel({ id: 'codex/gpt-5.5', group: 'not-a-category' })).toBe(true);
  });
});

describe('modelBadges — 徽章唯一口径', () => {
  it('分段模式: 用段 provider 的 access', () => {
    expect(
      modelBadges({ id: 'claude-opus-5' }, { access: { kind: 'subscription', product: 'Claude.ai' } }),
    ).toEqual({ subscription: true, budget: false });
  });

  it('flat 模式: provider 缺失时读条目 sourceAccess(真实溯源,标签不再消失)', () => {
    expect(
      modelBadges(
        { id: 'claude-opus-5', sourceAccess: { kind: 'subscription', product: 'Claude.ai' } },
        null,
      ),
    ).toEqual({ subscription: true, budget: false });
  });

  it('两者都拿不到(device-link 旧被控端拍平清单)→ 不显示,诚实降级', () => {
    expect(modelBadges({ id: 'claude-opus-5' }, null)).toEqual({
      subscription: false,
      budget: false,
    });
  });

  // 2026-07 Copilot review: 分段模式下段供应商无 access 元数据时,不得回读条目的
  // sourceAccess(那可能是 flat 首见的**另一家**供应商)——否则当前段的行会挂上别家的订阅徽章。
  it('分段模式: provider 无 access 时不回读 sourceAccess,徽章按当前段诚实为空', () => {
    expect(
      modelBadges(
        { id: 'claude-opus-5', sourceAccess: { kind: 'subscription', product: 'Claude.ai' } },
        {},
      ),
    ).toEqual({ subscription: false, budget: false });
  });

  it('骨折徽章与订阅徽章独立判定', () => {
    expect(modelBadges({ id: 'codex/gpt-5.5' }, { access: { kind: 'managed' } })).toEqual({
      subscription: false,
      budget: true,
    });
  });
});

describe('formatContextWindow(下沉自 ModelSelector,输出逐字一致)', () => {
  it('M 档: 整数不带小数,非整取 1 位', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_500_000)).toBe('1.5M');
  });
  it('K 档: 整数不带小数,非整四舍五入取整', () => {
    expect(formatContextWindow(272_000)).toBe('272K');
    expect(formatContextWindow(200_000)).toBe('200K');
    expect(formatContextWindow(8_192)).toBe('8K');
  });
  it('<1000 原样', () => {
    expect(formatContextWindow(512)).toBe('512');
  });
});
