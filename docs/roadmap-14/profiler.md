# Sampling profiler

> Draft for review. Not published to the docs site.

A sampling profiler that runs inside the process, off by default, plus a
flamegraph export, an event-loop lag monitor, and captures that trigger
when lag stays over a threshold. It builds on the existing observability
(spans, metrics, slow-query records) instead of duplicating them: use
spans to find *which* request was slow, and a profile to find *what code*
was running while it was slow.

```ts
import { SamplingProfiler, hotFunctions } from "yatta.js/profiler";

const profiler = new SamplingProfiler();

// Nothing is measured until start() is called.
await profiler.start();
await doTheSlowThing();
const profile = await profiler.stop();

for (const fn of hotFunctions(profile, 10)) {
  console.log(`${fn.function} — ${fn.selfPercent}% self time`);
}
```

## The spike result: Bun does have an in-process profiler

The design assumed Bun lacked Node's inspector profiler. That is out of
date. Verified on Bun 1.4.4 on this machine:

- `bun --cpu-prof` writes a real `.cpuprofile` (nodes, samples,
  timeDeltas) and the hot function in a test script appeared in it.
- `bun --cpu-prof-md` writes a Markdown report with hot functions and a
  call tree.
- `node:inspector` `Profiler.enable` / `setSamplingInterval` /
  `start` / `stop` work in-process: a test script captured 16 samples
  with the busy function on top, and start/stop can repeat in one
  process.
- There is no `--cpu-prof-flamegraph` flag in Bun 1.4.4, so the
  flamegraph in this module is built from profile data directly.

This module uses the inspector path. The CLI flags cover whole-process
profiles written on exit; this module covers targeted windows while the
server keeps running.

## Profiling one function

```ts
import { SamplingProfiler, toFlamegraphSvg } from "yatta.js/profiler";

const profiler = new SamplingProfiler({ samplingIntervalUs: 1000 });
const { result, profile } = await profiler.profile(() => handleBatch());

// A self-contained SVG string. Serve it behind the observability gate,
// never on a public route: frame names still name internal functions.
const svg = toFlamegraphSvg(profile, { title: "Batch handler" });
```

| Option | Default | What it does |
| --- | --- | --- |
| `samplingIntervalUs` | `1000` | Sample interval in microseconds, the same default as Bun's `--cpu-prof-interval`. Smaller means finer detail and more overhead. |

`stop()` without `start()` returns `null`, not an empty profile dressed
up as a result. A second `start()` while running is a no-op returning
`false`. If the inspector session cannot start, `start()` throws
instead of letting a caller read "nothing was hot" from a failed capture.

## Folded stacks and hot functions

```ts
import { collapsedStacks, hotFunctions } from "yatta.js/profiler";

// Folded-stack lines: "a;b;c count", the format flamegraph tools read.
const folded = collapsedStacks(profile);

// Functions ranked by self time: samples where the frame was on top.
const hot = hotFunctions(profile, 10);
```

Shares are over samples, so they add up to the profile's sample count.
Line numbers are positions in transpiled code, the same caveat as Bun's
own `--cpu-prof` output — they may not match the TypeScript source line.

## Event-loop lag

```ts
import { EventLoopLagMonitor } from "yatta.js/profiler";

const lag = new EventLoopLagMonitor({ windowMs: 1000 });
lag.start();

// After at least one window:
lag.current(); // { at, meanMs, p99Ms, maxMs }
lag.allSamples(); // retained windows, oldest first
```

The monitor uses the same `node:perf_hooks` histogram the observe
module's hardware engine uses, as a standalone caller-owned version.
Each window is read and then reset, so a window's mean describes that
window only — a cumulative mean would dilute a spike from minutes ago
into invisibility. Like everything else here, it measures nothing until
`start()` is called.

## Threshold-triggered capture

```ts
import {
  SamplingProfiler,
  EventLoopLagMonitor,
  ThresholdCapture,
  attachLagTrigger,
} from "yatta.js/profiler";

const profiler = new SamplingProfiler();
const lag = new EventLoopLagMonitor({ windowMs: 1000, thresholdMs: 100 });
const capture = new ThresholdCapture({
  profiler,
  thresholdMs: 100,
  consecutive: 2, // two over-threshold windows before capturing
  captureDurationMs: 5000,
  cooldownMs: 60000, // quiet period after each capture
  maxCaptures: 5, // oldest evicted first
  onCapture: (c) => console.log("captured", c.hot[0]?.function),
});

capture.start();
lag.start();
const detach = attachLagTrigger(lag, capture);

// Later:
capture.captures(); // [{ startedAt, triggerValueMs, context, profile, hot, flamegraphSvg }]
```

`observe()` can also be fed any millisecond signal directly
(`capture.observe(durationMs, { route: "/slow" })`). Context labels are
sanitized: only short string values are kept, and anything under a
credential-looking key is dropped.

## Overhead, honestly

Sampling is LOW overhead, not zero. The inspector samples the stack at
the configured interval, and each sample costs a stack walk. The
profiler is off by default and sampled when on; an app that never
configures it pays nothing — importing the module starts no timer and
no session. A threshold capture adds one bounded profile per cooldown
period at most, and a capture already in flight suppresses further
triggers.

## Gotchas

- **No HTTP endpoint is included.** Serving a flamegraph is the app
  author's job, behind the same gate as the rest of the observability
  surface (the observe token). A profiler must not be switchable on by
  an unauthenticated request, so there is no request-triggered enable
  path here at all: only in-process code can start a capture.
- **Flamegraphs carry function names and file basenames only.** Full
  file paths are stripped, and no arguments, SQL text, headers or
  request bodies are ever recorded. The raw profile Bun returns still
  carries full file URLs — pass it through `sanitizeProfile()` before
  storing it outside the process or serving it.
- **A capture never steals another profile.** If a profile is already
  running when a threshold fires, the capture steps aside instead of
  stopping someone else's capture when its window ends.
- **The lag monitor needs `thresholdMs` for listeners to fire.**
  `attachLagTrigger` subscribes through the monitor's threshold
  listeners, which only run on over-threshold windows.
- **Sampling is statistical, not exact.** A function absent from every
  sample did not run long enough to matter; a function on many samples
  is hot. For exact call counts, use spans, not a profiler.
- **Heap profiling is out of scope for this round.** Bun 1.4.4 also
  ships `--heap-prof` for whole-process heap profiles on exit, but no
  in-process heap API is built here.
- **Whole-process profiles are the complement.** For a profile of an
  entire run, `bun --cpu-prof --cpu-prof-dir=./profiles app.ts` writes
  a `.cpuprofile` on exit, and `--cpu-prof-md` adds a readable report.
  Those flags need a restart to change; this module does not.
