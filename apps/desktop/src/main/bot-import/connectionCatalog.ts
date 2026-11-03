import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ImportedMcpServer } from './types.js';
import type { CompanionEnvironment } from './environment.js';
import { fingerprint } from './files.js';
import { environmentRedactions, isPublicImportSetting, redactEnvironmentData, redactEnvironmentValues } from './process.js';

// Explicit transport routes only; arbitrary short/lowercase paths can be bearer credentials.
const PUBLIC_MCP_ROUTES = new Set(['api', 'v1', 'v2', 'mcp', 'sse', 'messages', 'hooks', 'webhooks']);
const LOCAL_MCP_ENDPOINTS = new Set(['native-mcp', 'touchdesigner-mcp']);
const CAPABILITY_PATH_PREFIXES = new Set(['hooks', 'webhooks', 'token', 'secret', 'credential', 'key']);
// Credential containers use the same classification as their scalar forms.
// PEM/Base64 suffixes describe key material; metadata such as key paths or
// format names and public keys must not become global content masks.
const CREDENTIAL_FIELD = /^(?:keys?|.*(?:api|private|signing|encryption|decryption|secret|access)[_-]?keys?(?:[_-]?(?:pem|base64))?|.*(?:tokens?|secrets?|passwords?|passwds?|pass[_-]?phrases?|credentials?)|auth(?:orization)?|access|refresh|cookies?)$/i;

export function isImportedCredentialField(name: string): boolean { return CREDENTIAL_FIELD.test(name); }

function basicCredentialValues(encoded: string): string[] {
  // Buffer's decoder ignores invalid characters and padding. Accept only a
  // canonical standard-base64 payload (with or without its complete padding).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return [];
  const bytes = Buffer.from(encoded, 'base64');
  const canonical = bytes.toString('base64');
  if (encoded !== canonical && encoded !== canonical.replace(/=+$/, '')) return [];
  // Preserve UTF-8 text and legacy single-byte Basic credentials without
  // producing replacement characters that were never part of the password.
  const utf8 = bytes.toString('utf8');
  const userinfo = Buffer.from(utf8, 'utf8').equals(bytes) ? utf8 : bytes.toString('latin1');
  const separator = userinfo.indexOf(':');
  if (separator < 0 || userinfo.length === 1) return [];
  const password = userinfo.slice(separator + 1);
  return password ? [userinfo, password] : [userinfo];
}

/** Shared transport-header decomposition for MCP and imported commands. Cookie
 * names are application-defined, so every nonempty cookie value stays private. */
export function headerCredentialValues(name: string, value: string): string[] {
  const header = name.trim(); const payload = value.trim();
  const authorization = /^(proxy-)?authorization$/i.test(header);
  if (!payload || !authorization && !isImportedCredentialField(header)) return [];
  const values = [payload];
  if (authorization) {
    const credential = /^\S+\s+(.+)$/.exec(payload)?.[1];
    if (credential) values.push(credential);
    if (credential && /^Basic[\t ]/i.test(payload)) values.push(...basicCredentialValues(credential));
  }
  if (/^cookie$/i.test(header)) for (const part of payload.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || !part.slice(0, separator).trim()) continue;
    const raw = part.slice(separator + 1).trim();
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (!unquoted) continue;
    values.push(raw, unquoted);
    try { values.push(decodeURIComponent(unquoted)); } catch { /* Preserve malformed encodings verbatim. */ }
  }
  return [...new Set(values)];
}

/** Include resolved connection-local values without overwriting same-named imports. */
export function connectionRedactions(server: ImportedMcpServer, environment: Record<string, string>): Record<string, string> {
  const values = [...Object.values(environmentRedactions(environment)), ...Object.values(environmentRedactions(server.env ?? {})), ...Object.values(server.headers ?? {})];
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    values.push(...headerCredentialValues(name, value));
  }
  if (server.url) {
    values.push(...urlCredentialValues(server.url, true));
  }
  return Object.fromEntries([...new Set(values)].filter(Boolean).map((value, index) => [`connection_credential_${index}`, value]));
}

/** URL credentials can be echoed in encoded or decoded form by a remote service. */
export function urlCredentialValues(raw: string, includePath = false): string[] {
  const values = [raw];
  try {
    const url = new URL(raw);
    values.push(url.username, url.password);
    // Apply the same setting classification to decoded and wire query values.
    for (const [name, value] of url.searchParams) if (!isPublicImportSetting(name, value)) values.push(value);
    for (const pair of url.search.slice(1).split('&')) {
      if (!pair.includes('=')) continue;
      const params = new URLSearchParams(pair);
      const [name, value] = [...params.entries()][0] ?? [];
      if (name && value && !isPublicImportSetting(name, value)) values.push(pair.slice(pair.indexOf('=') + 1));
    }
    // OAuth-style fragments carry named credentials, but ordinary document
    // anchors and fragment metadata must not become global source-text masks.
    for (const pair of url.hash.slice(1).split('&')) {
      if (!pair.includes('=')) continue;
      const [name, value] = [...new URLSearchParams(pair).entries()][0] ?? [];
      if (name && value && CREDENTIAL_FIELD.test(name)) values.push(value, pair.slice(pair.indexOf('=') + 1));
    }
    if (includePath) {
      const parts = url.pathname.split('/').filter(Boolean);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      let capability = false;
      for (const part of parts) {
        const publicRoute = PUBLIC_MCP_ROUTES.has(part)
          || local && parts.length === 1 && LOCAL_MCP_ENDPOINTS.has(part);
        if (capability || !publicRoute) values.push(part);
        // A route-looking value after a credential introducer is still private.
        if (!publicRoute || CAPABILITY_PATH_PREFIXES.has(part.toLowerCase())) capability = true;
      }
    }
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
  const collect = (value: unknown, credentialValue = false, commandEnv = false): void => {
    if (typeof value === 'string') {
      if (credentialValue) values.push(value);
      // Structured command env may put capability URLs under ordinary names
      // such as endpoint. Ordinary provider config/base URLs are not capability
      // grants; their public path names must not become global content masks.
      if (commandEnv && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) values.push(...urlCredentialValues(value, true));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      // OAuth token records include public protocol metadata alongside secrets.
      // Do not turn a scheme name into a global mask for imported source files.
      // Unknown values and non-scalar descendants retain the private context.
      if (/^token[_-]?type$/i.test(key) && typeof child === 'string' && /^(?:Bearer|DPoP)$/i.test(child)) continue;
      // Credential-bearing containers remain private through array indices and
      // nested objects; unrelated sibling fields keep their own classification.
      collect(child, credentialValue || CREDENTIAL_FIELD.test(key), commandEnv);
    }
  };
  for (const credential of environment.credentials) collect(credential.value, false, credential.format === 'command-env');
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
