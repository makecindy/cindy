/**
 * 用户级 system prompt 长度上限。
 *
 * 8000 chars ≈ 2k tokens —— 够写人格化指令、风格、禁用词，又不至于把 context 撑爆。
 * 前端 textarea 字数提示 + Save 按钮 over-limit 判断都用这个。
 *
 * 这里独立成一个 constants 文件而不是住在 userPreferences.types.ts 里 ——
 * 因为 userPrompt 不走服务端 UserPreferences 同步，归属不应混在一起。
 */
export const USER_PROMPT_MAX_LENGTH = 8000;
