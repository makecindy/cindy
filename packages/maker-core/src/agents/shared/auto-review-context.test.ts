import { describe, it, expect, vi } from "vitest";
import {
  withAutoReviewContext,
  resolveAutoReviewDecision,
  type AutoReviewDelegate,
  type AutoReviewRequest,
  type AutoReviewDecision,
} from "./auto-review-decision.js";
const request: AutoReviewRequest = {
  sessionId: "s",
  agentKind: "pi",
  model: "m",
  userIntent: "",
  workspaceRoots: ["/answer"],
  platform: "linux",
  action: { kind: "exec", command: "npm test", cwd: "/answer" },
};
describe("live review context across decision caches", () => {
  it("rechecks revocation even when an allow decision is already cached", async () => {
    let active = true;
    const delegate: AutoReviewDelegate = async () => ({ verdict: "allow" });
    delegate.prepareRequest = async (r) =>
      active
        ? {
            ...r,
            delegatedTask: {
              source: "approved-plugin",
              pluginId: "p",
              role: "worker",
              task: "Run tests",
              workingDir: "/answer",
              authorizationRevision: "v1",
            },
          }
        : { ...r, authorizationError: "revoked" };
    const evaluate = vi.fn(async (): Promise<AutoReviewDecision> => ({
      verdict: "allow",
    }));
    expect(
      (await withAutoReviewContext(request, delegate, evaluate)).verdict,
    ).toBe("allow");
    active = false;
    expect(
      (await withAutoReviewContext(request, delegate, evaluate)).verdict,
    ).toBe("block");
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it("rejects a stale allow after user restriction or owner epoch changes during review", async () => {
    let revision = "1";
    const delegate: AutoReviewDelegate = async () => ({ verdict: "allow" });
    delegate.prepareRequest = async (r) => ({
      ...r,
      delegatedTask: {
        source: "approved-plugin",
        pluginId: "p",
        role: "worker",
        task: "Run tests",
        workingDir: "/answer",
        authorizationRevision: revision,
      },
    });
    expect(
      (
        await withAutoReviewContext(request, delegate, async () => {
          revision = "2";
          return { verdict: "allow" };
        })
      ).verdict,
    ).toBe("block");
  });
  it("asks on infrastructure failure without evaluating or using cached authorization", async () => {
    const delegate: AutoReviewDelegate = async () => null;
    delegate.prepareRequest = async () => {
      throw Error("DB changed");
    };
    const evaluate = vi.fn();
    expect(
      await withAutoReviewContext(request, delegate, evaluate),
    ).toMatchObject({ verdict: "ask", unavailable: true });
    expect(evaluate).not.toHaveBeenCalled();
  });
});

it('delegated local edits still review user restrictions instead of using the workspace fast path', async () => {
 const delegate = vi.fn(async ():Promise<AutoReviewDecision> => ({verdict:'block'}));
 const scoped:AutoReviewRequest={...request,userIntent:'Only read; do not modify files',
 delegatedTask:{source:'approved-plugin',pluginId:'eval',role:'worker',task:'Fix project',workingDir:'/answer',authorizationRevision:'1'},
 action:{kind:'file-write',path:'/answer/src/a.ts'}};
 expect((await resolveAutoReviewDecision(scoped,delegate)).verdict).toBe('block');
 expect(delegate).toHaveBeenCalledOnce();
});

it('reviews task-level read restrictions even without separate user text', async () => {
  const delegate = vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'block' }));
  const scoped: AutoReviewRequest = { ...request, userIntent: '',
    delegatedTask: { source: 'approved-plugin', pluginId: 'eval', role: 'worker',
      task: 'Inspect src only. Do not read fixtures/private.txt.', workingDir: '/answer', authorizationRevision: '1' },
    action: { kind: 'read', path: '/answer/fixtures/private.txt' } };
  expect((await resolveAutoReviewDecision(scoped, delegate)).verdict).toBe('block');
  expect(delegate).toHaveBeenCalledOnce();
});

it('does not execute a stale allow when the final authority lookup fails', async () => {
  let calls = 0;
  const delegate: AutoReviewDelegate = async () => null;
  delegate.prepareRequest = async r => { if (++calls === 2) throw Error('storage offline'); return r; };
  expect(await withAutoReviewContext(request, delegate, async () => ({verdict: 'allow'})))
    .toMatchObject({verdict: 'ask', unavailable: true});
});
