import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ImportedMcpServer } from './types.js';
import type { CompanionEnvironment } from './environment.js';
import { fingerprint } from './files.js';
import { environmentRedactions, redactEnvironmentData, redactEnvironmentValues } from './process.js';

/** Include resolved connection-local values without overwriting same-named imports. */
export function connectionRedactions(server: ImportedMcpServer, environment: Record<string, string>): Record<string, string> {
  const values = [...Object.values(environmentRedactions(environment)), ...Object.values(environmentRedactions(server.env ?? {})), ...Object.values(server.headers ?? {})];
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    if (/^(proxy-)?authorization$/i.test(name)) {
      const credential = /^\S+\s+(.+)$/.exec(value)?.[1];
      if (credential) values.push(credential);
    }
  }
  if (server.url) {
    values.push(...urlCredentialValues(server.url, true));
  }
  return Object.fromEntries([...new Set(values)].filter(Boolean).map((value, index) => [`connection_credential_${index}`, value]));
}

/** URL credentials can be echoed in encoded or decoded form by a remote service. */
function urlCredentialValues(raw: string, includePath = false): string[] {
  const values = [raw];
  try {
    const url = new URL(raw);
    values.push(url.username, url.password, ...url.searchParams.values());
    // URLSearchParams already decodes once; retain the wire representation too.
    for (const pair of url.search.slice(1).split('&')) if (pair.includes('=')) values.push(pair.slice(pair.indexOf('=') + 1));
    if (includePath) values.push(url.pathname, ...url.pathname.split('/').filter(Boolean));
  } catch { /* Invalid URLs fail at execution; never publish the literal in errors. */ }
  return [...new Set(values.filter(value => value && value !== '/').flatMap(value => {
    try { return [value, decodeURIComponent(value)]; } catch { return [value]; }
  }))];
}

/** Executable credentials plus private masks for known values embedded in selected originals. */
export function importedContentRedactions(environment: Pick<CompanionEnvironment, 'env' | 'mcp' | 'credentials' | 'contentRedactions'>, monitorUrls: string[] = []): Record<string, string> {
  const values = [...Object.values(environmentRedactions(environment.env)),
    ...Object.values(environment.contentRedactions ?? {}),
    ...environment.mcp.flatMap(server => Object.values(connectionRedactions(server, environment.env))),
    ...monitorUrls.flatMap(url => urlCredentialValues(url, true))];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && /^(?:key|api[_-]?key|.*token|.*secret|.*password|authorization|access|refresh)$/i.test(key)) values.push(child);
      else collect(child);
    }
  };
  for (const credential of environment.credentials) collect(credential.value);
  const named = environmentRedactions(environment.env);
  const namedValues = new Set(Object.values(named));
  let index = 0;
  for (const value of new Set(values)) {
    if (!value || namedValues.has(value)) continue;
    while (Object.hasOwn(named, `imported_credential_${index}`)) index++;
    named[`imported_credential_${index++}`] = value;
  }
  return named;
}

/** Keep readable identities unless the upstream embeds a credential in the name. */
export function publicConnectionName(name: string, secrets: Record<string, string>): string {
  return redactEnvironmentValues(name, secrets) === name ? name : `imported_${fingerprint(name).slice(0, 20)}`;
}

const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const schemaChildren = new Set(['items', 'prefixItems', 'additionalItems', 'contains', 'additionalProperties', 'unevaluatedItems',
  'unevaluatedProperties', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contentSchema']);
const schemaKeywords = new Set([...schemaMaps, ...schemaChildren,
  '$schema', '$id', 'id', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor', '$vocabulary', '$comment',
  'type', 'enum', 'const', 'default', 'examples', 'title', 'description', 'required', 'dependentRequired',
  'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern',
  'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains', 'maxProperties', 'minProperties',
  'format', 'contentEncoding', 'contentMediaType', 'readOnly', 'writeOnly', 'deprecated']);

function redactSchema(value: unknown, secrets: Record<string, string>, dictionary = false): unknown {
  if (Array.isArray(value)) return value.map(child => redactSchema(child, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    // Names in property/definition maps are data even when named "type" or
    // "properties". Schema keywords themselves must retain their wire spelling.
    if (dictionary) return [redactEnvironmentValues(key, secrets), redactSchema(child, secrets)];
    // JSON Schema type discriminators are protocol syntax, not business values.
    // An imported variable containing "object" must not invalidate the catalog.
    const types = Array.isArray(child) ? child : [child];
    if (key === 'type' && types.every(type => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) return [key, child];
    const projected = schemaMaps.has(key) ? redactSchema(child, secrets, true)
      : schemaChildren.has(key) ? redactSchema(child, secrets) : redactEnvironmentData(child, secrets);
    return [schemaKeywords.has(key) ? key : redactEnvironmentValues(key, secrets), projected];
  }));
  return redactEnvironmentData(value, secrets);
}

/** Restore only schema-defined aliases, privately at the upstream call boundary. */
export function restoreImportedArguments(value: Record<string, unknown>, schema: unknown, secrets: Record<string, string>): Record<string, unknown> {
  const object = (node: unknown): Record<string, unknown> | undefined =>
    node !== null && typeof node === 'object' && !Array.isArray(node) ? node as Record<string, unknown> : undefined;
  const names = (node: unknown): string[] => Array.isArray(node) ? node.filter((name): name is string => typeof name === 'string') : [];
  const expand = (nodes: unknown[]): Record<string, unknown>[] => {
    const result: Record<string, unknown>[] = [];
    const seen = new Set<unknown>();
    const visit = (node: unknown): void => {
      const current = object(node);
      if (!current || seen.has(node)) return;
      seen.add(node); result.push(current);
      // Resolve local definitions only; no external schema fetching at dispatch.
      if (typeof current.$ref === 'string' && current.$ref.startsWith('#')) {
        let target: unknown = schema;
        const pointer = decodeURIComponent(current.$ref.slice(1));
        if (!pointer || pointer.startsWith('/')) {
          for (const segment of pointer ? pointer.slice(1).split('/') : []) {
            const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
            const record = object(target);
            target = record && Object.hasOwn(record, key) ? record[key] : undefined;
          }
          visit(target);
        }
      }
      for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
        const branches = current[keyword];
        if (Array.isArray(branches)) branches.forEach(visit);
      }
      // These subschemas describe the same argument position. Restore their
      // published aliases here; validation/branch selection stays upstream.
      for (const keyword of ['if', 'then', 'else', 'not']) visit(current[keyword]);
      for (const keyword of ['dependentSchemas', 'dependencies']) {
        Object.values(object(current[keyword]) ?? {}).forEach(visit);
      }
    };
    nodes.forEach(visit);
    return result;
  };
  const aliases = (values: string[]): Map<string, string> => {
    const result = new Map<string, string>();
    for (const original of values) {
      const alias = redactEnvironmentValues(original, secrets);
      if (result.has(alias) && result.get(alias) !== original) throw new Error('Ambiguous imported schema');
      // Unchanged literals also participate in collision detection at this path.
      result.set(alias, original);
    }
    return result;
  };
  const restore = (node: unknown, schemas: unknown[], inherited: unknown[] = []): unknown => {
    const candidates = expand(schemas);
    const literals = [...inherited, ...candidates.flatMap(current => [
      ...(Array.isArray(current.enum) ? current.enum : []),
      ...(Array.isArray(current.examples) ? current.examples : []),
      ...(Object.hasOwn(current, 'const') ? [current.const] : []),
      ...(Object.hasOwn(current, 'default') ? [current.default] : []),
    ])];
    const scalars = aliases(literals.filter((literal): literal is string => typeof literal === 'string'));
    if (typeof node === 'string') return scalars.get(node) ?? node;
    if (Array.isArray(node)) return node.map((child, index) => restore(child, candidates.map(current => {
      if (Array.isArray(current.prefixItems)) return current.prefixItems[index] ?? current.items;
      return Array.isArray(current.items) ? current.items[index] ?? current.additionalItems : current.items;
    }), literals.filter(Array.isArray).map(literal => literal[index])));
    if (object(node)) {
      const literalObjects = literals.map(object).filter((literal): literal is Record<string, unknown> => !!literal);
      const properties = candidates.map(current => object(current.properties) ?? {});
      // These keywords declare names on this object even without properties entries.
      const requiredNames = candidates.flatMap(current => [
        ...names(current.required),
        ...['dependentRequired', 'dependentSchemas', 'dependencies'].flatMap(keyword =>
          Object.entries(object(current[keyword]) ?? {}).flatMap(([name, required]) => [name, ...names(required)])),
      ]);
      const propertyNames = expand(candidates.map(current => current.propertyNames))
        .flatMap(current => [...names(current.enum), ...names([current.const])]);
      const keys = aliases([...requiredNames, ...propertyNames, ...[...properties, ...literalObjects].flatMap(current => Object.keys(current))]);
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, child]) => {
        const originalKey = keys.get(key) ?? key;
        const children = candidates.flatMap((current, index) => {
          const matched = Object.hasOwn(properties[index]!, originalKey) ? [properties[index]![originalKey]] : [];
          for (const [pattern, constraint] of Object.entries(object(current.patternProperties) ?? {})) {
            if (new RegExp(pattern).test(originalKey)) matched.push(constraint);
          }
          return matched.length ? matched : [current.additionalProperties];
        });
        return [originalKey, restore(child, children, literalObjects.flatMap(literal =>
          Object.hasOwn(literal, originalKey) ? [literal[originalKey]] : []))];
      }));
    }
    return node;
  };
  return restore(value, [schema]) as Record<string, unknown>;
}

/** Redact tool metadata and schema keys/strings while preserving protocol syntax. */
export function redactImportedTool(tool: Tool, secrets: Record<string, string>): Tool {
  const result = redactEnvironmentData(tool, secrets);
  result.name = publicConnectionName(tool.name, secrets);
  result.inputSchema = redactSchema(tool.inputSchema, secrets) as Tool['inputSchema'];
  if (tool.outputSchema) result.outputSchema = redactSchema(tool.outputSchema, secrets) as Tool['outputSchema'];
  return result;
}

/** The SDK has validated content block fields. Preserve wire syntax only at
 * those protocol positions; arbitrary structured payload/meta keys stay private. */
export function redactImportedResult<T extends Record<string, unknown>>(result: T, secrets: Record<string, string>): T {
  const envelope = new Set(['content', 'structuredContent', 'isError', '_meta', 'toolResult']);
  const redacted = Object.fromEntries(Object.entries(result).map(([key, value]) => [
    envelope.has(key) ? key : redactEnvironmentValues(key, secrets), redactEnvironmentData(value, secrets),
  ]));
  const fields = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, redactEnvironmentData(child, secrets)]));
  if (Array.isArray(result.content)) redacted.content = result.content.map(block => {
    const content = fields(block);
    content.type = block.type;
    if (block.resource) content.resource = fields(block.resource);
    if (block.annotations) {
      content.annotations = { ...fields(block.annotations),
        ...(block.annotations.audience === undefined ? {} : { audience: [...block.annotations.audience] }) };
    }
    if (Array.isArray(block.icons)) content.icons = block.icons.map((icon: Record<string, unknown>) => ({
      ...fields(icon), ...(icon.theme === undefined ? {} : { theme: icon.theme }),
    }));
    return content;
  });
  return redacted as T;
}
