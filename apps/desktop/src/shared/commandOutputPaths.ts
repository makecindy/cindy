/**
 * commandOutputPaths —— 从命令文本里派生「这条命令写出了哪个文件」。
 * ---------------------------------------------------------------------------
 * 放在 shared 而不是 renderer/lib:对话里的「本轮产出 / 交付物卡」(renderer
 * generatedFiles.ts)与右栏「交付物」仓库的主进程投影(main localDb/ipc/botArtifacts.ts)
 * 必须用**同一套**判定,否则会出现「对话里有卡、仓库里没有」。这里只做纯文本判定,
 * 不碰 fs、不碰 Electron,两端都能直接 import。
 *
 * 唯一原则:**只认明确写出位置**。命令文本里出现路径 ≠ 命令创建了它(可能只是读输入),
 * 所以收的是重定向、常见 save/write API、输出参数、复制/移动目标,以及少数
 * 「产物位置由命令语义唯一确定」的转换器(见 extractConverterOutputPaths)。
 * 候选是否真的存在、是否落在本轮时间窗内,由调用方在渲染 / 投影前用 stat 复核。
 */

/** 文件候选需带扩展名;复制/移动命令的目录目标可用末尾分隔符明确表达。 */
const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** 临时目录里的产物是脚本自身/中间文件的高发区,一律不算「本轮产出」。 */
const TEMP_DIR_RE = /(^|[\\/])(tmp|temp)([\\/])|[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i;

function isPathCandidate(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 3 || s.length > 512) return false;
  if (!EXT_RE.test(s) && !/[\\/]$/.test(s)) return false;
  if (TEMP_DIR_RE.test(s)) return false;
  // 绝对路径,或含分隔符的相对路径(交给 resolveToolFilePath 按 workingDir 解析)。
  // 纯文件名(`输出.xlsx`)不收:随机带点 token 误报率太高。
  const isAbs = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/');
  const hasSep = s.includes('/') || s.includes('\\');
  return isAbs || hasSep;
}

interface CommandPathToken {
  path: string;
  start: number;
  end: number;
}

interface CommandArgument {
  value: string;
  start: number;
  end: number;
}

function extractCommandArguments(text: string, offset = 0): CommandArgument[] {
  const parsed = [...text.matchAll(/'([^'\r\n]*)'|"([^"\r\n]*)"|([^\s]+)/g)].map((match) => {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const quoted = match[1] !== undefined || match[2] !== undefined;
    const quoteOffset = quoted ? 1 : 0;
    const start = offset + (match.index ?? 0) + quoteOffset;
    return { value, start, end: start + value.length, quoted };
  });
  const merged: typeof parsed = [];
  // POSIX shell 的奇数个尾随反斜杠会转义紧随其后的空白;只消费最后一个反斜杠,
  // 避免把 Windows 路径里的普通反斜杠做全局反转义。
  for (const argument of parsed) {
    const previous = merged.at(-1);
    const trailingBackslashes = previous?.value.match(/\\+$/)?.[0].length ?? 0;
    if (previous && !previous.quoted && !argument.quoted && trailingBackslashes % 2 === 1) {
      const gap = text.slice(previous.end - offset, argument.start - offset);
      if (/^[ \t]+$/.test(gap)) {
        previous.value = `${previous.value.slice(0, -1)}${gap[0]}${argument.value}`;
        previous.end = argument.end;
        continue;
      }
    }
    merged.push(argument);
  }
  return merged.map(({ value, start, end }) => ({ value, start, end }));
}

const RELATIVE_PATH_TOKEN_RE = /(?:^|[\s=(,>])([^\s'"<>|?*]+[\\/])(?=$|[\s'"<>|])/g;

/**
 * 裸(未加引号)的**相对文件**路径只在紧跟输出参数 / 重定向时才取 token。
 * 通用扫描仍只收目录形态(见 RELATIVE_PATH_TOKEN_RE):把任意 `a/b.txt` 都变成
 * 候选会让「读输入」大面积进候选池,只能靠下游 mtime 兜底,得不偿失。而
 * `pandoc in.md -o out/report.pdf`、`node gen.js > out/a.json` 这两种最常见的
 * 写法本身就带明确写出语义,不收就是真丢产物(实测 PDF 场景)。
 * 位置仍交给 isExplicitOutputPath 复核,这里只负责让 token 存在。
 */
const EXPLICIT_OUTPUT_RELATIVE_TOKEN_RE =
  /(?:(?:^|\s)(?:-o|--output(?:-file|-document)?|--outfile)(?:\s+|=)|>{1,2}\s*)([^\s'"<>|?*=]+[\\/][^\s'"<>|?*]*)(?=$|[\s'"<>|;&])/g;

/** 提取路径 token 及其在命令中的位置;写出语义需要靠相邻文本判断。 */
function extractCommandPathTokens(command: string): CommandPathToken[] {
  if (!command) return [];
  const out: CommandPathToken[] = [];
  const quotedRanges: Array<{ start: number; end: number }> = [];
  const push = (raw: string, start: number, end: number): void => {
    const s = raw.trim();
    if (!isPathCandidate(s)) return;
    out.push({ path: s, start, end });
  };
  // 单、双引号分开扫描,才能识别 `node -e "save('C:\\out\\a.xlsx')"` 这类
  // 外层 shell 引号包内层语言字符串的常见形态。合并成一个 alternation 会被外层先吞掉。
  const scanQuoted = (re: RegExp): void => {
    for (const m of command.matchAll(re)) {
      const raw = m[1] ?? '';
      const matchStart = m.index ?? 0;
      quotedRanges.push({ start: matchStart, end: matchStart + m[0].length });
      push(raw, matchStart + 1, matchStart + 1 + raw.length);
    }
  };
  scanQuoted(/'([^'\r\n]+)'/g);
  scanQuoted(/"([^"\r\n]+)"/g);
  // 裸 Windows 盘符路径与裸 POSIX 绝对路径(前面是行首/空白/常见分隔)。
  // 盘符前不允许字母数字:排除 URL scheme 尾字母被当盘符(https://…)。
  const insideQuotedRange = (index: number): boolean =>
    quotedRanges.some((range) => index >= range.start && index < range.end);
  for (const m of command.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"<>|?*]+/g)) {
    const start = m.index ?? 0;
    if (!insideQuotedRange(start)) push(m[0], start, start + m[0].length);
  }
  for (const m of command.matchAll(/(?:^|[\s=(,>])(\/[^\s'"<>|?*:]+)/g)) {
    const start = (m.index ?? 0) + m[0].length - m[1].length;
    if (!insideQuotedRange(start)) push(m[1], start, start + m[1].length);
  }
  for (const m of command.matchAll(RELATIVE_PATH_TOKEN_RE)) {
    const raw = m[1];
    const start = (m.index ?? 0) + m[0].length - raw.length;
    if (!insideQuotedRange(start) && !/^https?:\/\//i.test(raw)) {
      push(raw, start, start + raw.length);
    }
  }
  for (const m of command.matchAll(EXPLICIT_OUTPUT_RELATIVE_TOKEN_RE)) {
    const raw = m[1] ?? '';
    const start = (m.index ?? 0) + m[0].length - raw.length;
    if (!insideQuotedRange(start) && !/^https?:\/\//i.test(raw)) {
      push(raw, start, start + raw.length);
    }
  }
  for (const token of extractTransferPlainFilenameDestinations(command)) {
    out.push(token);
  }
  // 同一段文本可能被多条扫描规则同时命中(例如 `> out/a.json` 既是相对路径又是
  // 输出参数形态)。按位置去重,否则 transferDirectoryOutputs 的来源列表会出现
  // 重复项、chip 也可能重复。
  const seenRanges = new Set<string>();
  return out
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter((token) => {
      const key = `${token.start}:${token.end}:${token.path}`;
      if (seenRanges.has(key)) return false;
      seenRanges.add(key);
      return true;
    });
}

const WRITE_CALL_PREFIX_RE =
  /(?:\.|\b)(?:save|savefig|writeFileSync|writeFile|writeAllText|writeAllBytes|createWriteStream|write_text|write_bytes|to_csv|to_excel|to_json|to_parquet|imwrite|imsave|dump)\s*\(\s*(?:(?:path_or_buf|excel_writer|path|filename|fname|fp|file)\s*=\s*)?(?:[rubf]{0,2})?['"]$/i;
const WRITE_CALL_LATER_KEYWORD_PREFIX_RE =
  /(?:\.|\b)(?:save|savefig|writeFileSync|writeFile|writeAllText|writeAllBytes|createWriteStream|write_text|write_bytes|to_csv|to_excel|to_json|to_parquet|imwrite|imsave|dump)\s*\(\s*[^();\r\n]+,\s*(?:path_or_buf|excel_writer|path|filename|fname|fp|file)\s*=\s*(?:[rubf]{0,2})?['"]$/i;
const OBJECT_FIRST_WRITE_CALL_PREFIX_RE =
  /\b(?:torch\.save|joblib\.dump)\s*\(\s*(?:[^();\r\n]|\([^()]*\))+,\s*(?:[rubf]{0,2})?['"]$/i;
const POWERSHELL_CMDLET_RE = /\b[A-Za-z][A-Za-z0-9]*-[A-Za-z][A-Za-z0-9-]*\b/g;
const POWERSHELL_WRITE_COMMANDS = new Set([
  'out-file',
  'set-content',
  'add-content',
  'export-csv',
  'export-clixml',
  'new-item',
]);
const OUTPUT_OPTION_PREFIX_RE =
  /(?:^|\s)(?:-o|--output(?:-file|-document)?|--outfile)(?:\s+|=)['"]?$/i;
const REDIRECT_PREFIX_RE = /(?:^|[^>])>{1,2}\s*['"]?$/;
const SAVE_COMMAND_PREFIX_RE = /(?:^|[;&|]\s*|\s)save\s+['"]?$/i;
const TEE_COMMAND_PREFIX_RE = /(?:^|[|;&]\s*)tee(?:\.exe)?\b[^|;&\r\n]*['"]?$/i;

function extractTransferPlainFilenameDestinations(command: string): CommandPathToken[] {
  const out: CommandPathToken[] = [];
  const commandRe =
    /\b(Copy-Item|Move-Item|copy|move|cp|mv)\b([^|;\r\n]*?)(?=\|{1,2}|;|\r?$|\n)/gim;
  for (const commandMatch of command.matchAll(commandRe)) {
    const commandName = (commandMatch[1] ?? '').toLowerCase();
    const argsText = commandMatch[2] ?? '';
    const argsStart = (commandMatch.index ?? 0) + commandMatch[0].length - argsText.length;
    const args = extractCommandArguments(argsText, argsStart);
    const isPlainFilename = (value: string): boolean =>
      EXT_RE.test(value) && !/[\\/<>|?*]/.test(value);
    if (commandName !== 'copy-item' && commandName !== 'move-item') {
      const supportsTargetDirectoryOption = commandName === 'cp' || commandName === 'mv';
      const targetDirectoryOptionIndex = supportsTargetDirectoryOption
        ? args.findIndex((arg) => /^(?:-t|--target-directory(?:=|$))/i.test(arg.value))
        : -1;
      if (targetDirectoryOptionIndex >= 0) {
        const option = args[targetDirectoryOptionIndex];
        const equalsIndex = option.value.indexOf('=');
        const separateDestination = args[targetDirectoryOptionIndex + 1];
        const rawDestination =
          equalsIndex >= 0 ? option.value.slice(equalsIndex + 1) : separateDestination?.value;
        const destinationStart =
          equalsIndex >= 0
            ? option.start + equalsIndex + 1
            : (separateDestination?.start ?? option.end);
        const destination = rawDestination?.replace(/^(['"])(.*)\1$/, '$2');
        if (destination && !TEMP_DIR_RE.test(destination) && !/[<>|?*]/.test(destination)) {
          out.push({
            path: /[\\/]$/.test(destination) ? destination : `${destination}/`,
            start: destinationStart,
            end: destinationStart + destination.length,
          });
        }
        continue;
      }
      const positional = args.filter(
        (arg) =>
          !arg.value.startsWith('-') &&
          !((commandName === 'copy' || commandName === 'move') && /^\/[A-Za-z]+$/.test(arg.value)),
      );
      const destination = positional.length >= 2 ? positional.at(-1) : undefined;
      if (destination && isPlainFilename(destination.value)) {
        out.push({ path: destination.value, start: destination.start, end: destination.end });
      }
      continue;
    }
    const explicitDestinationIndex = args.findIndex((arg) =>
      /^-(?:Destination|LiteralDestination|Target)$/i.test(arg.value),
    );
    if (explicitDestinationIndex >= 0) {
      const destination = args[explicitDestinationIndex + 1];
      if (destination && isPlainFilename(destination.value)) {
        out.push({ path: destination.value, start: destination.start, end: destination.end });
      }
      continue;
    }

    const positional: typeof args = [];
    let namedSource = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg.value.startsWith('-')) {
        positional.push(arg);
        continue;
      }
      if (/^-(?:Path|LiteralPath)$/i.test(arg.value)) namedSource = true;
      if (!/^-(?:Force|Recurse|PassThru|Container|Confirm|WhatIf)$/i.test(arg.value)) {
        index += 1;
      }
    }
    const destination = namedSource ? positional[0] : positional[1];
    if (destination && isPlainFilename(destination.value)) {
      out.push({ path: destination.value, start: destination.start, end: destination.end });
    }
  }
  return out;
}

function isTopLevelPowerShellTail(value: string): boolean {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '`') {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && (char === ';' || char === '|' || char === '\r' || char === '\n')) {
      return false;
    }
  }
  return depth === 0;
}

function isPowerShellOutputPosition(before: string): boolean {
  const cmdlets = [...before.matchAll(POWERSHELL_CMDLET_RE)];
  const lastCmdlet = cmdlets.at(-1);
  const lastWriteCmdlet = cmdlets
    .filter((match) => POWERSHELL_WRITE_COMMANDS.has(match[0].toLowerCase()))
    .at(-1);
  if (!lastCmdlet || !lastWriteCmdlet) return false;
  const writeTail = before.slice((lastWriteCmdlet.index ?? 0) + lastWriteCmdlet[0].length);
  // Support the first positional path and the cmdlets' explicit path switches.
  // An explicit switch may follow a nested read expression, but it must remain at the writer's
  // top level so a nested `Get-Content -Path` cannot leak its input path.
  if (
    /-(?:FilePath|LiteralPath|Path)\s+['"]?$/i.test(writeTail) &&
    isTopLevelPowerShellTail(writeTail)
  ) {
    return true;
  }
  if (lastCmdlet.index !== lastWriteCmdlet.index) return false;
  const trailing = before.slice((lastCmdlet.index ?? 0) + lastCmdlet[0].length);
  return /^\s*['"]?$/.test(trailing);
}

function isExplicitOutputPath(
  command: string,
  token: CommandPathToken,
  tokens: readonly CommandPathToken[],
): boolean {
  const before = command.slice(Math.max(0, token.start - 240), token.start);
  const powerShellBefore = command.slice(0, token.start);
  const after = command.slice(token.end, token.end + 80);
  if (
    WRITE_CALL_PREFIX_RE.test(before) ||
    WRITE_CALL_LATER_KEYWORD_PREFIX_RE.test(before) ||
    OBJECT_FIRST_WRITE_CALL_PREFIX_RE.test(before) ||
    /^\s*['"]?\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/i.test(after) ||
    isPowerShellOutputPosition(powerShellBefore) ||
    OUTPUT_OPTION_PREFIX_RE.test(before) ||
    REDIRECT_PREFIX_RE.test(before) ||
    SAVE_COMMAND_PREFIX_RE.test(before) ||
    TEE_COMMAND_PREFIX_RE.test(before)
  ) {
    return true;
  }
  // Python / Ruby 等的 open(path, 'w'|'a'|'x'|'wb'...)。
  if (
    /\bopen\s*\(\s*(?:[rubf]{0,2})?['"]$/i.test(before) &&
    (/^['"]\s*,\s*['"][wax][bt+]*['"]/i.test(after) ||
      /^['"]\s*,\s*[^();\r\n]*\bmode\s*=\s*['"][wax][bt+]*['"]/i.test(after))
  ) {
    return true;
  }

  // copy/move 的最后一个路径参数是目标。只看当前命令段,避免把前一条命令的路径带进来。
  const previousSeparators = [
    { index: command.lastIndexOf(';', token.start - 1), length: 1 },
    { index: command.lastIndexOf('\n', token.start - 1), length: 1 },
    { index: command.lastIndexOf('&&', token.start - 1), length: 2 },
    { index: command.lastIndexOf('||', token.start - 1), length: 2 },
  ];
  const previousSeparator = previousSeparators.reduce((latest, candidate) =>
    candidate.index > latest.index ? candidate : latest,
  );
  const segmentStart = previousSeparator.index + previousSeparator.length;
  const nextSeparators = [
    command.indexOf(';', token.end),
    command.indexOf('\n', token.end),
    command.indexOf('&&', token.end),
    command.indexOf('||', token.end),
  ].filter((index) => index >= 0);
  const segmentEnd = nextSeparators.length > 0 ? Math.min(...nextSeparators) : command.length;
  const segment = command.slice(segmentStart, segmentEnd);
  const lastPath = tokens
    .filter((candidate) => candidate.start >= segmentStart && candidate.end <= segmentEnd)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .at(-1);
  const beforeInSegment = command.slice(segmentStart, token.start);
  if (/(?:^|\|\s*)(?:Copy-Item|Move-Item)\b/i.test(segment.trim())) {
    const hasExplicitDestination = /-(?:Destination|LiteralDestination|Target)\s+/i.test(segment);
    if (hasExplicitDestination) {
      return /-(?:Destination|LiteralDestination|Target)\s+['"]?$/i.test(beforeInSegment);
    }
    return lastPath?.start === token.start && lastPath.end === token.end;
  }
  const isTargetDirectoryTransfer =
    /(?:^|\|\s*)(?:cp|mv)\s+/i.test(segment.trim()) &&
    /(?:^|\s)(?:-t(?:\s+|$)|--target-directory(?:\s+|=))/i.test(segment);
  if (isTargetDirectoryTransfer) {
    return /(?:^|\s)(?:-t|--target-directory)(?:\s+|=)['"]?$/i.test(beforeInSegment);
  }
  return (
    lastPath?.start === token.start &&
    lastPath.end === token.end &&
    /(?:^|\|\s*)(?:cp|copy|mv|move|Copy-Item|Move-Item)\s+/i.test(segment.trim())
  );
}

function transferDirectoryOutputs(
  command: string,
  destination: CommandPathToken,
  tokens: readonly CommandPathToken[],
): string[] {
  if (!/[\\/]$/.test(destination.path)) return [destination.path];
  const previousSeparators = [
    { index: command.lastIndexOf(';', destination.start - 1), length: 1 },
    { index: command.lastIndexOf('\n', destination.start - 1), length: 1 },
    { index: command.lastIndexOf('&&', destination.start - 1), length: 2 },
    { index: command.lastIndexOf('||', destination.start - 1), length: 2 },
  ];
  const previousSeparator = previousSeparators.reduce((latest, candidate) =>
    candidate.index > latest.index ? candidate : latest,
  );
  const segmentStart = previousSeparator.index + previousSeparator.length;
  const nextSeparators = [
    command.indexOf(';', destination.end),
    command.indexOf('\n', destination.end),
    command.indexOf('&&', destination.end),
    command.indexOf('||', destination.end),
  ].filter((index) => index >= 0);
  const segmentEnd = nextSeparators.length > 0 ? Math.min(...nextSeparators) : command.length;
  const sourcePaths = tokens
    .filter((token) => token.start >= segmentStart && token.end <= segmentEnd)
    .filter((token) => token.start !== destination.start)
    .filter((token) => !/[\\/]$/.test(token.path))
    .map((token) => token.path);
  const segmentArguments = extractCommandArguments(
    command.slice(segmentStart, segmentEnd),
    segmentStart,
  );
  for (const argument of segmentArguments) {
    if (argument.start === destination.start) continue;
    if (!EXT_RE.test(argument.value) || /[<>|?*]/.test(argument.value)) continue;
    if (!sourcePaths.includes(argument.value)) sourcePaths.push(argument.value);
  }
  const outputs = sourcePaths
    .map((source) => {
      const sourceName = source
        .replace(/[\\/]$/, '')
        .split(/[\\/]/)
        .at(-1);
      return sourceName ? `${destination.path}${sourceName}` : null;
    })
    .filter((path): path is string => Boolean(path));
  return outputs.length > 0 ? outputs : [destination.path];
}

// ── 转换器 / 无头浏览器 ────────────────────────────────────────────────────
//
// 这一族的产物路径**不一定在命令文本里字面出现**(LibreOffice 只给格式和输出目录,
// 文件名由输入名推出),所以走不了上面那套「token + 相邻文本」的判定,单独合成。
// 只收「写出位置由命令语义唯一确定」的形态:PDF / 截图 / 格式转换是伙伴会话里
// 二进制产物的主要来路(实测 PDF 就是这样丢掉的),而这些命令本身即写出语义,
// 不存在「只是读输入」的歧义。

/**
 * Chromium 家族的写出开关。**只认 `=` 形态**:Chrome 的命令行开关一律
 * `--switch=value`,`--print-to-pdf out.pdf` 里的 `out.pdf` 会被当成位置参数(URL),
 * 并不产出该文件,认了就是误报。
 */
const HEADLESS_BROWSER_OUTPUT_RE =
  /--(?:print-to-pdf|screenshot)=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'<>|]+))/gi;

const LIBREOFFICE_EXEC_RE = /^(?:soffice(?:\.bin)?|libreoffice)(?:\.(?:exe|com))?$/i;

/** 「最后一个位置参数就是输出」的转换器。 */
const POSITIONAL_OUTPUT_EXEC_RE = /^(?:wkhtmltopdf|wkhtmltoimage|weasyprint)(?:\.exe)?$/i;

/** 命令段切分。合成类判定不需要偏移量,按分隔符切开即可,避免跨命令串味。 */
function splitCommandSegments(command: string): string[] {
  return command.split(/;|\r?\n|&&|\|\||\|/g);
}

function commandArgumentBasename(value: string): string {
  const unquoted = value.replace(/^(['"])(.*)\1$/, '$2');
  const tail = unquoted.split(/[\\/]/).at(-1);
  return (tail ?? unquoted).toLowerCase();
}

/** 去掉最后一节扩展名的文件名(LibreOffice 用输入名 + 目标格式拼产物名)。 */
function fileStem(value: string): string {
  const name = value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? value;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 合成候选的准入。与 token 候选不同,**允许纯文件名** —— 位置由命令语义唯一确定
 * (`soffice --convert-to pdf a.docx` 就是往 cwd 写 `a.pdf`),不存在 token 扫描
 * 那种「随机带点 token」的误报面;相对路径交给调用方按 workingDir 解析。
 */
function isSynthesizedOutputCandidate(value: string): boolean {
  const s = value.trim();
  if (s.length < 3 || s.length > 512) return false;
  if (!EXT_RE.test(s)) return false;
  if (TEMP_DIR_RE.test(s)) return false;
  return !/[<>|?*]/.test(s);
}

/** `soffice/libreoffice --convert-to <ext> [--outdir <dir>] <input…>` 的产物。 */
function libreOfficeConvertOutputs(args: readonly string[]): string[] {
  const execIndex = args.findIndex((arg) => LIBREOFFICE_EXEC_RE.test(commandArgumentBasename(arg)));
  if (execIndex < 0) return [];
  let convertTo: string | null = null;
  let outDir: string | null = null;
  const inputs: string[] = [];
  for (let index = execIndex + 1; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('-')) {
      // 输入文档必须带扩展名。`--convert-to csv:"Text - txt - csv (StarCalc)"` 这类
      // 带过滤器名的写法会被 shell 分词切碎,碎片会混进位置参数;要求扩展名即可把
      // 它们挡掉,而任何真实的 LibreOffice 输入都带扩展名。
      if (EXT_RE.test(arg)) inputs.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    const name = (equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg).replace(/^-+/, '').toLowerCase();
    const inline = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : null;
    if (name !== 'convert-to' && name !== 'outdir') continue;
    // 其余开关(--headless / --norestore / -env:…)都不吃值,跳过即可。
    const value = inline ?? args[index + 1] ?? null;
    if (inline === null) index += 1;
    if (name === 'convert-to') convertTo = value;
    else outDir = value;
  }
  if (!convertTo || inputs.length === 0) return [];
  // `--convert-to csv:"Text - txt - csv (StarCalc)":44,34` 这类带过滤器参数的形态,
  // 冒号前那一段才是真正的目标扩展名。
  const ext = (convertTo.split(':')[0] ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return [];
  const dir = outDir ? (/[\\/]$/.test(outDir) ? outDir : `${outDir}/`) : '';
  return inputs.map((input) => `${dir}${fileStem(input)}.${ext}`);
}

/** `wkhtmltopdf <input> <output>` / `weasyprint <input> <output>`:末位位置参数即产物。 */
function positionalConverterOutputs(args: readonly string[]): string[] {
  const execIndex = args.findIndex((arg) =>
    POSITIONAL_OUTPUT_EXEC_RE.test(commandArgumentBasename(arg)),
  );
  if (execIndex < 0) return [];
  // 带值的长选项(--margin-top 10mm)会混进位置参数里,但它永远不会是**最后一个**
  // ——最后一个是输出,这是这两个 CLI 的固定契约。所以只看末位,不必认全部选项表。
  const positionals = args.slice(execIndex + 1).filter((arg) => !arg.startsWith('-'));
  if (positionals.length < 2) return [];
  const output = positionals.at(-1);
  return output ? [output] : [];
}

/** 转换器 / 无头浏览器写出的产物路径(合成,可能不在命令文本里字面出现)。 */
export function extractConverterOutputPaths(command: string): string[] {
  if (!command) return [];
  const out: string[] = [];
  for (const match of command.matchAll(HEADLESS_BROWSER_OUTPUT_RE)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (value) out.push(value);
  }
  for (const segment of splitCommandSegments(command)) {
    const args = extractCommandArguments(segment)
      .map((argument) => argument.value)
      .filter((value) => value.length > 0);
    if (args.length === 0) continue;
    out.push(...libreOfficeConvertOutputs(args), ...positionalConverterOutputs(args));
  }
  return out.filter((value) => isSynthesizedOutputCandidate(value));
}

/**
 * 命令文本 → 明确写出位置里的产物路径候选。
 *
 * mtime 只能证明文件最近变过,不能证明是当前命令创建的(新 worktree 中所有文件尤其容易
 * 同时命中时间窗)。因此普通参数、变量赋值、Get-Content / ReadAllLines 等读取位置一律不收;
 * 只认重定向、常见 save/write API、输出参数及复制/移动目标。后续仍由渲染方做时间窗复核。
 */
export function extractCommandOutputPathCandidates(command: string): string[] {
  const tokens = extractCommandPathTokens(command);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (!isExplicitOutputPath(command, token, tokens)) continue;
    for (const output of transferDirectoryOutputs(command, token, tokens)) {
      if (seen.has(output)) continue;
      seen.add(output);
      out.push(output);
    }
  }
  for (const output of extractConverterOutputPaths(command)) {
    if (seen.has(output)) continue;
    seen.add(output);
    out.push(output);
  }
  return out;
}
