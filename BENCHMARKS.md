# Yatta Benchmarks

> Last run: `2026-11-05T03:38:52Z` · commit [`bb468c7`](https://github.com/psrockstar098/yatta.js/commit/bb468c77a272452db3ff560b0ba0a864edb0d263) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 88.5 ms
  • End-to-End Runtime Task Cost    : 0.0372 ms/op
  • Peak RSS Memory        : 229.4 MB
  • RSS Heap Memory             : 94.01 MB
  • Raw Worker IPC Round-Trip      : 0.0300 ms/op
  • Scheduler + Graph Overhead     : 0.0072 ms/op
  • Settled Cooldown RSS   : 73.5 MB (Clean GC release)
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
| Yatta     |      53,484 |     1.00x |    11% | 1.72ms | 3.34ms | 3.58ms |
| Raw Bun   |      72,132 |     1.35x |    13% | 1.32ms | 2.66ms | 2.87ms |
| Hono      |      58,135 |     1.09x |    41% | 1.53ms | 2.76ms | 3.17ms |
| Elysia    |      59,012 |     1.10x |    46% | 1.36ms | 2.24ms | 2.85ms |
| Express   |      20,384 |     0.38x |     3% | 4.36ms | 8.00ms | 9.31ms |
| Fastify   |      27,756 |     0.52x |     9% | 3.17ms | 6.33ms | 8.18ms |
| Koa       |      21,459 |     0.40x |    10% | 4.60ms | 7.63ms | 9.90ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,258 |       0.32 |       0.34 |       0.34 |       0.34 |
|         100 |     0.7 ms |              143,360 |       0.31 |       0.43 |       0.46 |       0.46 |
|         500 |     1.9 ms |              261,052 |       0.93 |       1.40 |       1.50 |       1.55 |
|        1000 |     3.4 ms |              292,278 |       1.77 |       2.70 |       2.82 |       2.85 |
|        5000 |    22.2 ms |              225,467 |      13.57 |      16.12 |      16.29 |      16.34 |
|       10000 |    44.7 ms |              223,590 |      22.13 |      35.15 |      36.81 |      36.83 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.7 ms |            130,237 |     3.92 |     5.40 |     6.35 |       6.48 |     6.48 |
|        5000 |   21.1 ms |            237,212 |    10.49 |    14.19 |    14.66 |      14.71 |    14.71 |
|       10000 |   40.1 ms |            249,577 |    19.79 |    29.07 |    30.72 |      30.75 |    30.75 |
|       25000 |   91.6 ms |            273,010 |    46.90 |    67.33 |    69.49 |      69.57 |    69.58 |
|       50000 |  157.4 ms |            317,731 |    82.71 |   119.30 |   127.05 |     127.46 |   127.52 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.8 ms |             84,518 |     6.00 |     9.03 |    10.44 |      10.61 |    10.61 |
|        5000 |   48.9 ms |            102,185 |    22.45 |    37.17 |    38.14 |      38.20 |    38.21 |
|       10000 |  106.9 ms |             93,515 |    56.04 |    89.60 |    93.29 |      93.43 |    93.45 |
|       25000 |  249.9 ms |            100,045 |   128.81 |   214.96 |   229.04 |     229.54 |   229.55 |
|       50000 |  439.0 ms |            113,890 |   244.34 |   372.93 |   395.45 |     397.44 |   398.04 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   22.2 ms |             45,135 |    11.69 |    19.59 |    20.98 |      21.16 |    21.16 |
|        5000 |   85.4 ms |             58,566 |    42.42 |    75.06 |    81.96 |      83.13 |    83.23 |
|       10000 |  158.7 ms |             63,004 |    79.65 |   137.60 |   152.74 |     154.94 |   155.20 |

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
  • Raw Worker IPC Round-Trip      : 0.0300 ms/op
  • End-to-End Runtime Task Cost    : 0.0372 ms/op
  • Scheduler + Graph Overhead     : 0.0072 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,258 |       0.32 |       0.34 |       0.34 |       0.34 |
|         100 |     0.7 ms |              143,360 |       0.31 |       0.43 |       0.46 |       0.46 |
|         500 |     1.9 ms |              261,052 |       0.93 |       1.40 |       1.50 |       1.55 |
|        1000 |     3.4 ms |              292,278 |       1.77 |       2.70 |       2.82 |       2.85 |
|        5000 |    22.2 ms |              225,467 |      13.57 |      16.12 |      16.29 |      16.34 |
|       10000 |    44.7 ms |              223,590 |      22.13 |      35.15 |      36.81 |      36.83 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 94.01 MB
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
| 1 CPU + 1 IO  |       2 |   48.8 ms |            204,897 |    21.49 |    36.72 |    39.09 |    39.23 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   39.4 ms |            253,859 |    19.80 |    30.02 |    30.18 |    30.28 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   33.1 ms |            302,287 |    15.74 |    25.53 |    26.43 |    26.76 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   32.9 ms |            303,523 |    17.47 |    24.40 |    24.72 |    24.74 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 88.5 ms
  • Peak Throughput Rate       : 282,494 ops/sec
  • Latency Distribution       : p50: 42.53ms | p90: 68.27ms | p99: 69.05ms | p99.9: 69.13ms | Max: 69.13ms
  • Memory (RSS)               : Baseline: 98.3 MB | Peak: 131.2 MB | Cooldown: 61.4 MB

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
|        1000 |    7.7 ms |            130,237 |     3.92 |     5.40 |     6.35 |       6.48 |     6.48 |
|        5000 |   21.1 ms |            237,212 |    10.49 |    14.19 |    14.66 |      14.71 |    14.71 |
|       10000 |   40.1 ms |            249,577 |    19.79 |    29.07 |    30.72 |      30.75 |    30.75 |
|       25000 |   91.6 ms |            273,010 |    46.90 |    67.33 |    69.49 |      69.57 |    69.58 |
|       50000 |  157.4 ms |            317,731 |    82.71 |   119.30 |   127.05 |     127.46 |   127.52 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.8 ms |             84,518 |     6.00 |     9.03 |    10.44 |      10.61 |    10.61 |
|        5000 |   48.9 ms |            102,185 |    22.45 |    37.17 |    38.14 |      38.20 |    38.21 |
|       10000 |  106.9 ms |             93,515 |    56.04 |    89.60 |    93.29 |      93.43 |    93.45 |
|       25000 |  249.9 ms |            100,045 |   128.81 |   214.96 |   229.04 |     229.54 |   229.55 |
|       50000 |  439.0 ms |            113,890 |   244.34 |   372.93 |   395.45 |     397.44 |   398.04 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   22.2 ms |             45,135 |    11.69 |    19.59 |    20.98 |      21.16 |    21.16 |
|        5000 |   85.4 ms |             58,566 |    42.42 |    75.06 |    81.96 |      83.13 |    83.23 |
|       10000 |  158.7 ms |             63,004 |    79.65 |   137.60 |   152.74 |     154.94 |   155.20 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 229.4 MB
  • Settled Cooldown RSS   : 73.5 MB (Clean GC release)

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
| Yatta     |      53,484 |     1.00x |    11% | 1.72ms | 3.34ms | 3.58ms |
| Raw Bun   |      72,132 |     1.35x |    13% | 1.32ms | 2.66ms | 2.87ms |
| Hono      |      58,135 |     1.09x |    41% | 1.53ms | 2.76ms | 3.17ms |
| Elysia    |      59,012 |     1.10x |    46% | 1.36ms | 2.24ms | 2.85ms |
| Express   |      20,384 |     0.38x |     3% | 4.36ms | 8.00ms | 9.31ms |
| Fastify   |      27,756 |     0.52x |     9% | 3.17ms | 6.33ms | 8.18ms |
| Koa       |      21,459 |     0.40x |    10% | 4.60ms | 7.63ms | 9.90ms |

  Yatta dispatch adds about 4.8µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
