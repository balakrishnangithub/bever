import { describe, expect, it } from 'vitest';

import type { SyncRun } from '../types';
import { describeRetries, describeRun, formatBytes, formatDuration } from './syncProgress';

function run(rest: Partial<SyncRun>): SyncRun {
  return {
    startedAt: 1_000_000,
    activeAt: 1_000_000 + 17 * 60_000,
    endedAt: 1_000_000 + 17 * 60_000,
    outcome: 'complete',
    message: null,
    pushed: 0,
    pulled: 0,
    blobsUploaded: 0,
    blobsDownloaded: 0,
    bytesUploaded: 0,
    bytesDownloaded: 0,
    heldBack: 0,
    retries: 0,
    throttled: 0,
    ...rest,
  };
}

describe('a run of the record, in words', () => {
  it('says how each kind of run ended and how long it took', () => {
    expect(describeRun(run({}), false)).toMatchObject({
      headline: 'Completed in 17:00',
      reason: null,
      trouble: false,
      moved: 'Nothing transferred',
    });
    expect(describeRun(run({ heldBack: 1 }), false)).toMatchObject({
      headline: 'Completed in 17:00; 1 note held back',
      trouble: true,
    });
    expect(describeRun(run({ outcome: 'stopped' }), false)).toMatchObject({
      headline: 'Stopped after 17:00',
      trouble: false,
    });
    expect(describeRun(run({ outcome: 'failed', message: 'network error: lost' }), false)).toMatchObject({
      headline: 'Failed after 17:00',
      reason: 'network error: lost',
      trouble: true,
    });
  });

  it('tells a run that is going from one that never got to end', () => {
    const unfinished = run({ outcome: 'running', endedAt: null });
    expect(describeRun(unfinished, true)).toMatchObject({ headline: 'Running', trouble: false });
    const left = describeRun(unfinished, false);
    expect(left.headline).toBe('Did not finish; last seen at work after 17:00');
    expect(left.reason).toMatch(/closed.*slept.*turned off/);
    expect(left.trouble).toBe(true);
  });

  it('says what went each way, and what had to be asked again', () => {
    const moved = describeRun(
      run({
        pushed: 1216,
        blobsUploaded: 2389,
        bytesUploaded: 1288 * 1024 * 1024,
        pulled: 1,
        blobsDownloaded: 0,
        bytesDownloaded: 2048,
        retries: 4,
        throttled: 1,
      }),
      false,
    ).moved;
    expect(moved).toBe(
      '↑ 1,216 notes, 2,389 attachments, 1.3 GB · ↓ 1 note, 0 attachments, 2.0 KB · 4 requests repeated, 1 of them because the storage service asked for fewer',
    );
    expect(describeRetries(1, 0)).toBe('1 request repeated');
  });
});

describe('sync progress formatting', () => {
  it('shows sub-second precision and minute-based elapsed time', () => {
    expect(formatDuration(400)).toBe('0.4 s');
    expect(formatDuration(12_345)).toBe('12.3 s');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(-1)).toBe('0.0 s');
  });

  it('uses compact binary units for transferred bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});
