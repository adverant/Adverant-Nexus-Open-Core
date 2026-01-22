/**
 * Repository Scanner
 *
 * Scans local file systems to discover files for ingestion into GraphRAG.
 * Respects .gitignore patterns and provides flexible filtering options.
 *
 * Features:
 * - Recursive directory traversal
 * - .gitignore pattern matching
 * - File extension filtering
 * - File size limits
 * - Duplicate detection via hashing
 * - Progress tracking
 *
 * Usage:
 * ```typescript
 * const scanner = new RepositoryScanner({
 *   rootPath: '/path/to/repo',
 *   extensions: ['ts', 'tsx', 'js', 'jsx'],
 *   ignorePatterns: ['node_modules', 'dist', 'build'],
 *   maxFileSize: 10 * 1024 * 1024 // 10MB
 * });
 *
 * const files = await scanner.scan();
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { FileDescriptor } from '../providers/content-provider.interface.js';
import { logger } from '../utils/logger.js';
import ignore from 'ignore';

const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);

/**
 * Scanner configuration options
 */
export interface RepositoryScanOptions {
  /** Root directory to scan */
  rootPath: string;

  /** File extensions to include (e.g., ['ts', 'tsx', 'js']) */
  extensions?: string[];

  /** Additional ignore patterns (added to .gitignore) */
  ignorePatterns?: string[];

  /** Maximum file size in bytes (default: 10MB) */
  maxFileSize?: number;

  /** Maximum depth for recursive scanning (default: unlimited) */
  maxDepth?: number;

  /** Whether to follow symbolic links (default: false) */
  followSymlinks?: boolean;

  /** Whether to compute file hashes (default: true) */
  computeHashes?: boolean;

  /** Progress callback for tracking */
  onProgress?: (discovered: number, processed: number) => void;
}

/**
 * Scan result with statistics
 */
export interface ScanResult {
  /** Discovered files ready for ingestion */
  files: FileDescriptor[];

  /** Total files discovered */
  totalFiles: number;

  /** Files skipped due to filters */
  skippedFiles: number;

  /** Scan duration in milliseconds */
  scanDuration: number;

  /** Total size of discovered files in bytes */
  totalSize: number;
}

/**
 * Repository Scanner
 */
export class RepositoryScanner {
  private options: Required<RepositoryScanOptions>;
  private ignoreFilter: ReturnType<typeof ignore>;
  private discoveredFiles: Map<string, FileDescriptor> = new Map();
  private skippedCount: number = 0;
  private totalSize: number = 0;

  constructor(options: RepositoryScanOptions) {
    // Set defaults
    this.options = {
      rootPath: options.rootPath,
      extensions: options.extensions || [],
      ignorePatterns: options.ignorePatterns || [],
      maxFileSize: options.maxFileSize || 10 * 1024 * 1024, // 10MB
      maxDepth: options.maxDepth ?? Number.MAX_SAFE_INTEGER,
      followSymlinks: options.followSymlinks ?? false,
      computeHashes: options.computeHashes ?? true,
      onProgress: options.onProgress || (() => {})
    };

    // Initialize ignore filter
    this.ignoreFilter = ignore();
    this.loadIgnorePatterns();
  }

  /**
   * Load .gitignore patterns from repository
   */
  private loadIgnorePatterns(): void {
    try {
      // Load .gitignore if it exists
      const gitignorePath = path.join(this.options.rootPath, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        this.ignoreFilter.add(gitignoreContent);
        logger.debug('.gitignore patterns loaded', { path: gitignorePath });
      }

      // Add additional ignore patterns
      if (this.options.ignorePatterns.length > 0) {
        this.ignoreFilter.add(this.options.ignorePatterns);
        logger.debug('Additional ignore patterns added', {
          count: this.options.ignorePatterns.length
        });
      }

      // Always ignore common directories
      this.ignoreFilter.add([
        '.git',
        '.git/**',
        'node_modules',
        'node_modules/**',
        '.DS_Store',
        '*.log'
      ]);

    } catch (error) {
      logger.warn('Failed to load ignore patterns', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Scan repository and discover files
   */
  async scan(): Promise<ScanResult> {
    const startTime = Date.now();

    logger.info('Starting repository scan', {
      rootPath: this.options.rootPath,
      extensions: this.options.extensions,
      maxFileSize: this.options.maxFileSize
    });

    // Validate root path
    if (!fs.existsSync(this.options.rootPath)) {
      throw new Error(`Root path does not exist: ${this.options.rootPath}`);
    }

    const stats = await stat(this.options.rootPath);
    if (!stats.isDirectory()) {
      throw new Error(`Root path is not a directory: ${this.options.rootPath}`);
    }

    // Start recursive scan
    await this.scanDirectory(this.options.rootPath, 0);

    const scanDuration = Date.now() - startTime;
    const files = Array.from(this.discoveredFiles.values());

    logger.info('Repository scan completed', {
      totalFiles: files.length,
      skippedFiles: this.skippedCount,
      totalSize: this.totalSize,
      scanDuration
    });

    return {
      files,
      totalFiles: files.length,
      skippedFiles: this.skippedCount,
      scanDuration,
      totalSize: this.totalSize
    };
  }

  /**
   * Recursively scan a directory
   */
  private async scanDirectory(dirPath: string, depth: number): Promise<void> {
    // Check depth limit
    if (depth > this.options.maxDepth) {
      return;
    }

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(this.options.rootPath, fullPath);

        // Check if ignored
        if (this.shouldIgnore(relativePath)) {
          logger.debug('Ignoring path', { path: relativePath });
          this.skippedCount++;
          continue;
        }

        if (entry.isDirectory()) {
          // Recurse into subdirectory
          await this.scanDirectory(fullPath, depth + 1);
        } else if (entry.isFile()) {
          // Process file
          await this.processFile(fullPath, relativePath, depth);
        } else if (entry.isSymbolicLink() && this.options.followSymlinks) {
          // Follow symlink if enabled
          const realPath = fs.realpathSync(fullPath);
          const realStats = await stat(realPath);

          if (realStats.isDirectory()) {
            await this.scanDirectory(realPath, depth + 1);
          } else if (realStats.isFile()) {
            await this.processFile(realPath, relativePath, depth);
          }
        }
      }
    } catch (error) {
      logger.error('Error scanning directory', {
        dirPath,
        error: (error as Error).message
      });
      // Continue scanning other directories
    }
  }

  /**
   * Process a single file
   */
  private async processFile(
    fullPath: string,
    relativePath: string,
    depth: number
  ): Promise<void> {
    try {
      const stats = await stat(fullPath);

      // Check file size
      if (stats.size > this.options.maxFileSize) {
        logger.debug('File too large', {
          path: relativePath,
          size: stats.size,
          limit: this.options.maxFileSize
        });
        this.skippedCount++;
        return;
      }

      // Check file extension
      if (this.options.extensions.length > 0) {
        const ext = path.extname(fullPath).slice(1); // Remove leading dot
        if (!this.options.extensions.includes(ext)) {
          logger.debug('File extension not allowed', {
            path: relativePath,
            ext,
            allowed: this.options.extensions
          });
          this.skippedCount++;
          return;
        }
      }

      // Compute hash if enabled
      let hash: string | undefined;
      if (this.options.computeHashes) {
        const content = await readFile(fullPath);
        hash = crypto.createHash('sha256').update(content).digest('hex');

        // Check for duplicates
        if (this.discoveredFiles.has(hash)) {
          logger.debug('Duplicate file detected', {
            path: relativePath,
            hash,
            original: this.discoveredFiles.get(hash)!.url
          });
          this.skippedCount++;
          return;
        }
      }

      // Create file descriptor
      const fileDescriptor: FileDescriptor = {
        url: fullPath,
        filename: path.basename(fullPath),
        parentPath: path.dirname(relativePath),
        depth,
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
        hash,
        metadata: {
          extension: path.extname(fullPath).slice(1),
          relativePath,
          absolutePath: fullPath
        }
      };

      // Store file descriptor
      if (hash) {
        this.discoveredFiles.set(hash, fileDescriptor);
      } else {
        this.discoveredFiles.set(fullPath, fileDescriptor);
      }

      this.totalSize += stats.size;

      // Report progress
      this.options.onProgress(this.discoveredFiles.size, this.discoveredFiles.size);

      logger.debug('File discovered', {
        path: relativePath,
        size: stats.size,
        depth
      });

    } catch (error) {
      logger.error('Error processing file', {
        path: relativePath,
        error: (error as Error).message
      });
      this.skippedCount++;
    }
  }

  /**
   * Check if a path should be ignored
   */
  private shouldIgnore(relativePath: string): boolean {
    // Normalize path separators for ignore library
    const normalizedPath = relativePath.split(path.sep).join('/');
    return this.ignoreFilter.ignores(normalizedPath);
  }

  /**
   * Get scan statistics without performing scan
   */
  async estimateScan(): Promise<{
    estimatedFiles: number;
    estimatedSize: number;
  }> {
    logger.info('Estimating repository scan', {
      rootPath: this.options.rootPath
    });

    let estimatedFiles = 0;
    let estimatedSize = 0;

    const estimate = async (dirPath: string, depth: number): Promise<void> => {
      if (depth > this.options.maxDepth) {
        return;
      }

      try {
        const entries = await readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const relativePath = path.relative(this.options.rootPath, fullPath);

          if (this.shouldIgnore(relativePath)) {
            continue;
          }

          if (entry.isDirectory()) {
            await estimate(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const stats = await stat(fullPath);

            if (stats.size <= this.options.maxFileSize) {
              if (this.options.extensions.length === 0) {
                estimatedFiles++;
                estimatedSize += stats.size;
              } else {
                const ext = path.extname(fullPath).slice(1);
                if (this.options.extensions.includes(ext)) {
                  estimatedFiles++;
                  estimatedSize += stats.size;
                }
              }
            }
          }
        }
      } catch (error) {
        // Ignore errors during estimation
      }
    };

    await estimate(this.options.rootPath, 0);

    logger.info('Repository scan estimation completed', {
      estimatedFiles,
      estimatedSize
    });

    return {
      estimatedFiles,
      estimatedSize
    };
  }
}
