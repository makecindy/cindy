import { expect, it } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import { bindDeviceAuthorizationTarget } from '../targetPolicy.js';

const manifest = {
  id: 'test-plugin',
  version: '1.0.0',
  network: { hosts: ['provider.example'] },
} as GhostManifest;
it('rejects unrelated domains, alternate ports, credentials and insecure schemes', () => {
  for (const url of [
    'https://attacker.example/device',
    'https://provider.example.attacker.example/device',
    'https://provider.example:8443/device',
    'https://user@provider.example/device',
    'http://provider.example/device',
  ]) {
    expect(() => bindDeviceAuthorizationTarget(manifest, url)).toThrow();
  }
});
it('pins the current plugin declaration throughout the live authorization', () => {
  const check = bindDeviceAuthorizationTarget(manifest, 'https://provider.example/device');
  expect(() => check(manifest)).not.toThrow();
  expect(() => check({ ...manifest, network: { hosts: ['attacker.example'] } })).toThrow();
  expect(() => check({ ...manifest, id: 'other-plugin' })).toThrow();
  expect(() => check({ ...manifest, version: '2.0.0' })).toThrow();
});
it('rejects a generic CLI target when no trusted declaration exists', () => {
  expect(() =>
    bindDeviceAuthorizationTarget(
      { ...manifest, network: undefined },
      'https://provider.example/device',
    ),
  ).toThrow();
});
it('binds the existing GitHub device adapter to its exact provider endpoint', () => {
  const github = { ...manifest, id: 'cindy-github', network: undefined };
  expect(() =>
    bindDeviceAuthorizationTarget(github, 'https://github.com/login/device'),
  ).not.toThrow();
  for (const url of [
    'https://github.com/other',
    'https://github.com/login/device?next=https://attacker.example',
    'https://github.com/login/device#fragment',
    'https://github.com.attacker.example/login/device',
  ]) {
    expect(() => bindDeviceAuthorizationTarget(github, url)).toThrow();
  }
});
it('binds the reviewed TapTap CLI adapter to its exact PAT route and one private code', () => {
  const maker = { ...manifest, id: 'taptap-maker', network: undefined };
  const url = 'https://maker.taptap.cn/pat-tokens?code=' + 'a'.repeat(32);
  const check = bindDeviceAuthorizationTarget(maker, url);
  expect(() => check(maker)).not.toThrow();
  for (const bad of [
    url + '&redirect=https://attacker.example',
    url + '&code=' + 'a'.repeat(32),
    url.replace('/pat-tokens', '/other'),
    url.replace('maker.taptap.cn', 'attacker.example'),
    url.replace('?code=', '?token='),
    url + '#fragment',
    url.slice(0, -1),
  ]) {
    expect(() => bindDeviceAuthorizationTarget(maker, bad)).toThrow();
  }
  expect(() => check({ ...maker, version: 'changed' })).toThrow();
});
