import { describe, expect, it } from 'vitest';

import { parseProxyAddrInput } from '../RemoteSection';

describe('parseProxyAddrInput', () => {
  it('parses host:port', () => {
    expect(parseProxyAddrInput('127.0.0.1:7890')).toEqual({ localHost: '127.0.0.1', localPort: 7890 });
    expect(parseProxyAddrInput(' localhost:1080 ')).toEqual({ localHost: 'localhost', localPort: 1080 });
  });

  it('parses bracketed IPv6', () => {
    expect(parseProxyAddrInput('[::1]:7890')).toEqual({ localHost: '::1', localPort: 7890 });
  });

  it('accepts bare IPv6 by splitting at the last colon (bracket form recommended)', () => {
    // ::1:7890 → lastIndexOf(':') 切出 host='::1', port=7890。裸 IPv6 语义
    // 模糊但有确定行为: 按 last-colon 切分接受; 文档/UI hint 推荐 bracket 形态。
    expect(parseProxyAddrInput('::1:7890')).toEqual({ localHost: '::1', localPort: 7890 });
  });

  it('rejects malformed input', () => {
    expect(parseProxyAddrInput('')).toBeNull();
    expect(parseProxyAddrInput('7890')).toBeNull();
    expect(parseProxyAddrInput(':7890')).toBeNull();
    expect(parseProxyAddrInput('host:')).toBeNull();
    expect(parseProxyAddrInput('host:abc')).toBeNull();
    expect(parseProxyAddrInput('host:0')).toBeNull();
    expect(parseProxyAddrInput('host:70000')).toBeNull();
    expect(parseProxyAddrInput('bad host:7890')).toBeNull();
    // 端口必须纯数字 — parseInt 的静默截断 ("7890abc" → 7890) 不接受。
    expect(parseProxyAddrInput('host:7890abc')).toBeNull();
    expect(parseProxyAddrInput('[::1]:7890abc')).toBeNull();
    // bracket 内的 host 同样拒空白 (与非 bracket 分支一致)。
    expect(parseProxyAddrInput('[::1 ]:7890')).toBeNull();
    // 引号与 main 侧 normalizeAgentProxyInput 校验一致, 两个分支都拒。
    expect(parseProxyAddrInput("ho'st:7890")).toBeNull();
    expect(parseProxyAddrInput('ho"st:7890')).toBeNull();
    expect(parseProxyAddrInput("[::1']:7890")).toBeNull();
    expect(parseProxyAddrInput('host:7890 ')).toEqual({ localHost: 'host', localPort: 7890 }); // 整串 trim 后合法
  });
});
