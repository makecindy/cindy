---
id: usage
title: Usage, billing, and Activity Monitor
summary: Where to see how much you've used — Settings > Usage history (token usage by day, agent, model, and session), Settings > Usage and billing (plan, balance, top-ups, orders), the macOS menu bar usage icon, and Activity Monitor (CPU / memory of Cindy and agent processes).
---
Cindy has several places that answer "how much have I used?". Pick the one that matches the question.

**Settings > Usage history — tokens used in Cindy:**

- Shows token usage produced inside Cindy. It's available whenever you're signed in, including local mode. It counts tokens, not money.
- **Device**: **All devices** (the default, combined across your computers) or one device such as **This device**. Other computers are read only while they're online and allow remote control; if one can't be reached, its last-read data is used and the page warns that totals may be low.
- **Time range**: **All time**, **Last 30 days** (default), **Last 7 days**, or **Today**. Use **Date**, or click a day in the heatmap, to look at a single day.
- Cards: **Overview** (tokens, **Active streak**, cache hit rate, **Models used**), **Activity heatmap**, **Daily tokens (30d)** stacked by model, **By Agent / harness**, **By model** (input, output, cache read, cache write, cache hit rate), and **Top sessions by tokens** — click a session there to open it (when it's reachable).
- Recording started when this page shipped; earlier history isn't backfilled.

**Settings > Usage and billing — your Cindy plan and balance:**

- Shown only when you're signed in with a personal Cindy account (not local mode or an organization account).
- **Current plan** — your subscription, renewal or end date, and **View plans** / **Change plan**. You can **Cancel Subscription** (no refund; the plan stays available until the period ends, and you can't buy a new plan until then) or **Resume Subscription**. Stripe-billed plans also offer **Manage in Stripe**.
- **Available balance** — **Plan Balance**, **Top-up Balance**, and **Promotional Balance**. **Add Funds** buys more.
- **Balance Usage** — how much of each balance is used and remaining, plus **Promotional Balance Details** (each grant's amount and expiry).
- **Order history** — top-up and subscription orders started in Cindy, with status. Unpaid orders are canceled automatically when they time out. **Request Invoice** on a completed order shows the details to email to support.
- Provider pages link here too: **View usage** / **Buy a plan** on **Cindy AI** in **Settings > Providers** (see the providers topic).

**Menu bar (macOS):**

- **Show remaining usage in the menu bar** (on by default) is in **Settings > General > App Behavior**. It adds a Cindy icon to the macOS menu bar; click it to see what's left on your subscriptions, your Cindy balance, and today's usage.

**Activity Monitor — what's using CPU and memory:**

- Open the **Menu** button at the top left and choose **Activity Monitor**. It opens in its own window.
- **Agent Processes** (the agent runtimes behind your tasks, with the task they belong to) and **App Processes** (Cindy's own processes), each with **CPU**, **Memory**, and **PID**. Click a column to sort.
- Select an agent process and click **Stop Process** to force-stop it. Every task using that process is interrupted; send another message in the task to start its agent again. Cindy's own app processes can't be stopped here.
- It shows processes on this computer only, not on remote computers you control.

**Other usage views:**

- Voice input usage (duration, count, estimated cost): **Settings > Voice Input** (see the voice input topic).
- A plugin's own calls: **Your calls** on its page under **Settings > Plugins**; a skill's recent use: its **Usage** panel on the skill detail page.
