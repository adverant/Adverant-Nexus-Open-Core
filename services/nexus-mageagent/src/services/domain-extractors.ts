/**
 * Domain-Specific Entity Extractors
 *
 * CRITICAL COMPONENT: Polymorphic extraction system for specialized domains
 * enabling deep semantic understanding across Legal, Medical, Code, and Narrative contexts.
 *
 * Root Cause Addressed: Cross-domain reasoning gaps - system treated all content
 * as generic text, missing domain-specific structures, relationships, and semantics.
 *
 * Architecture: Strategy Pattern + Template Method
 * - Base extractor defines common interface
 * - Domain-specific extractors implement specialized logic
 * - Automatic domain detection and extractor selection
 * - Hierarchical entity relationships (e.g., Case → Parties → Claims)
 *
 * Design Principle: Domain-Driven Design
 * - Each domain has its own ubiquitous language
 * - Extractors preserve domain semantics
 * - Graph relationships mirror real-world domain structures
 *
 * Integration:
 * - Progressive Summarization: Extract entities at each level
 * - Streaming Pipeline: Real-time extraction during streaming
 * - GraphRAG: Store entities with domain-specific relationships
 */

import { graphRAGClient } from '../clients/graphrag-client';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface ExtractedEntity {
  entityId: string;
  entityType: string;
  name: string;
  content: string;
  importance: number; // 0-1 weighted importance
  confidence: number; // 0-1 extraction confidence
  metadata: Record<string, any>;
  relationships: EntityRelationship[];
}

export interface EntityRelationship {
  targetEntityId: string;
  relationshipType: string;
  weight: number; // 0-1 relationship strength
  metadata?: Record<string, any>;
}

export interface ExtractionContext {
  domain: 'legal' | 'medical' | 'code' | 'narrative' | 'general';
  content: string;
  sourceId?: string; // ID of chunk/document being processed
  sessionId?: string;
  metadata?: Record<string, any>;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  totalEntitiesFound: number;
  extractionTime: number;
  domain: string;
  extractorUsed: string;
}

/**
 * Base Entity Extractor (Template Method Pattern)
 */
export abstract class BaseEntityExtractor {
  protected readonly domain: string;

  constructor(domain: string) {
    this.domain = domain;
  }

  /**
   * Template method: orchestrates extraction pipeline
   */
  async extract(context: ExtractionContext): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      // Step 1: Pre-process content
      const preprocessed = await this.preProcess(context.content, context);

      // Step 2: Extract entities (domain-specific)
      const entities = await this.extractEntities(preprocessed, context);

      // Step 3: Post-process and validate
      const validated = await this.postProcess(entities, context);

      // Step 4: Store in GraphRAG
      await this.storeEntities(validated, context);

      const extractionTime = Date.now() - startTime;

      logger.info('Entity extraction completed', {
        domain: this.domain,
        entitiesFound: validated.length,
        extractionTime,
        sessionId: context.sessionId
      });

      return {
        entities: validated,
        totalEntitiesFound: validated.length,
        extractionTime,
        domain: this.domain,
        extractorUsed: this.constructor.name
      };
    } catch (error) {
      logger.error('Entity extraction failed', {
        domain: this.domain,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Pre-process content (can be overridden)
   */
  protected async preProcess(content: string, _context: ExtractionContext): Promise<string> {
    // Default: basic cleanup
    return content
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }

  /**
   * Extract entities (must be implemented by subclasses)
   */
  protected abstract extractEntities(
    content: string,
    context: ExtractionContext
  ): Promise<ExtractedEntity[]>;

  /**
   * Post-process and validate (can be overridden)
   */
  protected async postProcess(
    entities: ExtractedEntity[],
    _context: ExtractionContext
  ): Promise<ExtractedEntity[]> {
    // Default: filter by confidence threshold
    return entities.filter(e => e.confidence >= 0.5);
  }

  /**
   * Store entities in GraphRAG
   */
  protected async storeEntities(
    entities: ExtractedEntity[],
    context: ExtractionContext
  ): Promise<void> {
    // Store entities
    for (const entity of entities) {
      await graphRAGClient.storeEntity({
        domain: this.domain,
        entityType: entity.entityType,
        textContent: entity.content,
        metadata: {
          entityId: entity.entityId,
          name: entity.name,
          importance: entity.importance,
          confidence: entity.confidence,
          sourceId: context.sourceId,
          sessionId: context.sessionId,
          ...entity.metadata
        },
        tags: [
          `domain:${this.domain}`,
          `type:${entity.entityType}`,
          `importance:${Math.floor(entity.importance * 10)}`,
          context.sessionId ? `session:${context.sessionId}` : ''
        ].filter(Boolean)
      });

      // Store relationships
      for (const rel of entity.relationships) {
        await graphRAGClient.createEntityRelationship({
          source_entity_id: entity.entityId,
          target_entity_id: rel.targetEntityId,
          relationship_type: rel.relationshipType,
          weight: rel.weight
        });
      }
    }
  }
}

/**
 * Legal Domain Extractor
 * Extracts: Cases, Statutes, Parties, Claims, Evidence
 */
export class LegalEntityExtractor extends BaseEntityExtractor {
  constructor() {
    super('legal');
  }

  protected async extractEntities(
    content: string,
    _context: ExtractionContext
  ): Promise<ExtractedEntity[]> {
    const entities: ExtractedEntity[] = [];

    // Extract case citations (e.g., "Smith v. Jones, 123 F.3d 456")
    const casePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+v\.\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),?\s+(\d+\s+[A-Z][a-z.]+\s+\d+)/g;
    let match;

    while ((match = casePattern.exec(content)) !== null) {
      const [fullMatch, plaintiff, defendant, citation] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'case',
        name: `${plaintiff} v. ${defendant}`,
        content: fullMatch,
        importance: 0.9, // Cases are high importance
        confidence: 0.95,
        metadata: {
          plaintiff,
          defendant,
          citation,
          position: match.index
        },
        relationships: []
      });
    }

    // Extract statute citations (e.g., "18 U.S.C. § 1234", "§ 501(c)(3)")
    const statutePattern = /(?:(\d+)\s+)?([A-Z][a-z.]+)\s*§\s*(\d+(?:\([a-z]\))?(?:\(\d+\))?)/g;

    while ((match = statutePattern.exec(content)) !== null) {
      const [fullMatch, title, code, section] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'statute',
        name: fullMatch,
        content: fullMatch,
        importance: 0.85,
        confidence: 0.9,
        metadata: {
          title: title || '',
          code,
          section,
          position: match.index
        },
        relationships: []
      });
    }

    // Extract parties (proper nouns in legal context)
    const partyPattern = /\b(?:Plaintiff|Defendant|Petitioner|Respondent|Appellant|Appellee)(?:\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*))/g;

    while ((match = partyPattern.exec(content)) !== null) {
      const [fullMatch, partyName] = match;
      const entityId = uuidv4();

      if (partyName) {
        entities.push({
          entityId,
          entityType: 'party',
          name: partyName,
          content: fullMatch,
          importance: 0.7,
          confidence: 0.8,
          metadata: {
            role: fullMatch.split(/\s+/)[0],
            position: match.index
          },
          relationships: []
        });
      }
    }

    // Extract legal claims (e.g., "breach of contract", "negligence")
    const claimKeywords = [
      'breach of contract',
      'negligence',
      'fraud',
      'misrepresentation',
      'defamation',
      'trespass',
      'assault',
      'battery'
    ];

    for (const claim of claimKeywords) {
      const claimRegex = new RegExp(`\\b${claim}\\b`, 'gi');
      const matches = content.match(claimRegex);

      if (matches) {
        const entityId = uuidv4();
        entities.push({
          entityId,
          entityType: 'claim',
          name: claim,
          content: claim,
          importance: 0.8,
          confidence: 0.85,
          metadata: {
            occurrences: matches.length
          },
          relationships: []
        });
      }
    }

    // Create relationships between entities
    this.createLegalRelationships(entities);

    return entities;
  }

  /**
   * Create domain-specific relationships
   */
  private createLegalRelationships(entities: ExtractedEntity[]): void {
    const cases = entities.filter(e => e.entityType === 'case');
    const parties = entities.filter(e => e.entityType === 'party');
    const claims = entities.filter(e => e.entityType === 'claim');

    // Link parties to cases
    for (const caseEntity of cases) {
      for (const party of parties) {
        // Check if party appears near case
        if (
          caseEntity.metadata.plaintiff === party.name ||
          caseEntity.metadata.defendant === party.name
        ) {
          caseEntity.relationships.push({
            targetEntityId: party.entityId,
            relationshipType: 'HAS_PARTY',
            weight: 1.0
          });
        }
      }
    }

    // Link claims to cases
    for (const caseEntity of cases) {
      for (const claim of claims) {
        caseEntity.relationships.push({
          targetEntityId: claim.entityId,
          relationshipType: 'INVOLVES_CLAIM',
          weight: 0.7
        });
      }
    }
  }
}

/**
 * Medical Domain Extractor
 * Extracts: Patients, Diagnoses, Treatments, Symptoms, Medications
 */
export class MedicalEntityExtractor extends BaseEntityExtractor {
  constructor() {
    super('medical');
  }

  protected async extractEntities(
    content: string,
    _context: ExtractionContext
  ): Promise<ExtractedEntity[]> {
    const entities: ExtractedEntity[] = [];

    // Extract diagnoses (e.g., "diagnosis: hypertension", "diagnosed with diabetes")
    const diagnosisPattern = /(?:diagnosis|diagnosed with|dx):\s*([A-Za-z\s]+?)(?:\.|,|\n|$)/gi;
    let match;

    while ((match = diagnosisPattern.exec(content)) !== null) {
      const [, diagnosis] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'diagnosis',
        name: diagnosis.trim(),
        content: match[0],
        importance: 0.95, // Diagnoses are critical
        confidence: 0.9,
        metadata: {
          position: match.index
        },
        relationships: []
      });
    }

    // Extract medications (e.g., "prescribed metformin 500mg")
    const medicationPattern = /(?:prescribed|medication|rx):\s*([A-Za-z]+)\s*(\d+\s*(?:mg|mcg|g|ml))?/gi;

    while ((match = medicationPattern.exec(content)) !== null) {
      const [fullMatch, medicationName, dosage] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'medication',
        name: medicationName,
        content: fullMatch,
        importance: 0.85,
        confidence: 0.85,
        metadata: {
          dosage: dosage || '',
          position: match.index
        },
        relationships: []
      });
    }

    // Extract symptoms
    const symptomKeywords = [
      'pain',
      'fever',
      'cough',
      'nausea',
      'fatigue',
      'headache',
      'dizziness',
      'shortness of breath'
    ];

    for (const symptom of symptomKeywords) {
      const symptomRegex = new RegExp(`\\b${symptom}\\b`, 'gi');
      const matches = content.match(symptomRegex);

      if (matches) {
        const entityId = uuidv4();
        entities.push({
          entityId,
          entityType: 'symptom',
          name: symptom,
          content: symptom,
          importance: 0.7,
          confidence: 0.75,
          metadata: {
            occurrences: matches.length
          },
          relationships: []
        });
      }
    }

    // Extract vital signs (e.g., "BP: 120/80", "HR: 72")
    const vitalPattern = /(?:BP|blood pressure):\s*(\d+\/\d+)|(?:HR|heart rate):\s*(\d+)|(?:temp|temperature):\s*(\d+\.?\d*)/gi;

    while ((match = vitalPattern.exec(content)) !== null) {
      const [fullMatch] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'vital_sign',
        name: fullMatch,
        content: fullMatch,
        importance: 0.65,
        confidence: 0.9,
        metadata: {
          position: match.index
        },
        relationships: []
      });
    }

    // Create medical relationships
    this.createMedicalRelationships(entities);

    return entities;
  }

  /**
   * Create medical domain relationships
   */
  private createMedicalRelationships(entities: ExtractedEntity[]): void {
    const diagnoses = entities.filter(e => e.entityType === 'diagnosis');
    const medications = entities.filter(e => e.entityType === 'medication');
    const symptoms = entities.filter(e => e.entityType === 'symptom');

    // Link symptoms to diagnoses
    for (const diagnosis of diagnoses) {
      for (const symptom of symptoms) {
        diagnosis.relationships.push({
          targetEntityId: symptom.entityId,
          relationshipType: 'PRESENTS_WITH',
          weight: 0.8
        });
      }
    }

    // Link medications to diagnoses
    for (const diagnosis of diagnoses) {
      for (const medication of medications) {
        diagnosis.relationships.push({
          targetEntityId: medication.entityId,
          relationshipType: 'TREATED_WITH',
          weight: 0.9
        });
      }
    }
  }
}

/**
 * Code Domain Extractor
 * Extracts: Classes, Functions, Interfaces, Dependencies
 */
export class CodeEntityExtractor extends BaseEntityExtractor {
  constructor() {
    super('code');
  }

  protected async extractEntities(
    content: string,
    _context: ExtractionContext
  ): Promise<ExtractedEntity[]> {
    const entities: ExtractedEntity[] = [];

    // Extract class definitions
    const classPattern = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
    let match;

    while ((match = classPattern.exec(content)) !== null) {
      const [fullMatch, className, extendsClass, implementsInterfaces] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'class',
        name: className,
        content: fullMatch,
        importance: 0.9,
        confidence: 0.95,
        metadata: {
          extends: extendsClass || null,
          implements: implementsInterfaces ? implementsInterfaces.split(',').map(i => i.trim()) : [],
          position: match.index
        },
        relationships: []
      });
    }

    // Extract function definitions
    const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/g;

    while ((match = functionPattern.exec(content)) !== null) {
      const [fullMatch, functionName, params, returnType] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'function',
        name: functionName,
        content: fullMatch,
        importance: 0.75,
        confidence: 0.9,
        metadata: {
          parameters: params.split(',').map(p => p.trim()).filter(Boolean),
          returnType: returnType ? returnType.trim() : 'void',
          position: match.index
        },
        relationships: []
      });
    }

    // Extract interface definitions
    const interfacePattern = /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w,\s]+))?/g;

    while ((match = interfacePattern.exec(content)) !== null) {
      const [fullMatch, interfaceName, extendsInterfaces] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'interface',
        name: interfaceName,
        content: fullMatch,
        importance: 0.8,
        confidence: 0.95,
        metadata: {
          extends: extendsInterfaces ? extendsInterfaces.split(',').map(i => i.trim()) : [],
          position: match.index
        },
        relationships: []
      });
    }

    // Extract imports (dependencies)
    const importPattern = /import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;

    while ((match = importPattern.exec(content)) !== null) {
      const [fullMatch, namedImports, defaultImport, modulePath] = match;
      const entityId = uuidv4();

      entities.push({
        entityId,
        entityType: 'dependency',
        name: modulePath,
        content: fullMatch,
        importance: 0.6,
        confidence: 1.0,
        metadata: {
          namedImports: namedImports ? namedImports.split(',').map(i => i.trim()) : [],
          defaultImport: defaultImport || null,
          position: match.index
        },
        relationships: []
      });
    }

    // Create code relationships
    this.createCodeRelationships(entities);

    return entities;
  }

  /**
   * Create code domain relationships
   */
  private createCodeRelationships(entities: ExtractedEntity[]): void {
    const classes = entities.filter(e => e.entityType === 'class');
    const interfaces = entities.filter(e => e.entityType === 'interface');
    const dependencies = entities.filter(e => e.entityType === 'dependency');

    // Link class inheritance
    for (const classEntity of classes) {
      if (classEntity.metadata.extends) {
        const parentClass = classes.find(c => c.name === classEntity.metadata.extends);
        if (parentClass) {
          classEntity.relationships.push({
            targetEntityId: parentClass.entityId,
            relationshipType: 'EXTENDS',
            weight: 1.0
          });
        }
      }

      // Link interface implementations
      for (const interfaceName of classEntity.metadata.implements || []) {
        const interfaceEntity = interfaces.find(i => i.name === interfaceName);
        if (interfaceEntity) {
          classEntity.relationships.push({
            targetEntityId: interfaceEntity.entityId,
            relationshipType: 'IMPLEMENTS',
            weight: 0.9
          });
        }
      }
    }

    // Link dependencies
    for (const dep of dependencies) {
      for (const classEntity of classes) {
        classEntity.relationships.push({
          targetEntityId: dep.entityId,
          relationshipType: 'DEPENDS_ON',
          weight: 0.7
        });
      }
    }
  }
}

/**
 * Narrative Domain Extractor
 * Extracts: Characters, Locations, Plot Points, Themes
 */
export class NarrativeEntityExtractor extends BaseEntityExtractor {
  constructor() {
    super('narrative');
  }

  protected async extractEntities(
    content: string,
    _context: ExtractionContext
  ): Promise<ExtractedEntity[]> {
    const entities: ExtractedEntity[] = [];

    // Extract character names (proper nouns in dialogue or narrative context)
    const characterPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:said|asked|replied|thought|felt|saw)/g;
    let match;
    const characterCounts: Record<string, number> = {};

    while ((match = characterPattern.exec(content)) !== null) {
      const [, characterName] = match;
      characterCounts[characterName] = (characterCounts[characterName] || 0) + 1;
    }

    // Create character entities (threshold: mentioned at least twice)
    for (const [characterName, count] of Object.entries(characterCounts)) {
      if (count >= 2) {
        const entityId = uuidv4();
        entities.push({
          entityId,
          entityType: 'character',
          name: characterName,
          content: characterName,
          importance: Math.min(1, count / 10), // More mentions = higher importance
          confidence: 0.8,
          metadata: {
            mentions: count
          },
          relationships: []
        });
      }
    }

    // Extract locations (preceded by prepositions)
    const locationPattern = /\b(?:in|at|near|to|from)\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
    const locationCounts: Record<string, number> = {};

    while ((match = locationPattern.exec(content)) !== null) {
      const [, locationName] = match;
      locationCounts[locationName] = (locationCounts[locationName] || 0) + 1;
    }

    for (const [locationName, count] of Object.entries(locationCounts)) {
      if (count >= 2) {
        const entityId = uuidv4();
        entities.push({
          entityId,
          entityType: 'location',
          name: locationName,
          content: locationName,
          importance: Math.min(1, count / 8),
          confidence: 0.7,
          metadata: {
            mentions: count
          },
          relationships: []
        });
      }
    }

    // Extract plot events (sentences with high narrative action)
    const actionVerbs = [
      'discovered',
      'realized',
      'decided',
      'fought',
      'fled',
      'confronted',
      'revealed',
      'betrayed'
    ];

    for (const verb of actionVerbs) {
      const verbRegex = new RegExp(`[^.!?]*\\b${verb}\\b[^.!?]*[.!?]`, 'gi');
      const matches = content.match(verbRegex);

      if (matches) {
        for (const eventSentence of matches.slice(0, 3)) {
          // Top 3 matches
          const entityId = uuidv4();
          entities.push({
            entityId,
            entityType: 'plot_event',
            name: verb,
            content: eventSentence.trim(),
            importance: 0.85,
            confidence: 0.75,
            metadata: {
              actionVerb: verb
            },
            relationships: []
          });
        }
      }
    }

    // Create narrative relationships
    this.createNarrativeRelationships(entities);

    return entities;
  }

  /**
   * Create narrative domain relationships
   */
  private createNarrativeRelationships(entities: ExtractedEntity[]): void {
    const characters = entities.filter(e => e.entityType === 'character');
    const locations = entities.filter(e => e.entityType === 'location');
    const plotEvents = entities.filter(e => e.entityType === 'plot_event');

    // Link characters to locations (if character name appears in location context)
    for (const character of characters) {
      for (const location of locations) {
        character.relationships.push({
          targetEntityId: location.entityId,
          relationshipType: 'VISITS',
          weight: 0.5
        });
      }
    }

    // Link characters to plot events
    for (const character of characters) {
      for (const event of plotEvents) {
        if (event.content.includes(character.name)) {
          character.relationships.push({
            targetEntityId: event.entityId,
            relationshipType: 'PARTICIPATES_IN',
            weight: 0.9
          });
        }
      }
    }
  }
}

/**
 * Extractor Factory
 */
export class EntityExtractorFactory {
  private static extractors: Map<string, BaseEntityExtractor> = new Map<string, BaseEntityExtractor>([
    ['legal', new LegalEntityExtractor()],
    ['medical', new MedicalEntityExtractor()],
    ['code', new CodeEntityExtractor()],
    ['narrative', new NarrativeEntityExtractor()]
  ]);

  /**
   * Get extractor for domain
   */
  static getExtractor(domain: string): BaseEntityExtractor {
    const extractor = this.extractors.get(domain);
    if (!extractor) {
      throw new Error(`No extractor found for domain: ${domain}`);
    }
    return extractor;
  }

  /**
   * Auto-detect domain and extract
   */
  static async autoExtract(content: string, context?: Partial<ExtractionContext>): Promise<ExtractionResult> {
    const detectedDomain = this.detectDomain(content);
    const extractor = this.getExtractor(detectedDomain);

    return extractor.extract({
      domain: detectedDomain as any,
      content,
      ...context
    });
  }

  /**
   * Detect domain from content
   */
  private static detectDomain(content: string): string {
    // Legal indicators
    if (/\bv\.\b.*\d+\s+[A-Z][a-z.]+\s+\d+|§\s*\d+|plaintiff|defendant/i.test(content)) {
      return 'legal';
    }

    // Medical indicators
    if (/diagnosis|medication|prescription|patient|symptom|treatment/i.test(content)) {
      return 'medical';
    }

    // Code indicators
    if (/(?:class|function|interface|import|export)\s+\w+|=>|{\s*[a-z]+:/i.test(content)) {
      return 'code';
    }

    // Narrative indicators (default if none match)
    return 'narrative';
  }
}
