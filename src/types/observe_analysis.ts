/**
 * Analysis engines for the observer: release tracking, incident correlation,
 * and the derived signals the dashboard reports.
 *
 * Kept out of `observe.ts` deliberately: that module is the recording layer and
 * is already large. This one only reads from an observer and never writes to
 * it, which keeps the dependency one-directional (`observe` imports this) and
 * makes the analysers testable against a stub.
 *
 * Design rule that governs everything below: **an analysis may be wrong, and it
 * has to say so.** A correlation engine that reports a confident answer when it
 * is guessing is worse than no engine, because it gets trusted. So every claim
 * carries the evidence that produced it and the reasons it might be wrong, and
 * gaps are reported as `Unknown` rather than smoothed over.
 */

import type {
  ErrorIssue,
  HardwareMetrics,
  HttpTransaction,
  SlowQueryRecord,
  LogRecord,
  Span,
} from "./observe";

// ────────────────────────────────────────────────────────────────────────────
// Shared vocabulary
// ────────────────────────────────────────────────────────────────────────────

/**
 * How much weight the data behind a claim actually carries.
 *
 * `unknown` is a real, expected outcome — it means the engine found the failure
 * but not its cause, which is honest and more useful than a guess.
 */
export type Confidence = "likely" | "possible" | "unknown";

export type EvidenceKind =
  | "span"
  | "slow-query"
  | "log"
  | "deploy"
  | "hardware"
  | "job"
  | "cache"
  | "transaction"
  | "breadcrumb";

export interface Evidence {
  kind: EvidenceKind;
  summary: string;
  detail?: string;
  traceId?: string;
  spanId?: string;
  at?: number;
  /**
   * How much this supports its claim, 0..1.
   *
   * This is a *reliability weight*, not a probability that the claim is true.
   * A saturating connection pool is near-certain to matter when observed
   * directly; a release deployed in the same hour is a weaker correlation.
   */
  weight: number;
}

export type SuspectKind =
  | "latency"
  | "db"
  | "deploy"
  | "saturation"
  | "dependency"
  | "code"
  | "unknown";

export interface Suspect {
  id: string;
  label: string;
  kind: SuspectKind;
  confidence: Confidence;
  /**
   * 0..1, derived from the evidence weights below.
   *
   * Not a probability. It ranks suspects against each other; it does not claim
   * the top one is the answer.
   */
  score: number;
  evidence: Evidence[];
  /** Why this reading might be wrong. Always populated below `likely`. */
  caveats: string[];
}

export interface TimelineEvent {
  at: number;
  /** Milliseconds from the start of the correlated trace. */
  offsetMs: number;
  kind: "request" | "span" | "error" | "deploy" | "log";
  label: string;
  detail?: string;
  traceId?: string;
  spanId?: string;
  durationMs?: number;
}

export interface SuggestedAction {
  id: string;
  label: string;
  rationale: string;
  risk: "safe" | "caution" | "destructive";
  /** Set when the observer can actually execute this, not just suggest it. */
  perform?: { kind: string; payload?: Record<string, unknown> };
}

export interface IncidentAnalysis {
  fingerprint: string;
  generatedAt: number;
  /** Aggregate 0..1 across all suspects. Read alongside `unknowns`. */
  confidence: number;
  /** 0..1 — the share of the incident the data actually explains. */
  evidenceCoverage: number;
  timeline: TimelineEvent[];
  suspects: Suspect[];
  evidence: Evidence[];
  suggestedActions: SuggestedAction[];
  /** What the collected data cannot answer. Never omitted. */
  unknowns: string[];
  stats: {
    occurrences: number;
    distinctTraces: number;
    /** Share of occurrences sharing their single most common trace. */
    traceReusePct: number;
    firstSeen: number;
    lastSeen: number;
    routes: string[];
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Small statistics helpers (local, so this module has no runtime dependency
// back on observe.ts)
// ────────────────────────────────────────────────────────────────────────────

function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

/** Nearest-rank percentile over a copy, ascending. */
export function p(values: number[], p: number): number {
  return percentileOf([...values].sort((a, b) => a - b), p);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Coefficient of variation, the dispersion measure used for baseline work.
 *
 * A metric whose p95 is far from its mean is spiky and needs a different
 * baseline rule than a steady one; without this the two are indistinguishable.
 */
export function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (m === 0) return 0;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance) / Math.abs(m);
}

// ────────────────────────────────────────────────────────────────────────────
// Release tracking (foundation for incidents #1, #2 and #3)
// ────────────────────────────────────────────────────────────────────────────

export interface ReleaseMarker {
  release: string;
  version: string;
  environment: string;
  /** When this observer first saw this release. */
  deployedAt: number;
  pid: number;
}

/**
 * Deployed releases, newest last.
 *
 * Recorded from the observer's own `release` config rather than trusted from a
 * caller, so the timeline cannot drift from the build that is actually running.
 */
export class ReleaseTimeline {
  private readonly markers: ReleaseMarker[] = [];
  private readonly cap: number;

  constructor(cap = 50) {
    this.cap = cap;
  }

  record(marker: ReleaseMarker): void {
    const last = this.markers[this.markers.length - 1];
    if (last && last.release === marker.release) {
      // Same build restarting: refresh nothing, keep the original deploy time so
      // "how long has this been live" stays truthful across restarts.
      return;
    }
    this.markers.push(marker);
    if (this.markers.length > this.cap) this.markers.shift();
  }

  all(): ReleaseMarker[] {
    return [...this.markers];
  }

  latest(): ReleaseMarker | undefined {
    return this.markers[this.markers.length - 1];
  }

  /** The release that was live at `at`, if known. */
  activeAt(at: number): ReleaseMarker | undefined {
    let found: ReleaseMarker | undefined;
    for (const m of this.markers) {
      if (m.deployedAt <= at) found = m;
      else break;
    }
    return found;
  }

  /** The release deployed immediately before `release`. */
  previousOf(release: string): ReleaseMarker | undefined {
    const i = this.markers.findIndex((m) => m.release === release);
    return i > 0 ? this.markers[i - 1] : undefined;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Incident correlation
// ────────────────────────────────────────────────────────────────────────────

/** The slice of an observer this module reads. Keeps it testable. */
export interface AnalysisSource {
  readonly service: string;
  readonly release?: string;
  readonly environment: string;
  readonly version: string;
  readonly spans: { all(): Span[] };
  readonly errors: { issues: Map<string, ErrorIssue> };
  readonly transactions: { all(): HttpTransaction[] };
  readonly slowQueries: { all(): SlowQueryRecord[] };
  readonly logs: { all(): LogRecord[] };
  readonly history: MetricsHistory;
  readonly releases: ReleaseTimeline;
  /** Latest hardware sample, when runtime metrics are enabled. */
  hardwareSnapshot?: () => HardwareMetrics;
  /** Queue/job counters, when the jobs subsystem is attached. */
  jobSnapshot?: () => Record<string, number> | undefined;
  /** Called so queue depth can be sampled into history. */
  recordJobDepth?: (at: number) => void;
}

interface SpanNode {
  span: Span;
  depth: number;
  children: SpanNode[];
  /** Time not accounted for by children — the span's real self cost. */
  ownMs: number;
}

/** Build the parent/child tree for one trace and compute self-time per node. */
export function buildSpanTree(spans: Span[]): SpanNode[] | null {
  if (spans.length === 0) return null;

  const byId = new Map<string, SpanNode>();
  const ordered = [...spans].sort((a, b) => a.startTime - b.startTime);

  for (const span of ordered) {
    byId.set(span.spanId, {
      span,
      depth: 0,
      children: [],
      ownMs: Math.max(0, span.durationMs ?? 0),
    });
  }

  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.parentSpanId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Self time = total minus the union of child spans. Children of a trace are
  // sequential in practice, so summing is right and simpler than interval
  // union; nested children would be double counted, which is why the union
  // below guards the common case.
  const assignDepth = (node: SpanNode, depth: number): number => {
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
    return depth;
  };
  roots.forEach((r) => assignDepth(r, 0));

  const computeOwn = (node: SpanNode): void => {
    let childMs = 0;
    for (const child of node.children) {
      childMs += Math.max(0, child.span.durationMs ?? 0);
      computeOwn(child);
    }
    node.ownMs = Math.max(0, (node.span.durationMs ?? 0) - childMs);
  };
  roots.forEach(computeOwn);

  return roots;
}

/** Flatten a tree to a depth-first list, preserving visual nesting order. */
export function flattenTree(roots: SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (node: SpanNode) => {
    out.push(node);
    for (const c of node.children) walk(c);
  };
  roots.forEach(walk);
  return out;
}

export class IncidentAnalyzer {
  constructor(private readonly source: AnalysisSource) {}

  /**
   * Correlate everything known about one issue fingerprint.
   *
   * Returns `null` only when the fingerprint is unknown; an analysis with no
   * suspects is a valid, honest result and still reports what it does know.
   */
  analyze(fingerprint: string): IncidentAnalysis | null {
    const issue = this.source.errors.issues.get(fingerprint);
    if (!issue) return null;

    const evidence: Evidence[] = [];
    const suspects: Suspect[] = [];
    const unknowns: string[] = [];
    const timeline: TimelineEvent[] = [];
    const actions: SuggestedAction[] = [];

    const occurrences = issue.occurrences;
    const traceIds = [
      ...new Set(occurrences.map((o) => o.traceId).filter((t): t is string => !!t)),
    ];

    // ── Trace reuse ────────────────────────────────────────────────────────
    // A single trace accounting for most failures means the engine has one
    // reproducible path, which is the cheapest thing to go and read.
    const traceCounts = new Map<string, number>();
    for (const o of occurrences) {
      if (!o.traceId) continue;
      traceCounts.set(o.traceId, (traceCounts.get(o.traceId) ?? 0) + 1);
    }
    let topTrace = "";
    let topTraceCount = 0;
    for (const [t, c] of traceCounts) {
      if (c > topTraceCount) {
        topTraceCount = c;
        topTrace = t;
      }
    }
    const traceReusePct =
      occurrences.length > 0
        ? Math.round((topTraceCount / occurrences.length) * 100)
        : 0;

    if (traceIds.length === 0) {
      unknowns.push(
        "No occurrence carried a trace id, so no request path could be reconstructed.",
      );
    }

    // ── Walk the most representative trace ────────────────────────────────
    // Prefer the most-repeated trace: it is the one most likely to reproduce.
    const focusTraceId =
      topTrace || traceIds[traceIds.length - 1] || undefined;
    const traceSpans = focusTraceId
      ? this.source.spans.all().filter((s) => s.traceId === focusTraceId)
      : [];

    if (focusTraceId && traceSpans.length > 0) {
      this.analyzeTrace({
        focusTraceId,
        spans: traceSpans,
        issue,
        timeline,
        evidence,
        suspects,
        unknowns,
      });
    }

    // ── Slow queries touching the same traces ─────────────────────────────
    const traceSet = new Set(traceIds);
    const relatedSlow = this.source.slowQueries
      .all()
      .filter((q) => (q.traceId ? traceSet.has(q.traceId) : false));

    if (relatedSlow.length > 0) {
      const worst = relatedSlow.reduce((a, b) =>
        a.durationMs >= b.durationMs ? a : b,
      );
      const ev: Evidence = {
        kind: "slow-query",
        summary: `Slow query recorded on the same trace: ${worst.durationMs}ms`,
        detail: worst.sql,
        traceId: worst.traceId,
        spanId: worst.spanId,
        at: worst.timestamp,
        weight: 0.8,
      };
      evidence.push(ev);
      suspects.push({
        id: "slow-query",
        label: `Slow query (${worst.durationMs}ms)`,
        kind: "db",
        confidence: "likely",
        score: 0.8,
        evidence: [ev],
        caveats: [
          "Slow query recorded alongside the failure, but this data cannot show whether it caused the error or merely ran alongside it.",
        ],
      });
      timeline.push({
        at: worst.timestamp,
        offsetMs: 0,
        kind: "span",
        label: `slow query ${worst.durationMs}ms`,
        detail: worst.sql,
        traceId: worst.traceId,
        durationMs: worst.durationMs,
      });
    }

    // ── Release proximity ─────────────────────────────────────────────────
    const active = this.source.releases.activeAt(issue.firstSeen);
    const latest = this.source.releases.latest();
    if (active && latest && active.release !== latest.release) {
      // The issue predates the current build, so the current build is not the
      // cause — worth stating, because it stops wasted bisects.
      evidence.push({
        kind: "deploy",
        summary: `First seen under release ${active.release}; ${latest.release} is live now`,
        at: active.deployedAt,
        weight: 0.5,
      });
      suspects.push({
        id: "not-current-release",
        label: `Not caused by the current release (${latest.release})`,
        kind: "deploy",
        confidence: "likely",
        score: 0.55,
        evidence: [
          {
            kind: "deploy",
            summary: `Issue first seen ${new Date(issue.firstSeen).toISOString()}, under ${active.release}`,
            weight: 0.5,
          },
        ],
        caveats: [
          "A shared dependency or database change can affect every release at once, so an older release does not rule out an external cause.",
        ],
      });
    }

    if (this.source.releases.all().length === 0) {
      unknowns.push(
        "No release markers recorded, so a deployment cannot be correlated with the first occurrence.",
      );
    }

    // ── Routes ────────────────────────────────────────────────────────────
    if (issue.routes.length > 0) {
      for (const route of issue.routes) {
        actions.push({
          id: `inspect-route-${route}`,
          label: `Inspect traffic for ${route}`,
          rationale: `All recorded occurrences of this fingerprint came from ${route}.`,
          risk: "safe",
        });
      }
    }

    if (issue.routes.length > 1) {
      // One fingerprint reaching several endpoints is often two unrelated bugs
      // that happen to share a message, so grouping them hides each half.
      unknowns.push(
        `This fingerprint spans ${issue.routes.length} routes (${issue.routes.join(", ")}), which can indicate two different bugs sharing a message.`,
      );
    }

    // ── Actions ───────────────────────────────────────────────────────────
    if (focusTraceId) {
      actions.push({
        id: "open-trace",
        label: `Open trace ${focusTraceId.slice(0, 12)}`,
        rationale:
          topTraceCount > 1
            ? `This single trace accounts for ${traceReusePct}% of recorded occurrences.`
            : "The most recent occurrence has a full span tree.",
        risk: "safe",
        perform: { kind: "open-trace", payload: { traceId: focusTraceId } },
      });
    }

    for (const suspect of suspects) {
      if (suspect.kind === "db") {
        actions.push({
          id: "inspect-slow-queries",
          label: "Inspect slow queries",
          rationale: "A slow query was recorded on a failing trace.",
          risk: "safe",
          perform: { kind: "open-slow-queries" },
        });
        break;
      }
    }

    if (issue.status === "unresolved" && issue.count >= 10) {
      actions.push({
        id: "mark-resolved",
        label: "Mark incident resolved",
        rationale: `${issue.count} occurrences grouped under one fingerprint.`,
        risk: "caution",
        perform: {
          kind: "resolve-issue",
          payload: { fingerprint },
        },
      });
    }

    // ── Confidence, derived from evidence rather than asserted ────────────
    const best = suspects.reduce(
      (max, s) => Math.max(max, s.confidence === "unknown" ? 0 : s.score),
      0,
    );
    const explainedTraces = traceIds.length > 0 ? 1 : 0;
    const evidenceCoverage =
      occurrences.length === 0
        ? 0
        : Math.min(
            1,
            (evidence.length / Math.max(1, suspects.length * 2)) *
              (0.5 + 0.5 * explainedTraces),
          );

    if (suspects.length === 0) {
      unknowns.push(
        "No correlated signal explained this failure; the error may originate outside the instrumented path.",
      );
    }
    if (issue.occurrences.length < 3) {
      unknowns.push(
        `Only ${issue.occurrences.length} occurrence(s) retained, so any rate or trend is unreliable.`,
      );
    }

    /*
     * A standing disclosure, so `unknowns` is never empty.
     *
     * Every other entry is conditional on some specific gap. Without this, a
     * well-formed incident with traces, a release and enough occurrences could
     * come back with nothing in `unknowns`, and a consumer would be free to
     * render "Likely cause: X" with no indication it is one correlation among
     * several that the data could not rule out.
     */
    unknowns.push(
      "Correlation is heuristic and based only on in-memory telemetry from this process; other contributing factors may not have been instrumented at all.",
    );

    timeline.sort((a, b) => a.at - b.at);

    return {
      fingerprint,
      generatedAt: Date.now(),
      confidence: Number(best.toFixed(2)),
      evidenceCoverage: Number(evidenceCoverage.toFixed(2)),
      timeline,
      suspects: suspects.sort((a, b) => b.score - a.score),
      evidence,
      suggestedActions: actions,
      unknowns,
      stats: {
        occurrences: issue.count,
        distinctTraces: traceIds.length,
        traceReusePct,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        routes: issue.routes,
      },
    };
  }

  /** Correlate the spans of one trace: latency chain, depth, repeats. */
  private analyzeTrace(args: {
    focusTraceId: string;
    spans: Span[];
    issue: ErrorIssue;
    timeline: TimelineEvent[];
    evidence: Evidence[];
    suspects: Suspect[];
    unknowns: string[];
  }): void {
    const { focusTraceId, spans, issue, timeline, evidence, suspects, unknowns } =
      args;

    const roots = buildSpanTree(spans);
    if (!roots) return;
    const nodes = flattenTree(roots);
    const root = nodes[0]!;
    const traceStart = root.span.startTime;

    for (const node of nodes) {
      timeline.push({
        at: node.span.startTime,
        offsetMs: Math.max(0, node.span.startTime - traceStart),
        kind: node.depth === 0 ? "request" : "span",
        label: node.span.name,
        detail:
          node.depth > 0 ? `${"  ".repeat(node.depth - 1)}${node.span.name}` : undefined,
        traceId: focusTraceId,
        spanId: node.span.spanId,
        durationMs: node.span.durationMs,
      });
    }

    // ── Dominant latency contributor ──────────────────────────────────────
    // The child span that consumed the most time is the best single lead, but
    // "most time" is not "the cause" — a slow parent with fast children means
    // the cost is in the parent, which the own-time split is there to catch.
    const dbNodes = nodes.filter((n) => /(^|\.)db\./.test(n.span.name));
    const slowest = nodes
      .filter((n) => n.depth > 0)
      .reduce<SpanNode | null>(
        (worst, n) =>
          !worst || (n.span.durationMs ?? 0) > (worst.span.durationMs ?? 0) ? n : worst,
        null,
      );

    if (slowest && (slowest.span.durationMs ?? 0) > 0) {
      const share =
        root.span.durationMs && root.span.durationMs > 0
          ? (slowest.span.durationMs ?? 0) / root.span.durationMs
          : 0;
      const ev: Evidence = {
        kind: "span",
        summary: `\`${slowest.span.name}\` took ${slowest.span.durationMs}ms of a ${root.span.durationMs}ms trace`,
        detail:
          share > 0
            ? `${Math.round(share * 100)}% of total request time`
            : undefined,
        traceId: focusTraceId,
        spanId: slowest.span.spanId,
        weight: share > 0.5 ? 0.75 : 0.4,
      };
      evidence.push(ev);
      suspects.push({
        id: `latency-${slowest.span.spanId}`,
        label: `Latency concentrated in ${slowest.span.name}`,
        kind: "latency",
        confidence: share > 0.5 ? "likely" : "possible",
        score: share > 0.5 ? 0.75 : 0.4,
        evidence: [ev],
        caveats:
          share > 0.5
            ? ["A slow child explains the request's duration, but the trace does not show whether that slowness is what produced the error."]
            : [
                `Only ${Math.round(share * 100)}% of the trace sits in this span, so it is a weak candidate on timing alone.`,
              ],
      });
    }

    // ── Database work ─────────────────────────────────────────────────────
    if (dbNodes.length > 0) {
      const dbTotal = dbNodes.reduce((a, n) => a + (n.span.durationMs ?? 0), 0);
      const ev: Evidence = {
        kind: "span",
        summary: `${dbNodes.length} database span(s) totalling ${Math.round(dbTotal)}ms`,
        traceId: focusTraceId,
        weight: 0.6,
      };
      evidence.push(ev);
      suspects.push({
        id: "db-work",
        label: `Database work (${dbNodes.length} call(s), ${Math.round(dbTotal)}ms)`,
        kind: "db",
        confidence: "possible",
        score: 0.6,
        evidence: [ev],
        caveats: [
          "Database spans are present and timed, but nothing recorded here proves the query result caused the failure.",
        ],
      });
    }

    // ── Erroring spans ────────────────────────────────────────────────────
    const failed = nodes.filter((n) => n.span.status === "error");
    if (failed.length > 0) {
      const first = failed[0]!;
      const ev: Evidence = {
        kind: "span",
        summary: `Span \`${first.span.name}\` recorded status=error`,
        traceId: focusTraceId,
        spanId: first.span.spanId,
        weight: 0.7,
      };
      evidence.push(ev);
      suspects.push({
        id: "erroring-span",
        label: `\`${first.span.name}\` recorded the failure`,
        kind: "code",
        confidence: "likely",
        score: 0.7,
        evidence: [ev],
        caveats: [
          "This is the nearest recorded failure to the error, not necessarily its origin.",
        ],
      });
    }

    // ── Transparency about what the trace cannot show ─────────────────────
    if (root.span.attributes["http.route"] === undefined && nodes.length <= 1) {
      unknowns.push(
        "The trace contains a single span, so no internal call path was instrumented for this request.",
      );
    }
    if (!root.span.attributes["http.route"]) {
      unknowns.push(
        "No route template was captured, so this trace cannot be grouped with other requests by endpoint.",
      );
    }
  }
}
// ────────────────────────────────────────────────────────────────────────────
// Release intelligence and "what changed?"
// ────────────────────────────────────────────────────────────────────────────

export interface ReleaseHealth {
  release: string;
  version: string;
  deployedAt: number;
  /** Window of traffic observed under this release. */
  windowMs: number;
  requests: number;
  errors: number;
  errorRatePct: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  slowQueries: number;
  /** Distinct error fingerprints first seen under this release. */
  newErrors: string[];
  affectedRoutes: string[];
  /**
   * Health verdict.
   *
   * Derived by comparing this release against the previous one, so the first
   * release recorded has nothing to compare to and is reported as "unknown"
   * rather than being called healthy by default.
   */
  status: "healthy" | "degraded" | "regressed" | "improved" | "unknown";
}

export interface MetricDelta {
  metric: string;
  before: number;
  after: number;
  /** Null when the baseline was zero, since the ratio is undefined, not 1. */
  changePct: number | null;
  /** Which direction is worse, for the metric. */
  worse: boolean;
}

export interface WhatChanged {
  release: string;
  previousRelease: string | null;
  sinceMs: number;
  deltas: MetricDelta[];
  newErrors: string[];
  fixedErrors: string[];
  /** Human-readable lines, safe to render directly. */
  summary: string[];
  /** Why this comparison may mislead. */
  caveats: string[];
}

/** Metrics where a rise is bad. Everything else is inverted. */
const LOWER_IS_BETTER = new Set(["errorRatePct", "p95Ms", "p99Ms", "slowQueries"]);

/** Minimum traffic before a percentage is worth quoting at all. */
const MIN_SAMPLE = 20;

export class ReleaseIntelligence {
  constructor(private readonly source: AnalysisSource) {}

  /** Group observed traffic and errors by the release that was live at the time. */
  health(): ReleaseHealth[] {
    const releases = this.source.releases.all();
    if (releases.length === 0) return [];

    const tx = this.source.transactions.all();
    const slow = this.source.slowQueries.all();
    const issues = [...this.source.errors.issues.values()];

    const rows: ReleaseHealth[] = releases.map((marker) => {
      const next = releases[releases.indexOf(marker) + 1];
      const from = marker.deployedAt;
      const to = next ? next.deployedAt : Date.now();

      const inWindow = tx.filter((t) => t.timestamp >= from && t.timestamp < to);
      const durations = inWindow.map((t) => t.durationMs);
      const failed = inWindow.filter((t) => t.status >= 500);

      const newErrors = [
        ...new Set(
          issues
            .filter((i) => i.firstSeen >= from && i.firstSeen < to)
            .map((i) => `${i.name}: ${i.message.slice(0, 60)}`),
        ),
      ];

      const affectedRoutes = [
        ...new Set(
          failed
            .map((t) => `${t.method} ${t.route}`)
            .sort()
            .slice(0, 10),
        ),
      ];

      return {
        release: marker.release,
        version: marker.version,
        deployedAt: from,
        windowMs: Math.max(0, to - from),
        requests: inWindow.length,
        errors: failed.length,
        errorRatePct:
          inWindow.length > 0
            ? Number(((failed.length / inWindow.length) * 100).toFixed(2))
            : 0,
        p50Ms: Number(p(durations, 50).toFixed(1)),
        p95Ms: Number(p(durations, 95).toFixed(1)),
        p99Ms: Number(p(durations, 99).toFixed(1)),
        slowQueries: slow.filter((q) => q.timestamp >= from && q.timestamp < to)
          .length,
        newErrors: newErrors.slice(0, 20),
        affectedRoutes,
        status: "unknown" as const,
      };
    });

    // Compare against the previous release, so "healthy" is a measurement
    // rather than an assumption made when nothing is known yet.
    for (let i = 0; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i]!;
      if (!prev || prev.requests < MIN_SAMPLE || cur.requests < MIN_SAMPLE) {
        cur.status = "unknown";
        continue;
      }

      const errorWorse = cur.errorRatePct > prev.errorRatePct * 1.5;
      const errorBetter = cur.errorRatePct < prev.errorRatePct * 0.5;
      const p95Worse = prev.p95Ms > 0 && cur.p95Ms > prev.p95Ms * 1.5;

      cur.status = errorWorse || p95Worse
        ? "regressed"
        : errorBetter
          ? "improved"
          : "degraded";
    }

    return rows;
  }

  /** The release currently running, if traffic has been seen under it. */
  current(): ReleaseHealth | undefined {
    const rows = this.health();
    return rows[rows.length - 1];
  }

  /**
   * Compare the running release against the one before it.
   *
   * Returns null when there is no previous release, which is the honest answer
   * on a first deploy rather than a comparison against an empty baseline.
   */
  whatChanged(release?: string): WhatChanged | null {
    const rows = this.health();
    if (rows.length === 0) return null;

    const currentMarker = release
      ? this.source.releases.all().find((m) => m.release === release)
      : this.source.releases.latest();
    if (!currentMarker) return null;

    const cur = rows.find((r) => r.release === currentMarker.release);
    const prevMarker = this.source.releases.previousOf(currentMarker.release);
    const prev = prevMarker
      ? rows.find((r) => r.release === prevMarker.release)
      : undefined;

    if (!cur) return null;

    const caveats: string[] = [];

    if (!prev) {
      caveats.push(
        `Release ${cur.release} is the first recorded, so there is nothing to compare it against.`,
      );
      if (cur.requests < MIN_SAMPLE) {
        caveats.push(
          `Only ${cur.requests} request(s) observed; rates and percentiles are not yet meaningful.`,
        );
      }
      return {
        release: cur.release,
        previousRelease: null,
        sinceMs: cur.deployedAt,
        deltas: [],
        newErrors: cur.newErrors,
        fixedErrors: [],
        summary: [
          `Release ${cur.release} is live with ${cur.requests} request(s) observed so far.`,
        ],
        caveats,
      };
    }

    if (prev.requests < MIN_SAMPLE || cur.requests < MIN_SAMPLE) {
      caveats.push(
        `Sample is thin (${prev.requests} before, ${cur.requests} after); treat percentages as indicative.`,
      );
    }

    const metrics: Array<[string, number, number]> = [
      ["errorRatePct", prev.errorRatePct, cur.errorRatePct],
      ["p95Ms", prev.p95Ms, cur.p95Ms],
      ["p99Ms", prev.p99Ms, cur.p99Ms],
      ["p50Ms", prev.p50Ms, cur.p50Ms],
      ["slowQueries", prev.slowQueries, cur.slowQueries],
    ];

    const deltas: MetricDelta[] = metrics
      .filter(([, before, after]) => before !== after)
      .map(([metric, before, after]) => {
        // A zero baseline has no meaningful ratio; Infinity would be a lie.
        const changePct = before === 0 ? null : Number((((after - before) / before) * 100).toFixed(1));
        const worse = LOWER_IS_BETTER.has(metric) ? after > before : after < before;
        return { metric, before, after, changePct, worse };
      })
      .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));

    const all = [...this.source.errors.issues.values()];

    /*
     * New vs fixed are both about *when the error last occurred*, not when it
     * first appeared.
     *
     * Keying "fixed" off firstSeen reported every long-standing error as fixed
     * on each release, simply because it predates the deploy — including the
     * ones still firing hundreds of times a minute. Fixed means it stopped:
     * seen during the previous release, not seen since this one went out.
     */
    const newErrors = all
      .filter((i) => i.firstSeen >= cur.deployedAt)
      .map((i) => i.fingerprint);

    const fixedErrors = all
      .filter((i) => i.lastSeen >= prev.deployedAt && i.lastSeen < cur.deployedAt)
      .map((i) => i.fingerprint);

    /*
     * `firstSeen >= cur.deployedAt` is sufficient on its own: an error that
     * first appeared after this release went live cannot have been happening
     * beforehand. Cross-checking against the previous window only produced
     * false negatives, because a long-running error's lastSeen is also after
     * the deploy.
     */

    const summary: string[] = [];
    if (prevMarker) summary.push(`Release: ${prevMarker.release} → ${cur.release}`);
    for (const d of deltas.slice(0, 4)) {
      const arrow = d.changePct === null ? "n/a" : `${d.changePct > 0 ? "+" : ""}${d.changePct}%`;
      summary.push(
        `${d.metric}: ${d.before} → ${d.after} (${arrow})${d.worse ? " worse" : ""}`,
      );
    }
    if (newErrors.length > 0) {
      summary.push(`${newErrors.length} new error fingerprint(s)`);
    }
    if (cur.affectedRoutes.length > 0) {
      summary.push(`Failing routes: ${cur.affectedRoutes.join(", ")}`);
    }

    return {
      release: cur.release,
      previousRelease: prev.release,
      sinceMs: cur.deployedAt,
      deltas,
      newErrors,
      fixedErrors,
      summary,
      caveats,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Time-series history (foundation for #6, #12, #14)
// ────────────────────────────────────────────────────────────────────────────

/**
 * One retained observation. A flat metric bag rather than a fixed shape so new
 * signals can be recorded without a schema change per signal.
 */
export interface HistorySample {
  at: number;
  metrics: Record<string, number>;
}

/**
 * Bounded, in-memory time series.
 *
 * Every "adaptive" or "trend" feature needs the same thing: a retained series
 * rather than a current value. Building it once here keeps those features from
 * each inventing their own storage, and keeps retention bounded, since an
 * unbounded sample log is itself a leak.
 */
export class MetricsHistory {
  private readonly samples: HistorySample[] = [];
  private readonly cap: number;

  constructor(cap = 720) {
    // 720 samples at the default 5s cadence is one hour of history.
    this.cap = cap;
  }

  record(at: number, metrics: Record<string, number>): void {
    // Reject non-finite values: NaN in the series poisons every downstream
    // mean, percentile and regression without any visible symptom.
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(metrics)) {
      if (Number.isFinite(v)) clean[k] = v;
    }
    this.samples.push({ at, metrics: clean });
    if (this.samples.length > this.cap) this.samples.shift();
  }

  all(): HistorySample[] {
    return [...this.samples];
  }

  get size(): number {
    return this.samples.length;
  }

  /** Samples within `windowMs` of `now`, oldest first. */
  window(windowMs: number, now = Date.now()): HistorySample[] {
    const from = now - windowMs;
    return this.samples.filter((s) => s.at >= from);
  }

  /** Values of one metric within a window, dropping gaps. */
  values(metric: string, windowMs: number, now = Date.now()): number[] {
    return this.window(windowMs, now)
      .map((s) => s.metrics[metric])
      .filter((v): v is number => v !== undefined);
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export interface Baseline {
  metric: string;
  /** Median, which a single spike cannot move. */
  median: number;
  p95: number;
  /** Median absolute deviation — a spread measure a single outlier cannot inflate. */
  mad: number;
  count: number;
  windowMs: number;
  /**
   * False when there is not yet enough history to compare against.
   *
   * Every consumer must check this: an anomaly verdict against three samples is
   * noise wearing a confidence score.
   */
  ready: boolean;
}

export interface AnomalyVerdict {
  metric: string;
  value: number;
  baseline: Baseline;
  /** value / median. Null when the median is zero, since the ratio is undefined. */
  ratio: number | null;
  /** Robust z-score using MAD. Null when spread is zero. */
  z: number | null;
  anomalous: boolean;
  confidence: Confidence;
  caveats: string[];
}

/** Samples required before an anomaly claim is allowed at all. */
const MIN_BASELINE_SAMPLES = 20;

/** Median-absolute-deviation multiplier; ~3 median deviations ≈ 3σ when normal. */
const MAD_THRESHOLD = 3;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

export class BaselineEngine {
  constructor(private readonly history: MetricsHistory) {}

  /**
   * Robust baseline for one metric.
   *
   * Median and MAD rather than mean and standard deviation, because latency and
   * queue depth are spiky: a mean is dragged upward by one stall and a σ is
   * inflated by it, which hides exactly the event worth reporting.
   */
  baseline(metric: string, windowMs: number, now = Date.now()): Baseline {
    const values = this.history.values(metric, windowMs, now);
    const med = median(values);
    const mad = median(values.map((v) => Math.abs(v - med)));

    return {
      metric,
      median: Number(med.toFixed(3)),
      p95: Number(p(values, 95).toFixed(3)),
      mad: Number(mad.toFixed(3)),
      count: values.length,
      windowMs,
      ready: values.length >= MIN_BASELINE_SAMPLES,
    };
  }

  /**
   * A percentile reference for filtering, with a lower bar than anomaly
   * detection.
   *
   * Classification ("is this slow for this query?") only needs a rough sense of
   * normal, whereas calling something anomalous is a claim worth holding to a
   * higher standard. Null when there is not enough to say anything yet.
   */
  reference(metric: string, windowMs: number, minSamples: number, now = Date.now()): number | null {
    const values = this.history.values(metric, windowMs, now);
    if (values.length < minSamples) return null;
    return p(values, 95);
  }

  /** Compare a current value against its own history. */
  evaluate(
    metric: string,
    value: number,
    windowMs: number,
    now = Date.now(),
  ): AnomalyVerdict {
    const base = this.baseline(metric, windowMs, now);
    const caveats: string[] = [];

    if (!base.ready) {
      // Refusing to answer is the whole point: with 4 samples almost any value
      // is either "normal" or an "anomaly" depending on which 4 were kept.
      return {
        metric,
        value,
        baseline: base,
        ratio: base.median > 0 ? Number((value / base.median).toFixed(2)) : null,
        z: null,
        anomalous: false,
        confidence: "unknown",
        caveats: [
          `Only ${base.count} sample(s) of ${metric} in the last ${Math.round(windowMs / 1000)}s; a baseline needs ${MIN_BASELINE_SAMPLES}. No anomaly is claimed.`,
        ],
      };
    }

    const ratio = base.median > 0 ? Number((value / base.median).toFixed(2)) : null;
    // MAD can legitimately be zero for a metric that rarely moves; dividing by
    // it would manufacture an infinite z-score from a trivial difference.
    const z =
      base.mad > 0
        ? Number(((0.6745 * (value - base.median)) / base.mad).toFixed(2))
        : null;

    const anomalous =
      z !== null ? Math.abs(z) >= MAD_THRESHOLD : false;

    if (z === null) {
      caveats.push(
        `${metric} has near-zero variance in this window, so deviation cannot be scored; compare the raw value against the median.`,
      );
    }

    return {
      metric,
      value,
      baseline: base,
      ratio,
      z,
      anomalous,
      confidence: anomalous ? "likely" : "possible",
      caveats,
    };
  }

  /** Evaluate several metrics at once, anomalous first. */
  evaluateAll(
    values: Record<string, number>,
    windowMs: number,
    now = Date.now(),
  ): AnomalyVerdict[] {
    return Object.entries(values)
      .map(([metric, value]) => this.evaluate(metric, value, windowMs, now))
      .sort((a, b) => Number(b.anomalous) - Number(a.anomalous));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Memory growth (#12)
// ────────────────────────────────────────────────────────────────────────────

export interface MemoryTrend {
  metric: "rssMb" | "heapUsedMb" | "heapTotalMb" | "externalMb";
  samples: number;
  windowMs: number;
  /** Least-squares slope, in MB per hour. Positive means growing. */
  growthMbPerHour: number;
  rSquared: number;
  /** Total change across the window. */
  deltaMb: number;
  verdict: "growing" | "stable" | "shrinking" | "insufficient-data";
  caveats: string[];
}

/**
 * Least-squares slope of `values` against time, plus the fit quality.
 *
 * R² is returned because a slope without one is misleading: noise in a flat
 * series still produces a non-zero slope.
 */
export function linearTrend(
  points: Array<{ at: number; value: number }>,
): { slopePerMs: number; rSquared: number } {
  const n = points.length;
  if (n < 2) return { slopePerMs: 0, rSquared: 0 };

  const t0 = points[0]!.at;
  const xs = points.map((p) => p.at - t0);
  const ys = points.map((p) => p.value);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;

  const ssTot = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const y = ys[i] ?? 0;
    const x = xs[i] ?? 0;
    ssRes += (y - (my + slope * (x - mx))) ** 2;
  }

  return {
    slopePerMs: slope,
    rSquared: ssTot === 0 ? 0 : Number((1 - ssRes / ssTot).toFixed(3)),
  };
}

/** Samples required before a growth claim is allowed. */
const MIN_TREND_SAMPLES = 30;

export function analyzeMemoryTrend(
  history: MetricsHistory,
  metric: "rssMb" | "heapUsedMb" | "heapTotalMb" | "externalMb",
  windowMs: number,
  now = Date.now(),
): MemoryTrend {
  const points: Array<{ at: number; value: number }> = [];
  for (const sample of history.window(windowMs, now)) {
    const value = sample.metrics[metric];
    // Skip gaps rather than treating a missing metric as zero, which would
    // read as a sudden drop to nothing.
    if (typeof value === "number" && Number.isFinite(value)) {
      points.push({ at: sample.at, value });
    }
  }

  const caveats: string[] = [];
  const deltaMb =
    points.length >= 2 ? points[points.length - 1]!.value - points[0]!.value : 0;

  if (points.length < MIN_TREND_SAMPLES) {
    caveats.push(
      `Only ${points.length} sample(s) over ${Math.round(windowMs / 60000)}m; a growth trend needs ${MIN_TREND_SAMPLES}.`,
    );
    return {
      metric,
      samples: points.length,
      windowMs,
      growthMbPerHour: 0,
      rSquared: 0,
      deltaMb: Number(deltaMb.toFixed(2)),
      verdict: "insufficient-data",
      caveats,
    };
  }

  const { slopePerMs, rSquared } = linearTrend(points);
  const growthMbPerHour = Number((slopePerMs * 3_600_000).toFixed(2));

  let verdict: MemoryTrend["verdict"];
  if (rSquared < 0.5) {
    // Without a decent fit the slope is noise, and calling noise a leak is how
    // this feature loses credibility.
    verdict = "stable";
    caveats.push(
      `Trend fit is weak (R²=${rSquared}); the series looks like noise rather than steady growth.`,
    );
  } else if (growthMbPerHour > 1) verdict = "growing";
  else if (growthMbPerHour < -1) verdict = "shrinking";
  else verdict = "stable";

  caveats.push(
    "Sustained RSS growth is consistent with a leak but does not prove one: allocator retention, a growing cache, or normal heap high-water marks look identical from outside.",
  );

  return {
    metric,
    samples: points.length,
    windowMs,
    growthMbPerHour,
    rSquared,
    deltaMb: Number(deltaMb.toFixed(2)),
    verdict,
    caveats,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Dependency / service map (#4)
// ────────────────────────────────────────────────────────────────────────────

export interface ServiceCall {
  to: string;
  spans: number;
  errors: number;
  p95Ms: number;
}

export interface ServiceNode {
  id: string;
  label: string;
  kind: "datastore" | "cache" | "queue" | "mail" | "realtime" | "server" | "client" | "unknown";
  spans: number;
  errors: number;
  p95Ms: number;
  calls: ServiceCall[];
  /**
   * True when this node was inferred from a span name rather than backed by an
   * attached subsystem, so its numbers describe one call path, not a service.
   */
  inferred: boolean;
}

export interface ServiceMap {
  nodes: ServiceNode[];
  edges: Array<{ from: string; to: string; spans: number; errors: number; p95Ms: number }>;
  /** What this map cannot show, stated rather than left to be discovered. */
  limitations: string[];
}

/**
 * Group a span into a service node.
 *
 * Derived from the span's own kind and name because that is all a trace
 * carries. Kept in one place so node identity is consistent between the node
 * list and the edge list.
 */
function classifyNode(span: Span): { id: string; kind: ServiceNode["kind"] } {
  const name = span.name.toLowerCase();
  // Split on "." and whitespace only. Splitting a route on "/" turned
  // "POST /api/checkout" into a service called "post".
  const prefix = name.split(/[.\s]/)[0] ?? name;

  if (/^(db|sql|query)\b/.test(name) || "db.statement" in span.attributes) {
    return { id: "database", kind: "datastore" };
  }
  if (/cache/.test(name)) return { id: "cache", kind: "cache" };
  if (/job|queue|worker/.test(name)) return { id: "jobs", kind: "queue" };
  if (/mail|smtp|email/.test(name)) return { id: "mail", kind: "mail" };
  if (/sse|websocket|realtime|socket/.test(name)) return { id: "realtime", kind: "realtime" };

  // A route span is the incoming edge of the API regardless of which span kind
  // the instrumentation happened to assign it.
  if (/^(get|post|put|patch|delete|head|options)\s+\//.test(name) || span.kind === "server") {
    return { id: "api", kind: "server" };
  }
  return { id: prefix || "unknown", kind: "unknown" };
}

export class ServiceMapBuilder {
  constructor(private readonly source: AnalysisSource) {}

  build(): ServiceMap {
    const spans = this.source.spans.all();

    interface Acc {
      kind: ServiceNode["kind"];
      spans: number;
      errors: number;
      durations: number[];
      calls: Map<string, { spans: number; errors: number; durations: number[] }>;
    }

    const acc = new Map<string, Acc>();
    const byId = new Map(spans.map((s) => [s.spanId, s]));

    const accFor = (id: string, kind: ServiceNode["kind"]): Acc => {
      let a = acc.get(id);
      if (!a) {
        a = { kind, spans: 0, errors: 0, durations: [], calls: new Map() };
        acc.set(id, a);
      }
      return a;
    };

    for (const span of spans) {
      const self = classifyNode(span);
      const own = accFor(self.id, self.kind);
      own.spans++;
      if (span.status === "error") own.errors++;
      if (span.durationMs !== undefined) own.durations.push(span.durationMs);

      const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
      // A missing or self-referencing parent means this span is a root; there is
      // no edge to draw from it.
      if (!parent || parent.spanId === span.spanId) continue;

      const parentSelf = classifyNode(parent);
      // Self-edges dominate inside a single subsystem and would bury the graph.
      if (parentSelf.id === self.id) continue;

      const from = accFor(parentSelf.id, parentSelf.kind);
      const call = from.calls.get(self.id) ?? { spans: 0, errors: 0, durations: [] };
      call.spans++;
      if (span.status === "error") call.errors++;
      if (span.durationMs !== undefined) call.durations.push(span.durationMs);
      from.calls.set(self.id, call);
    }

    const nodes: ServiceNode[] = [];
    const edges: ServiceMap["edges"] = [];

    for (const [id, a] of acc) {
      const calls: ServiceCall[] = [];
      for (const [to, c] of a.calls) {
        const call: ServiceCall = {
          to,
          spans: c.spans,
          errors: c.errors,
          p95Ms: Number(p(c.durations, 95).toFixed(1)),
        };
        calls.push(call);
        edges.push({ ...call, from: id, to });
      }

      nodes.push({
        id,
        label: id,
        kind: a.kind,
        spans: a.spans,
        errors: a.errors,
        p95Ms: Number(p(a.durations, 95).toFixed(1)),
        calls: calls.sort((x, y) => y.spans - x.spans),
        inferred: true,
      });
    }

    const limitations: string[] = [
      "Nodes are inferred from span names and kinds, so this shows instrumented call paths rather than a declared architecture.",
    ];
    if (!spans.some((s) => s.kind === "producer" || s.kind === "consumer")) {
      limitations.push(
        "No producer or consumer spans were recorded, so asynchronous edges between services are missing.",
      );
    }
    if (!spans.some((s) => s.kind === "client" && !/^(db|sql|query)\b/.test(s.name.toLowerCase()))) {
      limitations.push(
        "No outbound HTTP client spans were recorded. External dependencies appear only if a call site was wrapped explicitly.",
      );
    }

    return {
      nodes: nodes.sort((a, b) => b.spans - a.spans),
      edges: edges.sort((a, b) => b.spans - a.spans),
      limitations,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// N+1 query detection (#13)
// ────────────────────────────────────────────────────────────────────────────

export interface NPlusOneFinding {
  traceId: string;
  parentSpanId: string;
  parentName: string;
  normalizedSql: string;
  calls: number;
  eachMs: number;
  /** Cost of the repetitions after the first, which is the avoidable part. */
  avoidableMs: number;
  severity: "low" | "medium" | "high";
  caveats: string[];
}

/**
 * Collapse literals so structurally identical statements compare equal.
 *
 * The observer already records `db.statement` normalized, so this is mostly
 * belt-and-braces — but a hand-wrapped call site may not be, and without it the
 * repetition that defines an N+1 is invisible.
 */
export function normalizeSqlForShape(sql: string): string {
  return sql
    .replace(/'[^']*'/g, "'?'")
    .replace(/\b\d+\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

/** Repetitions below this are ordinary application logic, not a detectable N+1. */
const N_PLUS_ONE_MIN_CALLS = 5;

export class NPlusOneDetector {
  constructor(private readonly source: AnalysisSource) {}

  detect(minCalls = N_PLUS_ONE_MIN_CALLS): NPlusOneFinding[] {
    const spans = this.source.spans.all();
    const findings: NPlusOneFinding[] = [];

    /*
     * Group database spans by the parent they were issued from.
     *
     * Grouping by trace instead would flag the same statement issued once per
     * request, which is just traffic. Repetition *under one parent* is the N+1
     * shape specifically.
     */
    const groups = new Map<string, Span[]>();
    for (const span of spans) {
      if (span.kind !== "client") continue;
      if (!span.parentSpanId) continue;
      if (!/^(db|sql|query)\b/.test(span.name.toLowerCase()) && !("db.statement" in span.attributes)) {
        continue;
      }
      const list = groups.get(span.parentSpanId) ?? [];
      list.push(span);
      groups.set(span.parentSpanId, list);
    }

    for (const [parentSpanId, group] of groups) {
      if (group.length < minCalls) continue;

      const byShape = new Map<string, Span[]>();
      for (const span of group) {
        const shape = normalizeSqlForShape(this.sqlOf(span));
        const list = byShape.get(shape) ?? [];
        list.push(span);
        byShape.set(shape, list);
      }

      for (const [shape, repeats] of byShape) {
        if (repeats.length < minCalls) continue;

        const durations = repeats
          .map((s) => s.durationMs)
          .filter((d): d is number => typeof d === "number");
        const each = p(durations, 50);
        // The first call is needed; the rest are the avoidable cost.
        const avoidable = Number((each * (repeats.length - 1)).toFixed(1));

        const caveats = [
          "Repetition alone does not prove a loop: a handler can legitimately issue the same prepared query once per row of an unrelated result set.",
        ];
        if (durations.length < repeats.length) {
          caveats.push(
            `${repeats.length - durations.length} repetition(s) had no recorded duration, so this is a lower bound.`,
          );
        }

        findings.push({
          traceId: repeats[0]!.traceId,
          parentSpanId,
          parentName: spans.find((s) => s.spanId === parentSpanId)?.name ?? parentSpanId,
          normalizedSql: shape,
          calls: repeats.length,
          eachMs: Number(each.toFixed(1)),
          avoidableMs: avoidable,
          severity: avoidable >= 500 ? "high" : avoidable >= 150 ? "medium" : "low",
          caveats,
        });
      }
    }

    return findings.sort((a, b) => b.avoidableMs - a.avoidableMs);
  }

  private sqlOf(span: Span): string {
    return (
      span.attributes["db.statement"]?.string ??
      span.attributes["db.query"]?.string ??
      span.name
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SLO / error budget (#7)
// ────────────────────────────────────────────────────────────────────────────

export interface SloDefinition {
  name: string;
  /** Target as a percentage, e.g. 99.9. */
  target: number;
  /** Window in ms; the caller supplies "30d" or similar. */
  windowMs: number;
  query?: { route?: string; method?: string };
}

export interface SloResult {
  name: string;
  target: number;
  windowMs: number;
  /** Measured against the recorded window, not the configured one. */
  observedMs: number;
  requests: number;
  goodRequests: number;
  /** Achieved percentage, or null when there is no traffic to measure. */
  achieved: number | null;
  /** 0..1. Share of the error budget left. */
  errorBudgetRemaining: number | null;
  /**
   * How fast the budget is being spent, relative to sustainable.
   *
   * 1 is on pace; above 1 is burning faster than the window allows.
   */
  burnRate: number | null;
  status: "healthy" | "at-risk" | "breached" | "no-data";
  caveats: string[];
}

/** Below this many requests a percentage says more about noise than about SLO. */
const SLO_MIN_REQUESTS = 20;

export class SloEngine {
  constructor(private readonly source: AnalysisSource) {}

  evaluate(slo: SloDefinition, now = Date.now()): SloResult {
    const caveats: string[] = [];
    const from = now - slo.windowMs;

    const matched = this.source.transactions.all().filter((t) => {
      if (t.timestamp < from || t.timestamp > now) return false;
      if (slo.query?.route && t.route !== slo.query.route) return false;
      if (slo.query?.method && t.method !== slo.query.method) return false;
      return true;
    });

    /*
     * The interval the traffic actually covers, not the configured window.
     *
     * Deriving this from the window start made a burst of traffic in the last
     * thirty seconds of a thirty-day window look like full coverage, which put
     * elapsedFraction at 1 and silently understated burn rate by orders of
     * magnitude.
     */
    const observedMs = matched.length > 0
      ? Math.min(
          slo.windowMs,
          Math.max(...matched.map((t) => t.timestamp)) -
            Math.min(...matched.map((t) => t.timestamp)),
        )
      : 0;

    // A 5xx is a failure. A 4xx is the caller getting an answer the API does not
    // have, so counting it against an availability objective would be wrong.
    const good = matched.filter((t) => t.status < 500).length;

    const base: Omit<SloResult, "achieved" | "errorBudgetRemaining" | "burnRate" | "status"> = {
      name: slo.name,
      target: slo.target,
      windowMs: slo.windowMs,
      observedMs,
      requests: matched.length,
      goodRequests: good,
      caveats,
    };

    if (matched.length < SLO_MIN_REQUESTS) {
      caveats.push(
        `Only ${matched.length} matching request(s); an SLO verdict needs ${SLO_MIN_REQUESTS}. No compliance is claimed.`,
      );
      return {
        ...base,
        achieved: null,
        errorBudgetRemaining: null,
        burnRate: null,
        status: "no-data",
        caveats,
      };
    }

    const achieved = Number(((good / matched.length) * 100).toFixed(3));
    // The budget is the allowance: 100% target leaves nothing, 99.9% leaves 0.1%.
    const budgetPct = 100 - slo.target;
    const consumedPct = 100 - achieved;
    const remaining = budgetPct <= 0 ? null : Number((1 - consumedPct / budgetPct).toFixed(3));

    /*
     * Burn rate compares how much budget was consumed against how much of the
     * window elapsed. At the end of a window, spending 1% of budget per 1% of
     * window is exactly sustainable, giving a rate of 1.
     */
    const elapsedFraction = observedMs > 0 ? Math.min(1, observedMs / slo.windowMs) : 0;
    const burnRate =
      elapsedFraction > 0 && budgetPct > 0
        ? Number((consumedPct / budgetPct / elapsedFraction).toFixed(2))
        : null;

    if (observedMs < slo.windowMs * 0.5) {
      caveats.push(
        `Traffic covers only ${Math.round((observedMs / slo.windowMs) * 100)}% of the ${Math.round(slo.windowMs / 86_400_000)}-day window, so burn rate is measured against a partial window.`,
      );
    }
    caveats.push(
      "Measured against retained in-memory traffic only; a restart or a longer window than the buffer holds will undercount.",
    );

    const status: SloResult["status"] =
      achieved >= slo.target ? (burnRate !== null && burnRate > 1 ? "at-risk" : "healthy")
      : achieved >= slo.target - (budgetPct / 2) ? "at-risk"
      : "breached";

    return { ...base, achieved, errorBudgetRemaining: remaining, burnRate, status, caveats };
  }

  /** Evaluate several objectives at once. */
  evaluateAll(slos: SloDefinition[], now = Date.now()): SloResult[] {
    return slos.map((s) => this.evaluate(s, now));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Job intelligence (#14)
// ────────────────────────────────────────────────────────────────────────────

export interface JobHealth {
  /** Empty when the store reports no per-state split. */
  total: number;
  queued: number;
  running: number;
  delayed: number;
  completed: number;
  failed: number;
  dead: number;
  /** Success as a share of terminal outcomes, or null with none to judge. */
  successRate: number | null;
  /**
   * Queue direction over the baseline window.
   *
   * "unknown" while there is too little history, rather than a guess from a
   * single sample.
   */
  backlog: "increasing" | "stable" | "draining" | "unknown";
  growthPerMinute: number | null;
  caveats: string[];
}

export class JobIntelligence {
  constructor(private readonly source: AnalysisSource) {}

  health(windowMs = 900_000): JobHealth {
    const caveats: string[] = [];
    const snapshot = this.source.jobSnapshot?.();

    if (!snapshot) {
      return {
        total: 0, queued: 0, running: 0, delayed: 0, completed: 0, failed: 0, dead: 0,
        successRate: null, backlog: "unknown", growthPerMinute: null,
        caveats: ["The jobs subsystem is not attached, so no queue metrics are available."],
      };
    }

    const num = (key: string) => Number(snapshot[key] ?? 0);
    const completed = num("completed");
    const failed = num("failed");
    const dead = num("dead");
    const terminal = completed + failed + dead;

    const successRate = terminal > 0 ? Number(((completed / terminal) * 100).toFixed(2)) : null;

    const queued = num("queued");
    const values = this.source.history.values("queueDepth", windowMs);

    let backlog: JobHealth["backlog"] = "unknown";
    let growthPerMinute: number | null = null;

    if (values.length >= 20) {
      /*
       * Slope per millisecond, not per sample.
       *
       * Dividing by the sample count conflated sampling cadence with real drift:
       * at one sample per second it overstated growth by a factor of 60,000.
       */
      const samples = this.source.history
        .window(windowMs)
        .map((s) => ({ at: s.at, value: s.metrics.queueDepth }))
        .filter((p): p is { at: number; value: number } => p.value !== undefined);

      const first = samples[0]!;
      const last = samples[samples.length - 1]!;
      const elapsedMs = Math.max(1, last.at - first.at);
      const slopePerMs = (last.value - first.value) / elapsedMs;
      growthPerMinute = Number((slopePerMs * 60_000).toFixed(3));
      // Compare against the current depth: a steady +1/s matters at 10 queued
      // and not at 10,000.
      if (Math.abs(growthPerMinute) < Math.max(0.5, queued * 0.05)) backlog = "stable";
      else backlog = growthPerMinute > 0 ? "increasing" : "draining";
    } else {
      caveats.push(
        `Only ${values.length} queue-depth sample(s) in the window; backlog direction needs 20.`,
      );
    }

    if (successRate === null) {
      caveats.push("No job has reached a terminal state yet, so no success rate is claimed.");
    }
    if (dead > 0) {
      caveats.push(
        `${dead} job(s) are dead-lettered and will not retry; they need a replay or a code fix.`,
      );
    }

    return {
      total: num("total"),
      queued,
      running: num("running"),
      delayed: num("delayed"),
      completed,
      failed,
      dead,
      successRate,
      backlog,
      growthPerMinute,
      caveats,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Safe actions (#8)
// ────────────────────────────────────────────────────────────────────────────

export type ActionRisk = "safe" | "caution" | "destructive";

export interface ActionRequest {
  kind: string;
  payload?: Record<string, unknown>;
  /**
   * Client-supplied key making a retry safe.
   *
   * Required for anything destructive or retrying: replaying a dead job or
   * clearing a cache twice is not idempotent, so a retried request must be
   * recognisable as the same intent rather than a second action.
   */
  idempotencyKey?: string;
}

export interface ActionPreview {
  kind: string;
  risk: ActionRisk;
  label: string;
  /** What this will affect, spelled out for the confirmation prompt. */
  target: string;
  reason: string;
  /** Why it is being proposed. */
  rationale: string;
  /** True when the action would change production-visible state. */
  requiresConfirmation: boolean;
  /** Set when the action cannot be performed safely as described. */
  blocked?: string;
}

export interface ActionOutcome {
  ok: boolean;
  kind: string;
  /** True when an idempotency key matched an action already performed. */
  deduplicated?: boolean;
  result?: unknown;
  error?: string;
  audit: { action: string; target?: string; at: number; idempotencyKey?: string };
}

/**
 * Actions the observer can describe, preview and audit.
 *
 * Split into preview and execute deliberately: a destructive action must be
 * inspectable before it runs, and the preview is what a dashboard renders in
 * its confirmation prompt.
 */
export class SafeActions {
  private readonly seenKeys = new Map<string, ActionOutcome>();

  constructor(private readonly source: AnalysisSource) {}

  /** Describe an action without running it. Null when the kind is unknown. */
  preview(request: ActionRequest, analysis?: IncidentAnalysis): ActionPreview | null {
    const kind = request.kind;
    const payload = request.payload ?? {};

    switch (kind) {
      case "open-trace": {
        const traceId = String(payload.traceId ?? "");
        return {
          kind,
          risk: "safe",
          label: "Open trace",
          target: traceId ? `trace ${traceId.slice(0, 12)}` : "no trace",
          reason: "Read-only view.",
          rationale: "Inspect the span tree for a failing request.",
          requiresConfirmation: false,
          blocked: traceId ? undefined : "No trace id supplied.",
        };
      }

      case "resolve-issue":
      case "ignore-issue": {
        const fp = String(payload.fingerprint ?? "");
        const issue = fp ? this.source.errors.issues.get(fp) : undefined;
        if (!issue) {
          return {
            kind, risk: "caution", label: kind, target: fp || "(none)", reason: "-",
            rationale: "-", requiresConfirmation: true,
            blocked: "No such fingerprint is currently tracked.",
          };
        }
        return {
          kind,
          risk: "caution",
          label: kind === "resolve-issue" ? "Mark resolved" : "Ignore",
          target: `${issue.name}: ${issue.message.slice(0, 60)} (${issue.count} occurrences)`,
          reason: "Changes triage state, not the underlying failure.",
          rationale:
            kind === "resolve-issue"
              ? "Hides the issue from the open queue. It will reappear if it recurs."
              : "Stops this fingerprint appearing in the queue entirely.",
          requiresConfirmation: true,
        };
      }

      case "replay-dead-job":
      case "purge-dead-jobs":
      case "clear-cache": {
        const destructive = kind !== "replay-dead-job";
        return {
          kind,
          risk: destructive ? "destructive" : "caution",
          label:
            kind === "replay-dead-job"
              ? "Replay dead job"
              : kind === "purge-dead-jobs"
                ? "Purge dead jobs"
                : "Clear cache",
          target: String(payload.target ?? "all matching entries"),
          reason:
            kind === "replay-dead-job"
              ? "Re-runs a job that already failed; it may fail again and can duplicate prior side effects."
              : kind === "purge-dead-jobs"
                ? "Permanently discards failed jobs. They cannot be replayed afterwards."
                : "Evicts cached entries, increasing load on the datastore behind them.",
          rationale: analysis
            ? `Proposed because this incident has confidence ${analysis.confidence}.`
            : "Operator requested.",
          requiresConfirmation: true,
        };
      }

      default:
        return null;
    }
  }

  /**
   * Execute an action, enforcing confirmation and idempotency.
   *
   * `executor` performs the real work; this guards the call, records the audit
   * entry, and deduplicates retries. Returning an outcome rather than throwing
   * keeps a blocked action (missing key, unknown kind) on the normal path,
   * since both are expected responses to operator input.
   *
   * Async because every real executor is. It used to be synchronous and call the
   * executor without awaiting it, which put a pending promise in `outcome.result` —
   * and a promise serialises to `{}`, so the HTTP route answered `{ ok: true }` with
   * no record of what had actually been done. An operator who purged the dead-letter
   * queue was told it worked and nothing more.
   */
  async execute(
    request: ActionRequest,
    executor: (kind: string, payload: Record<string, unknown>) => unknown | Promise<unknown>,
    options: { confirmed?: boolean; actor?: string; at?: number } = {},
  ): Promise<ActionOutcome> {
    const at = options.at ?? Date.now();
    // `actor` is only used for the outcome's own audit shape; the observer records the
    // authoritative entry, since it is the one that knows the actor.
    const actor = options.actor ?? "unknown";

    const preview = this.preview(request);
    if (!preview) {
      return {
        ok: false,
        kind: request.kind,
        error: `Unknown action "${request.kind}"`,
        audit: { action: `unknown:${request.kind}`, at },
      };
    }
    if (preview.blocked) {
      return {
        ok: false,
        kind: request.kind,
        error: preview.blocked,
        audit: { action: `${request.kind}:blocked`, target: preview.target, at },
      };
    }

    /*
     * Idempotency is required for anything that changes state, not optional.
     * Without a key a retried request re-runs the action, so a double-clicked
     * "replay job" becomes two executions.
     */
    if (preview.risk !== "safe" && !request.idempotencyKey) {
      return {
        ok: false,
        kind: request.kind,
        error:
          'This action requires an idempotency key. Send the same key on retry so a repeated request is recognised rather than re-run.',
        audit: { action: `${request.kind}:missing-idempotency-key`, target: preview.target, at },
      };
    }

    if (request.idempotencyKey) {
      const prior = this.seenKeys.get(request.idempotencyKey);
      if (prior) {
        return { ...prior, deduplicated: true };
      }
    }

    if (preview.requiresConfirmation && !options.confirmed) {
      return {
        ok: false,
        kind: request.kind,
        error: `Confirmation required: ${preview.reason}`,
        audit: { action: `${request.kind}:unconfirmed`, target: preview.target, at },
      };
    }

    let result: unknown;
    try {
      // Awaited, so a rejection inside the executor lands here rather than becoming
      // an unhandled rejection and an outcome that claims success.
      result = await executor(request.kind, request.payload ?? {});
    } catch (err) {
      const outcome: ActionOutcome = {
        ok: false,
        kind: request.kind,
        error: err instanceof Error ? err.message : String(err),
        audit: {
          action: `${request.kind}:failed`,
          target: preview.target,
          at,
          idempotencyKey: request.idempotencyKey,
        },
      };
      return outcome;
    }

    const outcome: ActionOutcome = {
      ok: true,
      kind: request.kind,
      result,
      audit: {
        action: request.kind,
        target: preview.target,
        at,
        idempotencyKey: request.idempotencyKey,
      },
    };

    if (request.idempotencyKey) {
      this.seenKeys.set(request.idempotencyKey, outcome);
      // Bounded, so this cannot become its own leak.
      if (this.seenKeys.size > 500) {
        const oldest = this.seenKeys.keys().next().value;
        if (oldest !== undefined) this.seenKeys.delete(oldest);
      }
    }

    return outcome;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Structured incident payload for AI consumption (#5)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A complete, self-describing account of one incident.
 *
 * Shape is designed to be handed to a language model or read by a colleague
 * with no access to the running process. It carries the evidence and the
 * caveats alongside the conclusions, so a reader cannot see a suspicion without
 * also seeing how weak it is.
 */
export interface IncidentReport {
  schemaVersion: 1;
  generatedAt: string;
  service: { name: string; release?: string; version: string; environment: string };
  summary: {
    fingerprint: string;
    errorName: string;
    message: string;
    firstSeen: string;
    lastSeen: string;
    occurrences: number;
    affectedRoutes: string[];
    status: string;
  };
  /** Plain-language findings, ordered strongest first. */
  likelyCauses: Array<{
    claim: string;
    confidence: string;
    supportingEvidence: string[];
    reasonsItCouldBeWrong: string[];
  }>;
  knownUnknowns: string[];
  timeline: Array<{ at: string; offsetMs: number; event: string; detail?: string }>;
  /** Where to look first, with the reasoning attached. */
  suggestedNextSteps: Array<{ action: string; why: string }>;
  /** What the collector cannot see, so a reader does not assume it does. */
  collectionGaps: string[];
}

export function buildIncidentReport(
  source: AnalysisSource,
  analysis: IncidentAnalysis,
  issue: { name: string; message: string; status: string },
): IncidentReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date(analysis.generatedAt).toISOString(),
    service: {
      name: source.service,
      release: source.release,
      version: source.version,
      environment: source.environment,
    },
    summary: {
      fingerprint: analysis.fingerprint,
      errorName: issue.name,
      message: issue.message,
      firstSeen: new Date(analysis.stats.firstSeen).toISOString(),
      lastSeen: new Date(analysis.stats.lastSeen).toISOString(),
      occurrences: analysis.stats.occurrences,
      affectedRoutes: analysis.stats.routes,
      status: issue.status,
    },
    likelyCauses: analysis.suspects.map((s) => ({
      claim: s.label,
      // Never a bare word: the caveats travel with it.
      confidence: `${s.confidence} (score ${s.score})`,
      supportingEvidence: s.evidence.map((e) => e.summary),
      reasonsItCouldBeWrong: s.caveats,
    })),
    knownUnknowns: analysis.unknowns,
    timeline: analysis.timeline.map((t) => ({
      at: new Date(t.at).toISOString(),
      offsetMs: t.offsetMs,
      event: t.label,
      detail: t.detail,
    })),
    suggestedNextSteps: analysis.suggestedActions.map((a) => ({
      action: a.label,
      why: `${a.rationale} (risk: ${a.risk})`,
    })),
    collectionGaps: [
      "Only spans and errors recorded in memory since this process started are included; earlier history is absent.",
      "This report contains no application log text beyond breadcrumbs attached to the failing spans.",
      "Release correlation is limited to builds this process observed starting.",
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Golden traces (#11)
// ────────────────────────────────────────────────────────────────────────────

export interface GoldenTrace {
  name: string;
  traceId: string;
  savedAt: number;
  /** Span names in depth-first order, which is the shape worth comparing. */
  steps: string[];
  /**
   * Per-step durations, parallel to `steps`.
   *
   * Required, not optional: a baseline that records only names can detect a new
   * or missing step but can never say a step got slower, which is the main
   * reason to keep a golden trace at all.
   */
  stepTimings: Array<{ name: string; ms: number }>;
  totalMs: number;
  route?: string;
}

export interface TraceDifference {
  step: string;
  kind: "extra" | "missing" | "slower" | "faster" | "changed";
  /** Signed millisecond difference for timing steps; 0 for structural ones. */
  deltaMs: number;
  ratio: number | null;
  note: string;
}

export interface GoldenTraceComparison {
  golden: GoldenTrace;
  currentTraceId: string;
  route?: string;
  differences: TraceDifference[];
  /** Only present when the comparison is meaningful enough to act on. */
  verdict: "slower" | "faster" | "same-shape" | "different-shape" | "unknown";
  caveats: string[];
}

/** Timing drift worth reporting as a regression, relative to the golden run. */
const GOLDEN_SLOWDOWN_RATIO = 2;

/** Below this many golden steps there is not enough shape to compare. */
const GOLDEN_MIN_STEPS = 3;

export class GoldenTraceStore {
  private readonly goldens: GoldenTrace[] = [];

  save(trace: GoldenTrace, cap = 25): GoldenTrace {
    // Replace by name so re-saving a baseline updates it instead of piling up
    // duplicates that all claim to be current.
    const i = this.goldens.findIndex((g) => g.name === trace.name);
    if (i >= 0) this.goldens.splice(i, 1);
    this.goldens.push(trace);
    if (this.goldens.length > cap) this.goldens.shift();
    return trace;
  }

  all(): GoldenTrace[] {
    return [...this.goldens];
  }

  find(name: string): GoldenTrace | undefined {
    return this.goldens.find((g) => g.name === name);
  }

  /**
   * Compare a live trace against a saved baseline.
   *
   * Compares the *shape* (which steps ran, in what order) and the *timing*, and
   * reports both separately: an extra query and a slow payment call need
   * different fixes.
   */
  compare(golden: GoldenTrace, spans: Span[]): GoldenTraceComparison | null {
    const traceSpans = spans.filter((s) => s.traceId === golden.traceId);
    if (traceSpans.length === 0) return null;

    const roots = buildSpanTree(traceSpans);
    if (!roots) return null;
    const ordered = flattenTree(roots);

    const currentSteps = ordered.map((n) => n.span.name);
    const currentMs = Number(
      ordered.reduce((a, n) => a + (n.span.durationMs ?? 0), 0).toFixed(1),
    );

    const differences: TraceDifference[] = [];
    const caveats: string[] = [];

    // Structural differences, matched by first occurrence so repeated step names
    // are not all reported as missing.
    const remaining = [...currentSteps];
    for (const step of golden.steps) {
      const idx = remaining.indexOf(step);
      if (idx >= 0) {
        remaining.splice(idx, 1);
      } else {
        differences.push({
          step,
          kind: "missing",
          deltaMs: 0,
          ratio: null,
          note: "Present in the golden trace but not in the current one. This may be an improvement or a removed step.",
        });
      }
    }
    for (const step of remaining) {
      differences.push({
        step,
        kind: "extra",
        deltaMs: 0,
        ratio: null,
        note: "Present now but not in the golden trace. A new step is often the real regression.",
      });
    }

    // Timing on steps present in both.
    const goldenTimings = new Map<string, number[]>();
    for (const entry of golden.stepTimings ?? []) {
      goldenTimings.set(entry.name, [...(goldenTimings.get(entry.name) ?? []), entry.ms]);
    }
    const goldenMedian: Record<string, number> = {};
    for (const [step, arr] of goldenTimings) goldenMedian[step] = median(arr);

    const currentTimings = new Map<string, number[]>();
    for (const node of ordered) {
      currentTimings.set(
        node.span.name,
        [...(currentTimings.get(node.span.name) ?? []), node.span.durationMs ?? 0],
      );
    }

    for (const [step, values] of currentTimings) {
      if (!(step in goldenMedian)) continue;
      const now = median(values);
      const before = goldenMedian[step]!;
      const delta = Number((now - before).toFixed(1));
      if (delta === 0) continue;

      const ratio = before > 0 ? Number((now / before).toFixed(2)) : null;
      const meaningful =
        ratio !== null && (ratio >= GOLDEN_SLOWDOWN_RATIO || ratio <= 1 / GOLDEN_SLOWDOWN_RATIO);

      if (!meaningful) continue;
      differences.push({
        step,
        kind: delta > 0 ? "slower" : "faster",
        deltaMs: delta,
        ratio,
        note:
          delta > 0
            ? `Step is ${ratio}x slower than the golden trace.`
            : `Step is faster than the golden trace.`,
      });
    }

    const structural = differences.filter((d) => d.kind === "extra" || d.kind === "missing");
    const slower = differences.filter((d) => d.kind === "slower");

    let verdict: GoldenTraceComparison["verdict"];
    if (golden.steps.length < GOLDEN_MIN_STEPS) {
      verdict = "unknown";
      caveats.push(
        `The golden trace has only ${golden.steps.length} step(s); there is not enough shape to compare against.`,
      );
    } else if (structural.length > 0) {
      verdict = "different-shape";
    } else if (slower.length > 0) {
      verdict = "slower";
    } else if (differences.some((d) => d.kind === "faster")) {
      verdict = "faster";
    } else {
      verdict = "same-shape";
      caveats.push("No step deviated from the golden trace by more than 2x.");
    }

    if (!golden.stepTimings || golden.stepTimings.length === 0) {
      caveats.push(
        "The golden trace recorded no step timings, so only the call shape could be compared.",
      );
    }

    return {
      golden,
      currentTraceId: golden.traceId,
      route: golden.route,
      differences: differences.sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs)),
      verdict,
      caveats,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Trace-to-code navigation (#10)
// ────────────────────────────────────────────────────────────────────────────

export interface SourceContext {
  filePath: string;
  /** 1-indexed, matching editor and stack-trace convention. */
  line: number;
  column: number;
  /** Function name from the frame, when the parser found one. */
  functionName?: string;
}

export interface SourceSnippet {
  filePath: string;
  line: number;
  column: number;
  /** Source lines with the target marked, plus a few either side. */
  lines: Array<{ number: number; text: string; isTarget: boolean }>;
  /** True when the file could not be read. */
  missing?: boolean;
  reason?: string;
  caveats: string[];
}

export interface TraceToCodeResolver {
  resolve(frame: SourceContext, contextLines?: number): SourceSnippet;
}

export class FileSystemTraceToCode implements TraceToCodeResolver {
  private readonly cache = new Map<string, string[] | null>();
  private readonly missing = new Set<string>();

  constructor(
    private readonly readFile: (path: string) => string | null,
    private readonly root?: string,
  ) {}

  resolve(frame: SourceContext, contextLines = 3): SourceSnippet {
    const caveats: string[] = [];

    /*
     * Only serve sources inside the project root.
     *
     * A stack frame can carry any path an attacker put in an error message, so
     * an unguarded read would turn a crafted trace into an arbitrary file read.
     */
    const resolved = frame.filePath;
    if (this.root && !resolved.startsWith(this.root)) {
      return {
        filePath: frame.filePath,
        line: frame.line,
        column: frame.column,
        lines: [],
        missing: true,
        reason: "Path is outside the project root.",
        caveats,
      };
    }

    let cached = this.cache.get(resolved);
    if (cached === undefined) {
      if (this.missing.has(resolved)) {
        return {
          filePath: resolved,
          line: frame.line,
          column: frame.column,
          lines: [],
          missing: true,
          reason: "Source file not available.",
          caveats: [
            "This build does not ship its sources, so only the file and line can be shown.",
          ],
        };
      }
      const text = this.readFile(resolved);
      if (text === null) {
        this.missing.add(resolved);
        return {
          filePath: resolved,
          line: frame.line,
          column: frame.column,
          lines: [],
          missing: true,
          reason: "Source file not available.",
          caveats: [
            "This build does not ship its sources, so only the file and line can be shown.",
          ],
        };
      }
      cached = text.split("\n");
      this.cache.set(resolved, cached);
    }
    // Non-null here: every branch above either returns or assigns `cached`.
    const lines = cached!;

    const target = frame.line;
    if (target < 1 || target > lines.length) {
      return {
        filePath: resolved,
        line: frame.line,
        column: frame.column,
        lines: [],
        missing: true,
        reason: `Line ${frame.line} is outside the file (${lines.length} lines).`,
        caveats: ["Line numbers can drift when the running build differs from the current checkout."],
      };
    }

    const from = Math.max(1, target - contextLines);
    const to = Math.min(lines.length, target + contextLines);

    return {
      filePath: resolved,
      line: target,
      column: frame.column,
      lines: Array.from({ length: to - from + 1 }, (_, i) => {
        const number = from + i;
        return { number, text: lines[number - 1] ?? "", isTarget: number === target };
      }),
      caveats,
    };
  }
}
