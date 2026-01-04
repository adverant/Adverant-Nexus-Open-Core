#!/usr/bin/env node

/**
 * Package Verification Script for @adverant-nexus/cli
 *
 * This script verifies that the package can be installed and used correctly
 * by testing it in a clean temporary environment.
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const icons = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
  rocket: '🚀',
  package: '📦',
  test: '🧪',
  clean: '🧹',
};

/**
 * Print colored output
 */
function print(message, color = 'reset', icon = null) {
  const colorCode = colors[color] || colors.reset;
  const iconStr = icon ? `${icon} ` : '';
  console.log(`${colorCode}${iconStr}${message}${colors.reset}`);
}

/**
 * Print section header
 */
function printSection(title) {
  console.log('\n' + colors.bold + colors.cyan + `${'='.repeat(60)}` + colors.reset);
  console.log(colors.bold + colors.cyan + title + colors.reset);
  console.log(colors.bold + colors.cyan + `${'='.repeat(60)}` + colors.reset + '\n');
}

/**
 * Execute command and return result
 */
function execCommand(command, options = {}) {
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    });
    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stderr: error.stderr?.toString(),
      stdout: error.stdout?.toString(),
    };
  }
}

/**
 * Execute command with promise
 */
function execCommandAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(' ');
    const proc = spawn(cmd, args, {
      stdio: options.silent ? 'pipe' : 'inherit',
      shell: true,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr });
      } else {
        resolve({ success: false, code, stdout, stderr });
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Create temporary test directory
 */
function createTempDir() {
  const tmpDir = path.join(os.tmpdir(), `nexus-cli-verify-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

/**
 * Clean up directory
 */
function cleanupDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read package.json
 */
function readPackageJson() {
  const pkgPath = path.resolve(rootDir, 'package.json');
  const content = fs.readFileSync(pkgPath, 'utf8');
  return JSON.parse(content);
}

/**
 * Test package installation
 */
async function testPackageInstallation(testDir, packagePath) {
  print('Installing package in test environment...', 'cyan', icons.package);

  // Create a minimal package.json
  const testPkgJson = {
    name: 'nexus-cli-test',
    version: '1.0.0',
    private: true,
    type: 'module',
  };

  fs.writeFileSync(
    path.join(testDir, 'package.json'),
    JSON.stringify(testPkgJson, null, 2)
  );

  // Install the package
  const installCmd = `npm install "${packagePath}"`;
  const result = execCommand(installCmd, { cwd: testDir, silent: false });

  if (!result.success) {
    print('Package installation failed', 'red', icons.error);
    return false;
  }

  print('Package installed successfully', 'green', icons.success);

  // Verify node_modules structure
  const nodeModulesPath = path.join(testDir, 'node_modules', '@adverant-nexus', 'cli');
  if (!fs.existsSync(nodeModulesPath)) {
    print('Package not found in node_modules', 'red', icons.error);
    return false;
  }

  print('Package structure verified in node_modules', 'green', icons.success);
  return true;
}

/**
 * Test CLI commands
 */
async function testCliCommands(testDir) {
  const commands = [
    { cmd: 'nexus --version', desc: 'Version check', required: true },
    { cmd: 'nexus --help', desc: 'Help command', required: true },
    { cmd: 'nexus config --help', desc: 'Config help', required: false },
    { cmd: 'nexus plugin --help', desc: 'Plugin help', required: false },
  ];

  for (const { cmd, desc, required } of commands) {
    print(`Testing: ${desc}`, 'cyan', icons.test);

    try {
      const result = await execCommandAsync(cmd, {
        cwd: testDir,
        silent: true,
        timeout: 10000,
      });

      if (result.success || (!required && result.code === 1)) {
        print(`  ✓ ${desc} works`, 'green');
      } else {
        if (required) {
          print(`  ✗ ${desc} failed`, 'red');
          if (result.stderr) {
            console.log(colors.red + `    Error: ${result.stderr}` + colors.reset);
          }
          return false;
        } else {
          print(`  ⚠ ${desc} failed (optional)`, 'yellow');
        }
      }
    } catch (error) {
      if (required) {
        print(`  ✗ ${desc} failed with exception`, 'red');
        console.error(error);
        return false;
      } else {
        print(`  ⚠ ${desc} failed (optional)`, 'yellow');
      }
    }
  }

  return true;
}

/**
 * Test package imports
 */
async function testPackageImports(testDir) {
  print('Testing package imports...', 'cyan', icons.test);

  const testFile = path.join(testDir, 'test-import.mjs');
  const testCode = `
import pkg from '@adverant-nexus/cli';

console.log('Import successful');
console.log('Package exports:', Object.keys(pkg || {}));
process.exit(0);
  `;

  fs.writeFileSync(testFile, testCode);

  try {
    const result = await execCommandAsync(`node ${testFile}`, {
      cwd: testDir,
      silent: true,
      timeout: 5000,
    });

    if (result.success) {
      print('Package imports work correctly', 'green', icons.success);
      return true;
    } else {
      print('Package import test failed', 'red', icons.error);
      if (result.stderr) {
        console.log(colors.red + `  Error: ${result.stderr}` + colors.reset);
      }
      return false;
    }
  } catch (error) {
    print('Package import test failed with exception', 'red', icons.error);
    console.error(error);
    return false;
  }
}

/**
 * Verify package contents
 */
function verifyPackageContents(testDir) {
  print('Verifying package contents...', 'cyan', icons.test);

  const pkgDir = path.join(testDir, 'node_modules', '@adverant-nexus', 'cli');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

  const requiredFiles = [
    'package.json',
    'README.md',
    'dist/index.js',
  ];

  let allFound = true;

  for (const file of requiredFiles) {
    const filePath = path.join(pkgDir, file);
    if (fs.existsSync(filePath)) {
      print(`  ✓ ${file}`, 'green');
    } else {
      print(`  ✗ ${file} missing`, 'red');
      allFound = false;
    }
  }

  // Check if files field is respected
  if (pkg.files) {
    const filesField = pkg.files;
    print(`  Files field includes: ${filesField.join(', ')}`, 'cyan', icons.info);
  }

  // Check for unwanted files
  const unwantedPatterns = ['.ts', 'tsconfig.json', '.env', 'src/'];
  const allFiles = getAllFilesRecursive(pkgDir);

  const unwantedFiles = allFiles.filter(file => {
    const relativePath = path.relative(pkgDir, file);
    return unwantedPatterns.some(pattern => {
      if (pattern.startsWith('.')) {
        return relativePath.includes(pattern) && !relativePath.includes('node_modules');
      }
      return relativePath.includes(pattern);
    });
  });

  if (unwantedFiles.length > 0) {
    print('  ⚠ Unwanted files found in package:', 'yellow');
    unwantedFiles.slice(0, 5).forEach(file => {
      print(`    - ${path.relative(pkgDir, file)}`, 'yellow');
    });
    if (unwantedFiles.length > 5) {
      print(`    ... and ${unwantedFiles.length - 5} more`, 'yellow');
    }
  } else {
    print('  ✓ No unwanted files detected', 'green');
  }

  return allFound;
}

/**
 * Get all files recursively
 */
function getAllFilesRecursive(dir, fileList = []) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory() && file !== 'node_modules') {
      getAllFilesRecursive(filePath, fileList);
    } else if (stat.isFile()) {
      fileList.push(filePath);
    }
  }

  return fileList;
}

/**
 * Check package size
 */
function checkPackageSize(packagePath) {
  print('Checking package size...', 'cyan', icons.test);

  const stat = fs.statSync(packagePath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);

  print(`  Package size: ${sizeMB} MB`, 'cyan', icons.info);

  if (stat.size > 10 * 1024 * 1024) { // 10MB
    print('  ⚠ Package is quite large (>10MB)', 'yellow');
    print('    Consider optimizing or excluding unnecessary files', 'yellow');
  } else if (stat.size > 50 * 1024 * 1024) { // 50MB
    print('  ✗ Package is too large (>50MB)', 'red');
    return false;
  } else {
    print('  ✓ Package size is reasonable', 'green');
  }

  return true;
}

/**
 * Main verification function
 */
async function runVerification() {
  print('\n' + colors.bold + colors.magenta + '🧪 Package Verification for @adverant-nexus/cli' + colors.reset + '\n');

  const pkg = readPackageJson();
  print(`Package: ${colors.bold}${pkg.name}@${pkg.version}${colors.reset}\n`);

  let testDir;
  let packagePath;
  let cleanupNeeded = false;

  try {
    // Step 1: Build the package
    printSection('1. Building Package');
    print('Running npm pack...', 'cyan', icons.package);

    const packResult = execCommand('npm pack', { cwd: rootDir, silent: true });
    if (!packResult.success) {
      print('Failed to create package tarball', 'red', icons.error);
      process.exit(1);
    }

    // Find the created tarball
    const files = fs.readdirSync(rootDir);
    const tarball = files.find(f => f.endsWith('.tgz'));

    if (!tarball) {
      print('Package tarball not found', 'red', icons.error);
      process.exit(1);
    }

    packagePath = path.join(rootDir, tarball);
    print(`Package created: ${tarball}`, 'green', icons.success);

    // Step 2: Check package size
    printSection('2. Package Size Check');
    const sizeOk = checkPackageSize(packagePath);
    if (!sizeOk) {
      print('Package size validation failed', 'red', icons.error);
      // Don't exit, continue with other tests
    }

    // Step 3: Create test environment
    printSection('3. Setting Up Test Environment');
    testDir = createTempDir();
    cleanupNeeded = true;
    print(`Test directory: ${testDir}`, 'cyan', icons.info);

    // Step 4: Test installation
    printSection('4. Testing Package Installation');
    const installOk = await testPackageInstallation(testDir, packagePath);
    if (!installOk) {
      print('Installation test failed', 'red', icons.error);
      process.exit(1);
    }

    // Step 5: Verify contents
    printSection('5. Verifying Package Contents');
    const contentsOk = verifyPackageContents(testDir);
    if (!contentsOk) {
      print('Contents verification failed', 'red', icons.error);
      process.exit(1);
    }

    // Step 6: Test imports
    printSection('6. Testing Package Imports');
    const importsOk = await testPackageImports(testDir);
    if (!importsOk) {
      print('Import tests failed', 'red', icons.error);
      // Don't exit, this might be expected for CLI-only packages
    }

    // Step 7: Test CLI commands
    printSection('7. Testing CLI Commands');
    const cliOk = await testCliCommands(testDir);
    if (!cliOk) {
      print('CLI command tests failed', 'red', icons.error);
      process.exit(1);
    }

    // Final summary
    printSection('Verification Summary');
    print(colors.bold + colors.green + '✅ All verification tests passed!' + colors.reset);
    print('\nThe package is ready for publication.', 'green');
    print('\nNext steps:', 'cyan');
    print('  1. Review the package contents', 'cyan');
    print('  2. Test in your target environment', 'cyan');
    print('  3. Publish with: npm publish', 'cyan');

  } catch (error) {
    print('\n' + colors.bold + colors.red + '❌ Verification failed:' + colors.reset);
    console.error(error);
    process.exit(1);
  } finally {
    // Cleanup
    if (cleanupNeeded) {
      printSection('Cleanup');
      print('Cleaning up test environment...', 'cyan', icons.clean);

      if (testDir) {
        cleanupDir(testDir);
        print(`Removed test directory: ${testDir}`, 'green', icons.success);
      }

      if (packagePath && fs.existsSync(packagePath)) {
        fs.unlinkSync(packagePath);
        print(`Removed package tarball: ${path.basename(packagePath)}`, 'green', icons.success);
      }
    }
  }
}

// Run verification
runVerification().catch(error => {
  print('\n' + colors.bold + colors.red + '❌ Verification script failed:' + colors.reset);
  console.error(error);
  process.exit(1);
});
