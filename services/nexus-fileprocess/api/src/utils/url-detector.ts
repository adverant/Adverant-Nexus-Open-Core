/**
 * URL Detection Utilities
 *
 * Provides intelligent URL detection and classification for various content sources.
 * Supports YouTube, Google Drive (files and folders), GitHub repositories,
 * direct HTTP/HTTPS URLs, and local files.
 *
 * @module url-detector
 */

/**
 * URL source types for content identification
 *
 * - `youtube`: YouTube video URL (watch, shorts, embed, youtu.be)
 * - `google_drive_file`: Google Drive individual file
 * - `google_drive_folder`: Google Drive folder (requires recursive discovery)
 * - `github_repo`: GitHub repository URL (requires ingestion via GitHub Manager)
 * - `github_raw_file`: GitHub raw file URL (direct file download)
 * - `http_direct`: Direct HTTP/HTTPS URL to a file
 * - `file_local`: Local file path (file:// protocol or absolute path)
 * - `unknown`: Unrecognized URL format
 */
export type UrlSourceType =
  | 'youtube'
  | 'google_drive_file'
  | 'google_drive_folder'
  | 'github_repo'
  | 'github_raw_file'
  | 'http_direct'
  | 'file_local'
  | 'unknown';

// ============================================================================
// YouTube URL Patterns
// ============================================================================

/**
 * YouTube URL patterns for detection
 *
 * Supports:
 * - Standard watch URLs: https://www.youtube.com/watch?v=VIDEO_ID
 * - Shorts: https://www.youtube.com/shorts/VIDEO_ID
 * - Shortened URLs: https://youtu.be/VIDEO_ID
 * - Embed URLs: https://www.youtube.com/embed/VIDEO_ID
 */
const YOUTUBE_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch\?v=/,
  /^https?:\/\/(www\.)?youtube\.com\/shorts\//,
  /^https?:\/\/youtu\.be\//,
  /^https?:\/\/(www\.)?youtube\.com\/embed\//,
];

/**
 * YouTube video ID extraction patterns
 *
 * Captures the 11-character video ID from various YouTube URL formats:
 * - watch?v=VIDEO_ID
 * - shorts/VIDEO_ID
 * - youtu.be/VIDEO_ID
 * - embed/VIDEO_ID
 */
const YOUTUBE_ID_PATTERNS = [
  /[?&]v=([a-zA-Z0-9_-]{11})/, // watch?v=
  /\/shorts\/([a-zA-Z0-9_-]{11})/, // shorts/
  /youtu\.be\/([a-zA-Z0-9_-]{11})/, // youtu.be/
  /\/embed\/([a-zA-Z0-9_-]{11})/, // embed/
];

// ============================================================================
// Google Drive URL Patterns
// ============================================================================

/**
 * Google Drive file URL patterns
 *
 * Supports:
 * - File view URLs: https://drive.google.com/file/d/FILE_ID/view
 * - Open URLs: https://drive.google.com/open?id=FILE_ID
 */
const GOOGLE_DRIVE_FILE_PATTERNS = [
  /^https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
  /^https?:\/\/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
];

/**
 * Google Drive folder URL patterns
 *
 * Supports:
 * - Folder URLs: https://drive.google.com/drive/folders/FOLDER_ID
 */
const GOOGLE_DRIVE_FOLDER_PATTERNS = [
  /^https?:\/\/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/,
];

// ============================================================================
// GitHub URL Patterns
// ============================================================================

/**
 * GitHub repository URL patterns
 *
 * Supports:
 * - Standard repo URLs: https://github.com/owner/repo
 * - With .git suffix: https://github.com/owner/repo.git
 * - SSH URLs: git@github.com:owner/repo.git
 * - Branch URLs: https://github.com/owner/repo/tree/branch
 *
 * Note: Repo names can contain dots (e.g., Adverant.ai)
 * We explicitly exclude paths that indicate file access (/blob/, /raw/)
 */
const GITHUB_REPO_PATTERNS = [
  // Standard HTTPS repo URL - must NOT be followed by /blob/, /raw/, or other file paths
  // Matches: github.com/owner/repo, github.com/owner/repo.git, github.com/owner/repo/tree/branch
  /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|commits?|issues?|pulls?|releases?|actions?|projects?|wiki|settings|branches|tags)(?:\/.*)?)?$/,
  // Base repo URL without path
  /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/,
  // SSH URL: git@github.com:owner/repo.git
  /^git@github\.com:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/,
];

/**
 * GitHub raw file URL patterns
 *
 * Supports:
 * - Raw content URLs: https://raw.githubusercontent.com/owner/repo/branch/path
 * - Blob URLs: https://github.com/owner/repo/blob/branch/path
 */
const GITHUB_RAW_FILE_PATTERNS = [
  // raw.githubusercontent.com URLs
  /^https?:\/\/raw\.githubusercontent\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/([^\/]+)\/(.+)$/,
  // github.com/owner/repo/blob/branch/path URLs
  /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/blob\/([^\/]+)\/(.+)$/,
  // github.com/owner/repo/raw/branch/path URLs
  /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/raw\/([^\/]+)\/(.+)$/,
];

// ============================================================================
// URL Detection Functions
// ============================================================================

/**
 * Detect the type of URL source
 *
 * Classifies URLs into specific source types for appropriate processing.
 * Uses pattern matching to identify YouTube, Google Drive, HTTP, and local file URLs.
 *
 * @param url - The URL to classify
 * @returns The detected URL source type
 *
 * @example
 * ```typescript
 * detectUrlType('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
 * // Returns: 'youtube'
 *
 * detectUrlType('https://drive.google.com/file/d/1abc123/view');
 * // Returns: 'google_drive_file'
 *
 * detectUrlType('https://example.com/video.mp4');
 * // Returns: 'http_direct'
 *
 * detectUrlType('file:///Users/user/video.mp4');
 * // Returns: 'file_local'
 * ```
 */
export function detectUrlType(url: string): UrlSourceType {
  // YouTube detection
  if (isYouTubeUrl(url)) {
    return 'youtube';
  }

  // Google Drive folder detection (check before file, as folders are more specific)
  if (isGoogleDriveFolder(url)) {
    return 'google_drive_folder';
  }

  // Google Drive file detection
  if (isGoogleDriveUrl(url)) {
    return 'google_drive_file';
  }

  // GitHub raw file detection (check before repo, as it's more specific)
  if (isGitHubRawFileUrl(url)) {
    return 'github_raw_file';
  }

  // GitHub repository detection
  if (isGitHubRepoUrl(url)) {
    return 'github_repo';
  }

  // Local file path detection
  if (url.startsWith('file://') || url.startsWith('/') || /^[a-zA-Z]:\\/.test(url)) {
    return 'file_local';
  }

  // HTTP/HTTPS direct URL
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return 'http_direct';
  }

  // Unknown format
  return 'unknown';
}

/**
 * Check if URL is a YouTube video
 *
 * Matches against all supported YouTube URL formats including:
 * - Standard watch URLs
 * - Shorts
 * - Shortened youtu.be URLs
 * - Embed URLs
 *
 * @param url - The URL to check
 * @returns True if the URL is a YouTube video, false otherwise
 *
 * @example
 * ```typescript
 * isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
 * // Returns: true
 *
 * isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ');
 * // Returns: true
 *
 * isYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
 * // Returns: true
 *
 * isYouTubeUrl('https://example.com/video.mp4');
 * // Returns: false
 * ```
 */
export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Check if URL is a Google Drive URL (file or folder)
 *
 * Matches both file and folder URLs from Google Drive.
 * For more specific detection, use `isGoogleDriveFolder()`.
 *
 * @param url - The URL to check
 * @returns True if the URL is a Google Drive URL, false otherwise
 *
 * @example
 * ```typescript
 * isGoogleDriveUrl('https://drive.google.com/file/d/1abc123/view');
 * // Returns: true
 *
 * isGoogleDriveUrl('https://drive.google.com/drive/folders/1abc123');
 * // Returns: true
 *
 * isGoogleDriveUrl('https://example.com/file.pdf');
 * // Returns: false
 * ```
 */
export function isGoogleDriveUrl(url: string): boolean {
  return (
    GOOGLE_DRIVE_FILE_PATTERNS.some(pattern => pattern.test(url)) ||
    GOOGLE_DRIVE_FOLDER_PATTERNS.some(pattern => pattern.test(url))
  );
}

/**
 * Check if URL is a Google Drive folder
 *
 * Specifically detects Google Drive folder URLs.
 * Folder URLs require recursive file discovery for processing.
 *
 * @param url - The URL to check
 * @returns True if the URL is a Google Drive folder, false otherwise
 *
 * @example
 * ```typescript
 * isGoogleDriveFolder('https://drive.google.com/drive/folders/1abc123');
 * // Returns: true
 *
 * isGoogleDriveFolder('https://drive.google.com/file/d/1abc123/view');
 * // Returns: false
 * ```
 */
export function isGoogleDriveFolder(url: string): boolean {
  return GOOGLE_DRIVE_FOLDER_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Extract Google Drive file ID from URL
 *
 * Extracts the unique file identifier from Google Drive file URLs.
 * The file ID is used for Google Drive API operations.
 *
 * @param url - The Google Drive URL
 * @returns The file ID if found, null otherwise
 *
 * @example
 * ```typescript
 * extractGoogleDriveFileId('https://drive.google.com/file/d/1abc123def456/view');
 * // Returns: '1abc123def456'
 *
 * extractGoogleDriveFileId('https://drive.google.com/open?id=1abc123def456');
 * // Returns: '1abc123def456'
 *
 * extractGoogleDriveFileId('https://example.com/file.pdf');
 * // Returns: null
 * ```
 */
export function extractGoogleDriveFileId(url: string): string | null {
  for (const pattern of GOOGLE_DRIVE_FILE_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extract Google Drive folder ID from URL
 *
 * Extracts the unique folder identifier from Google Drive folder URLs.
 * The folder ID is used for Google Drive API operations and recursive discovery.
 *
 * @param url - The Google Drive folder URL
 * @returns The folder ID if found, null otherwise
 *
 * @example
 * ```typescript
 * extractGoogleDriveFolderId('https://drive.google.com/drive/folders/1abc123def456');
 * // Returns: '1abc123def456'
 *
 * extractGoogleDriveFolderId('https://drive.google.com/file/d/1abc123/view');
 * // Returns: null
 * ```
 */
export function extractGoogleDriveFolderId(url: string): string | null {
  for (const pattern of GOOGLE_DRIVE_FOLDER_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extract YouTube video ID from URL
 *
 * Extracts the 11-character video ID from various YouTube URL formats.
 * The video ID is used for YouTube API operations and video retrieval.
 *
 * Supports:
 * - Watch URLs: https://www.youtube.com/watch?v=VIDEO_ID
 * - Shorts: https://www.youtube.com/shorts/VIDEO_ID
 * - Shortened URLs: https://youtu.be/VIDEO_ID
 * - Embed URLs: https://www.youtube.com/embed/VIDEO_ID
 *
 * @param url - The YouTube URL
 * @returns The video ID if found, null otherwise
 *
 * @example
 * ```typescript
 * extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
 * // Returns: 'dQw4w9WgXcQ'
 *
 * extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ');
 * // Returns: 'dQw4w9WgXcQ'
 *
 * extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ');
 * // Returns: 'dQw4w9WgXcQ'
 *
 * extractYouTubeVideoId('https://example.com/video.mp4');
 * // Returns: null
 * ```
 */
export function extractYouTubeVideoId(url: string): string | null {
  for (const pattern of YOUTUBE_ID_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Normalize URL for consistent processing
 *
 * Removes query parameters and fragments (except for essential ones like YouTube video IDs)
 * and ensures consistent URL formatting.
 *
 * @param url - The URL to normalize
 * @returns The normalized URL
 *
 * @example
 * ```typescript
 * normalizeUrl('https://example.com/file.pdf?download=true#section');
 * // Returns: 'https://example.com/file.pdf'
 *
 * normalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s');
 * // Returns: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
 * ```
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);

    // For YouTube, preserve only the video ID parameter
    if (urlObj.hostname.includes('youtube.com')) {
      const videoId = urlObj.searchParams.get('v');
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    // For other URLs, remove query parameters and fragments
    urlObj.search = '';
    urlObj.hash = '';

    return urlObj.toString();
  } catch (error) {
    // If URL parsing fails, return original URL
    return url;
  }
}

/**
 * Validate URL format
 *
 * Checks if the URL is valid and well-formed.
 * Does not check if the URL is accessible or exists.
 *
 * @param url - The URL to validate
 * @returns True if the URL is valid, false otherwise
 *
 * @example
 * ```typescript
 * isValidUrl('https://example.com/file.pdf');
 * // Returns: true
 *
 * isValidUrl('not-a-url');
 * // Returns: false
 *
 * isValidUrl('file:///Users/user/video.mp4');
 * // Returns: true
 * ```
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    // Check if it's a valid local file path
    return url.startsWith('/') || /^[a-zA-Z]:\\/.test(url);
  }
}

/**
 * Get file extension from URL
 *
 * Extracts the file extension from a URL or file path.
 * Handles query parameters and fragments correctly.
 *
 * @param url - The URL or file path
 * @returns The file extension (without dot) or null if no extension found
 *
 * @example
 * ```typescript
 * getFileExtensionFromUrl('https://example.com/video.mp4');
 * // Returns: 'mp4'
 *
 * getFileExtensionFromUrl('https://example.com/document.pdf?download=true');
 * // Returns: 'pdf'
 *
 * getFileExtensionFromUrl('https://example.com/page');
 * // Returns: null
 * ```
 */
export function getFileExtensionFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const lastDot = pathname.lastIndexOf('.');
    const lastSlash = pathname.lastIndexOf('/');

    if (lastDot > lastSlash && lastDot !== -1) {
      return pathname.substring(lastDot + 1).toLowerCase();
    }
  } catch {
    // Fallback for local file paths
    const lastDot = url.lastIndexOf('.');
    const lastSlash = Math.max(url.lastIndexOf('/'), url.lastIndexOf('\\'));

    if (lastDot > lastSlash && lastDot !== -1) {
      return url.substring(lastDot + 1).toLowerCase();
    }
  }

  return null;
}

/**
 * Check if URL points to a video file
 *
 * Detects video files based on common video file extensions.
 * Does not check MIME type or actual file content.
 *
 * @param url - The URL to check
 * @returns True if the URL appears to point to a video file, false otherwise
 *
 * @example
 * ```typescript
 * isVideoUrl('https://example.com/movie.mp4');
 * // Returns: true
 *
 * isVideoUrl('https://example.com/video.mkv');
 * // Returns: true
 *
 * isVideoUrl('https://example.com/document.pdf');
 * // Returns: false
 * ```
 */
export function isVideoUrl(url: string): boolean {
  const extension = getFileExtensionFromUrl(url);
  if (!extension) {
    return false;
  }

  const videoExtensions = [
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm',
    'm4v', 'mpg', 'mpeg', '3gp', 'ogv', 'ts', 'm2ts'
  ];

  return videoExtensions.includes(extension);
}

// ============================================================================
// GitHub URL Detection Functions
// ============================================================================

/**
 * Check if URL is a GitHub repository URL
 *
 * Detects URLs that point to a GitHub repository (not a specific file).
 * Matches standard HTTPS URLs, URLs with .git suffix, SSH URLs, and branch/tag URLs.
 *
 * @param url - The URL to check
 * @returns True if the URL points to a GitHub repository, false otherwise
 *
 * @example
 * ```typescript
 * isGitHubRepoUrl('https://github.com/adverant/nexus-cli');
 * // Returns: true
 *
 * isGitHubRepoUrl('https://github.com/adverant/Adverant.ai');
 * // Returns: true (repo names can contain dots)
 *
 * isGitHubRepoUrl('https://github.com/adverant/nexus-cli/tree/main');
 * // Returns: true (branch URLs are still repo references)
 *
 * isGitHubRepoUrl('https://github.com/adverant/nexus-cli/blob/main/README.md');
 * // Returns: false (this is a file URL)
 *
 * isGitHubRepoUrl('git@github.com:adverant/nexus-cli.git');
 * // Returns: true (SSH URL)
 * ```
 */
export function isGitHubRepoUrl(url: string): boolean {
  // First check if it's a raw file URL (exclude these)
  if (isGitHubRawFileUrl(url)) {
    return false;
  }

  // Check against repo patterns
  return GITHUB_REPO_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Check if URL is a GitHub raw file URL
 *
 * Detects URLs that point to raw file content on GitHub.
 * Matches raw.githubusercontent.com URLs and /blob/ or /raw/ path URLs.
 *
 * @param url - The URL to check
 * @returns True if the URL points to a raw GitHub file, false otherwise
 *
 * @example
 * ```typescript
 * isGitHubRawFileUrl('https://raw.githubusercontent.com/adverant/nexus-cli/main/README.md');
 * // Returns: true
 *
 * isGitHubRawFileUrl('https://github.com/adverant/nexus-cli/blob/main/package.json');
 * // Returns: true
 *
 * isGitHubRawFileUrl('https://github.com/adverant/nexus-cli');
 * // Returns: false (repo URL, not file)
 * ```
 */
export function isGitHubRawFileUrl(url: string): boolean {
  return GITHUB_RAW_FILE_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * GitHub repository information extracted from URL
 */
export interface GitHubRepoInfo {
  /** Repository owner (user or organization) */
  owner: string;
  /** Repository name */
  repo: string;
  /** Branch name if present in URL */
  branch?: string;
  /** Full repository identifier (owner/repo) */
  fullName: string;
  /** Normalized HTTPS clone URL */
  cloneUrl: string;
}

/**
 * Extract repository information from a GitHub URL
 *
 * Parses various GitHub URL formats and extracts the owner, repo name,
 * and optionally the branch if specified in the URL.
 *
 * @param url - The GitHub URL to parse
 * @returns Repository info if parseable, null otherwise
 *
 * @example
 * ```typescript
 * extractGitHubRepoInfo('https://github.com/adverant/nexus-cli');
 * // Returns: { owner: 'adverant', repo: 'nexus-cli', fullName: 'adverant/nexus-cli', cloneUrl: 'https://github.com/adverant/nexus-cli.git' }
 *
 * extractGitHubRepoInfo('https://github.com/adverant/nexus-cli/tree/develop');
 * // Returns: { owner: 'adverant', repo: 'nexus-cli', branch: 'develop', ... }
 *
 * extractGitHubRepoInfo('git@github.com:adverant/nexus-cli.git');
 * // Returns: { owner: 'adverant', repo: 'nexus-cli', ... }
 * ```
 */
export function extractGitHubRepoInfo(url: string): GitHubRepoInfo | null {
  // Try each pattern to extract owner and repo
  for (const pattern of GITHUB_REPO_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1] && match[2]) {
      const owner = match[1];
      // Clean repo name - remove .git suffix if present
      const repo = match[2].replace(/\.git$/, '');
      const fullName = `${owner}/${repo}`;
      const cloneUrl = `https://github.com/${owner}/${repo}.git`;

      // Try to extract branch from tree/branch pattern
      const branchMatch = url.match(/\/tree\/([^\/]+)/);
      const branch = branchMatch ? branchMatch[1] : undefined;

      return {
        owner,
        repo,
        branch,
        fullName,
        cloneUrl,
      };
    }
  }

  return null;
}

/**
 * GitHub raw file information extracted from URL
 */
export interface GitHubRawFileInfo {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Branch or commit ref */
  ref: string;
  /** File path within the repository */
  filePath: string;
  /** Direct raw content URL */
  rawUrl: string;
}

/**
 * Extract file information from a GitHub raw file URL
 *
 * Parses raw file URLs to extract repository, branch, and file path.
 *
 * @param url - The GitHub raw file URL to parse
 * @returns File info if parseable, null otherwise
 *
 * @example
 * ```typescript
 * extractGitHubRawFileInfo('https://raw.githubusercontent.com/adverant/nexus-cli/main/README.md');
 * // Returns: { owner: 'adverant', repo: 'nexus-cli', ref: 'main', filePath: 'README.md', rawUrl: '...' }
 *
 * extractGitHubRawFileInfo('https://github.com/adverant/nexus-cli/blob/main/package.json');
 * // Returns: { owner: 'adverant', repo: 'nexus-cli', ref: 'main', filePath: 'package.json', rawUrl: '...' }
 * ```
 */
export function extractGitHubRawFileInfo(url: string): GitHubRawFileInfo | null {
  for (const pattern of GITHUB_RAW_FILE_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1] && match[2] && match[3] && match[4]) {
      const owner = match[1];
      const repo = match[2];
      const ref = match[3];
      const filePath = match[4];

      // Construct raw URL regardless of input format
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;

      return {
        owner,
        repo,
        ref,
        filePath,
        rawUrl,
      };
    }
  }

  return null;
}

/**
 * Check if URL is any kind of GitHub URL
 *
 * Convenience function to check if a URL points to GitHub
 * (either repository or file).
 *
 * @param url - The URL to check
 * @returns True if the URL points to GitHub, false otherwise
 */
export function isGitHubUrl(url: string): boolean {
  return isGitHubRepoUrl(url) || isGitHubRawFileUrl(url);
}
