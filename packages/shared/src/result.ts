export type Ok<T> = { readonly _tag: 'ok'; readonly value: T };
export type Err<E> = { readonly _tag: 'err'; readonly error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { _tag: 'ok', value };
}

export function err<E>(error: E): Err<E> {
  return { _tag: 'err', error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result._tag === 'ok';
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result._tag === 'err';
}
