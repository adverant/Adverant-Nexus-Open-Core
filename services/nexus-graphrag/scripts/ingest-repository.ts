#!/usr/bin/env tsx
/**
 * Repository Ingestion CLI Tool
 *
 * Command-line tool to ingest local repositories into GraphRAG.
 *
 * Usage:
 * ```bash
 * npx tsx scripts/ingest-repository.ts \
 *   --path /path/to/repo \
 *   --extensions "ts,tsx,js,jsx,md" \
 *   --ignore "node_modules,dist,build" \
 *   --concurrency 5
 * ```
 *
 * Options:
 * --path: Repository path (required)
 * --extensions: Comma-separated file extensions (default: ts,tsx,js,jsx,md,json,yaml,yml)
 * --ignore: Comma-separated ignore patterns (default: none, uses .gitignore)
 * --max-file-size: Maximum file size in MB (default: 10)
 * --max-depth: Maximum directory depth (default: unlimited)
 * --concurrency: Number of concurrent ingestion jobs (default: 5)
 * --estimate-only: Only estimate, don't actually ingest
 * --api-url: GraphRAG API URL (default: http://localhost:9090)
 * --webhook-url: Webhook URL for progress notifications (optional)
 */

import * as http from 'http';
import * as https from 'https';

// Parse command-line arguments
function parseArgs(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = argv[i + 1];

      if (nextArg && !nextArg.startsWith('--')) {
        args[key] = nextArg;
        i++; // Skip next argument
      } else {
        args[key] = true; // Flag without value
      }
    }
  }

  return args;
}

// Make HTTP request
function makeRequest(
  url: string,
  method: string,
  data?: any
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 500,
          body
        });
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// Poll ingestion job status
async function pollJobStatus(
  apiUrl: string,
  jobId: string,
  intervalMs: number = 5000
): Promise<void> {
  let isComplete = false;
  let lastProgress = -1;

  while (!isComplete) {
    try {
      const response = await makeRequest(
        `${apiUrl}/api/documents/ingestion-jobs/${jobId}`,
        'GET'
      );

      if (response.statusCode !== 200) {
        console.error(`Error fetching job status: ${response.statusCode}`);
        console.error(response.body);
        break;
      }

      const result = JSON.parse(response.body);

      // Display progress
      if (result.progress !== undefined && result.progress !== lastProgress) {
        lastProgress = result.progress;
        console.log(`Progress: ${(result.progress * 100).toFixed(1)}% - ` +
                    `${result.filesProcessed}/${result.filesDiscovered} files`);

        if (result.errors && result.errors.length > 0) {
          console.log(`Errors: ${result.errors.length}`);
        }
      }

      // Check if complete
      if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') {
        isComplete = true;

        console.log('\n' + '='.repeat(60));
        console.log(`Job Status: ${result.status.toUpperCase()}`);
        console.log('='.repeat(60));
        console.log(`Files Discovered: ${result.filesDiscovered}`);
        console.log(`Files Processed: ${result.filesProcessed}`);
        console.log(`Success: ${result.filesSucceeded || 0}`);
        console.log(`Failed: ${result.filesFailed || 0}`);
        console.log(`Duration: ${(result.processingTime / 1000).toFixed(2)}s`);

        if (result.errors && result.errors.length > 0) {
          console.log('\n' + '='.repeat(60));
          console.log('ERRORS:');
          console.log('='.repeat(60));
          result.errors.forEach((err: any, idx: number) => {
            console.log(`${idx + 1}. ${err.file || 'Unknown'}: ${err.error || err.message}`);
          });
        }

        break;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, intervalMs));

    } catch (error) {
      console.error('Error polling job status:', (error as Error).message);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

// Main function
async function main() {
  const args = parseArgs();

  // Validate required arguments
  if (!args.path) {
    console.error('Error: --path is required');
    console.error('\nUsage:');
    console.error('  npx tsx scripts/ingest-repository.ts --path /path/to/repo [options]');
    console.error('\nOptions:');
    console.error('  --path            Repository path (required)');
    console.error('  --extensions      Comma-separated file extensions');
    console.error('  --ignore          Comma-separated ignore patterns');
    console.error('  --max-file-size   Maximum file size in MB (default: 10)');
    console.error('  --max-depth       Maximum directory depth (default: unlimited)');
    console.error('  --concurrency     Number of concurrent jobs (default: 5)');
    console.error('  --estimate-only   Only estimate, don\'t ingest');
    console.error('  --api-url         GraphRAG API URL (default: http://localhost:9090)');
    console.error('  --webhook-url     Webhook URL for notifications');
    process.exit(1);
  }

  const repositoryPath = args.path as string;
  const apiUrl = (args['api-url'] as string) || 'http://localhost:9090';

  // Build options object
  const options: any = {};

  if (args.extensions) {
    options.extensions = (args.extensions as string).split(',').map(e => e.trim());
  }

  if (args.ignore) {
    options.ignorePatterns = (args.ignore as string).split(',').map(p => p.trim());
  }

  if (args['max-file-size']) {
    options.maxFileSize = parseInt(args['max-file-size'] as string) * 1024 * 1024; // Convert MB to bytes
  }

  if (args['max-depth']) {
    options.maxDepth = parseInt(args['max-depth'] as string);
  }

  if (args.concurrency) {
    options.concurrency = parseInt(args.concurrency as string);
  }

  if (args['estimate-only']) {
    options.estimateOnly = true;
  }

  if (args['webhook-url']) {
    options.webhookUrl = args['webhook-url'];
  }

  // Prepare request payload
  const payload = {
    repositoryPath,
    options
  };

  console.log('Starting repository ingestion...');
  console.log('Repository:', repositoryPath);
  console.log('API URL:', apiUrl);
  if (options.extensions) {
    console.log('Extensions:', options.extensions.join(', '));
  }
  if (options.ignorePatterns) {
    console.log('Ignore patterns:', options.ignorePatterns.join(', '));
  }
  console.log('');

  try {
    // Make API request
    const response = await makeRequest(
      `${apiUrl}/api/documents/ingest-repository`,
      'POST',
      payload
    );

    if (response.statusCode !== 200 && response.statusCode !== 202) {
      console.error(`Error: HTTP ${response.statusCode}`);
      console.error(response.body);
      process.exit(1);
    }

    const result = JSON.parse(response.body);

    if (options.estimateOnly) {
      // Display estimate
      console.log('='.repeat(60));
      console.log('ESTIMATION RESULTS:');
      console.log('='.repeat(60));
      console.log(`Files discovered: ${result.estimate.filesDiscovered}`);
      console.log(`Total size: ${result.estimate.humanReadableSize}`);
      console.log('');
      console.log('Run without --estimate-only to start ingestion.');
      return;
    }

    // Display initial result
    console.log('='.repeat(60));
    console.log('INGESTION STARTED:');
    console.log('='.repeat(60));
    console.log(`Job ID: ${result.jobId}`);
    console.log(`Files discovered: ${result.filesDiscovered}`);
    console.log(`Files skipped: ${result.filesSkipped}`);
    console.log(`Total size: ${result.humanReadableSize}`);
    console.log(`Scan duration: ${result.scanDuration}ms`);
    console.log('');
    console.log('Monitoring job progress...');
    console.log('');

    // Poll job status
    await pollJobStatus(apiUrl, result.jobId);

  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
