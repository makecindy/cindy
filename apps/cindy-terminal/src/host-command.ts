import path from 'node:path';

/** A bootstrap-owned command, never accepted from remote business RPC. */
export interface TerminalHostCommand {
  executable: string;
  args: string[];
}

export function validateHostCommand(value: unknown): TerminalHostCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SERVICE_PATH');
  const command = value as TerminalHostCommand;
  if (typeof command.executable !== 'string' || !path.isAbsolute(command.executable)
    || /[\r\n\0]/.test(command.executable) || !Array.isArray(command.args)
    || command.args.length > 16 || command.args.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg)))
    throw new Error('INVALID_SERVICE_PATH');
  return { executable: command.executable, args: [...command.args] };
}
