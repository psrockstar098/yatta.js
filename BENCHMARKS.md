# Yatta Benchmarks

> Last run: `2026-11-23T09:17:42Z` · commit [`a7c496c`](https://github.com/psrockstar098/yatta.js/commit/a7c496c564cdd381f421601bceb7aa5e140bc23f) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 66.9 ms
  • End-to-End Runtime Task Cost    : 0.0214 ms/op
  • Peak RSS Memory        : 207.4 MB
  • RSS Heap Memory             : 93.45 MB
  • Raw Worker IPC Round-Trip      : 0.0150 ms/op
  • Scheduler + Graph Overhead     : 0.0064 ms/op
  • Settled Cooldown RSS   : 79.2 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.89 MB
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
| Yatta     |      93,377 |     1.00x |     6% | 1.11ms | 1.60ms | 2.13ms |
| Raw Bun   |     121,328 |     1.30x |     5% | 0.92ms | 1.15ms | 1.55ms |
| Hono      |     107,467 |     1.15x |    11% | 1.02ms | 1.44ms | 1.91ms |
| Elysia    |     115,496 |     1.24x |     3% | 0.93ms | 1.30ms | 1.69ms |
| Express   |      43,423 |     0.47x |     3% | 2.15ms | 4.27ms | 5.45ms |
| Fastify   |      55,881 |     0.60x |     5% | 1.56ms | 3.31ms | 4.22ms |
| Koa       |      49,082 |     0.53x |     2% | 1.93ms | 3.60ms | 4.35ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               19,957 |       0.23 |       0.25 |       0.25 |       0.25 |
|         100 |     0.6 ms |              157,145 |       0.21 |       0.41 |       0.41 |       0.41 |
|         500 |     1.3 ms |              381,137 |       0.63 |       0.89 |       0.92 |       0.95 |
|        1000 |     2.2 ms |              447,439 |       1.12 |       1.67 |       1.75 |       1.77 |
|        5000 |    14.9 ms |              335,380 |       8.49 |      10.69 |      10.84 |      10.86 |
|       10000 |    26.2 ms |              381,304 |      13.54 |      20.20 |      20.53 |      20.77 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    5.6 ms |            178,827 |     2.38 |     3.32 |     4.45 |       4.86 |     4.86 |
|        5000 |   15.6 ms |            321,036 |     6.92 |     9.45 |     9.86 |       9.87 |     9.87 |
|       10000 |   30.2 ms |            331,317 |    13.77 |    21.24 |    22.85 |      22.96 |    22.97 |
|       25000 |   64.3 ms |            389,015 |    34.18 |    46.17 |    48.53 |      48.61 |    48.61 |
|       50000 |  117.8 ms |            424,593 |    59.46 |    89.05 |    94.07 |      94.10 |    94.10 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            124,961 |     4.00 |     5.47 |     6.01 |       6.11 |     6.11 |
|        5000 |   34.6 ms |            144,653 |    18.25 |    26.74 |    27.55 |      27.58 |    27.59 |
|       10000 |   70.8 ms |            141,229 |    38.96 |    62.46 |    64.21 |      64.29 |    64.31 |
|       25000 |  187.5 ms |            133,360 |    96.10 |   161.57 |   172.70 |     173.08 |   173.08 |
|       50000 |  316.5 ms |            157,990 |   156.85 |   260.14 |   286.32 |     287.22 |   287.28 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.3 ms |             69,933 |     9.06 |    12.65 |    13.47 |      13.60 |    13.60 |
|        5000 |   51.1 ms |             97,928 |    30.04 |    45.34 |    48.77 |      49.14 |    49.18 |
|       10000 |   96.7 ms |            103,438 |    41.49 |    78.52 |    93.05 |      93.76 |    93.88 |

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
  • Raw Worker IPC Round-Trip      : 0.0150 ms/op
  • End-to-End Runtime Task Cost    : 0.0214 ms/op
  • Scheduler + Graph Overhead     : 0.0064 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               19,957 |       0.23 |       0.25 |       0.25 |       0.25 |
|         100 |     0.6 ms |              157,145 |       0.21 |       0.41 |       0.41 |       0.41 |
|         500 |     1.3 ms |              381,137 |       0.63 |       0.89 |       0.92 |       0.95 |
|        1000 |     2.2 ms |              447,439 |       1.12 |       1.67 |       1.75 |       1.77 |
|        5000 |    14.9 ms |              335,380 |       8.49 |      10.69 |      10.84 |      10.86 |
|       10000 |    26.2 ms |              381,304 |      13.54 |      20.20 |      20.53 |      20.77 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.45 MB
  • V8/JSC Heap Used             : 13.89 MB

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
| 1 CPU + 1 IO  |       2 |   41.0 ms |            243,858 |    20.90 |    30.26 |    30.80 |    30.93 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   28.4 ms |            351,590 |    14.38 |    20.83 |    21.60 |    21.71 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   24.5 ms |            407,617 |    10.33 |    18.20 |    18.41 |    18.46 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   22.1 ms |            452,305 |    12.03 |    17.75 |    17.99 |    18.00 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 66.9 ms
  • Peak Throughput Rate       : 373,521 ops/sec
  • Latency Distribution       : p50: 32.60ms | p90: 51.99ms | p99: 53.10ms | p99.9: 53.26ms | Max: 53.27ms
  • Memory (RSS)               : Baseline: 113.1 MB | Peak: 130.5 MB | Cooldown: 102.1 MB

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
|        1000 |    5.6 ms |            178,827 |     2.38 |     3.32 |     4.45 |       4.86 |     4.86 |
|        5000 |   15.6 ms |            321,036 |     6.92 |     9.45 |     9.86 |       9.87 |     9.87 |
|       10000 |   30.2 ms |            331,317 |    13.77 |    21.24 |    22.85 |      22.96 |    22.97 |
|       25000 |   64.3 ms |            389,015 |    34.18 |    46.17 |    48.53 |      48.61 |    48.61 |
|       50000 |  117.8 ms |            424,593 |    59.46 |    89.05 |    94.07 |      94.10 |    94.10 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            124,961 |     4.00 |     5.47 |     6.01 |       6.11 |     6.11 |
|        5000 |   34.6 ms |            144,653 |    18.25 |    26.74 |    27.55 |      27.58 |    27.59 |
|       10000 |   70.8 ms |            141,229 |    38.96 |    62.46 |    64.21 |      64.29 |    64.31 |
|       25000 |  187.5 ms |            133,360 |    96.10 |   161.57 |   172.70 |     173.08 |   173.08 |
|       50000 |  316.5 ms |            157,990 |   156.85 |   260.14 |   286.32 |     287.22 |   287.28 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.3 ms |             69,933 |     9.06 |    12.65 |    13.47 |      13.60 |    13.60 |
|        5000 |   51.1 ms |             97,928 |    30.04 |    45.34 |    48.77 |      49.14 |    49.18 |
|       10000 |   96.7 ms |            103,438 |    41.49 |    78.52 |    93.05 |      93.76 |    93.88 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 207.4 MB
  • Settled Cooldown RSS   : 79.2 MB (Clean GC release)

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
| Yatta     |      93,377 |     1.00x |     6% | 1.11ms | 1.60ms | 2.13ms |
| Raw Bun   |     121,328 |     1.30x |     5% | 0.92ms | 1.15ms | 1.55ms |
| Hono      |     107,467 |     1.15x |    11% | 1.02ms | 1.44ms | 1.91ms |
| Elysia    |     115,496 |     1.24x |     3% | 0.93ms | 1.30ms | 1.69ms |
| Express   |      43,423 |     0.47x |     3% | 2.15ms | 4.27ms | 5.45ms |
| Fastify   |      55,881 |     0.60x |     5% | 1.56ms | 3.31ms | 4.22ms |
| Koa       |      49,082 |     0.53x |     2% | 1.93ms | 3.60ms | 4.35ms |

  Yatta dispatch adds about 2.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
