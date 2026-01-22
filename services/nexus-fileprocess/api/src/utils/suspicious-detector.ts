/**
 * Suspicious File Detector
 *
 * Utility to detect suspicious indicators in ANY file type that should
 * trigger full CyberAgent malware analysis.
 *
 * Design Philosophy:
 * - Any hint of suspicion → Full malware testing
 * - False positives are acceptable (better safe than sorry)
 * - Non-binary files can contain threats too (macros, scripts, etc.)
 *
 * Detection Categories:
 * 1. Filename patterns (double extensions, suspicious names)
 * 2. Magic byte mismatches (file claims to be X but is Y)
 * 3. Known malicious patterns in content
 * 4. Entropy analysis (encrypted/packed content)
 * 5. Embedded executable detection
 */

import { logger } from './logger';

/**
 * Suspicious detection result
 */
export interface SuspiciousResult {
  isSuspicious: boolean;
  confidence: number; // 0.0 - 1.0
  threatLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  flags: string[];
  recommendations: string[];
  requiresFullScan: boolean;
}

/**
 * Input for suspicious detection
 */
export interface SuspiciousDetectionInput {
  filename: string;
  claimedMimeType?: string;
  detectedMimeType?: string;
  buffer?: Buffer;
  fileSize?: number;
}

// ============================================================================
// SUSPICIOUS FILENAME PATTERNS
// ============================================================================

/**
 * Double extension patterns often used to disguise executables
 */
const DOUBLE_EXTENSION_PATTERNS = [
  /\.(pdf|doc|docx|txt|jpg|png|mp3|mp4)\.(exe|scr|bat|cmd|com|pif|msi|vbs|js|jse|wsf|wsh)$/i,
  /\.(pdf|doc|docx|txt|jpg|png|mp3|mp4)\.(dll|so|dylib)$/i,
];

/**
 * Suspicious filename patterns
 */
const SUSPICIOUS_FILENAME_PATTERNS = [
  /^(invoice|payment|receipt|document|urgent|important|scan|fax|order)[-_]?\d*\.(zip|rar|7z|exe|scr|js)$/i,
  /^cv[-_]?resume[-_]?\d*\.(zip|rar|exe|doc)$/i,
  /(crack|keygen|activator|patch|hack|exploit)[-_]?/i,
  /password[-_]?protected/i,
  /(torrent|warez|pirate)/i,
  /\.(scr|pif|com|hta|vbe|vbs|jse|wsf|wsh)$/i, // Highly suspicious extensions
];

/**
 * Suspicious characters in filenames
 */
const SUSPICIOUS_FILENAME_CHARS = [
  /\u202e/, // Right-to-left override (used to reverse filename display)
  /\u200e/, // Left-to-right mark
  /\u200f/, // Right-to-left mark
  /[\x00-\x1f]/, // Control characters
];

// ============================================================================
// SUSPICIOUS CONTENT PATTERNS
// ============================================================================

/**
 * Suspicious strings that may indicate malicious content
 * These are searched in file content (especially for documents, scripts)
 */
const SUSPICIOUS_CONTENT_STRINGS = [
  // PowerShell
  'powershell',
  'invoke-expression',
  'iex',
  'downloadstring',
  'invoke-webrequest',
  'new-object system.net.webclient',
  'bypass',
  '-enc ',
  '-encodedcommand',

  // VBA/Macro
  'auto_open',
  'autoopen',
  'auto_close',
  'document_open',
  'workbook_open',
  'shell(',
  'wscript.shell',
  'cmd.exe',
  'cmd /c',
  'certutil',

  // JavaScript
  'eval(',
  'fromcharcode',
  'document.write',
  'unescape(',

  // Network
  'createobject("msxml2',
  'xmlhttp',
  'xmlhttprequest',
  'winhttprequest',

  // File operations
  'filesystemobject',
  'createtextfile',
  'adodb.stream',

  // System commands
  'regsvr32',
  'mshta',
  'rundll32',
  'schtasks',
  'bitsadmin',
];

/**
 * Executable signatures to detect embedded executables
 * (including PE header MZ signature)
 */
const EXECUTABLE_SIGNATURES = [
  { signature: Buffer.from([0x4D, 0x5A]), name: 'PE/EXE' }, // MZ - Windows PE
  { signature: Buffer.from([0x7F, 0x45, 0x4C, 0x46]), name: 'ELF' }, // ELF - Linux
  { signature: Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]), name: 'Mach-O Universal' },
  { signature: Buffer.from([0xCF, 0xFA, 0xED, 0xFE]), name: 'Mach-O 64-bit' },
  { signature: Buffer.from([0xCE, 0xFA, 0xED, 0xFE]), name: 'Mach-O 32-bit' },
  { signature: Buffer.from([0x50, 0x4B, 0x03, 0x04]), name: 'ZIP/JAR/APK' }, // ZIP archives
];

// ============================================================================
// MIME TYPE MISMATCHES
// ============================================================================

/**
 * Expected magic bytes for common MIME types
 */
const MIME_MAGIC_MAP: Record<string, Buffer[]> = {
  'application/pdf': [Buffer.from([0x25, 0x50, 0x44, 0x46])], // %PDF
  'image/jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  'image/gif': [Buffer.from([0x47, 0x49, 0x46, 0x38])], // GIF8
  'application/zip': [Buffer.from([0x50, 0x4B, 0x03, 0x04])],
  'application/x-rar-compressed': [Buffer.from([0x52, 0x61, 0x72, 0x21])], // Rar!
  'application/gzip': [Buffer.from([0x1F, 0x8B])],
};

// ============================================================================
// DETECTION FUNCTIONS
// ============================================================================

/**
 * Check if filename has suspicious patterns
 */
function checkFilenamePatterns(filename: string): { suspicious: boolean; flags: string[] } {
  const flags: string[] = [];

  // Check double extensions
  for (const pattern of DOUBLE_EXTENSION_PATTERNS) {
    if (pattern.test(filename)) {
      flags.push(`Double extension detected: ${filename}`);
    }
  }

  // Check suspicious patterns
  for (const pattern of SUSPICIOUS_FILENAME_PATTERNS) {
    if (pattern.test(filename)) {
      flags.push(`Suspicious filename pattern: ${pattern.source}`);
    }
  }

  // Check suspicious characters
  for (const pattern of SUSPICIOUS_FILENAME_CHARS) {
    if (pattern.test(filename)) {
      flags.push(`Suspicious character in filename (possible RLO attack)`);
    }
  }

  return {
    suspicious: flags.length > 0,
    flags,
  };
}

/**
 * Check if MIME type matches magic bytes
 */
function checkMimeTypeMismatch(
  claimedMimeType: string | undefined,
  detectedMimeType: string | undefined,
  buffer: Buffer | undefined
): { suspicious: boolean; flags: string[] } {
  const flags: string[] = [];

  // If claimed type differs from detected type, that's suspicious
  if (claimedMimeType && detectedMimeType &&
      claimedMimeType !== detectedMimeType &&
      !claimedMimeType.includes('octet-stream')) {
    flags.push(`MIME type mismatch: claimed ${claimedMimeType}, detected ${detectedMimeType}`);
  }

  // Check if magic bytes match claimed type
  if (buffer && claimedMimeType && MIME_MAGIC_MAP[claimedMimeType]) {
    const expectedMagics = MIME_MAGIC_MAP[claimedMimeType];
    const matchesExpected = expectedMagics.some(magic =>
      buffer.slice(0, magic.length).equals(magic)
    );

    if (!matchesExpected) {
      flags.push(`Magic bytes don't match claimed MIME type: ${claimedMimeType}`);
    }
  }

  return {
    suspicious: flags.length > 0,
    flags,
  };
}

/**
 * Check for embedded executables in non-executable files
 */
function checkEmbeddedExecutables(
  buffer: Buffer | undefined,
  detectedMimeType: string | undefined
): { suspicious: boolean; flags: string[] } {
  const flags: string[] = [];

  if (!buffer || buffer.length < 4) {
    return { suspicious: false, flags: [] };
  }

  // Skip if file is already a known binary type
  const binaryTypes = [
    'application/x-executable',
    'application/x-mach-binary',
    'application/x-dosexec',
    'application/x-msdownload',
    'application/x-elf',
    'application/octet-stream',
  ];

  if (detectedMimeType && binaryTypes.includes(detectedMimeType)) {
    return { suspicious: false, flags: [] };
  }

  // Skip embedded executable check for document types that commonly embed fonts
  // PDF fonts (especially TrueType/OpenType) contain MZ headers which are false positives
  // Office documents have similar issues with embedded OLE objects
  const documentTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
    'application/msword', // doc
    'application/vnd.ms-excel', // xls
    'application/vnd.ms-powerpoint', // ppt
  ];

  if (detectedMimeType && documentTypes.includes(detectedMimeType)) {
    return { suspicious: false, flags: [] };
  }

  // Search for executable signatures within the file
  // Skip first 4 bytes to avoid matching file's own header
  const searchStart = 4;
  const searchEnd = Math.min(buffer.length, 1024 * 1024); // Search first 1MB

  for (let i = searchStart; i < searchEnd - 4; i++) {
    for (const sig of EXECUTABLE_SIGNATURES) {
      if (buffer.slice(i, i + sig.signature.length).equals(sig.signature)) {
        flags.push(`Embedded executable detected at offset ${i}: ${sig.name}`);
        return { suspicious: true, flags }; // One is enough
      }
    }
  }

  return {
    suspicious: flags.length > 0,
    flags,
  };
}

/**
 * Check for suspicious content strings
 */
function checkSuspiciousContent(buffer: Buffer | undefined): { suspicious: boolean; flags: string[] } {
  const flags: string[] = [];

  if (!buffer || buffer.length < 10) {
    return { suspicious: false, flags: [] };
  }

  // Only check text-like content (skip binary files)
  // Check first 1000 bytes for printable characters
  const sampleSize = Math.min(buffer.length, 1000);
  let printableCount = 0;
  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) {
      printableCount++;
    }
  }

  // If less than 70% printable, skip content analysis
  if (printableCount / sampleSize < 0.7) {
    return { suspicious: false, flags: [] };
  }

  // Convert to lowercase string for searching
  const content = buffer.toString('utf-8', 0, Math.min(buffer.length, 512 * 1024)).toLowerCase();

  for (const pattern of SUSPICIOUS_CONTENT_STRINGS) {
    if (content.includes(pattern.toLowerCase())) {
      flags.push(`Suspicious content pattern: "${pattern}"`);
      if (flags.length >= 3) break; // Limit to 3 flags
    }
  }

  return {
    suspicious: flags.length > 0,
    flags,
  };
}

/**
 * Calculate Shannon entropy of data
 * High entropy (>7.5 for 8-bit) indicates encryption or compression
 */
function calculateEntropy(buffer: Buffer): number {
  if (!buffer || buffer.length === 0) return 0;

  const sampleSize = Math.min(buffer.length, 64 * 1024); // Sample first 64KB
  const frequencies = new Array(256).fill(0);

  for (let i = 0; i < sampleSize; i++) {
    frequencies[buffer[i]]++;
  }

  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (frequencies[i] > 0) {
      const probability = frequencies[i] / sampleSize;
      entropy -= probability * Math.log2(probability);
    }
  }

  return entropy;
}

/**
 * Check for high entropy (possible encryption/packing)
 */
function checkHighEntropy(
  buffer: Buffer | undefined,
  detectedMimeType: string | undefined,
  filename?: string
): { suspicious: boolean; flags: string[] } {
  const flags: string[] = [];

  if (!buffer || buffer.length < 1000) {
    return { suspicious: false, flags: [] };
  }

  // Skip if file is already a compressed or naturally high-entropy type
  // These file types use internal compression/encoding that results in high entropy
  // but are legitimate and should not trigger suspicious file detection
  const compressedTypes = [
    // Archives
    'application/zip',
    'application/gzip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'application/x-bzip2',
    'application/x-xz',
    'application/x-tar',
    'application/x-compress',
    'application/x-lzip',
    'application/zstd',

    // Images
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/tiff',
    'image/avif',
    'image/heic',
    'image/heif',

    // Media (partial match)
    'video/',
    'audio/',

    // PDF documents (use FlateDecode/DCTDecode compression)
    'application/pdf',

    // Modern Office formats (OOXML - internally ZIP archives)
    'application/vnd.openxmlformats-officedocument',

    // Legacy Office formats (with OLE compression)
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',

    // OpenDocument formats (internally ZIP archives)
    'application/vnd.oasis.opendocument',

    // Container/package formats (ZIP-based)
    'application/x-apple-diskimage',
    'application/vnd.android.package-archive',
    'application/java-archive',

    // Font files (often compressed)
    'font/',
    'application/font-',
    'application/x-font-',
  ];

  if (detectedMimeType && compressedTypes.some(t => detectedMimeType.includes(t))) {
    return { suspicious: false, flags: [] };
  }

  // Also skip based on file extension when MIME type is generic (e.g., application/octet-stream)
  // This handles cases where the source (like Google Drive) returns incorrect MIME types
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const safeExtensions = [
      // Documents
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
      // Archives
      'zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar', 'tgz', 'tbz2',
      // Images
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'bmp', 'ico',
      // Media
      'mp3', 'mp4', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma',
      'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v',
      // Fonts
      'ttf', 'otf', 'woff', 'woff2', 'eot',
      // Other compressed/binary formats
      'dmg', 'iso', 'apk', 'jar', 'war', 'ear', 'ipa',
      'epub', 'mobi', 'azw', 'azw3',
      'psd', 'ai', 'sketch', 'fig', 'xd',
    ];
    if (ext && safeExtensions.includes(ext)) {
      return { suspicious: false, flags: [] };
    }
  }

  const entropy = calculateEntropy(buffer);

  // Entropy > 7.5 for non-compressed files is suspicious
  // (could indicate packed/encrypted malware)
  if (entropy > 7.5) {
    flags.push(`High entropy detected (${entropy.toFixed(2)}): possible encrypted/packed content`);
  }

  return {
    suspicious: flags.length > 0,
    flags,
  };
}

// ============================================================================
// MAIN DETECTION FUNCTION
// ============================================================================

/**
 * Detect if a file shows any suspicious indicators
 *
 * @param input - File information for analysis
 * @returns Detection result with flags and recommendations
 */
export function detectSuspiciousFile(input: SuspiciousDetectionInput): SuspiciousResult {
  const startTime = Date.now();
  const allFlags: string[] = [];

  // Run all detection checks
  const filenameResult = checkFilenamePatterns(input.filename);
  allFlags.push(...filenameResult.flags);

  const mimeResult = checkMimeTypeMismatch(
    input.claimedMimeType,
    input.detectedMimeType,
    input.buffer
  );
  allFlags.push(...mimeResult.flags);

  const embeddedResult = checkEmbeddedExecutables(input.buffer, input.detectedMimeType);
  allFlags.push(...embeddedResult.flags);

  const contentResult = checkSuspiciousContent(input.buffer);
  allFlags.push(...contentResult.flags);

  const entropyResult = checkHighEntropy(input.buffer, input.detectedMimeType, input.filename);
  allFlags.push(...entropyResult.flags);

  // Calculate threat level based on flags
  const isSuspicious = allFlags.length > 0;
  let threatLevel: SuspiciousResult['threatLevel'] = 'none';
  let confidence = 0;

  if (allFlags.length >= 3) {
    threatLevel = 'high';
    confidence = 0.9;
  } else if (allFlags.length === 2) {
    threatLevel = 'medium';
    confidence = 0.7;
  } else if (allFlags.length === 1) {
    threatLevel = 'low';
    confidence = 0.5;
  }

  // Elevate to critical if embedded executable found
  if (embeddedResult.suspicious) {
    threatLevel = 'critical';
    confidence = Math.max(confidence, 0.85);
  }

  // Build recommendations
  const recommendations: string[] = [];
  if (isSuspicious) {
    recommendations.push('Route to CyberAgent for full malware analysis');
    recommendations.push('Do not process until security scan completes');
    if (threatLevel === 'critical' || threatLevel === 'high') {
      recommendations.push('Consider blocking file if scan finds threats');
    }
  }

  const durationMs = Date.now() - startTime;

  const result: SuspiciousResult = {
    isSuspicious,
    confidence,
    threatLevel,
    flags: allFlags,
    recommendations,
    requiresFullScan: isSuspicious,
  };

  if (isSuspicious) {
    logger.info('Suspicious file detected', {
      filename: input.filename,
      threatLevel,
      confidence,
      flagCount: allFlags.length,
      flags: allFlags.slice(0, 5), // Log first 5 flags
      durationMs,
    });
  } else {
    logger.debug('File passed suspicious detection checks', {
      filename: input.filename,
      durationMs,
    });
  }

  return result;
}

/**
 * Quick check - returns true if ANY suspicion detected
 * Use this for fast routing decisions
 */
export function isFileSuspicious(input: SuspiciousDetectionInput): boolean {
  return detectSuspiciousFile(input).isSuspicious;
}

export default {
  detectSuspiciousFile,
  isFileSuspicious,
};
