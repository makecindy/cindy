/** Opt-in native regression; isolated Home and loopback fake model, no credentials.
 * CINDY_CODEX_TEST_BINARY=<binary> vitest run src/agents/codex/goal-ownership.native.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
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
  "disables native goal tools and continuation even when resuming a persisted active goal",
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-goal-ownership-"),
    );
    const requests: Array<{
      body: { input: Array<{ role?: string; content?: unknown }> };
      response: ServerResponse;
    }> = [];
    let replyAutomatically = false;
    const reply = (response: ServerResponse) => {
      const output = [
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
          expect(JSON.stringify(requests[1 + step]!.body)).not.toContain(
            "create_goal",
          );
          expect(completed).toBe(step);
        }
        // Stable system/developer content across Host sends; no per-turn
        // workaround, changing prefix, or extra model request is introduced.
        const prefix = (index: number) =>
          requests[index]!.body.input.filter(
            (item) => item.role === "system" || item.role === "developer",
          ).map((item) => ({ role: item.role, content: item.content }));
        expect(prefix(3)).toEqual(prefix(2));
      } finally {
        await subscription.release();
      }
    } finally {
      for (const host of hosts) await host.retire("native goal test complete");
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);
