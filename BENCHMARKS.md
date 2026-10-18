# Yatta Benchmarks

> Last run: `2026-10-18T02:07:04Z` · commit [`2850a56`](https://github.com/psrockstar098/yatta.js/commit/2850a561cca4564229ac9d4a51e8ada47ee5a653) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 81.7 ms
  • End-to-End Runtime Task Cost    : 0.0363 ms/op
  • Peak RSS Memory        : 155.8 MB
  • RSS Heap Memory             : 93.62 MB
  • Raw Worker IPC Round-Trip      : 0.0317 ms/op
  • Scheduler + Graph Overhead     : 0.0046 ms/op
  • Settled Cooldown RSS   : 102.5 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.79 MB
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
| Yatta     |      53,828 |     1.00x |     9% | 1.74ms | 3.36ms | 3.72ms |
| Raw Bun   |      65,551 |     1.22x |    20% | 1.36ms | 2.36ms | 2.81ms |
| Hono      |      63,403 |     1.18x |     7% | 1.54ms | 2.81ms | 3.14ms |
| Elysia    |      69,601 |     1.29x |    19% | 1.35ms | 2.56ms | 3.02ms |
| Express   |      21,922 |     0.41x |     6% | 4.25ms | 8.04ms | 10.44ms |
| Fastify   |      27,382 |     0.51x |     3% | 3.39ms | 6.65ms | 8.81ms |
| Koa       |      22,047 |     0.41x |    17% | 4.17ms | 8.08ms | 11.65ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,831 |       0.27 |       0.30 |       0.30 |       0.30 |
|         100 |     0.8 ms |              133,258 |       0.29 |       0.47 |       0.48 |       0.48 |
|         500 |     1.8 ms |              281,226 |       0.97 |       1.40 |       1.45 |       1.48 |
|        1000 |     3.3 ms |              304,746 |       1.68 |       2.58 |       2.71 |       2.75 |
|        5000 |    21.6 ms |              231,066 |      11.60 |      14.03 |      14.80 |      14.90 |
|       10000 |    37.2 ms |              268,554 |      20.36 |      28.40 |      28.62 |      28.68 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.5 ms |            153,014 |     2.84 |     4.09 |     5.06 |       5.20 |     5.20 |
|        5000 |   20.0 ms |            249,859 |     9.57 |    13.16 |    13.77 |      13.79 |    13.79 |
|       10000 |   39.2 ms |            255,247 |    20.85 |    30.19 |    30.76 |      30.77 |    30.77 |
|       25000 |   89.8 ms |            278,353 |    39.66 |    67.75 |    69.58 |      70.45 |    70.47 |
|       50000 |  148.2 ms |            337,280 |    74.99 |   111.34 |   120.66 |     120.79 |   120.83 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.8 ms |             92,250 |     5.65 |     7.95 |     9.18 |       9.28 |     9.28 |
|        5000 |   41.4 ms |            120,829 |    18.58 |    28.49 |    31.49 |      31.54 |    31.55 |
|       10000 |   74.9 ms |            133,553 |    39.10 |    62.37 |    65.35 |      65.42 |    65.42 |
|       25000 |  235.1 ms |            106,349 |   106.34 |   195.11 |   209.74 |     210.22 |   210.25 |
|       50000 |  462.9 ms |            108,024 |   208.48 |   384.47 |   428.32 |     429.49 |   429.56 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   23.7 ms |             42,188 |    12.40 |    20.36 |    22.41 |      22.82 |    22.82 |
|        5000 |   97.1 ms |             51,476 |    50.57 |    84.91 |    92.54 |      93.46 |    93.56 |
|       10000 |  191.6 ms |             52,183 |    96.60 |   165.91 |   185.14 |     186.61 |   186.89 |

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
  • Raw Worker IPC Round-Trip      : 0.0317 ms/op
  • End-to-End Runtime Task Cost    : 0.0363 ms/op
  • Scheduler + Graph Overhead     : 0.0046 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,831 |       0.27 |       0.30 |       0.30 |       0.30 |
|         100 |     0.8 ms |              133,258 |       0.29 |       0.47 |       0.48 |       0.48 |
|         500 |     1.8 ms |              281,226 |       0.97 |       1.40 |       1.45 |       1.48 |
|        1000 |     3.3 ms |              304,746 |       1.68 |       2.58 |       2.71 |       2.75 |
|        5000 |    21.6 ms |              231,066 |      11.60 |      14.03 |      14.80 |      14.90 |
|       10000 |    37.2 ms |              268,554 |      20.36 |      28.40 |      28.62 |      28.68 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.62 MB
  • V8/JSC Heap Used             : 13.79 MB

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
| 1 CPU + 1 IO  |       2 |   44.1 ms |            226,804 |    21.51 |    33.32 |    34.15 |    34.45 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   39.5 ms |            252,940 |    19.21 |    29.59 |    29.86 |    29.90 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   32.5 ms |            307,910 |    16.56 |    23.01 |    23.69 |    23.79 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   34.6 ms |            288,848 |    15.02 |    26.53 |    26.73 |    26.75 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 81.7 ms
  • Peak Throughput Rate       : 305,989 ops/sec
  • Latency Distribution       : p50: 39.35ms | p90: 60.84ms | p99: 62.27ms | p99.9: 62.82ms | Max: 62.84ms
  • Memory (RSS)               : Baseline: 99.9 MB | Peak: 131.2 MB | Cooldown: 102.6 MB

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
|        1000 |    6.5 ms |            153,014 |     2.84 |     4.09 |     5.06 |       5.20 |     5.20 |
|        5000 |   20.0 ms |            249,859 |     9.57 |    13.16 |    13.77 |      13.79 |    13.79 |
|       10000 |   39.2 ms |            255,247 |    20.85 |    30.19 |    30.76 |      30.77 |    30.77 |
|       25000 |   89.8 ms |            278,353 |    39.66 |    67.75 |    69.58 |      70.45 |    70.47 |
|       50000 |  148.2 ms |            337,280 |    74.99 |   111.34 |   120.66 |     120.79 |   120.83 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.8 ms |             92,250 |     5.65 |     7.95 |     9.18 |       9.28 |     9.28 |
|        5000 |   41.4 ms |            120,829 |    18.58 |    28.49 |    31.49 |      31.54 |    31.55 |
|       10000 |   74.9 ms |            133,553 |    39.10 |    62.37 |    65.35 |      65.42 |    65.42 |
|       25000 |  235.1 ms |            106,349 |   106.34 |   195.11 |   209.74 |     210.22 |   210.25 |
|       50000 |  462.9 ms |            108,024 |   208.48 |   384.47 |   428.32 |     429.49 |   429.56 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   23.7 ms |             42,188 |    12.40 |    20.36 |    22.41 |      22.82 |    22.82 |
|        5000 |   97.1 ms |             51,476 |    50.57 |    84.91 |    92.54 |      93.46 |    93.56 |
|       10000 |  191.6 ms |             52,183 |    96.60 |   165.91 |   185.14 |     186.61 |   186.89 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 155.8 MB
  • Settled Cooldown RSS   : 102.5 MB (Clean GC release)

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
| Yatta     |      53,828 |     1.00x |     9% | 1.74ms | 3.36ms | 3.72ms |
| Raw Bun   |      65,551 |     1.22x |    20% | 1.36ms | 2.36ms | 2.81ms |
| Hono      |      63,403 |     1.18x |     7% | 1.54ms | 2.81ms | 3.14ms |
| Elysia    |      69,601 |     1.29x |    19% | 1.35ms | 2.56ms | 3.02ms |
| Express   |      21,922 |     0.41x |     6% | 4.25ms | 8.04ms | 10.44ms |
| Fastify   |      27,382 |     0.51x |     3% | 3.39ms | 6.65ms | 8.81ms |
| Koa       |      22,047 |     0.41x |    17% | 4.17ms | 8.08ms | 11.65ms |

  Yatta dispatch adds about 3.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
