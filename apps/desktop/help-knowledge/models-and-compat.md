---
id: models-and-compat
title: Choosing a model
summary: Pick a task's model from the model selector in the composer; Cindy picks the engine (Claude Code / Codex / Pi) for you, and Customize lets you change engine, reasoning effort, and Fast. Compatibility-mode engines are off by default and are turned on per model in Settings > Providers. Account-pool assignment and engine-specific credential changes are separate.
tab: providers
---
You pick the model a task uses from the **model selector in the composer toolbar** (the pill showing the current model). It works the same for a new task and inside an existing one.

**The model panel:**

- A search box at the top; a rail on the left with **Recent**, **Favorites**, **All**, and one icon per connected provider (source); the model list on the right; and **Configure models** at the bottom to connect more sources.
- You choose a **model**; Cindy automatically picks the recommended **engine** (Claude Code, Codex, or Pi) for it and shows it in the pill.
- Hover a model row and click **Customize** (or right-click the row) to change its engine, **Reasoning Effort**, and **Speed** (Fast, where supported). **Reset to recommended** undoes your changes.
- Click ☆ on a row to **Save to favorites** — a favorite keeps that exact setup (source, model, engine, effort, Fast). **Recent** lists the last few setups you used.

**Default model for a new task:**

- It depends on what you've connected: with a ChatGPT (OpenAI) subscription it's **GPT-6.1 Sol** on Codex; with a Claude (Anthropic) subscription it's **Opus 5.5** on Claude Code; otherwise it's Cindy AI's **Auto** on Pi. After that, a new task starts with the model you last picked.

**Switching mid-task:**

- Open the selector and pick a different model. It applies from your **next message**; while a switch is pending, the pill's tooltip shows "Current" and "Next message".
- If the new model runs on a **different engine**, Cindy asks you to confirm (**Switch Agent?**). The new engine continues from a handoff summary of the conversation, so some reasoning or details may not carry over perfectly.
- A **provider/account change is not the same as changing the account-pool strategy**. A strategy governs new assignments; healthy existing tasks normally retain their account (see the Providers topic). Changing subscription accounts can require a context handoff and runtime rebuild even when the engine stays the same.
- **Engine differences:** Claude Code's native account credentials are tied to its process; Codex may need to rebuild when credential mode or native thread identity changes. Pi uses its own runtime compatibility check and may refresh a compatible route, require a rebuild, or reject an unavailable target. Pi is not a guarantee of restart-free subscription-account switching, and these lifecycle differences do not mean that only Pi can use account-pool assignment.

**Using non-Anthropic models:**

- There's no global compatibility toggle to flip. Each model lists the engines that support it natively, and the recommended one is chosen automatically.
- Some engines can only run a model in **Compatibility mode** (requests are converted). These are **off by default**, because they can be unstable. To turn one on, open **Settings > Providers**, open the model's **Advanced settings**, and enable that engine under **Engine support**. It is then shown with a "Compatibility mode" label in the model's Customize options.

**Notes:**

- Which models you can pick depends on the sources connected in **Settings > Providers** (see the Providers topic). Use **Configure models** at the bottom of the panel to get there.
- Models from your other computers or shared with you can also appear in the panel, labeled with where they run.
