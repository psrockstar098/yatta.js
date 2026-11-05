/**
 * Local text embeddings, loaded only when asked for.
 *
 * Nothing in this module runs at import time, and nothing here is
 * imported by the vector store until a text call actually needs an
 * embedder and no embedder was passed in code. No model is downloaded
 * at startup, at database open, or on any plain vector call.
 *
 * The runtime is a fixed package name, never an environment value: the
 * environment only names a model and a cache directory. The model value
 * is validated as a plain model id (letters, digits, dots, dashes,
 * underscores, slashes between segments — no `..`, no leading slash,
 * no backslash), so it can never become a path traversal or a module
 * specifier. The cache value is a directory, passed to the runtime as
 * data, never imported or executed.
 *
 * The runtime package itself is optional: it is not a Yatta dependency.
 * Without it, `createLocalEmbedder()` fails with install instructions
 * instead of a bare module-resolution error.
 */

import { YattaError } from "./db";
import type { VectorEmbedder } from "./vectors";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function readModelId(): string {
  const model = process.env.YATTA_EMBEDDING_MODEL;
  if (!model) {
    throw new YattaError(
      "YATTA_EMBEDDING_MODEL is not set. Set it to a local embedding model id, " +
        "or pass an embedder to searchText/upsertText instead.",
    );
  }
  if (model.length > 256 || !MODEL_ID.test(model) || model.split("/").includes("..")) {
    throw new YattaError(
      `Invalid YATTA_EMBEDDING_MODEL ${JSON.stringify(model)}. ` +
        `Expected a plain model id such as "vendor/model-name", with no "..", no leading slash, and no backslash.`,
    );
  }
  return model;
}

/**
 * Builds an embedder backed by a locally run embedding model, downloaded
 * once and cached by the runtime. The first call downloads the model;
 * later calls reuse the cache. Call it once and hand the result to
 * `db.vectors.setEmbedder()` to avoid re-reading the environment.
 */
export async function createLocalEmbedder(): Promise<VectorEmbedder> {
  const model = readModelId();
  const cacheDir = process.env.YATTA_EMBEDDING_CACHE_DIR;
  if (cacheDir !== undefined && cacheDir.includes("\0")) {
    throw new YattaError("YATTA_EMBEDDING_CACHE_DIR must not contain NUL bytes.");
  }

  // Fixed package name, loaded lazily. If the operator never installed
  // it, this is a plain explanation, not a crash at import time.
  // The package is optional and not a Yatta dependency, so it has no
  // resolvable types here; the suppression covers that, not a code error.
  let runtime: any;
  try {
    // @ts-ignore - optional dependency, intentionally not installed
    runtime = await import("@xenova/transformers");
  } catch {
    throw new YattaError(
      "Local embeddings need the optional \"@xenova/transformers\" package, which is not installed. " +
        "Install it, set YATTA_EMBEDDING_MODEL to a small embedding model, and retry. " +
        "Until then, pass an embedder in code or use search() with precomputed vectors.",
    );
  }

  if (cacheDir) {
    try {
      runtime.env.cacheDir = cacheDir;
    } catch {
      // A runtime that ignores cacheDir still works; the model just lands in its default cache.
    }
  }

  let extractor: any;
  try {
    extractor = await runtime.pipeline("feature-extraction", model);
  } catch (err) {
    throw new YattaError(
      `Could not load embedding model ${JSON.stringify(model)}: ${(err as Error).message}`,
    );
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const rows: unknown = typeof output?.tolist === "function" ? output.tolist() : output;
      if (!Array.isArray(rows)) {
        throw new YattaError("Embedding model returned a result that is not a list of vectors.");
      }
      // One text in gives a flat list from some runtimes; normalize to one row per text.
      const matrix: unknown[] = texts.length === 1 && typeof rows[0] === "number" ? [rows] : rows;
      if (matrix.length !== texts.length) {
        throw new YattaError(
          `Embedding model returned ${matrix.length} vectors for ${texts.length} texts.`,
        );
      }
      return matrix as number[][];
    },
  };
}
