# Yatta Benchmarks

> Last run: `2026-11-27T14:34:01Z` · commit [`f397e4d`](https://github.com/psrockstar098/yatta.js/commit/f397e4d7f030fcb0e66049cb3d14c22cd337dfda) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 77.8 ms
  • End-to-End Runtime Task Cost    : 0.0263 ms/op
  • Peak RSS Memory        : 119.0 MB
  • RSS Heap Memory             : 98.38 MB
  • Raw Worker IPC Round-Trip      : 0.0180 ms/op
  • Scheduler + Graph Overhead     : 0.0083 ms/op
  • Settled Cooldown RSS   : 85.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.40 MB
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
| Yatta     |      63,194 |     1.00x |     7% | 1.40ms | 3.06ms | 3.74ms |
| Raw Bun   |      52,066 |     0.82x |    10% | 1.64ms | 3.57ms | 4.64ms |
| Hono      |      56,929 |     0.90x |     9% | 1.52ms | 3.38ms | 4.12ms |
| Elysia    |      52,351 |     0.83x |    21% | 1.65ms | 3.81ms | 4.91ms |
| Express   |      30,964 |     0.49x |    17% | 3.00ms | 6.04ms | 7.22ms |
| Fastify   |      39,667 |     0.63x |    10% | 2.27ms | 4.71ms | 6.23ms |
| Koa       |      34,958 |     0.55x |    25% | 2.72ms | 5.15ms | 6.80ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,778 |       0.25 |       0.26 |       0.26 |       0.26 |
|         100 |     0.7 ms |              141,184 |       0.48 |       0.55 |       0.56 |       0.56 |
|         500 |     1.5 ms |              324,044 |       0.97 |       1.26 |       1.31 |       1.32 |
|        1000 |     2.2 ms |              458,685 |       1.09 |       1.61 |       1.63 |       1.65 |
|        5000 |    16.4 ms |              305,705 |       7.79 |      11.35 |      11.49 |      11.54 |
|       10000 |    28.6 ms |              350,016 |      13.23 |      20.73 |      22.33 |      22.52 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    5.7 ms |            175,985 |     2.30 |     3.38 |     3.52 |       3.54 |     3.54 |
|        5000 |   16.4 ms |            303,964 |     6.63 |    10.75 |    12.83 |      12.84 |    12.84 |
|       10000 |   33.3 ms |            300,408 |    15.40 |    27.59 |    28.61 |      28.64 |    28.64 |
|       25000 |   75.9 ms |            329,180 |    41.15 |    57.84 |    59.53 |      59.61 |    59.62 |
|       50000 |  148.0 ms |            337,849 |    74.20 |   108.92 |   119.91 |     120.06 |   120.07 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.5 ms |            118,029 |     4.60 |     6.34 |     6.91 |       7.00 |     7.00 |
|        5000 |   36.8 ms |            136,022 |    18.45 |    29.23 |    29.98 |      30.01 |    30.01 |
|       10000 |   72.3 ms |            138,233 |    35.83 |    60.79 |    63.17 |      63.29 |    63.30 |
|       25000 |  175.9 ms |            142,141 |    90.25 |   148.10 |   162.55 |     162.87 |   162.89 |
|       50000 |  361.1 ms |            138,447 |   179.40 |   293.45 |   325.24 |     326.78 |   326.86 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   20.0 ms |             50,010 |    10.32 |    17.20 |    18.90 |      19.11 |    19.11 |
|        5000 |  108.5 ms |             46,065 |    60.83 |    93.66 |   105.31 |     106.74 |   107.01 |
|       10000 |  187.3 ms |             53,392 |    81.01 |   152.69 |   178.30 |     182.01 |   182.34 |

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
  • Raw Worker IPC Round-Trip      : 0.0180 ms/op
  • End-to-End Runtime Task Cost    : 0.0263 ms/op
  • Scheduler + Graph Overhead     : 0.0083 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,778 |       0.25 |       0.26 |       0.26 |       0.26 |
|         100 |     0.7 ms |              141,184 |       0.48 |       0.55 |       0.56 |       0.56 |
|         500 |     1.5 ms |              324,044 |       0.97 |       1.26 |       1.31 |       1.32 |
|        1000 |     2.2 ms |              458,685 |       1.09 |       1.61 |       1.63 |       1.65 |
|        5000 |    16.4 ms |              305,705 |       7.79 |      11.35 |      11.49 |      11.54 |
|       10000 |    28.6 ms |              350,016 |      13.23 |      20.73 |      22.33 |      22.52 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 98.38 MB
  • V8/JSC Heap Used             : 13.40 MB

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
| 1 CPU + 1 IO  |       2 |   34.6 ms |            289,188 |    16.81 |    25.41 |    25.76 |    26.13 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   34.6 ms |            289,345 |    16.89 |    25.80 |    26.18 |    26.20 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   32.7 ms |            305,878 |    16.09 |    25.52 |    25.95 |    26.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   31.6 ms |            316,577 |    16.03 |    25.98 |    26.25 |    26.27 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 77.8 ms
  • Peak Throughput Rate       : 321,530 ops/sec
  • Latency Distribution       : p50: 36.98ms | p90: 62.04ms | p99: 62.88ms | p99.9: 63.13ms | Max: 63.14ms
  • Memory (RSS)               : Baseline: 100.4 MB | Peak: 133.0 MB | Cooldown: 103.3 MB

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
|        1000 |    5.7 ms |            175,985 |     2.30 |     3.38 |     3.52 |       3.54 |     3.54 |
|        5000 |   16.4 ms |            303,964 |     6.63 |    10.75 |    12.83 |      12.84 |    12.84 |
|       10000 |   33.3 ms |            300,408 |    15.40 |    27.59 |    28.61 |      28.64 |    28.64 |
|       25000 |   75.9 ms |            329,180 |    41.15 |    57.84 |    59.53 |      59.61 |    59.62 |
|       50000 |  148.0 ms |            337,849 |    74.20 |   108.92 |   119.91 |     120.06 |   120.07 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.5 ms |            118,029 |     4.60 |     6.34 |     6.91 |       7.00 |     7.00 |
|        5000 |   36.8 ms |            136,022 |    18.45 |    29.23 |    29.98 |      30.01 |    30.01 |
|       10000 |   72.3 ms |            138,233 |    35.83 |    60.79 |    63.17 |      63.29 |    63.30 |
|       25000 |  175.9 ms |            142,141 |    90.25 |   148.10 |   162.55 |     162.87 |   162.89 |
|       50000 |  361.1 ms |            138,447 |   179.40 |   293.45 |   325.24 |     326.78 |   326.86 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   20.0 ms |             50,010 |    10.32 |    17.20 |    18.90 |      19.11 |    19.11 |
|        5000 |  108.5 ms |             46,065 |    60.83 |    93.66 |   105.31 |     106.74 |   107.01 |
|       10000 |  187.3 ms |             53,392 |    81.01 |   152.69 |   178.30 |     182.01 |   182.34 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 119.0 MB
  • Settled Cooldown RSS   : 85.1 MB (Clean GC release)

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
| Yatta     |      63,194 |     1.00x |     7% | 1.40ms | 3.06ms | 3.74ms |
| Raw Bun   |      52,066 |     0.82x |    10% | 1.64ms | 3.57ms | 4.64ms |
| Hono      |      56,929 |     0.90x |     9% | 1.52ms | 3.38ms | 4.12ms |
| Elysia    |      52,351 |     0.83x |    21% | 1.65ms | 3.81ms | 4.91ms |
| Express   |      30,964 |     0.49x |    17% | 3.00ms | 6.04ms | 7.22ms |
| Fastify   |      39,667 |     0.63x |    10% | 2.27ms | 4.71ms | 6.23ms |
| Koa       |      34,958 |     0.55x |    25% | 2.72ms | 5.15ms | 6.80ms |

  Yatta dispatch adds about -3.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
