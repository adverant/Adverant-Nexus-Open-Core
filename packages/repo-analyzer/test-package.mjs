#!/usr/bin/env node

/**
 * Comprehensive test suite for @adverant/repo-analyzer
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Get package directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import the package
const { RepoManager, TypeDetector, OutputGenerator, RepositoryAnalyzer } = await import('./dist/index.js');

// Test counters
let passed = 0;
let failed = 0;

// Color codes for terminal output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

/**
 * Run a test case
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`${colors.green}  ✓ ${name}${colors.reset}`);
  } catch (error) {
    failed++;
    console.log(`${colors.red}  ✗ ${name}${colors.reset}`);
    console.error(`    Error: ${error.message}`);
  }
}

/**
 * Assert helper
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

console.log(`\n${colors.cyan}${colors.bold}@adverant/repo-analyzer Test Suite${colors.reset}\n`);

// ============================================
// TEST 1: RepoManager URL Parsing
// ============================================
console.log(`${colors.cyan}${colors.bold}TEST: RepoManager URL Parsing${colors.reset}`);

const repoManager = new RepoManager();

await test('GitHub HTTPS URL parsed correctly', async () => {
  const result = repoManager.parseRepoUrl('https://github.com/adverant/adverant-nexus');
  assert(result.isValid, 'Should be valid');
  assert(result.platform === 'github', 'Platform should be github');
  assert(result.owner === 'adverant', 'Owner should be adverant');
  assert(result.name === 'adverant-nexus', 'Name should be adverant-nexus');
});

await test('GitHub SSH URL parsed correctly', async () => {
  const result = repoManager.parseRepoUrl('git@github.com:adverant/adverant-nexus.git');
  assert(result.isValid, 'Should be valid');
  assert(result.platform === 'github', 'Platform should be github');
  assert(result.owner === 'adverant', 'Owner should be adverant');
});

await test('GitLab URL parsed correctly', async () => {
  const result = repoManager.parseRepoUrl('https://gitlab.com/group/project');
  assert(result.isValid, 'Should be valid');
  assert(result.platform === 'gitlab', 'Platform should be gitlab');
});

await test('Invalid URL correctly rejected', async () => {
  const result = repoManager.parseRepoUrl('not-a-valid-url');
  assert(!result.isValid, 'Should be invalid');
  assert(result.error, 'Should have error message');
});

await test('Local path parsed correctly', async () => {
  const result = repoManager.parseRepoUrl(__dirname);
  assert(result.isValid, 'Should be valid');
  assert(result.platform === 'local', 'Platform should be local');
  assert(result.localPath === __dirname, 'Local path should match');
});

await test('file:// URL parsed correctly', async () => {
  const result = repoManager.parseRepoUrl(`file://${__dirname}`);
  assert(result.isValid, 'Should be valid');
  assert(result.platform === 'local', 'Platform should be local');
});

// ============================================
// TEST 2: RepoManager Directory Structure
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: RepoManager Directory Structure${colors.reset}`);

await test('Directory structure returned correctly', async () => {
  const structure = repoManager.getDirectoryStructure(__dirname, 2);
  assert(structure.type === 'directory', 'Root should be directory');
  assert(structure.name === 'repo-analyzer', 'Name should match');
  assert(Array.isArray(structure.children), 'Should have children');
});

await test('Expected files found in structure', async () => {
  const structure = repoManager.getDirectoryStructure(__dirname, 2);
  const fileNames = structure.children?.map(c => c.name) ?? [];
  assert(fileNames.includes('package.json'), 'Should find package.json');
  assert(fileNames.includes('src'), 'Should find src directory');
});

// ============================================
// TEST 3: RepoManager File Listing
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: RepoManager File Listing${colors.reset}`);

await test('File listing works correctly', async () => {
  const files = repoManager.listFiles(__dirname, { maxFiles: 50 });
  assert(Array.isArray(files), 'Should return array');
  assert(files.length > 0, 'Should find files');
});

await test('File metadata is correct', async () => {
  const files = repoManager.listFiles(__dirname, { extensions: ['.ts'] });
  const tsFile = files.find(f => f.extension === '.ts');
  assert(tsFile, 'Should find TypeScript file');
  assert(tsFile.language === 'typescript', 'Language should be typescript');
});

// ============================================
// TEST 4: RepoManager File Reading
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: RepoManager File Reading${colors.reset}`);

await test('File content read correctly', async () => {
  const content = repoManager.readFile(__dirname, 'package.json');
  assert(content, 'Should read content');
  assert(content.includes('@adverant/repo-analyzer'), 'Should contain package name');
});

await test('JSON file parsed correctly', async () => {
  const json = repoManager.readJsonFile(__dirname, 'package.json');
  assert(json, 'Should parse JSON');
  assert(json.name === '@adverant/repo-analyzer', 'Should have correct name');
});

await test('Non-existent file returns null', async () => {
  const content = repoManager.readFile(__dirname, 'non-existent-file.xyz');
  assert(content === null, 'Should return null for missing file');
});

// ============================================
// TEST 5: TypeDetector Detection
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: TypeDetector Detection${colors.reset}`);

const typeDetector = new TypeDetector(repoManager, __dirname);

await test('Repository type detected correctly', async () => {
  const result = await typeDetector.detect();
  assert(result.primaryType, 'Should have primary type');
  assert(result.confidence >= 0 && result.confidence <= 1, 'Confidence should be 0-1');
  console.log(`${colors.yellow}    Detected: ${result.primaryType} (${Math.round(result.confidence * 100)}%)${colors.reset}`);
});

await test('Tech stack detected correctly', async () => {
  const result = await typeDetector.detect();
  assert(Array.isArray(result.techStack), 'Should have tech stack array');
  assert(result.techStack.includes('typescript'), 'Should detect TypeScript');
  console.log(`${colors.yellow}    Tech stack: ${result.techStack.join(', ')}${colors.reset}`);
});

await test('Quick detection works', async () => {
  const result = await typeDetector.quickDetect();
  assert(result.type, 'Should have type');
  assert(typeof result.confidence === 'number', 'Should have confidence');
});

// ============================================
// TEST 6: OutputGenerator Markdown Generation
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: OutputGenerator Markdown Generation${colors.reset}`);

const outputGenerator = new OutputGenerator();

await test('Markdown generated from minimal result', async () => {
  const minimalResult = {
    detectedType: { primaryType: 'library', confidence: 0.9, techStack: ['typescript'], indicators: [] },
    techStack: ['typescript', 'javascript'],
    architecture: {
      pattern: 'unknown',
      patternConfidence: 0.5,
      layers: [],
      components: [],
      dependencies: { nodes: [], edges: [], externalDependencies: [] },
    },
    findings: [],
    recommendations: [],
    archMd: '',
    repositoryInfo: { url: 'https://github.com/test/test', platform: 'github', owner: 'test', name: 'test', branch: 'main' },
    repositoryMetadata: { sizeBytes: 1024, fileCount: 10, directoryCount: 5 },
    directoryStructure: { path: '/', name: 'root', type: 'directory' },
  };

  const markdown = outputGenerator.generateMarkdown(minimalResult);
  assert(markdown.includes('# test Architecture'), 'Should include repo name in title');
  assert(markdown.includes('Library'), 'Should include detected type');
  assert(markdown.includes('typescript'), 'Should include tech stack');
});

await test('JSON output is valid JSON', async () => {
  const minimalResult = {
    detectedType: { primaryType: 'library', confidence: 0.9, techStack: [], indicators: [] },
    techStack: [],
    architecture: { pattern: 'unknown', patternConfidence: 0, layers: [], components: [], dependencies: { nodes: [], edges: [], externalDependencies: [] } },
    findings: [],
    recommendations: [],
    archMd: '',
    repositoryInfo: { url: '', platform: 'github', owner: '', name: '', branch: 'main' },
    repositoryMetadata: { sizeBytes: 0, fileCount: 0, directoryCount: 0 },
    directoryStructure: { path: '/', name: 'root', type: 'directory' },
  };

  const json = outputGenerator.generateJson(minimalResult);
  const parsed = JSON.parse(json);
  assert(parsed.detectedType, 'Should have detectedType');
});

await test('HTML output contains required structure', async () => {
  const minimalResult = {
    detectedType: { primaryType: 'library', confidence: 0.9, techStack: [], indicators: [] },
    techStack: [],
    architecture: { pattern: 'unknown', patternConfidence: 0, layers: [], components: [], dependencies: { nodes: [], edges: [], externalDependencies: [] } },
    findings: [],
    recommendations: [],
    archMd: '',
    repositoryInfo: { url: '', platform: 'github', owner: '', name: 'TestRepo', branch: 'main' },
    repositoryMetadata: { sizeBytes: 0, fileCount: 0, directoryCount: 0 },
    directoryStructure: { path: '/', name: 'root', type: 'directory' },
  };

  const html = outputGenerator.generateHtml(minimalResult);
  assert(html.includes('<!DOCTYPE html>'), 'Should have DOCTYPE');
  assert(html.includes('TestRepo'), 'Should include repo name');
});

// ============================================
// TEST 7: RepositoryAnalyzer Instantiation
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: RepositoryAnalyzer Instantiation${colors.reset}`);

await test('Analyzer creates successfully with defaults', async () => {
  const analyzer = new RepositoryAnalyzer();
  assert(analyzer, 'Should create analyzer');
});

await test('Analyzer creates with custom config', async () => {
  const analyzer = new RepositoryAnalyzer({
    mageAgentUrl: 'http://localhost:9010',
    graphRagUrl: 'http://localhost:8090',
    enableAiAnalysis: false,
  });
  assert(analyzer, 'Should create analyzer with config');
});

// ============================================
// TEST 8: RepositoryAnalyzer Type Detection
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: RepositoryAnalyzer Type Detection${colors.reset}`);

await test('detectType works on local path', async () => {
  const analyzer = new RepositoryAnalyzer({ enableAiAnalysis: false });
  const result = await analyzer.detectType(__dirname);
  assert(result.primaryType, 'Should have primary type');
  assert(result.techStack.includes('typescript'), 'Should detect TypeScript');
  console.log(`${colors.yellow}    Detected: ${result.primaryType} (${Math.round(result.confidence * 100)}%)${colors.reset}`);
});

// ============================================
// TEST 9: Full Analysis (Local, No AI)
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: Full Analysis (Local, No AI)${colors.reset}`);

await test('Full analysis completes on local path', async () => {
  const analyzer = new RepositoryAnalyzer({ enableAiAnalysis: false });

  let progressUpdates = 0;
  const analysis = await analyzer.analyze(
    { repoUrl: __dirname, analysisDepth: 'quick' },
    undefined,
    (progress) => {
      progressUpdates++;
    }
  );

  assert(analysis.status === 'completed', `Should complete, got: ${analysis.status} - ${analysis.errorMessage || ''}`);
  assert(analysis.result, 'Should have result');
  assert(analysis.result.archMd, 'Should have generated markdown');
  assert(progressUpdates > 0, 'Should have progress updates');
  console.log(`${colors.yellow}    Duration: ${analysis.usage.durationMs}ms, Files: ${analysis.usage.filesAnalyzed}${colors.reset}`);
});

await test('Analysis result contains expected fields', async () => {
  const analyzer = new RepositoryAnalyzer({ enableAiAnalysis: false });
  const analysis = await analyzer.analyze({ repoUrl: __dirname, analysisDepth: 'quick' });

  assert(analysis.result?.detectedType, 'Should have detectedType');
  assert(analysis.result?.techStack, 'Should have techStack');
  assert(analysis.result?.architecture, 'Should have architecture');
  assert(analysis.result?.repositoryInfo, 'Should have repositoryInfo');
  assert(analysis.result?.repositoryMetadata, 'Should have repositoryMetadata');
});

// ============================================
// TEST 10: Error Handling
// ============================================
console.log(`\n${colors.cyan}${colors.bold}TEST: Error Handling${colors.reset}`);

await test('Invalid URL returns failed analysis', async () => {
  const analyzer = new RepositoryAnalyzer({ enableAiAnalysis: false });
  const analysis = await analyzer.analyze({ repoUrl: 'https://github.com/invalid/nonexistent-repo-xyz123' });
  assert(analysis.status === 'failed', 'Should fail');
  assert(analysis.errorMessage, 'Should have error message');
});

await test('Non-existent local path returns failed analysis', async () => {
  const analyzer = new RepositoryAnalyzer({ enableAiAnalysis: false });
  const analysis = await analyzer.analyze({ repoUrl: '/nonexistent/path/xyz123' });
  assert(analysis.status === 'failed', 'Should fail');
});

// ============================================
// Summary
// ============================================
console.log(`\n${'='.repeat(50)}`);
console.log(`${colors.reset}`);
console.log(`${colors.bold}TEST SUMMARY${colors.reset}`);
console.log(`${colors.green}  Passed: ${passed}${colors.reset}`);
console.log(`${colors.red}  Failed: ${failed}${colors.reset}`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);