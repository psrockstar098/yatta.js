/**
 * Vector search for Yatta DB — store embeddings, search by similarity.
 *
 * Two backends, one API. Which one runs is decided lazily, on the first
 * vector call, never at database open and never at import time:
 *
 * - `sqlite-vec`: the operator installed a `vec0` extension binary where
 *   SQLite can find it (library search path), and Yatta loads it with the
 *   fixed name `vec0`. Vectors live in a vec0 virtual table, ranked by
 *   distance. This is the fast path at scale.
 * - `sqlite`: plain SQLite tables plus a cosine-similarity query built on
 *   `json_each`. Correct, no native binary needed, slower at scale because
 *   every search scans the whole collection. This is the default when no
 *   `vec0` binary is loadable.
 *
 * `YATTA_VECTORS_BACKEND` picks the mode: `auto` (default — try vec0,
 * fall back to plain SQLite), `sqlite-vec` (refuse to run without vec0,
 * instead of silently running slower), or `sqlite` (never attempt the
 * extension, for deterministic runs and tests). The value is a mode name,
 * never a path: extension loading accepts only the fixed name `vec0`, so
 * no caller or environment value can steer it at an arbitrary file.
 *
 * Embeddings are stored as given, and cosine similarity is computed from
 * the stored values plus a stored norm. The vec0 path stores a normalized
 * copy for distance ranking and converts distance back to cosine
 * (`cos = 1 - d^2 / 2` for unit vectors), so both backends return the same
 * score for the same data, up to float32 rounding in the vec0 table.
 *
 * Text embeddings are a separate, optional step (see vectors_embed.ts):
 * pass an embedder in code, or set one once with `setEmbedder()`. With
 * no embedder, `searchText`/`upsertText` refuse plainly instead of
 * inventing vectors. Image embeddings are not built in this round.
 */

import type { Database } from "bun:sqlite";
import { YattaError } from "./db";

/**
 * Minimal store surface a vector store needs. Any YattaDB instance (or its
 * transaction proxy) satisfies this, so vector writes inside
 * `db.transaction()` commit or roll back with the surrounding work.
 */
export interface VectorStoreDb {
  rawRun(sql: string, params?: any[]): { lastInsertRowid: number; changes: number };
  rawAll<R = any>(sql: string, params?: any[]): R[];
  rawGet<R = any>(sql: string, params?: any[]): R | null;
  readonly sqlite: Database;
}

/** Which storage engine a collection actually uses. */
export type VectorBackend = "sqlite-vec" | "sqlite";

/** Mode selected by `YATTA_VECTORS_BACKEND`. */
export type VectorBackendMode = "auto" | "sqlite-vec" | "sqlite";

/** One stored vector, as returned by `get` and `search`. */
export interface VectorRecord {
  /** Caller-chosen id, unique inside its collection. */
  id: string;
  /** The embedding exactly as stored. */
  embedding: number[];
  /** Caller metadata, or null when none was stored. */
  metadata: unknown;
}

/** One ranked search hit. `score` is cosine similarity: 1 is identical. */
export interface VectorSearchHit {
  id: string;
  /** Cosine similarity in [-1, 1]. Higher is more similar. */
  score: number;
  metadata: unknown;
  /** Only present when `includeEmbedding` was requested. */
  embedding?: number[];
}

/** Options for `search`. */
export interface VectorSearchOptions {
  /** Max hits to return. Defaults to 10. */
  limit?: number;
  /** Only return hits at or above this cosine similarity (-1 to 1). */
  threshold?: number;
  /** Also return each hit's stored embedding. Defaults to false. */
  includeEmbedding?: boolean;
}

/** Options for `searchText` and `upsertText`. */
export interface VectorTextOptions {
  /** Embedder for this call. Overrides the store default for one call. */
  embedder?: VectorEmbedder;
}

/**
 * Something that turns text into embeddings. Bring your own, or use
 * `createLocalEmbedder()` from vectors_embed.ts. The interface is the
 * whole contract: tests use a small deterministic embedder behind it,
 * production uses a real model behind it, and the store cannot tell.
 */
export interface VectorEmbedder {
  /**
   * Embedding width, when known before the first call. Omitted means the
   * width is whatever the first `embed` call returns.
   */
  readonly dimensions?: number;
  /** Embeds each text, in order. Returns one vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

/** One collection: a name, its width, and the backend that stores it. */
export interface VectorCollectionInfo {
  name: string;
  dimensions: number;
  backend: VectorBackend;
}

export const VECTOR_REGISTRY_TABLE = "_yatta_vector_collections";
const MAX_DIMENSIONS = 4096;
const MAX_ID_LENGTH = 512;
const MAX_LIMIT = 1000;
const COLLECTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** The only extension name ever passed to loadExtension. Fixed, not configurable. */
const VEC_EXTENSION_NAME = "vec0";

function vectorTableName(collection: string): string {
  return `_vec_${collection}`;
}

function vectorMetaTableName(collection: string): string {
  return `_vec_${collection}_meta`;
}

function validateCollectionName(name: unknown): string {
  if (typeof name !== "string" || !COLLECTION_NAME.test(name)) {
    throw new YattaError(
      `Invalid vector collection name ${JSON.stringify(name)}. ` +
        `Use letters, digits and underscores, starting with a letter or underscore.`,
    );
  }
  return name;
}

function validateId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new YattaError(
      `Invalid vector id: ids must be non-empty strings of at most ${MAX_ID_LENGTH} characters.`,
    );
  }
  return id;
}

function validateDimensions(dimensions: unknown): number {
  if (
    typeof dimensions !== "number" ||
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > MAX_DIMENSIONS
  ) {
    throw new YattaError(
      `Invalid vector dimensions ${JSON.stringify(dimensions)}. ` +
        `Expected an integer between 1 and ${MAX_DIMENSIONS}.`,
    );
  }
  return dimensions;
}

function validateEmbedding(embedding: unknown, expected?: number): number[] {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new YattaError("Embedding must be a non-empty array of numbers.");
  }
  if (embedding.length > MAX_DIMENSIONS) {
    throw new YattaError(
      `Embedding has ${embedding.length} dimensions, over the ${MAX_DIMENSIONS} limit.`,
    );
  }
  for (const value of embedding) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new YattaError("Embedding values must all be finite numbers.");
    }
  }
  if (expected !== undefined && embedding.length !== expected) {
    throw new YattaError(
      `Embedding has ${embedding.length} dimensions, but this collection holds ${expected}.`,
    );
  }
  return embedding as number[];
}

function validateLimit(limit: unknown): number {
  if (limit === undefined) return 10;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new YattaError(`Invalid search limit ${JSON.stringify(limit)}. Expected an integer between 1 and ${MAX_LIMIT}.`);
  }
  return limit;
}

function validateThreshold(threshold: unknown): number | null {
  if (threshold === undefined) return null;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new YattaError(`Invalid search threshold ${JSON.stringify(threshold)}. Expected a number between -1 and 1.`);
  }
  return threshold;
}

function normOf(embedding: number[]): number {
  let sum = 0;
  for (const value of embedding) sum += value * value;
  return Math.sqrt(sum);
}

function normalize(embedding: number[]): number[] {
  const norm = normOf(embedding);
  if (norm === 0) {
    throw new YattaError("Zero vectors have no cosine similarity: every component is 0.");
  }
  return embedding.map((value) => value / norm);
}

function clampScore(score: number): number {
  if (score > 1) return 1;
  if (score < -1) return -1;
  return score;
}

function encodeMetadata(metadata: unknown): string | null {
  if (metadata === undefined) return null;
  try {
    const encoded = JSON.stringify(metadata);
    if (encoded === undefined) {
      throw new YattaError("Vector metadata must be JSON-serializable.");
    }
    return encoded;
  } catch (err) {
    if (err instanceof YattaError) throw err;
    throw new YattaError(`Vector metadata must be JSON-serializable: ${(err as Error).message}`);
  }
}

function decodeMetadata(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Rows written by hand, not by upsert, keep their text rather than failing the search.
    return raw;
  }
}

function decodeEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as number[];
    } catch {
      // Fall through to the error below.
    }
  }
  throw new YattaError("Stored embedding is not a JSON array of numbers.");
}

function readBackendMode(): VectorBackendMode {
  const raw = process.env.YATTA_VECTORS_BACKEND;
  if (raw === undefined || raw === "") return "auto";
  if (raw === "auto" || raw === "sqlite-vec" || raw === "sqlite") return raw;
  throw new YattaError(
    `Invalid YATTA_VECTORS_BACKEND ${JSON.stringify(raw)}. ` +
      `Expected "auto", "sqlite-vec", or "sqlite".`,
  );
}

/**
 * Vector search over one database file.
 *
 * Get it from `db.vectors` — the store is created lazily on first access,
 * and no extension is loaded and no table created until the first vector
 * call. A database that never touches vectors pays nothing for them.
 */
export class VectorStore {
  private readonly db: VectorStoreDb;
  private defaultEmbedder: VectorEmbedder | null = null;
  private cachedEmbedder: VectorEmbedder | null = null;
  /** Backend resolved for the current connection, or null before first use. */
  private resolvedBackend: VectorBackend | null = null;
  /** The connection the cached backend was resolved for. A restore swaps it. */
  private resolvedFor: unknown = null;

  constructor(db: VectorStoreDb) {
    this.db = db;
  }

  /**
   * The backend this process resolved for new collections, or
   * `"undecided"` before anything needed a resolution. Reading it does
   * not trigger a load: laziness is observable, not just promised.
   * Note that reads and writes to an existing plain-SQLite collection
   * deliberately do not resolve anything — they are served by SQL
   * whether or not vec0 is installed — so the store can stay undecided
   * after real SQL-backed use. Creating a collection, or touching a
   * vec-backed one, is what resolves it.
   */
  get backend(): VectorBackend | "undecided" {
    if (this.resolvedBackend !== null && this.resolvedFor === this.db.sqlite) {
      return this.resolvedBackend;
    }
    return "undecided";
  }

  /** Sets the default embedder for `searchText`/`upsertText`. Pass null to clear it. */
  setEmbedder(embedder: VectorEmbedder | null): void {
    if (embedder !== null && typeof embedder.embed !== "function") {
      throw new YattaError("Embedder must provide an embed(texts) function.");
    }
    this.defaultEmbedder = embedder;
  }

  /**
   * Creates a collection, or checks an existing one. A dimension mismatch
   * throws rather than silently reinterpreting stored vectors, and a
   * collection created under the other backend throws rather than being
   * read through the wrong engine (a vec0 table is unreadable without the
   * extension, so a quiet fallback would return wrong results, not slow ones).
   */
  ensureCollection(name: string, dimensions: number): VectorCollectionInfo {
    const collection = validateCollectionName(name);
    const width = validateDimensions(dimensions);
    const backend = this.resolveBackend();
    this.ensureRegistryTable();
    const existing = this.readCollection(collection);
    if (existing) {
      if (existing.dimensions !== width) {
        throw new YattaError(
          `Vector collection "${collection}" already holds ${existing.dimensions}-dimensional vectors, ` +
            `not ${width}. Create a new collection for a different width.`,
        );
      }
      if (existing.backend !== backend) {
        throw new YattaError(
          `Vector collection "${collection}" was created with backend "${existing.backend}", ` +
            `but this process resolved "${backend}". Load the vec0 extension or set ` +
            `YATTA_VECTORS_BACKEND to match the collection's backend.`,
        );
      }
      return existing;
    }
    // Data tables first, registry row last: a failure mid-create leaves
    // unregistered tables that the next call recreates, never a registry
    // row pointing at tables that do not exist.
    if (backend === "sqlite-vec") {
      const table = vectorTableName(collection);
      const meta = vectorMetaTableName(collection);
      this.db.rawRun(
        `CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING vec0(embedding float[${width}]);`,
      );
      this.db.rawRun(
        `CREATE TABLE IF NOT EXISTS "${meta}" (` +
          `rowid INTEGER PRIMARY KEY AUTOINCREMENT, ` +
          `id TEXT NOT NULL UNIQUE, embedding TEXT NOT NULL, metadata TEXT);`,
      );
    } else {
      const table = vectorTableName(collection);
      this.db.rawRun(
        `CREATE TABLE IF NOT EXISTS "${table}" (` +
          `id TEXT PRIMARY KEY, embedding TEXT NOT NULL, norm REAL NOT NULL, metadata TEXT);`,
      );
    }
    this.db.rawRun(
      `INSERT INTO "${VECTOR_REGISTRY_TABLE}" (name, dimensions, backend) VALUES (?, ?, ?);`,
      [collection, width, backend],
    );
    return { name: collection, dimensions: width, backend };
  }

  /** All collections in this file, in name order. */
  listCollections(): VectorCollectionInfo[] {
    this.ensureRegistryTable();
    const rows = this.db.rawAll<{ name: string; dimensions: number; backend: string }>(
      `SELECT name, dimensions, backend FROM "${VECTOR_REGISTRY_TABLE}" ORDER BY name ASC;`,
    );
    return rows.map((row) => ({
      name: row.name,
      dimensions: row.dimensions,
      backend: row.backend as VectorBackend,
    }));
  }

  /**
   * Stores a vector, replacing any previous vector with the same id in
   * the same collection. A first write to an unknown collection creates
   * it at the embedding's width.
   */
  upsert(
    collection: string,
    input: { id: string; embedding: number[]; metadata?: unknown },
  ): VectorRecord {
    const name = validateCollectionName(collection);
    const id = validateId(input?.id);
    const embedding = validateEmbedding(input?.embedding);
    const metadata = encodeMetadata(input?.metadata);
    const info = this.ensureCollectionForWrite(name, embedding.length);
    const stored = validateEmbedding(embedding, info.dimensions);
    const norm = normOf(stored);
    if (norm === 0) {
      throw new YattaError("Zero vectors have no cosine similarity: every component is 0.");
    }
    const rawJson = JSON.stringify(stored);
    if (info.backend === "sqlite-vec") {
      const table = vectorTableName(name);
      const meta = vectorMetaTableName(name);
      const existing = this.db.rawGet<{ rowid: number }>(
        `SELECT rowid FROM "${meta}" WHERE id = ? LIMIT 1;`,
        [id],
      );
      const normalizedJson = JSON.stringify(normalize(stored));
      if (existing) {
        this.db.rawRun(`UPDATE "${table}" SET embedding = ? WHERE rowid = ?;`, [
          normalizedJson,
          existing.rowid,
        ]);
        this.db.rawRun(`UPDATE "${meta}" SET embedding = ?, metadata = ? WHERE rowid = ?;`, [
          rawJson,
          metadata,
          existing.rowid,
        ]);
      } else {
        const inserted = this.db.rawRun(
          `INSERT INTO "${meta}" (id, embedding, metadata) VALUES (?, ?, ?);`,
          [id, rawJson, metadata],
        );
        this.db.rawRun(`INSERT INTO "${table}" (rowid, embedding) VALUES (?, ?);`, [
          inserted.lastInsertRowid,
          normalizedJson,
        ]);
      }
    } else {
      const table = vectorTableName(name);
      this.db.rawRun(
        `INSERT INTO "${table}" (id, embedding, norm, metadata) VALUES (?, ?, ?, ?) ` +
          `ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding, norm = excluded.norm, metadata = excluded.metadata;`,
        [id, rawJson, norm, metadata],
      );
    }
    return { id, embedding: stored, metadata: input?.metadata ?? null };
  }

  /** One stored vector by id, or null. Throws for an unknown collection. */
  get(collection: string, id: string): VectorRecord | null {
    const name = validateCollectionName(collection);
    const key = validateId(id);
    const info = this.requireCollection(name);
    if (info.backend === "sqlite-vec") {
      const meta = vectorMetaTableName(name);
      const row = this.db.rawGet<{ id: string; embedding: string; metadata: string | null }>(
        `SELECT id, embedding, metadata FROM "${meta}" WHERE id = ? LIMIT 1;`,
        [key],
      );
      if (!row) return null;
      return { id: row.id, embedding: decodeEmbedding(row.embedding), metadata: decodeMetadata(row.metadata) };
    }
    const table = vectorTableName(name);
    const row = this.db.rawGet<{ id: string; embedding: string; metadata: string | null }>(
      `SELECT id, embedding, metadata FROM "${table}" WHERE id = ? LIMIT 1;`,
      [key],
    );
    if (!row) return null;
    return { id: row.id, embedding: decodeEmbedding(row.embedding), metadata: decodeMetadata(row.metadata) };
  }

  /** Removes one vector. Returns true when a row was actually removed. */
  remove(collection: string, id: string): boolean {
    const name = validateCollectionName(collection);
    const key = validateId(id);
    const info = this.requireCollection(name);
    if (info.backend === "sqlite-vec") {
      const table = vectorTableName(name);
      const meta = vectorMetaTableName(name);
      const existing = this.db.rawGet<{ rowid: number }>(
        `SELECT rowid FROM "${meta}" WHERE id = ? LIMIT 1;`,
        [key],
      );
      if (!existing) return false;
      this.db.rawRun(`DELETE FROM "${table}" WHERE rowid = ?;`, [existing.rowid]);
      this.db.rawRun(`DELETE FROM "${meta}" WHERE rowid = ?;`, [existing.rowid]);
      return true;
    }
    const table = vectorTableName(name);
    const result = this.db.rawRun(`DELETE FROM "${table}" WHERE id = ?;`, [key]);
    return result.changes > 0;
  }

  /** How many vectors a collection holds. Throws for an unknown collection. */
  count(collection: string): number {
    const name = validateCollectionName(collection);
    const info = this.requireCollection(name);
    const table = info.backend === "sqlite-vec" ? vectorMetaTableName(name) : vectorTableName(name);
    const row = this.db.rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}";`);
    return row?.n ?? 0;
  }

  /** Drops a collection and its vectors. Returns false when it did not exist. */
  dropCollection(collection: string): boolean {
    const name = validateCollectionName(collection);
    // Resolving the backend here is intentional: dropping must not load an
    // extension into a process that never used vectors, but a vec0 table
    // cannot be dropped without the extension loaded, so a vec-backed
    // collection in a vec-less process throws instead of half-dropping.
    const info = this.readCollectionAfterRegistry(name);
    if (!info) return false;
    if (info.backend === "sqlite-vec") {
      this.resolveBackend();
      if (this.resolvedBackend !== "sqlite-vec") {
        throw new YattaError(
          `Vector collection "${name}" is stored with sqlite-vec, but vec0 is not loaded in this process, ` +
            `so its virtual table cannot be dropped. Install vec0 or open the file where it is available.`,
        );
      }
      this.db.rawRun(`DROP TABLE IF EXISTS "${vectorTableName(name)}";`);
      this.db.rawRun(`DROP TABLE IF EXISTS "${vectorMetaTableName(name)}";`);
    } else {
      this.db.rawRun(`DROP TABLE IF EXISTS "${vectorTableName(name)}";`);
    }
    this.db.rawRun(`DELETE FROM "${VECTOR_REGISTRY_TABLE}" WHERE name = ?;`, [name]);
    return true;
  }

  /**
   * Ranked cosine-similarity search. The query is always a bound parameter
   * (JSON text for both backends); only the `k`/`LIMIT` counts — validated
   * integers from this method, never caller text — are interpolated, because
   * vec0's `k` does not accept a bound parameter in every build.
   */
  search(
    collection: string,
    query: number[],
    options: VectorSearchOptions = {},
  ): VectorSearchHit[] {
    const name = validateCollectionName(collection);
    const info = this.requireCollection(name);
    const vector = validateEmbedding(query, info.dimensions);
    const limit = validateLimit(options.limit);
    const threshold = validateThreshold(options.threshold);
    const queryNorm = normOf(vector);
    if (queryNorm === 0) {
      throw new YattaError("Zero query vectors have no cosine similarity: every component is 0.");
    }

    if (info.backend === "sqlite-vec") {
      return this.searchVec(name, vector, limit, threshold, options.includeEmbedding === true);
    }
    return this.searchSql(name, vector, queryNorm, limit, threshold, options.includeEmbedding === true);
  }

  /** Embeds text and searches. Needs an embedder: per-call, store default, or the local model (see below). */
  async searchText(
    collection: string,
    text: string,
    options: VectorSearchOptions & VectorTextOptions = {},
  ): Promise<VectorSearchHit[]> {
    const query = await this.embedOne(text, options.embedder);
    return this.search(collection, query, options);
  }

  /** Embeds text and stores it under `id`. Creates the collection on first write. */
  async upsertText(
    collection: string,
    input: { id: string; text: string; metadata?: unknown },
    options: VectorTextOptions = {},
  ): Promise<VectorRecord> {
    if (typeof input?.text !== "string" || input.text.length === 0) {
      throw new YattaError("upsertText needs a non-empty text string.");
    }
    const embedding = await this.embedOne(input.text, options.embedder);
    return this.upsert(collection, { id: input.id, embedding, metadata: input.metadata });
  }

  /** Embeds texts with the resolved embedder. Throws when none is configured. */
  async embedText(texts: string[], embedder?: VectorEmbedder): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string")) {
      throw new YattaError("embedText needs an array of strings.");
    }
    const resolved = await this.resolveEmbedder(embedder);
    const vectors = await resolved.embed(texts);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new YattaError(
        `Embedder returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${texts.length} texts.`,
      );
    }
    return vectors.map((vector, i) => {
      try {
        return validateEmbedding(vector);
      } catch (err) {
        throw new YattaError(`Embedder returned an invalid vector for text ${i}: ${(err as Error).message}`);
      }
    });
  }

  private searchSql(
    name: string,
    vector: number[],
    queryNorm: number,
    limit: number,
    threshold: number | null,
    includeEmbedding: boolean,
  ): VectorSearchHit[] {
    const table = vectorTableName(name);
    const extra = includeEmbedding ? `, embedding` : ``;
    // Cosine via json_each: the query and each stored vector are JSON
    // arrays, so joining on the array index pairs matching components and
    // SUM gives the dot product. Stored norms are precomputed at write.
    const rows = this.db.rawAll<{ id: string; metadata: string | null; score: number; embedding?: string }>(
      `SELECT id, metadata, score${extra} FROM (` +
        `SELECT id, metadata, embedding, ` +
        `(SELECT COALESCE(SUM(q.value * v.value), 0) FROM json_each(?) AS q ` +
        `JOIN json_each(embedding) AS v ON q.key = v.key) / (? * norm) AS score ` +
        `FROM "${table}") ` +
        `WHERE ? IS NULL OR score >= ? ` +
        `ORDER BY score DESC, id ASC LIMIT ${limit};`,
      [JSON.stringify(vector), queryNorm, threshold, threshold],
    );
    return rows.map((row) => ({
      id: row.id,
      score: clampScore(row.score),
      metadata: decodeMetadata(row.metadata),
      ...(includeEmbedding && row.embedding !== undefined
        ? { embedding: decodeEmbedding(row.embedding) }
        : {}),
    }));
  }

  private searchVec(
    name: string,
    vector: number[],
    limit: number,
    threshold: number | null,
    includeEmbedding: boolean,
  ): VectorSearchHit[] {
    const table = vectorTableName(name);
    const meta = vectorMetaTableName(name);
    // With a threshold, k must cover the whole collection: vec0 returns
    // only the k nearest, so a thresholded search over k = limit could
    // drop qualifying rows sitting past the cutoff. Without one, k = limit
    // is exactly the rows returned.
    const k = threshold === null ? limit : this.count(name);
    if (k === 0) return [];
    const rows = this.db.rawAll<{ id: string; metadata: string | null; score: number; embedding?: string }>(
      `SELECT m.id AS id, m.metadata AS metadata, ` +
        `(1 - (v.distance * v.distance) / 2) AS score` +
        `${includeEmbedding ? `, m.embedding AS embedding` : ``} ` +
        `FROM "${table}" AS v JOIN "${meta}" AS m ON m.rowid = v.rowid ` +
        `WHERE v.embedding MATCH ? AND k = ${k} ` +
        `ORDER BY score DESC, m.id ASC;`,
      [JSON.stringify(normalize(vector))],
    );
    const hits = rows.map((row) => ({
      id: row.id,
      score: clampScore(row.score),
      metadata: decodeMetadata(row.metadata),
      ...(includeEmbedding && row.embedding !== undefined
        ? { embedding: decodeEmbedding(row.embedding) }
        : {}),
    }));
    const filtered = threshold === null ? hits : hits.filter((hit) => hit.score >= threshold);
    return filtered.slice(0, limit);
  }

  private async embedOne(text: string, embedder?: VectorEmbedder): Promise<number[]> {
    if (typeof text !== "string" || text.length === 0) {
      throw new YattaError("Text embedding needs a non-empty string.");
    }
    const vectors = await this.embedText([text], embedder);
    return vectors[0];
  }

  private async resolveEmbedder(embedder?: VectorEmbedder): Promise<VectorEmbedder> {
    if (embedder) {
      if (typeof embedder.embed !== "function") {
        throw new YattaError("Embedder must provide an embed(texts) function.");
      }
      return embedder;
    }
    if (this.defaultEmbedder) return this.defaultEmbedder;
    if (this.cachedEmbedder) return this.cachedEmbedder;
    // Only reached when the operator opted into a local model by setting
    // YATTA_EMBEDDING_MODEL. With no model configured, this refuses rather
    // than downloading a model nobody asked for. The embedder module is
    // imported lazily, so merely using vectors never loads it.
    if (process.env.YATTA_EMBEDDING_MODEL) {
      const { createLocalEmbedder } = await import("./vectors_embed");
      this.cachedEmbedder = await createLocalEmbedder();
      return this.cachedEmbedder;
    }
    throw new YattaError(
      "No embedder configured for text vectors. Pass an embedder to searchText/upsertText, " +
        "call db.vectors.setEmbedder(embedder), or set YATTA_EMBEDDING_MODEL to a local model " +
        "and install the optional runtime it needs (see docs/roadmap-14/vectors.md).",
    );
  }

  private ensureRegistryTable(): void {
    this.db.rawRun(
      `CREATE TABLE IF NOT EXISTS "${VECTOR_REGISTRY_TABLE}" (` +
        `name TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, backend TEXT NOT NULL);`,
    );
  }

  private readCollection(name: string): VectorCollectionInfo | null {
    const row = this.db.rawGet<{ name: string; dimensions: number; backend: string }>(
      `SELECT name, dimensions, backend FROM "${VECTOR_REGISTRY_TABLE}" WHERE name = ? LIMIT 1;`,
      [name],
    );
    if (!row) return null;
    return { name: row.name, dimensions: row.dimensions, backend: row.backend as VectorBackend };
  }

  private readCollectionAfterRegistry(name: string): VectorCollectionInfo | null {
    this.ensureRegistryTable();
    return this.readCollection(name);
  }

  private requireCollection(name: string): VectorCollectionInfo {
    // Reads, not writes, must not resolve a backend: a plain-SQLite file
    // opened where vec0 happens to be installed must still read its
    // collections without loading anything, and a vec-backed collection
    // must fail on its own terms below, not at backend resolution.
    const info = this.readCollectionAfterRegistry(name);
    if (!info) {
      throw new YattaError(
        `Unknown vector collection "${name}". Create it with db.vectors.ensureCollection("${name}", dimensions) ` +
          `or write to it once with upsert/upsertText.`,
      );
    }
    if (info.backend === "sqlite-vec") {
      // A vec0 virtual table cannot even be queried without the extension.
      // Resolve (and load) it here so the failure names vec0, not SQLite.
      const backend = this.resolveBackend();
      if (backend !== "sqlite-vec") {
        throw new YattaError(
          `Vector collection "${name}" is stored with sqlite-vec, but vec0 is not loaded in this process. ` +
            `Install vec0 where SQLite can find it, or set YATTA_VECTORS_BACKEND=sqlite-vec to see the load error.`,
        );
      }
    }
    return info;
  }

  private ensureCollectionForWrite(name: string, dimensions: number): VectorCollectionInfo {
    const existing = this.readCollectionAfterRegistry(name);
    if (existing) {
      if (existing.dimensions !== dimensions) {
        throw new YattaError(
          `Vector collection "${name}" already holds ${existing.dimensions}-dimensional vectors, ` +
            `not ${dimensions}.`,
        );
      }
      if (existing.backend === "sqlite-vec") {
        const backend = this.resolveBackend();
        if (backend !== "sqlite-vec") {
          throw new YattaError(
            `Vector collection "${name}" is stored with sqlite-vec, but vec0 is not loaded in this process.`,
          );
        }
      }
      return existing;
    }
    return this.ensureCollection(name, dimensions);
  }

  /**
   * Resolves the backend for the current connection, loading vec0 at most
   * once per connection. The extension name is a fixed literal: no
   * environment value, option, or caller argument reaches loadExtension.
   */
  private resolveBackend(): VectorBackend {
    if (this.resolvedBackend !== null && this.resolvedFor === this.db.sqlite) {
      return this.resolvedBackend;
    }
    const mode = readBackendMode();
    this.resolvedFor = this.db.sqlite;
    if (mode === "sqlite") {
      this.resolvedBackend = "sqlite";
      return "sqlite";
    }
    try {
      this.db.sqlite.loadExtension(VEC_EXTENSION_NAME);
      // Loading a library named vec0 is not proof it is sqlite-vec: check
      // the function only sqlite-vec provides before trusting the backend.
      const version = this.db.rawGet<{ v: string }>(`SELECT vec_version() AS v;`);
      if (!version || typeof version.v !== "string") throw new Error("vec_version() did not return a version");
      this.resolvedBackend = "sqlite-vec";
      return "sqlite-vec";
    } catch (err) {
      if (mode === "sqlite-vec") {
        throw new YattaError(
          `YATTA_VECTORS_BACKEND=sqlite-vec, but the vec0 extension could not be loaded: ` +
            `${(err as Error).message}. Install a vec0 binary where SQLite can find it, ` +
            `or use YATTA_VECTORS_BACKEND=auto for the plain-SQLite fallback.`,
        );
      }
      this.resolvedBackend = "sqlite";
      return "sqlite";
    }
  }
}
