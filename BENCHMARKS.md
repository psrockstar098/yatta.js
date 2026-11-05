# Yatta Benchmarks

> Last run: `2026-11-05T04:08:26Z` · commit [`9f48393`](https://github.com/psrockstar098/yatta.js/commit/9f483936189b47ec1801b0682ae3d5f8b5ba98a8) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 81.0 ms
  • End-to-End Runtime Task Cost    : 0.0258 ms/op
  • Peak RSS Memory        : 138.4 MB
  • RSS Heap Memory             : 95.86 MB
  • Raw Worker IPC Round-Trip      : 0.0224 ms/op
  • Scheduler + Graph Overhead     : 0.0034 ms/op
  • Settled Cooldown RSS   : 74.2 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.62 MB
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
| Yatta     |      59,173 |     1.00x |    20% | 1.95ms | 4.00ms | 5.00ms |
| Raw Bun   |      44,244 |     0.75x |    18% | 2.06ms | 4.30ms | 4.40ms |
| Hono      |      61,470 |     1.04x |    11% | 1.50ms | 2.41ms | 3.79ms |
| Elysia    |      54,012 |     0.91x |    14% | 1.59ms | 3.29ms | 3.75ms |
| Express   |      27,129 |     0.46x |     5% | 3.30ms | 6.05ms | 7.37ms |
| Fastify   |      37,941 |     0.64x |    10% | 2.54ms | 4.59ms | 5.73ms |
| Koa       |      29,194 |     0.49x |     2% | 3.04ms | 6.03ms | 7.26ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,547 |       0.28 |       0.29 |       0.29 |       0.29 |
|         100 |     0.5 ms |              188,184 |       0.26 |       0.32 |       0.34 |       0.34 |
|         500 |     1.7 ms |              291,047 |       0.79 |       1.24 |       1.36 |       1.39 |
|        1000 |     3.4 ms |              294,991 |       1.39 |       1.99 |       2.10 |       2.14 |
|        5000 |    17.1 ms |              292,228 |       8.85 |      11.56 |      12.02 |      12.08 |
|       10000 |    30.8 ms |              325,055 |      16.16 |      23.65 |      24.07 |      24.09 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.0 ms |            143,857 |     3.40 |     4.57 |     5.83 |       5.93 |     5.93 |
|        5000 |   15.8 ms |            315,683 |     7.76 |     9.86 |    10.25 |      10.26 |    10.27 |
|       10000 |   36.4 ms |            274,695 |    17.25 |    27.50 |    27.99 |      28.15 |    28.16 |
|       25000 |   80.8 ms |            309,440 |    39.28 |    60.89 |    64.94 |      64.99 |    64.99 |
|       50000 |  166.4 ms |            300,557 |    82.90 |   133.48 |   142.02 |     142.24 |   142.25 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.4 ms |            105,881 |     4.47 |     7.30 |     7.98 |       8.24 |     8.24 |
|        5000 |   36.6 ms |            136,578 |    16.43 |    28.41 |    29.24 |      29.30 |    29.30 |
|       10000 |   76.6 ms |            130,515 |    38.83 |    64.54 |    66.68 |      66.79 |    66.81 |
|       25000 |  196.0 ms |            127,520 |    95.13 |   169.17 |   179.55 |     179.97 |   180.00 |
|       50000 |  394.5 ms |            126,745 |   212.07 |   338.56 |   366.31 |     367.32 |   367.39 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.3 ms |             61,262 |     8.76 |    13.72 |    15.42 |      15.64 |    15.64 |
|        5000 |   70.4 ms |             70,992 |    38.13 |    61.28 |    66.48 |      67.47 |    67.58 |
|       10000 |  156.5 ms |             63,909 |    67.29 |   133.13 |   148.59 |     150.92 |   151.14 |

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
  • Raw Worker IPC Round-Trip      : 0.0224 ms/op
  • End-to-End Runtime Task Cost    : 0.0258 ms/op
  • Scheduler + Graph Overhead     : 0.0034 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,547 |       0.28 |       0.29 |       0.29 |       0.29 |
|         100 |     0.5 ms |              188,184 |       0.26 |       0.32 |       0.34 |       0.34 |
|         500 |     1.7 ms |              291,047 |       0.79 |       1.24 |       1.36 |       1.39 |
|        1000 |     3.4 ms |              294,991 |       1.39 |       1.99 |       2.10 |       2.14 |
|        5000 |    17.1 ms |              292,228 |       8.85 |      11.56 |      12.02 |      12.08 |
|       10000 |    30.8 ms |              325,055 |      16.16 |      23.65 |      24.07 |      24.09 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 95.86 MB
  • V8/JSC Heap Used             : 13.62 MB

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
| 1 CPU + 1 IO  |       2 |   39.3 ms |            254,520 |    19.23 |    29.51 |    30.63 |    30.70 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   34.8 ms |            287,161 |    18.18 |    26.59 |    27.17 |    27.55 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   32.9 ms |            303,579 |    15.53 |    26.08 |    26.58 |    26.63 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   30.3 ms |            330,011 |    14.63 |    25.11 |    25.39 |    25.41 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 81.0 ms
  • Peak Throughput Rate       : 308,545 ops/sec
  • Latency Distribution       : p50: 42.66ms | p90: 63.89ms | p99: 64.88ms | p99.9: 64.94ms | Max: 64.95ms
  • Memory (RSS)               : Baseline: 101.6 MB | Peak: 132.2 MB | Cooldown: 102.5 MB

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
|        1000 |    7.0 ms |            143,857 |     3.40 |     4.57 |     5.83 |       5.93 |     5.93 |
|        5000 |   15.8 ms |            315,683 |     7.76 |     9.86 |    10.25 |      10.26 |    10.27 |
|       10000 |   36.4 ms |            274,695 |    17.25 |    27.50 |    27.99 |      28.15 |    28.16 |
|       25000 |   80.8 ms |            309,440 |    39.28 |    60.89 |    64.94 |      64.99 |    64.99 |
|       50000 |  166.4 ms |            300,557 |    82.90 |   133.48 |   142.02 |     142.24 |   142.25 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.4 ms |            105,881 |     4.47 |     7.30 |     7.98 |       8.24 |     8.24 |
|        5000 |   36.6 ms |            136,578 |    16.43 |    28.41 |    29.24 |      29.30 |    29.30 |
|       10000 |   76.6 ms |            130,515 |    38.83 |    64.54 |    66.68 |      66.79 |    66.81 |
|       25000 |  196.0 ms |            127,520 |    95.13 |   169.17 |   179.55 |     179.97 |   180.00 |
|       50000 |  394.5 ms |            126,745 |   212.07 |   338.56 |   366.31 |     367.32 |   367.39 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.3 ms |             61,262 |     8.76 |    13.72 |    15.42 |      15.64 |    15.64 |
|        5000 |   70.4 ms |             70,992 |    38.13 |    61.28 |    66.48 |      67.47 |    67.58 |
|       10000 |  156.5 ms |             63,909 |    67.29 |   133.13 |   148.59 |     150.92 |   151.14 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 138.4 MB
  • Settled Cooldown RSS   : 74.2 MB (Clean GC release)

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
| Yatta     |      59,173 |     1.00x |    20% | 1.95ms | 4.00ms | 5.00ms |
| Raw Bun   |      44,244 |     0.75x |    18% | 2.06ms | 4.30ms | 4.40ms |
| Hono      |      61,470 |     1.04x |    11% | 1.50ms | 2.41ms | 3.79ms |
| Elysia    |      54,012 |     0.91x |    14% | 1.59ms | 3.29ms | 3.75ms |
| Express   |      27,129 |     0.46x |     5% | 3.30ms | 6.05ms | 7.37ms |
| Fastify   |      37,941 |     0.64x |    10% | 2.54ms | 4.59ms | 5.73ms |
| Koa       |      29,194 |     0.49x |     2% | 3.04ms | 6.03ms | 7.26ms |

  Yatta dispatch adds about -5.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 20%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
