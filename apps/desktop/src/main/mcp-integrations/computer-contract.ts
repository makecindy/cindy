/** A session's actual tools/list contract, independent of release version strings. */
export interface ComputerDriverToolSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export class ComputerContractError extends Error {
  readonly code = 'COMPUTER_DRIVER_INCOMPATIBLE';
}

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
  }
  for (const key of Object.keys(args)) {
    if (args[key] === undefined) delete args[key];
    else if (schema.additionalProperties === false && !(key in props)) {
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
