# Yatta Benchmarks

> Last run: `2026-11-22T13:44:41Z` · commit [`d057f99`](https://github.com/psrockstar098/yatta.js/commit/d057f995c6889c300cb806ac9d88b5b15b21447a) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 86.7 ms
  • End-to-End Runtime Task Cost    : 0.0273 ms/op
  • Peak RSS Memory        : 200.2 MB
  • RSS Heap Memory             : 99.61 MB
  • Raw Worker IPC Round-Trip      : 0.0228 ms/op
  • Scheduler + Graph Overhead     : 0.0045 ms/op
  • Settled Cooldown RSS   : 121.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.92 MB
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      58,193 |     1.00x |     7% | 1.75ms | 2.59ms | 3.04ms |
| Raw Bun   |      51,081 |     0.88x |    25% | 1.71ms | 3.71ms | 3.97ms |
| Hono      |      61,849 |     1.06x |    21% | 1.61ms | 2.33ms | 3.36ms |
| Elysia    |      56,588 |     0.97x |    18% | 1.57ms | 3.32ms | 3.87ms |
| Express   |      23,480 |     0.40x |     4% | 3.97ms | 7.39ms | 8.58ms |
| Fastify   |      31,533 |     0.54x |     9% | 2.70ms | 5.21ms | 6.45ms |
| Koa       |      26,299 |     0.45x |    12% | 3.44ms | 6.51ms | 7.61ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,212 |       0.30 |       0.32 |       0.32 |       0.32 |
|         100 |     0.6 ms |              164,460 |       0.25 |       0.37 |       0.37 |       0.37 |
|         500 |     1.2 ms |              421,580 |       0.55 |       0.78 |       0.83 |       0.86 |
|        1000 |     2.7 ms |              365,972 |       1.20 |       1.44 |       1.51 |       1.56 |
|        5000 |    20.0 ms |              249,831 |      10.73 |      14.73 |      14.76 |      14.80 |
|       10000 |    38.3 ms |              260,952 |      19.25 |      31.88 |      32.14 |      32.18 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.3 ms |            159,800 |     2.73 |     3.86 |     4.92 |       4.98 |     4.98 |
|        5000 |   18.8 ms |            265,831 |     9.98 |    12.38 |    12.75 |      12.80 |    12.80 |
|       10000 |   39.8 ms |            251,127 |    21.91 |    31.14 |    31.74 |      31.75 |    31.75 |
|       25000 |  104.2 ms |            239,814 |    52.96 |    83.53 |    88.95 |      89.16 |    89.17 |
|       50000 |  209.5 ms |            238,649 |   103.71 |   168.97 |   180.00 |     180.32 |   180.37 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.4 ms |             95,912 |     5.03 |     7.34 |     8.36 |       8.70 |     8.70 |
|        5000 |   36.7 ms |            136,370 |    18.09 |    28.51 |    29.44 |      29.48 |    29.49 |
|       10000 |   85.6 ms |            116,793 |    43.90 |    73.06 |    76.06 |      76.15 |    76.16 |
|       25000 |  216.2 ms |            115,616 |   100.16 |   184.12 |   196.48 |     196.76 |   196.79 |
|       50000 |  393.7 ms |            127,014 |   224.67 |   336.23 |   360.36 |     361.33 |   361.38 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   17.1 ms |             58,565 |     9.21 |    14.53 |    15.87 |      16.11 |    16.11 |
|        5000 |   73.6 ms |             67,954 |    35.26 |    61.93 |    70.67 |      71.77 |    71.86 |
|       10000 |  170.5 ms |             58,635 |    77.26 |   144.43 |   161.02 |     165.97 |   166.23 |

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
  • Raw Worker IPC Round-Trip      : 0.0228 ms/op
  • End-to-End Runtime Task Cost    : 0.0273 ms/op
  • Scheduler + Graph Overhead     : 0.0045 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,212 |       0.30 |       0.32 |       0.32 |       0.32 |
|         100 |     0.6 ms |              164,460 |       0.25 |       0.37 |       0.37 |       0.37 |
|         500 |     1.2 ms |              421,580 |       0.55 |       0.78 |       0.83 |       0.86 |
|        1000 |     2.7 ms |              365,972 |       1.20 |       1.44 |       1.51 |       1.56 |
|        5000 |    20.0 ms |              249,831 |      10.73 |      14.73 |      14.76 |      14.80 |
|       10000 |    38.3 ms |              260,952 |      19.25 |      31.88 |      32.14 |      32.18 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 99.61 MB
  • V8/JSC Heap Used             : 13.92 MB

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
| 1 CPU + 1 IO  |       2 |   41.4 ms |            241,520 |    20.40 |    32.97 |    33.36 |    33.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   35.4 ms |            282,090 |    19.24 |    27.41 |    27.49 |    27.49 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   27.4 ms |            365,162 |    13.84 |    22.40 |    22.71 |    22.77 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   35.7 ms |            280,432 |    17.09 |    28.99 |    29.20 |    29.22 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 86.7 ms
  • Peak Throughput Rate       : 288,431 ops/sec
  • Latency Distribution       : p50: 44.35ms | p90: 69.56ms | p99: 71.10ms | p99.9: 71.37ms | Max: 71.40ms
  • Memory (RSS)               : Baseline: 101.4 MB | Peak: 136.2 MB | Cooldown: 105.8 MB

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
|        1000 |    6.3 ms |            159,800 |     2.73 |     3.86 |     4.92 |       4.98 |     4.98 |
|        5000 |   18.8 ms |            265,831 |     9.98 |    12.38 |    12.75 |      12.80 |    12.80 |
|       10000 |   39.8 ms |            251,127 |    21.91 |    31.14 |    31.74 |      31.75 |    31.75 |
|       25000 |  104.2 ms |            239,814 |    52.96 |    83.53 |    88.95 |      89.16 |    89.17 |
|       50000 |  209.5 ms |            238,649 |   103.71 |   168.97 |   180.00 |     180.32 |   180.37 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.4 ms |             95,912 |     5.03 |     7.34 |     8.36 |       8.70 |     8.70 |
|        5000 |   36.7 ms |            136,370 |    18.09 |    28.51 |    29.44 |      29.48 |    29.49 |
|       10000 |   85.6 ms |            116,793 |    43.90 |    73.06 |    76.06 |      76.15 |    76.16 |
|       25000 |  216.2 ms |            115,616 |   100.16 |   184.12 |   196.48 |     196.76 |   196.79 |
|       50000 |  393.7 ms |            127,014 |   224.67 |   336.23 |   360.36 |     361.33 |   361.38 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   17.1 ms |             58,565 |     9.21 |    14.53 |    15.87 |      16.11 |    16.11 |
|        5000 |   73.6 ms |             67,954 |    35.26 |    61.93 |    70.67 |      71.77 |    71.86 |
|       10000 |  170.5 ms |             58,635 |    77.26 |   144.43 |   161.02 |     165.97 |   166.23 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 200.2 MB
  • Settled Cooldown RSS   : 121.6 MB (Clean GC release)

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
| Yatta     |      58,193 |     1.00x |     7% | 1.75ms | 2.59ms | 3.04ms |
| Raw Bun   |      51,081 |     0.88x |    25% | 1.71ms | 3.71ms | 3.97ms |
| Hono      |      61,849 |     1.06x |    21% | 1.61ms | 2.33ms | 3.36ms |
| Elysia    |      56,588 |     0.97x |    18% | 1.57ms | 3.32ms | 3.87ms |
| Express   |      23,480 |     0.40x |     4% | 3.97ms | 7.39ms | 8.58ms |
| Fastify   |      31,533 |     0.54x |     9% | 2.70ms | 5.21ms | 6.45ms |
| Koa       |      26,299 |     0.45x |    12% | 3.44ms | 6.51ms | 7.61ms |

  Yatta dispatch adds about -2.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
