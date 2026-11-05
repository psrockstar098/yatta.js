# Yatta Benchmarks

> Last run: `2026-11-05T02:57:24Z` · commit [`101c05b`](https://github.com/psrockstar098/yatta.js/commit/101c05b292b9b3be61ada9298217fb7f7bf30bad) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 58.9 ms
  • End-to-End Runtime Task Cost    : 0.0166 ms/op
  • Peak RSS Memory        : 232.8 MB
  • RSS Heap Memory             : 95.75 MB
  • Raw Worker IPC Round-Trip      : 0.0107 ms/op
  • Scheduler + Graph Overhead     : 0.0059 ms/op
  • Settled Cooldown RSS   : 81.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.66 MB
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      94,215 |     1.00x |    10% | 0.91ms | 1.66ms | 2.10ms |
| Raw Bun   |     120,440 |     1.28x |    19% | 0.94ms | 1.89ms | 2.05ms |
| Hono      |     102,963 |     1.09x |    19% | 1.06ms | 2.13ms | 2.89ms |
| Elysia    |     112,927 |     1.20x |     3% | 0.99ms | 1.28ms | 1.71ms |
| Express   |      43,454 |     0.46x |     3% | 2.25ms | 4.36ms | 7.15ms |
| Fastify   |      56,595 |     0.60x |    10% | 1.66ms | 3.08ms | 3.98ms |
| Koa       |      47,301 |     0.50x |     7% | 1.98ms | 4.02ms | 5.73ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,628 |       0.19 |       0.20 |       0.20 |       0.20 |
|         100 |     0.5 ms |              213,572 |       0.22 |       0.34 |       0.36 |       0.36 |
|         500 |     1.4 ms |              346,521 |       0.71 |       1.04 |       1.10 |       1.12 |
|        1000 |     2.2 ms |              452,147 |       1.11 |       1.53 |       1.56 |       1.57 |
|        5000 |    16.0 ms |              311,723 |       8.82 |      11.72 |      11.75 |      11.75 |
|       10000 |    30.2 ms |              331,400 |      15.40 |      24.02 |      24.19 |      24.49 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    5.5 ms |            182,859 |     2.29 |     3.09 |     3.92 |       4.00 |     4.00 |
|        5000 |   17.6 ms |            284,052 |     9.74 |    12.11 |    12.49 |      12.50 |    12.50 |
|       10000 |   32.5 ms |            307,755 |    15.15 |    24.33 |    25.76 |      25.78 |    25.78 |
|       25000 |   60.4 ms |            413,573 |    28.86 |    42.33 |    46.00 |      46.17 |    46.29 |
|       50000 |  113.8 ms |            439,527 |    57.15 |    86.11 |    91.66 |      91.76 |    91.77 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.8 ms |            113,061 |     4.36 |     6.43 |     7.27 |       7.61 |     7.61 |
|        5000 |   29.5 ms |            169,304 |    14.82 |    22.93 |    23.76 |      23.81 |    23.82 |
|       10000 |   60.6 ms |            165,023 |    32.48 |    52.17 |    53.96 |      54.02 |    54.02 |
|       25000 |  186.0 ms |            134,381 |    99.40 |   161.70 |   170.55 |     170.95 |   170.96 |
|       50000 |  350.1 ms |            142,836 |   182.79 |   296.30 |   320.99 |     321.87 |   321.93 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.2 ms |             61,772 |     6.32 |     9.47 |    15.32 |      15.42 |    15.42 |
|        5000 |   47.4 ms |            105,590 |    26.63 |    41.75 |    45.15 |      45.63 |    45.67 |
|       10000 |   95.7 ms |            104,499 |    44.59 |    83.74 |    91.58 |      92.50 |    92.72 |

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
  • Raw Worker IPC Round-Trip      : 0.0107 ms/op
  • End-to-End Runtime Task Cost    : 0.0166 ms/op
  • Scheduler + Graph Overhead     : 0.0059 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,628 |       0.19 |       0.20 |       0.20 |       0.20 |
|         100 |     0.5 ms |              213,572 |       0.22 |       0.34 |       0.36 |       0.36 |
|         500 |     1.4 ms |              346,521 |       0.71 |       1.04 |       1.10 |       1.12 |
|        1000 |     2.2 ms |              452,147 |       1.11 |       1.53 |       1.56 |       1.57 |
|        5000 |    16.0 ms |              311,723 |       8.82 |      11.72 |      11.75 |      11.75 |
|       10000 |    30.2 ms |              331,400 |      15.40 |      24.02 |      24.19 |      24.49 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 95.75 MB
  • V8/JSC Heap Used             : 13.66 MB

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
| 1 CPU + 1 IO  |       2 |   34.7 ms |            288,474 |    17.36 |    26.37 |    27.61 |    27.69 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   29.8 ms |            335,728 |    16.71 |    22.47 |    22.56 |    22.58 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   25.5 ms |            392,064 |    12.37 |    19.72 |    20.16 |    20.34 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   23.2 ms |            431,308 |    10.94 |    17.51 |    17.68 |    17.71 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 58.9 ms
  • Peak Throughput Rate       : 424,609 ops/sec
  • Latency Distribution       : p50: 29.27ms | p90: 46.63ms | p99: 47.07ms | p99.9: 47.15ms | Max: 47.17ms
  • Memory (RSS)               : Baseline: 101.0 MB | Peak: 135.8 MB | Cooldown: 101.1 MB

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
|        1000 |    5.5 ms |            182,859 |     2.29 |     3.09 |     3.92 |       4.00 |     4.00 |
|        5000 |   17.6 ms |            284,052 |     9.74 |    12.11 |    12.49 |      12.50 |    12.50 |
|       10000 |   32.5 ms |            307,755 |    15.15 |    24.33 |    25.76 |      25.78 |    25.78 |
|       25000 |   60.4 ms |            413,573 |    28.86 |    42.33 |    46.00 |      46.17 |    46.29 |
|       50000 |  113.8 ms |            439,527 |    57.15 |    86.11 |    91.66 |      91.76 |    91.77 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.8 ms |            113,061 |     4.36 |     6.43 |     7.27 |       7.61 |     7.61 |
|        5000 |   29.5 ms |            169,304 |    14.82 |    22.93 |    23.76 |      23.81 |    23.82 |
|       10000 |   60.6 ms |            165,023 |    32.48 |    52.17 |    53.96 |      54.02 |    54.02 |
|       25000 |  186.0 ms |            134,381 |    99.40 |   161.70 |   170.55 |     170.95 |   170.96 |
|       50000 |  350.1 ms |            142,836 |   182.79 |   296.30 |   320.99 |     321.87 |   321.93 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.2 ms |             61,772 |     6.32 |     9.47 |    15.32 |      15.42 |    15.42 |
|        5000 |   47.4 ms |            105,590 |    26.63 |    41.75 |    45.15 |      45.63 |    45.67 |
|       10000 |   95.7 ms |            104,499 |    44.59 |    83.74 |    91.58 |      92.50 |    92.72 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 232.8 MB
  • Settled Cooldown RSS   : 81.6 MB (Clean GC release)

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
| Yatta     |      94,215 |     1.00x |    10% | 0.91ms | 1.66ms | 2.10ms |
| Raw Bun   |     120,440 |     1.28x |    19% | 0.94ms | 1.89ms | 2.05ms |
| Hono      |     102,963 |     1.09x |    19% | 1.06ms | 2.13ms | 2.89ms |
| Elysia    |     112,927 |     1.20x |     3% | 0.99ms | 1.28ms | 1.71ms |
| Express   |      43,454 |     0.46x |     3% | 2.25ms | 4.36ms | 7.15ms |
| Fastify   |      56,595 |     0.60x |    10% | 1.66ms | 3.08ms | 3.98ms |
| Koa       |      47,301 |     0.50x |     7% | 1.98ms | 4.02ms | 5.73ms |

  Yatta dispatch adds about 2.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
