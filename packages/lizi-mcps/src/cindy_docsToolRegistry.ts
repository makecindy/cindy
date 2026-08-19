/**
 * cindy_docsToolRegistry.ts
 * ---------------------------------------------------------------------------
 * 与 XdtHelperToolRegistry / SchedulerToolRegistry 同构:cindy_docs 的细粒度工具
 * 注册在这里,而不是直接挂到 McpServer 上。MCP server 只暴露 `list_tools` +
 * `call_tool` 两个入口工具,让六个文档工具的完整描述与 schema 不进系统提示,
 * 只在模型真的要做文档时才被拉取。
 *
 * Category 分三类:
 *  - 'author'  : 从结构化输入直接生成 Office 文件 (make_docx / make_pptx / make_xlsx)
 *  - 'convert' : 把已有内容转成 PDF (render_pdf / office_to_pdf)
 *  - 'read'    : 只读解析已有表格文件 (read_sheet)
 *
 * 拆成三类而不是一锅端,是因为模型的意图天然分这三种:「我有内容要出文件」、
 * 「我有文件要转格式」、「我要读表格里的数」。list_tools(category) 的结果越贴意图,
 * 选错工具的概率越低。
 */

import { z } from 'zod';

export type DocsToolCategory = 'author' | 'convert' | 'read';

export type DocsToolContentBlock = { type: 'text'; text: string };

export interface DocsToolResult {
  content: DocsToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type DocsToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<DocsToolResult>;

export interface DocsToolDef {
  name: string;
  category: DocsToolCategory;
  description: string;
  inputShape: z.ZodRawShape;
  handler: DocsToolHandler;
}

export interface DocsToolSummary {
  name: string;
  category: DocsToolCategory;
  description: string;
}

export class DocsToolRegistry {
  private readonly tools = new Map<string, DocsToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: DocsToolCategory;
    description: string;
    inputShape: T;
    handler: DocsToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[cindyDocsToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as DocsToolDef);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): DocsToolDef | undefined {
    return this.tools.get(name);
  }

  list(category?: DocsToolCategory): DocsToolSummary[] {
    const all: DocsToolSummary[] = [];
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      all.push({ name: t.name, category: t.category, description: t.description });
    }
    return all;
  }

  listCategories(): DocsToolCategory[] {
    const set = new Set<DocsToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<DocsToolResult> {
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

    // strict:未知字段直接判失败(而非默默剥掉)。与 xdt-helper registry 同口径——
    // 拼错字段若被静默忽略,模型会以为参数生效了,实际出来的文件跟它想的不一样。
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
