import { stdin, stdout } from 'node:process';

export type TerminalCommand = {
  name: string;
  description: string;
};

type Activity = { label: string; startedAt: number };
type Picker<T> = {
  title: string;
  choices: readonly T[];
  display: (choice: T) => string;
  selected: number;
  resolve: (choice: T) => void;
  reject: (error: Error) => void;
};

/**
 * Scores a slash-command candidate without inventing commands that Cindy does
 * not implement. Prefix matches win, then the remaining results are ranked by
 * their ordered-character match just like a lightweight command palette.
 */
export function matchTerminalCommands(input: string, commands: readonly TerminalCommand[]): TerminalCommand[] {
  if (!input.startsWith('/')) return [];
  const query = input.slice(1).trim().toLowerCase();
  if (input.includes(' ') && query.includes(' ')) return [];
  return commands
    .map((command, index) => ({ command, index, score: commandScore(command.name, query) }))
    .filter((item): item is { command: TerminalCommand; index: number; score: number } => item.score !== undefined)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.command);
}

function commandScore(name: string, query: string): number | undefined {
  if (!query) return 1;
  const candidate = name.slice(1).toLowerCase();
  if (candidate.startsWith(query)) return 10_000;
  let cursor = 0;
  let score = 0;
  for (const character of query) {
    const index = candidate.indexOf(character, cursor);
    if (index === -1) return undefined;
    score += 10 - Math.min(9, index - cursor);
    cursor = index + 1;
  }
  return score;
}

/** Wraps text by terminal columns so the redraw loop never relies on wrapping side effects. */
export function wrapTerminalText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line) return [''];
    const characters = [...line];
    const lines: string[] = [];
    for (let start = 0; start < characters.length; start += safeWidth) {
      lines.push(characters.slice(start, start + safeWidth).join(''));
    }
    return lines;
  });
}

/**
 * A small full-screen terminal shell. It deliberately owns only presentation
 * state: the daemon remains the source of truth for sessions and turns, which
 * keeps SSH reconnects and remote mobile control independent from this UI.
 */
export class CindyTerminalUi {
  private readonly commands: readonly TerminalCommand[];
  private readonly onSubmit: (value: string) => void;
  private readonly onInterrupt: () => void;
  private readonly onExit: () => void;
  private readonly inputHandler: (value: Buffer) => void;
  private header: string[] = ['Cindy'];
  private transcript: string[] = [];
  private input = '';
  private suggestionIndex = 0;
  private activity: Activity | undefined;
  private picker: Picker<unknown> | undefined;
  private redrawTimer: ReturnType<typeof setInterval> | undefined;
  private mounted = false;

  constructor(options: {
    commands: readonly TerminalCommand[];
    onSubmit: (value: string) => void;
    onInterrupt: () => void;
    onExit: () => void;
  }) {
    this.commands = options.commands;
    this.onSubmit = options.onSubmit;
    this.onInterrupt = options.onInterrupt;
    this.onExit = options.onExit;
    this.inputHandler = (value) => this.handleInput(value);
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', this.inputHandler);
    stdout.write('\x1b[?1049h\x1b[?25l');
    this.redrawTimer = setInterval(() => this.render(), 250);
    this.render();
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    if (this.redrawTimer) clearInterval(this.redrawTimer);
    this.redrawTimer = undefined;
    stdin.off('data', this.inputHandler);
    stdin.setRawMode(false);
    stdout.write('\x1b[?25h\x1b[?1049l');
  }

  setHeader(lines: string[]): void {
    this.header = lines;
    this.render();
  }

  addTranscript(text: string): void {
    this.transcript.push(...wrapTerminalText(text, this.columns() - 2));
    // Keep the terminal client bounded; the durable complete history belongs
    // to Cindy session storage and can always be resumed on another device.
    if (this.transcript.length > 2_000) this.transcript.splice(0, this.transcript.length - 2_000);
    this.render();
  }

  clearTranscript(): void {
    this.transcript = [];
    this.render();
  }

  setActivity(label?: string): void {
    this.activity = label ? { label, startedAt: Date.now() } : undefined;
    this.render();
  }

  async choose<T>(title: string, choices: readonly T[], display: (choice: T) => string): Promise<T> {
    if (choices.length === 0) throw new Error(`${title} has no choices.`);
    if (this.picker) throw new Error('Another terminal selection is already open.');
    return new Promise<T>((resolve, reject) => {
      this.picker = { title, choices, display, selected: 0, resolve, reject };
      this.render();
    });
  }

  private handleInput(buffer: Buffer): void {
    const value = buffer.toString('utf8');
    if (this.picker) {
      this.handlePickerInput(value);
      return;
    }
    if (value === '\u0003') {
      this.onInterrupt();
      return;
    }
    if (value === '\u0004') {
      if (!this.input) this.onExit();
      return;
    }
    if (value === '\f') {
      this.render();
      return;
    }
    if (value === '\u001b') {
      if (this.activity) this.onInterrupt();
      return;
    }
    if (value === '\u001b[A') {
      this.moveSuggestion(-1);
      return;
    }
    if (value === '\u001b[B') {
      this.moveSuggestion(1);
      return;
    }
    if (value === '\t') {
      this.completeSuggestion();
      return;
    }
    if (value === '\r') {
      this.submit();
      return;
    }
    if (value === '\n') {
      // Most terminals send Enter as CR. Ctrl+J therefore provides a stable
      // multi-line composer shortcut over SSH without intercepting Enter.
      this.input += '\n';
      this.render();
      return;
    }
    if (value === '\u007f' || value === '\b') {
      this.input = [...this.input].slice(0, -1).join('');
      this.suggestionIndex = 0;
      this.render();
      return;
    }
    if (value.startsWith('\u001b')) return;
    // Bracketed pastes and ordinary UTF-8 text are inserted as one operation.
    this.input += value.replace(/\r?\n/g, ' ');
    this.suggestionIndex = 0;
    this.render();
  }

  private handlePickerInput(value: string): void {
    const picker = this.picker;
    if (!picker) return;
    if (value === '\u001b' || value === '\u0003') {
      this.picker = undefined;
      picker.reject(new Error('Selection cancelled.'));
    } else if (value === '\u001b[A') {
      picker.selected = (picker.selected - 1 + picker.choices.length) % picker.choices.length;
    } else if (value === '\u001b[B') {
      picker.selected = (picker.selected + 1) % picker.choices.length;
    } else if (value === '\r' || value === '\n') {
      this.picker = undefined;
      picker.resolve(picker.choices[picker.selected]!);
    }
    this.render();
  }

  private suggestions(): TerminalCommand[] {
    return matchTerminalCommands(this.input, this.commands).slice(0, 7);
  }

  private moveSuggestion(direction: number): void {
    const suggestions = this.suggestions();
    if (suggestions.length === 0) return;
    this.suggestionIndex = (this.suggestionIndex + direction + suggestions.length) % suggestions.length;
    this.render();
  }

  private completeSuggestion(): void {
    const suggestions = this.suggestions();
    const selected = suggestions[this.suggestionIndex];
    if (!selected) return;
    this.input = selected.name;
    this.suggestionIndex = 0;
    this.render();
  }

  private submit(): void {
    const value = this.input.trim();
    if (!value) return;
    const suggestions = this.suggestions();
    if (value.startsWith('/') && suggestions.length > 0 && value !== suggestions[0]?.name) {
      this.completeSuggestion();
      return;
    }
    this.input = '';
    this.suggestionIndex = 0;
    this.onSubmit(value);
    this.render();
  }

  private render(): void {
    if (!this.mounted) return;
    const columns = this.columns();
    const rows = Math.max(10, stdout.rows || 24);
    const suggestions = this.suggestions();
    const pickerLines = this.picker ? this.renderPicker(columns) : [];
    const status = this.activity
      ? `• ${this.activity.label} (${Math.floor((Date.now() - this.activity.startedAt) / 1_000)}s · esc to interrupt)`
      : 'Ready · / for commands · ctrl+j newline · ctrl+c interrupt · ctrl+d quit';
    const composerLines = wrapTerminalText(`› ${this.input || 'Ask Cindy anything…'}`, columns);
    const suggestionLines = !this.picker && suggestions.length > 0
      ? suggestions.map((command, index) => `${index === this.suggestionIndex ? '›' : ' '} ${command.name.padEnd(15)} ${command.description}`)
      : [];
    const fixed = this.header.length + 1 + pickerLines.length + suggestionLines.length + composerLines.length + 2;
    const transcriptRows = Math.max(1, rows - fixed);
    const transcript = this.transcript.slice(-transcriptRows);
    const lines = [
      ...this.header.map((line) => truncate(line, columns)),
      '─'.repeat(columns),
      ...transcript.map((line) => truncate(line, columns)),
      ...Array.from({ length: Math.max(0, transcriptRows - transcript.length) }, () => ''),
      ...pickerLines,
      ...suggestionLines,
      truncate(status, columns),
      ...composerLines.map((line) => truncate(line, columns)),
    ];
    stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}\x1b[H`);
  }

  private renderPicker(columns: number): string[] {
    const picker = this.picker;
    if (!picker) return [];
    const visible = picker.choices.slice(Math.max(0, picker.selected - 3), picker.selected + 4);
    return [
      `┌ ${picker.title} ${'─'.repeat(Math.max(0, columns - picker.title.length - 3))}`,
      ...visible.map((choice) => {
        const actualIndex = picker.choices.indexOf(choice);
        return `${actualIndex === picker.selected ? '›' : ' '} ${picker.display(choice)}`;
      }),
      '└ ↑↓ choose · enter confirm · esc cancel',
    ].map((line) => truncate(line, columns));
  }

  private columns(): number {
    return Math.max(48, stdout.columns || 80);
  }
}

function truncate(value: string, width: number): string {
  const characters = [...value];
  return characters.length <= width ? value : `${characters.slice(0, Math.max(1, width - 1)).join('')}…`;
}
