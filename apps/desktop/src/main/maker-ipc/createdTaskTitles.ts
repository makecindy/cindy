/** The execution host installs its title writer when maker IPC is ready. Channel and
 * storage modules can use it without loading the maker runtime during their own startup. */
export interface CreatedTaskTitle {
  initialTitle: string;
  format?: (topic: string) => string;
  compose?: (topic: string) => Promise<string | null>;
}

interface TaskTitleWriter {
  refine(id: string, subject: string, creation?: CreatedTaskTitle): Promise<string | null>;
  mayRefine(id: string): boolean;
  persistInitial(id: string, title: string, initialTitle: string): Promise<boolean>;
}

let writer: TaskTitleWriter | undefined;
export function installTaskTitleWriter(host: TaskTitleWriter): void { writer = host; }

export function refineCreatedTaskTitle(id: string, subject: string, creation?: CreatedTaskTitle): Promise<string | null> {
  return writer?.refine(id, subject, creation) ?? Promise.resolve(null);
}

export function mayRefineTaskTitle(id: string): boolean {
  return writer?.mayRefine(id) ?? true;
}

export function persistInitialTaskTitle(id: string, title: string, initialTitle: string): Promise<boolean> {
  return writer?.persistInitial(id, title, initialTitle) ?? Promise.resolve(false);
}
