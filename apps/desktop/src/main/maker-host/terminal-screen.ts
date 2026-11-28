/**
 * terminal-screen —— 把终端输出还原成屏幕上的文字(纯内存、无 IO)。
 *
 * 官方 CLI 的交互界面是增量刷新的:没变的字符不重发,只移动光标跳过去。直接去掉控制序列
 * 会漏字(2026-11-24 实测:读出的令牌少了两位)。这里按光标位置把每个字符落到网格上,
 * 读到的才是用户在终端里看到的那一屏。
 *
 * 只实现还原文字需要的部分:光标移动、擦除、插入删除、滚动;颜色等显示属性一律忽略。
 * 字符一律按一列计,东亚宽字符所在的行不保证列对齐(这里要读的行只有 ASCII)。
 */

const ESC = '\x1b';

export class TerminalScreen {
  private readonly cols: number;
  private readonly rows: number;
  private grid: string[][];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  /** An escape sequence split across two chunks waits here for its remainder. */
  private pending = '';

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.grid = Array.from({ length: this.rows }, () => this.blankLine());
  }

  /** Screen lines from top to bottom, trailing blanks removed. */
  lines(): string[] {
    return this.grid.map(line => line.join('').trimEnd());
  }

  write(chunk: string): void {
    const data = this.pending + chunk;
    this.pending = '';
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === ESC) {
        const end = this.escape(data, i);
        if (end < 0) {
          this.pending = data.slice(i);
          return;
        }
        i = end;
        continue;
      }
      i += 1;
      if (ch === '\r') this.col = 0;
      else if (ch === '\n') this.lineFeed();
      else if (ch === '\b') this.col = Math.max(0, this.col - 1);
      else if (ch === '\t') this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      else if (ch >= ' ' && ch !== '\x7f') this.print(ch);
    }
  }

  private blankLine(): string[] {
    return Array.from({ length: this.cols }, () => ' ');
  }

  private print(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row][this.col] = ch;
    this.col += 1;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) this.row += 1;
    else this.scroll(1);
  }

  private scroll(count: number): void {
    for (let n = 0; n < count; n += 1) {
      this.grid.shift();
      this.grid.push(this.blankLine());
    }
  }

  private clampCursor(): void {
    this.row = Math.min(this.rows - 1, Math.max(0, this.row));
    this.col = Math.min(this.cols - 1, Math.max(0, this.col));
  }

  /** Consume one escape sequence starting at `start`; -1 when it is not complete yet. */
  private escape(data: string, start: number): number {
    const kind = data[start + 1];
    if (kind === undefined) return -1;
    if (kind === '[') {
      let end = start + 2;
      while (end < data.length && (data.charCodeAt(end) < 0x40 || data.charCodeAt(end) > 0x7e)) end += 1;
      if (end >= data.length) return -1;
      this.control(data.slice(start + 2, end), data[end]);
      return end + 1;
    }
    if (kind === ']' || kind === 'P' || kind === '_' || kind === '^') {
      // Operating-system command and similar strings: skipped up to their terminator.
      for (let end = start + 2; end < data.length; end += 1) {
        if (data[end] === '\x07') return end + 1;
        if (data[end] === ESC && data[end + 1] === '\\') return end + 2;
      }
      return -1;
    }
    if (kind === '(' || kind === ')' || kind === '#' || kind === '%') {
      return start + 2 < data.length ? start + 3 : -1;
    }
    if (kind === '7') this.saved = { row: this.row, col: this.col };
    else if (kind === '8') ({ row: this.row, col: this.col } = this.saved);
    else if (kind === 'M') {
      if (this.row > 0) this.row -= 1;
      else {
        this.grid.pop();
        this.grid.unshift(this.blankLine());
      }
    } else if (kind === 'D') this.lineFeed();
    else if (kind === 'E') {
      this.col = 0;
      this.lineFeed();
    } else if (kind === 'c') {
      this.grid = Array.from({ length: this.rows }, () => this.blankLine());
      this.row = 0;
      this.col = 0;
    }
    return start + 2;
  }

  private control(body: string, final: string): void {
    // Private-mode sequences (cursor visibility, alternate screen, bracketed paste) change no text.
    if (/^[?<=>]/.test(body)) return;
    const params = body.split(';').map(value => Number.parseInt(value, 10));
    const arg = (index: number, fallback: number) => {
      const value = params[index];
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const line = this.grid[this.row];
    switch (final) {
      case 'A': this.row -= arg(0, 1); break;
      case 'B': case 'e': this.row += arg(0, 1); break;
      case 'C': case 'a': this.col += arg(0, 1); break;
      case 'D': this.col -= arg(0, 1); break;
      case 'E': this.row += arg(0, 1); this.col = 0; break;
      case 'F': this.row -= arg(0, 1); this.col = 0; break;
      case 'G': case '`': this.col = arg(0, 1) - 1; break;
      case 'd': this.row = arg(0, 1) - 1; break;
      case 'H': case 'f': this.row = arg(0, 1) - 1; this.col = arg(1, 1) - 1; break;
      case 'J': {
        const mode = Number.isFinite(params[0]) ? params[0] : 0;
        if (mode === 0) {
          line.fill(' ', Math.min(this.col, this.cols));
          for (let r = this.row + 1; r < this.rows; r += 1) this.grid[r] = this.blankLine();
        } else if (mode === 1) {
          line.fill(' ', 0, Math.min(this.col + 1, this.cols));
          for (let r = 0; r < this.row; r += 1) this.grid[r] = this.blankLine();
        } else {
          this.grid = Array.from({ length: this.rows }, () => this.blankLine());
        }
        break;
      }
      case 'K': {
        const mode = Number.isFinite(params[0]) ? params[0] : 0;
        if (mode === 0) line.fill(' ', Math.min(this.col, this.cols));
        else if (mode === 1) line.fill(' ', 0, Math.min(this.col + 1, this.cols));
        else line.fill(' ');
        break;
      }
      case 'X': line.fill(' ', Math.min(this.col, this.cols), Math.min(this.col + arg(0, 1), this.cols)); break;
      case 'P': {
        const count = Math.min(arg(0, 1), this.cols - this.col);
        line.splice(this.col, count);
        line.push(...Array.from({ length: count }, () => ' '));
        break;
      }
      case '@': {
        const count = Math.min(arg(0, 1), this.cols - this.col);
        line.splice(this.col, 0, ...Array.from({ length: count }, () => ' '));
        line.length = this.cols;
        break;
      }
      case 'L': {
        const count = Math.min(arg(0, 1), this.rows - this.row);
        this.grid.splice(this.row, 0, ...Array.from({ length: count }, () => this.blankLine()));
        this.grid.length = this.rows;
        break;
      }
      case 'M': {
        const count = Math.min(arg(0, 1), this.rows - this.row);
        this.grid.splice(this.row, count);
        while (this.grid.length < this.rows) this.grid.push(this.blankLine());
        break;
      }
      case 'S': this.scroll(Math.min(arg(0, 1), this.rows)); break;
      case 'T': {
        for (let n = Math.min(arg(0, 1), this.rows); n > 0; n -= 1) {
          this.grid.pop();
          this.grid.unshift(this.blankLine());
        }
        break;
      }
      case 's': this.saved = { row: this.row, col: this.col }; break;
      case 'u': ({ row: this.row, col: this.col } = this.saved); break;
      default: break;
    }
    this.clampCursor();
  }
}
