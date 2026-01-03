/**
 * Temporal Extraction Service
 *
 * Extracts temporal entities from content including:
 * - Absolute dates (January 15, 2024, 01/15/2024)
 * - Relative dates (yesterday, next week, last month)
 * - Durations (3 days, 2 weeks, 1 year)
 * - Recurring patterns (every Monday, weekly, monthly)
 *
 * All extracted temporals are normalized to ISO 8601 format for consistent storage.
 */

import { logger } from '../utils/logger';

export type TemporalType = 'date' | 'duration' | 'relative' | 'recurring';

export interface TemporalEntity {
  /** Type of temporal expression */
  type: TemporalType;
  /** Original text as found in content */
  text: string;
  /** Normalized value in ISO 8601 format */
  normalizedValue: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Position in original content */
  position: {
    start: number;
    end: number;
  };
}

interface PatternDefinition {
  regex: RegExp;
  type: TemporalType;
  parser: (match: RegExpExecArray) => string;
  confidence: number;
}

// Month name to number mapping
const MONTH_MAP: Record<string, string> = {
  'january': '01', 'jan': '01',
  'february': '02', 'feb': '02',
  'march': '03', 'mar': '03',
  'april': '04', 'apr': '04',
  'may': '05',
  'june': '06', 'jun': '06',
  'july': '07', 'jul': '07',
  'august': '08', 'aug': '08',
  'september': '09', 'sep': '09', 'sept': '09',
  'october': '10', 'oct': '10',
  'november': '11', 'nov': '11',
  'december': '12', 'dec': '12'
};

// Duration unit mapping for ISO 8601
const DURATION_UNIT_MAP: Record<string, string> = {
  'year': 'Y', 'years': 'Y', 'yr': 'Y', 'yrs': 'Y',
  'month': 'M', 'months': 'M', 'mo': 'M', 'mos': 'M',
  'week': 'W', 'weeks': 'W', 'wk': 'W', 'wks': 'W',
  'day': 'D', 'days': 'D',
  'hour': 'H', 'hours': 'H', 'hr': 'H', 'hrs': 'H',
  'minute': 'M', 'minutes': 'M', 'min': 'M', 'mins': 'M',
  'second': 'S', 'seconds': 'S', 'sec': 'S', 'secs': 'S'
};

export class TemporalExtractor {
  private patterns: PatternDefinition[];

  constructor() {
    this.patterns = this.initializePatterns();
  }

  /**
   * Initialize regex patterns for temporal extraction
   */
  private initializePatterns(): PatternDefinition[] {
    return [
      // === ABSOLUTE DATES ===

      // ISO 8601: 2024-01-15
      {
        regex: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
        type: 'date',
        parser: (m) => `${m[1]}-${m[2]}-${m[3]}`,
        confidence: 0.95
      },

      // US format: 01/15/2024, 1/15/2024, 01-15-2024
      {
        regex: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g,
        type: 'date',
        parser: (m) => this.parseUSDate(m[1], m[2], m[3]),
        confidence: 0.90
      },

      // US format short year: 01/15/24
      {
        regex: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/g,
        type: 'date',
        parser: (m) => this.parseUSDate(m[1], m[2], '20' + m[3]),
        confidence: 0.85
      },

      // Full month name: January 15, 2024 or January 15th, 2024
      {
        regex: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/gi,
        type: 'date',
        parser: (m) => this.parseMonthDate(m[1], m[2], m[3]),
        confidence: 0.95
      },

      // Abbreviated month: Jan 15, 2024
      {
        regex: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/gi,
        type: 'date',
        parser: (m) => this.parseMonthDate(m[1], m[2], m[3]),
        confidence: 0.90
      },

      // Month day only (assume current year): January 15 or Jan 15
      {
        regex: /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi,
        type: 'date',
        parser: (m) => this.parseMonthDate(m[1], m[2]),
        confidence: 0.80
      },

      // === RELATIVE DATES ===

      // Simple relative: today, yesterday, tomorrow
      {
        regex: /\b(today|yesterday|tomorrow)\b/gi,
        type: 'relative',
        parser: (m) => this.parseSimpleRelative(m[0]),
        confidence: 0.95
      },

      // Last/next period: last week, next month, last year
      {
        regex: /\b(last|next|this)\s+(week|month|year|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
        type: 'relative',
        parser: (m) => this.parseRelativePeriod(m[1], m[2]),
        confidence: 0.90
      },

      // X days/weeks/months ago/from now
      {
        regex: /\b(\d+)\s+(days?|weeks?|months?|years?)\s+(ago|from\s+now|later)\b/gi,
        type: 'relative',
        parser: (m) => this.parseRelativeOffset(m[1], m[2], m[3]),
        confidence: 0.90
      },

      // In X days/weeks/months
      {
        regex: /\bin\s+(\d+)\s+(days?|weeks?|months?|years?)\b/gi,
        type: 'relative',
        parser: (m) => this.parseRelativeOffset(m[1], m[2], 'from now'),
        confidence: 0.90
      },

      // === DURATIONS ===

      // X days/weeks/months/years
      {
        regex: /\b(\d+)\s*(years?|months?|weeks?|days?|hours?|minutes?|mins?|seconds?|secs?|yrs?|mos?|wks?|hrs?)\b/gi,
        type: 'duration',
        parser: (m) => this.parseDuration(m[1], m[2]),
        confidence: 0.90
      },

      // Duration ranges: 2-3 weeks, 1 to 2 months
      {
        regex: /\b(\d+)\s*(?:-|to)\s*(\d+)\s*(years?|months?|weeks?|days?|hours?)\b/gi,
        type: 'duration',
        parser: (m) => this.parseDurationRange(m[1], m[2], m[3]),
        confidence: 0.85
      },

      // === RECURRING ===

      // Every day/week/month/year
      {
        regex: /\b(every|each)\s+(day|week|month|year|hour|minute|second|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
        type: 'recurring',
        parser: (m) => this.parseRecurring(m[1], m[2]),
        confidence: 0.90
      },

      // Weekly, monthly, yearly, daily
      {
        regex: /\b(daily|weekly|monthly|yearly|annually|hourly)\b/gi,
        type: 'recurring',
        parser: (m) => this.parseRecurringFrequency(m[0]),
        confidence: 0.95
      },

      // Every X days/weeks/months
      {
        regex: /\b(every)\s+(\d+)\s+(days?|weeks?|months?|years?)\b/gi,
        type: 'recurring',
        parser: (m) => this.parseRecurringInterval(m[2], m[3]),
        confidence: 0.90
      }
    ];
  }

  /**
   * Extract all temporal entities from content
   */
  extract(content: string): TemporalEntity[] {
    const entities: TemporalEntity[] = [];
    const seenPositions = new Set<string>();

    for (const pattern of this.patterns) {
      // Create new regex instance for each iteration (reset lastIndex)
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(content)) !== null) {
        const positionKey = `${match.index}-${match.index + match[0].length}`;

        // Skip if we've already extracted an entity at this position
        if (seenPositions.has(positionKey)) continue;
        seenPositions.add(positionKey);

        try {
          const normalizedValue = pattern.parser(match);
          entities.push({
            type: pattern.type,
            text: match[0],
            normalizedValue,
            confidence: pattern.confidence,
            position: {
              start: match.index,
              end: match.index + match[0].length
            }
          });
        } catch (err: any) {
          logger.warn('Failed to parse temporal expression', {
            text: match[0],
            type: pattern.type,
            error: err.message
          });
        }
      }
    }

    // Sort by position
    entities.sort((a, b) => a.position.start - b.position.start);

    logger.debug('Temporal extraction complete', {
      contentLength: content.length,
      entitiesFound: entities.length,
      types: entities.map(e => e.type)
    });

    return entities;
  }

  // === PARSER METHODS ===

  private parseUSDate(month: string, day: string, year: string): string {
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  private parseMonthDate(month: string, day: string, year?: string): string {
    const monthNum = MONTH_MAP[month.toLowerCase()];
    if (!monthNum) throw new Error(`Unknown month: ${month}`);

    const y = year || new Date().getFullYear().toString();
    return `${y}-${monthNum}-${day.padStart(2, '0')}`;
  }

  private parseSimpleRelative(text: string): string {
    const now = new Date();
    const lower = text.toLowerCase();

    switch (lower) {
      case 'today':
        return now.toISOString().split('T')[0];
      case 'yesterday':
        now.setDate(now.getDate() - 1);
        return now.toISOString().split('T')[0];
      case 'tomorrow':
        now.setDate(now.getDate() + 1);
        return now.toISOString().split('T')[0];
      default:
        return `RELATIVE:${lower}`;
    }
  }

  private parseRelativePeriod(modifier: string, period: string): string {
    const now = new Date();
    const mod = modifier.toLowerCase();
    const per = period.toLowerCase();

    // For weekdays, calculate the next/last occurrence
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const weekdayIndex = weekdays.indexOf(per);

    if (weekdayIndex !== -1) {
      const currentDay = now.getDay();
      let diff = weekdayIndex - currentDay;

      if (mod === 'last') {
        diff = diff <= 0 ? diff - 7 : diff - 7;
      } else if (mod === 'next') {
        diff = diff <= 0 ? diff + 7 : diff;
      }

      now.setDate(now.getDate() + diff);
      return now.toISOString().split('T')[0];
    }

    // For week/month/year
    switch (per) {
      case 'week':
        now.setDate(now.getDate() + (mod === 'last' ? -7 : mod === 'next' ? 7 : 0));
        break;
      case 'month':
        now.setMonth(now.getMonth() + (mod === 'last' ? -1 : mod === 'next' ? 1 : 0));
        break;
      case 'year':
        now.setFullYear(now.getFullYear() + (mod === 'last' ? -1 : mod === 'next' ? 1 : 0));
        break;
      case 'day':
        now.setDate(now.getDate() + (mod === 'last' ? -1 : mod === 'next' ? 1 : 0));
        break;
    }

    return now.toISOString().split('T')[0];
  }

  private parseRelativeOffset(amount: string, unit: string, direction: string): string {
    const now = new Date();
    const num = parseInt(amount, 10);
    const dir = direction.toLowerCase().includes('ago') ? -1 : 1;
    const unitLower = unit.toLowerCase().replace(/s$/, '');

    switch (unitLower) {
      case 'day':
        now.setDate(now.getDate() + (num * dir));
        break;
      case 'week':
        now.setDate(now.getDate() + (num * 7 * dir));
        break;
      case 'month':
        now.setMonth(now.getMonth() + (num * dir));
        break;
      case 'year':
        now.setFullYear(now.getFullYear() + (num * dir));
        break;
    }

    return now.toISOString().split('T')[0];
  }

  private parseDuration(amount: string, unit: string): string {
    const unitLower = unit.toLowerCase();
    const isoUnit = DURATION_UNIT_MAP[unitLower];
    if (!isoUnit) throw new Error(`Unknown duration unit: ${unit}`);

    // ISO 8601 duration format: P(n)Y(n)M(n)DT(n)H(n)M(n)S
    // Time components need T prefix
    const timeUnits = ['H', 'M', 'S'];
    if (timeUnits.includes(isoUnit)) {
      return `PT${amount}${isoUnit}`;
    }
    return `P${amount}${isoUnit}`;
  }

  private parseDurationRange(min: string, max: string, unit: string): string {
    const unitLower = unit.toLowerCase();
    const isoUnit = DURATION_UNIT_MAP[unitLower];
    if (!isoUnit) throw new Error(`Unknown duration unit: ${unit}`);

    // Return as range in ISO 8601 format
    return `P${min}${isoUnit}/P${max}${isoUnit}`;
  }

  private parseRecurring(_modifier: string, unit: string): string {
    const unitUpper = unit.toUpperCase();

    // RFC 5545 recurrence format
    const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
    if (weekdays.includes(unitUpper)) {
      return `RRULE:FREQ=WEEKLY;BYDAY=${unitUpper.substring(0, 2)}`;
    }

    const freqMap: Record<string, string> = {
      'DAY': 'DAILY',
      'WEEK': 'WEEKLY',
      'MONTH': 'MONTHLY',
      'YEAR': 'YEARLY',
      'HOUR': 'HOURLY',
      'MINUTE': 'MINUTELY',
      'SECOND': 'SECONDLY'
    };

    return `RRULE:FREQ=${freqMap[unitUpper] || unitUpper}`;
  }

  private parseRecurringFrequency(frequency: string): string {
    const freqMap: Record<string, string> = {
      'daily': 'RRULE:FREQ=DAILY',
      'weekly': 'RRULE:FREQ=WEEKLY',
      'monthly': 'RRULE:FREQ=MONTHLY',
      'yearly': 'RRULE:FREQ=YEARLY',
      'annually': 'RRULE:FREQ=YEARLY',
      'hourly': 'RRULE:FREQ=HOURLY'
    };

    return freqMap[frequency.toLowerCase()] || `RRULE:FREQ=${frequency.toUpperCase()}`;
  }

  private parseRecurringInterval(amount: string, unit: string): string {
    const unitLower = unit.toLowerCase().replace(/s$/, '');
    const freqMap: Record<string, string> = {
      'day': 'DAILY',
      'week': 'WEEKLY',
      'month': 'MONTHLY',
      'year': 'YEARLY'
    };

    return `RRULE:FREQ=${freqMap[unitLower] || unitLower.toUpperCase()};INTERVAL=${amount}`;
  }
}

export default TemporalExtractor;
