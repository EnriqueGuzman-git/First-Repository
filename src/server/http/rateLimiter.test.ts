import { describe, expect, it } from 'vitest';

import { createFixedWindowLimiter } from './rateLimiter.js';

describe('fixed-window rate limiter', () => {
  it('allows up to `max` hits per key within a window', () => {
    const clock = 1_000;
    const limiter = createFixedWindowLimiter({ windowMs: 1_000, max: 3, now: () => clock });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);

    const blocked = limiter.check('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1_000);
  });

  it('tracks keys independently', () => {
    const clock = 0;
    const limiter = createFixedWindowLimiter({ windowMs: 1_000, max: 1, now: () => clock });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true); // different key, own budget
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('resets the counter once the window elapses', () => {
    let clock = 0;
    const limiter = createFixedWindowLimiter({ windowMs: 1_000, max: 1, now: () => clock });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);

    clock += 1_000; // window boundary reached
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('reports a shrinking retryAfterMs as the window drains', () => {
    let clock = 0;
    const limiter = createFixedWindowLimiter({ windowMs: 1_000, max: 1, now: () => clock });

    limiter.check('a'); // opens window at t=0
    clock = 400;
    expect(limiter.check('a').retryAfterMs).toBe(600);
  });

  it('prunes expired keys to bound memory', () => {
    let clock = 0;
    const limiter = createFixedWindowLimiter({
      windowMs: 1_000,
      max: 1,
      now: () => clock,
      pruneThreshold: 2,
    });

    limiter.check('a');
    limiter.check('b');
    expect(limiter.size).toBe(2);

    clock += 1_000; // both windows now expired
    limiter.check('c'); // size (2) > threshold (2) is false; grow to 3 first
    limiter.check('d'); // now size 3 > 2 → prune expired a & b before inserting d
    expect(limiter.size).toBeLessThan(4);
  });
});
