import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ENDPOINT_FILE = 'host-endpoint.json';

/** Called only while holding the profile's service lease. */
export function publishHostEndpoint(profile, baseUrl, instanceId, pid = process.pid) {
  const file = path.join(profile, ENDPOINT_FILE);
  const record = { pid, baseUrl, instanceId };
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      // A late cleanup must never remove a replacement process's endpoint.
      if (current.instanceId === instanceId && current.pid === pid) fs.rmSync(file, { force: true });
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  };
}

export function readHostEndpoint(profile) {
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(profile, ENDPOINT_FILE), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const url = new URL(record.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.origin !== record.baseUrl || !url.port
      || !Number.isSafeInteger(record.pid) || record.pid < 1) throw new Error('Invalid local Host endpoint');
  return record;
}

async function controlRequest(profile, endpoint, pathname, body) {
  const token = fs.readFileSync(path.join(profile, 'host-api-token'), 'utf8').trim();
  const response = await fetch(`${endpoint.baseUrl}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`,
      ...(endpoint.instanceId ? { 'x-cindy-host-instance': endpoint.instanceId } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Host control request failed (${response.status})`);
  return response.json();
}

export async function readHostProcessStatus(profile) {
  const endpoint = readHostEndpoint(profile);
  if (!endpoint) return { running: false };
  try {
    const health = await controlRequest(profile, endpoint, '/health');
    if (endpoint.instanceId && health.instanceId !== endpoint.instanceId) throw new Error('Host endpoint belongs to another instance');
    if (health.clientProtocol === 1 && health.pid !== endpoint.pid) throw new Error('Host process identity changed');
    return { running: true, pid: endpoint.pid, baseUrl: endpoint.baseUrl, runtime: health.runtime, instanceId: health.instanceId,
      ...(health.clientProtocol === undefined ? {} : { clientProtocol: health.clientProtocol }) };
  } catch (error) {
    // An unresponsive service is not proof that its process has exited.
    return { running: null, pid: endpoint.pid, baseUrl: endpoint.baseUrl, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function requestHostStop(profile) {
  const endpoint = readHostEndpoint(profile);
  if (!endpoint) return { stopping: false, running: false };
  if (typeof endpoint.instanceId !== 'string' || !endpoint.instanceId) throw new Error('This Host does not support managed stop; stop its foreground process');
  return controlRequest(profile, endpoint, '/control/stop', { instanceId: endpoint.instanceId });
}

export async function requestHostRemote(profile, action, deviceId) {
  const endpoint = readHostEndpoint(profile);
  if (!endpoint?.instanceId) throw new Error('Start Cindy Host first using the same data directory');
  return controlRequest(profile, endpoint, '/control/remote', { instanceId: endpoint.instanceId, action, deviceId });
}
