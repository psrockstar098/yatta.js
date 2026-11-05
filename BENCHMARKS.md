# Yatta Benchmarks

> Last run: `2026-11-05T02:20:41Z` · commit [`3731ac5`](https://github.com/psrockstar098/yatta.js/commit/3731ac5493f793e1e48292844ca7ed574685c2b7) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 95.4 ms
  • End-to-End Runtime Task Cost    : 0.0277 ms/op
  • Peak RSS Memory        : 218.9 MB
  • RSS Heap Memory             : 95.01 MB
  • Raw Worker IPC Round-Trip      : 0.0213 ms/op
  • Scheduler + Graph Overhead     : 0.0064 ms/op
  • Settled Cooldown RSS   : 72.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.61 MB
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      61,323 |     1.00x |    13% | 1.67ms | 2.76ms | 3.64ms |
| Raw Bun   |      49,677 |     0.81x |    12% | 1.76ms | 3.83ms | 3.91ms |
| Hono      |      63,841 |     1.04x |    21% | 1.55ms | 2.81ms | 3.55ms |
| Elysia    |      54,972 |     0.90x |    20% | 1.54ms | 3.12ms | 3.53ms |
| Express   |      24,080 |     0.39x |    13% | 4.02ms | 6.92ms | 8.31ms |
| Fastify   |      35,299 |     0.58x |     5% | 2.79ms | 4.80ms | 5.70ms |
| Koa       |      26,929 |     0.44x |     6% | 3.36ms | 6.48ms | 8.60ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,250 |       0.28 |       0.30 |       0.30 |       0.30 |
|         100 |     0.5 ms |              197,389 |       0.22 |       0.36 |       0.40 |       0.40 |
|         500 |     1.7 ms |              301,596 |       0.81 |       1.24 |       1.31 |       1.34 |
|        1000 |     3.1 ms |              319,269 |       1.61 |       2.50 |       2.60 |       2.63 |
|        5000 |    21.3 ms |              235,221 |      10.68 |      14.62 |      14.65 |      14.68 |
|       10000 |    37.5 ms |              266,831 |      20.16 |      30.36 |      30.54 |      30.93 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.0 ms |            141,934 |     3.90 |     5.27 |     5.98 |       6.06 |     6.06 |
|        5000 |   18.9 ms |            264,704 |     9.00 |    12.99 |    13.47 |      13.48 |    13.48 |
|       10000 |   37.2 ms |            269,046 |    18.72 |    27.13 |    28.89 |      28.90 |    28.90 |
|       25000 |   81.3 ms |            307,676 |    41.64 |    59.80 |    64.15 |      64.51 |    64.53 |
|       50000 |  167.5 ms |            298,597 |    87.78 |   130.32 |   138.31 |     138.71 |   138.72 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.9 ms |            112,520 |     4.26 |     6.53 |     7.61 |       7.73 |     7.73 |
|        5000 |   37.7 ms |            132,785 |    16.70 |    28.07 |    29.28 |      29.37 |    29.38 |
|       10000 |   78.6 ms |            127,216 |    37.80 |    64.03 |    66.62 |      66.68 |    66.69 |
|       25000 |  200.4 ms |            124,755 |    98.09 |   170.85 |   183.33 |     183.77 |   183.79 |
|       50000 |  423.3 ms |            118,122 |   239.28 |   364.85 |   389.53 |     390.28 |   390.32 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   18.6 ms |             53,682 |    10.09 |    16.03 |    17.63 |      17.86 |    17.86 |
|        5000 |   77.7 ms |             64,313 |    44.82 |    68.52 |    74.84 |      75.87 |    75.95 |
|       10000 |  139.1 ms |             71,874 |    67.82 |   120.37 |   134.27 |     135.50 |   135.74 |

## Full logs

<details>
<summary>Worker runtime deep profile (full log)</summary>

```

=======================================================
   🚀 YATTA WORKER RUNTIME — DEEP PROFILE & STRESS TEST
=======================================================

[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[1] Layer Overhead Decomposition (Micro-benchmarking 2,000 calls each):
  • Raw Worker IPC Round-Trip      : 0.0213 ms/op
  • End-to-End Runtime Task Cost    : 0.0277 ms/op
  • Scheduler + Graph Overhead     : 0.0064 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,250 |       0.28 |       0.30 |       0.30 |       0.30 |
|         100 |     0.5 ms |              197,389 |       0.22 |       0.36 |       0.40 |       0.40 |
|         500 |     1.7 ms |              301,596 |       0.81 |       1.24 |       1.31 |       1.34 |
|        1000 |     3.1 ms |              319,269 |       1.61 |       2.50 |       2.60 |       2.63 |
|        5000 |    21.3 ms |              235,221 |      10.68 |      14.62 |      14.65 |      14.68 |
|       10000 |    37.5 ms |              266,831 |      20.16 |      30.36 |      30.54 |      30.93 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 95.01 MB
  • V8/JSC Heap Used             : 13.61 MB

=======================================================
   ✅ BENCHMARK COMPLETE
=======================================================

```
</details>

<details>
<summary>Topology & tail tuning (full log)</summary>

```

=======================================================
   🧪 YATTA WORKER RUNTIME — TOPOLOGY & TAIL TUNING    
=======================================================

[1] Hardware Topology Matrix Sweep (10,000 tasks on 2 physical cores):
| Configuration | Threads | Duration  | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
|:--------------|:-------:|:---------:|:------------------:|:--------:|:--------:|:--------:|:--------:|
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 2
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 1 IO  |       2 |   44.3 ms |            225,842 |    21.25 |    35.10 |    35.81 |    36.01 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   39.5 ms |            253,214 |    19.23 |    29.68 |    29.83 |    29.84 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   30.5 ms |            327,463 |    14.38 |    25.17 |    25.48 |    25.53 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   32.7 ms |            305,621 |    15.85 |    26.77 |    26.92 |    26.94 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 95.4 ms
  • Peak Throughput Rate       : 262,115 ops/sec
  • Latency Distribution       : p50: 49.22ms | p90: 76.78ms | p99: 77.44ms | p99.9: 77.53ms | Max: 77.54ms
  • Memory (RSS)               : Baseline: 111.9 MB | Peak: 136.1 MB | Cooldown: 105.7 MB

=======================================================
   ✅ TUNING BENCHMARK COMPLETE
=======================================================

```
</details>

<details>
<summary>Comprehensive workload benchmark (full log)</summary>

```

=========================================================================
   🚀 YATTA WORKER RUNTIME — MULTI-WORKLOAD & DEEP STRESS BENCHMARK     
=========================================================================

[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
📊 [WORKLOAD 1] Zero-Delay FastPing (IPC & Scheduler Baseline):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.0 ms |            141,934 |     3.90 |     5.27 |     5.98 |       6.06 |     6.06 |
|        5000 |   18.9 ms |            264,704 |     9.00 |    12.99 |    13.47 |      13.48 |    13.48 |
|       10000 |   37.2 ms |            269,046 |    18.72 |    27.13 |    28.89 |      28.90 |    28.90 |
|       25000 |   81.3 ms |            307,676 |    41.64 |    59.80 |    64.15 |      64.51 |    64.53 |
|       50000 |  167.5 ms |            298,597 |    87.78 |   130.32 |   138.31 |     138.71 |   138.72 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.9 ms |            112,520 |     4.26 |     6.53 |     7.61 |       7.73 |     7.73 |
|        5000 |   37.7 ms |            132,785 |    16.70 |    28.07 |    29.28 |      29.37 |    29.38 |
|       10000 |   78.6 ms |            127,216 |    37.80 |    64.03 |    66.62 |      66.68 |    66.69 |
|       25000 |  200.4 ms |            124,755 |    98.09 |   170.85 |   183.33 |     183.77 |   183.79 |
|       50000 |  423.3 ms |            118,122 |   239.28 |   364.85 |   389.53 |     390.28 |   390.32 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   18.6 ms |             53,682 |    10.09 |    16.03 |    17.63 |      17.86 |    17.86 |
|        5000 |   77.7 ms |             64,313 |    44.82 |    68.52 |    74.84 |      75.87 |    75.95 |
|       10000 |  139.1 ms |             71,874 |    67.82 |   120.37 |   134.27 |     135.50 |   135.74 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 218.9 MB
  • Settled Cooldown RSS   : 72.8 MB (Clean GC release)

=========================================================================
   ✅ COMPREHENSIVE WORKLOAD BENCHMARK COMPLETE
=========================================================================

```
</details>

<details>
<summary>Framework comparison (full log)</summary>

```

=======================================================
   YATTA vs EXPRESS vs FASTIFY vs HONO vs ELYSIA vs KOA
=======================================================

Route:  GET /json
Load:   20,000 requests, 100 concurrent, keep-alive
Method: one process per framework, 3 repetitions each, median reported

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      61,323 |     1.00x |    13% | 1.67ms | 2.76ms | 3.64ms |
| Raw Bun   |      49,677 |     0.81x |    12% | 1.76ms | 3.83ms | 3.91ms |
| Hono      |      63,841 |     1.04x |    21% | 1.55ms | 2.81ms | 3.55ms |
| Elysia    |      54,972 |     0.90x |    20% | 1.54ms | 3.12ms | 3.53ms |
| Express   |      24,080 |     0.39x |    13% | 4.02ms | 6.92ms | 8.31ms |
| Fastify   |      35,299 |     0.58x |     5% | 2.79ms | 4.80ms | 5.70ms |
| Koa       |      26,929 |     0.44x |     6% | 3.36ms | 6.48ms | 8.60ms |

  Yatta dispatch adds about -3.8µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
