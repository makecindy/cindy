/** Opt-in native wiring check: fake models and MCP, no credentials or external requests.
 * CINDY_CODEX_TEST_BINARY=<binary> vitest run src/agents/codex/native-auto-review-policy.native.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { AppServerHost } from "./app-server/host.js";
import { createStdioTransport } from "./app-server/stdioTransport.js";
import { nativeAutoReviewContinuationConfig } from "./native-auto-review-policy.js";
import defaultPolicy from "./native-auto-review-policy-0.145.0.md?raw";
import currentPolicy from "./native-auto-review-policy-0.153.4.md?raw";
import { AUTO_REVIEW_CONTINUATION_POLICY } from "../shared/continuation-policy.js";
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
  "retains the stock tenant policy and delivers continuation rules to the native reviewer",
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-native-review-contract-"),
    );
    const policies: string[] = [];
    const mainPrefixes: string[] = [];
    let mainRequests = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.end('{"models":[]}');
        return;
      }
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      let output: unknown[];
      if (body.model === "codex-auto-review") {
        policies.push(body.instructions ?? body.input
          .filter((item: { role?: string }) => item.role === "developer")
          .flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? [])
          .map((item: { text?: string }) => item.text ?? "").join("\n"));
        // This verdict exercises transport only. It is NOT a model behavior evaluation.
        output = [
          {
            type: "message",
            role: "assistant",
            id: "review-output",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: '{"outcome":"allow"}',
                annotations: [],
              },
            ],
          },
        ];
      } else if (++mainRequests % 2 === 1) {
        mainPrefixes.push(
          JSON.stringify(
            body.input.filter(
              (item: { role?: string }) =>
                item.role === "developer" || item.role === "system",
            // Native 0.153 assigns per-thread IDs; compare all actual prompt content.
            ).map(({ id: _id, ...item }: { id?: string; [key: string]: unknown }) => item),
          ),
        );
        output = [
          {
            type: "custom_tool_call",
            name: "exec",
            call_id: `call-${mainRequests}`,
            input:
              'text(await tools.mcp__cindy_scheduler__call_tool({name:"schedule_create",args:{bindToCurrentSession:true,cronExpr:"*/10 * * * *",prompt:"Follow only example/app PR 42; stop when done or cancelled; do not merge."}}));',
          },
        ];
      } else {
        output = [
          {
            type: "message",
            role: "assistant",
            id: "main-output",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Simulation complete.",
                annotations: [],
              },
            ],
          },
        ];
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const item of output)
        response.write(
          `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
        );
      response.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_test",
            object: "response",
            status: "completed",
            model: body.model,
            output,
            usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
          },
        })}\n\n`,
      );
    });
    let host: AppServerHost | undefined;
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing loopback address");
      const mcpPath = path.join(root, "mcp.mjs");
      await fs.writeFile(
        mcpPath,
        `import { createInterface } from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line); if(r.id===undefined)continue; let result={};
 if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'cindy_scheduler',version:'1'}};
 if(r.method==='tools/list')result={tools:[{name:'call_tool',description:'Continue authorized work periodically.',inputSchema:{type:'object',properties:{name:{type:'string'},args:{type:'object'}},required:['name','args']}}]};
 if(r.method==='tools/call')result={content:[{type:'text',text:'Simulation only; no schedule created.'}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}`,
      );
      host = new AppServerHost({
        logger,
        clientInfo: { name: "cindy-native-review-test", version: "1" },
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
              `mcp_servers.cindy_scheduler.command=${JSON.stringify(process.execPath)}`,
              "-c",
              `mcp_servers.cindy_scheduler.args=[${JSON.stringify(mcpPath)}]`,
            ],
          }),
      });
      const init = await host.ensureStarted();
      const expectedPolicy = init.userAgent?.includes('/0.153.4 ') ? currentPolicy : defaultPolicy;
      const config = nativeAutoReviewContinuationConfig(init.userAgent, {});
      expect(config["auto_review.policy"]).toBeTruthy();
      for (const overrides of [{}, config]) {
        const result = await host.request<{ thread: { id: string } }>(
          "thread/start",
          {
            cwd: root,
            model: "gpt-5.6-luna",
            modelProvider: "probe",
            ephemeral: true,
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: "workspace-write",
            config: overrides,
          },
        );
        let complete = false;
        const subscription = host.subscribeThread(result.thread.id, {
          turnCompleted: () => {
            complete = true;
          },
        });
        try {
          await host.request("turn/start", {
            threadId: result.thread.id,
            input: [{ type: "text", text: "提交当前 example/app 的 PR 42。" }],
          });
          await expect.poll(() => complete, { timeout: 15_000 }).toBe(true);
        } finally {
          await subscription.release();
        }
      }
      expect(policies).toHaveLength(2);
      const stockTenant = policies[0]!
        .split(/# (?:Policy Configuration|Security Policy)\n/)[1]!
        .split("# Investigation Guidelines")[0]!
        .trim();
      expect(stockTenant).toBe(expectedPolicy.trim());
      expect(policies[0]).not.toContain(AUTO_REVIEW_CONTINUATION_POLICY);
      expect(policies[1]).toContain(expectedPolicy.trim());
      expect(policies[1]).toContain(AUTO_REVIEW_CONTINUATION_POLICY);
      expect(mainPrefixes).toHaveLength(2);
      expect(mainPrefixes[1]).toBe(mainPrefixes[0]);
    } finally {
      await host?.retire("native review test complete");
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);
