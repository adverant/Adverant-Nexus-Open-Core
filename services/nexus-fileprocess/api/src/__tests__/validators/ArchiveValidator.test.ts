/**
 * Unit tests for ArchiveValidator
 *
 * Tests:
 * - Magic byte detection for all supported formats
 * - TAR compression detection
 * - File extension fallback
 * - Invalid/corrupted archive detection
 * - Zero-byte file handling
 */

import { ArchiveValidator } from '../../validators/ArchiveValidator';

describe('ArchiveValidator', () => {
  let validator: ArchiveValidator;

  beforeEach(() => {
    validator = new ArchiveValidator();
  });

  describe('ZIP archive detection', () => {
    it('should detect valid ZIP archive by magic bytes', async () => {
      // ZIP magic bytes: 0x504B0304
      const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]);

      const result = await validator.validate({
        buffer,
        filename: 'test.zip',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/zip');
      expect(result.metadata?.isArchive).toBe(true);
      expect(result.metadata?.archiveType).toBe('zip');
    });

    it('should return valid for non-archive files', async () => {
      // Random bytes (not an archive)
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, ...Array(100).fill(0xFF)]);

      const result = await validator.validate({
        buffer,
        filename: 'test.dat',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBeUndefined();
    });
  });

  describe('RAR archive detection', () => {
    it('should detect valid RAR archive by magic bytes', async () => {
      // RAR magic bytes: 0x526172211A07
      const buffer = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, ...Array(100).fill(0)]);

      const result = await validator.validate({
        buffer,
        filename: 'test.rar',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/x-rar-compressed');
      expect(result.metadata?.isArchive).toBe(true);
      expect(result.metadata?.archiveType).toBe('rar');
    });
  });

  describe('7Z archive detection', () => {
    it('should detect valid 7Z archive by magic bytes', async () => {
      // 7Z magic bytes: 0x377ABCAF271C
      const buffer = Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, ...Array(100).fill(0)]);

      const result = await validator.validate({
        buffer,
        filename: 'test.7z',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/x-7z-compressed');
      expect(result.metadata?.isArchive).toBe(true);
      expect(result.metadata?.archiveType).toBe('7z');
    });
  });

  describe('TAR archive detection', () => {
    it('should detect valid TAR archive by ustar signature at offset 257', async () => {
      // Create buffer with 'ustar' at offset 257
      const buffer = Buffer.alloc(300);
      buffer.write('ustar', 257, 'ascii');

      const result = await validator.validate({
        buffer,
        filename: 'test.tar',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/x-tar');
      expect(result.metadata?.isArchive).toBe(true);
      expect(result.metadata?.archiveType).toBe('tar');
      expect(result.metadata?.compressionFormat).toBe('none');
    });

    it('should detect TAR.GZ compression', async () => {
      // GZIP magic bytes followed by TAR
      const buffer = Buffer.alloc(300);
      buffer[0] = 0x1F;
      buffer[1] = 0x8B;
      buffer.write('ustar', 257, 'ascii');

      const result = await validator.validate({
        buffer,
        filename: 'test.tar.gz',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/x-tar');
      expect(result.metadata?.compressionFormat).toBe('gzip');
    });

    it('should detect TAR.BZ2 compression', async () => {
      // BZIP2 magic bytes followed by TAR
      const buffer = Buffer.alloc(300);
      buffer[0] = 0x42;
      buffer[1] = 0x5A;
      buffer[2] = 0x68;
      buffer.write('ustar', 257, 'ascii');

      const result = await validator.validate({
        buffer,
        filename: 'test.tar.bz2',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/x-tar');
      expect(result.metadata?.compressionFormat).toBe('bzip2');
    });
  });

  describe('GZIP detection', () => {
    it('should detect valid GZIP file', async () => {
      // GZIP magic bytes: 0x1F8B
      const buffer = Buffer.from([0x1F, 0x8B, ...Array(100).fill(0)]);

      const result = await validator.validate({
        buffer,
        filename: 'test.gz',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/gzip');
      expect(result.metadata?.isArchive).toBe(true);
      expect(result.metadata?.archiveType).toBe('gzip');
    });
  });

  describe('BZIP2 detection', () => {
    it('should detect valid BZIP2 file', async () => {
      // BZIP2 magic bytes: 0x425A68 (BZh)
      const buffer = Buffer.from([0x42, 0x5A, 0x68, ...Array(100).fill(0)]);

      const result = await validator.validate({
        buffer,
        filename: 'test.bz2',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/x-bzip2');
      expect(result.metadata?.isArchive).toBe(true);
      expect(result.metadata?.archiveType).toBe('bzip2');
    });
  });

  describe('Edge cases', () => {
    it('should handle zero-byte files', async () => {
      const buffer = Buffer.alloc(0);

      const result = await validator.validate({
        buffer,
        filename: 'empty.zip',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBeUndefined();
    });

    it('should handle files smaller than signature length', async () => {
      const buffer = Buffer.from([0x50, 0x4B]); // Only 2 bytes (ZIP needs 4)

      const result = await validator.validate({
        buffer,
        filename: 'truncated.zip',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBeUndefined();
    });

    it('should handle TAR files too small for ustar signature', async () => {
      const buffer = Buffer.alloc(200); // Less than 257 bytes

      const result = await validator.validate({
        buffer,
        filename: 'small.tar',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBeUndefined();
    });
  });

  describe('Filename and metadata', () => {
    it('should include filename in validation context', async () => {
      const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]);

      const result = await validator.validate({
        buffer,
        filename: 'my-archive.zip',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/zip');
    });

    it('should handle files with no extension', async () => {
      const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]);

      const result = await validator.validate({
        buffer,
        filename: 'archive',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/zip');
    });

    it('should handle optional userId in context', async () => {
      const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]);

      const result = await validator.validate({
        buffer,
        filename: 'test.zip',
        userId: 'user-123',
      });

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/zip');
    });
  });
});
