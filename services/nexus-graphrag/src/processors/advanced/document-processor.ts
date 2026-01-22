/**
 * Advanced Document Processor
 *
 * Main orchestration class for advanced document processing that leverages:
 * - Docling for layout-preserving document understanding
 * - 3-tier OCR cascade for image/scan processing
 * - Document DNA triple-layer storage strategy
 * - OpenRouterModelSelector for vision model selection
 * - VoyageAI for semantic and structural embeddings
 *
 * This processor integrates directly with GraphRAG's existing infrastructure
 * to provide state-of-the-art document intelligence capabilities.
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import { OpenRouterModelSelector } from '../../clients/openrouter-model-selector';
import { VoyageAIClient } from '../../clients/voyage-ai-unified-client';
import { GraphRAGStorageEngine } from '../../storage/storage-engine';
import { DoclingIntegration } from './docling-integration';
import { OCRCascade } from '../ocr/ocr-cascade';
import { LayoutAnalyzer } from './layout-analyzer';
import { DocumentClassifier } from './document-classifier';
import {
  DocumentDNA,
  DocumentLayer,
  ProcessingOptions,
  ProcessingResult,
  DocumentFormat,
  LayoutElement
} from '../../types/document-dna';
import { DocumentMetadata } from '../../types';

export interface AdvancedProcessingOptions extends ProcessingOptions {
  enableDocling?: boolean;
  enableOCR?: boolean;
  enableDocumentDNA?: boolean;
  ocrTier?: 'auto' | 'fast' | 'quality' | 'premium';
  preserveLayout?: boolean;
  extractTables?: boolean;
  budget?: number;
  sessionId?: string;
  userId?: string;
}

export class AdvancedDocumentProcessor {
  private openRouterSelector: OpenRouterModelSelector;
  private voyageClient: VoyageAIClient;
  private storageEngine: GraphRAGStorageEngine;
  private doclingIntegration: DoclingIntegration;
  private ocrCascade: OCRCascade;
  private layoutAnalyzer: LayoutAnalyzer;
  private documentClassifier: DocumentClassifier;

  constructor(
    storageEngine: GraphRAGStorageEngine,
    openRouterApiKey?: string,
    voyageApiKey?: string
  ) {
    // Leverage existing infrastructure
    this.storageEngine = storageEngine;

    // Use existing model selectors
    this.openRouterSelector = new OpenRouterModelSelector(
      openRouterApiKey || process.env.OPENROUTER_API_KEY!
    );

    this.voyageClient = new VoyageAIClient(
      voyageApiKey || process.env.VOYAGE_API_KEY!
    );

    // Initialize new advanced capabilities
    this.doclingIntegration = new DoclingIntegration();
    this.ocrCascade = new OCRCascade(this.openRouterSelector);
    this.layoutAnalyzer = new LayoutAnalyzer();
    this.documentClassifier = new DocumentClassifier(this.openRouterSelector);
  }

  /**
   * Main entry point for advanced document processing
   */
  async processDocument(
    content: string | Buffer,
    options: AdvancedProcessingOptions = {}
  ): Promise<ProcessingResult> {
    const startTime = Date.now();
    const documentId = options.documentId || uuidv4();

    try {
      logger.info('Starting advanced document processing', {
        documentId,
        options,
        contentType: typeof content === 'string' ? 'text' : 'binary'
      });

      // Step 1: Classify document type
      const classification = await this.documentClassifier.classify(content);
      logger.info('Document classified', { documentId, classification });

      // Step 2: Determine processing strategy
      const strategy = this.determineStrategy(classification, options);

      // Step 3: Process based on strategy
      let processedContent: ProcessingResult;

      if (strategy.useDocling && this.shouldUseDocling(classification.format)) {
        processedContent = await this.processWithDocling(content, options);
      } else if (strategy.useOCR && this.isImageFormat(classification.format)) {
        processedContent = await this.processWithOCR(content, options);
      } else {
        processedContent = await this.processStandardDocument(content, options);
      }

      // Step 4: Extract layout if requested
      if (options.preserveLayout) {
        const layout = await this.layoutAnalyzer.analyze(processedContent.text);
        processedContent.layout = layout;
      }

      // Step 5: Generate Document DNA if enabled
      if (options.enableDocumentDNA) {
        const dna = await this.generateDocumentDNA(
          processedContent,
          classification,
          options
        );
        processedContent.dna = dna;
      }

      // Step 6: Store in GraphRAG with enhanced metadata
      const storageResult = await this.storeEnhancedDocument(
        processedContent,
        options
      );

      const processingTime = Date.now() - startTime;

      logger.info('Advanced document processing completed', {
        documentId,
        processingTime,
        strategy,
        hasLayout: !!processedContent.layout,
        hasDNA: !!processedContent.dna
      });

      return {
        ...processedContent,
        documentId,
        storageResult,
        processingTime,
        metadata: {
          ...processedContent.metadata,
          classification,
          strategy,
          processingTime
        }
      };

    } catch (error) {
      logger.error('Advanced document processing failed', {
        documentId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });

      throw error;
    }
  }

  /**
   * Process document using Docling for layout preservation
   */
  private async processWithDocling(
    content: string | Buffer,
    options: AdvancedProcessingOptions
  ): Promise<ProcessingResult> {
    logger.info('Processing with Docling');

    const doclingResult = await this.doclingIntegration.process(content, {
      preserveLayout: options.preserveLayout ?? true,
      extractTables: options.extractTables ?? true,
      extractFigures: true
    });

    return {
      text: doclingResult.text,
      metadata: {
        processingMethod: 'docling',
        ...doclingResult.metadata
      },
      tables: doclingResult.tables,
      figures: doclingResult.figures,
      layout: doclingResult.layout
    };
  }

  /**
   * Process document using OCR cascade
   */
  private async processWithOCR(
    content: string | Buffer,
    options: AdvancedProcessingOptions
  ): Promise<ProcessingResult> {
    logger.info('Processing with OCR cascade');

    const ocrResult = await this.ocrCascade.process(content, {
      tier: options.ocrTier || 'auto',
      budget: options.budget,
      preserveLayout: options.preserveLayout
    });

    return {
      text: ocrResult.text,
      metadata: {
        processingMethod: 'ocr',
        ocrTier: ocrResult.tier,
        confidence: ocrResult.confidence,
        ...ocrResult.metadata
      },
      layout: ocrResult.layout
    };
  }

  /**
   * Process standard text document
   */
  private async processStandardDocument(
    content: string | Buffer,
    _options: AdvancedProcessingOptions
  ): Promise<ProcessingResult> {
    logger.info('Processing standard document');

    const text = typeof content === 'string' ? content : content.toString('utf-8');

    return {
      text,
      metadata: {
        processingMethod: 'standard'
      }
    };
  }

  /**
   * Generate Document DNA with triple-layer storage
   */
  private async generateDocumentDNA(
    processedContent: ProcessingResult,
    classification: any,
    options: AdvancedProcessingOptions
  ): Promise<DocumentDNA> {
    logger.info('Generating Document DNA');

    // Layer 1: Semantic embeddings (meaning-based)
    const semanticEmbeddingResult = await this.voyageClient.generateEmbedding(
      processedContent.text,
      {
        inputType: 'document',
        contentType: 'text'
      }
    );
    const semanticEmbeddings = semanticEmbeddingResult.embedding;

    // Layer 2: Structural embeddings (layout-based)
    let structuralEmbeddings;
    if (processedContent.layout) {
      const structuralText = this.layoutToStructuralText(processedContent.layout);
      const structuralEmbeddingResult = await this.voyageClient.generateEmbedding(
        structuralText,
        {
          inputType: 'document',
          contentType: 'code' // Better for structural patterns
        }
      );
      structuralEmbeddings = structuralEmbeddingResult.embedding;
    }

    // Layer 3: Original preservation
    const originalLayer: DocumentLayer = {
      type: 'original',
      content: processedContent.text,
      metadata: {
        format: classification.format,
        preservedAt: new Date().toISOString(),
        ...processedContent.metadata
      }
    };

    return {
      id: uuidv4(),
      documentId: options.documentId || uuidv4(),
      layers: {
        semantic: {
          type: 'semantic',
          embeddings: semanticEmbeddings,
          metadata: {
            model: 'voyage-3',
            dimensions: semanticEmbeddings.length
          }
        },
        structural: structuralEmbeddings ? {
          type: 'structural',
          embeddings: structuralEmbeddings,
          layout: processedContent.layout,
          metadata: {
            model: 'voyage-code-3',
            dimensions: structuralEmbeddings.length
          }
        } : undefined,
        original: originalLayer
      },
      createdAt: new Date().toISOString(),
      version: '1.0.0'
    };
  }

  /**
   * Store enhanced document with all layers
   */
  private async storeEnhancedDocument(
    processedContent: ProcessingResult,
    options: AdvancedProcessingOptions
  ): Promise<any> {
    // Use existing storage engine with enhanced metadata
    const metadata: DocumentMetadata = {
      id: options.documentId,
      title: options.title || 'Untitled Document',
      ...processedContent.metadata,
      dna: processedContent.dna,
      layout: processedContent.layout,
      custom: {
        ...processedContent.metadata.custom,
        processingOptions: options
      }
    };

    const result = await this.storageEngine.storeDocument(
      processedContent.text,
      metadata
    );

    return result;
  }

  /**
   * Determine processing strategy based on classification
   */
  private determineStrategy(classification: any, options: AdvancedProcessingOptions) {
    return {
      useDocling: options.enableDocling !== false &&
                  (classification.hasComplexLayout || classification.hasTables),
      useOCR: options.enableOCR !== false &&
              (classification.isScanned || classification.hasImages),
      preserveLayout: options.preserveLayout ?? classification.hasComplexLayout,
      extractTables: options.extractTables ?? classification.hasTables
    };
  }

  /**
   * Check if format should use Docling
   */
  private shouldUseDocling(format: DocumentFormat): boolean {
    const doclingFormats = ['pdf', 'docx', 'pptx', 'html', 'xml'];
    return doclingFormats.includes(format.toLowerCase());
  }

  /**
   * Check if format is image-based
   */
  private isImageFormat(format: DocumentFormat): boolean {
    const imageFormats = ['png', 'jpg', 'jpeg', 'tiff', 'bmp', 'gif', 'webp'];
    return imageFormats.includes(format.toLowerCase());
  }

  /**
   * Convert layout to structural text for embedding
   */
  private layoutToStructuralText(layout: LayoutElement[]): string {
    return layout.map(element => {
      return `[${element.type}] ${element.content || ''} [/${element.type}]`;
    }).join('\n');
  }
}

export default AdvancedDocumentProcessor;