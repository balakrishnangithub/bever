import type { SyncRun } from '../types';

export function formatDuration(milliseconds: number): string {
  const safeMilliseconds = Math.max(0, milliseconds);
  if (safeMilliseconds < 60_000) {
    return `${(safeMilliseconds / 1000).toFixed(1)} s`;
  }
  const totalSeconds = Math.round(safeMilliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  const precision = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function counted(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/** How many requests were made again, and how many of them at the storage service's asking. */
export function describeRetries(retries: number, throttled: number): string {
  const repeated = `${counted(retries, 'request')} repeated`;
  return throttled > 0
    ? `${repeated}, ${throttled.toLocaleString('en-US')} of them because the storage service asked for fewer`
    : repeated;
}

/**
 * A run of the record in words: how it ended, and what it moved. `going`
 * says whether a run is going now. One that is still marked as running
 * while none is never got to say how it ended.
 */
export function describeRun(
  run: SyncRun,
  going: boolean,
): { headline: string; reason: string | null; trouble: boolean; moved: string } {
  const lasted = formatDuration(Math.max(0, (run.endedAt ?? run.activeAt) - run.startedAt));
  let headline: string;
  let reason: string | null = null;
  let trouble = false;
  if (run.outcome === 'complete') {
    headline = `Completed in ${lasted}`;
    if (run.heldBack > 0) {
      headline += `; ${counted(run.heldBack, 'note')} held back`;
      trouble = true;
    }
  } else if (run.outcome === 'stopped') {
    headline = `Stopped after ${lasted}`;
  } else if (run.outcome === 'failed') {
    headline = `Failed after ${lasted}`;
    reason = run.message ?? 'No reason was recorded.';
    trouble = true;
  } else if (going) {
    headline = 'Running';
  } else {
    headline = `Did not finish; last seen at work after ${lasted}`;
    reason = 'Bever was closed, or the device slept or was turned off, while it ran.';
    trouble = true;
  }
  const moved: string[] = [];
  if (run.pushed > 0 || run.blobsUploaded > 0) {
    moved.push(
      `↑ ${counted(run.pushed, 'note')}, ${counted(run.blobsUploaded, 'attachment')}, ${formatBytes(run.bytesUploaded)}`,
    );
  }
  if (run.pulled > 0 || run.blobsDownloaded > 0) {
    moved.push(
      `↓ ${counted(run.pulled, 'note')}, ${counted(run.blobsDownloaded, 'attachment')}, ${formatBytes(run.bytesDownloaded)}`,
    );
  }
  if (moved.length === 0) moved.push('Nothing transferred');
  if (run.retries > 0) moved.push(describeRetries(run.retries, run.throttled));
  return { headline, reason, trouble, moved: moved.join(' · ') };
}
