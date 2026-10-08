# Yatta Benchmarks

> Last run: `2026-10-08T15:26:18Z` · commit [`bb51202`](https://github.com/psrockstar098/yatta.js/commit/bb512028b61425dd9328d03b47327ae40af34ada) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 80.7 ms
  • End-to-End Runtime Task Cost    : 0.0414 ms/op
  • Peak RSS Memory        : 225.6 MB
  • RSS Heap Memory             : 92.00 MB
  • Raw Worker IPC Round-Trip      : 0.0242 ms/op
  • Scheduler + Graph Overhead     : 0.0172 ms/op
  • Settled Cooldown RSS   : 75.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.76 MB
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
| Yatta     |      62,608 |     1.00x |    12% | 1.52ms | 2.97ms | 3.40ms |
| Raw Bun   |      71,519 |     1.14x |    13% | 1.29ms | 2.25ms | 2.65ms |
| Hono      |      70,797 |     1.13x |    13% | 1.35ms | 2.45ms | 2.79ms |
| Elysia    |      77,977 |     1.25x |     3% | 1.21ms | 2.23ms | 2.92ms |
| Express   |      27,461 |     0.44x |     6% | 3.29ms | 6.25ms | 7.48ms |
| Fastify   |      35,287 |     0.56x |    15% | 2.54ms | 5.10ms | 6.41ms |
| Koa       |      27,277 |     0.44x |    15% | 3.38ms | 6.94ms | 9.08ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               13,299 |       0.37 |       0.40 |       0.40 |       0.40 |
|         100 |     0.6 ms |              154,488 |       0.29 |       0.51 |       0.55 |       0.55 |
|         500 |     1.6 ms |              314,530 |       0.80 |       1.21 |       1.27 |       1.29 |
|        1000 |     3.2 ms |              313,232 |       1.62 |       2.42 |       2.49 |       2.52 |
|        5000 |    18.0 ms |              278,075 |      10.00 |      11.97 |      12.22 |      12.24 |
|       10000 |    41.0 ms |              243,841 |      23.06 |      33.36 |      33.61 |      33.69 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.1 ms |            141,816 |     2.84 |     4.06 |     4.91 |       5.23 |     5.23 |
|        5000 |   18.8 ms |            266,550 |     9.43 |    12.37 |    12.87 |      12.90 |    12.90 |
|       10000 |   37.5 ms |            266,716 |    19.13 |    28.53 |    29.05 |      29.08 |    29.08 |
|       25000 |   84.8 ms |            294,824 |    41.37 |    61.24 |    63.94 |      64.43 |    64.46 |
|       50000 |  133.9 ms |            373,323 |    67.32 |   101.94 |   106.01 |     106.47 |   106.48 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.3 ms |             88,697 |     5.50 |     8.02 |     9.18 |       9.55 |     9.55 |
|        5000 |   45.7 ms |            109,310 |    23.49 |    35.44 |    36.48 |      36.55 |    36.55 |
|       10000 |  100.2 ms |             99,821 |    52.32 |    84.97 |    88.59 |      88.68 |    88.69 |
|       25000 |  250.3 ms |             99,898 |   135.17 |   220.00 |   231.19 |     231.66 |   231.70 |
|       50000 |  416.0 ms |            120,198 |   222.62 |   346.14 |   380.15 |     381.31 |   381.39 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   26.6 ms |             37,601 |    15.01 |    23.10 |    25.20 |      25.45 |    25.45 |
|        5000 |  100.4 ms |             49,799 |    47.48 |    88.75 |    97.33 |      98.58 |    98.68 |
|       10000 |  191.8 ms |             52,126 |    93.88 |   168.25 |   184.77 |     188.20 |   188.45 |

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
  • Raw Worker IPC Round-Trip      : 0.0242 ms/op
  • End-to-End Runtime Task Cost    : 0.0414 ms/op
  • Scheduler + Graph Overhead     : 0.0172 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               13,299 |       0.37 |       0.40 |       0.40 |       0.40 |
|         100 |     0.6 ms |              154,488 |       0.29 |       0.51 |       0.55 |       0.55 |
|         500 |     1.6 ms |              314,530 |       0.80 |       1.21 |       1.27 |       1.29 |
|        1000 |     3.2 ms |              313,232 |       1.62 |       2.42 |       2.49 |       2.52 |
|        5000 |    18.0 ms |              278,075 |      10.00 |      11.97 |      12.22 |      12.24 |
|       10000 |    41.0 ms |              243,841 |      23.06 |      33.36 |      33.61 |      33.69 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 92.00 MB
  • V8/JSC Heap Used             : 13.76 MB

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
| 1 CPU + 1 IO  |       2 |   39.5 ms |            253,095 |    17.98 |    30.02 |    30.35 |    30.37 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   36.4 ms |            274,924 |    19.86 |    25.33 |    25.40 |    25.41 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   29.4 ms |            340,259 |    14.01 |    21.89 |    22.54 |    22.97 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   29.8 ms |            335,853 |    14.55 |    22.15 |    22.38 |    22.41 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 80.7 ms
  • Peak Throughput Rate       : 309,622 ops/sec
  • Latency Distribution       : p50: 36.69ms | p90: 61.46ms | p99: 63.15ms | p99.9: 63.78ms | Max: 63.79ms
  • Memory (RSS)               : Baseline: 101.8 MB | Peak: 124.0 MB | Cooldown: 83.6 MB

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
|        1000 |    7.1 ms |            141,816 |     2.84 |     4.06 |     4.91 |       5.23 |     5.23 |
|        5000 |   18.8 ms |            266,550 |     9.43 |    12.37 |    12.87 |      12.90 |    12.90 |
|       10000 |   37.5 ms |            266,716 |    19.13 |    28.53 |    29.05 |      29.08 |    29.08 |
|       25000 |   84.8 ms |            294,824 |    41.37 |    61.24 |    63.94 |      64.43 |    64.46 |
|       50000 |  133.9 ms |            373,323 |    67.32 |   101.94 |   106.01 |     106.47 |   106.48 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.3 ms |             88,697 |     5.50 |     8.02 |     9.18 |       9.55 |     9.55 |
|        5000 |   45.7 ms |            109,310 |    23.49 |    35.44 |    36.48 |      36.55 |    36.55 |
|       10000 |  100.2 ms |             99,821 |    52.32 |    84.97 |    88.59 |      88.68 |    88.69 |
|       25000 |  250.3 ms |             99,898 |   135.17 |   220.00 |   231.19 |     231.66 |   231.70 |
|       50000 |  416.0 ms |            120,198 |   222.62 |   346.14 |   380.15 |     381.31 |   381.39 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   26.6 ms |             37,601 |    15.01 |    23.10 |    25.20 |      25.45 |    25.45 |
|        5000 |  100.4 ms |             49,799 |    47.48 |    88.75 |    97.33 |      98.58 |    98.68 |
|       10000 |  191.8 ms |             52,126 |    93.88 |   168.25 |   184.77 |     188.20 |   188.45 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 225.6 MB
  • Settled Cooldown RSS   : 75.6 MB (Clean GC release)

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
| Yatta     |      62,608 |     1.00x |    12% | 1.52ms | 2.97ms | 3.40ms |
| Raw Bun   |      71,519 |     1.14x |    13% | 1.29ms | 2.25ms | 2.65ms |
| Hono      |      70,797 |     1.13x |    13% | 1.35ms | 2.45ms | 2.79ms |
| Elysia    |      77,977 |     1.25x |     3% | 1.21ms | 2.23ms | 2.92ms |
| Express   |      27,461 |     0.44x |     6% | 3.29ms | 6.25ms | 7.48ms |
| Fastify   |      35,287 |     0.56x |    15% | 2.54ms | 5.10ms | 6.41ms |
| Koa       |      27,277 |     0.44x |    15% | 3.38ms | 6.94ms | 9.08ms |

  Yatta dispatch adds about 2.0µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
