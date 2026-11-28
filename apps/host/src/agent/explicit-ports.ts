/**
 * Port bags the Host hands to the desktop's shared factories, with every optional port written out.
 *
 * A shared factory can gain an optional port that the desktop binds and the Host does not; for many
 * of them "not bound" means "allowed" (main e322628568: canRecreateDirectory of the working
 * directory recovery). The type checker says nothing, so the Host falls behind silently.
 * `explicitPorts<T>()` takes a bag where each optional member of T must be present: bound for real,
 * or `undefined` with a comment saying why the Host need not bind it. A new optional port on the
 * desktop side then fails the Host's typecheck at every binding until someone decides. Required
 * members keep their own type (they do not start accepting `undefined`).
 */

type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;

/**
 * T with its optional members made required (still allowing `undefined` for those only). Mapped over
 * key unions, not `keyof T`, so the optional modifier is not carried over (a homomorphic `-?` would
 * also strip `undefined` from those members).
 */
export type Explicit<T> = { [K in RequiredKeys<T>]: T[K] } & { [K in OptionalKeys<T>]: T[K] | undefined };

/**
 * A port bag for T in which every optional port is written out; returned as T. `undefined` is
 * stripped from T first: a factory parameter with a default value has `X | undefined` as its type
 * (`Parameters<…>[0]`), and `keyof (X | undefined)` is empty, which would let any bag through.
 */
export function explicitPorts<T>(ports: Explicit<NonNullable<T>>): NonNullable<T> {
  return ports as NonNullable<T>;
}
