/**
 * cindy_feishuBotToolRegistry.ts
 * ---------------------------------------------------------------------------
 * Mirrors the art tool registry —— 把细粒度的 feishu-bot 工具从 MCP server
 * 自身剥离,只暴露 `cindy_feishu_bot_list_tools` + `cindy_feishu_bot_call_tool`
 * 两个入口,省 Agent 上下文。
 *
 * INVALID_ARGS 时把目标工具的 JSON Schema 一并回吐,模型可以一轮自纠。
 */

import { z } from 'zod';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * 类目。当前只有 `bot`(bot↔user 通道相关),保留 slot 是为了将来加诸如
 * `chat_meta`(改 chat 标题/欢迎语)、`reaction`(给消息打表情)等家族时
 * 不用动 registry shape。
 */
export type FeishuBotToolCategory = 'bot';

export type FeishuBotToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface FeishuBotToolResult {
  content: FeishuBotToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type FeishuBotToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<FeishuBotToolResult>;

export interface FeishuBotToolDef {
  name: string;
  category: FeishuBotToolCategory;
  description: string;
  /**
   * 共享 rule 文档的 key。registry 只存 key,markdown 真身在并行的 rules map,
   * `cindy_feishu_bot_list_tools` 时按 category 一次性 bundle 进顶层 `rules`,
   * 不在每个工具描述里复读。
   */
  rules?: string[];
  inputShape: z.ZodRawShape;
  handler: FeishuBotToolHandler;
}

export interface FeishuBotToolSummary {
  name: string;
  category: FeishuBotToolCategory;
  description: string;
  rules?: string[];
}

// ── Registry ────────────────────────────────────────────────────────────────

export class FeishuBotToolRegistry {
  private readonly tools = new Map<string, FeishuBotToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: FeishuBotToolCategory;
    description: string;
    rules?: string[];
    inputShape: T;
    handler: FeishuBotToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[cindy_feishuBotToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as FeishuBotToolDef);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): FeishuBotToolDef | undefined {
    return this.tools.get(name);
  }

  list(category?: FeishuBotToolCategory): FeishuBotToolSummary[] {
    const all: FeishuBotToolSummary[] = [];
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      all.push({
        name: t.name,
        category: t.category,
        description: t.description,
        ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
      });
    }
    return all;
  }

  collectRuleKeys(category?: FeishuBotToolCategory): string[] {
    const set = new Set<string>();
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      for (const k of t.rules ?? []) set.add(k);
    }
    return Array.from(set);
  }

  listCategories(): FeishuBotToolCategory[] {
    const set = new Set<FeishuBotToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<FeishuBotToolResult> {
    const def = this.tools.get(name);
    if (!def) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              errorCode: 'UNKNOWN_TOOL',
              data: {
                requested: name,
                available: Array.from(this.tools.keys()),
                hint: '调用 list_tools 查看完整工具列表',
              },
            }),
          },
        ],
        isError: true,
      };
    }

    // strict:未知字段直接判失败(而非默默剥掉)。否则 agent 传了拼错 / 不支持的字段会
    // "返回成功、实际忽略",误导其以为生效(典型:camelCase 写成 sessionIds 而非 session_ids)。
    // 失败分支已带 schema + hint,agent 可据此自纠重试。
    const objSchema = z.strictObject(def.inputShape);
    const parsed = objSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      let jsonSchema: unknown;
      try {
        jsonSchema = z.toJSONSchema(objSchema);
      } catch {
        jsonSchema = '<schema serialization failed>';
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              errorCode: 'INVALID_ARGS',
              data: {
                tool: name,
                // received: 回显收到的顶层 keys — 只回 schema 时模型看不出自己是多包了一层信封
                // (keys=["args"]) 还是拍平了 (keys=参数字段), 实测 2026-10-31 三个会话因此连续盲试。
                received: rawArgs && typeof rawArgs === 'object'
                  ? Object.keys(rawArgs as Record<string, unknown>)
                  : [],
                validation_errors: parsed.error.issues,
                schema: jsonSchema,
                hint: '请按 schema 修正参数后重试',
              },
            }),
          },
        ],
        isError: true,
      };
    }

    return def.handler(parsed.data as Record<string, unknown>);
  }
}
