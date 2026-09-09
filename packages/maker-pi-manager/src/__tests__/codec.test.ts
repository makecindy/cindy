/**
 * codec.test.ts — NDJSONDecoder / encodeMessage 完整覆盖。
 *
 * 覆盖清单:
 *   NDJSON 解析:完整行、半行跨 push、多行、CRLF 容忍、空行跳过、
 *     corrupt JSON 触发 onCorruptLine 且不中断、合法 JSON 非 RpcMessage 触发
 *     onCorruptLine。
 *   UTF-8 安全:3 字节中文拆两半 push, StringDecoder 正确重组。
 *   OOM 守卫:>64M 无换行 → buffer 丢弃 + onCorruptLine 一次,后续可复用。
 *   reset:清 buffer + 新 StringDecoder,之后 push 正常。
 *   encodeMessage:JSON.stringify + '\n' 往返可被 NDJSONDecoder 解析。
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { NDJSONDecoder, encodeMessage } from '../codec.js';
import type { RpcMessage } from '../protocol.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function pushLines(
  decoder: NDJSONDecoder,
  ...chunks: (string | Buffer)[]
): RpcMessage[] {
  let out: RpcMessage[] = [];
  for (const c of chunks) {
    out = out.concat(decoder.push(c));
  }
  return out;
}

// ---------------------------------------------------------------------------
// encodeMessage
// ---------------------------------------------------------------------------
describe('encodeMessage', () => {
  it('should produce a JSON line terminated by newline', () => {
    const msg: RpcMessage = { type: 'notification', method: 'test', params: {} };
    const line = encodeMessage(msg);
    expect(line).toBe('{"type":"notification","method":"test","params":{}}\n');
  });

  it('roundtrip: encodeMessage output can be decoded by NDJSONDecoder', () => {
    const msg: RpcMessage = {
      type: 'request',
      id: 42,
      method: 'pi/ensure',
      params: { sessionId: 'abc', cmd: 'bash -c "pi"', env: { KEY: 'val' } },
    };
    const line = encodeMessage(msg);
    const decoder = new NDJSONDecoder();
    const results = decoder.push(line);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// NDJSONDecoder — push
// ---------------------------------------------------------------------------
describe('NDJSONDecoder.push', () => {
  // ---- 完整行 ----
  describe('complete lines', () => {
    it('parses a single complete line', () => {
      const decoder = new NDJSONDecoder();
      const results = decoder.push('{"type":"notification","method":"hello"}\n');
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'notification',
        method: 'hello',
      });
    });

    it('parses multiple complete lines in one push', () => {
      const decoder = new NDJSONDecoder();
      const chunk = [
        '{"type":"notification","method":"a"}',
        '{"type":"notification","method":"b"}',
        '{"type":"request","id":1,"method":"c","params":{}}',
      ].join('\n') + '\n';
      const results = decoder.push(chunk);
      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ type: 'notification', method: 'a' });
      expect(results[1]).toMatchObject({ type: 'notification', method: 'b' });
      expect(results[2]).toMatchObject({ type: 'request', id: 1, method: 'c' });
    });

    it('parses Buffer input', () => {
      const decoder = new NDJSONDecoder();
      const buf = Buffer.from(
        '{"type":"notification","method":"buf"}\n',
        'utf8',
      );
      const results = decoder.push(buf);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ method: 'buf' });
    });
  });

  // ---- 半行跨 push ----
  describe('partial lines across pushes', () => {
    it('buffers partial line and completes on next push', () => {
      const decoder = new NDJSONDecoder();

      // first push: partial line (no newline)
      const r1 = decoder.push('{"type":"notif');
      expect(r1).toEqual([]);

      // second push: rest + newline
      const r2 = decoder.push('ication","method":"partial"}\n');
      expect(r2).toHaveLength(1);
      expect(r2[0]).toEqual({
        type: 'notification',
        method: 'partial',
      });
    });

    it('handles trailing partial after complete lines', () => {
      const decoder = new NDJSONDecoder();

      const r1 = decoder.push(
        '{"type":"notification","method":"a"}\n{"type":"noti',
      );
      expect(r1).toHaveLength(1);
      expect(r1[0]).toMatchObject({ method: 'a' });

      const r2 = decoder.push(
        'fication","method":"b"}\n{"type":"notification","method":"c"}\n',
      );
      expect(r2).toHaveLength(2);
      expect(r2[0]).toMatchObject({ method: 'b' });
      expect(r2[1]).toMatchObject({ method: 'c' });
    });

    it('returns empty array when no newline in buffer', () => {
      const decoder = new NDJSONDecoder();
      const r = decoder.push('incomplete');
      expect(r).toEqual([]);
    });
  });

  // ---- CRLF 容忍 ----
  describe('CRLF tolerance', () => {
    it('strips trailing \\r from lines', () => {
      const decoder = new NDJSONDecoder();
      const results = decoder.push(
        '{"type":"notification","method":"crlf"}\r\n',
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ method: 'crlf' });
    });

    it('handles mixed \\r\\n and \\n in same chunk', () => {
      const decoder = new NDJSONDecoder();
      const results = decoder.push(
        '{"type":"notification","method":"a"}\r\n{"type":"notification","method":"b"}\n',
      );
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ method: 'a' });
      expect(results[1]).toMatchObject({ method: 'b' });
    });

    it('strips multiple trailing CRs (\\r\\r\\n) — round 3 #6', () => {
      const decoder = new NDJSONDecoder();
      const corrupt: string[] = [];
      const d2 = new NDJSONDecoder({ onCorruptLine: (line) => corrupt.push(line) });
      const results = d2.push(
        '{"type":"notification","method":"double-cr"}\r\r\n',
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ method: 'double-cr' });
      expect(corrupt).toHaveLength(0);
    });

    it('skips whitespace-only lines without reporting corrupt — round 3 #7', () => {
      const decoder = new NDJSONDecoder();
      const corrupt: string[] = [];
      const d2 = new NDJSONDecoder({ onCorruptLine: (line) => corrupt.push(line) });
      const results = d2.push(
        '{"type":"notification","method":"x"}\n   \n\t\n{"type":"notification","method":"y"}\n',
      );
      expect(results).toHaveLength(2);
      expect(corrupt).toHaveLength(0);
    });

    it('strips UTF-8 BOM from the first chunk — round 3 #8', () => {
      const decoder = new NDJSONDecoder();
      const results = decoder.push(
        '﻿{"type":"notification","method":"bom"}\n',
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ method: 'bom' });
    });

    it('BOM only stripped once at stream start, not mid-stream — round 3 #8', () => {
      const decoder = new NDJSONDecoder();
      const results = decoder.push(
        '{"type":"notification","method":"a"}\n﻿{"type":"notification","method":"bom-late"}\n',
      );
      // 中间的 BOM 不是合法 JSON 开头 → corrupt 行, 流继续。
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ method: 'a' });
    });
  });

  // ---- 空行跳过 ----
  describe('empty line skipping', () => {
    it('skips blank lines between messages', () => {
      const decoder = new NDJSONDecoder();
      const results = decoder.push(
        '{"type":"notification","method":"a"}\n\n{"type":"notification","method":"b"}\n',
      );
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ method: 'a' });
      expect(results[1]).toMatchObject({ method: 'b' });
    });

    it('skips lines that are only whitespace (empty after trim is no-op, but CR becomes empty)', () => {
      const decoder = new NDJSONDecoder();
      // \r alone becomes empty after \r strip → skipped
      const results = decoder.push(
        '{"type":"notification","method":"x"}\n\r\n{"type":"notification","method":"y"}\n',
      );
      expect(results).toHaveLength(2);
    });
  });

  // ---- corrupt JSON → onCorruptLine + 流不中断 ----
  describe('corrupt JSON handling', () => {
    it('calls onCorruptLine for unparseable JSON and continues', () => {
      const corruptLines: { line: string; error: Error }[] = [];
      const decoder = new NDJSONDecoder({
        onCorruptLine(line, error) {
          corruptLines.push({ line, error });
        },
      });

      const results = decoder.push(
        'not json at all\n{"type":"notification","method":"good"}\n',
      );

      expect(corruptLines).toHaveLength(1);
      expect(corruptLines[0].line).toBe('not json at all');
      expect(corruptLines[0].error).toBeInstanceOf(Error);

      // 流不中断 — 仍然是 good line
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ method: 'good' });
    });

    it('calls onCorruptLine for valid JSON that is not an RpcMessage', () => {
      const corruptLines: string[] = [];
      const decoder = new NDJSONDecoder({
        onCorruptLine(line) {
          corruptLines.push(line);
        },
      });

      const results = decoder.push(
        '{"valid":"json","but":"not rpc"}\n{"type":"notification","method":"ok"}\n',
      );

      expect(corruptLines).toHaveLength(1);
      expect(corruptLines[0]).toBe('{"valid":"json","but":"not rpc"}');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ method: 'ok' });
    });

    it('does not throw when onCorruptLine is not provided', () => {
      const decoder = new NDJSONDecoder(); // no handler
      expect(() => {
        decoder.push('garbage\n');
      }).not.toThrow();
    });

    it('handles multiple corrupt lines in a row', () => {
      const corruptLines: string[] = [];
      const decoder = new NDJSONDecoder({
        onCorruptLine(line) {
          corruptLines.push(line);
        },
      });

      decoder.push(
        'bad1\nbad2\n{"type":"notification","method":"survivor"}\nbad3\n',
      );

      expect(corruptLines).toHaveLength(3);
      expect(corruptLines).toEqual([
        'bad1',
        'bad2',
        'bad3',
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// UTF-8 跨边界
// ---------------------------------------------------------------------------
describe('NDJSONDecoder — UTF-8 safety', () => {
  it('correctly reassembles a 3-byte Chinese character split across two pushes', () => {
    // 构造含中文的消息
    const msg: RpcMessage = {
      type: 'notification',
      method: '你好',
      params: {},
    };
    const full = Buffer.from(encodeMessage(msg), 'utf8');

    // 计算 '你' 在 Buffer 中的位置
    // encodeMessage: '{"type":"notification","method":"你好","params":{}}\n'
    // ASCII prefix: '{"type":"notification","method":"' = 30 bytes
    // '你' = 0xE4 0xBD 0xA0 (3 bytes, starting at byte 30)
    // '好' = 0xE5 0xA5 0xBD (3 bytes, starting at byte 33)
    const prefix = '{"type":"notification","method":"';
    const prefixBytes = Buffer.byteLength(prefix, 'utf8'); // = 30

    // 把 '你' 的第一、二个字节拆到 chunk1,第三个字节+余下到 chunk2
    const chunk1 = full.subarray(0, prefixBytes + 2);
    const chunk2 = full.subarray(prefixBytes + 2);

    const decoder = new NDJSONDecoder();

    // 第一次 push: 前缀 + '你' 的前 2 字节, StringDecoder 内部暂存
    const r1 = decoder.push(chunk1);
    expect(r1).toEqual([]);

    // 第二次 push: '你' 的第 3 字节 + '好' + 余下, StringDecoder 补全 → '你'
    const r2 = decoder.push(chunk2);
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ type: 'notification', method: '你好' });
  });

  it('correctly reassembles when chunk splits mid-character byte sequence', () => {
    // 更极端的分割: 把 '你' 的 3 个字节分别分到三个 chunk
    const msg: RpcMessage = {
      type: 'notification',
      method: '你',
      params: {},
    };
    const full = Buffer.from(encodeMessage(msg), 'utf8');

    const prefix = '{"type":"notification","method":"';
    const prefixBytes = Buffer.byteLength(prefix, 'utf8'); // = 30

    // '你' = 0xE4 0xBD 0xA0, 拆成三段
    const chunk1 = full.subarray(0, prefixBytes + 1); // + 0xE4
    const chunk2 = full.subarray(prefixBytes + 1, prefixBytes + 2); // 0xBD
    const chunk3 = full.subarray(prefixBytes + 2); // 0xA0 + rest

    const decoder = new NDJSONDecoder();
    expect(decoder.push(chunk1)).toEqual([]);
    expect(decoder.push(chunk2)).toEqual([]);
    const r3 = decoder.push(chunk3);
    expect(r3).toHaveLength(1);
    expect(r3[0]).toMatchObject({ method: '你' });
  });

  it('handles ASCII-only messages without corruption', () => {
    const decoder = new NDJSONDecoder();
    const msg: RpcMessage = { type: 'notification', method: 'hello', params: {} };
    const buf = Buffer.from(encodeMessage(msg), 'utf8');

    // 任意位置切分 ASCII 消息, 不会触发多字节重组
    const mid = Math.floor(buf.length / 2);
    const r1 = decoder.push(buf.subarray(0, mid));
    const r2 = decoder.push(buf.subarray(mid));

    expect([...r1, ...r2]).toHaveLength(1);
    expect([...r1, ...r2][0]).toMatchObject({ method: 'hello' });
  });
});

// ---------------------------------------------------------------------------
// OOM 守卫
// ---------------------------------------------------------------------------
describe('NDJSONDecoder — OOM guard', () => {
  it(
    'discards buffer and fires onCorruptLine once when buffer exceeds 64M with no newline',
    () => {
      const maxChars = 64 * 1024 * 1024;
      // 创建一个超过上限的无换行 chunk
      const bigBuf = Buffer.alloc(maxChars + 1, 0x61); // 64M+1 字节的 'a'

      let corruptCalls = 0;
      let corruptLine = '';
      let corruptErr: Error | null = null;

      const decoder = new NDJSONDecoder({
        onCorruptLine(line, err) {
          corruptCalls++;
          corruptLine = line;
          corruptErr = err;
        },
      });

      const result = decoder.push(bigBuf);

      expect(result).toEqual([]);
      expect(corruptCalls).toBe(1);
      expect(corruptLine).toBe('a'.repeat(256)); // 前 256 字符样本
      expect(corruptErr).toBeInstanceOf(Error);
      expect((corruptErr as Error | null)?.message).toContain('exceeded');
      expect((corruptErr as Error | null)?.message).toContain('OOM');
    },
    30000,
  );

  it('decoder is still usable after OOM guard fires', () => {
    const maxChars = 64 * 1024 * 1024;
    const bigBuf = Buffer.alloc(maxChars + 1, 0x61);

    const decoder = new NDJSONDecoder();

    decoder.push(bigBuf); // OOM guard fires, buffer cleared

    // 之后正常消息应可解析
    const results = decoder.push(
      '{"type":"notification","method":"after-oom"}\n',
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ method: 'after-oom' });
  }, 30000);

  it('does not fire for normal messages far under limit', () => {
    const decoder = new NDJSONDecoder();
    let corruptCalls = 0;
    // 直接替换 decoder 不方便，新建一个带 handler 的
    const d2 = new NDJSONDecoder({
      onCorruptLine: () => {
        corruptCalls++;
      },
    });

    // push 1000 normal messages — 远低于 64M
    for (let i = 0; i < 1000; i++) {
      d2.push(`{"type":"notification","method":"m${i}"}\n`);
    }
    expect(corruptCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------
describe('NDJSONDecoder.reset', () => {
  it('clears the internal buffer', () => {
    const decoder = new NDJSONDecoder();
    decoder.push('{"type":"noti'); // 半行, 留在 buffer

    decoder.reset();

    // 之后 push 不应带上前面的半行数据
    const results = decoder.push('fication","method":"fresh"}\n');
    // 若 buffer 未清, 会拼接成完整行; 清空后 "fication..." 单独无法解析
    // → corrupt line
    expect(results).toHaveLength(0); // 不是合法 JSON
  });

  it('creates a fresh StringDecoder (decoder is reusable)', () => {
    const decoder = new NDJSONDecoder();

    // 先正常使用
    const r1 = decoder.push(
      '{"type":"notification","method":"first"}\n',
    );
    expect(r1).toHaveLength(1);

    decoder.reset();

    // 重置后应可正常解码新消息
    const r2 = decoder.push(
      '{"type":"notification","method":"second"}\n',
    );
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ method: 'second' });
  });

  it('reset clears buffer so stale partial lines do not bleed into next connection', () => {
    const decoder = new NDJSONDecoder();

    // 模拟 socket 断连前收到半行
    decoder.push('{"type":"request","id":1,"method":"pi/ensu');

    decoder.reset();

    // 新连接完整消息
    const results = decoder.push(
      '{"type":"notification","method":"new-conn"}\n',
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ method: 'new-conn' });
    // 确保没有拼接上之前的半行
    expect(JSON.stringify(results[0])).not.toContain('pi/ensu');
  });
});

// ---------------------------------------------------------------------------
// 综合往返
// ---------------------------------------------------------------------------
describe('NDJSONDecoder — integration scenarios', () => {
  it('handles interleaved string and Buffer pushes', () => {
    const decoder = new NDJSONDecoder();
    const msgs: RpcMessage[] = [
      { type: 'request', id: 1, method: 'pi/ensure', params: {} },
      { type: 'response', id: 1, result: { sockPath: '/tmp/sock' } },
      { type: 'notification', method: 'session/closed', params: { sessionId: 's1' } },
    ];

    // string pushes
    const r1 = decoder.push(encodeMessage(msgs[0]));
    expect(r1).toHaveLength(1);

    // Buffer pushes
    const r2 = decoder.push(Buffer.from(encodeMessage(msgs[1]), 'utf8'));
    expect(r2).toHaveLength(1);

    const r3 = decoder.push(encodeMessage(msgs[2]));
    expect(r3).toHaveLength(1);

    expect(r1[0]).toMatchObject({ type: 'request', id: 1 });
    expect(r2[0]).toMatchObject({ type: 'response', id: 1 });
    expect(r3[0]).toMatchObject({ type: 'notification', method: 'session/closed' });
  });

  it('handles a realistic multi-chunk stream', () => {
    const decoder = new NDJSONDecoder();
    const line1 = encodeMessage({ type: 'request', id: 1, method: 'protocol/hello', params: { protocolVersion: 1 } });
    const line2 = encodeMessage({ type: 'response', id: 1, result: { protocolVersion: 1 } });
    const line3 = encodeMessage({ type: 'notification', method: 'session/closed', params: { sessionId: 'x' } });

    // 模拟 TCP chunk 边界: 随机切分
    const combined = line1 + line2 + line3;
    const buf = Buffer.from(combined, 'utf8');

    const r1 = decoder.push(buf.subarray(0, 50));  // 第一块
    const r2 = decoder.push(buf.subarray(50, 120)); // 第二块
    const r3 = decoder.push(buf.subarray(120));     // 余下

    const all = [...r1, ...r2, ...r3];
    expect(all).toHaveLength(3);
  });
});
