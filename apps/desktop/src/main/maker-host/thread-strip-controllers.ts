import { createThreadStripController } from '@cindy/anthropic-compat-proxy';

/**
 * 主动剥离 controller 单例。**每个剥离条件一个独立实例** —— 共用会交叉污染
 * (一个条件恢复会让另一个条件的 active-strip transform 误触发,详见 ThreadStripController)。
 */

// 加密推理 (encrypted_content) 主动剥离 —— 受 silentEncryptedRetry 设置 gate。
export const encryptedStripController = createThreadStripController();

// 缺 id 的 image generation 历史 item 主动剥离 —— always-on(只删上游已拒绝过的坏历史项)。
export const imageGenerationStripController = createThreadStripController();

// Responses 历史 message/reasoning item 不合规 id 前缀主动剥离(issue #4738: Gemini 历史
// 切 GPT 后 `chatcmpl-…_msg_0` 被 Responses 拒绝)—— always-on; 恢复一次后该 thread 发送前预洗。
export const responsesItemIdStripController = createThreadStripController();

// Responses 历史 item id 超长主动改写(issue #4227: Gateway/grok 历史的 `ws_…_call-…` 84 字符
// id 切 OpenAI 后被 64 上限拒绝)—— always-on; 恢复一次后该 thread 发送前预改写。
export const responsesItemIdLengthStripController = createThreadStripController();

// 空 thinking 块主动剥离 —— always-on(删空块零成本)。必须与上面是独立实例。
export const emptyThinkingStripController = createThreadStripController();

// 空 text 块主动剥离 —— always-on(bridge 修复前落进历史的 `{type:'text',text:''}`
// 空块,切回真 Anthropic 模型时 400)。必须与上面是独立实例。
export const emptyTextStripController = createThreadStripController();

// 空 assistant 消息主动剥离 —— always-on(moonshot/kimi 空 thinking 占位被中断
// 持久化后回放 400 "with role 'assistant' must not be empty")。必须与上面是独立实例。
export const emptyAssistantStripController = createThreadStripController();

// xAI ModelInput 422 主动剥离 —— always-on(Gateway / LiteLLM 中转 grok 时
// Codex 历史里的非 ModelInput item 会整包 422;恢复一次后该 thread 发送前预洗)。
export const xaiModelInputStripController = createThreadStripController();
