/**
 * Mock for file-type library (ESM module)
 *
 * Phase 7-8: Test Infrastructure
 *
 * Provides mock implementation of fileTypeFromBuffer for testing
 * without importing the actual ESM module
 */

export const fileTypeFromBuffer = jest.fn(async (buffer: Buffer) => {
  // PDF magic bytes: %PDF
  if (buffer.subarray(0, 4).toString() === '%PDF') {
    return { mime: 'application/pdf', ext: 'pdf' };
  }

  // PNG magic bytes: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mime: 'image/png', ext: 'png' };
  }

  // JPEG magic bytes: FF D8 FF
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }

  // ZIP magic bytes: 50 4B 03 04 or 50 4B 05 06 or 50 4B 07 08
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  ) {
    return { mime: 'application/zip', ext: 'zip' };
  }

  // TAR magic bytes: "ustar" at offset 257
  if (buffer.length > 262) {
    const tarMagic = buffer.subarray(257, 262).toString();
    if (tarMagic === 'ustar') {
      return { mime: 'application/x-tar', ext: 'tar' };
    }
  }

  // GZIP magic bytes: 1F 8B
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return { mime: 'application/gzip', ext: 'gz' };
  }

  // BZIP2 magic bytes: 42 5A 68
  if (buffer[0] === 0x42 && buffer[1] === 0x5a && buffer[2] === 0x68) {
    return { mime: 'application/x-bzip2', ext: 'bz2' };
  }

  // RAR magic bytes: 52 61 72 21 1A 07 (Rar! followed by EOF and version)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x61 &&
    buffer[2] === 0x72 &&
    buffer[3] === 0x21
  ) {
    return { mime: 'application/x-rar-compressed', ext: 'rar' };
  }

  // 7Z magic bytes: 37 7A BC AF 27 1C
  if (
    buffer[0] === 0x37 &&
    buffer[1] === 0x7a &&
    buffer[2] === 0xbc &&
    buffer[3] === 0xaf
  ) {
    return { mime: 'application/x-7z-compressed', ext: '7z' };
  }

  // DOCX/XLSX/PPTX (ZIP-based Office formats)
  // These start with ZIP magic bytes but have specific file structures
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const content = buffer.toString('utf-8');
    if (content.includes('word/')) {
      return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
    }
    if (content.includes('xl/')) {
      return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    }
    if (content.includes('ppt/')) {
      return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' };
    }
    // Generic ZIP (no Office markers found)
    return { mime: 'application/zip', ext: 'zip' };
  }

  // DOC magic bytes: D0 CF 11 E0 A1 B1 1A E1 (OLE/CFB header)
  if (
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0
  ) {
    return { mime: 'application/msword', ext: 'doc' };
  }

  // No recognized magic bytes
  return undefined;
});
