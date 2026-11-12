import { describe, expect, test } from "vitest";
import { prepareResponsesCompatibility } from "../index";
import {
    restoreRoutedNamespaceCalls,
    rewriteRoutedNamespaceToolsForUpstream,
} from "../upstream/responses/namespace-tool-compat";

/**
 * A bare declaration may spell out the flattened wire name of a namespace child: Codex emits both
 * shapes when one of its code-mode tools shares a name with a runtime namespace child. Failing the
 * request costs the whole turn — the strict gateway rejects the request, not one tool — so the
 * child is renamed and stays restorable through its request-local alias.
 *
 * These regressions live outside `src/__tests__/upstream/**` because that tree is regenerated from
 * the pinned upstream tests (see `UPSTREAM.json` and `scripts/sync-upstream.mjs`).
 */
describe("namespace tool wire-name collisions", () => {
    test("renames a namespace child whose flattened wire name a bare declaration claims", () => {
        const rewritten = rewriteRoutedNamespaceToolsForUpstream({
            tools: [
                { type: "function", name: "collaboration__followup_task", parameters: {} },
                { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "followup_task", parameters: {} }] },
            ],
            input: [{ type: "function_call", namespace: "collaboration", name: "followup_task", call_id: "call_1", arguments: "{}" }],
        });
        const body = rewritten.body;
        expect(body.tools.map(tool => tool.name)).toEqual([
            "collaboration__followup_task",
            "collaboration__followup_task_2",
        ]);
        expect(body.input[0]).toMatchObject({ name: "collaboration__followup_task_2", call_id: "call_1" });
        expect([...rewritten.aliases]).toEqual([
            ["collaboration__followup_task_2", { namespace: "collaboration", name: "followup_task", kind: "function" }],
            ["collaboration.followup_task", { namespace: "collaboration", name: "followup_task", kind: "function" }],
        ]);
        expect(restoreRoutedNamespaceCalls({ type: "function_call", name: "collaboration__followup_task_2", arguments: "{}" }, rewritten.aliases).value)
            .toEqual({ type: "function_call", name: "followup_task", namespace: "collaboration", arguments: "{}" });
    });

    test("keeps allocating free wire names and reuses one per logical tool", () => {
        const child = { type: "function", name: "read", parameters: {} };
        const rewritten = rewriteRoutedNamespaceToolsForUpstream({
            tools: [
                { type: "function", name: "workspace__read", parameters: {} },
                { type: "function", name: "workspace__read_2", parameters: {} },
                { type: "namespace", name: "workspace", tools: [child] },
            ],
            // The same logical tool declared in a second container keeps the name the first one
            // allocated instead of consuming another suffix.
            input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "workspace", tools: [{ ...child }] }] }],
        });
        expect(rewritten.body.tools.map(tool => tool.name)).toEqual([
            "workspace__read",
            "workspace__read_2",
            "workspace__read_3",
        ]);
        expect(rewritten.body.input[0].tools).toEqual([]);
        expect([...rewritten.aliases.keys()].sort()).toEqual(["workspace.read", "workspace__read_3"]);
    });

    test("rewrites a selector to the disambiguated wire name", () => {
        const rewritten = rewriteRoutedNamespaceToolsForUpstream({
            tools: [
                { type: "function", name: "workspace__read", parameters: {} },
                { type: "namespace", name: "workspace", tools: [{ type: "function", name: "read", parameters: {} }] },
            ],
            tool_choice: { type: "function", namespace: "workspace", name: "read" },
        });
        expect(rewritten.body.tool_choice).toEqual({ type: "function", name: "workspace__read_2" });
        expect(rewritten.aliases.get("workspace__read_2"))
            .toEqual({ namespace: "workspace", name: "read", kind: "function" });
    });

    // A disambiguating suffix must not take a name a later sibling legitimately owns. Reserving
    // every real name first makes the outcome independent of declaration order.
    test("reserves real names before handing out a disambiguating suffix", () => {
        for (const order of [["read", "read_2"], ["read_2", "read"]]) {
            const rewritten = rewriteRoutedNamespaceToolsForUpstream({
                tools: [
                    { type: "function", name: "workspace__read", parameters: {} },
                    {
                        type: "namespace",
                        name: "workspace",
                        tools: order.map(name => ({ type: "function", name, parameters: {} })),
                    },
                ],
            });
            expect(rewritten.body.tools.map(tool => tool.name)).toEqual([
                "workspace__read",
                ...order.map(name => (name === "read" ? "workspace__read_3" : "workspace__read_2")),
            ]);
            expect(rewritten.aliases.get("workspace__read_3")).toMatchObject({ namespace: "workspace", name: "read" });
            expect(rewritten.aliases.get("workspace__read_2")).toMatchObject({ namespace: "workspace", name: "read_2" });
        }
    });

    // Two namespace children that flatten to one wire name are a genuine declaration ambiguity:
    // their dotted spellings alias each other, so renaming one would make the other's restoration
    // depend on which container was rewritten first. That case keeps failing closed.
    test("still fails closed when two namespace children flatten to one wire name", () => {
        expect(() => rewriteRoutedNamespaceToolsForUpstream({
            tools: [
                { type: "namespace", name: "workspace__read", tools: [{ type: "function", name: "x" }] },
                { type: "namespace", name: "workspace", tools: [{ type: "function", name: "read__x" }] },
            ],
        })).toThrow('namespace tool wire-name collision for "workspace__read__x"');
    });

    test("keeps a displaced bare function out of the custom restore", () => {
        const body = {
            tools: [
                { type: "function", name: "collaboration__run", parameters: {} },
                { type: "namespace", name: "collaboration", tools: [{ type: "custom", name: "run", description: "Run raw input" }] },
            ],
        };
        const prepared = prepareResponsesCompatibility(body, { customTools: "functions", namespaceTools: "functions" });
        expect(prepared.body.tools.map(tool => tool.name))
            .toEqual(["collaboration__run", "collaboration__run_2"]);

        // The bare declaration keeps its own name; its ordinary call must not be rewritten into a
        // custom-tool call just because a displaced namespace child used to own that wire name.
        const bare = JSON.stringify({ output: [{ type: "function_call", name: "collaboration__run", call_id: "call_bare", arguments: '{"input":"echo bare"}' }] });
        expect(prepared.restoreJson(bare)).toBe(bare);

        // The displaced custom child still restores through its namespace identity and kind.
        const rewritten = JSON.stringify({ output: [{ type: "function_call", name: "collaboration__run_2", call_id: "call_custom", arguments: '{"input":"echo custom"}' }] });
        expect(JSON.parse(prepared.restoreJson(rewritten)).output[0]).toMatchObject({
            type: "custom_tool_call",
            name: "run",
            namespace: "collaboration",
            input: "echo custom",
        });
    });

    test("keeps a displaced ordinary function out of the custom restore", () => {
        const body = {
            tools: [
                { type: "custom", name: "workspace__read", description: "Read raw input" },
                { type: "namespace", name: "workspace", tools: [{ type: "function", name: "read", parameters: {} }] },
            ],
        };
        const prepared = prepareResponsesCompatibility(body, { customTools: "functions", namespaceTools: "functions" });
        expect(prepared.body.tools.map(tool => tool.name))
            .toEqual(["workspace__read", "workspace__read_2"]);

        // The bare custom tool keeps its own restore path even though a displaced child used the name.
        const bare = JSON.stringify({ output: [{ type: "function_call", name: "workspace__read", call_id: "call_bare", arguments: '{"input":"echo bare"}' }] });
        expect(JSON.parse(prepared.restoreJson(bare)).output[0]).toMatchObject({
            type: "custom_tool_call",
            name: "workspace__read",
        });

        // The displaced child was declared as an ordinary function, so it must not come back as a
        // custom-tool call.
        const rewritten = JSON.stringify({ output: [{ type: "function_call", name: "workspace__read_2", call_id: "call_fn", arguments: '{"q":"x"}' }] });
        expect(JSON.parse(prepared.restoreJson(rewritten)).output[0]).toMatchObject({
            type: "function_call",
            name: "read",
            namespace: "workspace",
        });
    });

    // `tool_choice` narrows the response aliases down to the bare declaration. The custom restore
    // still has to know what the displaced child was, so displacement metadata is derived from the
    // whole rename set instead of the authorized aliases.
    test("keeps displacement metadata when tool_choice only authorizes the bare declaration", () => {
        const body = {
            tools: [
                { type: "function", name: "collaboration__run", parameters: {} },
                { type: "namespace", name: "collaboration", tools: [{ type: "custom", name: "run", description: "Run raw input" }] },
            ],
            tool_choice: { type: "function", name: "collaboration__run" },
        };
        const prepared = prepareResponsesCompatibility(body, { customTools: "functions", namespaceTools: "functions" });
        const bare = JSON.stringify({ output: [{ type: "function_call", name: "collaboration__run", call_id: "call_bare", arguments: '{"input":"echo bare"}' }] });
        expect(prepared.restoreJson(bare)).toBe(bare);
    });

    // The streaming path classifies each item before it restores it; without the same displacement
    // data an ordinary call keeps an `fc_` id while its argument events are renamed under `ctc_`.
    test("classifies streamed calls with the same displacement", () => {
        const body = {
            tools: [
                { type: "function", name: "collaboration__run", parameters: {} },
                { type: "namespace", name: "collaboration", tools: [{ type: "custom", name: "run", description: "Run raw input" }] },
            ],
        };
        const prepared = prepareResponsesCompatibility(body, { customTools: "functions", namespaceTools: "functions" });
        const rewrite = prepared.createStreamRewrite();
        const blocks = [
            { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "collaboration__run", arguments: "" } },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"input":"echo bare"}' },
            { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"input":"echo bare"}' },
            { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "collaboration__run", arguments: '{"input":"echo bare"}' } },
        ].map(payload => `data: ${JSON.stringify(payload)}`);
        const out = blocks.map(block => rewrite(block).join("")).join("");
        expect(out).not.toContain("custom_tool_call_input");
        expect(out).not.toContain('"ctc_');
        expect(out).toContain("response.function_call_arguments.delta");
        expect(out).toContain('"type":"function_call"');
    });

    // Both declarations are custom here, so the shared name proves nothing about the child. The
    // child keeps the kind it was declared with instead of being treated as an ordinary function.
    test("keeps a custom child custom when the bare declaration is custom too", () => {
        const body = {
            tools: [
                { type: "custom", name: "workspace__read", description: "Bare custom" },
                { type: "namespace", name: "workspace", tools: [{ type: "custom", name: "read", description: "Child custom" }] },
            ],
        };
        const prepared = prepareResponsesCompatibility(body, { customTools: "functions", namespaceTools: "functions" });
        const rewritten = JSON.stringify({ output: [{ type: "function_call", name: "workspace__read_2", call_id: "call_child", arguments: '{"input":"echo child"}' }] });
        expect(JSON.parse(prepared.restoreJson(rewritten)).output[0]).toMatchObject({
            type: "custom_tool_call",
            name: "read",
            namespace: "workspace",
            input: "echo child",
        });
    });

    // Function-argument repair indexes its catalog by wire name. A displaced child answers to the
    // allocated name, so the catalog has to record it there; otherwise the ambiguous preferred name
    // makes repair skip both declarations.
    test("repairs function arguments for both the bare tool and the displaced child", () => {
        const parameters = { type: "object", properties: { line: { type: "integer" } } };
        const body = {
            tools: [
                { type: "function", name: "workspace__read", parameters },
                { type: "namespace", name: "workspace", tools: [{ type: "function", name: "read", parameters }] },
            ],
        };
        const prepared = prepareResponsesCompatibility(body, {
            customTools: "functions",
            namespaceTools: "functions",
            repairFunctionArguments: true,
        });
        const child = JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "function_call", name: "workspace__read_2", call_id: "call_child", arguments: '{"line":12.0}' }] } });
        expect(JSON.parse(prepared.restoreJson(child)).response.output[0]).toMatchObject({
            name: "read",
            namespace: "workspace",
            arguments: '{"line":12}',
        });
        const bare = JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "function_call", name: "workspace__read", call_id: "call_bare", arguments: '{"line":3.0}' }] } });
        expect(JSON.parse(prepared.restoreJson(bare)).response.output[0]).toMatchObject({
            name: "workspace__read",
            arguments: '{"line":3}',
        });
    });
});
