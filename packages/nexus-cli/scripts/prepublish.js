#!/usr/bin/env node

/**
 * Pre-publish Validation Script for @adverant-nexus/cli
 *
 * This script validates that the package is ready for publication to npm.
 * It checks compilation, files, metadata, and more.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
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
};

// Validation results tracking
const results = {
  passed: [],
  warnings: [],
  errors: [],
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
 * Print validation result
 */
function printResult(passed, message, details = null) {
  if (passed) {
    print(message, 'green', icons.success);
    results.passed.push(message);
  } else {
    print(message, 'red', icons.error);
    results.errors.push(message);
  }
  if (details) {
    console.log(colors.cyan + `  ${details}` + colors.reset);
  }
}

/**
 * Print warning
 */
function printWarning(message, details = null) {
  print(message, 'yellow', icons.warning);
  results.warnings.push(message);
  if (details) {
    console.log(colors.yellow + `  ${details}` + colors.reset);
  }
}

/**
 * Execute command and return result
 */
function execCommand(command, options = {}) {
  try {
    const output = execSync(command, {
      cwd: rootDir,
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
 * Check if file or directory exists
 */
function fileExists(filePath) {
  return fs.existsSync(path.resolve(rootDir, filePath));
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
 * Check for sensitive patterns in files
 */
function checkForSensitiveData() {
  const sensitivePatterns = [
    /(?:api[_-]?key|apikey)[\s]*[:=][\s]*['"][^'"]+['"]/gi,
    /(?:secret|password|passwd|pwd)[\s]*[:=][\s]*['"][^'"]+['"]/gi,
    /(?:token|auth)[\s]*[:=][\s]*['"][^'"]+['"]/gi,
    /(?:private[_-]?key)[\s]*[:=][\s]*['"][^'"]+['"]/gi,
    /-----BEGIN (?:RSA |DSA )?PRIVATE KEY-----/gi,
    /sk_live_[a-zA-Z0-9]+/gi, // Stripe keys
    /AIza[0-9A-Za-z-_]{35}/gi, // Google API keys
    /ghp_[a-zA-Z0-9]{36}/gi, // GitHub Personal Access Tokens
  ];

  const filesToCheck = [];
  const dirsToScan = ['dist', 'src'];

  for (const dir of dirsToScan) {
    const dirPath = path.resolve(rootDir, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = getAllFiles(dirPath);
    filesToCheck.push(...files);
  }

  const findings = [];

  for (const file of filesToCheck) {
    // Skip large files and node_modules
    if (file.includes('node_modules') || file.endsWith('.min.js')) continue;

    try {
      const content = fs.readFileSync(file, 'utf8');

      for (const pattern of sensitivePatterns) {
        const matches = content.match(pattern);
        if (matches) {
          findings.push({
            file: path.relative(rootDir, file),
            pattern: pattern.toString(),
            matches: matches.length,
          });
        }
      }
    } catch (error) {
      // Skip files that can't be read as text
      continue;
    }
  }

  return findings;
}

/**
 * Get all files recursively
 */
function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      getAllFiles(filePath, fileList);
    } else {
      fileList.push(filePath);
    }
  }

  return fileList;
}

/**
 * Check directory size
 */
function getDirectorySize(dirPath) {
  let size = 0;

  if (!fs.existsSync(dirPath)) return 0;

  const files = getAllFiles(dirPath);
  for (const file of files) {
    const stat = fs.statSync(file);
    size += stat.size;
  }

  return size;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Validate package.json metadata
 */
function validatePackageJson(pkg) {
  const requiredFields = [
    'name',
    'version',
    'description',
    'main',
    'bin',
    'author',
    'license',
    'repository',
    'keywords',
    'engines',
  ];

  for (const field of requiredFields) {
    if (!pkg[field]) {
      printResult(false, `Missing required field: ${field}`);
    } else {
      printResult(true, `Required field present: ${field}`);
    }
  }

  // Check version format
  const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
  if (!versionRegex.test(pkg.version)) {
    printResult(false, `Invalid version format: ${pkg.version}`, 'Should be semver (e.g., 1.0.0, 1.0.0-beta.1)');
  } else {
    printResult(true, `Valid version format: ${pkg.version}`);
  }

  // Check package name format
  if (pkg.name.startsWith('@')) {
    const scopedRegex = /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$/;
    if (!scopedRegex.test(pkg.name)) {
      printResult(false, `Invalid scoped package name: ${pkg.name}`);
    } else {
      printResult(true, `Valid scoped package name: ${pkg.name}`);
    }
  }

  // Check keywords
  if (pkg.keywords && pkg.keywords.length > 0) {
    printResult(true, `Keywords defined: ${pkg.keywords.length} keywords`);
  } else {
    printWarning('No keywords defined', 'Add keywords to improve discoverability');
  }

  // Check files field
  if (pkg.files && pkg.files.length > 0) {
    printResult(true, `Files field defined: ${pkg.files.length} patterns`);
  } else {
    printWarning('No files field defined', 'Consider adding a files field to control what gets published');
  }

  // Check engines
  if (pkg.engines && pkg.engines.node) {
    printResult(true, `Node.js version requirement: ${pkg.engines.node}`);
  } else {
    printWarning('No Node.js version specified in engines');
  }

  // Check publishConfig
  if (pkg.publishConfig) {
    printResult(true, 'publishConfig defined');
    if (pkg.publishConfig.access === 'public') {
      print('  Access: public', 'cyan');
    }
  }
}

/**
 * Main validation runner
 */
async function runValidation() {
  print('\n' + colors.bold + colors.magenta + '🚀 Pre-Publish Validation for @adverant-nexus/cli' + colors.reset + '\n');

  const pkg = readPackageJson();
  print(`Package: ${colors.bold}${pkg.name}@${pkg.version}${colors.reset}\n`);

  // 1. Check TypeScript compilation
  printSection('1. TypeScript Compilation');
  print('Running TypeScript compiler...');
  const tscResult = execCommand('npm run typecheck', { silent: false });
  if (tscResult.success) {
    printResult(true, 'TypeScript compilation successful');
  } else {
    printResult(false, 'TypeScript compilation failed');
  }

  // 2. Check required files
  printSection('2. Required Files Check');
  const requiredFiles = [
    { path: 'dist', type: 'directory', required: true },
    { path: 'README.md', type: 'file', required: true },
    { path: 'LICENSE', type: 'file', required: false },
    { path: 'package.json', type: 'file', required: true },
    { path: 'dist/index.js', type: 'file', required: true },
  ];

  for (const { path: filePath, type, required } of requiredFiles) {
    const exists = fileExists(filePath);
    if (required) {
      printResult(exists, `${type}: ${filePath}`, exists ? 'Found' : 'Missing');
    } else {
      if (exists) {
        printResult(true, `${type}: ${filePath}`, 'Found');
      } else {
        printWarning(`Optional ${type} not found: ${filePath}`);
      }
    }
  }

  // 3. Check build output
  printSection('3. Build Output Validation');
  const distPath = path.resolve(rootDir, 'dist');
  if (fs.existsSync(distPath)) {
    const distSize = getDirectorySize(distPath);
    print(`Build size: ${formatBytes(distSize)}`, 'cyan', icons.info);

    if (distSize > 10 * 1024 * 1024) { // 10MB
      printWarning('Build size exceeds 10MB', 'Consider optimizing bundle size');
    } else {
      printResult(true, 'Build size is reasonable');
    }

    // Check for source maps
    const hasSourceMaps = getAllFiles(distPath).some(f => f.endsWith('.map'));
    if (hasSourceMaps) {
      printWarning('Source maps found in dist/', 'Consider excluding .map files to reduce package size');
    }
  }

  // 4. Validate package.json
  printSection('4. Package.json Validation');
  validatePackageJson(pkg);

  // 5. Check for sensitive data
  printSection('5. Sensitive Data Check');
  print('Scanning for potential secrets...');
  const sensitiveFindings = checkForSensitiveData();

  if (sensitiveFindings.length > 0) {
    printResult(false, 'Potential sensitive data found:');
    sensitiveFindings.forEach(finding => {
      print(`  ${finding.file}: ${finding.matches} match(es)`, 'red');
    });
  } else {
    printResult(true, 'No sensitive data patterns detected');
  }

  // 6. Verify dependencies
  printSection('6. Dependencies Validation');

  // Check for missing dependencies
  print('Checking for missing dependencies...');
  const depsCheck = execCommand('npm ls --depth=0', { silent: true });
  if (depsCheck.success) {
    printResult(true, 'All dependencies are installed');
  } else {
    if (depsCheck.stderr && depsCheck.stderr.includes('missing')) {
      printResult(false, 'Missing dependencies detected', 'Run: npm install');
    } else {
      printWarning('Unable to verify dependencies');
    }
  }

  // Check for outdated dependencies
  print('Checking for outdated dependencies...');
  const outdatedCheck = execCommand('npm outdated --json', { silent: true });
  if (outdatedCheck.output) {
    try {
      const outdated = JSON.parse(outdatedCheck.output);
      const outdatedCount = Object.keys(outdated).length;
      if (outdatedCount > 0) {
        printWarning(`${outdatedCount} outdated dependencies found`, 'Run: npm outdated');
      } else {
        printResult(true, 'All dependencies are up to date');
      }
    } catch (e) {
      printResult(true, 'All dependencies are up to date');
    }
  }

  // 7. Run tests
  printSection('7. Test Suite');
  if (pkg.scripts && pkg.scripts.test) {
    print('Running test suite...');
    const testResult = execCommand('npm test', { silent: true });
    if (testResult.success) {
      printResult(true, 'All tests passed');
    } else {
      // Check if it's a "no tests found" error
      const stderr = testResult.stderr || '';
      const stdout = testResult.stdout || '';
      const noTestsFound = stderr.includes('No tests found') || stdout.includes('No tests found');

      if (noTestsFound) {
        printWarning('No test files found', 'Consider adding tests before publishing');
      } else {
        printResult(false, 'Some tests failed');
        if (stderr) {
          console.log(colors.red + '  Error output:' + colors.reset);
          console.log(stderr);
        }
      }
    }
  } else {
    printWarning('No test script defined', 'Consider adding tests before publishing');
  }

  // 8. Run linter
  printSection('8. Code Quality');
  if (pkg.scripts && pkg.scripts.lint) {
    print('Running linter...');
    const lintResult = execCommand('npm run lint', { silent: true });
    if (lintResult.success) {
      printResult(true, 'Linting passed');
    } else {
      printWarning('Linting issues found', 'Run: npm run lint:fix');
    }
  } else {
    printWarning('No lint script defined');
  }

  // 9. Check .npmignore
  printSection('9. Package Contents');
  const npmignorePath = path.resolve(rootDir, '.npmignore');
  if (fs.existsSync(npmignorePath)) {
    printResult(true, '.npmignore file exists');
    const npmignore = fs.readFileSync(npmignorePath, 'utf8');

    const shouldIgnore = [
      { pattern: 'src', name: 'source files' },
      { pattern: 'test', name: 'test files' },
      { pattern: '.git', name: 'git files' },
      { pattern: 'tsconfig', name: 'TypeScript config' },
      { pattern: '.env', name: 'environment files' },
    ];

    for (const { pattern, name } of shouldIgnore) {
      if (npmignore.includes(pattern)) {
        print(`  ✓ Ignoring ${name}`, 'green');
      } else {
        printWarning(`  Consider ignoring ${name}`);
      }
    }
  } else {
    printWarning('.npmignore not found', 'Will use .gitignore or files field');
  }

  // 10. Dry run pack
  printSection('10. Package Simulation');
  print('Running npm pack --dry-run...');
  const packResult = execCommand('npm pack --dry-run', { silent: true });
  if (packResult.success) {
    printResult(true, 'Package simulation successful');
    if (packResult.stdout) {
      const lines = packResult.stdout.split('\n');
      const fileCount = lines.filter(l => l.trim() && !l.includes('npm notice')).length;
      print(`  ${fileCount} files will be published`, 'cyan', icons.info);
    }
  } else {
    printResult(false, 'Package simulation failed');
  }

  // Final summary
  printSection('Validation Summary');
  print(`${colors.bold}Results:${colors.reset}`);
  print(`  ${colors.green}${icons.success} Passed: ${results.passed.length}${colors.reset}`);
  print(`  ${colors.yellow}${icons.warning} Warnings: ${results.warnings.length}${colors.reset}`);
  print(`  ${colors.red}${icons.error} Errors: ${results.errors.length}${colors.reset}`);

  if (results.errors.length > 0) {
    print('\n' + colors.bold + colors.red + '❌ Validation failed. Please fix the errors above before publishing.' + colors.reset);
    process.exit(1);
  } else if (results.warnings.length > 0) {
    print('\n' + colors.bold + colors.yellow + '⚠️  Validation passed with warnings. Review warnings before publishing.' + colors.reset);
    process.exit(0);
  } else {
    print('\n' + colors.bold + colors.green + '✅ All validations passed! Package is ready to publish.' + colors.reset);
    process.exit(0);
  }
}

// Run validation
runValidation().catch(error => {
  print('\n' + colors.bold + colors.red + '❌ Validation script failed:' + colors.reset);
  console.error(error);
  process.exit(1);
});
