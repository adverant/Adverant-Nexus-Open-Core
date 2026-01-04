/**
 * Test Fixtures - Sample data for testing
 *
 * Phase 7-8: Comprehensive Test Suite
 *
 * Provides:
 * - Sample files (PDF, PNG, ZIP, etc.) as base64
 * - Sample job payloads
 * - Sample database records
 * - Sample API responses
 */

/**
 * Sample PDF file (minimal valid PDF)
 * Contains text: "Test PDF"
 */
export const samplePDF = {
  base64: 'JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL0NvbnRlbnRzIDQgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+CmVuZG9iago0IDAgb2JqCjw8L0xlbmd0aCA0Mz4+CnN0cmVhbQpCVAovRjEgMTIgVGYKNzIgNzIwIFRkCihUZXN0IFBERikgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+CmVuZG9iagoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvS2lkc1szIDAgUl0vQ291bnQgMS9NZWRpYUJveFswIDAgNjEyIDc5Ml0+PgplbmRvYmoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMzA2IDAwMDAwIG4gCjAwMDAwMDAyNDYgMDAwMDAgbiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTAxIDAwMDAwIG4gCjAwMDAwMDAxOTMgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgozNTUKJSVFT0YK',
  buffer: Buffer.from('JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL0NvbnRlbnRzIDQgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+CmVuZG9iago0IDAgb2JqCjw8L0xlbmd0aCA0Mz4+CnN0cmVhbQpCVAovRjEgMTIgVGYKNzIgNzIwIFRkCihUZXN0IFBERikgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+CmVuZG9iagoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvS2lkc1szIDAgUl0vQ291bnQgMS9NZWRpYUJveFswIDAgNjEyIDc5Ml0+PgplbmRvYmoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMzA2IDAwMDAwIG4gCjAwMDAwMDAyNDYgMDAwMDAgbiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTAxIDAwMDAwIG4gCjAwMDAwMDAxOTMgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgozNTUKJSVFT0YK', 'base64'),
  mimetype: 'application/pdf',
  filename: 'test.pdf',
  size: 355,
};

/**
 * Sample PNG image (1x1 pixel red PNG)
 */
export const samplePNG = {
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'),
  mimetype: 'image/png',
  filename: 'test.png',
  size: 68,
};

/**
 * Sample JPEG image (1x1 pixel red JPEG)
 */
export const sampleJPEG = {
  base64: '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=',
  buffer: Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=', 'base64'),
  mimetype: 'image/jpeg',
  filename: 'test.jpg',
  size: 631,
};

/**
 * Sample plain text file
 */
export const sampleTXT = {
  base64: Buffer.from('This is a test text file.\nLine 2.\nLine 3.').toString('base64'),
  buffer: Buffer.from('This is a test text file.\nLine 2.\nLine 3.'),
  mimetype: 'text/plain',
  filename: 'test.txt',
  size: 42,
};

/**
 * Sample ZIP archive (contains test.txt)
 * Created with: echo "test content" > test.txt && zip test.zip test.txt
 */
export const sampleZIP = {
  base64: 'UEsDBBQACAAIAAAAAAAAAAAAAAAAAAAAAAgAAAB0ZXN0LnR4dAWAY3QDAANLTUvOzy0BAEsFAgAACAAAAAAAAAAAAAgAAAAAAAAA',
  buffer: Buffer.from('UEsDBBQACAAIAAAAAAAAAAAAAAAAAAAAAAgAAAB0ZXN0LnR4dAWAY3QDAANLTUvOzy0BAEsFAgAACAAAAAAAAAAAAAgAAAAAAAAA', 'base64'),
  mimetype: 'application/zip',
  filename: 'test.zip',
  size: 77,
};

/**
 * Corrupted PDF (invalid header)
 */
export const corruptedPDF = {
  base64: Buffer.from('NOT A VALID PDF FILE').toString('base64'),
  buffer: Buffer.from('NOT A VALID PDF FILE'),
  mimetype: 'application/pdf',
  filename: 'corrupted.pdf',
  size: 20,
};

/**
 * Empty file
 */
export const emptyFile = {
  base64: '',
  buffer: Buffer.alloc(0),
  mimetype: 'application/octet-stream',
  filename: 'empty.bin',
  size: 0,
};

/**
 * Oversized file (simulated - actual size would be 101MB)
 */
export const oversizedFileMetadata = {
  mimetype: 'application/pdf',
  filename: 'oversized.pdf',
  size: 101 * 1024 * 1024, // 101MB
};

/**
 * Sample job data for BullMQ
 */
export const sampleJobData = {
  valid: {
    fileId: 'file-123',
    userId: 'user-456',
    tenantId: 'tenant-789',
    filename: 'document.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    s3Bucket: 'test-bucket',
    s3Key: 'uploads/document.pdf',
  },
  withArchive: {
    fileId: 'file-archive-123',
    userId: 'user-456',
    tenantId: 'tenant-789',
    filename: 'archive.zip',
    mimetype: 'application/zip',
    size: 2048,
    s3Bucket: 'test-bucket',
    s3Key: 'uploads/archive.zip',
  },
};

/**
 * Sample database records
 */
export const sampleDatabaseRecords = {
  job: {
    id: '123e4567-e89b-12d3-a456-426614174000',
    tenant_id: 'tenant-789',
    user_id: 'user-456',
    status: 'pending',
    file_name: 'document.pdf',
    file_size: 1024,
    mime_type: 'application/pdf',
    s3_bucket: 'test-bucket',
    s3_key: 'uploads/document.pdf',
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  },
  artifact: {
    id: '223e4567-e89b-12d3-a456-426614174001',
    job_id: '123e4567-e89b-12d3-a456-426614174000',
    tenant_id: 'tenant-789',
    artifact_type: 'extracted_text',
    content: 'This is extracted text from the document.',
    s3_bucket: 'test-bucket',
    s3_key: 'artifacts/text-123.txt',
    metadata: { confidence: 0.95 },
    created_at: new Date(),
  },
  pattern: {
    id: '323e4567-e89b-12d3-a456-426614174002',
    tenant_id: 'tenant-789',
    file_type: 'application/vnd.custom',
    pattern_name: 'custom-parser',
    success_count: 5,
    failure_count: 1,
    avg_processing_time_ms: 1500,
    last_used_at: new Date(),
    metadata: { parser_version: '1.0' },
    created_at: new Date(),
    updated_at: new Date(),
  },
};

/**
 * Sample API responses
 */
export const sampleAPIResponses = {
  uploadSuccess: {
    success: true,
    message: 'File uploaded successfully',
    data: {
      jobId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'queued',
    },
  },
  uploadError: {
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid file type',
    },
  },
  statusSuccess: {
    success: true,
    data: {
      jobId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'completed',
      progress: 100,
      artifacts: [
        {
          type: 'extracted_text',
          url: 'https://storage.example.com/artifacts/text-123.txt',
        },
      ],
    },
  },
};

/**
 * Sample validation results
 */
export const sampleValidationResults = {
  pdfValid: {
    isValid: true,
    mimetype: 'application/pdf',
    fileType: 'pdf',
    metadata: {
      pages: 1,
      hasText: true,
    },
  },
  zipValid: {
    isValid: true,
    mimetype: 'application/zip',
    fileType: 'zip',
    metadata: {
      format: 'zip',
      fileCount: 1,
    },
  },
  invalidFile: {
    isValid: false,
    error: 'Unsupported file type',
  },
};

/**
 * Sample Sandbox execution requests
 */
export const sampleSandboxRequests = {
  pythonScript: {
    code: 'print("Hello from sandbox")',
    language: 'python' as const,
    timeout: 5000,
  },
  nodeScript: {
    code: 'console.log("Hello from sandbox")',
    language: 'node' as const,
    packages: ['lodash'],
    timeout: 10000,
  },
  withFile: {
    code: 'import sys; print(open("/workspace/input.txt").read())',
    language: 'python' as const,
    files: [
      {
        filename: 'input.txt',
        content: Buffer.from('Test file content').toString('base64'),
      },
    ],
    timeout: 5000,
  },
};

/**
 * Sample Sandbox execution results
 */
export const sampleSandboxResults = {
  success: {
    success: true,
    stdout: 'Hello from sandbox\n',
    stderr: '',
    exitCode: 0,
    executionTimeMs: 150,
    resourceUsage: {
      cpuTimeMs: 80,
      memoryPeakMb: 64,
    },
  },
  failure: {
    success: false,
    stdout: '',
    stderr: 'Error: Module not found',
    exitCode: 1,
    executionTimeMs: 50,
    error: {
      code: 'EXECUTION_ERROR',
      message: 'Script execution failed',
      details: 'Module not found',
    },
  },
  timeout: {
    success: false,
    stdout: '',
    stderr: '',
    exitCode: 124,
    executionTimeMs: 5000,
    error: {
      code: 'TIMEOUT',
      message: 'Execution timed out after 5000ms',
    },
  },
};

/**
 * Sample pattern learning data
 */
export const samplePatternData = {
  newPattern: {
    tenantId: 'tenant-789',
    fileType: 'application/vnd.custom',
    patternName: 'custom-parser-v1',
    metadata: {
      parserVersion: '1.0',
      supportedFeatures: ['text-extraction', 'metadata-parsing'],
    },
  },
  cachedPattern: {
    id: '323e4567-e89b-12d3-a456-426614174002',
    tenantId: 'tenant-789',
    fileType: 'application/vnd.custom',
    patternName: 'custom-parser-v1',
    successCount: 10,
    failureCount: 0,
    avgProcessingTimeMs: 1200,
    lastUsedAt: new Date(),
    metadata: {
      parserVersion: '1.0',
    },
  },
};

/**
 * Sample Office Document Files
 *
 * Modern Office formats (DOCX, XLSX, PPTX) are ZIP-based Open XML formats
 * Legacy Office formats (DOC, XLS, PPT) use OLE2/CFB (Compound File Binary) format
 */

/**
 * Minimal DOCX (ZIP with word/ directory)
 * Created as ZIP with PK header (50 4B 03 04) and "word/" in content
 */
export const sampleDOCX = {
  // ZIP file containing "word/" marker
  base64: 'UEsDBBQAAAAIAAAAAAAAAAAAAAAAAAAAAAgAAAB3b3JkLwAAAAAAAAAAAAAAAAAAAAAAAAAA',
  buffer: Buffer.from('UEsDBBQAAAAIAAAAAAAAAAAAAAAAAAAAAAgAAAB3b3JkLwAAAAAAAAAAAAAAAAAAAAAAAAAA', 'base64'),
  mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  filename: 'test.docx',
  size: 50,
};

/**
 * Minimal XLSX (ZIP with xl/ directory)
 * Created as ZIP with PK header (50 4B 03 04) and "xl/" in content
 */
export const sampleXLSX = {
  // ZIP file containing "xl/" marker
  base64: 'UEsDBBQAAAAIAAAAAAAAAAAAAAAAAAAAAAQAAAB4bC8AAAAAAAAAAAAAAAAAAAAAAA==',
  buffer: Buffer.from('UEsDBBQAAAAIAAAAAAAAAAAAAAAAAAAAAAQAAAB4bC8AAAAAAAAAAAAAAAAAAAAAAA==', 'base64'),
  mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  filename: 'test.xlsx',
  size: 46,
};

/**
 * Minimal PPTX (ZIP with ppt/ directory)
 * Created as ZIP with PK header (50 4B 03 04) and "ppt/" in content
 */
export const samplePPTX = {
  // ZIP file containing "ppt/" marker
  base64: 'UEsDBBQAAAAIAAAAAAAAAAAAAAAAAAAAAAUAAABwcHQvAAAAAAAAAAAAAAAAAAAAAA==',
  buffer: Buffer.from('UEsDBBQAAAAIAAAAAAAAAAAAAAAAAAAAAAUAAABwcHQvAAAAAAAAAAAAAAAAAAAAAA==', 'base64'),
  mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  filename: 'test.pptx',
  size: 47,
};

/**
 * Legacy DOC file (OLE2/CFB format)
 * Magic bytes: D0 CF 11 E0 A1 B1 1A E1
 */
export const sampleDOC = {
  // OLE2 header signature
  buffer: Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, // OLE2 magic bytes
    ...Array(56).fill(0x00), // Minimal padding to meet minimum size
  ]),
  get base64() {
    return this.buffer.toString('base64');
  },
  mimetype: 'application/msword',
  filename: 'test.doc',
  get size() {
    return this.buffer.length;
  },
};

/**
 * Legacy XLS file (OLE2/CFB format)
 * Magic bytes: D0 CF 11 E0 A1 B1 1A E1
 */
export const sampleXLS = {
  // OLE2 header signature
  buffer: Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, // OLE2 magic bytes
    ...Array(56).fill(0x00), // Minimal padding to meet minimum size
  ]),
  get base64() {
    return this.buffer.toString('base64');
  },
  mimetype: 'application/vnd.ms-excel',
  filename: 'test.xls',
  get size() {
    return this.buffer.length;
  },
};

/**
 * Legacy PPT file (OLE2/CFB format)
 * Magic bytes: D0 CF 11 E0 A1 B1 1A E1
 */
export const samplePPT = {
  // OLE2 header signature
  buffer: Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, // OLE2 magic bytes
    ...Array(56).fill(0x00), // Minimal padding to meet minimum size
  ]),
  get base64() {
    return this.buffer.toString('base64');
  },
  mimetype: 'application/vnd.ms-powerpoint',
  filename: 'test.ppt',
  get size() {
    return this.buffer.length;
  },
};

/**
 * Corrupted Office documents (for error testing)
 */
export const corruptedOfficeDocuments = {
  // ZIP header but no Office markers
  invalidDOCX: {
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(60).fill(0x00)]),
    get base64() {
      return this.buffer.toString('base64');
    },
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: 'corrupted.docx',
    get size() {
      return this.buffer.length;
    },
  },
  // OLE2 header but wrong extension
  invalidOLE: {
    buffer: Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
      ...Array(56).fill(0x00),
    ]),
    get base64() {
      return this.buffer.toString('base64');
    },
    mimetype: 'application/octet-stream',
    filename: 'test.xyz', // Non-Office extension
    get size() {
      return this.buffer.length;
    },
  },
  // Neither ZIP nor OLE2
  notAnOfficeFile: {
    buffer: Buffer.from('This is not an Office document'),
    get base64() {
      return this.buffer.toString('base64');
    },
    mimetype: 'application/octet-stream',
    filename: 'not-office.docx',
    get size() {
      return this.buffer.length;
    },
  },
};
