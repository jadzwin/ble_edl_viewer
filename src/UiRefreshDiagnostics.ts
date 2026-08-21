import type { DistributionSnapshot } from './BleStatsCollector';

const SAMPLE_CAPACITY = 2048;

class NumberRing {
  private readonly values = new Float64Array(SAMPLE_CAPACITY);
  private nextIndex = 0;
  private count = 0;

  reset(): void {
    this.nextIndex = 0;
    this.count = 0;
  }

  push(value: number): void {
    this.values[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % SAMPLE_CAPACITY;
    this.count = Math.min(this.count + 1, SAMPLE_CAPACITY);
  }

  sortedArray(): number[] {
    const result = new Array<number>(this.count);
    const startIndex = this.count < SAMPLE_CAPACITY ? 0 : this.nextIndex;
    for (let index = 0; index < this.count; index += 1) {
      result[index] = this.values[(startIndex + index) % SAMPLE_CAPACITY] ?? 0;
    }
    result.sort((a, b) => a - b);
    return result;
  }
}

function percentile(sortedValues: readonly number[], fraction: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index] ?? null;
}

function distribution(ring: NumberRing): DistributionSnapshot {
  const values = ring.sortedArray();
  if (values.length === 0) {
    return { min: null, median: null, p95: null, p99: null, max: null };
  }
  return {
    min: values[0] ?? null,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values[values.length - 1] ?? null,
  };
}

export interface UiRefreshDiagnosticsSnapshot {
  requested: number;
  executed: number;
  committed: number;
  coalesced: number;
  actualIntervalMs: DistributionSnapshot;
  latenessMs: DistributionSnapshot;
  preparationDurationMs: DistributionSnapshot;
  commitDelayMs: DistributionSnapshot;
  rpmLatestAgeMs: number | null;
  rpmSnapshotCount: number;
  lastSnapshotAgoMs: number | null;
}

export class UiRefreshDiagnostics {
  private requested = 0;
  private executed = 0;
  private committed = 0;
  private coalesced = 0;
  private lastStartedAtMs: number | null = null;
  private pendingStartedAtMs: number | null = null;
  private lastSnapshotAtMs: number | null = null;
  private rpmLatestAgeMs: number | null = null;
  private rpmSnapshotCount = 0;
  private readonly actualIntervals = new NumberRing();
  private readonly lateness = new NumberRing();
  private readonly preparationDurations = new NumberRing();
  private readonly commitDelays = new NumberRing();

  constructor(private readonly targetIntervalMs: number) {}

  reset(): void {
    this.requested = 0;
    this.executed = 0;
    this.committed = 0;
    this.coalesced = 0;
    this.lastStartedAtMs = null;
    this.pendingStartedAtMs = null;
    this.lastSnapshotAtMs = null;
    this.rpmLatestAgeMs = null;
    this.rpmSnapshotCount = 0;
    this.actualIntervals.reset();
    this.lateness.reset();
    this.preparationDurations.reset();
    this.commitDelays.reset();
  }

  markInactive(): void {
    this.lastStartedAtMs = null;
  }

  recordExecution(
    startedAtMs: number,
    preparationDurationMs: number,
    rpmLatestAgeMs: number | null,
    rpmSnapshotCount: number,
  ): void {
    let dueRefreshes = 1;
    if (this.lastStartedAtMs !== null) {
      const actualIntervalMs = Math.max(0, startedAtMs - this.lastStartedAtMs);
      this.actualIntervals.push(actualIntervalMs);
      this.lateness.push(Math.max(0, actualIntervalMs - this.targetIntervalMs));
      dueRefreshes = Math.max(1, Math.floor(actualIntervalMs / this.targetIntervalMs));
    }

    this.requested += dueRefreshes;
    this.executed += 1;
    this.coalesced += dueRefreshes - 1;
    this.lastStartedAtMs = startedAtMs;
    this.pendingStartedAtMs = startedAtMs;
    this.lastSnapshotAtMs = startedAtMs;
    this.rpmLatestAgeMs = rpmLatestAgeMs;
    this.rpmSnapshotCount = rpmSnapshotCount;
    this.preparationDurations.push(Math.max(0, preparationDurationMs));
  }

  recordCommit(committedAtMs: number): void {
    if (this.pendingStartedAtMs === null) return;
    this.committed += 1;
    this.commitDelays.push(Math.max(0, committedAtMs - this.pendingStartedAtMs));
    this.pendingStartedAtMs = null;
  }

  snapshot(nowMs: number): UiRefreshDiagnosticsSnapshot {
    return {
      requested: this.requested,
      executed: this.executed,
      committed: this.committed,
      coalesced: this.coalesced,
      actualIntervalMs: distribution(this.actualIntervals),
      latenessMs: distribution(this.lateness),
      preparationDurationMs: distribution(this.preparationDurations),
      commitDelayMs: distribution(this.commitDelays),
      rpmLatestAgeMs: this.rpmLatestAgeMs,
      rpmSnapshotCount: this.rpmSnapshotCount,
      lastSnapshotAgoMs:
        this.lastSnapshotAtMs === null ? null : Math.max(0, nowMs - this.lastSnapshotAtMs),
    };
  }
}
