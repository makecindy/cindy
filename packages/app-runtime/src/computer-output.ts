import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/index.js';

export class ComputerOutputSchemaError extends Error {
  readonly code = 'DRIVER_OUTPUT_SCHEMA_MISMATCH';
  constructor(
    message: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = 'ComputerOutputSchemaError';
  }
}

/** Preserve explicit driver errors; validate successful results exactly once, without replay. */
export async function callComputerToolWithOutputValidation(
  client: Client,
  params: CallToolRequest['params'],
  validator: JsonSchemaValidator<unknown> | undefined,
  readOnly: boolean,
  signal?: AbortSignal,
) {
  if (!validator) return client.callTool(params, undefined, { signal });
  // SDK callTool validates structured error payloads against the success schema,
  // unlike its server implementation. Request still validates the MCP envelope.
  const result = await client.request({ method: 'tools/call', params }, CallToolResultSchema, {
    signal,
  });
  if (result.isError) return result;
  if (!result.structuredContent) {
    throw new ComputerOutputSchemaError(
      `Tool ${params.name} has an output schema but did not return structured content`,
      !readOnly,
    );
  }
  const validation = validator(result.structuredContent);
  if (!validation.valid) {
    throw new ComputerOutputSchemaError(
      `Structured content does not match the tool's output schema: ${validation.errorMessage}`,
      !readOnly,
    );
  }
  return result;
}
