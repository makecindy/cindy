/**
 * 右侧栏 tab 持久化上限 —— main(权威校验)与 renderer(写入前预检)共用同一常量,
 * 避免跨进程两份定义漂移。单行 tab state JSON 序列化字节上限。
 */
export const MAX_STATE_JSON_BYTES = 16 * 1024;
