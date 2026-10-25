import path from 'node:path';
import { superviseTerminal } from './service-supervisor.js';
import { validateHostCommand } from './host-command.js';

const [entry, profile, hostJson, ...extra] = process.argv.slice(2);
if (extra.length || ![entry, profile].every(value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value))) {
  process.stderr.write('INVALID_SERVICE_PATH\n');
  process.exitCode = 1;
} else {
  void Promise.resolve().then(()=>superviseTerminal(entry, profile, hostJson?validateHostCommand(JSON.parse(hostJson)):undefined)).catch(() => {
    process.stderr.write('SERVICE_SUPERVISOR_FAILED\n');
    process.exitCode = 1;
  });
}
