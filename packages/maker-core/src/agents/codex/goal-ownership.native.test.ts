/** Opt-in native regression; isolated Home and loopback fake model, no credentials.
 * CINDY_CODEX_TEST_BINARY=<binary> vitest run src/agents/codex/goal-ownership.native.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { CodexAgent } from "./index.js";
import { AppServerHost } from "./app-server/host.js";
import { createStdioTransport } from "./app-server/stdioTransport.js";
import type { Logger } from "../../interfaces/logger.js";

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => logger,
};

it.skipIf(!binaryPath)(
  "disables native Goal execution in cold resumes and auxiliary oneShot calls",
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-goal-ownership-"),
    );
    const requests: Array<{
      body: { input: Array<{ role?: string; content?: unknown; call_id?: string; output?: unknown }> };
      response: ServerResponse;
    }> = [];
    let replyAutomatically = false;
    let pendingOutputs: Array<Array<Record<string, unknown>>> = [];
    const reply = (response: ServerResponse) => {
      const output = pendingOutputs.shift() ?? [
        {
          type: "message",
          id: "answer",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "One step completed.",
              annotations: [],
            },
          ],
        },
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [output_index, item] of output.entries()) {
        response.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`);
      }
      response.end(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "response",
            status: "completed",
            output,
            usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
          },
        })}\n\n`,
      );
    };
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.end('{"models":[]}');
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ body: JSON.parse(body), response });
      if (replyAutomatically) reply(response);
    });
    // A 0.166 resumed request can retain obsolete tool descriptions in history.
    // Probe the live registry and execution instead of searching that history.
    const goalCalls = [
      { name: "get_goal", args: {} },
      { name: "update_goal", args: { status: "paused" } },
      { name: "create_goal", args: { objective: "Must not be created", token_budget: 1000 } },
    ];
    const queueGoalProbes = (label: string) => {
      pendingOutputs = goalCalls.flatMap(({ name, args }) => [
        [{ type: "function_call", name, call_id: `${label}-${name}-direct`, arguments: JSON.stringify(args) }],
        [{ type: "custom_tool_call", name: "exec", call_id: `${label}-${name}-exec`, input:
          `text(ALL_TOOLS.filter(t => /^(get_goal|update_goal|create_goal)$/.test(t.name)).map(t => t.name)); ` +
          `try { text(await tools.${name}(${JSON.stringify(args)})); } catch (error) { text(String(error)); }`,
        }],
      ]);
    };
    const expectGoalProbesRejected = (start: number, label: string) => {
      // Six tool responses plus one final answer, with no Goal-owned extra turn.
      expect(requests).toHaveLength(start + 7);
      const input = requests.at(-1)!.body.input.filter(item => item.output !== undefined);
      for (const { name } of goalCalls) {
        expect(input.find(item => item.call_id === `${label}-${name}-direct`)?.output)
          .toBe(`unsupported call: ${name}`);
        expect(input.find(item => item.call_id === `${label}-${name}-exec`)?.output)
          .toEqual(expect.arrayContaining([
            { type: "input_text", text: "[]" },
            { type: "input_text", text: `TypeError: tools.${name} is not a function` },
          ]));
      }
      expect(pendingOutputs).toHaveLength(0);
    };
    const hosts: AppServerHost[] = [];
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing loopback address");
      const makeHost = () => {
        const host = new AppServerHost({
          logger,
          clientInfo: { name: "cindy-goal-ownership-test", version: "1" },
          createTransport: () =>
            createStdioTransport({
              binaryPath: binaryPath!,
              cwd: root,
              env: {
                PATH: process.env.PATH ?? "",
                HOME: root,
                USERPROFILE: root,
                CODEX_HOME: root,
                ...(process.env.SystemRoot
                  ? { SystemRoot: process.env.SystemRoot }
                  : {}),
              },
              extraArgs: [
                "-c",
                'model_provider="probe"',
                "-c",
                'model_providers.probe.name="Probe"',
                "-c",
                `model_providers.probe.base_url="http://127.0.0.1:${address.port}"`,
                "-c",
                'model_providers.probe.wire_api="responses"',
                "-c",
                "model_providers.probe.requires_openai_auth=false",
                "-c",
                "features.code_mode=false",
                "-c",
                "features.code_mode_only=false",
              ],
            }),
        });
        hosts.push(host);
        return host;
      };
      const original = makeHost();
      await original.ensureStarted();
      const { thread } = await original.request<{ thread: { id: string } }>(
        "thread/start",
        {
          cwd: root,
          model: "gpt-6-astra",
          modelProvider: "probe",
          approvalPolicy: "never",
          sandbox: "read-only",
          config: { "features.goals": true },
        },
      );
      await original.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "Complete the goal." }],
      });
      await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
      await original.request("thread/goal/set", {
        threadId: thread.id,
        objective: "Complete two steps",
        status: "active",
      });
      reply(requests[0]!.response);
      // Reproduce the second, provider-owned turn with no new Host send.
      await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2);
      expect(JSON.stringify(requests[0]!.body)).toContain("create_goal");
      await original.retire("cold resume fixture");

      replyAutomatically = true;
      const resumed = makeHost();
      await resumed.ensureStarted();
      await resumed.request("thread/resume", {
        threadId: thread.id,
        cwd: root,
        model: "gpt-6-astra",
        modelProvider: "probe",
        approvalPolicy: "never",
        sandbox: "read-only",
        config: { "features.goals": false },
      });
      const goal = await resumed.request<{ goal: { status: string } }>(
        "thread/goal/get",
        { threadId: thread.id },
      );
      expect(goal.goal.status).toBe("active");
      let completed = 0;
      const subscription = resumed.subscribeThread(thread.id, {
        turnCompleted: () => {
          completed += 1;
        },
      });
      try {
        for (const step of [1, 2]) {
          await resumed.request("turn/start", {
            threadId: thread.id,
            input: [{ type: "text", text: `Run Cindy-owned step ${step}.` }],
          });
          await expect.poll(() => completed, { timeout: 15_000 }).toBe(step);
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(requests).toHaveLength(2 + step);
          expect(completed).toBe(step);
        }
        // Stable system/developer content across Host sends; no per-turn
        // workaround, changing prefix, or extra model request is introduced.
        const prefix = (index: number) =>
          requests[index]!.body.input.filter(
            (item) => item.role === "system" || item.role === "developer",
          ).map((item) => ({ role: item.role, content: item.content }));
        expect(prefix(3)).toEqual(prefix(2));

        const probeStart = requests.length;
        queueGoalProbes("resumed");
        await resumed.request("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text: "Probe disabled Goal tools." }],
        });
        await expect.poll(() => completed, { timeout: 15_000 }).toBe(3);
        // real-wait: Observe the real app-server after turn completion for an unwanted Goal-owned request.
        await new Promise(resolve => setTimeout(resolve, 500));
        expectGoalProbesRejected(probeStart, "resumed");
        expect(await resumed.request("thread/goal/get", { threadId: thread.id })).toEqual(goal);

      } finally {
        await subscription.release();
      }

      // Exercise the production oneShot thread/start, not a duplicate of its config.
      // Only the host acquisition is injected to keep native auth/model I/O isolated.
      const utilityHost = makeHost();
      const agent = new CodexAgent({
        runtimeConfig: {},
        logger,
        binaryPath: binaryPath!,
        auth: {
          getState: async () => ({ authenticated: true }),
          triggerLogin: async () => ({ authenticated: true }),
          logout: async () => {},
          getAuthEnv: async () => ({}),
        },
      });
      const utilityHosts = Reflect.get(agent, "hosts") as Map<string, AppServerHost>;
      utilityHosts.set("goal-test-utility", utilityHost);
      Object.defineProperty(agent, "getUtilityHost", {
        value: async () => ({ key: "goal-test-utility", host: utilityHost }),
      });
      const probeStart = requests.length;
      queueGoalProbes("oneShot");
      expect(await agent.oneShot("Produce a bounded title or summary.", {
        model: "gpt-6-astra", timeoutMs: 15_000,
      })).toBe("One step completed.");
      // real-wait: Observe the native oneShot host after release for an unwanted Goal continuation.
      await new Promise(resolve => setTimeout(resolve, 500));
      expectGoalProbesRejected(probeStart, "oneShot");
    } finally {
      for (const host of hosts) await host.retire("native goal test complete");
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
