/**
 * Model-facing names for the embedded iOS Simulator tools.
 *
 * Bare names like `open_url` or `type_text` read as generic host/browser
 * actions, and agents have mis-routed unrelated work (opening a web page) into
 * the simulator gateway because of it. The advertised names now say what device
 * they act on.
 *
 * Only what a model sees is renamed. The Host contract keeps its original
 * names — `IOSSimulatorMcpToolName`, the Desktop IPC allowlist and the viewer
 * panel are unaffected — and every old model-facing name stays callable as a
 * hidden alias so an installed plugin or a saved prompt written against it
 * keeps working.
 */
export const IOS_SIMULATOR_DEPRECATED_TOOL_ALIASES: Readonly<
  Record<string, string>
> = {
  open_url: "open_simulator_url",
  take_screenshot: "take_simulator_screenshot",
  type_text: "type_simulator_text",
  key_press: "press_simulator_key",
  drag: "drag_on_simulator",
  list_devices: "list_simulator_devices",
};

/**
 * Resolve a possibly-deprecated model-facing name to the advertised one. Every
 * name-keyed decision (approval policy, availability, dispatch) must go through
 * this, or an alias could silently bypass a gate that the new name enforces.
 */
export function canonicalIOSSimulatorToolName(name: string): string {
  return IOS_SIMULATOR_DEPRECATED_TOOL_ALIASES[name] ?? name;
}

/** Hidden aliases that still resolve to `name`, derived from one table. */
export function deprecatedIOSSimulatorToolAliasesFor(
  name: string,
): readonly string[] {
  return Object.entries(IOS_SIMULATOR_DEPRECATED_TOOL_ALIASES)
    .filter(([, current]) => current === name)
    .map(([deprecated]) => deprecated);
}
