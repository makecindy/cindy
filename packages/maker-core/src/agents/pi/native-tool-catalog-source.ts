/** Public ExtensionAPI calls, included in the existing Cindy bridge only. */
export const PI_NATIVE_TOOL_CATALOG_SOURCE = String.raw`
async function callCindyNativeToolCatalog(pi: any, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'getAllTools':
      if (typeof pi.getAllTools !== 'function') break;
      return pi.getAllTools().map(({ name, description, parameters, promptGuidelines, exposure, namespace, annotations }: any) =>
        ({ name, description, parameters, promptGuidelines, exposure, namespace, annotations }));
    case 'getActiveTools':
      if (typeof pi.getActiveTools !== 'function') break;
      return pi.getActiveTools();
    case 'setActiveTools':
      if (typeof pi.setActiveTools !== 'function' || typeof pi.getActiveTools !== 'function') break;
      pi.setActiveTools(args[0]);
      return pi.getActiveTools();
    case 'registerMcpServer':
      if (typeof pi.registerMcpServer !== 'function') break;
      await pi.registerMcpServer(args[0], args[1]);
      return null;
    case 'unregisterMcpServer':
      if (typeof pi.unregisterMcpServer !== 'function') break;
      await pi.unregisterMcpServer(args[0]);
      return null;
  }
  throw new Error('UNSUPPORTED_CAPABILITY');
}
`;
