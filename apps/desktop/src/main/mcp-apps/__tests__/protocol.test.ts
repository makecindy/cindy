import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import {
  appCsp,
  boundedAppRecord,
  readAppResource,
  safeAppLink,
  toolVisibleTo,
  uiToolUri,
  MCP_APPS_MAX_BYTES,
  MCP_APPS_MAX_CARD_BYTES,
} from '../protocol.js';

vi.mock('../../i18n.js', () => ({ t: (key: string) => ({ 'mcpApps.pluginTrust.unverified': '未验证', 'mcpApps.pluginTrust.reviewed': '已审核' })[key] ?? key }));
import { projectMcpAppHistory } from '../history.js';

const tool = (ui: unknown): Tool => ({
  name: 'example',
  inputSchema: { type: 'object' },
  _meta: { ui },
});
const uri = 'ui://example/app.html';
const card = (result: NonNullable<McpAppRecord['result']>): McpAppRecord => ({
  version: 1,
  serverId: 'example',
  serverRevision: 'revision',
  resourceUri: uri,
  tool: tool({ resourceUri: uri }),
  arguments: {},
  result,
});
describe('standard MCP Apps metadata and policy', () => {
  it('preserves a complete card at the byte limit and replaces a result one byte over it', () => {
    const record = card({ content: [{ type: 'text', text: '' }], _meta: { viewOnly: true } });
    const overhead = Buffer.byteLength(JSON.stringify({ mcpApp: record }));
    record.result!.content = [
      { type: 'text', text: 'x'.repeat(MCP_APPS_MAX_CARD_BYTES - overhead) },
    ];
    expect(Buffer.byteLength(JSON.stringify({ mcpApp: record }))).toBe(MCP_APPS_MAX_CARD_BYTES);
    expect(boundedAppRecord(record)).toBe(record);
    const oversized = {
      ...record,
      result: {
        ...record.result!,
        content: [{ type: 'text', text: 'x'.repeat(MCP_APPS_MAX_CARD_BYTES - overhead + 1) }],
      },
    };
    expect(Buffer.byteLength(JSON.stringify({ mcpApp: oversized }))).toBe(
      MCP_APPS_MAX_CARD_BYTES + 1,
    );
    expect(boundedAppRecord(oversized).result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'MCP_APP_RESULT_TOO_LARGE' }],
    });
    expect(record.result!._meta).toEqual({ viewOnly: true });
  });
  it.each(['multibyte text', 'View-only metadata'] as const)(
    'includes %s in the serialized byte budget',
    (kind) => {
      const record = card(
        kind === 'multibyte text'
          ? { content: [{ type: 'text', text: '汉'.repeat(MCP_APPS_MAX_CARD_BYTES / 2) }] }
          : {
              content: [{ type: 'text', text: 'small' }],
              _meta: { viewOnly: 'x'.repeat(MCP_APPS_MAX_CARD_BYTES) },
            },
      );
      if (kind === 'multibyte text')
        expect(JSON.stringify({ mcpApp: record }).length).toBeLessThan(MCP_APPS_MAX_CARD_BYTES);
      expect(boundedAppRecord(record).result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'MCP_APP_RESULT_TOO_LARGE' }],
      });
    },
  );
  it('bounds the whole card when input and result each fit separately', () => {
    const record = card({
      content: [{ type: 'text', text: 'x'.repeat(MCP_APPS_MAX_CARD_BYTES / 2) }],
    });
    record.arguments = { draft: 'y'.repeat(MCP_APPS_MAX_CARD_BYTES / 2) };
    expect(Buffer.byteLength(JSON.stringify(record.result))).toBeLessThan(MCP_APPS_MAX_CARD_BYTES);
    const bounded = boundedAppRecord(record);
    expect(bounded.arguments).toEqual(record.arguments);
    expect(bounded.result!.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ mcpApp: bounded }))).toBeLessThanOrEqual(
      MCP_APPS_MAX_CARD_BYTES,
    );
  });
  it('uses the standard same-origin base URI default for omitted and empty declarations', () => {
    expect(appCsp().header).toContain("base-uri 'self'");
    expect(appCsp().header).toContain("form-action 'none'");
    expect(appCsp({ csp: { baseUriDomains: [] } }).header).toContain("base-uri 'self'");
    expect(appCsp({ csp: { baseUriDomains: ['https://assets.example.org'] } }).header).toContain(
      'base-uri https://assets.example.org',
    );
  });
  it('defaults tools to both audiences and enforces explicit visibility', () => {
    expect(toolVisibleTo(tool({}), 'app')).toBe(true);
    expect(toolVisibleTo(tool({}), 'model')).toBe(true);
    expect(toolVisibleTo(tool({ visibility: ['app'] }), 'model')).toBe(false);
    expect(toolVisibleTo(tool({ visibility: ['model'] }), 'app')).toBe(false);
    expect(toolVisibleTo(tool({ visibility: 'app' }), 'app')).toBe(false);
    expect(uiToolUri(tool({ resourceUri: uri }))).toBe(uri);
    expect(uiToolUri({ ...tool({}), _meta: { 'ui/resourceUri': uri } })).toBe(uri);
    expect(uiToolUri(tool({ resourceUri: 'https://example.org/app' }))).toBeUndefined();
  });
  it('reads text or base64 HTML and honors read metadata before list metadata', () => {
    const html = '<!doctype html><html><body>标准应用</body></html>';
    for (const data of [{ text: html }, { blob: Buffer.from(html).toString('base64') }]) {
      expect(
        readAppResource(
          { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', ...data }] },
          uri,
          { prefersBorder: false },
        ),
      ).toEqual({ html, meta: { prefersBorder: false } });
    }
    expect(
      readAppResource(
        {
          contents: [
            {
              uri,
              mimeType: 'text/html;profile=mcp-app',
              text: html,
              _meta: { ui: { prefersBorder: true } },
            },
          ],
        },
        uri,
        { prefersBorder: false },
      ).meta.prefersBorder,
    ).toBe(true);
  });
  it('rejects wrong URI, MIME, invalid base64 and oversized resource bytes', () => {
    expect(() =>
      readAppResource({ contents: [{ uri, text: '', mimeType: 'text/html' }] }, uri),
    ).toThrow('MCP_APP_RESOURCE_MISSING');
    expect(() =>
      readAppResource(
        { contents: [{ uri: 'ui://other', text: '', mimeType: 'text/html;profile=mcp-app' }] },
        uri,
      ),
    ).toThrow('MCP_APP_RESOURCE_MISSING');
    expect(() =>
      readAppResource(
        { contents: [{ uri, blob: '!!invalid!!', mimeType: 'text/html;profile=mcp-app' }] },
        uri,
      ),
    ).toThrow('MCP_APP_INVALID_RESOURCE');
    expect(() =>
      readAppResource(
        {
          contents: [
            {
              uri,
              text: '汉'.repeat(MCP_APPS_MAX_BYTES / 3 + 1),
              mimeType: 'text/html;profile=mcp-app',
            },
          ],
        },
        uri,
      ),
    ).toThrow('MCP_APP_RESOURCE_TOO_LARGE');
  });
  it('restricts omitted domains and keeps each declared domain in its directive', () => {
    expect(appCsp().header).toContain("connect-src 'none'; frame-src 'none'; base-uri 'self'");
    const policy = appCsp({
      csp: {
        connectDomains: ['https://api.example.org', 'wss://*.example.org:443'],
        resourceDomains: ['https://cdn.example.org'],
        frameDomains: ['https://frame.example.org'],
        baseUriDomains: ['https://base.example.org'],
      },
    });
    expect(policy.header).toContain('connect-src https://api.example.org wss://*.example.org:443');
    expect(policy.header).toContain('frame-src https://frame.example.org');
    expect(policy.header).toContain('base-uri https://base.example.org');
    expect(policy.header).not.toContain("'unsafe-eval'");
  });
  it.each([
    'https://example.org; script-src *',
    '*',
    'file://local',
    'data:',
    'https://user:password@example.org',
    'https://example.org/path',
    "https://example.org 'unsafe-eval'",
    'https://example.org:99999',
  ])('rejects CSP source injection: %s', (source) => {
    expect(() => appCsp({ csp: { connectDomains: [source] } })).toThrow();
  });
  it.each([
    'file:///C:/secret',
    'javascript:alert(1)',
    'data:text/html,x',
    'https://user:secret@example.org',
    'not a URL',
  ])('rejects privileged or malformed links: %s', (url) => {
    expect(() => safeAppLink(url)).toThrow('MCP_APP_INVALID_LINK');
  });
});

// Regression F07/F19: the public history projection stripped the Host badge.
// Exercise the production projector, retaining no private schema/result. Tier: unit.
it.each(['unverified', 'reviewed'])('projects Host plugin trust in the existing public title: %s', (trust) => {
  const record = card({ content: [{ type: 'text', text: 'public' }], _meta: { secret: 'private' } });
  record.tool._meta = { 'cindy/plugin': { name: 'Planner', trust } };
  const content = { mcpApp: record };
  const expected = { mcpAppHistory: { version: 1, title: `Planner · ${trust === 'unverified' ? '未验证' : '已审核'}`, text: 'public' } };
  expect(projectMcpAppHistory(content, true)).toEqual(expected);
  expect(projectMcpAppHistory(JSON.stringify(content), true)).toEqual(expected);
  expect(projectMcpAppHistory(content, false)).toBe(content);
});
