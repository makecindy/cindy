// renderer 不枚举具体值 —— 合法值完全由 maker capabilities 在运行时给出。
// renderer 只把 ID 当不透明 string 透传, 显示用 capabilities 里的 displayName。
// (类型别名保留是为了语义可读, 不是约束)
// 注:默认模型/档位偏好已全量本地化(newMakerDraft.lastByVendor 按 agent 分槽 +
// providerModelMemory 按 (agent, 模型) 全局记忆),服务端 UserPreferences 不再被消费。
export type Effort = string;
export type PermissionMode = string;
