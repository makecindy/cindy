import type {
  ManagementCommand,
  ManagementItem,
  ManagementResult,
} from '../../../shared/settingsManagement';
interface TrialServer {
  id: string;
  name: string;
  url: string;
  token: boolean;
  transport: string;
  headers: string[];
}
/** In-memory preview: retain presence and header names only, never the entered credential. */
export function createTrialMcpAuthorization() {
  const servers: TrialServer[] = [
    {
      id: 'mcp:docs',
      name: 'Documentation',
      url: 'https://example.com/mcp',
      token: true,
      transport: 'http',
      headers: ['X-API-Key'],
    },
    {
      id: 'mcp:tools',
      name: 'Team Tools',
      url: 'https://example.com/sse',
      token: false,
      transport: 'sse',
      headers: [] as string[],
    },
  ];
  const tickets = new Map<string, { server?: TrialServer; label: string }>();
  const operations = new Map<string, ManagementResult>();
  const action = (
    server: TrialServer | undefined,
    label: string,
    fields: ManagementItem['actions'][number]['fields'],
    intent: ManagementItem['actions'][number]['intent'] = 'edit',
  ) => {
    const id = crypto.randomUUID();
    tickets.set(id, { server, label });
    return {
      id,
      label,
      fields,
      intent,
      expiresAt: Date.now() + 300000,
      ...(label === 'management.removeToken'
        ? { confirmation: 'management.confirm.disconnect' }
        : label === 'management.actions.delete'
          ? { confirmation: 'management.confirm.delete' }
          : {}),
    };
  };
  const fields = (server?: TrialServer) =>
    (['name', 'url', 'transport'] as const).map((key) => ({
      name: key,
      label: key,
      kind: 'text' as const,
      required: key !== 'url' || !server,
      maxLength: 512,
      ...(server ? { value: server[key] } : {}),
    }));
  const finish = (operationId: string, phase: 'succeeded' | 'failed') => {
    const result: ManagementResult = { kind: 'operation', operationId, phase };
    operations.set(operationId, result);
    return result;
  };
  return {
    owns(command: ManagementCommand) {
      return command.operation === 'list'
        ? command.section === 'mcp'
        : command.operation === 'run'
          ? tickets.has(command.actionId)
          : operations.has(command.operationId);
    },
    async execute(command: ManagementCommand): Promise<ManagementResult> {
      if (command.operation === 'list')
        return {
          kind: 'page',
          section: 'mcp',
          offset: 0,
          items: [
            {
              id: 'mcp:create',
              label: 'Add MCP',
              status: 'available' as const,
              actions: [action(undefined, 'management.actions.create', fields(), 'create')],
            },
            ...servers.map((server) => ({
              id: server.id,
              label: server.name,
              status: 'available' as const,
              actions: [
                action(server, 'management.actions.edit', fields(server)),
                action(
                  server,
                  'management.setToken',
                  [
                    {
                      name: 'bearerToken',
                      label: 'Token',
                      kind: 'password',
                      required: true,
                      maxLength: 8192,
                    },
                  ],
                  'connect',
                ),
                action(server, 'management.setHeader', [
                  {
                    name: 'headerName',
                    label: 'Header',
                    kind: 'text',
                    required: true,
                    maxLength: 512,
                  },
                  {
                    name: 'headerValue',
                    label: 'Value',
                    kind: 'password',
                    required: true,
                    maxLength: 8192,
                  },
                ]),
                ...(server.token
                  ? [action(server, 'management.removeToken', [], 'disconnect')]
                  : []),
                ...(server.headers.length
                  ? [
                      action(server, 'management.removeHeader', [
                        {
                          name: 'headerName',
                          label: 'Header',
                          kind: 'select',
                          required: true,
                          maxLength: 512,
                          options: server.headers.map((value) => ({ value, label: value })),
                        },
                      ]),
                    ]
                  : []),
                action(server, 'management.actions.delete', [], 'delete'),
              ],
            })),
          ],
        };
      if (operations.has(command.operationId)) return operations.get(command.operationId)!;
      if (command.operation !== 'run')
        return { kind: 'operation', operationId: command.operationId, phase: 'unknown' };
      const ticket = tickets.get(command.actionId);
      if (!ticket) throw Error('EXPIRED');
      const { server, label } = ticket;
      const values = command.values;
      let phase: 'succeeded' | 'failed' = 'succeeded';
      if (label === 'management.actions.create')
        servers.push({
          id: `mcp:trial-${crypto.randomUUID().slice(0, 8)}`,
          name: values.name!,
          url: values.url!,
          transport: values.transport!,
          token: false,
          headers: [],
        });
      if (!server) return finish(command.operationId, phase);
      if (label === 'management.actions.edit') {
        const url = values.url?.trim() || server.url;
        // Like the instance: credentials are never sent to a changed endpoint.
        if (url !== server.url && (server.token || server.headers.length)) phase = 'failed';
        else Object.assign(server, { name: values.name, url, transport: values.transport });
      }
      if (label === 'management.actions.delete') servers.splice(servers.indexOf(server), 1);
      if (label === 'management.setToken') server.token = true;
      if (label === 'management.removeToken') server.token = false;
      if (label === 'management.setHeader' && !server.headers.includes(command.values.headerName!))
        server.headers.push(command.values.headerName!);
      if (label === 'management.removeHeader')
        server.headers = server.headers.filter((key) => key !== command.values.headerName);
      return finish(command.operationId, phase);
    },
  };
}
