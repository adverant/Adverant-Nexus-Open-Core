/**
 * Repository Type Detector
 *
 * Analyzes a repository's structure, dependencies, and files to determine
 * its type (backend, frontend, mobile, etc.) and technology stack.
 */

import type {
  RepositoryType,
  TechStack,
  TypeDetectionResult,
  TypeIndicator,
} from './types/index.js';
import type { RepoManager } from './manager.js';

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages: string[] };
}

export class TypeDetector {
  private readonly repoManager: RepoManager;
  private readonly repoPath: string;

  constructor(repoManager: RepoManager, repoPath: string) {
    this.repoManager = repoManager;
    this.repoPath = repoPath;
  }

  /**
   * Detect repository type and technology stack
   */
  async detect(): Promise<TypeDetectionResult> {
    const indicators: TypeIndicator[] = [];
    const techStack: TechStack[] = [];

    // Gather file-based indicators
    const fileIndicators = await this.detectFromFiles();
    indicators.push(...fileIndicators);

    // Gather dependency-based indicators
    const depIndicators = await this.detectFromDependencies();
    indicators.push(...depIndicators);

    // Gather structure-based indicators
    const structureIndicators = await this.detectFromStructure();
    indicators.push(...structureIndicators);

    // Detect tech stack
    const detectedTech = await this.detectTechStack();
    techStack.push(...detectedTech);

    // Calculate primary type from indicators
    const { primaryType, confidence, subTypes } = this.calculatePrimaryType(indicators);

    return {
      primaryType,
      confidence,
      techStack,
      indicators,
      subTypes,
    };
  }

  /**
   * Quick detection without full analysis
   */
  async quickDetect(): Promise<{ type: RepositoryType; confidence: number }> {
    const indicators: TypeIndicator[] = [];

    // Only check critical files for quick detection
    const criticalFiles = [
      { file: 'pnpm-workspace.yaml', type: 'monorepo' as RepositoryType },
      { file: 'lerna.json', type: 'monorepo' as RepositoryType },
      { file: 'nx.json', type: 'monorepo' as RepositoryType },
      { file: 'turbo.json', type: 'monorepo' as RepositoryType },
      { file: 'next.config.js', type: 'frontend' as RepositoryType },
      { file: 'next.config.mjs', type: 'frontend' as RepositoryType },
      { file: 'nuxt.config.js', type: 'frontend' as RepositoryType },
      { file: 'angular.json', type: 'frontend' as RepositoryType },
      { file: 'main.tf', type: 'infra-as-code' as RepositoryType },
      { file: 'Pulumi.yaml', type: 'infra-as-code' as RepositoryType },
      { file: 'pubspec.yaml', type: 'mobile' as RepositoryType },
      { file: 'Podfile', type: 'mobile' as RepositoryType },
    ];

    for (const { file, type } of criticalFiles) {
      if (this.repoManager.exists(this.repoPath, file)) {
        indicators.push({
          type: 'file',
          name: file,
          path: file,
          confidence: 0.9,
          suggestedType: type,
        });
      }
    }

    // Check for packages/apps directories (monorepo)
    if (
      this.repoManager.exists(this.repoPath, 'packages') ||
      this.repoManager.exists(this.repoPath, 'apps')
    ) {
      indicators.push({
        type: 'structure',
        name: 'packages-or-apps-dir',
        confidence: 0.7,
        suggestedType: 'monorepo',
      });
    }

    // Check package.json for hints
    const packageJson = this.repoManager.readJsonFile<PackageJson>(
      this.repoPath,
      'package.json'
    );

    if (packageJson) {
      // Check for workspaces
      if (packageJson.workspaces) {
        indicators.push({
          type: 'dependency',
          name: 'npm-workspaces',
          confidence: 0.9,
          suggestedType: 'monorepo',
        });
      }

      // Check dependencies for frontend frameworks
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      if (allDeps['next'] || allDeps['react'] || allDeps['vue'] || allDeps['@angular/core']) {
        indicators.push({
          type: 'dependency',
          name: 'frontend-framework',
          confidence: 0.8,
          suggestedType: 'frontend',
        });
      }

      // Check for backend frameworks
      if (allDeps['express'] || allDeps['fastify'] || allDeps['@nestjs/core'] || allDeps['koa']) {
        indicators.push({
          type: 'dependency',
          name: 'backend-framework',
          confidence: 0.8,
          suggestedType: 'backend',
        });
      }
    }

    const { primaryType, confidence } = this.calculatePrimaryType(indicators);
    return { type: primaryType, confidence };
  }

  /**
   * Detect indicators from file presence
   */
  private async detectFromFiles(): Promise<TypeIndicator[]> {
    const indicators: TypeIndicator[] = [];

    const typePatterns: Record<RepositoryType, Array<{ pattern: string; confidence: number }>> = {
      monorepo: [
        { pattern: 'pnpm-workspace.yaml', confidence: 0.95 },
        { pattern: 'lerna.json', confidence: 0.95 },
        { pattern: 'nx.json', confidence: 0.95 },
        { pattern: 'turbo.json', confidence: 0.9 },
      ],
      frontend: [
        { pattern: 'next.config.js', confidence: 0.9 },
        { pattern: 'next.config.mjs', confidence: 0.9 },
        { pattern: 'nuxt.config.js', confidence: 0.9 },
        { pattern: 'angular.json', confidence: 0.95 },
        { pattern: 'svelte.config.js', confidence: 0.9 },
        { pattern: 'vite.config.ts', confidence: 0.7 },
        { pattern: 'webpack.config.js', confidence: 0.6 },
      ],
      backend: [
        { pattern: 'requirements.txt', confidence: 0.6 },
        { pattern: 'go.mod', confidence: 0.7 },
        { pattern: 'Cargo.toml', confidence: 0.7 },
        { pattern: 'pom.xml', confidence: 0.8 },
        { pattern: 'build.gradle', confidence: 0.7 },
        { pattern: 'Gemfile', confidence: 0.6 },
        { pattern: 'composer.json', confidence: 0.6 },
      ],
      mobile: [
        { pattern: 'pubspec.yaml', confidence: 0.95 },
        { pattern: 'Podfile', confidence: 0.8 },
        { pattern: 'capacitor.config.json', confidence: 0.9 },
        { pattern: 'app.json', confidence: 0.5 },
      ],
      'infra-as-code': [
        { pattern: 'main.tf', confidence: 0.95 },
        { pattern: 'Pulumi.yaml', confidence: 0.95 },
        { pattern: 'ansible.cfg', confidence: 0.9 },
        { pattern: 'Chart.yaml', confidence: 0.8 },
        { pattern: 'docker-compose.yml', confidence: 0.5 },
      ],
      library: [
        { pattern: 'setup.py', confidence: 0.7 },
        { pattern: 'pyproject.toml', confidence: 0.6 },
      ],
      unknown: [],
    };

    for (const [type, patterns] of Object.entries(typePatterns)) {
      for (const { pattern, confidence } of patterns) {
        if (this.repoManager.exists(this.repoPath, pattern)) {
          indicators.push({
            type: 'file',
            name: pattern,
            path: pattern,
            confidence,
            suggestedType: type as RepositoryType,
          });
        }
      }
    }

    return indicators;
  }

  /**
   * Detect indicators from dependencies
   */
  private async detectFromDependencies(): Promise<TypeIndicator[]> {
    const indicators: TypeIndicator[] = [];

    // Check package.json
    const packageJson = this.repoManager.readJsonFile<PackageJson>(
      this.repoPath,
      'package.json'
    );

    if (packageJson) {
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Monorepo indicators
      if (packageJson.workspaces) {
        indicators.push({
          type: 'dependency',
          name: 'npm-workspaces',
          confidence: 0.9,
          suggestedType: 'monorepo',
        });
      }

      // Frontend framework dependencies
      const frontendDeps: Array<{ dep: string; confidence: number }> = [
        { dep: 'next', confidence: 0.9 },
        { dep: 'react', confidence: 0.7 },
        { dep: 'vue', confidence: 0.8 },
        { dep: '@angular/core', confidence: 0.9 },
        { dep: 'svelte', confidence: 0.8 },
        { dep: '@remix-run/react', confidence: 0.9 },
        { dep: 'gatsby', confidence: 0.9 },
      ];

      for (const { dep, confidence } of frontendDeps) {
        if (allDeps[dep]) {
          indicators.push({
            type: 'dependency',
            name: dep,
            confidence,
            suggestedType: 'frontend',
          });
        }
      }

      // Backend framework dependencies
      const backendDeps: Array<{ dep: string; confidence: number }> = [
        { dep: 'express', confidence: 0.8 },
        { dep: 'fastify', confidence: 0.85 },
        { dep: '@nestjs/core', confidence: 0.9 },
        { dep: 'koa', confidence: 0.8 },
        { dep: 'hapi', confidence: 0.8 },
      ];

      for (const { dep, confidence } of backendDeps) {
        if (allDeps[dep]) {
          indicators.push({
            type: 'dependency',
            name: dep,
            confidence,
            suggestedType: 'backend',
          });
        }
      }

      // Mobile dependencies
      const mobileDeps: Array<{ dep: string; confidence: number }> = [
        { dep: 'react-native', confidence: 0.95 },
        { dep: '@capacitor/core', confidence: 0.9 },
        { dep: '@ionic/react', confidence: 0.9 },
        { dep: 'expo', confidence: 0.9 },
      ];

      for (const { dep, confidence } of mobileDeps) {
        if (allDeps[dep]) {
          indicators.push({
            type: 'dependency',
            name: dep,
            confidence,
            suggestedType: 'mobile',
          });
        }
      }

      // Library indicators
      if (packageJson.name?.startsWith('@') || allDeps['rollup'] || allDeps['tsup']) {
        indicators.push({
          type: 'pattern',
          name: 'library-pattern',
          confidence: 0.5,
          suggestedType: 'library',
        });
      }
    }

    return indicators;
  }

  /**
   * Detect indicators from directory structure
   */
  private async detectFromStructure(): Promise<TypeIndicator[]> {
    const indicators: TypeIndicator[] = [];

    // Monorepo structure
    if (this.repoManager.exists(this.repoPath, 'packages')) {
      indicators.push({
        type: 'structure',
        name: 'packages-directory',
        path: 'packages',
        confidence: 0.7,
        suggestedType: 'monorepo',
      });
    }

    if (this.repoManager.exists(this.repoPath, 'apps')) {
      indicators.push({
        type: 'structure',
        name: 'apps-directory',
        path: 'apps',
        confidence: 0.7,
        suggestedType: 'monorepo',
      });
    }

    // Mobile structure
    if (
      this.repoManager.exists(this.repoPath, 'ios') &&
      this.repoManager.exists(this.repoPath, 'android')
    ) {
      indicators.push({
        type: 'structure',
        name: 'mobile-platforms',
        confidence: 0.9,
        suggestedType: 'mobile',
      });
    }

    // Infrastructure structure
    if (this.repoManager.exists(this.repoPath, 'terraform')) {
      indicators.push({
        type: 'structure',
        name: 'terraform-directory',
        path: 'terraform',
        confidence: 0.85,
        suggestedType: 'infra-as-code',
      });
    }

    if (
      this.repoManager.exists(this.repoPath, 'k8s') ||
      this.repoManager.exists(this.repoPath, 'kubernetes')
    ) {
      indicators.push({
        type: 'structure',
        name: 'kubernetes-directory',
        confidence: 0.7,
        suggestedType: 'infra-as-code',
      });
    }

    // Frontend structure
    if (
      this.repoManager.exists(this.repoPath, 'src/components') ||
      this.repoManager.exists(this.repoPath, 'components')
    ) {
      indicators.push({
        type: 'structure',
        name: 'components-directory',
        confidence: 0.6,
        suggestedType: 'frontend',
      });
    }

    if (this.repoManager.exists(this.repoPath, 'public')) {
      indicators.push({
        type: 'structure',
        name: 'public-directory',
        confidence: 0.4,
        suggestedType: 'frontend',
      });
    }

    // Library structure
    if (
      this.repoManager.exists(this.repoPath, 'lib') ||
      this.repoManager.exists(this.repoPath, 'src/lib')
    ) {
      indicators.push({
        type: 'structure',
        name: 'lib-directory',
        confidence: 0.4,
        suggestedType: 'library',
      });
    }

    return indicators;
  }

  /**
   * Detect technology stack
   */
  private async detectTechStack(): Promise<TechStack[]> {
    const stack: Set<TechStack> = new Set();

    // Check for TypeScript
    if (this.repoManager.exists(this.repoPath, 'tsconfig.json')) {
      stack.add('typescript');
    }

    // Check package.json dependencies
    const packageJson = this.repoManager.readJsonFile<PackageJson>(
      this.repoPath,
      'package.json'
    );

    if (packageJson) {
      stack.add('javascript');

      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Frameworks
      if (allDeps['react'] || allDeps['react-dom']) stack.add('react');
      if (allDeps['vue']) stack.add('vue');
      if (allDeps['@angular/core']) stack.add('angular');
      if (allDeps['svelte']) stack.add('svelte');
      if (allDeps['next']) stack.add('nextjs');
      if (allDeps['nuxt']) stack.add('nuxt');
      if (allDeps['express']) stack.add('express');
      if (allDeps['fastify']) stack.add('fastify');
      if (allDeps['@nestjs/core']) stack.add('nestjs');
      if (allDeps['react-native']) stack.add('react-native');

      // Databases
      if (allDeps['pg'] || allDeps['@prisma/client'] || allDeps['postgres']) stack.add('postgresql');
      if (allDeps['mysql'] || allDeps['mysql2']) stack.add('mysql');
      if (allDeps['mongodb'] || allDeps['mongoose']) stack.add('mongodb');
      if (allDeps['redis'] || allDeps['ioredis']) stack.add('redis');
      if (allDeps['neo4j-driver']) stack.add('neo4j');

      // Testing
      if (allDeps['jest']) stack.add('jest');
      if (allDeps['vitest']) stack.add('vitest');
      if (allDeps['mocha']) stack.add('mocha');
      if (allDeps['cypress']) stack.add('cypress');
      if (allDeps['@playwright/test']) stack.add('playwright');

      // Other
      if (allDeps['graphql'] || allDeps['apollo-server']) stack.add('graphql');
      if (allDeps['ws'] || allDeps['socket.io']) stack.add('websocket');
    }

    // Check for Python
    if (
      this.repoManager.exists(this.repoPath, 'requirements.txt') ||
      this.repoManager.exists(this.repoPath, 'pyproject.toml') ||
      this.repoManager.exists(this.repoPath, 'setup.py')
    ) {
      stack.add('python');

      // Check for Python frameworks
      const requirements = this.repoManager.readFile(this.repoPath, 'requirements.txt');
      if (requirements) {
        if (requirements.includes('django')) stack.add('django');
        if (requirements.includes('flask')) stack.add('flask');
        if (requirements.includes('fastapi')) stack.add('fastapi');
        if (requirements.includes('pytest')) stack.add('pytest');
      }
    }

    // Check for Go
    if (this.repoManager.exists(this.repoPath, 'go.mod')) {
      stack.add('go');
    }

    // Check for Rust
    if (this.repoManager.exists(this.repoPath, 'Cargo.toml')) {
      stack.add('rust');
    }

    // Check for Docker
    if (
      this.repoManager.exists(this.repoPath, 'Dockerfile') ||
      this.repoManager.exists(this.repoPath, 'docker-compose.yml')
    ) {
      stack.add('docker');
    }

    // Check for Kubernetes
    if (
      this.repoManager.exists(this.repoPath, 'k8s') ||
      this.repoManager.exists(this.repoPath, 'kubernetes')
    ) {
      stack.add('kubernetes');
    }

    // Check for Terraform
    if (this.repoManager.exists(this.repoPath, 'main.tf')) {
      stack.add('terraform');
    }

    // Check for OpenAPI
    if (
      this.repoManager.exists(this.repoPath, 'openapi.yaml') ||
      this.repoManager.exists(this.repoPath, 'openapi.json') ||
      this.repoManager.exists(this.repoPath, 'swagger.yaml') ||
      this.repoManager.exists(this.repoPath, 'swagger.json')
    ) {
      stack.add('openapi');
      stack.add('rest');
    }

    return Array.from(stack);
  }

  /**
   * Calculate primary type from indicators
   */
  private calculatePrimaryType(indicators: TypeIndicator[]): {
    primaryType: RepositoryType;
    confidence: number;
    subTypes?: RepositoryType[];
  } {
    if (indicators.length === 0) {
      return { primaryType: 'unknown', confidence: 0 };
    }

    // Weight indicators by confidence and count
    const typeScores: Record<RepositoryType, number> = {
      backend: 0,
      frontend: 0,
      mobile: 0,
      'infra-as-code': 0,
      library: 0,
      monorepo: 0,
      unknown: 0,
    };

    for (const indicator of indicators) {
      typeScores[indicator.suggestedType] += indicator.confidence;
    }

    // Sort types by score
    const sortedTypes = Object.entries(typeScores)
      .filter(([_, score]) => score > 0)
      .sort(([, a], [, b]) => b - a) as Array<[RepositoryType, number]>;

    if (sortedTypes.length === 0) {
      return { primaryType: 'unknown', confidence: 0 };
    }

    const firstType = sortedTypes[0];
    if (!firstType) {
      return { primaryType: 'unknown', confidence: 0 };
    }

    const [primaryType, primaryScore] = firstType;

    // Calculate confidence (normalize to 0-1)
    const maxPossibleScore = indicators.length;
    const confidence = Math.min(primaryScore / maxPossibleScore, 1);

    // Check for subtypes (relevant for monorepos)
    let subTypes: RepositoryType[] | undefined;
    if (primaryType === 'monorepo' && sortedTypes.length > 1) {
      subTypes = sortedTypes
        .slice(1)
        .filter(([type, score]) => score > 0.3 && type !== 'unknown')
        .map(([type]) => type);
    }

    return { primaryType, confidence, subTypes };
  }
}

export default TypeDetector;
