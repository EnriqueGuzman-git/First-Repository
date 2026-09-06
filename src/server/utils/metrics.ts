export type MetricsSnapshot = {
  readonly commands: Readonly<Record<string, number>>;
  readonly errors: Readonly<Record<string, number>>;
  readonly commandDurationMs: {
    readonly count: number;
    readonly total: number;
    readonly max: number;
  };
};

export class Metrics {
  private readonly commandCounts = new Map<string, number>();
  private readonly errorCounts = new Map<string, number>();
  private commandDurationCount = 0;
  private commandDurationTotal = 0;
  private commandDurationMax = 0;

  recordCommand(type: string): void {
    this.commandCounts.set(type, (this.commandCounts.get(type) ?? 0) + 1);
  }

  recordError(code: string): void {
    this.errorCounts.set(code, (this.errorCounts.get(code) ?? 0) + 1);
  }

  recordCommandDuration(durationMs: number): void {
    this.commandDurationCount += 1;
    this.commandDurationTotal += durationMs;
    this.commandDurationMax = Math.max(this.commandDurationMax, durationMs);
  }

  snapshot(): MetricsSnapshot {
    return {
      commands: Object.fromEntries(this.commandCounts),
      errors: Object.fromEntries(this.errorCounts),
      commandDurationMs: {
        count: this.commandDurationCount,
        total: this.commandDurationTotal,
        max: this.commandDurationMax,
      },
    };
  }
}
