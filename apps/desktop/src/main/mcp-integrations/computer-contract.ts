/** A session's actual tools/list contract, independent of release version strings. */
export interface ComputerDriverToolSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export class ComputerContractError extends Error {
  readonly code = 'COMPUTER_DRIVER_INCOMPATIBLE';
}

/**
 * Negotiate arguments for an optional driver decoration. Missing tools or a
 * closed schema with no compatible Cindy fields mean the decoration is not
 * available; they must not become rejected driver calls.
 */
export function selectAdvertisedComputerDriverArgs(
  name: string,
  input: Record<string, unknown>,
  schemas: ReadonlyMap<string, ComputerDriverToolSchema>,
): Record<string, unknown> | null {
  const schema = schemas.get(name);
  if (!schema) return null;
  if (schema.additionalProperties !== false) return { ...input };
  const properties = schema.properties ?? {};
  const args = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => value !== undefined && Object.hasOwn(properties, key)),
  );
  return Object.keys(args).length > 0 ? args : null;
}

/** Fields Cindy may advertise after an older installed driver froze its schema. */
const DRIVER_COMPAT_OPTIONAL_FIELDS = new Set(['delivery_mode']);

export function adaptComputerDriverArgs(
  name: string,
  input: Record<string, unknown>,
  schemas: ReadonlyMap<string, ComputerDriverToolSchema>,
): Record<string, unknown> {
  const schema = schemas.get(name);
  if (!schema)
    throw new ComputerContractError(
      `Installed driver does not advertise ${name}. Check the driver installation/version.`,
    );
  const props = schema.properties ?? {};
  const args = { ...input };
  if (name === 'get_window_state') {
    const screenshot =
      typeof args.include_screenshot === 'boolean'
        ? args.include_screenshot
        : args.capture_mode !== 'ax';
    if ('include_screenshot' in props) {
      args.include_screenshot = screenshot;
      delete args.capture_mode; // New drivers ignore this legacy option.
    } else {
      delete args.include_screenshot;
      args.capture_mode =
        typeof input.include_screenshot === 'boolean'
          ? screenshot
            ? 'vision'
            : 'ax'
          : (input.capture_mode ?? 'vision');
    }
    // Bound the actual AX walk, not a lossy re-indexing of its response.
    if ('max_elements' in props) args.max_elements ??= 200;
    if ('max_depth' in props) args.max_depth ??= 15;
    // Drivers since 0.35 default to Markdown only; Cindy needs the structured
    // elements to register tokens and frames, and trims them from the model view.
    if ('tree_format' in props) args.tree_format ??= 'both';
    else delete args.tree_format;
    // Evidence reads may use compact diffs; older drivers simply return full state.
    if (!('since' in props)) delete args.since;
  }
  if (args.element_index !== undefined && !('element_index' in props) && 'element_token' in props) {
    // Newer drivers address an observed row only as `<snapshot_id>:<row>`.
    if (args.element_token === undefined) {
      if (typeof args.snapshot_id !== 'string')
        throw new ComputerContractError(
          'Element actions require a fresh snapshot_id or element_token. Call get_window_state first.',
        );
      args.element_token = `${args.snapshot_id}:${args.element_index}`;
    }
    delete args.element_index;
  }
  // Cindy has already checked freshness; drivers without the field never see it.
  if (!('snapshot_id' in props)) delete args.snapshot_id;
  for (const key of Object.keys(args)) {
    if (args[key] === undefined) delete args[key];
    else if (schema.additionalProperties === false && !(key in props)) {
      // Only strip fields Cindy added after older drivers froze their schema.
      // Unknown keys still fail closed so a misspelled target cannot dispatch.
      if (DRIVER_COMPAT_OPTIONAL_FIELDS.has(key)) {
        delete args[key];
        continue;
      }
      throw new ComputerContractError(
        `Installed driver ${name} does not accept ${key}; no action was dispatched.`,
      );
    }
  }
  for (const key of schema.required ?? []) {
    if (!(key in args))
      throw new ComputerContractError(
        `Installed driver ${name} requires ${key}; no action was dispatched.`,
      );
  }
  if (
    'snapshot_id' in props &&
    args.element_index !== undefined &&
    !args.snapshot_id &&
    !args.element_token
  ) {
    throw new ComputerContractError(
      'Element actions require a fresh driver snapshot_id or element_token. Call get_window_state first.',
    );
  }
  return args;
}
