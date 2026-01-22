/**
 * Repository Manager
 *
 * Handles all git operations including cloning, parsing URLs,
 * reading files, and traversing directory structures.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { simpleGit, SimpleGit } from 'simple-git';
import type {
  RepositoryParseResult,
  DirectoryStructure,
  FileInfo,
  RepositoryCloneResult,
  CloneOptions,
  GitCredentials,
  GitPlatform,
} from './types/index.js';

/**
 * Error thrown for repository operation failures
 */
export class RepoManagerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context: {
      operation: string;
      url?: string;
      path?: string;
      originalError?: Error;
    }
  ) {
    super(message);
    this.name = 'RepoManagerError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class RepoManager {
  private readonly tempDir: string;
  private readonly git: SimpleGit;
  private credentials?: GitCredentials;

  constructor(options: { tempDir?: string; credentials?: GitCredentials } = {}) {
    this.tempDir = options.tempDir ?? path.join(os.tmpdir(), 'repo-analyzer');
    this.credentials = options.credentials;

    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    this.git = simpleGit({
      baseDir: this.tempDir,
      binary: 'git',
      maxConcurrentProcesses: 5,
    });
  }

  /**
   * Parse a repository URL to extract platform, owner, and repo name
   */
  parseRepoUrl(url: string): RepositoryParseResult {
    if (!url || typeof url !== 'string') {
      return {
        isValid: false,
        error: 'URL is required and must be a string',
      };
    }

    const normalizedUrl = url.trim();

    // Handle local file paths (file:// protocol)
    if (normalizedUrl.startsWith('file://')) {
      const localPath = normalizedUrl.replace('file://', '');
      if (!fs.existsSync(localPath)) {
        return {
          isValid: false,
          error: `Local path does not exist: ${localPath}`,
        };
      }
      const dirName = path.basename(localPath);
      return {
        isValid: true,
        platform: 'local',
        owner: 'local',
        name: dirName || 'repository',
        localPath,
      };
    }

    // Handle absolute local paths without file:// prefix
    if (normalizedUrl.startsWith('/') && !normalizedUrl.includes('://')) {
      if (!fs.existsSync(normalizedUrl)) {
        return {
          isValid: false,
          error: `Local path does not exist: ${normalizedUrl}`,
        };
      }
      const dirName = path.basename(normalizedUrl);
      return {
        isValid: true,
        platform: 'local',
        owner: 'local',
        name: dirName || 'repository',
        localPath: normalizedUrl,
      };
    }

    // GitHub patterns
    const githubHttpsPattern = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/;
    const githubSshPattern = /^git@github\.com:([^\/]+)\/([^\/]+?)(?:\.git)?$/;

    // GitLab patterns
    const gitlabHttpsPattern = /^https?:\/\/gitlab\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/;
    const gitlabSshPattern = /^git@gitlab\.com:([^\/]+)\/([^\/]+?)(?:\.git)?$/;

    // Bitbucket patterns
    const bitbucketHttpsPattern = /^https?:\/\/bitbucket\.org\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/;
    const bitbucketSshPattern = /^git@bitbucket\.org:([^\/]+)\/([^\/]+?)(?:\.git)?$/;

    // Try GitHub
    let match = normalizedUrl.match(githubHttpsPattern) ?? normalizedUrl.match(githubSshPattern);
    if (match) {
      return {
        isValid: true,
        platform: 'github',
        owner: match[1],
        name: match[2]?.replace(/\.git$/, ''),
      };
    }

    // Try GitLab
    match = normalizedUrl.match(gitlabHttpsPattern) ?? normalizedUrl.match(gitlabSshPattern);
    if (match) {
      return {
        isValid: true,
        platform: 'gitlab',
        owner: match[1],
        name: match[2]?.replace(/\.git$/, ''),
      };
    }

    // Try Bitbucket
    match = normalizedUrl.match(bitbucketHttpsPattern) ?? normalizedUrl.match(bitbucketSshPattern);
    if (match) {
      return {
        isValid: true,
        platform: 'bitbucket',
        owner: match[1],
        name: match[2]?.replace(/\.git$/, ''),
      };
    }

    return {
      isValid: false,
      error: `Unable to parse URL: ${url}. Supported formats: GitHub, GitLab, Bitbucket (HTTPS or SSH), or local paths`,
    };
  }

  /**
   * Clone a repository to local temp directory
   */
  async cloneRepository(
    url: string,
    options: CloneOptions = {}
  ): Promise<RepositoryCloneResult> {
    const startTime = Date.now();
    const parsed = this.parseRepoUrl(url);

    if (!parsed.isValid) {
      return {
        success: false,
        localPath: '',
        commitHash: '',
        branch: options.branch ?? 'main',
        duration: Date.now() - startTime,
        error: parsed.error,
      };
    }

    // For local paths, just return the path directly
    if (parsed.platform === 'local' && parsed.localPath) {
      try {
        const localGit = simpleGit(parsed.localPath);
        const log = await localGit.log({ maxCount: 1 });
        const currentBranch = await localGit.revparse(['--abbrev-ref', 'HEAD']);

        return {
          success: true,
          localPath: parsed.localPath,
          commitHash: log.latest?.hash ?? 'unknown',
          branch: currentBranch.trim() || options.branch || 'main',
          duration: Date.now() - startTime,
        };
      } catch (error) {
        return {
          success: true,
          localPath: parsed.localPath,
          commitHash: 'unknown',
          branch: options.branch ?? 'main',
          duration: Date.now() - startTime,
        };
      }
    }

    const repoName = `${parsed.owner}-${parsed.name}-${Date.now()}`;
    const localPath = path.join(this.tempDir, repoName);

    try {
      const cloneUrl = this.buildCloneUrl(url, parsed.platform);
      const cloneArgs: string[] = [];

      if (options.depth) {
        cloneArgs.push('--depth', String(options.depth));
      }

      if (options.branch) {
        cloneArgs.push('--branch', options.branch);
      }

      await this.git.clone(cloneUrl, localPath, cloneArgs);

      // Get commit hash
      const repoGit = simpleGit(localPath);
      const log = await repoGit.log({ maxCount: 1 });
      const commitHash = log.latest?.hash ?? 'unknown';

      // Get current branch
      const currentBranch = await repoGit.revparse(['--abbrev-ref', 'HEAD']);

      return {
        success: true,
        localPath,
        commitHash,
        branch: currentBranch.trim() || options.branch || 'main',
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        localPath: '',
        commitHash: '',
        branch: options.branch ?? 'main',
        duration: Date.now() - startTime,
        error: `Clone failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Build the clone URL with authentication if needed
   */
  private buildCloneUrl(url: string, platform?: GitPlatform): string {
    // For local platform, just return the URL as-is
    if (platform === 'local') {
      return url;
    }

    if (this.credentials?.token && url.startsWith('https://')) {
      // Inject token for HTTPS URLs
      const urlObj = new URL(url);
      urlObj.username = this.credentials.token;
      urlObj.password = 'x-oauth-basic';
      return urlObj.toString();
    }

    return url;
  }

  /**
   * Get directory structure of a repository
   */
  getDirectoryStructure(
    repoPath: string,
    maxDepth: number = 5,
    currentDepth: number = 0
  ): DirectoryStructure {
    if (!fs.existsSync(repoPath)) {
      throw new RepoManagerError(
        `Path does not exist: ${repoPath}`,
        'PATH_NOT_FOUND',
        { operation: 'getDirectoryStructure', path: repoPath }
      );
    }

    const stats = fs.statSync(repoPath);
    const name = path.basename(repoPath);

    if (!stats.isDirectory()) {
      return {
        path: repoPath,
        name,
        type: 'file',
        size: stats.size,
      };
    }

    const structure: DirectoryStructure = {
      path: repoPath,
      name,
      type: 'directory',
    };

    if (currentDepth < maxDepth) {
      const entries = fs.readdirSync(repoPath, { withFileTypes: true });
      const children: DirectoryStructure[] = [];

      for (const entry of entries) {
        // Skip common non-essential directories
        if (this.shouldSkipPath(entry.name)) {
          continue;
        }

        const childPath = path.join(repoPath, entry.name);

        // Skip broken symlinks and inaccessible paths
        try {
          // Check if the path is accessible (handles broken symlinks)
          fs.accessSync(childPath, fs.constants.R_OK);
          children.push(
            this.getDirectoryStructure(childPath, maxDepth, currentDepth + 1)
          );
        } catch {
          // Skip inaccessible paths (broken symlinks, permission issues)
          continue;
        }
      }

      structure.children = children.sort((a, b) => {
        // Directories first, then alphabetical
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    }

    return structure;
  }

  /**
   * Check if a path should be skipped during traversal
   */
  private shouldSkipPath(name: string): boolean {
    const skipPatterns = [
      'node_modules',
      '.git',
      '.svn',
      '.hg',
      '__pycache__',
      '.pytest_cache',
      '.tox',
      '.nox',
      'venv',
      '.venv',
      'env',
      '.env',
      'dist',
      'build',
      '.next',
      '.nuxt',
      'coverage',
      '.nyc_output',
      '.cache',
      '.parcel-cache',
      '.turbo',
    ];

    return skipPatterns.includes(name) || name.startsWith('.');
  }

  /**
   * List all files in a repository with metadata
   */
  listFiles(
    repoPath: string,
    options: {
      extensions?: string[];
      maxFiles?: number;
      excludePatterns?: string[];
    } = {}
  ): FileInfo[] {
    const files: FileInfo[] = [];
    const maxFiles = options.maxFiles ?? 10000;

    const traverse = (dir: string): void => {
      if (files.length >= maxFiles) return;

      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (files.length >= maxFiles) break;

        if (this.shouldSkipPath(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        // Skip broken symlinks and inaccessible paths
        try {
          fs.accessSync(fullPath, fs.constants.R_OK);
        } catch {
          continue;
        }

        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();

          // Filter by extension if specified
          if (options.extensions && options.extensions.length > 0) {
            if (!options.extensions.includes(ext) && !options.extensions.includes(ext.slice(1))) {
              continue;
            }
          }

          // Check exclude patterns
          if (options.excludePatterns) {
            const relativePath = path.relative(repoPath, fullPath);
            if (options.excludePatterns.some(p => relativePath.includes(p))) {
              continue;
            }
          }

          const stats = fs.statSync(fullPath);
          files.push({
            path: path.relative(repoPath, fullPath),
            name: entry.name,
            extension: ext,
            size: stats.size,
            language: this.detectLanguage(ext),
          });
        }
      }
    };

    traverse(repoPath);
    return files;
  }

  /**
   * Read file content
   */
  readFile(repoPath: string, filePath: string): string | null {
    const fullPath = path.join(repoPath, filePath);

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    try {
      return fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Read and parse JSON file
   */
  readJsonFile<T = unknown>(repoPath: string, filePath: string): T | null {
    const content = this.readFile(repoPath, filePath);
    if (!content) return null;

    try {
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  /**
   * Check if a file or directory exists
   */
  exists(repoPath: string, relativePath: string): boolean {
    return fs.existsSync(path.join(repoPath, relativePath));
  }

  /**
   * Detect programming language from file extension
   */
  private detectLanguage(extension: string): string | undefined {
    const extensionMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.rb': 'ruby',
      '.php': 'php',
      '.cs': 'csharp',
      '.cpp': 'cpp',
      '.c': 'c',
      '.h': 'c',
      '.hpp': 'cpp',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.vue': 'vue',
      '.svelte': 'svelte',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.sass': 'sass',
      '.less': 'less',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.xml': 'xml',
      '.md': 'markdown',
      '.sql': 'sql',
      '.sh': 'shell',
      '.bash': 'shell',
      '.zsh': 'shell',
      '.dockerfile': 'dockerfile',
    };

    return extensionMap[extension.toLowerCase()];
  }

  /**
   * Clean up cloned repositories
   */
  async cleanup(localPath?: string): Promise<void> {
    const pathToClean = localPath ?? this.tempDir;

    if (fs.existsSync(pathToClean)) {
      fs.rmSync(pathToClean, { recursive: true, force: true });
    }
  }

  /**
   * Get repository metadata
   */
  async getRepositoryMetadata(repoPath: string): Promise<{
    sizeBytes: number;
    fileCount: number;
    directoryCount: number;
    lastCommitDate?: Date;
  }> {
    let sizeBytes = 0;
    let fileCount = 0;
    let directoryCount = 0;

    const traverse = (dir: string): void => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (this.shouldSkipPath(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          directoryCount++;
          traverse(fullPath);
        } else if (entry.isFile()) {
          fileCount++;
          const stats = fs.statSync(fullPath);
          sizeBytes += stats.size;
        }
      }
    };

    traverse(repoPath);

    // Try to get last commit date
    let lastCommitDate: Date | undefined;
    try {
      const repoGit = simpleGit(repoPath);
      const log = await repoGit.log({ maxCount: 1 });
      if (log.latest?.date) {
        lastCommitDate = new Date(log.latest.date);
      }
    } catch {
      // Not a git repository or git not available
    }

    return {
      sizeBytes,
      fileCount,
      directoryCount,
      lastCommitDate,
    };
  }
}

export default RepoManager;
