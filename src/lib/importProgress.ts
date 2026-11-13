import type { ImportProgress } from '../types';

/** Share of an import that is done, from 0 to 100, across all its files. */
export function importPercent(progress: ImportProgress | null): number {
  if (!progress || progress.fileCount === 0) return 0;
  const withinFile = progress.totalBytes > 0 ? Math.min(1, progress.bytesRead / progress.totalBytes) : 0;
  return Math.min(100, Math.floor(((progress.fileIndex + withinFile) / progress.fileCount) * 100));
}
