/**
 * Unit tests for ArchiveExtractor
 *
 * Tests:
 * - ZIP extraction
 * - TAR extraction
 * - TAR.GZ extraction
 * - Error handling for corrupted archives
 * - Empty archive handling
 * - Factory pattern selection
 */

import { ArchiveExtractorFactory, ZipExtractor, TarExtractor } from '../../extractors/ArchiveExtractor';
import AdmZip from 'adm-zip';

describe('ArchiveExtractorFactory', () => {
  describe('Archive format detection', () => {
    it('should detect ZIP as archive format', () => {
      expect(ArchiveExtractorFactory.isArchive('application/zip')).toBe(true);
    });

    it('should detect RAR as archive format', () => {
      expect(ArchiveExtractorFactory.isArchive('application/x-rar-compressed')).toBe(true);
    });

    it('should detect 7Z as archive format', () => {
      expect(ArchiveExtractorFactory.isArchive('application/x-7z-compressed')).toBe(true);
    });

    it('should detect TAR as archive format', () => {
      expect(ArchiveExtractorFactory.isArchive('application/x-tar')).toBe(true);
    });

    it('should detect GZIP as archive format', () => {
      expect(ArchiveExtractorFactory.isArchive('application/gzip')).toBe(true);
    });

    it('should detect BZIP2 as archive format', () => {
      expect(ArchiveExtractorFactory.isArchive('application/x-bzip2')).toBe(true);
    });

    it('should not detect PDF as archive format', () => {
      expect(ArchiveExtractorFactory.isArchive('application/pdf')).toBe(false);
    });

    it('should not detect images as archive format', () => {
      expect(ArchiveExtractorFactory.isArchive('image/png')).toBe(false);
      expect(ArchiveExtractorFactory.isArchive('image/jpeg')).toBe(false);
    });
  });
});

describe('ZipExtractor', () => {
  let extractor: ZipExtractor;

  beforeEach(() => {
    extractor = new ZipExtractor();
  });

  describe('Format detection', () => {
    it('should accept ZIP MIME type', () => {
      expect(extractor.canExtract('application/zip')).toBe(true);
    });

    it('should reject non-ZIP MIME types', () => {
      expect(extractor.canExtract('application/x-rar-compressed')).toBe(false);
      expect(extractor.canExtract('application/pdf')).toBe(false);
    });
  });

  describe('ZIP extraction', () => {
    it('should extract files from valid ZIP archive', async () => {
      // Create test ZIP archive
      const zip = new AdmZip();
      zip.addFile('file1.txt', Buffer.from('Hello World'));
      zip.addFile('file2.txt', Buffer.from('Test Content'));
      zip.addFile('dir/file3.txt', Buffer.from('Nested File'));

      const buffer = zip.toBuffer();

      const result = await extractor.extract(buffer, 'test.zip');

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(3);
      expect(result.metadata.archiveType).toBe('zip');
      expect(result.metadata.totalFiles).toBe(3);

      // Verify file contents
      const file1 = result.files.find(f => f.filename === 'file1.txt');
      expect(file1).toBeDefined();
      expect(file1!.buffer.toString()).toBe('Hello World');
      expect(file1!.size).toBe(11);

      const file2 = result.files.find(f => f.filename === 'file2.txt');
      expect(file2).toBeDefined();
      expect(file2!.buffer.toString()).toBe('Test Content');

      const file3 = result.files.find(f => f.filename === 'dir/file3.txt');
      expect(file3).toBeDefined();
      expect(file3!.buffer.toString()).toBe('Nested File');
    });

    it('should handle empty ZIP archive', async () => {
      // Create empty ZIP archive
      const zip = new AdmZip();
      const buffer = zip.toBuffer();

      const result = await extractor.extract(buffer, 'empty.zip');

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(0);
      expect(result.metadata.totalFiles).toBe(0);
      expect(result.metadata.totalSize).toBe(0);
    });

    it('should skip directories in ZIP archive', async () => {
      // Create ZIP with directories
      const zip = new AdmZip();
      zip.addFile('dir1/', Buffer.alloc(0)); // Directory entry
      zip.addFile('dir1/file.txt', Buffer.from('Content'));

      const buffer = zip.toBuffer();

      const result = await extractor.extract(buffer, 'test.zip');

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(1); // Only file, not directory
      expect(result.files[0].filename).toBe('dir1/file.txt');
    });

    it('should handle corrupted ZIP archive', async () => {
      // Invalid ZIP data
      const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0xFF, 0xFF]);

      const result = await extractor.extract(buffer, 'corrupted.zip');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('ZIP_EXTRACTION_FAILED');
      expect(result.files).toHaveLength(0);
    });

    it('should calculate total size correctly', async () => {
      const zip = new AdmZip();
      zip.addFile('small.txt', Buffer.from('ABC')); // 3 bytes
      zip.addFile('large.txt', Buffer.from('X'.repeat(1000))); // 1000 bytes

      const buffer = zip.toBuffer();

      const result = await extractor.extract(buffer, 'test.zip');

      expect(result.success).toBe(true);
      expect(result.metadata.totalSize).toBe(1003);
    });

    it('should include extraction time metadata', async () => {
      const zip = new AdmZip();
      zip.addFile('file.txt', Buffer.from('Test'));

      const buffer = zip.toBuffer();

      const result = await extractor.extract(buffer, 'test.zip');

      expect(result.success).toBe(true);
      expect(result.metadata.extractionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('TarExtractor', () => {
  let extractor: TarExtractor;

  beforeEach(() => {
    extractor = new TarExtractor();
  });

  describe('Format detection', () => {
    it('should accept TAR MIME type', () => {
      expect(extractor.canExtract('application/x-tar')).toBe(true);
    });

    it('should accept GZIP MIME type (for TAR.GZ)', () => {
      expect(extractor.canExtract('application/gzip')).toBe(true);
    });

    it('should accept BZIP2 MIME type (for TAR.BZ2)', () => {
      expect(extractor.canExtract('application/x-bzip2')).toBe(true);
    });

    it('should reject non-TAR MIME types', () => {
      expect(extractor.canExtract('application/zip')).toBe(false);
      expect(extractor.canExtract('application/pdf')).toBe(false);
    });
  });

  // Note: Full TAR extraction tests require tar-stream library
  // and are more complex. These are basic structure tests.

  describe('TAR.BZ2 handling', () => {
    it('should return error for BZIP2 TAR archives (not yet supported)', async () => {
      // BZIP2 magic bytes
      const buffer = Buffer.from([0x42, 0x5A, 0x68, ...Array(100).fill(0)]);

      const result = await extractor.extract(buffer, 'test.tar.bz2');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('TAR_BZIP2_NOT_SUPPORTED');
    });
  });
});

describe('Integration: ArchiveExtractorFactory.extract', () => {
  it('should select ZIP extractor for ZIP files', async () => {
    const zip = new AdmZip();
    zip.addFile('test.txt', Buffer.from('Content'));
    const buffer = zip.toBuffer();

    const result = await ArchiveExtractorFactory.extract(
      buffer,
      'test.zip',
      'application/zip'
    );

    expect(result.success).toBe(true);
    expect(result.metadata.archiveType).toBe('zip');
    expect(result.files).toHaveLength(1);
  });

  it('should return error for unsupported archive format', async () => {
    const buffer = Buffer.from('not an archive');

    const result = await ArchiveExtractorFactory.extract(
      buffer,
      'test.unknown',
      'application/x-unknown-archive'
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('UNSUPPORTED_ARCHIVE_FORMAT');
    expect(result.error!.details).toContain('ZIP, RAR, 7Z, TAR');
  });
});
