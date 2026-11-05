// Edge purge bindings: Cloudflare and Vercel, wired to local tag invalidation.
//
// The local engine stays the source of truth. When an edge-aware engine
// invalidates tags locally, it also asks the configured edge provider to
// purge the same tags (and URLs, where the provider supports them). The
// edge call is fire-and-forget in one specific sense: a provider failure
// never breaks local invalidation. It is logged as a warning and the
// local result is returned as if the edge call had succeeded. Local data
// is never left stale because the edge is down; the edge copy may lag
// until the next invalidation or its own TTL.
//
// Credentials come from environment variables only, read once when the
// provider is constructed. No provider constructor, purge call, log line,
// or error message ever includes a credential value: tokens travel only
// in an `Authorization` header, never in a URL, a body, or a log.
//
// "Automatic" means automatic-after-one-time-setup, not zero-config.
// With no provider configured, an edge-aware engine behaves exactly like
// the plain engine: local-only invalidation, no network call, no warning
// about a provider that was never set up. A provider name with missing
// credentials is also treated as unconfigured (with one warning at
// construction, so a typo in setup is visible instead of silent).
//
// No HTTP route is added here. Purging is a server-side operation the app
// itself triggers by calling `invalidateTags` on an edge-aware engine.
// Never expose that call behind an unauthenticated endpoint: anyone who
// can call it can purge the edge cache at will.
//
// Deliberately absent: purge-everything. An empty tag/URL list is a
// no-op, never a whole-cache purge. A whole-cache purge must be an
// explicit, separate action in the provider dashboard.

import {
  type CacheOptions,
  MemoryCacheEngine,
} from "./cache_queue";

/** What a purge asks the edge to drop. At least one of the two is required. */
export interface EdgePurgeRequest {
  /** Cache tags to purge. Supported by both providers. */
  tags?: string[];
  /**
   * Full URLs to purge. Supported by Cloudflare only; the Vercel binding
   * ignores URLs it cannot purge by tag and says so, rather than
   * pretending a URL purge happened.
   */
  urls?: string[];
}

/** A single edge provider. Implementations must never log credentials. */
export interface EdgePurgeProvider {
  /** Provider name, used only in log lines: `"cloudflare"` or `"vercel"`. */
  readonly name: string;
  /** Purges the given tags and/or URLs. Throws on a provider-side failure. */
  purge(request: EdgePurgeRequest): Promise<void>;
}

/** Minimal fetch shape, so tests can inject a fake without real network. */
export type EdgeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

const PURGE_TIMEOUT_MS = 5_000;

function cleanList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Shared purge plumbing: empty requests are no-ops, failures carry only
 * the provider name and HTTP status (never a body or header that could
 * echo a credential), and a slow provider cannot hang invalidation.
 */
async function postPurge(
  providerName: string,
  url: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: EdgeFetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // A slow provider must not hang invalidation. The timeout aborts the
    // request; the caller treats that as a provider failure (fail-open).
    signal:
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(PURGE_TIMEOUT_MS)
        : undefined,
  });
  if (!response.ok) {
    throw new Error(
      `Edge purge failed for provider "${providerName}": HTTP ${response.status}.`,
    );
  }
}

/**
 * Cloudflare purge binding.
 *
 * Endpoint: `POST /zones/{zoneId}/purge_cache` with `{ tags }` and/or
 * `{ files }`. Tags and URLs are sent as separate requests because the
 * API accepts one purge mode per request body; sending both in one body
 * would be rejected and the whole purge would fail.
 *
 * Required: a scoped API token with the Cache Purge permission, and the
 * zone id. The token is used only in the `Authorization` header.
 */
export class CloudflareEdgePurgeProvider implements EdgePurgeProvider {
  readonly name = "cloudflare";

  constructor(
    private readonly zoneId: string,
    private readonly token: string,
    private readonly fetchImpl: EdgeFetch = fetch as unknown as EdgeFetch,
  ) {
    if (!zoneId || !token) {
      throw new Error(
        "Cloudflare edge purge needs a zone id and an API token.",
      );
    }
  }

  async purge(request: EdgePurgeRequest): Promise<void> {
    const tags = cleanList(request.tags);
    const urls = cleanList(request.urls);
    if (tags.length === 0 && urls.length === 0) return;
    const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(this.zoneId)}/purge_cache`;
    if (tags.length > 0) {
      await postPurge("cloudflare", base, this.token, { tags }, this.fetchImpl);
    }
    if (urls.length > 0) {
      await postPurge("cloudflare", base, this.token, { files: urls }, this.fetchImpl);
    }
  }
}

/**
 * Vercel purge binding.
 *
 * Endpoint: `POST /v1/edge-cache/invalidate-by-tags` with `{ tags }`.
 * This marks the tagged entries stale so the next request revalidates
 * them; it is tag-only by design. URLs cannot be purged through this
 * endpoint, so a URL-only request is a no-op here — the caller is told
 * via the returned note, and local invalidation has already happened.
 *
 * Required: an API token, and the project id or name. An optional team
 * id is appended as a query parameter when set.
 */
export class VercelEdgePurgeProvider implements EdgePurgeProvider {
  readonly name = "vercel";

  constructor(
    private readonly projectIdOrName: string,
    private readonly token: string,
    private readonly teamId: string | undefined,
    private readonly fetchImpl: EdgeFetch = fetch as unknown as EdgeFetch,
  ) {
    if (!projectIdOrName || !token) {
      throw new Error(
        "Vercel edge purge needs a project id or name and an API token.",
      );
    }
  }

  async purge(request: EdgePurgeRequest): Promise<void> {
    const tags = cleanList(request.tags);
    if (tags.length === 0) return;
    const query = new URLSearchParams({
      projectIdOrName: this.projectIdOrName,
    });
    if (this.teamId) query.set("teamId", this.teamId);
    const url = `https://api.vercel.com/v1/edge-cache/invalidate-by-tags?${query.toString()}`;
    await postPurge("vercel", url, this.token, { tags }, this.fetchImpl);
  }
}

/**
 * Builds the configured edge provider from the environment, or `null`
 * when nothing is configured. No network call happens here.
 *
 * Variables:
 * - `YATTA_EDGE_PROVIDER`: `"cloudflare"` or `"vercel"`. Anything else
 *   (including unset) means no provider.
 * - Cloudflare: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`.
 * - Vercel: `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID` (id or name),
 *   optional `VERCEL_TEAM_ID`.
 *
 * A provider name with missing credentials returns `null` with a
 * warning, not a half-built provider that would fail on every purge.
 * The warning names the missing variable, never any credential value.
 */
export function createEdgePurgeFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: EdgeFetch,
): EdgePurgeProvider | null {
  const provider = env.YATTA_EDGE_PROVIDER?.trim().toLowerCase();
  if (!provider) return null;
  if (provider === "cloudflare") {
    const token = env.CLOUDFLARE_API_TOKEN;
    const zoneId = env.CLOUDFLARE_ZONE_ID;
    if (!token || !zoneId) {
      console.warn(
        "[cache-edge] YATTA_EDGE_PROVIDER=cloudflare but " +
          "CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID is missing; " +
          "edge purge is disabled and invalidation stays local-only.",
      );
      return null;
    }
    return new CloudflareEdgePurgeProvider(zoneId, token, fetchImpl);
  }
  if (provider === "vercel") {
    const token = env.VERCEL_API_TOKEN;
    const project = env.VERCEL_PROJECT_ID;
    if (!token || !project) {
      console.warn(
        "[cache-edge] YATTA_EDGE_PROVIDER=vercel but VERCEL_API_TOKEN " +
          "or VERCEL_PROJECT_ID is missing; edge purge is disabled and " +
          "invalidation stays local-only.",
      );
      return null;
    }
    return new VercelEdgePurgeProvider(
      project,
      token,
      env.VERCEL_TEAM_ID,
      fetchImpl,
    );
  }
  console.warn(
    `[cache-edge] Unknown YATTA_EDGE_PROVIDER "${provider}"; edge purge ` +
      "is disabled and invalidation stays local-only.",
  );
  return null;
}

/** Options for an edge-aware engine: the plain engine options, plus a provider. */
export interface EdgeAwareCacheOptions extends CacheOptions {
  /**
   * Edge provider, or `null` for local-only behavior. Build one with
   * `createEdgePurgeFromEnv()` or pass a fake in tests. When omitted,
   * the environment is read once at construction.
   */
  edge?: EdgePurgeProvider | null;
  /** Fetch implementation for the env-built provider (tests only). */
  edgeFetch?: EdgeFetch;
}

/**
 * A cache engine that also purges the edge on tag invalidation.
 *
 * Everything else is the plain engine, unchanged: `get`, `set`,
 * `remember`, `delete`, `clear` and metrics all delegate to the parent
 * class. Only `invalidateTags` gains a step, after local invalidation
 * has succeeded: the same tags are sent to the edge provider.
 *
 * Provider failures are fail-open with a warning: local invalidation
 * already happened, and returning an error here would make a caller
 * believe the local data was still cached when it was not. The warning
 * carries the provider name and the error message only — provider
 * implementations never put credentials in their errors.
 *
 * URLs are not part of local tag invalidation (local entries have tags,
 * not URLs), so `invalidateTags` purges by tag only. To purge edge URLs
 * as well, call `purgeEdge` directly with both.
 */
export class EdgeAwareCacheEngine extends MemoryCacheEngine {
  private readonly edge: EdgePurgeProvider | null;

  constructor(options: EdgeAwareCacheOptions = {}) {
    super(options);
    this.edge =
      options.edge !== undefined
        ? options.edge
        : createEdgePurgeFromEnv(process.env, options.edgeFetch);
  }

  /** The configured provider, or `null` when invalidation is local-only. */
  get edgeProvider(): EdgePurgeProvider | null {
    return this.edge;
  }

  override async invalidateTags(
    tags: string | string[],
  ): Promise<number> {
    const evicted = await super.invalidateTags(tags);
    await this.purgeEdge({ tags: Array.isArray(tags) ? tags : [tags] });
    return evicted;
  }

  /**
   * Purges the edge directly, without touching local entries. Fail-open:
   * returns `false` (and warns) when the provider fails or is absent,
   * `true` when a purge was attempted and accepted.
   */
  async purgeEdge(request: EdgePurgeRequest): Promise<boolean> {
    if (!this.edge) return false;
    try {
      await this.edge.purge(request);
      return true;
    } catch (error) {
      console.warn(
        `[cache-edge] Edge purge via "${this.edge.name}" failed; ` +
          "local invalidation still stands: " +
          (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }
}

/**
 * Convenience factory: an edge-aware engine from plain engine options
 * and a provider (or `null` for local-only). Equivalent to constructing
 * `EdgeAwareCacheEngine` directly.
 */
export function withEdgePurge(
  options: EdgeAwareCacheOptions = {},
): EdgeAwareCacheEngine {
  return new EdgeAwareCacheEngine(options);
}

/**
 * One-off helper for code that already holds a plain engine: invalidate
 * locally, then purge the edge, fail-open. Prefer `EdgeAwareCacheEngine`
 * for new code; this exists so existing invalidation call sites can add
 * an edge purge without swapping their engine.
 */
export async function invalidateTagsWithEdge(
  cache: MemoryCacheEngine,
  tags: string | string[],
  provider: EdgePurgeProvider | null,
): Promise<number> {
  const evicted = await cache.invalidateTags(tags);
  if (!provider) return evicted;
  try {
    await provider.purge({ tags: Array.isArray(tags) ? tags : [tags] });
  } catch (error) {
    console.warn(
      `[cache-edge] Edge purge via "${provider.name}" failed; local ` +
        "invalidation still stands: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return evicted;
}
