# Yatta Benchmarks

> Last run: `2026-10-17T03:36:03Z` · commit [`51dc0d8`](https://github.com/psrockstar098/yatta.js/commit/51dc0d80572ef26cb648cc387a77c8d6c4f0d830) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 92.1 ms
  • End-to-End Runtime Task Cost    : 0.0562 ms/op
  • Peak RSS Memory        : 181.2 MB
  • RSS Heap Memory             : 77.97 MB
  • Raw Worker IPC Round-Trip      : 0.0400 ms/op
  • Scheduler + Graph Overhead     : 0.0162 ms/op
  • Settled Cooldown RSS   : 73.2 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      42,388 |     1.00x |    24% | 2.11ms | 4.01ms | 4.49ms |
| Raw Bun   |      47,192 |     1.11x |     7% | 2.15ms | 3.48ms | 5.19ms |
| Hono      |      44,869 |     1.06x |     3% | 1.93ms | 3.68ms | 4.75ms |
| Elysia    |      46,250 |     1.09x |     7% | 2.29ms | 3.52ms | 4.72ms |
| Express   |      14,664 |     0.35x |     5% | 6.07ms | 10.32ms | 11.46ms |
| Fastify   |      20,234 |     0.48x |    16% | 6.06ms | 8.42ms | 10.50ms |
| Koa       |      14,658 |     0.35x |     7% | 7.14ms | 11.30ms | 15.75ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               13,053 |       0.37 |       0.41 |       0.41 |       0.41 |
|         100 |     1.0 ms |              105,215 |       0.31 |       0.52 |       0.60 |       0.60 |
|         500 |     1.8 ms |              281,161 |       0.86 |       1.16 |       1.19 |       1.22 |
|        1000 |     3.2 ms |              307,757 |       1.77 |       2.52 |       2.54 |       2.56 |
|        5000 |    21.7 ms |              230,522 |      11.99 |      15.14 |      15.24 |      15.35 |
|       10000 |    41.1 ms |              243,191 |      20.18 |      32.40 |      33.28 |      33.57 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.0 ms |            110,970 |     3.37 |     4.70 |     7.08 |       7.15 |     7.15 |
|        5000 |   18.9 ms |            265,173 |     9.30 |    11.69 |    12.15 |      12.16 |    12.17 |
|       10000 |   44.0 ms |            227,387 |    23.50 |    33.96 |    34.71 |      34.72 |    34.72 |
|       25000 |  102.4 ms |            244,184 |    52.19 |    72.49 |    77.69 |      77.80 |    77.82 |
|       50000 |  218.2 ms |            229,134 |   107.91 |   168.12 |   180.97 |     181.06 |   181.08 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.9 ms |             84,289 |     6.12 |     8.59 |     9.12 |       9.47 |     9.47 |
|        5000 |   47.7 ms |            104,898 |    23.71 |    36.01 |    36.98 |      37.03 |    37.04 |
|       10000 |   85.1 ms |            117,516 |    43.32 |    68.25 |    71.34 |      71.50 |    71.51 |
|       25000 |  238.7 ms |            104,751 |   119.02 |   207.11 |   219.45 |     219.96 |   219.96 |
|       50000 |  448.5 ms |            111,472 |   221.85 |   376.57 |   412.17 |     414.15 |   414.31 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.5 ms |             30,800 |    16.95 |    28.79 |    31.18 |      31.47 |    31.47 |
|        5000 |  143.1 ms |             34,929 |    79.00 |   127.17 |   139.22 |     140.39 |   140.56 |
|       10000 |  271.4 ms |             36,840 |   133.57 |   236.34 |   262.83 |     265.41 |   265.79 |

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[1] Layer Overhead Decomposition (Micro-benchmarking 2,000 calls each):
  • Raw Worker IPC Round-Trip      : 0.0400 ms/op
  • End-to-End Runtime Task Cost    : 0.0562 ms/op
  • Scheduler + Graph Overhead     : 0.0162 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               13,053 |       0.37 |       0.41 |       0.41 |       0.41 |
|         100 |     1.0 ms |              105,215 |       0.31 |       0.52 |       0.60 |       0.60 |
|         500 |     1.8 ms |              281,161 |       0.86 |       1.16 |       1.19 |       1.22 |
|        1000 |     3.2 ms |              307,757 |       1.77 |       2.52 |       2.54 |       2.56 |
|        5000 |    21.7 ms |              230,522 |      11.99 |      15.14 |      15.24 |      15.35 |
|       10000 |    41.1 ms |              243,191 |      20.18 |      32.40 |      33.28 |      33.57 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.97 MB
  • V8/JSC Heap Used             : 0.75 MB

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 1 IO  |       2 |   51.6 ms |            193,728 |    25.64 |    39.16 |    39.64 |    40.10 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   43.8 ms |            228,120 |    20.98 |    33.75 |    33.93 |    33.97 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   38.8 ms |            257,597 |    16.83 |    30.30 |    31.12 |    31.58 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   40.1 ms |            249,226 |    17.20 |    30.49 |    30.92 |    31.02 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 92.1 ms
  • Peak Throughput Rate       : 271,407 ops/sec
  • Latency Distribution       : p50: 43.80ms | p90: 71.36ms | p99: 73.00ms | p99.9: 73.22ms | Max: 73.24ms
  • Memory (RSS)               : Baseline: 94.8 MB | Peak: 129.1 MB | Cooldown: 102.4 MB

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
📊 [WORKLOAD 1] Zero-Delay FastPing (IPC & Scheduler Baseline):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.0 ms |            110,970 |     3.37 |     4.70 |     7.08 |       7.15 |     7.15 |
|        5000 |   18.9 ms |            265,173 |     9.30 |    11.69 |    12.15 |      12.16 |    12.17 |
|       10000 |   44.0 ms |            227,387 |    23.50 |    33.96 |    34.71 |      34.72 |    34.72 |
|       25000 |  102.4 ms |            244,184 |    52.19 |    72.49 |    77.69 |      77.80 |    77.82 |
|       50000 |  218.2 ms |            229,134 |   107.91 |   168.12 |   180.97 |     181.06 |   181.08 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.9 ms |             84,289 |     6.12 |     8.59 |     9.12 |       9.47 |     9.47 |
|        5000 |   47.7 ms |            104,898 |    23.71 |    36.01 |    36.98 |      37.03 |    37.04 |
|       10000 |   85.1 ms |            117,516 |    43.32 |    68.25 |    71.34 |      71.50 |    71.51 |
|       25000 |  238.7 ms |            104,751 |   119.02 |   207.11 |   219.45 |     219.96 |   219.96 |
|       50000 |  448.5 ms |            111,472 |   221.85 |   376.57 |   412.17 |     414.15 |   414.31 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.5 ms |             30,800 |    16.95 |    28.79 |    31.18 |      31.47 |    31.47 |
|        5000 |  143.1 ms |             34,929 |    79.00 |   127.17 |   139.22 |     140.39 |   140.56 |
|       10000 |  271.4 ms |             36,840 |   133.57 |   236.34 |   262.83 |     265.41 |   265.79 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 181.2 MB
  • Settled Cooldown RSS   : 73.2 MB (Clean GC release)

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
| Yatta     |      42,388 |     1.00x |    24% | 2.11ms | 4.01ms | 4.49ms |
| Raw Bun   |      47,192 |     1.11x |     7% | 2.15ms | 3.48ms | 5.19ms |
| Hono      |      44,869 |     1.06x |     3% | 1.93ms | 3.68ms | 4.75ms |
| Elysia    |      46,250 |     1.09x |     7% | 2.29ms | 3.52ms | 4.72ms |
| Express   |      14,664 |     0.35x |     5% | 6.07ms | 10.32ms | 11.46ms |
| Fastify   |      20,234 |     0.48x |    16% | 6.06ms | 8.42ms | 10.50ms |
| Koa       |      14,658 |     0.35x |     7% | 7.14ms | 11.30ms | 15.75ms |

  Yatta dispatch adds about 2.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 24%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
