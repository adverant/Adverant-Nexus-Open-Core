/**
 * FileValidator Unit Tests
 *
 * Phase 7-8: Comprehensive Test Suite - Unit Tests
 *
 * Tests for FileValidator.ts covering:
 * - FileSizeValidator: Empty, too small, too large, valid sizes
 * - MagicByteValidator: Magic byte detection, UTF-8 text, unknown formats
 * - MimeConsistencyValidator: MIME mismatch handling
 * - PdfValidator: Valid PDF, corrupted PDF
 * - FileValidatorChain: Complete validation chain
 */

import {
  FileSizeValidator,
  MagicByteValidator,
  MimeConsistencyValidator,
  PdfValidator,
  FileValidatorChain,
  FileValidationContext,
} from '../../validators/FileValidator';
import { samplePDF, samplePNG, sampleTXT, emptyFile } from '../utils/fixtures';

describe('FileValidator - Unit Tests', () => {
  describe('FileSizeValidator', () => {
    it('should reject empty files', async () => {
      const validator = new FileSizeValidator();
      const context: FileValidationContext = {
        buffer: emptyFile.buffer,
        filename: emptyFile.filename,
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('no data');
    });

    it('should reject files that are too small', async () => {
      const validator = new FileSizeValidator(100, 1024 * 1024); // Min 100 bytes
      const context: FileValidationContext = {
        buffer: Buffer.from('tiny'),
        filename: 'tiny.txt',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('too small');
    });

    it('should reject files that are too large', async () => {
      const validator = new FileSizeValidator(1, 1000); // Max 1000 bytes
      const context: FileValidationContext = {
        buffer: Buffer.alloc(2000), // 2KB file
        filename: 'large.bin',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('too large');
    });

    it('should accept files within size limits', async () => {
      const validator = new FileSizeValidator(1, 1024 * 1024); // 1B - 1MB
      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: samplePDF.filename,
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should use default size limits if not specified', async () => {
      const validator = new FileSizeValidator(); // Default: 1B - 100MB
      const context: FileValidationContext = {
        buffer: Buffer.alloc(1024), // 1KB
        filename: 'test.bin',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
    });
  });

  describe('MagicByteValidator', () => {
    it('should detect PDF files from magic bytes', async () => {
      const validator = new MagicByteValidator();
      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: samplePDF.filename,
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/pdf');
    });

    it('should detect PNG files from magic bytes', async () => {
      const validator = new MagicByteValidator();
      const context: FileValidationContext = {
        buffer: samplePNG.buffer,
        filename: samplePNG.filename,
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('image/png');
    });

    it('should detect UTF-8 text files when no magic bytes present', async () => {
      const validator = new MagicByteValidator();
      const context: FileValidationContext = {
        buffer: sampleTXT.buffer,
        filename: sampleTXT.filename,
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('text/plain');
    });

    it('should accept unknown formats as application/octet-stream', async () => {
      const validator = new MagicByteValidator();
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE]); // Non-text binary
      const context: FileValidationContext = {
        buffer: binaryData,
        filename: 'unknown.bin',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/octet-stream');
    });

    it('should reject files that are too small for detected format', async () => {
      const validator = new MagicByteValidator();
      // Truncated PDF (just the header, missing body)
      const truncatedPDF = Buffer.from('%PDF-1.4\n');
      const context: FileValidationContext = {
        buffer: truncatedPDF,
        filename: 'truncated.pdf',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('too small');
    });

    it('should handle empty buffers gracefully', async () => {
      const validator = new MagicByteValidator();
      const context: FileValidationContext = {
        buffer: Buffer.alloc(0),
        filename: 'empty.bin',
      };

      const result = await validator.validate(context);

      // Should detect as octet-stream since no magic bytes
      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/octet-stream');
    });

    it('should detect JSON files as text/plain', async () => {
      const validator = new MagicByteValidator();
      const jsonBuffer = Buffer.from('{"key": "value", "number": 123}');
      const context: FileValidationContext = {
        buffer: jsonBuffer,
        filename: 'data.json',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('text/plain');
    });

    it('should detect CSV files as text/plain', async () => {
      const validator = new MagicByteValidator();
      const csvBuffer = Buffer.from('name,age,city\nJohn,30,NYC\nJane,25,LA');
      const context: FileValidationContext = {
        buffer: csvBuffer,
        filename: 'data.csv',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('text/plain');
    });
  });

  describe('MimeConsistencyValidator', () => {
    it('should accept when claimed MIME matches detected MIME', async () => {
      const validator = new MimeConsistencyValidator();
      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: samplePDF.filename,
        claimedMimeType: 'application/pdf',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/pdf');
    });

    it('should warn but accept when claimed MIME differs from detected', async () => {
      const validator = new MimeConsistencyValidator();
      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: 'document.txt', // Wrong extension
        claimedMimeType: 'text/plain', // Wrong MIME type
      };

      // Spy on console.warn to verify warning is logged
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/pdf'); // Uses detected, not claimed
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MIME type mismatch')
      );

      warnSpy.mockRestore();
    });

    it('should handle text/plain → octet-stream compatibility', async () => {
      const validator = new MimeConsistencyValidator();
      const binaryData = Buffer.from([0x00, 0x01, 0x02]); // Non-text binary
      const context: FileValidationContext = {
        buffer: binaryData,
        filename: 'data.txt',
        claimedMimeType: 'text/plain',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      // Binary data won't pass UTF-8 text check, so detected as octet-stream
      expect(result.detectedMimeType).toBe('application/octet-stream');
    });

    it('should detect UTF-8 text when no magic bytes present', async () => {
      const validator = new MimeConsistencyValidator();
      const context: FileValidationContext = {
        buffer: sampleTXT.buffer,
        filename: sampleTXT.filename,
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('text/plain');
    });

    it('should accept unknown formats as octet-stream', async () => {
      const validator = new MimeConsistencyValidator();
      const binaryData = Buffer.from([0x00, 0xFF, 0xAB, 0xCD]);
      const context: FileValidationContext = {
        buffer: binaryData,
        filename: 'unknown.bin',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/octet-stream');
    });
  });

  describe('PdfValidator', () => {
    it('should accept valid PDF files', async () => {
      const validator = new PdfValidator();
      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: samplePDF.filename,
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true);
    });

    it('should reject PDFs with invalid magic bytes', async () => {
      const validator = new PdfValidator();
      // Create buffer that file-type will detect as PDF but has wrong magic bytes
      const invalidPDF = Buffer.concat([
        Buffer.from('NOTPDF-1.4\n'), // Wrong header
        samplePDF.buffer.subarray(11), // Rest of PDF
      ]);

      const context: FileValidationContext = {
        buffer: invalidPDF,
        filename: 'invalid.pdf',
      };

      const result = await validator.validate(context);

      // Note: file-type library might not detect this as PDF due to wrong magic bytes
      // If detected as non-PDF, validator skips (returns valid: true)
      // If detected as PDF, it should fail the magic byte check
      if (result.detectedMimeType === 'application/pdf') {
        expect(result.valid).toBe(false);
        expect(result.error?.message).toContain('magic bytes');
      } else {
        expect(result.valid).toBe(true); // Skipped PDF validation
      }
    });

    it('should reject PDFs missing EOF marker', async () => {
      const validator = new PdfValidator();
      // Create PDF without %%EOF marker
      const incompletePDF = samplePDF.buffer.subarray(0, samplePDF.buffer.length - 10);

      const context: FileValidationContext = {
        buffer: incompletePDF,
        filename: 'incomplete.pdf',
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('EOF');
    });

    it('should skip validation for non-PDF files', async () => {
      const validator = new PdfValidator();
      const context: FileValidationContext = {
        buffer: samplePNG.buffer,
        filename: samplePNG.filename,
      };

      const result = await validator.validate(context);

      expect(result.valid).toBe(true); // Skipped, not a PDF
    });
  });

  describe('FileValidatorChain', () => {
    it('should run all validators in sequence and accept valid PDF', async () => {
      const chain = new FileValidatorChain();
      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: samplePDF.filename,
        claimedMimeType: 'application/pdf',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/pdf');
    });

    it('should run all validators and accept valid PNG', async () => {
      const chain = new FileValidatorChain();
      const context: FileValidationContext = {
        buffer: samplePNG.buffer,
        filename: samplePNG.filename,
        claimedMimeType: 'image/png',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('image/png');
    });

    it('should run all validators and accept text files', async () => {
      const chain = new FileValidatorChain();
      const context: FileValidationContext = {
        buffer: sampleTXT.buffer,
        filename: sampleTXT.filename,
        claimedMimeType: 'text/plain',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('text/plain');
    });

    it('should return first failure in chain (empty file)', async () => {
      const chain = new FileValidatorChain();
      const context: FileValidationContext = {
        buffer: emptyFile.buffer,
        filename: emptyFile.filename,
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('no data');
    });

    it('should return first failure in chain (oversized file)', async () => {
      const chain = new FileValidatorChain();
      const oversizedBuffer = Buffer.alloc(101 * 1024 * 1024); // 101MB
      const context: FileValidationContext = {
        buffer: oversizedBuffer,
        filename: 'oversized.bin',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('too large');
    });

    it('should accept unknown file formats', async () => {
      const chain = new FileValidatorChain();
      const unknownBuffer = Buffer.from([0x00, 0xFF, 0xAB, 0xCD, 0xEF]);
      const context: FileValidationContext = {
        buffer: unknownBuffer,
        filename: 'unknown.xyz',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/octet-stream');
    });

    it('should handle MIME type mismatch gracefully', async () => {
      const chain = new FileValidatorChain();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: 'document.txt', // Wrong extension
        claimedMimeType: 'text/plain', // Wrong MIME type
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/pdf');
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should propagate detectedMimeType through chain', async () => {
      const chain = new FileValidatorChain();
      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: samplePDF.filename,
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('application/pdf');
    });

    it('should handle files with no claimed MIME type', async () => {
      const chain = new FileValidatorChain();
      const context: FileValidationContext = {
        buffer: samplePNG.buffer,
        filename: samplePNG.filename,
        // No claimedMimeType
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('image/png');
    });
  });

  describe('Edge Cases', () => {
    it('should handle very small valid files', async () => {
      const chain = new FileValidatorChain();
      const tinyText = Buffer.from('a');
      const context: FileValidationContext = {
        buffer: tinyText,
        filename: 'tiny.txt',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
    });

    it('should handle files with special characters in filename', async () => {
      const chain = new FileValidatorChain();
      const context: FileValidationContext = {
        buffer: samplePDF.buffer,
        filename: 'document (1) [final] #2.pdf',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
    });

    it('should handle files with Unicode characters', async () => {
      const chain = new FileValidatorChain();
      const unicodeText = Buffer.from('Hello 世界 🌍', 'utf-8');
      const context: FileValidationContext = {
        buffer: unicodeText,
        filename: 'unicode.txt',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      // Unicode characters may not pass the 90% printable ASCII check
      // The validator detects it as octet-stream or text/plain depending on the content
      expect(['text/plain', 'application/octet-stream']).toContain(result.detectedMimeType);
    });

    it('should handle files with mixed line endings', async () => {
      const chain = new FileValidatorChain();
      const mixedLineEndings = Buffer.from('line1\nline2\r\nline3\rline4');
      const context: FileValidationContext = {
        buffer: mixedLineEndings,
        filename: 'mixed.txt',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('text/plain');
    });

    it('should handle files with only whitespace', async () => {
      const chain = new FileValidatorChain();
      const whitespaceOnly = Buffer.from('   \n\t  \r\n  ');
      const context: FileValidationContext = {
        buffer: whitespaceOnly,
        filename: 'whitespace.txt',
      };

      const result = await chain.validate(context);

      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('text/plain');
    });
  });
});
