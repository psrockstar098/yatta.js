# Yatta Benchmarks

> Last run: `2026-10-17T03:54:58Z` · commit [`57c9d81`](https://github.com/psrockstar098/yatta.js/commit/57c9d8113bddcce0b6657ed09b1372316dcd2604) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 113.0 ms
  • End-to-End Runtime Task Cost    : 0.0543 ms/op
  • Peak RSS Memory        : 204.6 MB
  • RSS Heap Memory             : 77.46 MB
  • Raw Worker IPC Round-Trip      : 0.0426 ms/op
  • Scheduler + Graph Overhead     : 0.0117 ms/op
  • Settled Cooldown RSS   : 72.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      42,816 |     1.00x |    24% | 2.17ms | 3.45ms | 4.78ms |
| Raw Bun   |      44,452 |     1.04x |    17% | 2.07ms | 3.22ms | 5.09ms |
| Hono      |      45,816 |     1.07x |     9% | 1.94ms | 3.86ms | 4.92ms |
| Elysia    |      44,504 |     1.04x |    34% | 2.87ms | 5.85ms | 6.02ms |
| Express   |      14,982 |     0.35x |    15% | 7.60ms | 11.27ms | 13.18ms |
| Fastify   |      20,419 |     0.48x |    14% | 4.81ms | 8.51ms | 9.82ms |
| Koa       |      15,615 |     0.36x |     1% | 5.65ms | 10.82ms | 11.74ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     1.1 ms |                9,003 |       0.51 |       0.69 |       0.69 |       0.69 |
|         100 |     1.4 ms |               70,325 |       0.38 |       0.95 |       0.96 |       0.96 |
|         500 |     3.5 ms |              143,031 |       1.25 |       2.00 |       2.06 |       2.09 |
|        1000 |     7.4 ms |              134,695 |       2.26 |       3.29 |       3.37 |       4.76 |
|        5000 |    31.8 ms |              157,324 |      18.27 |      23.35 |      23.72 |      23.84 |
|       10000 |    53.3 ms |              187,590 |      27.41 |      41.66 |      43.87 |      44.25 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.1 ms |            124,156 |     3.42 |     5.09 |     6.76 |       7.05 |     7.05 |
|        5000 |   21.6 ms |            230,956 |     9.52 |    13.99 |    14.47 |      14.48 |    14.48 |
|       10000 |   48.0 ms |            208,146 |    23.17 |    37.56 |    38.11 |      38.52 |    38.52 |
|       25000 |   98.5 ms |            253,840 |    49.10 |    71.33 |    75.16 |      75.34 |    75.35 |
|       50000 |  199.7 ms |            250,383 |    99.29 |   154.64 |   167.87 |     168.36 |   168.37 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.5 ms |             79,873 |     6.43 |     9.53 |    10.79 |      11.09 |    11.09 |
|        5000 |   53.3 ms |             93,879 |    24.59 |    40.85 |    41.99 |      42.03 |    42.03 |
|       10000 |  108.3 ms |             92,304 |    55.91 |    89.24 |    93.82 |      93.92 |    93.94 |
|       25000 |  267.9 ms |             93,329 |   138.75 |   233.97 |   248.64 |     248.94 |   248.95 |
|       50000 |  459.1 ms |            108,902 |   230.16 |   390.71 |   419.57 |     421.31 |   421.46 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.8 ms |             31,406 |    16.72 |    27.99 |    30.44 |      30.83 |    30.83 |
|        5000 |  143.7 ms |             34,801 |    77.41 |   128.07 |   139.30 |     140.75 |   140.92 |
|       10000 |  266.9 ms |             37,468 |   134.01 |   235.06 |   258.78 |     261.38 |   261.64 |

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
  • Raw Worker IPC Round-Trip      : 0.0426 ms/op
  • End-to-End Runtime Task Cost    : 0.0543 ms/op
  • Scheduler + Graph Overhead     : 0.0117 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     1.1 ms |                9,003 |       0.51 |       0.69 |       0.69 |       0.69 |
|         100 |     1.4 ms |               70,325 |       0.38 |       0.95 |       0.96 |       0.96 |
|         500 |     3.5 ms |              143,031 |       1.25 |       2.00 |       2.06 |       2.09 |
|        1000 |     7.4 ms |              134,695 |       2.26 |       3.29 |       3.37 |       4.76 |
|        5000 |    31.8 ms |              157,324 |      18.27 |      23.35 |      23.72 |      23.84 |
|       10000 |    53.3 ms |              187,590 |      27.41 |      41.66 |      43.87 |      44.25 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.46 MB
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
| 1 CPU + 1 IO  |       2 |   53.2 ms |            188,022 |    28.67 |    42.04 |    42.42 |    42.61 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   48.2 ms |            207,321 |    25.18 |    38.13 |    38.18 |    38.20 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   35.6 ms |            281,195 |    17.59 |    27.07 |    28.01 |    28.59 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   44.7 ms |            223,516 |    21.15 |    35.48 |    35.70 |    35.74 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 113.0 ms
  • Peak Throughput Rate       : 221,239 ops/sec
  • Latency Distribution       : p50: 56.72ms | p90: 88.09ms | p99: 89.90ms | p99.9: 90.92ms | Max: 90.98ms
  • Memory (RSS)               : Baseline: 96.8 MB | Peak: 127.6 MB | Cooldown: 101.6 MB

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
|        1000 |    8.1 ms |            124,156 |     3.42 |     5.09 |     6.76 |       7.05 |     7.05 |
|        5000 |   21.6 ms |            230,956 |     9.52 |    13.99 |    14.47 |      14.48 |    14.48 |
|       10000 |   48.0 ms |            208,146 |    23.17 |    37.56 |    38.11 |      38.52 |    38.52 |
|       25000 |   98.5 ms |            253,840 |    49.10 |    71.33 |    75.16 |      75.34 |    75.35 |
|       50000 |  199.7 ms |            250,383 |    99.29 |   154.64 |   167.87 |     168.36 |   168.37 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.5 ms |             79,873 |     6.43 |     9.53 |    10.79 |      11.09 |    11.09 |
|        5000 |   53.3 ms |             93,879 |    24.59 |    40.85 |    41.99 |      42.03 |    42.03 |
|       10000 |  108.3 ms |             92,304 |    55.91 |    89.24 |    93.82 |      93.92 |    93.94 |
|       25000 |  267.9 ms |             93,329 |   138.75 |   233.97 |   248.64 |     248.94 |   248.95 |
|       50000 |  459.1 ms |            108,902 |   230.16 |   390.71 |   419.57 |     421.31 |   421.46 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.8 ms |             31,406 |    16.72 |    27.99 |    30.44 |      30.83 |    30.83 |
|        5000 |  143.7 ms |             34,801 |    77.41 |   128.07 |   139.30 |     140.75 |   140.92 |
|       10000 |  266.9 ms |             37,468 |   134.01 |   235.06 |   258.78 |     261.38 |   261.64 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 204.6 MB
  • Settled Cooldown RSS   : 72.1 MB (Clean GC release)

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
| Yatta     |      42,816 |     1.00x |    24% | 2.17ms | 3.45ms | 4.78ms |
| Raw Bun   |      44,452 |     1.04x |    17% | 2.07ms | 3.22ms | 5.09ms |
| Hono      |      45,816 |     1.07x |     9% | 1.94ms | 3.86ms | 4.92ms |
| Elysia    |      44,504 |     1.04x |    34% | 2.87ms | 5.85ms | 6.02ms |
| Express   |      14,982 |     0.35x |    15% | 7.60ms | 11.27ms | 13.18ms |
| Fastify   |      20,419 |     0.48x |    14% | 4.81ms | 8.51ms | 9.82ms |
| Koa       |      15,615 |     0.36x |     1% | 5.65ms | 10.82ms | 11.74ms |

  Yatta dispatch adds about 0.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 24%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
