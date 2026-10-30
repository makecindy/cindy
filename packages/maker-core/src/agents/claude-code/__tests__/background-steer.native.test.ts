/**
 * 2026-10-24 phone interruption regression, through real Session + Claude adapter + CLI.
 * Native tier (explicit CINDY_CLAUDE_TEST_BINARY): unit mocks cannot prove that the SDK
 * consumes another user input while its background Agent is still running. The model
 * endpoint is loopback and uses a fake key; the child response is explicitly released.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAgent } from "../index.js";
import { Session } from "../../../session.js";
import type { Logger } from "../../../interfaces/logger.js";
import type { AgentEvent } from "../../../types/events.js";

const binaryPath = process.env.CINDY_CLAUDE_TEST_BINARY;

describe.skipIf(!binaryPath)(
  "background interruption with real Claude runtime",
  () => {
    it("delivers a correction before the child completes and then settles once", async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "cindy-background-steer-native-"),
      );
      const seen: AgentEvent[] = [];
      let releaseChild: (() => void) | undefined;
      let parentRequests = 0;
      let correctionRequests = 0;
      let session: Session | undefined;
      let responseId = 0;
      const reply = (
        res: ServerResponse,
        model: string,
        content: Record<string, unknown>[],
      ) => {
        const stop = content.some((block) => block.type === "tool_use")
          ? "tool_use"
          : "end_turn";
        const events: Record<string, unknown>[] = [
          {
            type: "message_start",
            message: {
              id: `msg_${++responseId}`,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 100, output_tokens: 0 },
            },
          },
        ];
        content.forEach((block, index) => {
          events.push({
            type: "content_block_start",
            index,
            content_block:
              block.type === "tool_use"
                ? { ...block, input: {} }
                : { type: "text", text: "" },
          });
          events.push({
            type: "content_block_delta",
            index,
            delta:
              block.type === "tool_use"
                ? {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(block.input),
                  }
                : { type: "text_delta", text: block.text },
          });
          events.push({ type: "content_block_stop", index });
        });
        events.push({
          type: "message_delta",
          delta: { stop_reason: stop },
          usage: { output_tokens: 10 },
        });
        events.push({ type: "message_stop" });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
        );
      };
      const server = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        if (req.url?.includes("count_tokens")) {
          res.writeHead(200).end(JSON.stringify({ input_tokens: 100 }));
          return;
        }
        const body = JSON.parse(raw);
        const users = (body.messages ?? []).filter(
          (message: { role: string }) => message.role === "user",
        );
        const texts = users.flatMap(
          (message: {
            content: string | Array<{ type: string; text?: string }>;
          }) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text ?? ""),
        );
        if (texts.some((text: string) => text === "BACKGROUND_STEER_CHILD")) {
          releaseChild = () =>
            reply(res, body.model, [{ type: "text", text: "CHILD_DONE" }]);
          return;
        }
        if (
          texts.some((text: string) => text.includes("BACKGROUND_STEER_START"))
        ) {
          parentRequests++;
          const corrected = texts.some((text: string) =>
            text.includes("BACKGROUND_STEER_CORRECTION"),
          );
          if (corrected) correctionRequests++;
          reply(
            res,
            body.model,
            parentRequests === 1
              ? [
                  {
                    type: "tool_use",
                    id: "tool_background_worker",
                    name: "Agent",
                    input: {
                      description: "Controlled background worker",
                      subagent_type: "general-purpose",
                      prompt: "BACKGROUND_STEER_CHILD",
                      run_in_background: true,
                    },
                  },
                ]
              : [
                  {
                    type: "text",
                    text: corrected ? "CORRECTION_ACK" : "WAITING_FOR_CHILD",
                  },
                ],
          );
          return;
        }
        reply(res, body.model, [{ type: "text", text: "OK" }]);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;
      const logger: Logger = {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
          return logger;
        },
      };
      try {
        const agent = new ClaudeCodeAgent({
          binaryPath: binaryPath!,
          logger,
          runtimeConfig: { endpoint: `http://127.0.0.1:${port}` },
          auth: {
            getState: async () => ({ authenticated: true }),
            triggerLogin: async () => ({ authenticated: true }),
            logout: async () => {},
            getAuthEnv: async () => ({
              ANTHROPIC_API_KEY: "invalid-loopback-test-key",
              CLAUDE_CONFIG_DIR: path.join(root, "config"),
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              DISABLE_TELEMETRY: "1",
              CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
            }),
          },
        });
        const handle = await agent.startSession({
          sessionId: "native-background-steer",
          workingDir: root,
          model: "claude-sonnet-4-5-20250929",
          permissionMode: "bypassPermissions",
        });
        session = new Session({
          id: "native-background-steer",
          agentKind: "claude-code",
          workDir: root,
          handle,
          capabilities: agent.capabilities,
          logger,
          turnStallMs: 0,
        });
        session.onEvent((event) => seen.push(event));
        await session.send("BACKGROUND_STEER_START");
        await expect
          .poll(
            () =>
              seen.some(
                (event) =>
                  event.type === "done" &&
                  event.turnContinuationId !== undefined,
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
        await expect
          .poll(() => Boolean(releaseChild), { timeout: 30_000 })
          .toBe(true);
        expect(session.isTurnRunning()).toBe(true);
        await session.steer("BACKGROUND_STEER_CORRECTION");
        await expect
          .poll(() => correctionRequests, { timeout: 30_000 })
          .toBe(1);
        expect(handle.listBackgroundTasks?.()).toHaveLength(1);
        await expect
          .poll(() => seen.filter((event) => event.type === "done").length, {
            timeout: 30_000,
          })
          .toBe(2);
        releaseChild!();
        releaseChild = undefined;
        await expect
          .poll(() => session!.isTurnRunning(), { timeout: 30_000 })
          .toBe(false);
        expect(
          seen.filter(
            (event) =>
              event.type === "done" && event.turnContinuationId === undefined,
          ),
        ).toHaveLength(1);
        expect(seen.filter((event) => event.type === "error")).toEqual([]);
      } catch (error) {
        console.error(
          "Native fixture state",
          JSON.stringify({
            parentRequests,
            correctionRequests,
            events: seen.map((event) => ({
              type: event.type,
              data: event.data,
              continuation: event.turnContinuationId,
            })),
          }),
        );
        throw error;
      } finally {
        releaseChild?.();
        await session?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    }, 120_000);
  },
);
