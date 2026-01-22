#!/usr/bin/env tsx
/**
 * Knowledge Base Bootstrap Script
 *
 * Seeds the GraphRAG knowledge base with foundational documents:
 * 1. Local seed documents (RAG concepts, LLM fundamentals, etc.)
 * 2. Internal README documentation
 * 3. External resources (arXiv papers, documentation sites)
 *
 * Usage:
 *   npm run bootstrap           # Full bootstrap
 *   npm run bootstrap:dry-run   # Preview without storing
 */

import * as fs from 'fs';
import * as path from 'path';

// Configuration
const GRAPHRAG_URL = process.env.GRAPHRAG_URL || 'http://localhost:8090';
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

interface BootstrapResult {
  success: boolean;
  documentId?: string;
  title: string;
  error?: string;
}

interface BootstrapSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  results: BootstrapResult[];
}

// Seed document definitions
const SEED_DOCUMENTS_DIR = path.join(__dirname, 'seed-documents');

// Internal README files to ingest
const INTERNAL_DOCS = [
  {
    path: '../../nexus-graphrag-enhanced/README.md',
    title: 'GraphRAG Enhanced Service Documentation',
    tags: ['nexus', 'graphrag', 'rag-enhancement', 'documentation'],
  },
  {
    path: '../README.md',
    title: 'GraphRAG Core Service Documentation',
    tags: ['nexus', 'graphrag', 'hybrid-search', 'documentation'],
  },
  {
    path: '../../nexus-gateway/README.md',
    title: 'Nexus API Gateway Documentation',
    tags: ['nexus', 'gateway', 'api', 'documentation'],
  },
  {
    path: '../../nexus-mageagent/README.md',
    title: 'MageAgent Multi-Agent Orchestration Documentation',
    tags: ['nexus', 'mageagent', 'multi-agent', 'documentation'],
  },
];

// External URLs to ingest (optional - may fail if service doesn't support)
const EXTERNAL_URLS = [
  {
    url: 'https://arxiv.org/abs/2312.10997',
    title: 'RAG Survey Paper (arXiv)',
    tags: ['research', 'rag', 'survey', 'academic'],
  },
  {
    url: 'https://docs.voyageai.com/',
    title: 'Voyage AI Documentation',
    tags: ['embeddings', 'voyage-ai', 'documentation'],
  },
];

function log(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
  const prefix = {
    info: `${colors.cyan}[INFO]${colors.reset}`,
    success: `${colors.green}[SUCCESS]${colors.reset}`,
    error: `${colors.red}[ERROR]${colors.reset}`,
    warning: `${colors.yellow}[WARNING]${colors.reset}`,
  };
  console.log(`${prefix[type]} ${message}`);
}

function logVerbose(message: string): void {
  if (VERBOSE) {
    console.log(`${colors.dim}  ${message}${colors.reset}`);
  }
}

async function storeDocument(
  content: string,
  title: string,
  tags: string[],
  source: string
): Promise<BootstrapResult> {
  if (DRY_RUN) {
    log(`[DRY RUN] Would store: ${title}`, 'info');
    logVerbose(`  Content length: ${content.length} chars`);
    logVerbose(`  Tags: ${tags.join(', ')}`);
    return { success: true, title, documentId: 'dry-run' };
  }

  try {
    const response = await fetch(`${GRAPHRAG_URL}/graphrag/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content,
        title,
        type: 'text',
        format: 'markdown',
        metadata: {
          source,
          category: 'foundational-knowledge',
          tags,
          bootstrapped: true,
          bootstrapDate: new Date().toISOString(),
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        title,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const result = await response.json();
    return {
      success: true,
      title,
      documentId: result.documentId || result.id,
    };
  } catch (error: any) {
    return {
      success: false,
      title,
      error: error.message,
    };
  }
}

async function ingestUrl(
  url: string,
  title: string,
  tags: string[]
): Promise<BootstrapResult> {
  if (DRY_RUN) {
    log(`[DRY RUN] Would ingest URL: ${url}`, 'info');
    return { success: true, title, documentId: 'dry-run' };
  }

  try {
    const response = await fetch(`${GRAPHRAG_URL}/api/documents/ingest-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        metadata: {
          title,
          tags,
          source: 'external-url',
          bootstrapped: true,
        },
        ingestionOptions: {
          chunkSize: 1000,
          overlap: 200,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        title,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const result = await response.json();
    return {
      success: true,
      title,
      documentId: result.jobId || result.documentId,
    };
  } catch (error: any) {
    return {
      success: false,
      title,
      error: error.message,
    };
  }
}

async function seedLocalDocuments(): Promise<BootstrapResult[]> {
  log('Seeding local foundational documents...', 'info');
  const results: BootstrapResult[] = [];

  if (!fs.existsSync(SEED_DOCUMENTS_DIR)) {
    log(`Seed documents directory not found: ${SEED_DOCUMENTS_DIR}`, 'error');
    return results;
  }

  const files = fs.readdirSync(SEED_DOCUMENTS_DIR).filter((f) => f.endsWith('.md'));
  log(`Found ${files.length} seed documents`, 'info');

  for (const file of files) {
    const filePath = path.join(SEED_DOCUMENTS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Extract title from first H1 or filename
    const titleMatch = content.match(/^# (.+)$/m);
    const title = titleMatch ? titleMatch[1] : file.replace('.md', '');

    // Generate tags from filename
    const tags = [
      'foundational',
      'seed-document',
      ...file.replace('.md', '').split('-'),
    ];

    log(`  Processing: ${title}`, 'info');
    const result = await storeDocument(content, title, tags, `seed-documents/${file}`);

    if (result.success) {
      log(`  Stored: ${title} (${result.documentId})`, 'success');
    } else {
      log(`  Failed: ${title} - ${result.error}`, 'error');
    }

    results.push(result);
  }

  return results;
}

async function ingestInternalDocs(): Promise<BootstrapResult[]> {
  log('Ingesting internal documentation (READMEs)...', 'info');
  const results: BootstrapResult[] = [];

  for (const doc of INTERNAL_DOCS) {
    const fullPath = path.resolve(__dirname, doc.path);

    if (!fs.existsSync(fullPath)) {
      log(`  Skipping (not found): ${doc.title}`, 'warning');
      results.push({
        success: false,
        title: doc.title,
        error: 'File not found',
      });
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    log(`  Processing: ${doc.title}`, 'info');

    const result = await storeDocument(content, doc.title, doc.tags, doc.path);

    if (result.success) {
      log(`  Stored: ${doc.title} (${result.documentId})`, 'success');
    } else {
      log(`  Failed: ${doc.title} - ${result.error}`, 'error');
    }

    results.push(result);
  }

  return results;
}

async function ingestExternalResources(): Promise<BootstrapResult[]> {
  log('Ingesting external resources (URLs)...', 'info');
  log('  Note: External URL ingestion may fail if service is unavailable', 'warning');
  const results: BootstrapResult[] = [];

  for (const resource of EXTERNAL_URLS) {
    log(`  Processing: ${resource.title}`, 'info');

    const result = await ingestUrl(resource.url, resource.title, resource.tags);

    if (result.success) {
      log(`  Queued: ${resource.title} (${result.documentId})`, 'success');
    } else {
      log(`  Failed: ${resource.title} - ${result.error}`, 'warning');
    }

    results.push(result);
  }

  return results;
}

function printSummary(summary: BootstrapSummary): void {
  console.log('\n' + '='.repeat(60));
  console.log('BOOTSTRAP SUMMARY');
  console.log('='.repeat(60));

  console.log(`
Total documents processed: ${summary.total}
  ${colors.green}Success: ${summary.success}${colors.reset}
  ${colors.red}Failed: ${summary.failed}${colors.reset}
  ${colors.yellow}Skipped: ${summary.skipped}${colors.reset}
`);

  if (summary.failed > 0) {
    console.log('Failed documents:');
    summary.results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  - ${r.title}: ${r.error}`);
      });
  }

  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log(`\n${colors.yellow}DRY RUN - No documents were actually stored${colors.reset}`);
    console.log('Run without --dry-run to perform actual bootstrap\n');
  }
}

async function checkGraphRAGHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${GRAPHRAG_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('NEXUS GRAPHRAG KNOWLEDGE BASE BOOTSTRAP');
  console.log('='.repeat(60) + '\n');

  log(`GraphRAG URL: ${GRAPHRAG_URL}`, 'info');
  log(`Dry run: ${DRY_RUN}`, 'info');

  // Check GraphRAG health (unless dry run)
  if (!DRY_RUN) {
    log('Checking GraphRAG service health...', 'info');
    const isHealthy = await checkGraphRAGHealth();
    if (!isHealthy) {
      log(`GraphRAG service not available at ${GRAPHRAG_URL}`, 'error');
      log('Make sure the service is running or set GRAPHRAG_URL environment variable', 'error');
      process.exit(1);
    }
    log('GraphRAG service is healthy', 'success');
  }

  console.log('');

  // Execute bootstrap phases
  const allResults: BootstrapResult[] = [];

  // Phase 1: Local seed documents
  const seedResults = await seedLocalDocuments();
  allResults.push(...seedResults);
  console.log('');

  // Phase 2: Internal README files
  const internalResults = await ingestInternalDocs();
  allResults.push(...internalResults);
  console.log('');

  // Phase 3: External URLs (optional, may fail)
  const externalResults = await ingestExternalResources();
  allResults.push(...externalResults);

  // Calculate summary
  const summary: BootstrapSummary = {
    total: allResults.length,
    success: allResults.filter((r) => r.success).length,
    failed: allResults.filter((r) => !r.success && r.error !== 'File not found').length,
    skipped: allResults.filter((r) => r.error === 'File not found').length,
    results: allResults,
  };

  printSummary(summary);

  // Exit with error code if failures
  if (summary.failed > 0 && !DRY_RUN) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Bootstrap failed:', error);
  process.exit(1);
});
