/**
 * Domain Type System with Extensibility
 *
 * Provides type-safe domain handling while allowing runtime extensibility.
 * Uses runtime validation for compile-time safety without restricting values.
 */

// Known domains for type hints and validation
export const KNOWN_DOMAINS = [
  'general',
  'code',
  'creative_writing',
  'medical',
  'legal',
  'research',
  'conversation',
  'documentation',
  'analysis'
] as const;

export type KnownDomain = typeof KNOWN_DOMAINS[number];

// Domain is extensible string type
export type Domain = string;

/**
 * Domain Registry for runtime validation and suggestions
 */
export class DomainRegistry {
  private static domains = new Set<string>(KNOWN_DOMAINS);

  /**
   * Register a new domain at runtime
   */
  static register(domain: string): void {
    if (!domain || domain.trim().length === 0) {
      throw new Error('Domain name cannot be empty');
    }
    this.domains.add(domain.toLowerCase());
  }

  /**
   * Check if domain is known (registered)
   */
  static isKnown(domain: string): boolean {
    return this.domains.has(domain.toLowerCase());
  }

  /**
   * Validate and normalize domain string
   */
  static validate(domain: string): Domain {
    if (!domain || domain.trim().length === 0) {
      throw new Error('Domain cannot be empty');
    }

    const normalized = domain.toLowerCase().trim();

    // Register unknown domain automatically
    if (!this.isKnown(normalized)) {
      this.register(normalized);
    }

    return normalized;
  }

  /**
   * Get all registered domains
   */
  static getAll(): string[] {
    return Array.from(this.domains);
  }

  /**
   * Suggest similar domains if exact match not found
   */
  static suggest(input: string): string[] {
    const lower = input.toLowerCase();
    return Array.from(this.domains).filter(d =>
      d.includes(lower) || lower.includes(d)
    );
  }
}

/**
 * Create a domain value with validation
 */
export function createDomain(value: string): Domain {
  return DomainRegistry.validate(value);
}

/**
 * Type guard for domain values
 */
export function isDomain(value: unknown): value is Domain {
  return typeof value === 'string' && value.trim().length > 0;
}
