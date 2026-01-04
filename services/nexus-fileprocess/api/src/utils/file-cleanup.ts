/**
 * File Cleanup Utility
 *
 * Provides safe file cleanup with error logging for disk-based temp files.
 * Ensures temporary files are always cleaned up, preventing disk space exhaustion.
 *
 * Design Pattern: Resource Acquisition Is Initialization (RAII) - TypeScript variant
 */

import fs from 'fs';
import { logger } from './logger';

/**
 * Safely clean up a temporary file
 *
 * @param filePath - Absolute path to the temporary file
 * @param context - Context for logging (e.g., 'upload', 'download', 'processing')
 * @returns Promise<boolean> - true if cleanup successful, false otherwise
 */
export async function cleanupTempFile(
  filePath: string | undefined,
  context: string = 'operation'
): Promise<boolean> {
  if (!filePath) {
    return true; // Nothing to clean up
  }

  try {
    await fs.promises.unlink(filePath);
    logger.debug('Temporary file cleaned up', {
      context,
      filePath,
    });
    return true;
  } catch (error) {
    // File may already be deleted or never existed - this is not critical
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug('Temporary file already deleted', {
        context,
        filePath,
      });
      return true;
    }

    // Log other errors but don't throw - cleanup failures shouldn't break the response
    logger.warn('Failed to clean up temporary file', {
      context,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Clean up multiple temporary files
 *
 * @param filePaths - Array of absolute paths to temporary files
 * @param context - Context for logging
 * @returns Promise<number> - Count of successfully cleaned files
 */
export async function cleanupTempFiles(
  filePaths: (string | undefined)[],
  context: string = 'operation'
): Promise<number> {
  const validPaths = filePaths.filter((path): path is string => !!path);

  if (validPaths.length === 0) {
    return 0;
  }

  const results = await Promise.allSettled(
    validPaths.map(path => cleanupTempFile(path, context))
  );

  const successCount = results.filter(
    result => result.status === 'fulfilled' && result.value === true
  ).length;

  if (successCount < validPaths.length) {
    logger.warn('Some temporary files failed to clean up', {
      context,
      totalFiles: validPaths.length,
      successCount,
      failedCount: validPaths.length - successCount,
    });
  }

  return successCount;
}
