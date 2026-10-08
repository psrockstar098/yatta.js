# Yatta Benchmarks

> Last run: `2026-10-08T17:33:37Z` · commit [`60ce05a`](https://github.com/psrockstar098/yatta.js/commit/60ce05ad3a12f53602358a3de9ef48fde7f12103) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 117.2 ms
  • End-to-End Runtime Task Cost    : 0.0542 ms/op
  • Peak RSS Memory        : 124.7 MB
  • RSS Heap Memory             : 81.27 MB
  • Raw Worker IPC Round-Trip      : 0.0409 ms/op
  • Scheduler + Graph Overhead     : 0.0133 ms/op
  • Settled Cooldown RSS   : 72.0 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
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
| Yatta     |      35,976 |     1.00x |    14% | 2.17ms | 4.22ms | 4.57ms |
| Raw Bun   |      45,585 |     1.27x |     9% | 2.06ms | 3.65ms | 4.20ms |
| Hono      |      45,742 |     1.27x |    29% | 1.89ms | 3.61ms | 3.92ms |
| Elysia    |      48,668 |     1.35x |    26% | 1.70ms | 2.73ms | 3.57ms |
| Express   |      15,121 |     0.42x |     5% | 5.28ms | 11.06ms | 12.00ms |
| Fastify   |      20,204 |     0.56x |     6% | 4.63ms | 8.56ms | 9.64ms |
| Koa       |      15,352 |     0.43x |     4% | 6.31ms | 10.28ms | 11.37ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,957 |       0.43 |       0.47 |       0.47 |       0.47 |
|         100 |     1.0 ms |              104,356 |       0.34 |       0.50 |       0.53 |       0.53 |
|         500 |     2.6 ms |              189,808 |       1.33 |       1.98 |       2.02 |       2.05 |
|        1000 |     4.4 ms |              228,838 |       2.21 |       2.80 |       2.87 |       2.88 |
|        5000 |    26.0 ms |              192,130 |      14.10 |      17.71 |      17.75 |      17.78 |
|       10000 |    51.3 ms |              194,777 |      26.03 |      41.98 |      42.09 |      42.10 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.1 ms |            109,400 |     4.98 |     6.72 |     7.85 |       8.18 |     8.18 |
|        5000 |   19.4 ms |            257,568 |     9.10 |    11.56 |    12.06 |      12.07 |    12.07 |
|       10000 |   45.1 ms |            221,918 |    21.06 |    34.10 |    35.50 |      35.63 |    35.63 |
|       25000 |  105.5 ms |            237,078 |    50.14 |    74.47 |    77.79 |      78.04 |    78.04 |
|       50000 |  187.8 ms |            266,290 |    91.65 |   148.28 |   158.34 |     158.85 |   158.86 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.4 ms |             80,902 |     6.25 |     9.21 |    11.01 |      11.30 |    11.30 |
|        5000 |   47.6 ms |            105,091 |    22.44 |    35.55 |    36.69 |      36.76 |    36.77 |
|       10000 |   98.5 ms |            101,474 |    49.83 |    82.25 |    85.14 |      85.24 |    85.25 |
|       25000 |  242.1 ms |            103,269 |   122.35 |   208.47 |   222.34 |     222.88 |   222.90 |
|       50000 |  507.5 ms |             98,515 |   269.73 |   434.29 |   470.10 |     471.13 |   471.21 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.4 ms |             32,853 |    15.79 |    26.85 |    29.20 |      29.42 |    29.42 |
|        5000 |  139.2 ms |             35,931 |    66.91 |   124.25 |   135.33 |     136.50 |   136.66 |
|       10000 |  283.9 ms |             35,229 |   142.05 |   250.27 |   276.93 |     279.12 |   279.46 |

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
  • Raw Worker IPC Round-Trip      : 0.0409 ms/op
  • End-to-End Runtime Task Cost    : 0.0542 ms/op
  • Scheduler + Graph Overhead     : 0.0133 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,957 |       0.43 |       0.47 |       0.47 |       0.47 |
|         100 |     1.0 ms |              104,356 |       0.34 |       0.50 |       0.53 |       0.53 |
|         500 |     2.6 ms |              189,808 |       1.33 |       1.98 |       2.02 |       2.05 |
|        1000 |     4.4 ms |              228,838 |       2.21 |       2.80 |       2.87 |       2.88 |
|        5000 |    26.0 ms |              192,130 |      14.10 |      17.71 |      17.75 |      17.78 |
|       10000 |    51.3 ms |              194,777 |      26.03 |      41.98 |      42.09 |      42.10 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 81.27 MB
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
| 1 CPU + 1 IO  |       2 |   60.5 ms |            165,172 |    25.30 |    46.10 |    47.06 |    47.26 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   42.3 ms |            236,558 |    22.41 |    33.68 |    33.89 |    33.93 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   39.6 ms |            252,276 |    19.61 |    32.20 |    32.55 |    32.62 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   40.0 ms |            250,173 |    19.03 |    30.28 |    30.72 |    30.95 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 117.2 ms
  • Peak Throughput Rate       : 213,388 ops/sec
  • Latency Distribution       : p50: 58.26ms | p90: 95.27ms | p99: 96.37ms | p99.9: 96.44ms | Max: 96.44ms
  • Memory (RSS)               : Baseline: 96.6 MB | Peak: 127.0 MB | Cooldown: 101.3 MB

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
|        1000 |    9.1 ms |            109,400 |     4.98 |     6.72 |     7.85 |       8.18 |     8.18 |
|        5000 |   19.4 ms |            257,568 |     9.10 |    11.56 |    12.06 |      12.07 |    12.07 |
|       10000 |   45.1 ms |            221,918 |    21.06 |    34.10 |    35.50 |      35.63 |    35.63 |
|       25000 |  105.5 ms |            237,078 |    50.14 |    74.47 |    77.79 |      78.04 |    78.04 |
|       50000 |  187.8 ms |            266,290 |    91.65 |   148.28 |   158.34 |     158.85 |   158.86 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.4 ms |             80,902 |     6.25 |     9.21 |    11.01 |      11.30 |    11.30 |
|        5000 |   47.6 ms |            105,091 |    22.44 |    35.55 |    36.69 |      36.76 |    36.77 |
|       10000 |   98.5 ms |            101,474 |    49.83 |    82.25 |    85.14 |      85.24 |    85.25 |
|       25000 |  242.1 ms |            103,269 |   122.35 |   208.47 |   222.34 |     222.88 |   222.90 |
|       50000 |  507.5 ms |             98,515 |   269.73 |   434.29 |   470.10 |     471.13 |   471.21 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.4 ms |             32,853 |    15.79 |    26.85 |    29.20 |      29.42 |    29.42 |
|        5000 |  139.2 ms |             35,931 |    66.91 |   124.25 |   135.33 |     136.50 |   136.66 |
|       10000 |  283.9 ms |             35,229 |   142.05 |   250.27 |   276.93 |     279.12 |   279.46 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 124.7 MB
  • Settled Cooldown RSS   : 72.0 MB (Clean GC release)

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
| Yatta     |      35,976 |     1.00x |    14% | 2.17ms | 4.22ms | 4.57ms |
| Raw Bun   |      45,585 |     1.27x |     9% | 2.06ms | 3.65ms | 4.20ms |
| Hono      |      45,742 |     1.27x |    29% | 1.89ms | 3.61ms | 3.92ms |
| Elysia    |      48,668 |     1.35x |    26% | 1.70ms | 2.73ms | 3.57ms |
| Express   |      15,121 |     0.42x |     5% | 5.28ms | 11.06ms | 12.00ms |
| Fastify   |      20,204 |     0.56x |     6% | 4.63ms | 8.56ms | 9.64ms |
| Koa       |      15,352 |     0.43x |     4% | 6.31ms | 10.28ms | 11.37ms |

  Yatta dispatch adds about 5.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
