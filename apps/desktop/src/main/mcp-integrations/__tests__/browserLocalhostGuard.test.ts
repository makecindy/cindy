import { describe, expect, it } from 'vitest';

import {
  inspectLocalhostUrl,
  isAllowedLocalhostPort,
  isLoopbackHostname,
  LocalhostPortBlockedError,
  normalizeLocalhostHostname,
} from '../browser-localhost-guard.js';

describe('normalizeLocalhostHostname', () => {
  it('lowercases and strips trailing dots like the SSRF guard', () => {
    expect(normalizeLocalhostHostname('LOCALHOST.')).toBe('localhost');
    expect(normalizeLocalhostHostname('localhost...')).toBe('localhost');
    expect(normalizeLocalhostHostname('Example.COM')).toBe('example.com');
  });

  it('unwraps bracketed IPv6 literals', () => {
    expect(normalizeLocalhostHostname('[::1]')).toBe('::1');
  });
});

describe('isLoopbackHostname', () => {
  it('recognizes localhost and its trailing-dot / subdomain forms', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('localhost.')).toBe(true);
    expect(isLoopbackHostname('LOCALHOST')).toBe(true);
    expect(isLoopbackHostname('foo.localhost')).toBe(true);
  });

  it('recognizes the whole 127.0.0.0/8 loopback block', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    // P2: matching only 127.0.0.1 would miss these aliases.
    expect(isLoopbackHostname('127.0.1.1')).toBe(true);
    expect(isLoopbackHostname('127.255.255.255')).toBe(true);
  });

  it('recognizes ::1 and 0.0.0.0', () => {
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('0.0.0.0')).toBe(true);
  });

  it('does not treat public or private LAN hosts as loopback', () => {
    expect(isLoopbackHostname('example.com')).toBe(false);
    expect(isLoopbackHostname('192.168.1.1')).toBe(false);
    expect(isLoopbackHostname('10.0.0.1')).toBe(false);
    expect(isLoopbackHostname('169.254.169.254')).toBe(false);
    expect(isLoopbackHostname('')).toBe(false);
  });
});

describe('isAllowedLocalhostPort', () => {
  it('allows ordinary dev-preview high ports', () => {
    for (const port of [3000, 5173, 8000, 8080, 4173, 4321, 5174, 9000]) {
      expect(isAllowedLocalhostPort(port)).toBe(true);
    }
  });

  it('allows 80 / 443 (local reverse proxies are common preview targets)', () => {
    expect(isAllowedLocalhostPort(80)).toBe(true);
    expect(isAllowedLocalhostPort(443)).toBe(true);
  });

  it('blocks known sensitive service ports even when the user approves localhost', () => {
    for (const port of [
      22, // SSH
      3306, // MySQL
      5432, // PostgreSQL
      6379, // Redis
      27017, // MongoDB
      9200, // Elasticsearch
      11211, // Memcached
      5672, // RabbitMQ
      18800, // managed Chrome CDP
      18791, // browser control server
    ]) {
      expect(isAllowedLocalhostPort(port)).toBe(false);
    }
  });

  it('rejects invalid ports', () => {
    expect(isAllowedLocalhostPort(0)).toBe(false);
    expect(isAllowedLocalhostPort(70000)).toBe(false);
    expect(isAllowedLocalhostPort(-1)).toBe(false);
    expect(isAllowedLocalhostPort(3.5)).toBe(false);
  });
});

describe('inspectLocalhostUrl', () => {
  it('flags http://localhost./ with a trailing dot (the SSRF bypass)', () => {
    const r = inspectLocalhostUrl('http://localhost./');
    expect(r.isLoopback).toBe(true);
    expect(r.allowed).toBe(true);
  });

  it('flags 127.0.0.1 and fills the default port', () => {
    const r = inspectLocalhostUrl('http://127.0.0.1/');
    expect(r.isLoopback).toBe(true);
    expect(r.port).toBe(80);
  });

  it('reports the port and rejects sensitive ports', () => {
    const blocked = inspectLocalhostUrl('http://localhost:6379/');
    expect(blocked.isLoopback).toBe(true);
    expect(blocked.port).toBe(6379);
    expect(blocked.allowed).toBe(false);

    const ok = inspectLocalhostUrl('http://localhost:5173/');
    expect(ok.isLoopback).toBe(true);
    expect(ok.port).toBe(5173);
    expect(ok.allowed).toBe(true);
  });

  it('treats non-loopback hosts as not-this-guard concern', () => {
    expect(inspectLocalhostUrl('https://example.com/').isLoopback).toBe(false);
    expect(inspectLocalhostUrl('http://192.168.1.5:3000/').isLoopback).toBe(false);
  });

  it('returns not-loopback for non-http(s) and unparseable URLs', () => {
    expect(inspectLocalhostUrl('file:///etc/passwd').isLoopback).toBe(false);
    expect(inspectLocalhostUrl('not a url').isLoopback).toBe(false);
    expect(inspectLocalhostUrl('').isLoopback).toBe(false);
  });
});

describe('LocalhostPortBlockedError', () => {
  it('carries the port and an explanatory message', () => {
    const err = new LocalhostPortBlockedError('http://localhost:6379/', 6379);
    expect(err.name).toBe('LocalhostPortBlockedError');
    expect(err.port).toBe(6379);
    expect(err.message).toContain('6379');
  });
});
