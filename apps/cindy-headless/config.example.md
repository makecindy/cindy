# Cindy Headless Local Gateway Config

Prefer process environment variables. If a local file is needed, copy `config.example.json` outside the repository:

- `%APPDATA%/cindy-headless/config.json`
- `~/.config/cindy-headless/config.json`

Or set `CINDY_HEADLESS_CONFIG_FILE` to an explicit path.

The file contains the shared gateway URL and API key used by all three backends:

```json
{
  "gateway": {
    "baseUrl": "https://llm-proxy.example.com",
    "apiKey": "replace-with-your-local-key",
    "codexBasePath": "/v1"
  }
}
```

Do not store the real file in a checkout, put the key in a profile,
or include it in a Harbor bundle. The same gateway credential is mapped to
Claude and Pi's Anthropic-compatible transports and Codex's OpenAI Responses provider.
Environment variables override file values:
`CINDY_HEADLESS_BASE_URL` and `CINDY_HEADLESS_API_KEY`.
