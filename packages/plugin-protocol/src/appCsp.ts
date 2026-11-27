/** No schemes, directives, quotes, whitespace, credentials or paths from a CSP source. */
export function validateCspDomains(domains: string[] | undefined): string[] {
  if (domains && (!Array.isArray(domains) || domains.length > 100))
    throw new Error("MCP_APP_INVALID_CSP_DOMAIN");
  return (domains ?? []).map((source) => {
    if (
      !/^(https?|wss?):\/\/(?:\*\.)?(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::(?:[0-9]{1,5}|\*))?\/?$/.test(
        source,
      )
    ) {
      throw new Error("MCP_APP_INVALID_CSP_DOMAIN");
    }
    const url = new URL(
      source.replace("://*.", "://wildcard.").replace(/:\*(\/?)$/, ":443$1"),
    );
    if (!url.hostname || (url.port && Number(url.port) > 65535))
      throw new Error("MCP_APP_INVALID_CSP_DOMAIN");
    return source;
  });
}
