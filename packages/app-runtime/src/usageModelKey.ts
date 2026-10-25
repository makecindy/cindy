const CODEX_BILLING_MODEL_SUFFIX_RE = /#billing=(?:api|subscription)$/;
function displayModelName(model:string){return model.replace(CODEX_BILLING_MODEL_SUFFIX_RE,'');}
export function codexApiUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=api`;
}

export function codexSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

/** Claude 订阅轮的按模型记账 key(register.ts 消费)—— 与 codex 同一订阅标记后缀。 */
export function claudeSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

/** Pi 订阅轮与其它 agent 共用 billing 后缀，但保留独立 agentKind。 */
export function piSubscriptionUsageModelKey(model: string): string {
  return `${displayModelName(model)}#billing=subscription`;
}

