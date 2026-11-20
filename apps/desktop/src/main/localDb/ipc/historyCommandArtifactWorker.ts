import { createHash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { describeToolUse } from '@cindy/maker-shared/tool-use-descriptor';
import { extractCommandOutputPathCandidates } from '../../../shared/commandOutputPaths';
import type { HistoryCommand, HistoryCommandWorkerRequest } from './historyCommandArtifacts';

const CACHE_LIMIT = 2048;
const cache = new Map<string, readonly string[]>();

function inferArtifacts({ id, toolName, input }: HistoryCommand): readonly string[] {
  const { command, displayCommand } = input;
  // Hash the complete JS strings, including unpaired UTF-16 surrogates, so
  // cached paths are valid even after a row rewrite or a shell wrapper change.
  const digest = createHash('sha256')
    .update(`${toolName}:${command?.length ?? -1}:${displayCommand?.length ?? -1}:`)
    .update(command ?? '', 'utf16le')
    .update(displayCommand ?? '', 'utf16le')
    .digest('base64');
  const key = `${id}\0${digest}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const descriptor = describeToolUse(toolName, input);
  const paths = descriptor.kind === 'command' ? extractCommandOutputPathCandidates(descriptor.command) : [];
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, paths);
  return paths;
}

const port = parentPort;
if (!port) throw new Error('History command worker requires a parent port');
const chunks = { command: [] as string[], displayCommand: [] as string[] };
port.on('message', (request: HistoryCommandWorkerRequest) => {
  if (request.type === 'chunk') {
    chunks[request.field].push(request.text);
    return;
  }
  if (request.type === 'batch') {
    port.postMessage(request.commands.map(inferArtifacts));
    return;
  }
  const input = {
    command: chunks.command.length ? chunks.command.join('') : undefined,
    displayCommand: chunks.displayCommand.length ? chunks.displayCommand.join('') : undefined,
  };
  chunks.command.length = 0;
  chunks.displayCommand.length = 0;
  port.postMessage([inferArtifacts({ id: request.id, toolName: request.toolName, input })]);
});
