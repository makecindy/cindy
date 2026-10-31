import { randomUUID } from 'node:crypto';

export interface PluginFileInfo {
  mimeType: string;
  size: number;
}
export interface PluginFileAccess {
  describe(instance: string, uri: string): Promise<PluginFileInfo | null>;
  read(instance: string, uri: string, request: Request): Promise<Response>;
}

/** View-local capabilities. No arbitrary URI lookup endpoint is exposed to a page. */
export class PluginAppFiles {
  private readonly grants = new Map<string, string>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly viewId: string,
    private readonly instance: string,
    private readonly access: PluginFileAccess,
    private readonly assertCurrent: () => Promise<void>,
  ) {}

  async project<T>(value: T): Promise<T> {
    await this.assertCurrent();
    this.lifetime.signal.throwIfAborted();
    const visit = async (input: unknown, depth: number): Promise<unknown> => {
      if (depth > 32 || !input || typeof input !== 'object') return input;
      if (Array.isArray(input)) return Promise.all(input.map((item) => visit(item, depth + 1)));
      const object = input as Record<string, unknown>;
      if (
        object.type === 'resource_link' &&
        typeof object.uri === 'string' &&
        /^(?:cindy-media:|library:)/.test(object.uri)
      ) {
        const info = await this.access.describe(this.instance, object.uri);
        await this.assertCurrent();
        this.lifetime.signal.throwIfAborted();
        if (!info) throw new Error('MCP_APP_FILE_NOT_AUTHORIZED');
        let token = [...this.grants].find(([, uri]) => uri === object.uri)?.[0];
        if (!token) {
          if (this.grants.size >= 256) throw new Error('MCP_APP_FILE_LIMIT');
          token = randomUUID();
          this.grants.set(token, object.uri);
        }
        return {
          ...object,
          _meta: {
            ...(object._meta && typeof object._meta === 'object' ? object._meta : {}),
            'cindy/file': {
              url: `cindy-mcp-app://${this.viewId}-view/__cindy/files/${token}`,
              ...info,
            },
          },
        };
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(object).map(async ([key, item]) => [key, await visit(item, depth + 1)]),
        ),
      );
    };
    return (await visit(value, 0)) as T;
  }

  async read(token: string, request: Request): Promise<Response> {
    await this.assertCurrent();
    this.lifetime.signal.throwIfAborted();
    const uri = this.grants.get(token);
    if (!uri || !['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 404 });
    const response = await this.access.read(
      this.instance,
      uri,
      new Request(request, {
        signal: AbortSignal.any([request.signal, this.lifetime.signal]),
      }),
    );
    try {
      await this.assertCurrent();
      this.lifetime.signal.throwIfAborted();
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  }

  has(uri: string): boolean {
    return !this.lifetime.signal.aborted && [...this.grants.values()].includes(uri);
  }
  async describeGranted(uri: string): Promise<PluginFileInfo> {
    await this.assertCurrent();
    if (!this.has(uri)) throw new Error('MCP_APP_FILE_NOT_AUTHORIZED');
    const info = await this.access.describe(this.instance, uri);
    await this.assertCurrent();
    if (!info || !this.has(uri)) throw new Error('MCP_APP_FILE_NOT_AUTHORIZED');
    return info;
  }
  async readGranted(uri: string, signal: AbortSignal): Promise<Response> {
    const token = [...this.grants].find(([, value]) => value === uri)?.[0];
    if (!token) throw new Error('MCP_APP_FILE_NOT_AUTHORIZED');
    return this.read(token, new Request('https://cindy.invalid/', { signal }));
  }
  close(): void {
    this.lifetime.abort();
    this.grants.clear();
  }
}
