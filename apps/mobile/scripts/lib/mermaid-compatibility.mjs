import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Android 10 can retain WebView 74. The upstream bundle also needs runtime APIs
// that syntax lowering alone does not supply. Keep the shims in this WebView,
// preserve native implementations, and never change the React Native runtime.
const target = ['es2019', 'chrome74'];
const compatibilityEntry = String.raw`
import clone from '@ungap/structured-clone';
if (typeof globalThis.structuredClone !== 'function') globalThis.structuredClone = clone;
if (typeof URL.canParse !== 'function') {
  Object.defineProperty(URL, 'canParse', {
    configurable: true, writable: true,
    value: function (url, base) {
      if (arguments.length === 0) throw new TypeError('URL.canParse requires a URL');
      function toString(value) {
        if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
        return String(value);
      }
      var input = toString(url);
      var resolvedBase = base === undefined ? undefined : toString(base);
      try { new URL(input, resolvedBase); return true; } catch (error) { return false; }
    }
  });
}
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true, writable: true,
    value: function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  });
}
function at(index) {
  'use strict';
  if (this == null) throw new TypeError('Cannot read a null value');
  var object = Object(this);
  var length = Math.min(Math.max(Math.trunc(+object.length) || 0, 0), Number.MAX_SAFE_INTEGER);
  var relative = Math.trunc(+index) || 0;
  var position = relative < 0 ? length + relative : relative;
  return position < 0 || position >= length ? undefined : object[position];
}
if (typeof Array.prototype.at !== 'function') {
  Object.defineProperty(Array.prototype, 'at', { configurable: true, writable: true, value: at });
}
if (typeof String.prototype.at !== 'function') {
  Object.defineProperty(String.prototype, 'at', {
    configurable: true, writable: true,
    value: function (index) {
      'use strict';
      if (this == null) throw new TypeError('Cannot read a null value');
      return at.call('' + this, index);
    }
  });
}
if (typeof String.prototype.replaceAll !== 'function') {
  Object.defineProperty(String.prototype, 'replaceAll', {
    configurable: true, writable: true,
    value: function (search, replacement) {
      'use strict';
      if (this == null) throw new TypeError('Cannot read a null value');
      if (search != null) {
        var match = search[Symbol.match];
        var isRegExp = match === undefined ? Object.prototype.toString.call(search) === '[object RegExp]' : !!match;
        if (isRegExp && String(search.flags).indexOf('g') < 0) throw new TypeError('replaceAll requires a global RegExp');
        var replace = search[Symbol.replace];
        if (replace != null) return replace.call(search, String(this), replacement);
      }
      var escaped = String(search).replace(/[\\^$.*+?()[\]{}|]/g, function (character) { return '\\' + character; });
      return String(this).replace(new RegExp(escaped, 'g'), replacement);
    }
  });
}
`;

export async function buildMobileMermaidJs(source, resolveDir) {
  const [compatibility, mermaid, cloneLicense] = await Promise.all([
    build({
      stdin: { contents: compatibilityEntry, resolveDir },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target,
      minify: true,
      legalComments: 'inline',
      write: false,
    }),
    transform(source, { target, minify: true, legalComments: 'inline' }),
    readFile(join(resolveDir, 'node_modules/@ungap/structured-clone/LICENSE'), 'utf8'),
  ]);
  return `/*! @ungap/structured-clone\n${cloneLicense.trim()}\n*/\n`
    + compatibility.outputFiles[0].text + mermaid.code;
}
