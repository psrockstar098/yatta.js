// Sampling profiler for Yatta.
//
// OFF by default: nothing here runs until the caller creates a profiler and
// calls start(). Importing this module starts no timer, no inspector session
// and no capture, so an app that never configures profiling pays nothing.
//
// How sampling works under Bun (verified on Bun 1.4.4, see docs/roadmap-14/
// profiler.md): Bun implements the node:inspector Profiler API
// (Profiler.enable / start / stop / setSamplingInterval), so a profiler can
// run inside the process over a chosen window — no restart, no separate
// process, no native addon. The CLI flags bun --cpu-prof / --cpu-prof-md
// cover whole-process profiles written on exit; this module covers targeted
// windows while the server keeps running.
//
// Overhead is LOW, not zero: the inspector samples the stack at the
// configured interval (default 1000 microseconds, the same default as
// --cpu-prof-interval). A function that never appears in a sample did not
// run long enough to matter; a function on many samples is hot. That is a
// statistical picture, not an exact call count.
//
// What this module never does:
// - It never dumps function arguments, SQL text, headers or request bodies.
//   Flamegraphs and folded stacks carry function names and file basenames
//   only. Full file paths are stripped because a path can name a host,
//   a user or a deployment layout.
// - It exposes no HTTP endpoint. Serving a flamegraph is the app author's
//   job, behind the same gate as the rest of the observability surface
//   (the observe token in src/main.ts). A profiler must not be switchable
//   on by an unauthenticated request, so there is no request-triggered
//   enable path here at all: only in-process code can start a capture.
// - Heap profiling is out of scope for this round. Bun 1.4.4 also ships
//   --heap-prof, but no in-process heap API is built here.

import inspector from "node:inspector";
import { monitorEventLoopDelay } from "node:perf_hooks";

// ─── Profile data (the .cpuprofile shape Bun writes) ───────────────────────

export interface CpuProfileCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CpuProfileNode {
  id: number;
  callFrame: CpuProfileCallFrame;
  hitCount: number;
  children?: number[];
  positionTicks?: Array<{ line: number; ticks: number }>;
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export class ProfilerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ProfilerError";
    if (options?.cause !== undefined) (this as any).cause = options.cause;
  }
}

// A session is kept behind this narrow shape so the rest of the module
// never depends on inspector's callback typing.
interface InspectorSessionLike {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    params?: Record<string, unknown>,
    callback?: (err: Error | null, result?: any) => void,
  ): void;
}

function postAsync(
  session: InspectorSessionLike,
  method: string,
  params?: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      if (params === undefined) {
        session.post(method, (err, result) =>
          err ? reject(err) : resolve(result),
        );
      } else {
        session.post(method, params, (err, result) =>
          err ? reject(err) : resolve(result),
        );
      }
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Frame labels: names and basenames only ────────────────────────────────

// Keys that must never appear in a stored capture context. This mirrors the
// sensitive-key rule in the observe module, kept local so importing the
// profiler does not pull in the whole observe surface.
const SENSITIVE_KEY_REGEX =
  /(password|passwd|secret|token|apikey|api_key|credential|cookie|session_?id|auth|private_?key|encryptionkey|credit_?card|cvv|ssn)/i;

export function basenameOf(url: string): string {
  if (!url) return "";
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const withoutQuery = withoutScheme.split(/[?#]/)[0] ?? "";
  const parts = withoutQuery.split("/").filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? "";
}

/**
 * One frame as it appears in folded stacks and flamegraphs.
 *
 * The label is `name@file:line` (line omitted when unknown). The file is a
 * basename only: a full path can leak host layout, and nothing in a
 * flamegraph needs it. Line numbers are positions in transpiled code, the
 * same caveat as Bun's own --cpu-prof output — they may not match the
 * TypeScript source line.
 */
export function frameLabel(frame: CpuProfileCallFrame): string {
  const name = frame.functionName || "(anonymous)";
  const file = basenameOf(frame.url);
  if (!file) return name;
  if (frame.lineNumber >= 0) return `${name}@${file}:${frame.lineNumber}`;
  return `${name}@${file}`;
}

/** Escape text for embedding in SVG or HTML. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A copy of a profile with every frame URL reduced to its basename.
 *
 * The raw profile Bun returns carries full file URLs. Pass it through here
 * before storing it anywhere outside the process or serving it, so a
 * flamegraph export never carries a host path with it. The flamegraph and
 * folded-stack builders below already work on labels, so they never see a
 * full path even without this step.
 */
export function sanitizeProfile(profile: CpuProfile): CpuProfile {
  return {
    ...profile,
    nodes: profile.nodes.map((node) => ({
      ...node,
      callFrame: { ...node.callFrame, url: basenameOf(node.callFrame.url) },
    })),
  };
}

// ─── Sampling profiler ─────────────────────────────────────────────────────

export interface SamplingProfilerOptions {
  /**
   * Sampling interval in microseconds. Default 1000, the same default as
   * Bun's --cpu-prof-interval. Smaller means finer detail and more samples;
   * it also means more overhead, so there is no reason to go below what
   * the question needs.
   */
  samplingIntervalUs?: number;
}

export class SamplingProfiler {
  private readonly intervalUs: number;
  private session: InspectorSessionLike | null = null;
  private running = false;

  constructor(options: SamplingProfilerOptions = {}) {
    const interval = options.samplingIntervalUs ?? 1000;
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new ProfilerError(
        `SamplingProfiler: samplingIntervalUs must be a positive integer, got ${JSON.stringify(options.samplingIntervalUs)}`,
      );
    }
    this.intervalUs = interval;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get samplingIntervalUs(): number {
    return this.intervalUs;
  }

  /**
   * Start sampling. Returns false if sampling is already running, so a
   * second start is a no-op rather than a second session. Throws
   * ProfilerError if the inspector session cannot be started, so a caller
   * never mistakes "profiler failed to start" for "nothing was hot".
   */
  async start(): Promise<boolean> {
    if (this.running) return false;
    try {
      const session = new inspector.Session() as unknown as InspectorSessionLike;
      session.connect();
      this.session = session;
      await postAsync(session, "Profiler.enable");
      await postAsync(session, "Profiler.setSamplingInterval", {
        interval: this.intervalUs,
      });
      await postAsync(session, "Profiler.start");
      this.running = true;
      return true;
    } catch (err) {
      try {
        this.session?.disconnect();
      } catch {}
      this.session = null;
      this.running = false;
      throw new ProfilerError("SamplingProfiler: failed to start", {
        cause: err,
      });
    }
  }

  /**
   * Stop sampling and return the profile, or null when not running.
   * Null is an honest "no capture", not an empty profile dressed up as one.
   */
  async stop(): Promise<CpuProfile | null> {
    if (!this.running || !this.session) return null;
    const session = this.session;
    this.session = null;
    this.running = false;
    try {
      const result = await postAsync(session, "Profiler.stop");
      const profile = result?.profile as CpuProfile | undefined;
      if (!profile || !Array.isArray(profile.nodes)) {
        throw new ProfilerError(
          "SamplingProfiler: inspector returned no profile",
        );
      }
      return profile;
    } catch (err) {
      if (err instanceof ProfilerError) throw err;
      throw new ProfilerError("SamplingProfiler: failed to stop", {
        cause: err,
      });
    } finally {
      try {
        session.disconnect();
      } catch {}
    }
  }

  /** Profile one function: start, run it, stop, return both. */
  async profile<T>(
    fn: () => T | Promise<T>,
  ): Promise<{ result: T; profile: CpuProfile }> {
    await this.start();
    try {
      const result = await fn();
      const profile = await this.stop();
      if (!profile) {
        throw new ProfilerError(
          "SamplingProfiler: capture ended with no profile",
        );
      }
      return { result, profile };
    } catch (err) {
      // Never leave a session running after a failed capture.
      if (this.running) await this.stop().catch(() => null);
      throw err;
    }
  }

  /** Stop if running and release the session. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.running) await this.stop().catch(() => null);
    if (this.session) {
      try {
        this.session.disconnect();
      } catch {}
      this.session = null;
    }
  }
}

// ─── Folded stacks, hot functions, flamegraph ───────────────────────────────

export interface FoldedStack {
  stack: string;
  samples: number;
}

/**
 * Collapse a profile into folded-stack lines (`a;b;c count`), the format
 * flamegraph tools consume. A sample counts once, on the frame that was on
 * top of the stack; parents of that frame get their share through the
 * stacks that pass through them. The "(root)" node is not a real frame
 * and is dropped.
 */
export function collapsedStacks(profile: CpuProfile): FoldedStack[] {
  const byId = new Map<number, CpuProfileNode>();
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }
  const counts = new Map<string, number>();
  for (const sampleId of profile.samples) {
    const frames: string[] = [];
    let current = byId.get(sampleId);
    while (current) {
      // A frame name is runtime data, not trusted syntax: a ";" or
      // newline in it would split one frame into two in the folded
      // format and corrupt the flamegraph built from it.
      const label = frameLabel(current.callFrame).replace(/[;\n\r]/g, " ");
      if (current.callFrame.functionName !== "(root)") {
        frames.unshift(label);
      }
      const parent = parentOf.get(current.id);
      current = parent === undefined ? undefined : byId.get(parent);
    }
    if (frames.length === 0) continue;
    const stack = frames.join(";");
    counts.set(stack, (counts.get(stack) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([stack, samples]) => ({ stack, samples }))
    .sort((a, b) => b.samples - a.samples);
}

export interface HotFunction {
  function: string;
  file: string;
  line: number;
  /** Samples where this frame was on top of the stack. */
  selfSamples: number;
  selfPercent: number;
  /** Estimate: self samples times the mean sample interval. */
  selfMsEstimate: number;
}

/**
 * Functions ranked by self time — the same "hot functions" view Bun's
 * --cpu-prof-md report prints. Shares are over samples, so they always
 * add up to the profile's sample count; nothing is invented from thin air.
 */
export function hotFunctions(
  profile: CpuProfile,
  limit = 10,
): HotFunction[] {
  const total = profile.samples.length;
  if (total === 0) return [];
  const meanDeltaUs =
    profile.timeDeltas.length > 0
      ? profile.timeDeltas.reduce((a, b) => a + b, 0) /
        profile.timeDeltas.length
      : 0;
  const byId = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) byId.set(node.id, node);
  const agg = new Map<
    string,
    { fn: string; file: string; line: number; selfSamples: number }
  >();
  for (const sampleId of profile.samples) {
    const node = byId.get(sampleId);
    if (!node) continue;
    const label = frameLabel(node.callFrame);
    const entry = agg.get(label) ?? {
      fn: node.callFrame.functionName || "(anonymous)",
      file: basenameOf(node.callFrame.url),
      line: node.callFrame.lineNumber,
      selfSamples: 0,
    };
    entry.selfSamples++;
    agg.set(label, entry);
  }
  return [...agg.values()]
    .map((entry) => ({
      function: entry.fn,
      file: entry.file,
      line: entry.line,
      selfSamples: entry.selfSamples,
      selfPercent: Number(((entry.selfSamples / total) * 100).toFixed(1)),
      selfMsEstimate: Number(
        ((entry.selfSamples * meanDeltaUs) / 1000).toFixed(2),
      ),
    }))
    .sort((a, b) => b.selfSamples - a.selfSamples)
    .slice(0, Math.max(0, limit));
}

// Flamegraph rendering: one row per stack depth, one rectangle per frame,
// width proportional to samples. Colours are deterministic per frame label
// (a hash to a hue), so the same profile always renders the same picture.
function flameColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 62%)`;
}

interface FlameNode {
  label: string;
  samples: number;
  children: Map<string, FlameNode>;
}

export interface FlamegraphOptions {
  width?: number;
  rowHeight?: number;
  fontSize?: number;
  title?: string;
}

/**
 * Render a profile as a self-contained SVG flamegraph string.
 *
 * The SVG carries labels and sample counts only — no URLs, no arguments,
 * no raw profile data. Serve it behind the observability gate, never on a
 * public route: frame names still name internal functions.
 */
export function toFlamegraphSvg(
  profile: CpuProfile,
  options: FlamegraphOptions = {},
): string {
  // Numbers are coerced, never interpolated raw: a caller-supplied value
  // is the only thing that reaches the SVG template, and a string there
  // could break out of an attribute.
  const finiteOr = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  const width = finiteOr(options.width, 1200);
  const rowHeight = finiteOr(options.rowHeight, 16);
  const fontSize = finiteOr(options.fontSize, 12);
  const title =
    typeof options.title === "string"
      ? options.title.slice(0, 200)
      : "CPU profile flamegraph";

  const root: FlameNode = { label: "", samples: 0, children: new Map() };
  for (const { stack, samples } of collapsedStacks(profile)) {
    let node = root;
    node.samples += samples;
    for (const label of stack.split(";")) {
      let child = node.children.get(label);
      if (!child) {
        child = { label, samples: 0, children: new Map() };
        node.children.set(label, child);
      }
      child.samples += samples;
      node = child;
    }
  }
  const total = root.samples;
  if (total === 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${rowHeight + 20}">` +
      `<text x="10" y="20" font-family="monospace" font-size="${fontSize}">No samples captured</text></svg>`
    );
  }

  // Depth of the deepest stack, for the SVG height.
  let maxDepth = 0;
  const measure = (node: FlameNode, depth: number) => {
    if (depth > maxDepth) maxDepth = depth;
    for (const child of node.children.values()) measure(child, depth + 1);
  };
  measure(root, 0);
  const height = maxDepth * rowHeight + 30;

  const rects: string[] = [];
  const render = (node: FlameNode, depth: number, x: number) => {
    const children = [...node.children.values()].sort(
      (a, b) => b.samples - a.samples,
    );
    let cursor = x;
    for (const child of children) {
      const w = (child.samples / total) * width;
      const y = height - 30 - depth * rowHeight;
      const pct = ((child.samples / total) * 100).toFixed(1);
      const tip = `${child.label} — ${child.samples} samples (${pct}%)`;
      const text =
        w > 40
          ? `<text x="${(cursor + 4).toFixed(1)}" y="${(y + 12).toFixed(1)}" font-family="monospace" font-size="${fontSize}">${escapeXml(child.label)}</text>`
          : "";
      rects.push(
        `<g><title>${escapeXml(tip)}</title>` +
          `<rect x="${cursor.toFixed(1)}" y="${y}" width="${Math.max(w, 0.5).toFixed(1)}" height="${rowHeight - 1}" fill="${flameColor(child.label)}" stroke="#fff" stroke-width="0.5"/>` +
          text +
          `</g>`,
      );
      render(child, depth + 1, cursor);
      cursor += w;
    }
  };
  render(root, 0, 0);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<text x="10" y="16" font-family="monospace" font-size="${fontSize}" font-weight="bold">${escapeXml(title)}</text>` +
    rects.join("") +
    `</svg>`
  );
}

// ─── Event-loop lag monitor ────────────────────────────────────────────────

export interface LagSample {
  at: number;
  meanMs: number;
  p99Ms: number;
  maxMs: number;
}

export interface EventLoopLagMonitorOptions {
  /** Histogram resolution in milliseconds. Default 10. */
  resolutionMs?: number;
  /** How often a window is read, in milliseconds. Default 1000. */
  windowMs?: number;
  /** Call this when a window's mean lag reaches the threshold. */
  thresholdMs?: number;
  onThreshold?: (sample: LagSample) => void;
  /** Retained windows. Default 300. */
  maxSamples?: number;
}

/**
 * Event-loop lag, as its own monitor.
 *
 * The observe module's hardware engine already samples the same
 * node:perf_hooks histogram for the dashboard; this is the standalone,
 * caller-owned version the profiler pairs with, so a threshold capture
 * does not need the whole observer running. Each window is read and then
 * reset, so a window's mean describes that window only — a cumulative mean
 * would dilute a spike that happened minutes ago into invisibility.
 *
 * OFF by default: nothing is measured until start() is called.
 */
export class EventLoopLagMonitor {
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>;
  private readonly windowMs: number;
  private readonly thresholdMs?: number;
  private readonly onThreshold?: (sample: LagSample) => void;
  private readonly maxSamples: number;
  private timer?: ReturnType<typeof setInterval>;
  private samples: LagSample[] = [];
  private last: LagSample | null = null;
  private allTimeMaxMs = 0;
  private listeners = new Set<(sample: LagSample) => void>();

  constructor(options: EventLoopLagMonitorOptions = {}) {
    const resolution = options.resolutionMs ?? 10;
    if (!Number.isFinite(resolution) || resolution <= 0) {
      throw new ProfilerError(
        "EventLoopLagMonitor: resolutionMs must be greater than 0",
      );
    }
    const windowMs = options.windowMs ?? 1000;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new ProfilerError(
        "EventLoopLagMonitor: windowMs must be greater than 0",
      );
    }
    if (
      options.thresholdMs !== undefined &&
      (!Number.isFinite(options.thresholdMs) || options.thresholdMs <= 0)
    ) {
      throw new ProfilerError(
        "EventLoopLagMonitor: thresholdMs must be greater than 0",
      );
    }
    this.histogram = monitorEventLoopDelay({ resolution });
    this.windowMs = windowMs;
    this.thresholdMs = options.thresholdMs;
    this.onThreshold = options.onThreshold;
    this.maxSamples = options.maxSamples ?? 300;
  }

  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  start(): boolean {
    if (this.timer) return false;
    this.histogram.enable();
    this.timer = setInterval(() => this.tick(), this.windowMs);
    this.timer.unref?.();
    return true;
  }

  stop(): boolean {
    if (!this.timer) return false;
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.histogram.disable();
    } catch {}
    return true;
  }

  private tick(): void {
    const sample: LagSample = {
      at: Date.now(),
      meanMs: Number((this.histogram.mean / 1e6).toFixed(3)),
      p99Ms: Number((this.histogram.percentile(99) / 1e6).toFixed(3)),
      maxMs: Number((this.histogram.max / 1e6).toFixed(3)),
    };
    try {
      this.histogram.reset();
    } catch {}
    if (sample.maxMs > this.allTimeMaxMs) this.allTimeMaxMs = sample.maxMs;
    this.last = sample;
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    if (
      this.thresholdMs !== undefined &&
      sample.meanMs >= this.thresholdMs
    ) {
      try {
        this.onThreshold?.(sample);
      } catch {}
      for (const listener of [...this.listeners]) {
        try {
          listener(sample);
        } catch {}
      }
    }
  }

  /**
   * Extra listeners for over-threshold windows, alongside the constructor
   * callback. Returns an unsubscribe function. This is how a threshold
   * capture subscribes without overwriting anyone else's callback.
   */
  addThresholdListener(fn: (sample: LagSample) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Most recent window, or null before the first window completes. */
  current(): LagSample | null {
    return this.last ? { ...this.last } : null;
  }

  allSamples(): LagSample[] {
    return this.samples.map((s) => ({ ...s }));
  }

  get allTimeMaxMs(): number {
    return this.allTimeMaxMs;
  }
}

// ─── Threshold-triggered capture ───────────────────────────────────────────

export interface ProfilerLike {
  readonly isRunning: boolean;
  start(): Promise<boolean> | boolean;
  stop(): Promise<CpuProfile | null>;
}

export interface CapturedProfile {
  startedAt: number;
  /** The lag value (or supplied signal) that crossed the threshold. */
  triggerValueMs: number;
  /** Caller-supplied labels, sanitized — never secrets, see sanitizeContext. */
  context: Record<string, string>;
  profile: CpuProfile;
  hot: HotFunction[];
  flamegraphSvg: string;
}

export interface ThresholdCaptureOptions {
  profiler: ProfilerLike;
  /** Lag (or any millisecond signal) at or above this triggers. */
  thresholdMs: number;
  /** Consecutive over-threshold observations before capturing. Default 1. */
  consecutive?: number;
  /** How long each capture samples. Default 5000 ms. */
  captureDurationMs?: number;
  /** Quiet period after a capture before another may start. Default 60000. */
  cooldownMs?: number;
  /** Retained captures; oldest evicted first. Default 5. */
  maxCaptures?: number;
  /** Called with each finished capture. */
  onCapture?: (capture: CapturedProfile) => void;
}

/**
 * Keep only safe labels in a capture context: string values, short, and
 * never under a credential-looking key. A route name or a queue name is
 * useful context; a token, header value or SQL fragment is not, and is
 * dropped rather than redacted into a shape that still leaks length.
 */
export function sanitizeContext(
  context: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!context) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(context)) {
    if (kept >= 20) break;
    if (SENSITIVE_KEY_REGEX.test(key)) continue;
    if (typeof value !== "string") continue;
    out[key] = value.slice(0, 200);
    kept++;
  }
  return out;
}

/**
 * Capture a profile when a signal stays over a threshold.
 *
 * OFF by default: observe() is a no-op until start() is called, and even
 * then it only ever starts the profiler the caller supplied. Nothing here
 * reads requests, and nothing here can be armed from outside the process:
 * a threshold capture is in-process code reacting to an in-process signal.
 * A capture in flight suppresses further triggers, and a cooldown after
 * each capture stops a sustained overload from filling the store with
 * back-to-back profiles.
 */
export class ThresholdCapture {
  private readonly profiler: ProfilerLike;
  private readonly thresholdMs: number;
  private readonly consecutive: number;
  private readonly captureDurationMs: number;
  private readonly cooldownMs: number;
  private readonly maxCaptures: number;
  private readonly onCapture?: (capture: CapturedProfile) => void;
  private enabled = false;
  private streak = 0;
  private capturing = false;
  private cooldownUntil = 0;
  private stored: CapturedProfile[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  // Set when stop() interrupts a capture mid-window, so the wait ends
  // instead of hanging forever with the profiler left running.
  private waitResolve?: () => void;
  private aborted = false;

  constructor(options: ThresholdCaptureOptions) {
    if (!options.profiler) {
      throw new ProfilerError("ThresholdCapture: profiler is required");
    }
    if (
      !Number.isFinite(options.thresholdMs) ||
      options.thresholdMs <= 0
    ) {
      throw new ProfilerError(
        "ThresholdCapture: thresholdMs must be greater than 0",
      );
    }
    const consecutive = options.consecutive ?? 1;
    if (!Number.isInteger(consecutive) || consecutive < 1) {
      throw new ProfilerError(
        "ThresholdCapture: consecutive must be an integer of at least 1",
      );
    }
    const duration = options.captureDurationMs ?? 5000;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new ProfilerError(
        "ThresholdCapture: captureDurationMs must be greater than 0",
      );
    }
    const cooldown = options.cooldownMs ?? 60000;
    if (!Number.isFinite(cooldown) || cooldown < 0) {
      throw new ProfilerError(
        "ThresholdCapture: cooldownMs must not be negative",
      );
    }
    const max = options.maxCaptures ?? 5;
    if (!Number.isInteger(max) || max < 1) {
      throw new ProfilerError(
        "ThresholdCapture: maxCaptures must be an integer of at least 1",
      );
    }
    this.profiler = options.profiler;
    this.thresholdMs = options.thresholdMs;
    this.consecutive = consecutive;
    this.captureDurationMs = duration;
    this.cooldownMs = cooldown;
    this.maxCaptures = max;
    this.onCapture = options.onCapture;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  start(): boolean {
    if (this.enabled) return false;
    this.enabled = true;
    this.aborted = false;
    return true;
  }

  stop(): boolean {
    if (!this.enabled) return false;
    this.enabled = false;
    this.streak = 0;
    this.aborted = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Wake a capture waiting out its window so it stops its profiler
    // instead of hanging with capturing stuck on.
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = undefined;
      resolve();
    }
    return true;
  }

  /**
   * Feed one signal reading (milliseconds). Below threshold resets the
   * streak; at or above it counts toward a capture. While disabled, or
   * while a capture is in flight, or inside cooldown, readings are ignored.
   */
  observe(valueMs: number, context?: Record<string, unknown>): void {
    if (!this.enabled || this.capturing) return;
    if (!Number.isFinite(valueMs)) return;
    if (valueMs < this.thresholdMs) {
      this.streak = 0;
      return;
    }
    if (Date.now() < this.cooldownUntil) return;
    this.streak++;
    if (this.streak < this.consecutive) return;
    this.streak = 0;
    void this.capture(valueMs, sanitizeContext(context));
  }

  private async capture(
    triggerValueMs: number,
    context: Record<string, string>,
  ): Promise<void> {
    this.capturing = true;
    const startedAt = Date.now();
    // Only a capture this object started may be stopped by it. Without
    // this flag, the finally below would stop a profile another piece of
    // code started, even when this capture stepped aside.
    let ownsProfile = false;
    try {
      // If a profile is already running (started by other code), this
      // capture steps aside instead of stopping someone else's capture
      // when its own window ends.
      const alreadyRunning = this.profiler.isRunning;
      const started = await this.profiler.start();
      if (!started && alreadyRunning) return;
      if (!started && !this.profiler.isRunning) return;
      ownsProfile = true;
      await new Promise<void>((resolve) => {
        this.waitResolve = resolve;
        this.timer = setTimeout(() => {
          this.waitResolve = undefined;
          resolve();
        }, this.captureDurationMs);
      });
      this.timer = undefined;
      const profile = await this.profiler.stop();
      // Stopped mid-window: the partial profile is discarded, not stored
      // as if it were a full capture, and no cooldown is set.
      if (this.aborted) return;
      if (!profile) return;
      const capture: CapturedProfile = {
        startedAt,
        triggerValueMs,
        context,
        profile,
        hot: hotFunctions(profile, 5),
        flamegraphSvg: toFlamegraphSvg(profile),
      };
      this.stored.push(capture);
      if (this.stored.length > this.maxCaptures) this.stored.shift();
      this.cooldownUntil = Date.now() + this.cooldownMs;
      try {
        this.onCapture?.(capture);
      } catch {}
    } catch {
      // A failed capture must not wedge the trigger: the next window may try.
    } finally {
      this.capturing = false;
      if (ownsProfile && this.profiler.isRunning) {
        await this.profiler.stop().catch(() => null);
      }
    }
  }

  captures(): CapturedProfile[] {
    return [...this.stored];
  }
}

/**
 * Wire a lag monitor to a threshold capture: when a window's mean lag
 * crosses the monitor's threshold, the capture's observe() runs with the
 * window's mean. Returns the monitor's unsubscribe function. The capture
 * itself must also be started — wiring alone never arms it.
 */
export function attachLagTrigger(
  monitor: EventLoopLagMonitor,
  capture: ThresholdCapture,
): () => void {
  return monitor.addThresholdListener((sample) =>
    capture.observe(sample.meanMs, { source: "event-loop" }),
  );
}
