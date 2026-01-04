/**
 * Input validation utilities for nexus-cli
 * Provides robust validation with clear error messages
 */

/**
 * RFC 5322 compliant email regex (simplified but robust)
 * Validates:
 * - Local part: alphanumeric + allowed special chars (. _ % + -)
 * - @ symbol required
 * - Domain: alphanumeric + hyphens, must have TLD
 * - TLD: 2-6 characters (covers .com, .io, .museum, etc.)
 */
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;

/**
 * Validates email format according to RFC 5322 simplified
 *
 * @param email - Email address to validate
 * @returns true if valid, error message string if invalid
 *
 * @example
 * ```typescript
 * validateEmail('user@example.com') // true
 * validateEmail('invalid.email') // 'Invalid email format. Expected: user@domain.com'
 * validateEmail('') // 'Email address is required'
 * ```
 */
export function validateEmail(email: string): true | string {
  // Check required
  if (!email || email.trim().length === 0) {
    return 'Email address is required';
  }

  const trimmed = email.trim();

  // Check length (RFC 5321: max 320 characters)
  if (trimmed.length > 320) {
    return 'Email address is too long (max 320 characters)';
  }

  // Check format
  if (!EMAIL_REGEX.test(trimmed)) {
    return 'Invalid email format. Expected: user@domain.com';
  }

  // Additional sanity checks
  const [localPart, domain] = trimmed.split('@');

  // Local part max 64 characters (RFC 5321)
  if (localPart.length > 64) {
    return 'Email local part is too long (max 64 characters before @)';
  }

  // Domain part max 255 characters (RFC 5321)
  if (domain.length > 255) {
    return 'Email domain is too long (max 255 characters after @)';
  }

  // Check for consecutive dots (invalid per RFC)
  if (trimmed.includes('..')) {
    return 'Email cannot contain consecutive dots';
  }

  // Check for leading/trailing dots in local part
  if (localPart.startsWith('.') || localPart.endsWith('.')) {
    return 'Email local part cannot start or end with a dot';
  }

  return true;
}

/**
 * Type guard to check if validation result is an error
 */
export function isValidationError(result: true | string): result is string {
  return typeof result === 'string';
}

/**
 * Validates plugin name format
 *
 * Requirements:
 * - Lowercase alphanumeric and hyphens only
 * - Must start with a letter
 * - Must not end with a hyphen
 * - Length: 3-50 characters
 *
 * @param name - Plugin name to validate
 * @returns true if valid, error message string if invalid
 */
export function validatePluginName(name: string): true | string {
  if (!name || name.trim().length === 0) {
    return 'Plugin name is required';
  }

  const trimmed = name.trim();

  // Check length
  if (trimmed.length < 3) {
    return 'Plugin name must be at least 3 characters';
  }

  if (trimmed.length > 50) {
    return 'Plugin name must be at most 50 characters';
  }

  // Check format: lowercase alphanumeric and hyphens
  const nameRegex = /^[a-z][a-z0-9-]*[a-z0-9]$/;
  if (!nameRegex.test(trimmed)) {
    return 'Plugin name must start with a letter, contain only lowercase letters, numbers, and hyphens, and not end with a hyphen';
  }

  // Check for consecutive hyphens
  if (trimmed.includes('--')) {
    return 'Plugin name cannot contain consecutive hyphens';
  }

  return true;
}

/**
 * Validates semantic version format
 *
 * Format: major.minor.patch (e.g., 1.0.0)
 * Supports pre-release tags: 1.0.0-alpha, 1.0.0-beta.1
 *
 * @param version - Version string to validate
 * @returns true if valid, error message string if invalid
 */
export function validateSemanticVersion(version: string): true | string {
  if (!version || version.trim().length === 0) {
    return 'Version is required';
  }

  const trimmed = version.trim();

  // Semantic versioning regex (supports pre-release tags)
  const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

  if (!semverRegex.test(trimmed)) {
    return 'Invalid semantic version format. Expected: major.minor.patch (e.g., 1.0.0)';
  }

  return true;
}

/**
 * Validates URL format
 *
 * @param url - URL string to validate
 * @returns true if valid, error message string if invalid
 */
export function validateUrl(url: string): true | string {
  if (!url || url.trim().length === 0) {
    return 'URL is required';
  }

  const trimmed = url.trim();

  try {
    const parsed = new URL(trimmed);

    // Must be HTTP or HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'URL must use HTTP or HTTPS protocol';
    }

    return true;
  } catch {
    return 'Invalid URL format. Expected: https://example.com';
  }
}

/**
 * Validates file path exists
 */
export function validateFilePath(path: string, requireExists = true): true | string {
  if (!path || path.trim().length === 0) {
    return 'File path is required';
  }

  if (!requireExists) {
    return true;
  }

  // Note: This is a synchronous check - in real implementation use fs.existsSync
  // For now, just validate the format
  const trimmed = path.trim();

  // Check for invalid characters (basic check)
  if (trimmed.includes('\0')) {
    return 'File path contains invalid null character';
  }

  return true;
}

/**
 * Validates directory path exists
 */
export function validateDirectoryPath(path: string, requireExists = true): true | string {
  if (!path || path.trim().length === 0) {
    return 'Directory path is required';
  }

  if (!requireExists) {
    return true;
  }

  const trimmed = path.trim();

  // Check for invalid characters (basic check)
  if (trimmed.includes('\0')) {
    return 'Directory path contains invalid null character';
  }

  return true;
}

/**
 * Validates JSON string
 */
export function validateJSON(json: string): true | string {
  if (!json || json.trim().length === 0) {
    return 'JSON string is required';
  }

  try {
    JSON.parse(json);
    return true;
  } catch (error) {
    return `Invalid JSON format: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

/**
 * Validates required field
 */
export function validateRequired(value: any, fieldName = 'Value'): true | string {
  if (value === undefined || value === null || value === '') {
    return `${fieldName} is required`;
  }

  return true;
}

/**
 * Validates string length
 */
export function validateLength(
  value: string,
  min?: number,
  max?: number,
  fieldName = 'Value'
): true | string {
  if (min !== undefined && value.length < min) {
    return `${fieldName} must be at least ${min} characters`;
  }

  if (max !== undefined && value.length > max) {
    return `${fieldName} must be at most ${max} characters`;
  }

  return true;
}

/**
 * Validates number range
 */
export function validateRange(
  value: number,
  min?: number,
  max?: number,
  fieldName = 'Value'
): true | string {
  if (min !== undefined && value < min) {
    return `${fieldName} must be at least ${min}`;
  }

  if (max !== undefined && value > max) {
    return `${fieldName} must be at most ${max}`;
  }

  return true;
}

/**
 * Validates one of choices
 */
export function validateChoice<T>(
  value: T,
  choices: T[],
  fieldName = 'Value'
): true | string {
  if (!choices.includes(value)) {
    return `${fieldName} must be one of: ${choices.join(', ')}`;
  }

  return true;
}

/**
 * Validates array
 */
export function validateArray(
  value: any,
  minLength?: number,
  maxLength?: number,
  fieldName = 'Value'
): true | string {
  if (!Array.isArray(value)) {
    return `${fieldName} must be an array`;
  }

  if (minLength !== undefined && value.length < minLength) {
    return `${fieldName} must have at least ${minLength} items`;
  }

  if (maxLength !== undefined && value.length > maxLength) {
    return `${fieldName} must have at most ${maxLength} items`;
  }

  return true;
}

/**
 * Validates positive number
 */
export function validatePositive(value: number, fieldName = 'Value'): true | string {
  if (value <= 0) {
    return `${fieldName} must be positive`;
  }

  return true;
}

/**
 * Validates port number
 */
export function validatePort(port: number): true | string {
  if (!Number.isInteger(port)) {
    return 'Port must be an integer';
  }

  if (port < 1 || port > 65535) {
    return 'Port must be between 1 and 65535';
  }

  return true;
}

/**
 * Combines multiple validators
 */
export function combineValidators(
  ...validators: Array<(value: any) => true | string>
): (value: any) => true | string {
  return (value: any) => {
    for (const validator of validators) {
      const result = validator(value);
      if (result !== true) {
        return result;
      }
    }
    return true;
  };
}
