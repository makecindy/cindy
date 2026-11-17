---
id: providers
title: Providers and Cindy AI
summary: Settings > Providers connects Cindy AI, subscription accounts, API keys, local models and custom endpoints. Manage separate subscription providers or account pools, allocation strategies, existing task bindings, quota limits and sharing.
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
- **Custom** connects a model API endpoint: display name, base URL, API key where required, models (fetch or add manually), and advanced request headers. The Add provider form is simplified; advanced engine and authentication settings are under **Edit connection settings** where supported, not a subscription-login selector in this form. To add another official Claude Code or ChatGPT login, choose **Subscription account**, not Custom. **Test connection** sends short requests and may cost a little.

**Managing a provider:**

- In the detail pane, turn individual models on or off (**Disable This Model** / **Enable All**); only enabled models appear in the model picker.
- The **···** menu has **Rename**, **Edit connection settings** (custom providers), **Disable This Provider** (keeps credentials; enable it again later), and **Delete** (message history is kept).

**Multiple subscription accounts on one computer:**

- Local Claude Code and ChatGPT subscriptions can be kept as **separate providers** or combined into an **account pool within one provider**. To choose a particular account for a new task, keep it in a single-account provider and select that source. A pool assigns only its own accounts; it does not combine balances across providers or computers.
- Use **Add account** in a provider's subscription-account section to add to that pool. Account actions let you pause, move to another local provider of the same kind, or take an account out as a separate provider. Removing an account from Cindy does not delete its official CLI login or native history. Available controls depend on the version on the computer running the task.
- **New assignments:** authentication, model support, quota information and concurrency limits affect the candidates before the pool strategy is applied. **Least busy** prefers lower reported running load; **Round robin** rotates candidates; **In order** prefers earlier candidates; **By weight** gives larger weights more chances. These do not guarantee equal token use or quota consumption. The model selector previews accounts and usage; sending the message makes the assignment.
- **Existing tasks:** a healthy task normally keeps its assigned account. Changing the strategy, another account becoming idle, or its quota recovering does not automatically redistribute healthy tasks. An account's concurrency limit restricts new assignments, not normal continuation of its already-bound tasks.
- **Unavailable accounts:** when a bound account cannot serve the task, Cindy can use another eligible account in the same provider. Pausing stops new assignments without interrupting a running turn; continuation checks for a replacement before the next send. Switching accounts uses a context handoff and a new native session, not the same native session ID in a different account directory. Chat history is retained, but native internal state may not carry over completely.
- Quota cards are observations, not reservations or guaranteed capacity. In particular, a full ChatGPT plan window alone does not prove that sending is blocked: the upstream service decides whether credits can be used. Real quota or login failures still affect continuation and failover.

**Sharing a provider (Remote & Sharing):**

- A connected provider shows **Allow remote use**: when on, your other computers and people you share with can use its models; the agent runs on this computer using its sign-in and quota. This needs remote control allowed on this computer (**Settings > Remote Connection**).
- **Remote & Sharing** opens sharing management: **Create Share Link** (one-time link; you approve the request, optionally checking a pairing code), see **People You Share With** with usage, and **Pause Sharing** / **Remove** people.
- Providers from your other computers appear in the list with a remote badge; providers others shared with you appear under **Providers Shared with Me**.

**Notes:**

- Direct service keys such as Brave Search, Tavily, and DeepSeek search are **not** managed here — they live on the **Web Search** plugin's detail page under **Plugins**. They are optional; web search works through Cindy AI without them.
