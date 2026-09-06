import { describe, expect, it } from 'vitest';

import { Metrics } from './metrics.js';

describe('Metrics', () => {
  it('aggregates command and error counters', () => {
    const metrics = new Metrics();
    metrics.recordCommand('AUTH');
    metrics.recordCommand('AUTH');
    metrics.recordError('MALFORMED_MESSAGE');
    metrics.recordCommandDuration(4);
    metrics.recordCommandDuration(8);

    expect(metrics.snapshot()).toEqual({
      commands: { AUTH: 2 },
      errors: { MALFORMED_MESSAGE: 1 },
      commandDurationMs: { count: 2, total: 12, max: 8 },
    });
  });
});
