# Yatta Benchmarks

> Last run: `2026-10-18T00:29:39Z` · commit [`761665c`](https://github.com/psrockstar098/yatta.js/commit/761665c03b09a37c3d7a8112a1785991ad6556ac) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 104.6 ms
  • End-to-End Runtime Task Cost    : 0.0547 ms/op
  • Peak RSS Memory        : 202.6 MB
  • RSS Heap Memory             : 65.08 MB
  • Raw Worker IPC Round-Trip      : 0.0449 ms/op
  • Scheduler + Graph Overhead     : 0.0098 ms/op
  • Settled Cooldown RSS   : 72.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      44,497 |     1.00x |     5% | 2.10ms | 3.97ms | 4.63ms |
| Raw Bun   |      42,036 |     0.94x |     7% | 2.27ms | 5.02ms | 5.49ms |
| Hono      |      45,573 |     1.02x |    18% | 1.90ms | 3.35ms | 3.71ms |
| Elysia    |      46,597 |     1.05x |    21% | 2.35ms | 4.87ms | 5.21ms |
| Express   |      15,968 |     0.36x |     7% | 5.52ms | 10.15ms | 11.68ms |
| Fastify   |      20,610 |     0.46x |    20% | 3.75ms | 7.90ms | 8.65ms |
| Koa       |      16,062 |     0.36x |    15% | 5.33ms | 9.78ms | 10.99ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,555 |       0.33 |       0.38 |       0.38 |       0.38 |
|         100 |     1.8 ms |               54,345 |       0.51 |       1.28 |       1.28 |       1.28 |
|         500 |     2.7 ms |              186,306 |       1.28 |       1.99 |       2.04 |       2.07 |
|        1000 |     4.9 ms |              205,158 |       2.52 |       3.63 |       3.74 |       3.78 |
|        5000 |    30.7 ms |              163,027 |      16.15 |      22.38 |      22.57 |      22.58 |
|       10000 |    57.3 ms |              174,637 |      32.45 |      45.40 |      45.75 |      45.91 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            104,948 |     3.74 |     6.32 |     7.94 |       8.11 |     8.11 |
|        5000 |   24.1 ms |            207,239 |    11.11 |    15.50 |    16.01 |      16.03 |    16.03 |
|       10000 |   45.9 ms |            217,880 |    21.03 |    33.76 |    35.83 |      35.87 |    35.88 |
|       25000 |   90.3 ms |            276,761 |    43.09 |    62.52 |    66.73 |      66.94 |    66.95 |
|       50000 |  194.8 ms |            256,634 |    92.64 |   148.99 |   161.96 |     162.49 |   162.51 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.9 ms |             63,027 |     6.28 |     9.82 |    11.41 |      11.60 |    11.60 |
|        5000 |   52.1 ms |             95,928 |    23.33 |    38.85 |    39.93 |      39.98 |    39.98 |
|       10000 |  109.6 ms |             91,263 |    58.62 |    91.78 |    94.55 |      94.76 |    94.77 |
|       25000 |  210.2 ms |            118,946 |   106.01 |   178.61 |   188.93 |     189.13 |   189.18 |
|       50000 |  398.0 ms |            125,620 |   200.87 |   333.86 |   355.14 |     356.31 |   356.37 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.6 ms |             31,630 |    16.62 |    28.03 |    30.32 |      30.67 |    30.67 |
|        5000 |  133.7 ms |             37,388 |    66.07 |   115.13 |   129.12 |     130.82 |   130.98 |
|       10000 |  268.2 ms |             37,286 |   137.01 |   235.57 |   258.97 |     263.74 |   264.26 |

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
  • Raw Worker IPC Round-Trip      : 0.0449 ms/op
  • End-to-End Runtime Task Cost    : 0.0547 ms/op
  • Scheduler + Graph Overhead     : 0.0098 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,555 |       0.33 |       0.38 |       0.38 |       0.38 |
|         100 |     1.8 ms |               54,345 |       0.51 |       1.28 |       1.28 |       1.28 |
|         500 |     2.7 ms |              186,306 |       1.28 |       1.99 |       2.04 |       2.07 |
|        1000 |     4.9 ms |              205,158 |       2.52 |       3.63 |       3.74 |       3.78 |
|        5000 |    30.7 ms |              163,027 |      16.15 |      22.38 |      22.57 |      22.58 |
|       10000 |    57.3 ms |              174,637 |      32.45 |      45.40 |      45.75 |      45.91 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 65.08 MB
  • V8/JSC Heap Used             : 0.78 MB

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
| 1 CPU + 1 IO  |       2 |   52.8 ms |            189,339 |    23.26 |    39.85 |    42.70 |    42.82 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   44.1 ms |            226,780 |    24.42 |    33.85 |    34.06 |    34.09 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   39.3 ms |            254,346 |    21.00 |    30.43 |    31.20 |    31.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   39.8 ms |            251,525 |    19.30 |    31.36 |    31.92 |    32.14 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 104.6 ms
  • Peak Throughput Rate       : 239,017 ops/sec
  • Latency Distribution       : p50: 51.09ms | p90: 84.95ms | p99: 85.54ms | p99.9: 86.08ms | Max: 86.09ms
  • Memory (RSS)               : Baseline: 100.3 MB | Peak: 129.4 MB | Cooldown: 102.6 MB

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
|        1000 |    9.5 ms |            104,948 |     3.74 |     6.32 |     7.94 |       8.11 |     8.11 |
|        5000 |   24.1 ms |            207,239 |    11.11 |    15.50 |    16.01 |      16.03 |    16.03 |
|       10000 |   45.9 ms |            217,880 |    21.03 |    33.76 |    35.83 |      35.87 |    35.88 |
|       25000 |   90.3 ms |            276,761 |    43.09 |    62.52 |    66.73 |      66.94 |    66.95 |
|       50000 |  194.8 ms |            256,634 |    92.64 |   148.99 |   161.96 |     162.49 |   162.51 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.9 ms |             63,027 |     6.28 |     9.82 |    11.41 |      11.60 |    11.60 |
|        5000 |   52.1 ms |             95,928 |    23.33 |    38.85 |    39.93 |      39.98 |    39.98 |
|       10000 |  109.6 ms |             91,263 |    58.62 |    91.78 |    94.55 |      94.76 |    94.77 |
|       25000 |  210.2 ms |            118,946 |   106.01 |   178.61 |   188.93 |     189.13 |   189.18 |
|       50000 |  398.0 ms |            125,620 |   200.87 |   333.86 |   355.14 |     356.31 |   356.37 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.6 ms |             31,630 |    16.62 |    28.03 |    30.32 |      30.67 |    30.67 |
|        5000 |  133.7 ms |             37,388 |    66.07 |   115.13 |   129.12 |     130.82 |   130.98 |
|       10000 |  268.2 ms |             37,286 |   137.01 |   235.57 |   258.97 |     263.74 |   264.26 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 202.6 MB
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
| Yatta     |      44,497 |     1.00x |     5% | 2.10ms | 3.97ms | 4.63ms |
| Raw Bun   |      42,036 |     0.94x |     7% | 2.27ms | 5.02ms | 5.49ms |
| Hono      |      45,573 |     1.02x |    18% | 1.90ms | 3.35ms | 3.71ms |
| Elysia    |      46,597 |     1.05x |    21% | 2.35ms | 4.87ms | 5.21ms |
| Express   |      15,968 |     0.36x |     7% | 5.52ms | 10.15ms | 11.68ms |
| Fastify   |      20,610 |     0.46x |    20% | 3.75ms | 7.90ms | 8.65ms |
| Koa       |      16,062 |     0.36x |    15% | 5.33ms | 9.78ms | 10.99ms |

  Yatta dispatch adds about -1.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
