import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { llamaCppProcessCommand } from '../llamaCppProcess.js';

const listener = `require('node:net').createServer().listen(0,'127.0.0.1',function(){console.log(JSON.stringify({port:this.address().port}))});`;
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(true));
  });

describe('llama.cpp process ownership', () => {
  it('keeps Windows non-detached spawning free of shell wrapping', () => {
    expect(llamaCppProcessCommand('server.exe', ['--port', '11435'], 'win32')).toEqual({
      binary: 'server.exe',
      args: ['--port', '11435'],
    });
  });
  it.skipIf(process.platform === 'win32').each(['owner-kill', 'pipe-close', 'stop'] as const)(
    'releases router and descendant ports on %s',
    async (action) => {
      const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(listener)}],{stdio:['ignore','inherit','inherit']});${listener}`;
      const command = llamaCppProcessCommand(process.execPath, ['-e', program]);
      const owner = spawn(
        process.execPath,
        [
          '-e',
          `
      const child=require('node:child_process').spawn(${JSON.stringify(command.binary)},${JSON.stringify(command.args)},{detached:true,stdio:['pipe','pipe','inherit']});
      console.log(JSON.stringify({group:child.pid})); child.stdout.pipe(process.stdout);
      process.stdin.on('data',()=>child.kill('SIGTERM'));
      process.stdin.on('end',()=>child.stdin.end());
    `,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let buffer = '';
      let group = 0;
      const ports: number[] = [];
      owner.stdout!.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const value = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (value.group) group = value.group;
          if (value.port) ports.push(value.port);
        }
      });
      try {
        await expect.poll(() => ports.length, { timeout: 8000 }).toBe(2);
        if (action === 'owner-kill') owner.kill('SIGKILL');
        else if (action === 'pipe-close') owner.stdin!.end();
        else owner.stdin!.write('stop');
        await expect
          .poll(async () => Promise.all(ports.map(listening)), { timeout: 8000 })
          .toEqual([false, false]);
      } finally {
        owner.kill('SIGKILL');
        if (group) {
          try {
            process.kill(-group, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    },
    20_000,
  );
});
