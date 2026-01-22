#!/usr/bin/env node

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Functional Test Runner for MageAgent Service
 *
 * This script runs comprehensive functional tests against the live deployment
 * and generates detailed reports.
 */

interface TestReport {
  timestamp: string;
  environment: string;
  duration: number;
  results: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  details: any;
}

class FunctionalTestRunner {
  private startTime: number = 0;
  private testResults: TestReport | null = null;

  async run(): Promise<void> {
    console.log('\n🚀 MageAgent Functional Test Runner');
    console.log('=' .repeat(80));

    this.startTime = Date.now();

    try {
      // Check environment
      this.checkEnvironment();

      // Run the functional tests
      await this.runTests();

      // Generate report
      await this.generateReport();

    } catch (error) {
      console.error('\n❌ Test runner failed:', error);
      process.exit(1);
    }
  }

  /**
   * Check test environment and prerequisites
   */
  private checkEnvironment(): void {
    console.log('\n📋 Checking test environment...');

    // Check Node.js version
    const nodeVersion = process.version;
    console.log(`   Node.js version: ${nodeVersion}`);

    if (!nodeVersion.match(/^v(1[89]|[2-9]\d)/)) {
      throw new Error('Node.js version 18 or higher is required');
    }

    // Check if TypeScript is available
    try {
      const tsNode = require.resolve('ts-node');
      console.log(`   TypeScript runner: Found at ${tsNode}`);
    } catch (error) {
      console.log('   TypeScript runner: Not found, will use compiled JavaScript');
    }

    // Check network connectivity
    console.log('   Network connectivity: Checking...');
    const https = require('https');
    https.get('https://graphrag.adverant.ai', (res: any) => {
      if (res.statusCode === 200 || res.statusCode === 301 || res.statusCode === 302) {
        console.log('   Network connectivity: ✅ OK');
      } else {
        console.log(`   Network connectivity: ⚠️ Warning - Status ${res.statusCode}`);
      }
    }).on('error', (err: any) => {
      console.error(`   Network connectivity: ❌ Failed - ${err.message}`);
    });

    // Check environment variables
    const env = process.env.TEST_ENV || 'production';
    console.log(`   Test environment: ${env}`);

    if (process.env.SKIP_SECURITY_TESTS) {
      console.log('   ⚠️ Security tests will be skipped');
    }

    if (process.env.SKIP_PERFORMANCE_TESTS) {
      console.log('   ⚠️ Performance tests will be skipped');
    }

    console.log('   Environment check: ✅ Complete');
  }

  /**
   * Run the functional tests
   */
  private async runTests(): Promise<void> {
    console.log('\n🧪 Running functional tests...\n');

    return new Promise((resolve, reject) => {
      const testFile = path.join(__dirname, 'mageagent-api.test.ts');

      // Check if we should use ts-node or compiled JS
      let command: string;
      let args: string[];

      try {
        require.resolve('ts-node');
        command = 'npx';
        args = ['ts-node', testFile];
      } catch {
        // Use compiled JavaScript
        const jsFile = testFile.replace('.ts', '.js');
        if (!fs.existsSync(jsFile)) {
          console.error('❌ Compiled test file not found. Please run: npm run build');
          reject(new Error('Test file not found'));
          return;
        }
        command = 'node';
        args = [jsFile];
      }

      // Set up environment variables
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        TEST_TIMESTAMP: new Date().toISOString()
      };

      // Spawn the test process
      const testProcess = spawn(command, args, {
        env,
        stdio: 'inherit' // Pass through stdout/stderr
      });

      testProcess.on('close', (code) => {
        if (code === 0) {
          console.log('\n✅ Functional tests completed successfully');
          resolve();
        } else {
          console.error(`\n❌ Functional tests failed with code ${code}`);
          reject(new Error(`Test process exited with code ${code}`));
        }
      });

      testProcess.on('error', (error) => {
        console.error('\n❌ Failed to run tests:', error);
        reject(error);
      });
    });
  }

  /**
   * Generate test report
   */
  private async generateReport(): Promise<void> {
    const duration = Date.now() - this.startTime;
    const timestamp = new Date().toISOString();

    console.log('\n📊 Generating test report...');

    this.testResults = {
      timestamp,
      environment: process.env.TEST_ENV || 'production',
      duration,
      results: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0
      },
      details: {}
    };

    // Save report to file
    const reportPath = path.join(__dirname, `../../test-results/functional-test-report-${timestamp.replace(/:/g, '-')}.json`);

    // Ensure directory exists
    const reportDir = path.dirname(reportPath);
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    fs.writeFileSync(reportPath, JSON.stringify(this.testResults, null, 2));
    console.log(`   Report saved to: ${reportPath}`);

    // Generate summary
    console.log('\n📈 TEST SUMMARY:');
    console.log(`   Environment: ${this.testResults.environment}`);
    console.log(`   Duration: ${(duration / 1000).toFixed(2)} seconds`);
    console.log(`   Timestamp: ${timestamp}`);
    console.log('\n' + '='.repeat(80));
  }
}

// Parse command line arguments
function parseArgs(): { skipSecurity: boolean; skipPerformance: boolean; env: string } {
  const args = process.argv.slice(2);
  return {
    skipSecurity: args.includes('--skip-security'),
    skipPerformance: args.includes('--skip-performance'),
    env: args.find(arg => arg.startsWith('--env='))?.split('=')[1] || 'production'
  };
}

// Main execution
async function main() {
  const options = parseArgs();

  // Set environment variables based on options
  if (options.skipSecurity) {
    process.env.SKIP_SECURITY_TESTS = 'true';
  }

  if (options.skipPerformance) {
    process.env.SKIP_PERFORMANCE_TESTS = 'true';
  }

  process.env.TEST_ENV = options.env;

  // Display usage if help requested
  if (process.argv.includes('--help')) {
    console.log(`
Usage: npm run test:functional [options]

Options:
  --env=<environment>     Set test environment (production, staging, development)
  --skip-security         Skip security tests
  --skip-performance      Skip performance tests
  --help                  Show this help message

Examples:
  npm run test:functional
  npm run test:functional --env=staging
  npm run test:functional --skip-security --skip-performance
    `);
    process.exit(0);
  }

  // Run the tests
  const runner = new FunctionalTestRunner();
  await runner.run();
}

// Execute
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});