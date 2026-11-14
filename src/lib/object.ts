/**
 * Drops keys whose value is undefined. Validated input marks fields the client
 * didn't send as undefined, but Prisma (with exactOptionalPropertyTypes) wants
 * them absent, not undefined. null is kept: it means "clear this field".
 */
export function withoutUndefined<T extends object>(obj: T) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
