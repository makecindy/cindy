import { describe, expect, it } from 'vitest';

import { parseProxyAddrInput, parseProxyUrlInput, parseRemotePortInput } from '../RemoteSection';

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

describe('parseRemotePortInput', () => {
  it('accepts strict integer ports in range', () => {
    expect(parseRemotePortInput('17893')).toBe(17893);
    expect(parseRemotePortInput(' 45000 ')).toBe(45000);
  });

  it('rejects non-integers, out-of-range, privileged and suffixed values', () => {
    expect(parseRemotePortInput('')).toBeNull();
    expect(parseRemotePortInput('0')).toBeNull();
    expect(parseRemotePortInput('65536')).toBeNull();
    expect(parseRemotePortInput('7890abc')).toBeNull();
    expect(parseRemotePortInput('-1')).toBeNull();
    expect(parseRemotePortInput('78.9')).toBeNull();
    // 特权/知名服务端口拒收 (防残留清理误杀系统 sshd, PR #992 review)。
    expect(parseRemotePortInput('22')).toBeNull();
    expect(parseRemotePortInput('1023')).toBeNull();
    expect(parseRemotePortInput('1024')).toBe(1024);
  });
});

describe('parseProxyUrlInput', () => {
  it('accepts http/https/socks5 URLs (与 main 侧 normalizeAgentProxyUrl 同口径)', () => {
    expect(parseProxyUrlInput('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(parseProxyUrlInput(' https://proxy.lan:3128 ')).toBe('https://proxy.lan:3128');
    expect(parseProxyUrlInput('socks5://10.0.0.5:1080')).toBe('socks5://10.0.0.5:1080');
    expect(parseProxyUrlInput('socks5h://10.0.0.5:1080')).toBe('socks5h://10.0.0.5:1080');
  });

  it('rejects unsupported schemes, whitespace, quotes, userinfo and non-URLs', () => {
    expect(parseProxyUrlInput('')).toBeNull();
    expect(parseProxyUrlInput('127.0.0.1:7890')).toBeNull(); // 缺 scheme
    expect(parseProxyUrlInput('ftp://127.0.0.1:21')).toBeNull();
    expect(parseProxyUrlInput('http://a b:1')).toBeNull();
    expect(parseProxyUrlInput("http://x'y:1")).toBeNull();
    expect(parseProxyUrlInput('http://x"y:1')).toBeNull();
    expect(parseProxyUrlInput('http://')).toBeNull();
    // userinfo 内嵌凭证拒收 (会持久化 + 写远端 marker, PR #992 greptile P1)。
    expect(parseProxyUrlInput('http://user:pass@127.0.0.1:7890')).toBeNull();
    expect(parseProxyUrlInput('socks5://user@10.0.0.5:1080')).toBeNull();
  });
});
