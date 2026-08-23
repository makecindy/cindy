import { z } from "zod";

import type {
  IOSSimulatorMcpErrorCode,
  IOSSimulatorToolAvailability,
} from "../types.js";

export type IOSSimulatorToolContentBlock = { type: "text"; text: string };

export interface IOSSimulatorToolResult {
  content: IOSSimulatorToolContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

export type IOSSimulatorToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<IOSSimulatorToolResult>;

interface IOSSimulatorToolDefinition {
  name: string;
  description: string;
  readOnly: boolean;
  inputShape: z.ZodRawShape;
  handler: IOSSimulatorToolHandler;
}

export function iosSimulatorTextResult(
  value: unknown,
  isError = false,
): IOSSimulatorToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function iosSimulatorBusinessError(
  errorCode: IOSSimulatorMcpErrorCode,
  message: string,
  data?: Record<string, unknown>,
): IOSSimulatorToolResult {
  return iosSimulatorTextResult(
    {
      ok: false,
      errorCode,
      data: { message, ...(data ?? {}) },
    },
    true,
  );
}

/** Progressive tool registry shared by Claude and Codex transports. */
export class IOSSimulatorToolRegistry {
  private readonly tools = new Map<string, IOSSimulatorToolDefinition>();
  /** Deprecated name → advertised name. Callable, never advertised. */
  private readonly deprecatedAliases = new Map<string, string>();

  register<T extends z.ZodRawShape>(definition: {
    name: string;
    description: string;
    readOnly?: boolean;
    inputShape: T;
    handler: IOSSimulatorToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
    /**
     * Superseded names that still resolve here. They keep a plugin or saved
     * prompt written against the old name working after a rename.
     */
    deprecatedAliases?: readonly string[];
  }): void {
    if (this.tools.has(definition.name)) {
      throw new Error(
        `[iosSimulatorToolRegistry] duplicate tool name: ${definition.name}`,
      );
    }
    for (const alias of definition.deprecatedAliases ?? []) {
      if (this.tools.has(alias) || this.deprecatedAliases.has(alias)) {
        throw new Error(
          `[iosSimulatorToolRegistry] duplicate tool alias: ${alias}`,
        );
      }
      this.deprecatedAliases.set(alias, definition.name);
    }
    this.tools.set(definition.name, {
      ...definition,
      readOnly: definition.readOnly === true,
    } as unknown as IOSSimulatorToolDefinition);
  }

  /** Advertised name for a requested name, resolving a deprecated alias. */
  resolveName(name: string): string {
    if (this.tools.has(name)) return name;
    return this.deprecatedAliases.get(name) ?? name;
  }

  list(
    availability: Record<string, IOSSimulatorToolAvailability> = {},
  ): Array<{
    name: string;
    description: string;
    readOnly: boolean;
    availability?: IOSSimulatorToolAvailability;
  }> {
    const hasAvailability = Object.keys(availability).length > 0;
    return Array.from(this.tools.values()).map(
      ({ name, description, readOnly }) => ({
        name,
        description,
        readOnly,
        ...(hasAvailability
          ? {
              availability:
                availability[name] ??
                ({
                  state: "unavailable",
                  reasonCode: "TOOL_NOT_REPORTED",
                } satisfies IOSSimulatorToolAvailability),
            }
          : {}),
      }),
    );
  }

  async call(name: string, rawArgs: unknown): Promise<IOSSimulatorToolResult> {
    const resolved = this.resolveName(name);
    const definition = this.tools.get(resolved);
    if (!definition) {
      return iosSimulatorTextResult(
        {
          ok: false,
          errorCode: "UNKNOWN_TOOL",
          data: { requested: name, available: Array.from(this.tools.keys()) },
        },
        true,
      );
    }
    const parsed = z
      .strictObject(definition.inputShape)
      .safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return iosSimulatorTextResult(
        {
          ok: false,
          errorCode: "INVALID_ARGS",
          data: { tool: resolved, validation_errors: parsed.error.issues },
        },
        true,
      );
    }
    return definition.handler(parsed.data as Record<string, unknown>);
  }
}
