// Standard Schema, declared locally.
//
// The interface is three properties, and declaring it here means a project can use
// zod, valibot, arktype or anything else without this package depending on any of
// them. A validator is anything carrying `~standard`.

export interface StandardSchemaV1<Output = unknown, Input = Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    /** Present in the spec, and the only reliable source of the output type. */
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/**
 * One thing wrong with a value.
 *
 * Deliberately minimal, with no index signature.
 *
 * A signature like `[key: string]: unknown` looks like it accepts every validator's
 * issue, and it does the opposite: it requires the *issue's* type to have an index
 * signature, which an `interface` does not get implicitly. zod's `Issue` then failed
 * to be assignable and every zod schema was rejected as "not a validator".
 *
 * Extra fields the validator provides — `code`, `expected`, `minimum` — are still
 * there at runtime. A caller that wants one reads it off the issue directly; this
 * type says what is guaranteed, not what is present.
 */
export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[]; readonly value?: undefined };

/**
 * Whether a value is a Standard Schema validator.
 *
 * `function` is accepted as well as `object`, because that is what some validators
 * are: an arktype type is a callable that carries `~standard`. Checking only for
 * `typeof value === "object"` rejected every arktype schema, which broke the
 * documented claim that any conforming library works.
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1<unknown, unknown> {
  if (value === null) return false;

  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return false;

  const candidate = (value as { ["~standard"]?: unknown })["~standard"];
  if (candidate === null || typeof candidate !== "object") return false;

  return typeof (candidate as { validate?: unknown }).validate === "function";
}

/**
 * The output type a validator produces.
 *
 * `types.output` is preferred, and structural inference from `validate` is the
 * fallback.
 *
 * The order matters. `validate` is declared with sync and async overloads by most
 * libraries, and `infer R` on an overloaded function resolves to the *last* one
 * only — so for an async-capable validator the inference picked the promise arm and
 * every output came back as a promise-wrapped type. `types.output` is declared once
 * and does not have that problem.
 */
/**
 * The output type a validator produces.
 *
 * `types.output` is preferred, and structural inference from `validate` is the
 * fallback. Two reasons for that order:
 *
 *  1. `validate` is declared with sync and async overloads by most libraries, and
 *     `infer R` on an overloaded function resolves to the *last* one only — so for
 *     an async-capable validator the inference picked the promise arm and every
 *     output came back promise-wrapped.
 *  2. `types` is optional in the spec, so it must be read through a helper rather
 *     than inferred directly. Inferring from `types?: { output: infer O }`
 *     resolves `O` to `undefined` — from the `| undefined` member — and every
 *     output then becomes `undefined`.
 */
export type Infer<S> = S extends { "~standard": { types?: infer T } }
  ? [DeclaredOutput<T>] extends [never]
    ? InferStructurally<S>
    : DeclaredOutput<T>
  : InferStructurally<S>;

/**
 * The `output` a validator declares, or `never` when it declares none.
 *
 * `never` rather than `unknown` so "absent" is distinguishable from "present and
 * unknown", which is what decides whether the structural fallback runs.
 */
type DeclaredOutput<T> = T extends { output: infer O }
  ? [O] extends [undefined]
    ? never
    : O
  : never;

/** The fallback, for a validator that does not declare `types`. */
type InferStructurally<S> = S extends { "~standard": { validate: (value: unknown) => infer R } }
  ? UnwrapPromise<R> extends { value: infer V }
    ? V
    : never
  : never;

type UnwrapPromise<R> = R extends Promise<infer P> ? P : R;

/** A one-line readable path for a validation issue, e.g. "body.user.email". */
export function formatIssuePath(prefix: string, issue: StandardIssue): string {
  if (!issue.path || issue.path.length === 0) return prefix;

  const segments = issue.path.map((segment) => {
    const key = typeof segment === "object" && segment !== null ? segment.key : segment;
    return String(key);
  });

  return `${prefix}.${segments.join(".")}`;
}

/**
 * A validation failure, carrying every issue.
 *
 * A plain `Error` with one message loses the rest, and a caller that wants
 * field-level errors — to highlight inputs, or to send a form back — has nothing to
 * work from. Every issue is here, with its path.
 *
 * `status` is set to 400 so a transport can turn this into a response without
 * knowing it came from a validator. That is why `mount` no longer has to catch a
 * plain Error and re-wrap it, which it did by hand and could get wrong.
 */
export class ValidationError extends Error {
  readonly status = 400;
  readonly issues: readonly StandardIssue[];

  /** The issues grouped by path, for rendering next to a field. */
  readonly fields: Readonly<Record<string, string>>;

  constructor(prefix: string, issues: readonly StandardIssue[]) {
    const first = issues[0];
    const where = first ? formatIssuePath(prefix, first) : prefix;
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";

    super(`${where}: ${first?.message ?? "failed validation"}${more}`);

    this.name = "ValidationError";
    this.issues = issues;

    const fields: Record<string, string> = {};
    for (const issue of issues) fields[formatIssuePath(prefix, issue)] = issue.message;
    this.fields = fields;
  }
}

/**
 * Validates without throwing. Returns the value or the issues.
 *
 * Async, and only ever async. Whether `validate` returns a promise is the
 * validator's business — zod declares both a sync and an async overload — so a
 * synchronous wrapper could only lie about half of them. An earlier version had
 * both names, and the sync one returned a promise typed as a value.
 */
export async function safeValidate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  prefix = "value",
): Promise<{ ok: true; value: Infer<S> } | { ok: false; error: ValidationError }> {
  const result = await run(schema, value, prefix);

  if (result.ok) return result;

  return { ok: false, error: result.error };
}

/** Validates and throws a {@link ValidationError} on failure. */
export async function validateOrThrow<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  prefix = "value",
): Promise<Infer<S>> {
  const result = await safeValidate(schema, value, prefix);

  if (!result.ok) throw result.error;

  return result.value;
}

/**
 * Runs a validator, converting a failure into a {@link ValidationError}.
 *
 * The version is checked because the spec's version 1 is the whole contract: a
 * validator promising version 2 may have changed `validate`'s shape, and silently
 * accepting it would mean interpreting a result whose shape is not the one this
 * reads.
 */
async function run<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  prefix: string,
): Promise<{ ok: true; value: Infer<S> } | { ok: false; error: ValidationError }> {
  const version = schema["~standard"].version;

  if (version !== 1) {
    throw new Error(
      `Validator from "${schema["~standard"].vendor}" reports Standard Schema version ${String(version)}, ` +
        `and this reads version 1. A later version may return a different shape, so it is refused ` +
        `rather than misread.`,
    );
  }

  const result = await schema["~standard"].validate(value);

  // An empty issues array is a failure with nothing to say, so it is treated as
  // success — a validator returning `{ issues: [] }` meant "no problems".
  if (result.issues && result.issues.length > 0) {
    return { ok: false, error: new ValidationError(prefix, result.issues) };
  }

  return { ok: true, value: result.value as Infer<S> };
}