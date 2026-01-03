/**
 * Standalone Provider Tests (No Build Required)
 * Tests Google Drive and HTTP providers independently
 */

import { HTTPProvider } from './src/providers/http-provider';
import { GoogleDriveProvider } from './src/providers/google-drive-provider';
import { config } from './src/config';

// Test configuration
const GOOGLE_DRIVE_TEST_FOLDER = 'https://drive.google.com/drive/folders/1iFxo8CikD-nrL1zQU6tBCHZUJpl5oSxJ';
const HTTP_TEST_FILE = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';

/**
 * Test HTTP Provider
 */
async function testHTTPProvider() {
  console.log('\n========================================');
  console.log('Testing HTTP Provider');
  console.log('========================================\n');

  const provider = new HTTPProvider({
    timeout: 30000,
    maxFileSize: 100 * 1024 * 1024,
    maxRetries: 3
  });

  try {
    // Test 1: URL validation
    console.log('Test 1: Validate HTTP URL');
    const canHandle = provider.canHandle(HTTP_TEST_FILE);
    console.log(`✓ Can handle HTTP URL: ${canHandle}`);

    if (!canHandle) {
      throw new Error('HTTP provider should handle HTTP URLs');
    }

    // Test 2: URL validation with validation method
    console.log('\nTest 2: Validate URL structure');
    const validation = await provider.validateURL(HTTP_TEST_FILE);
    console.log('Validation result:', JSON.stringify(validation, null, 2));

    if (!validation.valid) {
      throw new Error(`URL validation failed: ${validation.error}`);
    }
    console.log('✓ URL validation passed');

    // Test 3: Fetch file
    console.log('\nTest 3: Fetch file content');
    const content = await provider.fetchFile(HTTP_TEST_FILE, (progress) => {
      console.log(`  Progress: ${progress.message} - ${progress.percentage || 0}%`);
    });

    console.log(`✓ File fetched successfully (${content.length} bytes)`);

    if (content.length === 0) {
      throw new Error('File content is empty');
    }

    console.log('\n✅ All HTTP Provider tests passed!\n');
    return true;
  } catch (error) {
    console.error('\n❌ HTTP Provider test failed:', (error as Error).message);
    console.error((error as Error).stack);
    return false;
  }
}

/**
 * Test Google Drive Provider
 */
async function testGoogleDriveProvider() {
  console.log('\n========================================');
  console.log('Testing Google Drive Provider');
  console.log('========================================\n');

  // Check if Google Drive is configured
  if (!config.googleDrive?.enabled) {
    console.log('⊘ Google Drive not enabled in config, skipping tests');
    console.log(`  GOOGLE_DRIVE_ENABLED: ${process.env.GOOGLE_DRIVE_ENABLED}`);
    console.log(`  Config value: ${config.googleDrive?.enabled}`);
    return true;
  }

  const provider = new GoogleDriveProvider({
    apiKey: config.googleDrive.apiKey,
    credentials: {
      clientId: config.googleDrive.clientId,
      clientSecret: config.googleDrive.clientSecret,
      redirectUri: config.googleDrive.redirectUri
    }
  });

  try {
    // Test 1: URL validation
    console.log('Test 1: Validate Google Drive URL');
    const canHandle = provider.canHandle(GOOGLE_DRIVE_TEST_FOLDER);
    console.log(`✓ Can handle Google Drive URL: ${canHandle}`);

    if (!canHandle) {
      throw new Error('Google Drive provider should handle Drive URLs');
    }

    // Test 2: URL validation with validation method
    console.log('\nTest 2: Validate folder structure');
    const validation = await provider.validateURL(GOOGLE_DRIVE_TEST_FOLDER);
    console.log('Validation result:', JSON.stringify(validation, null, 2));

    if (!validation.valid) {
      throw new Error(`URL validation failed: ${validation.error}`);
    }
    console.log('✓ URL validation passed');
    console.log(`  Type: ${validation.type}`);
    console.log(`  Estimated files: ${validation.estimatedFileCount || 'unknown'}`);

    // Test 3: File discovery (if it's a folder)
    if (validation.type === 'folder') {
      console.log('\nTest 3: Discover files in folder');
      const files = await provider.discoverFiles(
        GOOGLE_DRIVE_TEST_FOLDER,
        {
          maxDepth: 2,
          maxFiles: 10
        },
        (progress) => {
          console.log(`  ${progress.message}`);
        }
      );

      console.log(`✓ Discovered ${files.length} files`);

      if (files.length > 0) {
        console.log('\n  Sample files:');
        files.slice(0, 3).forEach((file, idx) => {
          console.log(`    ${idx + 1}. ${file.filename} (${file.mimeType})`);
          console.log(`       URL: ${file.url}`);
          console.log(`       Size: ${file.size ? `${(file.size / 1024).toFixed(2)} KB` : 'unknown'}`);
        });
      }
    }

    console.log('\n✅ All Google Drive Provider tests passed!\n');
    return true;
  } catch (error) {
    console.error('\n❌ Google Drive Provider test failed:', (error as Error).message);
    console.error((error as Error).stack);
    return false;
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log('===========================================');
  console.log('URL Ingestion Provider Unit Tests');
  console.log('===========================================');

  const results = {
    http: false,
    googleDrive: false
  };

  // Run tests
  results.http = await testHTTPProvider();
  results.googleDrive = await testGoogleDriveProvider();

  // Summary
  console.log('\n========================================');
  console.log('Test Summary');
  console.log('========================================');
  console.log(`HTTP Provider: ${results.http ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Google Drive Provider: ${results.googleDrive ? '✅ PASS' : '❌ FAIL'}`);
  console.log('========================================\n');

  const allPassed = results.http && results.googleDrive;
  process.exit(allPassed ? 0 : 1);
}

// Run tests
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
