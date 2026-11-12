import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { callComputerToolWithOutputValidation } from '../computer-output.js';

const outputSchema = {
  type: 'object' as const,
  properties: { windows: { type: 'array' as const } },
  required: ['windows'],
};
const validator = new AjvJsonSchemaValidator().getValidator(outputSchema);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function driver(result: CallToolResult) {
  const server = new Server(
    { name: 'driver-fixture', version: '1' },
    { capabilities: { tools: {} } },
  );
  const client = new Client({ name: 'cindy-test', version: '1' });
  const dispatch = vi.fn(() => result);
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'list_windows', inputSchema: { type: 'object' }, outputSchema }],
  }));
  server.setRequestHandler(CallToolRequestSchema, dispatch);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanup.push(
    () => client.close(),
    () => server.close(),
  );
  await client.listTools();
  return { client, dispatch };
}

describe('Computer Use driver output boundary (real MCP SDK)', () => {
  const refusal: CallToolResult = {
    isError: true,
    content: [{ type: 'text', text: 'AX window could not be resolved' }],
    structuredContent: { code: 'ax_window_unresolved', message: 'AX window could not be resolved' },
  };

  it('reproduces SDK masking of a structured error with a success schema', async () => {
    const { client } = await driver(refusal);
    await expect(client.callTool({ name: 'list_windows' })).rejects.toThrow(
      'Structured content does not match',
    );
  });

  it('preserves the original error envelope with exactly one dispatch', async () => {
    const { client, dispatch } = await driver(refusal);
    await expect(
      callComputerToolWithOutputValidation(client, { name: 'list_windows' }, validator, true),
    ).resolves.toEqual(refusal);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('still validates successful structured output', async () => {
    const success = { content: [], structuredContent: { windows: [] } };
    const { client, dispatch } = await driver(success);
    await expect(
      callComputerToolWithOutputValidation(client, { name: 'list_windows' }, validator, true),
    ).resolves.toEqual(success);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'rejects malformed success without replay (readOnly=%s)',
    async (readOnly) => {
      const { client, dispatch } = await driver({
        content: [],
        structuredContent: { unexpected: true },
      });
      await expect(
        callComputerToolWithOutputValidation(client, { name: 'list_windows' }, validator, readOnly),
      ).rejects.toMatchObject({
        code: 'DRIVER_OUTPUT_SCHEMA_MISMATCH',
        outcomeUnknown: !readOnly,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects missing success output without claiming an action failed to execute', async () => {
    const { client, dispatch } = await driver({ content: [] });
    await expect(
      callComputerToolWithOutputValidation(client, { name: 'list_windows' }, validator, false),
    ).rejects.toMatchObject({
      code: 'DRIVER_OUTPUT_SCHEMA_MISMATCH',
      outcomeUnknown: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
