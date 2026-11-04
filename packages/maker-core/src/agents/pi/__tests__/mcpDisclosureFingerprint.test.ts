import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';

// 把 CindyMcpGateway 从 bridge 源码里切出来，在 VM 中用桩件驱动。断言都走真实入口
// （register 后的 cindy_mcp_call_tool），不直接调内部方法：披露门、自愈放行、MCP
// 请求次数、落盘与重载都在同一条路径上被验证。
const source = CINDY_BRIDGE_EXTENSION_SOURCE;
// 从工具名常量切到 CindyMcpGateway 类结束：register() 用到的常量与 helper 都在这段里，
// 因此 register 后的 cindy_mcp_call_tool 走的是与生产同一条代码路径。
const sliceStart = source.indexOf("const CINDY_MCP_LIST_TOOLS = 'cindy_mcp_list_tools'");
const classStart = source.indexOf('class CindyMcpGateway {');
const classEnd = source.indexOf('\n}\n', classStart) + 3;
if (sliceStart < 0 || classStart < sliceStart || classEnd <= classStart) {
  throw new Error('CindyMcpGateway slice not found in bridge source');
}
const GATEWAY_SOURCE = source.slice(sliceStart, classEnd);

type DisclosedFile = { version: number; entries: Record<string, string> };
type ToolDescriptor = { name: string; description?: string; inputSchema?: unknown };

const TOOL: ToolDescriptor = {
  name: 'send_to_worker',
  description: '向指定 worker 投递消息',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
};
const TOOL_CHANGED: ToolDescriptor = { ...TOOL, description: '向指定 worker 投递消息（v2）' };

function fingerprint(tool: ToolDescriptor): string {
  const description = typeof tool.description === 'string' && tool.description.length > 0
    ? tool.description
    : 'MCP tool ' + tool.name + ' from cindy_orca';
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {}, additionalProperties: true };
  return createHash('sha256').update(JSON.stringify([tool.name, description, inputSchema])).digest('hex');
}

function loadGateway(options: {
  stored?: DisclosedFile | null;
  writeFails?: boolean;
  /** 磁盘上已有内容（用于多实例合并场景），优先于 stored。 */
  onDisk?: DisclosedFile | null;
  /** 预先存在的锁文件持锁 pid；777 = 活进程，999 = 已退出进程。 */
  lockOwner?: number;
  /** process.kill(pid, 0) 抛出的错误码，默认 ESRCH。 */
  killErrorCode?: string;
  /** 模拟回收残留锁时被另一个实例抢先（rename 失败）。 */
  reclaimLostRace?: boolean;
  /** 模拟 wx 创建锁后写入 pid 失败（磁盘满等）。 */
  lockPidWriteFails?: boolean;
  /** 模拟挪走的残留锁内容其实是另一个实例重建的活锁（pid）。 */
  reclaimReplacesWith?: number;
} = {}) {
  const writes: DisclosedFile[] = [];
  const renames: string[] = [];
  const warnings: string[] = [];
  const requests: unknown[] = [];
  const disk: { value: DisclosedFile | null } = { value: options.onDisk ?? options.stored ?? null };
  const alivePids = new Set<number>([4242, 777]);
  // 锁文件独立于披露文件，由外部（另一实例或崩溃残留）直接写入。
  // 锁文件独立于披露文件，由外部（另一实例或崩溃残留）直接写入；null = 不存在。
  const lockFile: { value: string | null } = { value: null };
  if (options.lockOwner !== undefined) lockFile.value = String(options.lockOwner);

  // 接管槽：rename(takeover→lock) 覆盖接管时锁内容从这里来。
  const takeoverFile: { value: string | null } = { value: null };
  // 披露文件的 tmp 写入单独保存：只有 rename 到正式路径才算落盘成功。
  const tmpFile: { value: DisclosedFile | null } = { value: null };

  const externalWrite = (value: DisclosedFile) => { disk.value = value; };
  const reclaimed: string[] = [];

  const code = ts.transpileModule(
    `${GATEWAY_SOURCE}\n(globalThis as any).CindyMcpGateway = CindyMcpGateway;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  const sandbox: Record<string, unknown> = {
    console: { warn: (line: string) => warnings.push(line) },
    process: {
      pid: 4242,
      env: {
        CINDY_PI_PERMISSION_FILE: '/runtime/perm-s1.json',
        CINDY_PI_SESSION_ID: 's1',
      },
      kill: (pid: number, signal: number) => {
        if (alivePids.has(pid)) {
          if (signal !== 0) alivePids.delete(pid);
          return;
        }
        throw Object.assign(new Error('kill failed'), { code: options.killErrorCode ?? 'ESRCH' });
      },
    },
    path: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (file: string) => file.slice(0, file.lastIndexOf('/')),
    },
    readFileSync: (file: string) => {
      if (file.endsWith('.lock')) {
        if (lockFile.value === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return lockFile.value;
      }
      if (disk.value === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return JSON.stringify(disk.value);
    },
    writeFileSync: (file: string, body: string) => {
      if (options.writeFails) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (file.endsWith('.lock')) {
        if (options.lockPidWriteFails && lockFile.value === '') {
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        }
        lockFile.value = body; // 记录持锁 pid
        return;
      }
      if (file.includes('.takeover-')) {
        takeoverFile.value = body; // 接管槽内容（持锁 pid）
        return;
      }
      // 披露文件的 tmp 写入：先暂存，rename 到正式路径才算落盘成功。
      tmpFile.value = JSON.parse(body) as DisclosedFile;
    },
    renameSync: (from: string, to: string) => {
      if (options.reclaimLostRace && from.includes('.takeover-')) {
        // 模拟接管覆盖失败（例如路径刚被另一个接管者占用）：本实例的 rename 失败。
        throw Object.assign(new Error('lock gone'), { code: 'ENOENT' });
      }
      if (from.includes('.takeover-') && to.endsWith('.lock')) {
        // 接管覆盖：锁路径内容换成接管槽内容；外部可预置 reclaimReplacesWith 模拟
        // 「本实例覆盖之后、写前复核之前，另一个接管者又覆盖了一次」。
        lockFile.value = options.reclaimReplacesWith !== undefined
          ? String(options.reclaimReplacesWith)
          : takeoverFile.value;
        takeoverFile.value = null;
      } else if (from.includes('.tmp') && !to.endsWith('.lock') && !to.includes('.takeover-')) {
        // 披露文件落盘：rename 成功才算保存成功。
        disk.value = tmpFile.value;
        tmpFile.value = null;
        writes.push(disk.value as DisclosedFile);
      }
      renames.push(`${from} -> ${to}`);
    },
    rmSync: (file: string) => {
      if (file.includes('.takeover-')) takeoverFile.value = null;
      else if (file.endsWith('.lock')) lockFile.value = null;
      else if (file.includes('.tmp')) tmpFile.value = null;
      reclaimed.push(file);
    },
    openSync: (file: string, flags: string) => {
      if (flags === 'wx' && lockFile.value !== null) {
        throw Object.assign(new Error('locked'), { code: 'EEXIST' });
      }
      if (flags === 'wx') lockFile.value = '';
      return 7;
    },
    closeSync: () => undefined,
    createHash,
    fetch: async (_url: string, init: { body: string } & Record<string, unknown>) => {
      requests.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'delivered' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    Response: globalThis.Response,
    URL,
    Headers,
    AbortController,
    TextDecoder,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(code, sandbox);

  const Gateway = sandbox.CindyMcpGateway as new () => {
    add(server: string, client: unknown, tools: ToolDescriptor[]): void;
    register(pi: unknown, options?: unknown): void;
    resolveCall(input: unknown): unknown;
  };
  const gateway = new Gateway();

  // executeResolvedCall 走 tool.client.request；用最小 client 桩替代 HTTP 层，
  // 每次真实调用都会在 requests 里留下一条，正好用来断言“恰好执行一次”。
  const httpClient = {
    request: async (_method: string, params: { name: string; arguments: unknown }) => {
      requests.push(params);
      return { content: [{ type: 'text', text: 'delivered' }] };
    },
  };
  gateway.add('cindy_orca', httpClient, [TOOL]);

  const registered: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] = [];
  gateway.register({ registerTool: (tool: { name: string; execute: unknown }) => registered.push(tool as never) });
  const callTool = registered.find((t) => t.name === 'cindy_mcp_call_tool');
  const listTools = registered.find((t) => t.name === 'cindy_mcp_list_tools');
  if (!callTool || !listTools) throw new Error('gateway tools not registered');

  const lockOwnerAfter = () => lockFile.value;
  return {
    gateway,
    httpClient,
    externalWrite,
    reclaimed,
    lockOwnerAfter,
    writes,
    renames,
    warnings,
    requests,
    disk,
    callRaw: (args: Record<string, unknown> = { message: 'hi' }) =>
      callTool.execute('call-1', { server: 'cindy_orca', tool: 'send_to_worker', args }),
    // 默认模拟真实模型的两步：第一次被路标拦下 → 查完 schema 重发。只有验证拦截语义的用例
    // 用 callRaw；其他错误（如 zod 拒参）原样抛出，不在此处吞掉。
    call: async (args: Record<string, unknown> = { message: 'hi' }) => {
      const input = { server: 'cindy_orca', tool: 'send_to_worker', args };
      try {
        return await callTool.execute('call-1', input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Inspect this tool before execution')) throw error;
        return callTool.execute('call-2', input);
      }
    },
    list: () => listTools.execute('list-1', { server: 'cindy_orca', tool: 'send_to_worker' }),
  };
}

describe('MCP gateway schema disclosure', () => {
  it('blocks the first uninspected call with a signpost, records the fingerprint, and lets the retry through', async () => {
    const { gateway, callRaw, requests, warnings, writes, disk } = loadGateway();
    const resolved = gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }) as { tool: unknown };
    // 事前未披露
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(resolved)).toBe(false);

    // 第一次：被拦下，一个 MCP 请求都不该发出去；回执必须指名要查的 server/tool
    const first = await callRaw().then(() => null, (error: Error) => error);
    expect(first?.message).toContain('Inspect this tool before execution');
    expect(first?.message).toContain('"server":"cindy_orca"');
    expect(first?.message).toContain('"tool":"send_to_worker"');
    expect(requests).toHaveLength(0);
    expect(warnings.some((line) => line.includes('gateway tool auto-disclosed on first call'))).toBe(true);
    // 拦的时候已经记账，因此重发时不再重复落盘
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL));
    expect(writes).toHaveLength(1);

    // 第二次（模型照路标查完 schema 后重发）：放行并执行成功
    const result = await callRaw();
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'delivered' }] });
    expect(writes).toHaveLength(1);
  });

  it('reuses a persisted disclosure after a reload when the schema is unchanged', async () => {
    const stored: DisclosedFile = {
      version: 1,
      entries: { 'cindy_orca\u0000send_to_worker': fingerprint(TOOL) },
    };
    const { gateway, call, requests, warnings, writes } = loadGateway({ stored });

    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(true);
    await call();

    expect(requests).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('re-arms the gate when the tool schema actually changes and lets the retry through', async () => {
    const stored: DisclosedFile = {
      version: 1,
      entries: { 'cindy_orca\u0000send_to_worker': fingerprint(TOOL) },
    };
    const { gateway, httpClient, callRaw, requests, warnings, disk } = loadGateway({ stored });

    // 同一会话内工具描述变化（MCP 重连后拿到新 schema）
    gateway.add('cindy_orca', httpClient, [TOOL_CHANGED]);
    const changed = gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }) as { tool: unknown };
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(changed)).toBe(false);

    const first = await callRaw().then(() => null, (error: Error) => error);
    expect(first?.message).toContain('"tool":"send_to_worker"');
    expect(requests).toHaveLength(0);

    await callRaw();
    expect(requests).toHaveLength(1);
    expect(warnings.some((line) => line.includes('auto-disclosed on first call'))).toBe(true);
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL_CHANGED));
  });

  it('merges a record another instance wrote after startup instead of overwriting it', async () => {
    // 关键：另一实例的写入发生在本实例**构造之后**，本实例内存里没有这条记录，
    // 因此只有落盘时的读-合并才能保住它（删掉合并循环这条测试就会红）。
    const { call, disk, renames, externalWrite } = loadGateway();
    const otherKey = 'cindy_other\u0000other_tool';
    const otherFingerprint = fingerprint({ name: 'other_tool', description: '别的工具' });
    externalWrite({ version: 1, entries: { [otherKey]: otherFingerprint } });

    await call();

    expect(disk.value?.entries[otherKey]).toBe(otherFingerprint);
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL));
    // 原子替换：先写 tmp 再 rename
    expect(renames).toHaveLength(1);
    expect(renames[0]).toContain('.tmp');
  });

  it('recovers a lock left behind by a crashed instance and persists', async () => {
    // 持锁 pid 999 已退出 → 锁必须被回收，本进程仍能落盘。
    const { call, disk } = loadGateway({ lockOwner: 999 });
    await call();
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL));
  });

  it('skips persisting while another live instance holds the lock, without breaking the gate', async () => {
    const { gateway, call, requests, disk } = loadGateway({ lockOwner: 777 });
    await call();
    expect(requests).toHaveLength(1);
    expect(disk.value).toBeNull();
    // 本进程内存里的披露已生效
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(true);
  });

  it('keeps a stale lock when the liveness probe fails for a reason other than ESRCH', async () => {
    // EINVAL 等非 ESRCH 错误不能证明进程已退出 → 不回收，跳过落盘但不挡工具执行。
    const { gateway, call, requests, disk } = loadGateway({ lockOwner: 999, killErrorCode: 'EINVAL' });
    await call();
    expect(requests).toHaveLength(1);
    expect(disk.value).toBeNull();
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(true);
  });

  it('skips persisting when the takeover rename fails, leaving the existing lock alone', async () => {
    // 接管覆盖失败（另一个实例抢先）：不争，放弃本次落盘，不删对方的锁。
    const { call, requests, disk, reclaimed } = loadGateway({ lockOwner: 999, reclaimLostRace: true });
    await call();
    expect(requests).toHaveLength(1);
    expect(disk.value).toBeNull();
    expect(reclaimed.some((file) => file.endsWith('.lock'))).toBe(false);
  });

  it('aborts without deleting the lock when another instance won the takeover race', async () => {
    // 接管覆盖成功后、写前复核前，另一个接管者又覆盖了一次（锁内容变成 777）。
    // 本实例必须放弃落盘且**不删锁**——那是赢家的锁；删了会造成新的双写窗口。
    const { call, requests, disk, lockOwnerAfter } = loadGateway({ lockOwner: 999, reclaimReplacesWith: 777 });
    await call();
    expect(requests).toHaveLength(1);
    expect(disk.value).toBeNull();
    // 赢家的锁保持原样（内容 777，活进程），未被本实例删除或覆盖回自己的 pid。
    expect(lockOwnerAfter()).toBe('777');
  });

  it('cleans up an empty lock when writing the pid fails, and recovers on the next call', async () => {
    // wx 创建锁后写 pid 失败（磁盘满）：空锁 owner 读不出来会被永远拒绝回收，
    // 必须当场清掉并放弃本次落盘；下次调用（磁盘恢复）重新获取并正常落盘。
    const { call, requests, disk, lockOwnerAfter } = loadGateway({ lockPidWriteFails: true });
    await call();
    expect(requests).toHaveLength(1);
    expect(disk.value).toBeNull();
    expect(lockOwnerAfter()).toBeNull();

    // 磁盘恢复（桩不再抛）：下一次调用正常获取锁并落盘。
    const second = loadGateway();
    await second.call();
    expect(second.requests).toHaveLength(1);
    expect(second.disk.value?.entries['cindy_orca send_to_worker']).toBe(fingerprint(TOOL));
  });

  it('keeps another instance newer fingerprint when persisting a different tool', async () => {
    // A 启动时载入 X 的旧指纹；另一实例随后更新 X 并落盘新指纹（外部写入磁盘）；
    // A 之后只为 Y 落盘。磁盘优先 + 只覆盖本次键：X 必须保持新指纹，不能被 A 内存
    // 里的旧值回退——否则下次启动 A 会把 X 判为未披露。
    const { gateway, disk, externalWrite } = loadGateway({
      stored: { version: 1, entries: { 'cindy_orca send_to_worker': fingerprint(TOOL) } },
    });
    const newer = fingerprint(TOOL_CHANGED);
    externalWrite({ version: 1, entries: { 'cindy_orca send_to_worker': newer } });

    // A 为另一个工具 Y 显式披露（list_tools 单工具查询的生产路径）。
    const other = { name: 'list_workers', description: '列出 workers', inputSchema: { type: 'object' } };
    gateway.add('cindy_orca', { request: async () => ({ content: [] }) }, [other]);
    await (gateway as unknown as { listResult: (params: unknown) => Promise<unknown> })
      .listResult({ server: 'cindy_orca', tool: 'list_workers' });

    expect(disk.value?.entries['cindy_orca send_to_worker']).toBe(newer);
    expect(disk.value?.entries['cindy_orca list_workers']).toBe(fingerprint(other));
  });


  it('treats a missing or corrupt disclosure file as undisclosed and still executes', async () => {
    for (const stored of [
      null,
      { version: 1, entries: { 'cindy_orca\u0000send_to_worker': 'not-a-hash' } },
    ] as (DisclosedFile | null)[]) {
      const { gateway, call, requests } = loadGateway({ stored });
      expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
        .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(false);
      await call();
      expect(requests).toHaveLength(1);
    }
  });

  it('keeps the in-memory gate working when the disclosure file cannot be written', async () => {
    const { gateway, call, requests, writes } = loadGateway({ writeFails: true });
    await call();
    expect(requests).toHaveLength(1);
    expect(writes).toHaveLength(0);
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(true);
  });

  it('records disclosure through cindy_mcp_list_tools too', async () => {
    const { gateway, list, requests, disk } = loadGateway();
    await list();
    expect(requests).toHaveLength(0);
    expect(disk.value?.entries['cindy_orca\u0000send_to_worker']).toBe(fingerprint(TOOL));
    expect((gateway as unknown as { isSchemaDisclosed(c: unknown): boolean })
      .isSchemaDisclosed(gateway.resolveCall({ server: 'cindy_orca', tool: 'send_to_worker' }))).toBe(true);
  });
});