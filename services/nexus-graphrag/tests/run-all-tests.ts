#!/usr/bin/env ts-node

/**
 * Comprehensive Test Runner for GraphRAG
 * Executes all test suites with detailed reporting
 */

import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';

interface TestSuite {
  name: string;
  path: string;
  type: 'unit' | 'integration' | 'e2e' | 'performance' | 'security';
  timeout?: number;
}

const testSuites: TestSuite[] = [
  // Unit Tests
  {
    name: 'Storage Engine',
    path: 'tests/unit/storage/storage-engine.test.ts',
    type: 'unit'
  },

  // Integration Tests
  {
    name: 'API Endpoints',
    path: 'tests/integration/api/api-endpoints.test.ts',
    type: 'integration'
  },
  {
    name: 'Vector Search',
    path: 'tests/integration/vector-search.test.ts',
    type: 'integration'
  },
  {
    name: 'Graph Operations',
    path: 'tests/integration/graph-operations.test.ts',
    type: 'integration'
  },
  {
    name: 'WebSocket',
    path: 'tests/integration/websocket/websocket.test.ts',
    type: 'integration'
  },

  // Performance Tests
  {
    name: 'Performance',
    path: 'tests/performance/performance.test.ts',
    type: 'performance',
    timeout: 120000
  },

  // Security Tests
  {
    name: 'Security',
    path: 'tests/security/security.test.ts',
    type: 'security'
  }
];

interface TestResult {
  suite: string;
  type: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  coverage?: {
    lines: number;
    branches: number;
    functions: number;
    statements: number;
  };
}

class TestRunner {
  private results: TestResult[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  async runAllTests(): Promise<void> {
    console.log(chalk.bold.cyan('\n🚀 GraphRAG Comprehensive Test Suite\n'));

    // Check if services are running
    const spinner = ora('Checking services...').start();
    const servicesReady = await this.checkServices();

    if (!servicesReady) {
      spinner.fail('Services not ready. Please start GraphRAG services first.');
      process.exit(1);
    }

    spinner.succeed('Services ready');

    // Run each test suite
    for (const suite of testSuites) {
      await this.runTestSuite(suite);
    }

    // Display results
    this.displayResults();
  }

  private async checkServices(): Promise<boolean> {
    try {
      const axios = require('axios');
      const response = await axios.get('http://localhost:8090/health', {
        timeout: 5000
      });
      return response.data.status === 'healthy';
    } catch (error) {
      return false;
    }
  }

  private async runTestSuite(suite: TestSuite): Promise<void> {
    const spinner = ora(`Running ${suite.name} tests...`).start();
    const startTime = Date.now();

    try {
      const result = await this.executeJest(suite.path, suite.timeout);
      const duration = Date.now() - startTime;

      this.results.push({
        suite: suite.name,
        type: suite.type,
        passed: result.passed,
        failed: result.failed,
        skipped: result.skipped,
        duration,
        coverage: result.coverage
      });

      if (result.failed === 0) {
        spinner.succeed(chalk.green(`✅ ${suite.name}: ${result.passed} passed`));
      } else {
        spinner.fail(chalk.red(`❌ ${suite.name}: ${result.failed} failed, ${result.passed} passed`));
      }
    } catch (error) {
      spinner.fail(chalk.red(`❌ ${suite.name}: Error running tests`));
      this.results.push({
        suite: suite.name,
        type: suite.type,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: Date.now() - startTime
      });
    }
  }

  private executeJest(testPath: string, timeout?: number): Promise<any> {
    return new Promise((resolve) => {
      const args = [
        'jest',
        testPath,
        '--json',
        '--coverage',
        '--detectOpenHandles',
        '--forceExit'
      ];

      if (timeout) {
        args.push(`--testTimeout=${timeout}`);
      }

      const jest = spawn('npx', args, {
        env: { ...process.env, NODE_ENV: 'test' }
      });

      let output = '';
      let errorOutput = '';

      jest.stdout.on('data', (data) => {
        output += data.toString();
      });

      jest.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      jest.on('close', (code) => {
        try {
          const jsonMatch = output.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            resolve({
              passed: result.numPassedTests || 0,
              failed: result.numFailedTests || 0,
              skipped: result.numPendingTests || 0,
              coverage: result.coverageMap ? this.extractCoverage(result.coverageMap) : undefined
            });
          } else {
            // If JSON parsing fails, use exit code
            resolve({
              passed: code === 0 ? 1 : 0,
              failed: code === 0 ? 0 : 1,
              skipped: 0
            });
          }
        } catch (error) {
          resolve({
            passed: 0,
            failed: 1,
            skipped: 0
          });
        }
      });
    });
  }

  private extractCoverage(coverageMap: any): any {
    // Extract coverage percentages from coverage map
    let totalLines = 0;
    let coveredLines = 0;
    let totalBranches = 0;
    let coveredBranches = 0;
    let totalFunctions = 0;
    let coveredFunctions = 0;
    let totalStatements = 0;
    let coveredStatements = 0;

    for (const file in coverageMap) {
      const fileCoverage = coverageMap[file];

      if (fileCoverage.l) {
        const lines = Object.values(fileCoverage.l) as number[];
        totalLines += lines.length;
        coveredLines += lines.filter(hits => hits > 0).length;
      }

      if (fileCoverage.b) {
        const branches = Object.values(fileCoverage.b) as number[][];
        totalBranches += branches.length * 2;
        coveredBranches += branches.flat().filter(hits => hits > 0).length;
      }

      if (fileCoverage.f) {
        const functions = Object.values(fileCoverage.f) as number[];
        totalFunctions += functions.length;
        coveredFunctions += functions.filter(hits => hits > 0).length;
      }

      if (fileCoverage.s) {
        const statements = Object.values(fileCoverage.s) as number[];
        totalStatements += statements.length;
        coveredStatements += statements.filter(hits => hits > 0).length;
      }
    }

    return {
      lines: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
      branches: totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 0,
      functions: totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0,
      statements: totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0
    };
  }

  private displayResults(): void {
    console.log(chalk.bold.cyan('\n📊 Test Results Summary\n'));

    // Create results table
    const table = new Table({
      head: [
        chalk.cyan('Suite'),
        chalk.cyan('Type'),
        chalk.green('Passed'),
        chalk.red('Failed'),
        chalk.yellow('Skipped'),
        chalk.blue('Duration'),
        chalk.magenta('Coverage')
      ],
      style: {
        head: [],
        border: []
      }
    });

    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    for (const result of this.results) {
      totalPassed += result.passed;
      totalFailed += result.failed;
      totalSkipped += result.skipped;

      const coverage = result.coverage
        ? `L: ${result.coverage.lines.toFixed(1)}% | B: ${result.coverage.branches.toFixed(1)}%`
        : 'N/A';

      table.push([
        result.suite,
        result.type,
        chalk.green(result.passed.toString()),
        result.failed > 0 ? chalk.red(result.failed.toString()) : '0',
        result.skipped > 0 ? chalk.yellow(result.skipped.toString()) : '0',
        `${(result.duration / 1000).toFixed(2)}s`,
        coverage
      ]);
    }

    // Add totals row
    table.push([
      chalk.bold('Total'),
      '',
      chalk.bold.green(totalPassed.toString()),
      totalFailed > 0 ? chalk.bold.red(totalFailed.toString()) : chalk.bold('0'),
      totalSkipped > 0 ? chalk.bold.yellow(totalSkipped.toString()) : chalk.bold('0'),
      chalk.bold(`${((Date.now() - this.startTime) / 1000).toFixed(2)}s`),
      ''
    ]);

    console.log(table.toString());

    // Display summary statistics
    const totalTests = totalPassed + totalFailed + totalSkipped;
    const passRate = totalTests > 0 ? (totalPassed / totalTests) * 100 : 0;

    console.log(chalk.bold.cyan('\n📈 Summary Statistics\n'));
    console.log(`  Total Tests: ${totalTests}`);
    console.log(`  Pass Rate: ${passRate.toFixed(1)}%`);
    console.log(`  Total Duration: ${((Date.now() - this.startTime) / 1000).toFixed(2)} seconds`);

    if (totalFailed > 0) {
      console.log(chalk.red(`\n⚠️  ${totalFailed} tests failed`));
      process.exit(1);
    } else {
      console.log(chalk.green('\n✅ All tests passed!'));
      process.exit(0);
    }
  }
}

// Run tests if executed directly
if (require.main === module) {
  const runner = new TestRunner();
  runner.runAllTests().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

export { TestRunner };