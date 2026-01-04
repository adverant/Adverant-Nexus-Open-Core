/**
 * Workspace Detection for Nexus CLI
 *
 * Auto-detects workspace characteristics:
 * - Project type (typescript, python, go, rust, java)
 * - Git repository info
 * - Docker compose files
 * - Service availability
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { execaCommand } from 'execa';
import { glob } from 'glob';
import type { NexusConfig } from '../../types/config.js';
import { logger } from '../../utils/logger.js';

export interface WorkspaceInfo {
  cwd: string;
  projectType: 'typescript' | 'python' | 'go' | 'rust' | 'java' | 'unknown';
  projectName: string;
  gitRepo: boolean;
  gitBranch?: string;
  gitRemote?: string;
  gitStatus?: string;
  dockerComposeFiles: string[];
  nexusConfig: NexusConfig | null;
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry' | 'cargo' | 'gradle' | 'maven';
}

/**
 * Workspace Detector
 */
export class WorkspaceDetector {
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
  }

  /**
   * Detect all workspace characteristics
   */
  async detect(): Promise<WorkspaceInfo> {
    const [projectType, projectName, gitInfo, dockerFiles, packageManager] = await Promise.all([
      this.detectProjectType(),
      this.detectProjectName(),
      this.detectGitInfo(),
      this.detectDockerComposeFiles(),
      this.detectPackageManager(),
    ]);

    // Check for .nexus.toml
    const nexusConfigPath = path.join(this.cwd, '.nexus.toml');
    const hasNexusConfig = await fs.pathExists(nexusConfigPath);

    return {
      cwd: this.cwd,
      projectType,
      projectName,
      gitRepo: gitInfo.isRepo,
      gitBranch: gitInfo.branch,
      gitRemote: gitInfo.remote,
      gitStatus: gitInfo.status,
      dockerComposeFiles: dockerFiles,
      nexusConfig: hasNexusConfig ? {} : null, // Actual config loaded by ConfigManager
      packageManager,
    };
  }

  /**
   * Detect project type based on files present
   */
  private async detectProjectType(): Promise<WorkspaceInfo['projectType']> {
    const checks = [
      {
        type: 'typescript' as const,
        files: ['package.json', 'tsconfig.json'],
      },
      {
        type: 'python' as const,
        files: ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'],
      },
      {
        type: 'go' as const,
        files: ['go.mod', 'go.sum'],
      },
      {
        type: 'rust' as const,
        files: ['Cargo.toml', 'Cargo.lock'],
      },
      {
        type: 'java' as const,
        files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
      },
    ];

    for (const check of checks) {
      for (const file of check.files) {
        const filePath = path.join(this.cwd, file);
        if (await fs.pathExists(filePath)) {
          logger.debug(`Detected ${check.type} project (found ${file})`);
          return check.type;
        }
      }
    }

    logger.debug('Could not detect project type');
    return 'unknown';
  }

  /**
   * Detect project name from package files
   */
  private async detectProjectName(): Promise<string> {
    // Try package.json
    const packageJsonPath = path.join(this.cwd, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      try {
        const packageJson = await fs.readJson(packageJsonPath);
        if (packageJson.name) {
          return packageJson.name;
        }
      } catch (error) {
        logger.debug(`Failed to read package.json: ${error}`);
      }
    }

    // Try pyproject.toml
    const pyprojectPath = path.join(this.cwd, 'pyproject.toml');
    if (await fs.pathExists(pyprojectPath)) {
      try {
        const content = await fs.readFile(pyprojectPath, 'utf-8');
        const match = content.match(/name\s*=\s*"([^"]+)"/);
        if (match) {
          return match[1];
        }
      } catch (error) {
        logger.debug(`Failed to read pyproject.toml: ${error}`);
      }
    }

    // Try Cargo.toml
    const cargoPath = path.join(this.cwd, 'Cargo.toml');
    if (await fs.pathExists(cargoPath)) {
      try {
        const content = await fs.readFile(cargoPath, 'utf-8');
        const match = content.match(/name\s*=\s*"([^"]+)"/);
        if (match) {
          return match[1];
        }
      } catch (error) {
        logger.debug(`Failed to read Cargo.toml: ${error}`);
      }
    }

    // Try go.mod
    const goModPath = path.join(this.cwd, 'go.mod');
    if (await fs.pathExists(goModPath)) {
      try {
        const content = await fs.readFile(goModPath, 'utf-8');
        const match = content.match(/module\s+([^\s]+)/);
        if (match) {
          return match[1].split('/').pop() || match[1];
        }
      } catch (error) {
        logger.debug(`Failed to read go.mod: ${error}`);
      }
    }

    // Fallback to directory name
    return path.basename(this.cwd);
  }

  /**
   * Detect git repository info
   */
  private async detectGitInfo(): Promise<{
    isRepo: boolean;
    branch?: string;
    remote?: string;
    status?: string;
  }> {
    const gitDir = path.join(this.cwd, '.git');
    const isRepo = await fs.pathExists(gitDir);

    if (!isRepo) {
      return { isRepo: false };
    }

    try {
      // Get current branch
      const branchResult = await execaCommand('git rev-parse --abbrev-ref HEAD', {
        cwd: this.cwd,
        shell: true,
      });
      const branch = branchResult.stdout.trim();

      // Get remote URL
      let remote: string | undefined;
      try {
        const remoteResult = await execaCommand('git config --get remote.origin.url', {
          cwd: this.cwd,
          shell: true,
        });
        remote = remoteResult.stdout.trim();
      } catch {
        // No remote configured
      }

      // Get status
      let status: string | undefined;
      try {
        const statusResult = await execaCommand('git status --porcelain', {
          cwd: this.cwd,
          shell: true,
        });
        const hasChanges = statusResult.stdout.trim().length > 0;
        status = hasChanges ? 'modified' : 'clean';
      } catch {
        // Status check failed
      }

      return {
        isRepo: true,
        branch,
        remote,
        status,
      };
    } catch (error) {
      logger.debug(`Failed to get git info: ${error}`);
      return { isRepo: true };
    }
  }

  /**
   * Detect docker-compose files
   */
  private async detectDockerComposeFiles(): Promise<string[]> {
    const patterns = [
      'docker-compose.yml',
      'docker-compose.yaml',
      'docker/docker-compose.yml',
      'docker/docker-compose.yaml',
      'docker-compose.*.yml',
      'docker-compose.*.yaml',
      'docker/docker-compose.*.yml',
      'docker/docker-compose.*.yaml',
    ];

    const files: string[] = [];

    for (const pattern of patterns) {
      try {
        const matches = await glob(pattern, {
          cwd: this.cwd,
          absolute: true,
        });
        files.push(...matches);
      } catch (error) {
        logger.debug(`Failed to search for ${pattern}: ${error}`);
      }
    }

    // Remove duplicates and sort
    const uniqueFiles = Array.from(new Set(files)).sort();

    if (uniqueFiles.length > 0) {
      logger.debug(`Found ${uniqueFiles.length} docker-compose file(s)`);
    }

    return uniqueFiles;
  }

  /**
   * Detect package manager
   */
  private async detectPackageManager(): Promise<WorkspaceInfo['packageManager']> {
    const checks: Array<{
      manager: WorkspaceInfo['packageManager'];
      files: string[];
    }> = [
      { manager: 'pnpm', files: ['pnpm-lock.yaml'] },
      { manager: 'yarn', files: ['yarn.lock'] },
      { manager: 'npm', files: ['package-lock.json'] },
      { manager: 'poetry', files: ['poetry.lock'] },
      { manager: 'pip', files: ['requirements.txt'] },
      { manager: 'cargo', files: ['Cargo.lock'] },
      { manager: 'gradle', files: ['build.gradle', 'build.gradle.kts'] },
      { manager: 'maven', files: ['pom.xml'] },
    ];

    for (const check of checks) {
      for (const file of check.files) {
        const filePath = path.join(this.cwd, file);
        if (await fs.pathExists(filePath)) {
          logger.debug(`Detected ${check.manager} package manager (found ${file})`);
          return check.manager;
        }
      }
    }

    return undefined;
  }

  /**
   * Check if running in a Nexus workspace
   */
  async isNexusWorkspace(): Promise<boolean> {
    const nexusConfigPath = path.join(this.cwd, '.nexus.toml');
    return await fs.pathExists(nexusConfigPath);
  }

  /**
   * Find nearest .nexus.toml by walking up the directory tree
   */
  async findNexusWorkspaceRoot(startDir?: string): Promise<string | null> {
    let currentDir = startDir || this.cwd;
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const configPath = path.join(currentDir, '.nexus.toml');
      if (await fs.pathExists(configPath)) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }

    return null;
  }
}

/**
 * Create workspace detector instance
 */
export function createWorkspaceDetector(cwd?: string): WorkspaceDetector {
  return new WorkspaceDetector(cwd);
}
