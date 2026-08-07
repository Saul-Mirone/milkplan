/**
 * Deep-readonly mapped type — used to satisfy
 * typescript/prefer-readonly-parameter-types on parameters that receive domain
 * data they must not mutate, without having to annotate every nested member.
 *
 * Functions are passed through untouched (they are already "readonly" values);
 * arrays and objects are made recursively readonly.
 */
export type DeepReadonly<T> = T extends (...args: readonly never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T
