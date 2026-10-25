/** The application owns log destinations and redaction; storage never opens a UI. */
export interface DbLogger {
  debug(message: string, ...fields: unknown[]): void;
  info(message: string, ...fields: unknown[]): void;
  warn(message: string, ...fields: unknown[]): void;
  error(message: string, ...fields: unknown[]): void;
}
