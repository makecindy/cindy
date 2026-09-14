import { describe, expect, it } from 'vitest';

import {
  describeUpstreamRequestFailure,
  findLoopbackRefusedConnection,
  UPSTREAM_LOOPBACK_REFUSED_CODE,
} from './upstream-failure.js';

function errno(code: string, address?: string, port?: number): Error {
  return Object.assign(new Error(`connect ${code} ${address ?? ''}:${port ?? ''}`), {
    code,
    syscall: 'connect',
    ...(address !== undefined ? { address } : {}),
    ...(port !== undefined ? { port } : {}),
  });
}

describe('findLoopbackRefusedConnection (#4100)', () => {
  it('recognises ECONNREFUSED against loopback addresses, including happy-eyeballs AggregateError', () => {
    expect(findLoopbackRefusedConnection(errno('ECONNREFUSED', '127.0.0.1', 18080)))
      .toEqual({ address: '127.0.0.1', port: 18080 });
    expect(findLoopbackRefusedConnection(errno('ECONNREFUSED', '::1', 18080)))
      .toEqual({ address: '::1', port: 18080 });
    expect(findLoopbackRefusedConnection(errno('ECONNREFUSED', '::ffff:127.0.0.1', 18080)))
      .toEqual({ address: '::ffff:127.0.0.1', port: 18080 });
    const aggregate = new AggregateError(
      [errno('ECONNREFUSED', '::1', 18080), errno('ECONNREFUSED', '127.0.0.1', 18080)],
      'aggregate',
    );
    expect(findLoopbackRefusedConnection(aggregate)).toEqual({ address: '::1', port: 18080 });
  });

  it('follows Error.cause so proxy-agent wrappers (outbound-proxy.ts / socks5.ts) keep their errno', () => {
    const wrapped = new Error('outbound proxy http://127.0.0.1:7890 unreachable: connect ECONNREFUSED 127.0.0.1:7890', {
      cause: errno('ECONNREFUSED', '127.0.0.1', 7890),
    });
    expect(findLoopbackRefusedConnection(wrapped)).toEqual({ address: '127.0.0.1', port: 7890 });
    // 二级包装 + AggregateError 混合也能找到
    const nested = new Error('outer', { cause: new AggregateError([errno('ECONNREFUSED', '::1', 1080)], 'agg') });
    expect(findLoopbackRefusedConnection(nested)).toEqual({ address: '::1', port: 1080 });
    // 没带 cause 的纯文本包装:不猜,保持通用文案
    expect(findLoopbackRefusedConnection(new Error('outbound proxy unreachable: connect ECONNREFUSED 127.0.0.1:7890'))).toBeNull();
  });

  it('leaves every other failure alone: non-loopback refusal, timeouts, DNS, non-errors', () => {
    expect(findLoopbackRefusedConnection(errno('ECONNREFUSED', '10.0.0.8', 443))).toBeNull();
    expect(findLoopbackRefusedConnection(errno('ECONNREFUSED', '127.example.com', 443))).toBeNull();
    expect(findLoopbackRefusedConnection(errno('ETIMEDOUT', '127.0.0.1', 18080))).toBeNull();
    expect(findLoopbackRefusedConnection(errno('ENOTFOUND'))).toBeNull();
    expect(findLoopbackRefusedConnection(new AggregateError([errno('ETIMEDOUT', '127.0.0.1', 1)], 'x'))).toBeNull();
    expect(findLoopbackRefusedConnection('ECONNREFUSED 127.0.0.1:18080')).toBeNull();
    expect(findLoopbackRefusedConnection(null)).toBeNull();
  });
});

describe('describeUpstreamRequestFailure (#4100)', () => {
  it('keeps the historical "upstream unreachable: <err>" text verbatim for everything else', () => {
    const err = errno('ETIMEDOUT', '10.0.0.8', 443);
    expect(describeUpstreamRequestFailure(err, { viaOutboundProxy: false }))
      .toEqual({ message: `upstream unreachable: ${String(err)}` });
  });

  it('turns a refused loopback port into an actionable message with a stable code', () => {
    const described = describeUpstreamRequestFailure(errno('ECONNREFUSED', '127.0.0.1', 18080), { viaOutboundProxy: false });
    expect(described.code).toBe(UPSTREAM_LOOPBACK_REFUSED_CODE);
    expect(described.message).toMatch(/^upstream unreachable: connect ECONNREFUSED 127\.0\.0\.1:18080/);
    expect(described.message).toMatch(/nothing is listening/);
    expect(described.message).toMatch(/configured upstream at 127\.0\.0\.1:18080/);
    expect(described.message).toMatch(/local proxy or an SSH tunnel/);
    expect(described.message).toMatch(/not a remote service or subscription problem/);
  });

  it('blames the outbound proxy instead when the refused loopback port is the proxy hop', () => {
    const described = describeUpstreamRequestFailure(errno('ECONNREFUSED', '127.0.0.1', 7890), { viaOutboundProxy: true });
    expect(described.code).toBe(UPSTREAM_LOOPBACK_REFUSED_CODE);
    expect(described.message).toMatch(/outbound proxy at 127\.0\.0\.1:7890/);
  });
});
