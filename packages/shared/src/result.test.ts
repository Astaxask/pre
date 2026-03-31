import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr } from './result.js';
import type { Result } from './result.js';

describe('Result utilities', () => {
  it('ok() creates an Ok result', () => {
    const result = ok(42);
    expect(result._tag).toBe('ok');
    expect(result.value).toBe(42);
  });

  it('err() creates an Err result', () => {
    const result = err('something went wrong');
    expect(result._tag).toBe('err');
    expect(result.error).toBe('something went wrong');
  });

  it('isOk() identifies Ok results', () => {
    expect(isOk(ok('hello'))).toBe(true);
    expect(isOk(err('fail'))).toBe(false);
  });

  it('isErr() identifies Err results', () => {
    expect(isErr(err('fail'))).toBe(true);
    expect(isErr(ok('hello'))).toBe(false);
  });

  it('works with typed results', () => {
    const result: Result<number, string> = ok(10);

    if (isOk(result)) {
      // TypeScript narrows to Ok<number>
      expect(result.value).toBe(10);
    } else {
      throw new Error('Expected Ok');
    }
  });

  it('works with Error objects', () => {
    const result: Result<string, Error> = err(new Error('test error'));

    if (isErr(result)) {
      expect(result.error.message).toBe('test error');
    } else {
      throw new Error('Expected Err');
    }
  });
});
