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

  register<T extends z.ZodRawShape>(definition: {
    name: string;
    description: string;
    readOnly?: boolean;
    inputShape: T;
    handler: IOSSimulatorToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(definition.name)) {
      throw new Error(
        `[iosSimulatorToolRegistry] duplicate tool name: ${definition.name}`,
      );
    }
    this.tools.set(definition.name, {
      ...definition,
      readOnly: definition.readOnly === true,
    } as unknown as IOSSimulatorToolDefinition);
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
    const definition = this.tools.get(name);
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
          data: { tool: name, validation_errors: parsed.error.issues },
        },
        true,
      );
    }
    return definition.handler(parsed.data as Record<string, unknown>);
  }
}
