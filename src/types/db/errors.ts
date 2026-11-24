// YattaDB error types.
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).
// YattaError has no `code` field: new YattaError(message, sql?).

/**
 * Base error class for YattaDB database operations.
 * Automatically formats and captures executed SQL statements for faster debugging.
 */
export class YattaError extends Error {
  /**
   * @param message Human-readable error description.
   * @param sql Optional SQL query string that caused the error.
   */
  constructor(message: string, public readonly sql?: string) {
    super(sql ? `${message}\n  SQL: ${sql}` : message);
    this.name = "YattaError";
  }
}
