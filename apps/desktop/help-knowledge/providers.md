---
id: providers
title: Providers and Cindy AI
summary: Model sources live in Settings > Providers — Cindy AI is provisioned automatically after sign-in for pay-per-token model access; add, reorder, disable, and share other providers (subscription accounts, API keys, local models, custom endpoints) there.
tab: providers
---
A provider is a source of models (with its own billing). Every model you can pick in the composer comes from a provider connected in **Settings > Providers**. Voice input is included for signed-in Cindy users and uses the separate voice service; it does not require or receive a Cindy AI key.

**The Providers page:**

- The left column lists your connected providers; click one to see its details and models on the right. **Drag to reorder** the list.
- **Add provider** is at the bottom of the list. **Enter Share Link…** (top right) is where you paste a provider share link someone sent you.

**Cindy AI:**

- Cindy AI is the official service: all models, for Claude Code, Codex, and Pi, billed per token from your balance — no keys to manage.
- If you're not signed in, a **Cindy AI** row marked **Recommended** appears at the top of the list with a **Sign in to Cindy** button.
- You don't paste a key — it's **provisioned automatically after you sign in** ("Fetching credentials…" while that happens, then **Connected**). Because it's tied to your account, it works on every computer you sign into. Organization accounts may show "Not enabled for your organization".
- The detail pane shows your remaining balance or plan allowance, with **View usage** and **Buy a plan** / **Upgrade plan** (these open **Settings > Usage and billing**).
- Credential actions are in the **···** (More Actions) menu: **Refresh credentials**, **Rotate key**, **Disconnect** (clears the locally saved Cindy AI key), plus the masked key (click to copy).
- **Rotate key** revokes the old key immediately: running sessions, remote sessions, and mobile voice that use it need to be restarted.

**Adding other providers (Add provider):**

- The wizard has three steps: **Choose provider → Connect → Choose models**. Options are grouped as **Recommended**, **Detected on this computer**, **Subscription account** (sign in through your browser, e.g. Claude Code, ChatGPT, SuperGrok), **Local models** (run models on this computer — Cindy can install llama.cpp or Ollama and download models — or connect a local server that's already running), **More providers** (API key), and **Custom**.
- CLIs already signed in on this computer appear under **Detected on this device** in the list, with **Use local account**.
- **Custom endpoint** connects any OpenAI- or Anthropic-compatible service: display name, which runtime(s) use it (Claude Code / Codex / Pi), base URL, authentication (API key, subscription account sign-in, or none), and models. **Fetch model list** pulls available models; **Test connection** sends short requests (may cost a little); **Quick fill from a template** pre-fills known services.

**Managing a provider:**

- In the detail pane, turn individual models on or off (**Disable This Model** / **Enable All**); only enabled models appear in the model picker.
- The **···** menu has **Rename**, **Edit connection settings** (custom providers), **Disable This Provider** (keeps credentials; enable it again later), and **Delete** (message history is kept).

**Sharing a provider (Remote & Sharing):**

- A connected provider shows **Allow remote use**: when on, your other computers and people you share with can use its models; the agent runs on this computer using its sign-in and quota. This needs remote control allowed on this computer (**Settings > Remote Connection**).
- **Remote & Sharing** opens sharing management: **Create Share Link** (one-time link; you approve the request, optionally checking a pairing code), see **People You Share With** with usage, and **Pause Sharing** / **Remove** people.
- Providers from your other computers appear in the list with a remote badge; providers others shared with you appear under **Providers Shared with Me**.

**Notes:**

- Direct service keys such as Brave Search, Tavily, and DeepSeek search are **not** managed here — they live on the **Web Search** plugin's detail page under **Plugins**. They are optional; web search works through Cindy AI without them.
