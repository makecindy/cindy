import { randomUUID } from 'node:crypto';
import type { Maker } from '@cindy/maker-core';
import type { CustomMcpConfig } from '../../shared/customMcp.js';
import { callCloudManagement } from './managementCalls.js';
import {
  managementReadExecution,
  managementRecord,
  managementTextField,
} from './managementConnections.js';
import type {
  ManagementAction,
  ManagementCaller,
  ManagementEntry,
  ManagementExecution,
} from './management.js';

let memory:
  | Pick<Maker, 'listAvailableAgents' | 'getAgentMemoryStatus' | 'resetAgentMemory' | 'makerMemory'>
  | undefined;
export function configureCloudMemoryManagement(maker: NonNullable<typeof memory>): void {
  memory = maker;
}
export async function listMemoryManagement(caller: ManagementCaller): Promise<ManagementEntry[]> {
  caller.assertCurrent();
  if (!memory) return [];
  const maker = memory,
    entries: ManagementEntry[] = [];
  if (maker.makerMemory) {
    const manager = maker.makerMemory;
    entries.push({
      id: 'memory:cindy',
      label: 'Cindy Memory',
      status: 'available',
      actions: [
        {
          resource: 'memory:cindy',
          intent: 'reset',
          label: 'management.actions.reset',
          confirmation: 'management.confirm.reset',
          async run(_values, execution) {
            execution.assertCurrent();
            if (maker.makerMemory !== manager) throw new Error('MANAGEMENT_CHANGED');
            await manager.resetAll();
            execution.assertCurrent();
          },
        },
      ],
    });
  }
  for (const agent of maker.listAvailableAgents()) {
    try {
      await maker.getAgentMemoryStatus(agent);
    } catch {
      continue;
    }
    caller.assertCurrent();
    entries.push({
      id: `memory:${agent}`,
      label: agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Pi',
      status: 'available',
      actions: [
        {
          resource: `memory:${agent}`,
          intent: 'reset',
          label: 'management.actions.reset',
          confirmation: 'management.confirm.reset',
          async run(_values, execution) {
            execution.assertCurrent();
            await maker.resetAgentMemory(agent);
            execution.assertCurrent();
          },
        },
      ],
    });
  }
  return entries;
}

interface McpCredentials {
  has(id: string): boolean;
  set(id: string, value: string): void;
  remove(id: string): void;
}
let mcpCredentials: McpCredentials | undefined;
export function configureCloudMcpCredentials(api: McpCredentials): void {
  mcpCredentials = api;
}
export async function listMcpManagement(caller: ManagementCaller): Promise<ManagementEntry[]> {
  const read = managementReadExecution(caller);
  const raw = managementRecord(await callCloudManagement('maker:mcp:custom:list', [], read));
  if (!Array.isArray(raw.servers) || !mcpCredentials) throw new Error('MANAGEMENT_MCP_UNAVAILABLE');
  const credentials = mcpCredentials;
  const fields = (value?: CustomMcpConfig) => [
    { ...managementTextField('name', 'text', true, value?.name), maxLength: 60 },
    managementTextField('url', 'text', !value, value?.url),
    {
      ...managementTextField('transport', 'select', true, value?.transport ?? 'http'),
      options: [
        { value: 'http', label: 'HTTP' },
        { value: 'sse', label: 'SSE' },
      ],
    },
  ];
  const config = (values: Record<string, string>, before?: CustomMcpConfig): CustomMcpConfig => {
    const address = values.url?.trim() || before?.url;
    if (!address) throw new Error('MANAGEMENT_INVALID_INPUT');
    const url = new URL(address);
    if (
      address !== before?.url &&
      (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    )
      throw new Error('MANAGEMENT_INVALID_INPUT');
    return {
      id: before?.id ?? `mcp-${randomUUID().slice(0, 8)}`,
      name: values.name!.trim(),
      url: address,
      transport: values.transport as 'http' | 'sse',
      headers: before?.headers ?? {},
    };
  };
  const invoke = async (channel: string, args: unknown[], execution: ManagementExecution) => {
    const result = managementRecord(await callCloudManagement(channel, args, execution));
    execution.assertCurrent();
    if (result.ok !== true) throw new Error('MANAGEMENT_MCP_FAILED');
  };
  const entries: ManagementEntry[] = [
    {
      id: 'mcp:create',
      label: 'Add MCP',
      labelKey: 'management.addMcp',
      status: 'available',
      actions: [
        {
          resource: 'mcp:create',
          intent: 'create',
          label: 'management.actions.create',
          fields: fields(),
          async run(values, execution) {
            await invoke('maker:mcp:custom:create', [config(values)], execution);
          },
        },
      ],
    },
  ];
  for (const server of raw.servers as CustomMcpConfig[]) {
    const resource = `mcp:${server.id}`,
      hadToken = credentials.has(server.id);
    const check = async (execution: ManagementExecution) => {
      const fresh = managementRecord(
        await callCloudManagement('maker:mcp:custom:list', [], execution),
      );
      execution.assertCurrent();
      if (
        JSON.stringify(
          (fresh.servers as CustomMcpConfig[]).find((item) => item.id === server.id),
        ) !== JSON.stringify(server) ||
        credentials.has(server.id) !== hadToken
      )
        throw new Error('MANAGEMENT_CHANGED');
    };
    // Existing URLs can contain credentials. They stay on the Host; replacement is explicit.
    const url = new URL(server.url),
      safeUrl = !url.username && !url.password && !url.search && !url.hash;
    const actions: ManagementAction[] = [
      {
        resource,
        intent: 'edit',
        label: 'management.actions.edit',
        fields: fields({ ...server, url: safeUrl ? server.url : '' }),
        confirmation: 'management.mcpEndpointChange',
        async run(values, execution) {
          await check(execution);
          const next = config(values, server);
          // Prevent an existing bearer/header credential from being sent to a changed destination.
          if (next.url !== server.url && (hadToken || Object.keys(server.headers).length))
            throw new Error('MANAGEMENT_MCP_CLEAR_CREDENTIALS_FIRST');
          await invoke('maker:mcp:custom:update', [next], execution);
        },
      },
      {
        resource,
        intent: 'connect',
        label: 'management.setToken',
        fields: [managementTextField('bearerToken', 'password')],
        async run(values, execution) {
          await check(execution);
          credentials.set(server.id, values.bearerToken!);
          await invoke('maker:mcp:custom:refresh', [], execution);
        },
      },
    ];
    actions.push({
      resource,
      intent: 'edit',
      label: 'management.setHeader',
      fields: [managementTextField('headerName'), managementTextField('headerValue', 'password')],
      async run(values, execution) {
        await check(execution);
        const name = values.headerName!.trim();
        if (['__proto__', 'constructor', 'prototype'].includes(name))
          throw new Error('MANAGEMENT_INVALID_INPUT');
        await invoke(
          'maker:mcp:custom:update',
          [{ ...server, headers: { ...server.headers, [name]: values.headerValue! } }],
          execution,
        );
      },
    });
    if (Object.keys(server.headers).length)
      actions.push({
        resource,
        intent: 'edit',
        label: 'management.removeHeader',
        fields: [
          {
            ...managementTextField('headerName', 'select'),
            value: Object.keys(server.headers)[0],
            options: Object.keys(server.headers).map((name) => ({ value: name, label: name })),
          },
        ],
        async run(values, execution) {
          await check(execution);
          const headers = { ...server.headers };
          delete headers[values.headerName!];
          await invoke('maker:mcp:custom:update', [{ ...server, headers }], execution);
        },
      });
    if (hadToken)
      actions.push({
        resource,
        intent: 'disconnect',
        label: 'management.removeToken',
        confirmation: 'management.confirm.disconnect',
        async run(_values, execution) {
          await check(execution);
          credentials.remove(server.id);
          await invoke('maker:mcp:custom:refresh', [], execution);
        },
      });
    actions.push({
      resource,
      intent: 'delete',
      label: 'management.actions.delete',
      confirmation: 'management.confirm.delete',
      async run(_values, execution) {
        await check(execution);
        await invoke('maker:mcp:custom:delete', [server.id], execution);
        credentials.remove(server.id);
      },
    });
    entries.push({ id: resource, label: server.name, status: 'available', actions });
  }
  caller.assertCurrent();
  return entries;
}
