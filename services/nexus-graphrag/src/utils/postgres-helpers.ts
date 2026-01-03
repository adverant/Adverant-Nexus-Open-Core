/**
 * PostgreSQL Helper Utilities
 * Provides functions for proper PostgreSQL data type conversions
 */

/**
 * Convert a JavaScript array to PostgreSQL text[] array format.
 * PostgreSQL expects arrays in the format: {"value1","value2"} or NULL
 *
 * @param arr - JavaScript array or null/undefined
 * @returns PostgreSQL-compatible array string or null
 *
 * @example
 * toPostgresArray(['tag1', 'tag2']) // returns '{"tag1","tag2"}'
 * toPostgresArray([])               // returns null
 * toPostgresArray(null)             // returns null
 */
export function toPostgresArray(arr: string[] | null | undefined): string | null {
  if (!arr || arr.length === 0) {
    return null; // Return null for empty arrays - PostgreSQL default will apply
  }
  // Escape double quotes and backslashes in values, then format as PostgreSQL array
  const escaped = arr.map(val => {
    const str = String(val);
    return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
  return '{' + escaped.join(',') + '}';
}

/**
 * Convert PostgreSQL array to JavaScript array
 * Handles the PostgreSQL array format: {"value1","value2"}
 *
 * @param pgArray - PostgreSQL array string or already-parsed array
 * @returns JavaScript string array
 */
export function fromPostgresArray(pgArray: string | string[] | null | undefined): string[] {
  if (!pgArray) {
    return [];
  }

  // If already an array (pg driver sometimes auto-parses), return as-is
  if (Array.isArray(pgArray)) {
    return pgArray;
  }

  // Parse PostgreSQL array format: {"value1","value2"}
  const str = String(pgArray);
  if (str === '{}' || str === '') {
    return [];
  }

  // Remove outer braces and split by comma, handling escaped values
  const inner = str.slice(1, -1); // Remove { and }
  if (!inner) {
    return [];
  }

  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  // Push last value
  if (current || inQuotes) {
    result.push(current);
  }

  return result;
}
