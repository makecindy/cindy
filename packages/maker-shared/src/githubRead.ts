/** Public GitHub identities never depend on the caller's current task or directory. */
export type GithubPrSelector =
  { url: string } | { repo: string; number: number };
export type GithubDetailKind =
  "checks" | "threads" | "comments" | "reviews" | "rules";
export type GithubReadMethod =
  "get_pr_status" | "get_pr_changes" | "get_pr_details";
export interface GithubReadArgs {
  pr: GithubPrSelector;
  freshness?: "cached_or_refresh" | "refresh";
  after?: string;
  limit?: number;
  kind?: GithubDetailKind;
  item?: string;
  device?: string;
}

export function parseGithubPr(value: unknown): {
  owner: string;
  repo: string;
  prNumber: number;
  url: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_PR");
  const v = value as Record<string, unknown>;
  let owner: string, repo: string, number: unknown;
  if (
    typeof v.url === "string" &&
    v.repo === undefined &&
    v.number === undefined
  ) {
    if (v.url.length > 2048) throw new Error("INVALID_PR");
    let url: URL;
    try {
      url = new URL(v.url);
    } catch {
      throw new Error("INVALID_PR");
    }
    const match =
      /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/.exec(
        url.pathname,
      );
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      !match
    )
      throw new Error("INVALID_PR");
    [, owner, repo] = match;
    number = Number(match[3]);
  } else if (
    typeof v.repo === "string" &&
    v.url === undefined &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo)
  ) {
    [owner, repo] = v.repo.split("/");
    number = v.number;
  } else throw new Error("INVALID_PR");
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  )
    throw new Error("INVALID_PR");
  owner = owner.toLowerCase();
  repo = repo.toLowerCase();
  return {
    owner,
    repo,
    prNumber: number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

/** Shared by UI, MCP, remote IPC and script broker; transport schemas add discovery descriptions. */
export function parseGithubReadArgs(value: unknown): GithubReadArgs {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_ARGS");
  const v = value as Record<string, unknown>;
  const pr = parseGithubPr(v.pr);
  if (
    v.limit !== undefined &&
    (!Number.isInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 100)
  )
    throw new Error("INVALID_LIMIT");
  for (const key of ["after", "item", "device"])
    if (
      v[key] !== undefined &&
      (typeof v[key] !== "string" ||
        !(v[key] as string).length ||
        (v[key] as string).length > 2048)
    )
      throw new Error("INVALID_ARGS");
  if (
    v.kind !== undefined &&
    !["checks", "threads", "comments", "reviews", "rules"].includes(
      String(v.kind),
    )
  )
    throw new Error("INVALID_KIND");
  if (
    v.freshness !== undefined &&
    !["cached_or_refresh", "refresh"].includes(String(v.freshness))
  )
    throw new Error("INVALID_FRESHNESS");
  return {
    pr: { url: pr.url },
    freshness: v.freshness as GithubReadArgs["freshness"],
    after: v.after as string | undefined,
    limit: v.limit as number | undefined,
    kind: v.kind as GithubDetailKind | undefined,
    item: v.item as string | undefined,
    device: v.device as string | undefined,
  };
}
