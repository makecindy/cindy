import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createWebSocketHandshakeTiming } from '../webSocketHandshakeTiming';

function harness() {
  let clock = 100;
  const timing = createWebSocketHandshakeTiming(() => clock);
  const request = Object.assign(new EventEmitter(), { end: vi.fn(), reusedSocket: false });
  timing.finishRequest(request as unknown as ClientRequest);
  return {
    timing,
    request,
    at: (elapsed: number) => {
      clock = 100 + elapsed;
    },
  };
}

it('ends the request immediately and separates DNS, TCP, TLS and upgrade milestones', () => {
  const h = harness();
  expect(h.request.end).toHaveBeenCalledTimes(1);
  const socket = Object.assign(new EventEmitter(), {
    encrypted: true,
    isSessionReused: () => false,
  });
  h.at(1);
  h.request.emit('socket', socket);
  h.at(10);
  socket.emit('lookup', null);
  h.at(200);
  socket.emit('connect');
  h.at(450);
  socket.emit('secureConnect');
  h.at(700);
  h.request.emit('upgrade');
  expect(h.timing.snapshot()).toEqual({
    socketAssignedMs: 1,
    dnsResolvedMs: 10,
    tcpConnectedMs: 200,
    tlsConnectedMs: 450,
    upgradeResponseMs: 700,
    responseWaitMs: 250,
    reusedSocket: false,
    tlsResumed: false,
  });
});

it('does not invent zero-cost handshake stages for a reused socket', () => {
  const h = harness();
  h.request.reusedSocket = true;
  h.at(1);
  h.request.emit('socket', new EventEmitter());
  h.at(300);
  h.request.emit('upgrade');
  expect(h.timing.snapshot()).toEqual({
    socketAssignedMs: 1,
    upgradeResponseMs: 300,
    responseWaitMs: 299,
    reusedSocket: true,
  });
});

it('records rejected upgrades and distinguishes a preconnected proxy socket from reuse', () => {
  const h = harness();
  h.at(900);
  h.request.emit('socket', new EventEmitter());
  h.at(1200);
  h.request.emit('response');
  expect(h.timing.snapshot()).toEqual({
    socketAssignedMs: 900,
    upgradeResponseMs: 1200,
    responseWaitMs: 300,
    reusedSocket: false,
  });
});
