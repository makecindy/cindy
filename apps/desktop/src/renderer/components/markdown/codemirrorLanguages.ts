/**
 * Map file preview language aliases (used with `detectRenderable`) to
 * CodeMirror 6 language extensions.
 *
 * Three parser sources are wired up:
 *   1. `@codemirror/lang-*` packages — first-class Lezer parsers with the
 *      richest highlighting + indent + folding support. Used for the major
 *      web stack (js/ts/json/css/html/...) and a few popular system langs
 *      (cpp/java/rust/go/python/php/sql/yaml).
 *   2. `@replit/codemirror-lang-solidity` — dedicated Solidity support backed
 *      by a CodeMirror stream parser.
 *   3. `@codemirror/legacy-modes` (CodeMirror 5 stream parsers, repackaged for
 *      CM6 via `StreamLanguage.define`) — used for everything else where a
 *      first-party Lezer parser doesn't exist (csharp/kotlin/swift/dart/ruby
 *      /lua/shell/powershell/toml/...). Highlighting quality is good enough
 *      for read-only code preview; missing-language fallback would be plain
 *      monospace which looks broken (white text on dark — see why we added
 *      this in the first place).
 *
 * Adding a new language: pick a first-class lang-* if available, else use a
 * compatible package or find the matching mode in legacy-modes and wrap with
 * StreamLanguage.define(). Then add the alias case below.
 */

import { type Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import { StreamLanguage } from '@codemirror/language';

import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { php } from '@codemirror/lang-php';
import { csharp as csharpLezer } from '@replit/codemirror-lang-csharp';
import { parser as solidityParser } from '@replit/codemirror-lang-solidity';

import {
  kotlin as legacyKotlin,
  dart as legacyDart,
  scala as legacyScala,
} from '@codemirror/legacy-modes/mode/clike';
import { swift as legacySwift } from '@codemirror/legacy-modes/mode/swift';
import { ruby as legacyRuby } from '@codemirror/legacy-modes/mode/ruby';
import { lua as legacyLua } from '@codemirror/legacy-modes/mode/lua';
import { shell as legacyShell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell as legacyPowerShell } from '@codemirror/legacy-modes/mode/powershell';
import { toml as legacyToml } from '@codemirror/legacy-modes/mode/toml';
import { properties as legacyProperties } from '@codemirror/legacy-modes/mode/properties';
import { perl as legacyPerl } from '@codemirror/legacy-modes/mode/perl';
import { groovy as legacyGroovy } from '@codemirror/legacy-modes/mode/groovy';
import { haskell as legacyHaskell } from '@codemirror/legacy-modes/mode/haskell';
import { r as legacyR } from '@codemirror/legacy-modes/mode/r';
import { dockerFile as legacyDockerfile } from '@codemirror/legacy-modes/mode/dockerfile';
import { diff as legacyDiff } from '@codemirror/legacy-modes/mode/diff';
import { protobuf as legacyProtobuf } from '@codemirror/legacy-modes/mode/protobuf';

// 把每个 legacy stream parser 包成 CM6 Extension。每个 wrap 是个常量,
// 同一文件多次被打开也复用,不重复 define。
const kotlin = StreamLanguage.define(legacyKotlin);
const dart = StreamLanguage.define(legacyDart);
const scala = StreamLanguage.define(legacyScala);
const swift = StreamLanguage.define(legacySwift);
const ruby = StreamLanguage.define(legacyRuby);
const lua = StreamLanguage.define(legacyLua);
const shell = StreamLanguage.define(legacyShell);
const powershell = StreamLanguage.define(legacyPowerShell);
const toml = StreamLanguage.define(legacyToml);
const ini = StreamLanguage.define(legacyProperties);
const perl = StreamLanguage.define(legacyPerl);
const groovy = StreamLanguage.define(legacyGroovy);
const haskell = StreamLanguage.define(legacyHaskell);
const r = StreamLanguage.define(legacyR);
const dockerfile = StreamLanguage.define(legacyDockerfile);
const diff = StreamLanguage.define(legacyDiff);
const protobuf = StreamLanguage.define(legacyProtobuf);

// The Solidity package's custom tags have no standard parents, so existing
// themes cannot style them. Keep its grammar and expose our usual semantic roles.
const solidity = StreamLanguage.define({
  ...solidityParser,
  tokenTable: {
    ...solidityParser.tokenTable,
    functionName: tags.function(tags.variableName),
    parameterValue: tags.variableName,
    addressFunction: tags.function(tags.variableName),
    errorHandling: tags.keyword,
    contractRelated: tags.keyword,
    version: tags.number,
    etherUnit: tags.unit,
    doc: tags.docComment,
    docReserve: tags.docComment,
    mathematicalAndCryptographic: tags.standard(tags.variableName),
    abi: tags.standard(tags.variableName),
  },
});

export function getCodeMirrorLanguage(alias: string | undefined): Extension | null {
  if (!alias) return null;
  switch (alias.toLowerCase()) {
    // ── First-class Lezer parsers ────────────────────────────────────────
    case 'python':
    case 'py':
      return python();
    case 'json':
      return json();
    case 'yaml':
    case 'yml':
      return yaml();
    case 'javascript':
    case 'js':
    case 'jsx':
      return javascript({ jsx: true });
    case 'typescript':
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'html':
    case 'xhtml':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'markdown':
    case 'md':
      return markdown();
    case 'cpp':
    case 'c':
    case 'c++':
      return cpp();
    case 'java':
      return java();
    case 'rust':
    case 'rs':
      return rust();
    case 'go':
      return go();
    case 'sql':
      return sql();
    case 'xml':
      return xml();
    case 'php':
      return php();
    case 'csharp':
    case 'cs':
    case 'c#':
      return csharpLezer();
    case 'solidity':
    case 'sol':
      return solidity;

    // ── Stream parsers (legacy-modes) ────────────────────────────────────
    case 'kotlin':
    case 'kt':
      return kotlin;
    case 'dart':
      return dart;
    case 'scala':
      return scala;
    case 'swift':
      return swift;
    case 'ruby':
    case 'rb':
      return ruby;
    case 'lua':
      return lua;
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'shell':
      return shell;
    case 'powershell':
    case 'ps1':
    case 'ps':
      return powershell;
    case 'toml':
      return toml;
    case 'ini':
    case 'properties':
      return ini;
    case 'perl':
    case 'pl':
      return perl;
    case 'groovy':
    case 'gradle':
      return groovy;
    case 'haskell':
    case 'hs':
      return haskell;
    case 'r':
      return r;
    case 'dockerfile':
    case 'docker':
      return dockerfile;
    case 'diff':
    case 'patch':
      return diff;
    case 'protobuf':
    case 'proto':
      return protobuf;

    default:
      return null;
  }
}
