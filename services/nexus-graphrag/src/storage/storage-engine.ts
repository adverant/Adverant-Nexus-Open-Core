import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import * as neo4j from 'neo4j-driver';
import { Pool } from 'pg';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { IntelligentChunkingEngine } from '../chunking/chunking-engine';
import { VoyageAIClient } from '../clients/voyage-ai-unified-client';
import {
  DocumentMetadata,
  StorageResult,
  Chunk,
  ChunkRelationship,
  DocumentSummary,
  DocumentOutline
} from '../types';
import { DocumentDNA } from '../types/document-dna';
import { logger } from '../utils/logger';
import { config } from '../config';
import { validateAndFixDocumentType } from '../utils/document-type-detector';
import { ContentTypeDetector, ContentType, detectContentTypeFull } from '../utils/content-type-detector';
import {
  PDFParsingError,
  FileParsingError,
  InvalidFilePathError,
  ContentPreprocessingError,
  InsufficientChunksError
} from '../utils/document-errors';
import { ingestionMetrics } from '../metrics/ingestion-metrics';
import { toPostgresArray } from '../utils/postgres-helpers';

export class GraphRAGStorageEngine {
  private chunkingEngine: IntelligentChunkingEngine;
  private voyageClient: VoyageAIClient;
  private qdrantClient: QdrantClient;
  private neo4jDriver: neo4j.Driver;
  private postgresPool: Pool;
  private redisClient: Redis;
  
  constructor() {
    // Initialize all clients - order matters: voyageClient must be created before chunkingEngine
    this.voyageClient = new VoyageAIClient(config.voyageAI.apiKey!);

    this.chunkingEngine = new IntelligentChunkingEngine({
      maxChunkTokens: config.chunking.maxTokens,
      overlapTokens: config.chunking.overlapTokens,
      voyageClient: this.voyageClient
    });
    
    this.qdrantClient = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey
    });
    
    this.neo4jDriver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
    );
    
    this.postgresPool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    });
    
    this.redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      retryStrategy: (times) => Math.min(times * 50, 2000)
    });
  }

  /**
   * Verify Neo4j connection on startup
   * Throws error if connection fails, preventing silent failures
   */
  async verifyNeo4jConnection(): Promise<void> {
    const session = this.neo4jDriver.session();

    try {
      logger.info('Verifying Neo4j connection...');

      // Test read permissions
      const result = await session.run('RETURN 1 as test');
      if (!result.records.length) {
        throw new Error('Neo4j connection test failed - no records returned');
      }

      // Test write permissions
      await session.run('CREATE (t:Test {timestamp: $ts}) DELETE t', {
        ts: Date.now()
      });

      logger.info('Neo4j connection verified successfully', {
        uri: config.neo4j.uri,
        database: config.neo4j.database || 'neo4j'
      });

    } catch (error: any) {
      logger.error('Neo4j connection failed', {
        error: error.message,
        uri: config.neo4j.uri,
        code: error.code,
        name: error.name
      });
      throw new Error(`Neo4j connection failed: ${error.message}`);
    } finally {
      await session.close();
    }
  }

  async storeDocument(
    content: string | Buffer,
    metadata: DocumentMetadata
  ): Promise<StorageResult> {
    const documentId = metadata.id || uuidv4();
    const startTime = Date.now();

    try {
      // ========================================
      // NEW: PREPROCESSING PIPELINE
      // ========================================
      // Intelligent content detection and extraction
      // Handles: plain text, file paths, Buffers, base64
      const preprocessed = await this.preprocessContent(content, metadata);
      const textContent = preprocessed.text;
      const enhancedMetadata = preprocessed.metadata;

      logger.info('Content preprocessing completed', {
        documentId,
        originalType: preprocessed.detectedType,
        extractedLength: textContent.length,
        preprocessingTime: `${Date.now() - startTime}ms`
      });

      // 1. Prepare document content
      const documentHash = this.computeHash(textContent);

      // Validate and fix document type
      const typeValidation = validateAndFixDocumentType(
        enhancedMetadata.type,
        textContent,
        enhancedMetadata
      );
      if (!typeValidation.isValid || !typeValidation.type) {
        throw new Error(typeValidation.error || 'Invalid document type');
      }

      // Enhance metadata with validated type and preprocessing info
      metadata = {
        ...enhancedMetadata,
        id: documentId,
        type: typeValidation.type,
        format: enhancedMetadata.format || enhancedMetadata.type || 'text',
        hash: documentHash,
        size: Buffer.byteLength(textContent, 'utf-8'),
        created_at: enhancedMetadata.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: enhancedMetadata.version || 1
      };
      
      // Check for duplicates
      const existing = await this.findDocumentByHash(documentHash);
      if (existing) {
        const processingTime = Date.now() - startTime;
        logger.info('Document already exists', { documentId: existing.id });

        // Record duplicate in metrics
        ingestionMetrics.recordIngestion({
          operation: 'store_document',
          success: true,
          duplicate: true,
          documentSize: Buffer.byteLength(textContent, 'utf-8'),
          processingTime
        });

        return {
          success: true,
          documentId: existing.id,
          message: 'Document already exists',
          duplicate: true
        };
      }
      
      // 2. Store full document
      await this.storeFullDocument(documentId, textContent, metadata);
      
      // 3. Intelligent chunking with fallback
      logger.info('Starting intelligent chunking', { documentId });

      // OPTIMIZATION: Small documents don't need chunking
      const contentLength = textContent.length;
      const useDirectStorage = contentLength < 500 || metadata._chunkingHints?.singleChunk;

      let chunkingResult;

      if (useDirectStorage) {
        logger.info('Document small enough for single chunk storage', {
          documentId,
          contentLength,
          reason: contentLength < 500 ? 'content_too_small' : 'single_chunk_hint'
        });

        // Store as single chunk without chunking overhead
        chunkingResult = {
          chunks: [{
            id: uuidv4(),
            document_id: documentId,  // Fixed: use document_id not documentId
            content: textContent,
            tokens: Math.ceil(textContent.length / 4),
            position: { start: 0, end: textContent.length },
            type: 'paragraph',
            metadata: {
              importance_score: 1,
              semantic_density: 1,
              contains_key_info: true,
              singleChunkOptimization: true
            }
          }],
          relationships: [],
          summary: {
            content: textContent.substring(0, 200) + (textContent.length > 200 ? '...' : ''),
            keyPoints: []
          },
          outline: { sections: [] }
        };
      } else {
        // Normal chunking for larger documents
        chunkingResult = await this.chunkingEngine.chunkDocument(textContent, metadata);
      }

      // FALLBACK: If chunking produced 0 chunks or failed, store as single chunk
      if (!chunkingResult.chunks || chunkingResult.chunks.length === 0) {
        logger.warn('Chunking produced 0 chunks, using single-chunk fallback', {
          documentId,
          contentLength: textContent.length,
          reason: 'Chunking failed to find split points'
        });

        // Create single chunk from entire document
        chunkingResult = {
          chunks: [{
            id: uuidv4(),
            document_id: documentId,  // Fixed: use document_id not documentId
            content: textContent,
            tokens: Math.ceil(textContent.length / 4), // Rough token estimate
            position: { start: 0, end: textContent.length },
            type: 'paragraph',
            metadata: {
              importance_score: 1,
              semantic_density: 1,
              contains_key_info: true,
              fallbackChunk: true,
              chunkingStrategy: 'single-chunk-fallback'
            }
          }],
          relationships: [],
          summary: {
            content: textContent.substring(0, 200) + (textContent.length > 200 ? '...' : ''),
            keyPoints: []
          },
          outline: { sections: [] }
        };

        logger.info('Single-chunk fallback created successfully', {
          documentId,
          chunkSize: textContent.length
        });
      }

      // 4. Propagate document-level metadata to chunks (for artifact URLs, etc.)
      // This ensures artifact references flow from document to each chunk
      const chunksWithDocMetadata = chunkingResult.chunks.map(chunk => ({
        ...chunk,
        metadata: {
          ...chunk.metadata,
          title: metadata.title,
          artifactId: metadata.artifactId,
          artifactUrl: metadata.artifactUrl,
          storageBackend: metadata.storageBackend,
          documentDnaId: metadata.documentDnaId
        }
      }));

      // 5. Generate embeddings for all chunks
      logger.info('Generating chunk embeddings', { documentId, chunkCount: chunksWithDocMetadata.length });
      const chunks = await this.generateChunkEmbeddings(chunksWithDocMetadata as Chunk[]);

      // 6. Store chunks in Qdrant
      logger.info('Storing chunks in Qdrant', { documentId });
      await this.storeChunksInQdrant(chunks);

      // 7. Store relationships in Neo4j
      logger.info('Storing relationships in Neo4j', { documentId });
      await this.storeRelationshipsInNeo4j(
        documentId,
        chunks,
        chunkingResult.relationships
      );

      // 8. Store summary and outline
      logger.info('Storing summary and outline', { documentId });
      await this.storeSummaryAndOutline(
        documentId,
        chunkingResult.summary,
        chunkingResult.outline as DocumentOutline
      );

      // 9. Update search indexes
      await this.updateSearchIndexes(documentId, metadata, chunks);

      // 10. Clear relevant caches
      await this.clearCaches(documentId);

      // ========================================
      // NEW: POST-STORAGE VERIFICATION
      // ========================================
      // Verify storage quality to catch silent failures
      await this.verifyStorageQuality(documentId, chunks, textContent);

      const processingTime = Date.now() - startTime;

      logger.info('Document stored successfully', {
        documentId,
        processingTime,
        chunksCreated: chunks.length,
        relationshipsCreated: chunkingResult.relationships.length
      });

      // Record successful ingestion in metrics
      ingestionMetrics.recordIngestion({
        operation: 'store_document',
        success: true,
        duplicate: false,
        documentSize: Buffer.byteLength(textContent, 'utf-8'),
        chunkCount: chunks.length,
        processingTime
      });

      return {
        success: true,
        documentId,
        chunksCreated: chunks.length,
        relationshipsCreated: chunkingResult.relationships.length,
        processingTimeMs: processingTime,
        metadata: {
          tokens: chunks.reduce((sum, c) => sum + c.tokens, 0),
          embeddingModel: this.getEmbeddingModel(metadata.type)
        }
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      logger.error('Document storage failed', { error, documentId });

      // Record failed ingestion in metrics
      ingestionMetrics.recordIngestion({
        operation: 'store_document',
        success: false,
        duplicate: false,
        processingTime,
        error: (error as Error).message
      });

      // Cleanup on failure
      await this.rollbackDocumentStorage(documentId);

      throw error;
    }
  }

  /**
   * ========================================
   * PREPROCESSING PIPELINE
   * ========================================
   * Intelligently detect content type and extract text
   */
  private async preprocessContent(
    content: string | Buffer,
    metadata: DocumentMetadata
  ): Promise<{
    text: string;
    metadata: DocumentMetadata;
    detectedType: ContentType;
  }> {
    // Detect content type
    const detection = detectContentTypeFull(content);

    logger.info('Content type detected', {
      type: detection.type,
      confidence: detection.confidence,
      reason: detection.reason
    });

    // Route to appropriate handler
    switch (detection.type) {
      case ContentType.FILEPATH:
        return await this.handleFilePath(content as string, metadata, detection);

      case ContentType.BUFFER:
        return await this.handleBuffer(content as Buffer, metadata, detection);

      case ContentType.BASE64:
        return await this.handleBase64(content as string, metadata, detection);

      case ContentType.PLAINTEXT:
      default:
        const rawText = Buffer.isBuffer(content) ? content.toString('utf-8') : content;
        return {
          text: this.sanitizeTextForPostgres(rawText),
          metadata,
          detectedType: detection.type
        };
    }
  }

  /**
   * Handle file path input - read file and parse
   */
  private async handleFilePath(
    filePath: string,
    metadata: DocumentMetadata,
    detection: any
  ): Promise<{
    text: string;
    metadata: DocumentMetadata;
    detectedType: ContentType;
  }> {
    try {
      // Validate file path
      const validation = ContentTypeDetector.validateFilePath(filePath);
      if (!validation.valid) {
        throw new InvalidFilePathError(filePath, validation.error!);
      }

      logger.info('Processing file from path', {
        filePath,
        fileSize: validation.stats!.size,
        extension: detection.metadata?.fileExtension
      });

      // Read file
      const fileBuffer = fs.readFileSync(filePath);

      // Get file info
      const fileName = path.basename(filePath);
      const extension = ContentTypeDetector.getFileExtension(fileName);

      // Check if file needs parsing
      if (extension && ContentTypeDetector.isParseableExtension(extension)) {
        return await this.parseFile(fileBuffer, fileName, filePath, metadata);
      }

      // Plain text file - just read as UTF-8 and sanitize
      return {
        text: this.sanitizeTextForPostgres(fileBuffer.toString('utf-8')),
        metadata: {
          ...metadata,
          source: filePath,
          filename: fileName,
          originalFormat: extension || 'unknown'
        },
        detectedType: ContentType.FILEPATH
      };
    } catch (error) {
      throw new ContentPreprocessingError(
        'filepath',
        'file reading',
        (error as Error).message,
        error as Error
      );
    }
  }

  /**
   * Handle Buffer input - detect format and parse
   */
  private async handleBuffer(
    buffer: Buffer,
    metadata: DocumentMetadata,
    _detection: any
  ): Promise<{
    text: string;
    metadata: DocumentMetadata;
    detectedType: ContentType;
  }> {
    try {
      logger.info('Processing Buffer content', {
        bufferSize: buffer.length
      });

      // If filename is provided in metadata, use it to determine if parsing is needed
      const fileName = metadata.filename || metadata.source || 'document.bin';
      const extension = ContentTypeDetector.getFileExtension(fileName);

      if (extension && ContentTypeDetector.isParseableExtension(extension)) {
        return await this.parseFile(buffer, fileName, 'buffer', metadata);
      }

      // Assume UTF-8 text and sanitize
      return {
        text: this.sanitizeTextForPostgres(buffer.toString('utf-8')),
        metadata: {
          ...metadata,
          originalFormat: extension || 'binary'
        },
        detectedType: ContentType.BUFFER
      };
    } catch (error) {
      throw new ContentPreprocessingError(
        'buffer',
        'buffer processing',
        (error as Error).message,
        error as Error
      );
    }
  }

  /**
   * Handle base64-encoded input - decode and parse
   */
  private async handleBase64(
    base64String: string,
    metadata: DocumentMetadata,
    detection: any
  ): Promise<{
    text: string;
    metadata: DocumentMetadata;
    detectedType: ContentType;
  }> {
    try {
      logger.info('Processing base64-encoded content');

      // Decode base64
      const buffer = ContentTypeDetector.decodeBase64(base64String);

      // Process as buffer
      return await this.handleBuffer(buffer, metadata, detection);
    } catch (error) {
      throw new ContentPreprocessingError(
        'base64',
        'base64 decoding',
        (error as Error).message,
        error as Error
      );
    }
  }

  /**
   * Parse file using document parser
   * Lazy loads the file-document-validator to avoid loading parsers unless needed
   */
  private async parseFile(
    buffer: Buffer,
    fileName: string,
    sourcePath: string,
    metadata: DocumentMetadata
  ): Promise<{
    text: string;
    metadata: DocumentMetadata;
    detectedType: ContentType;
  }> {
    try {
      // Dynamic import to avoid loading parser if not needed
      const { validateFileDocument } = await import('../validators/file-document-validator');

      logger.info('Parsing file with document parser', {
        fileName,
        bufferSize: buffer.length
      });

      // Parse document
      const parsed = await validateFileDocument(buffer, fileName, undefined, metadata.domain);

      if (!parsed.valid) {
        const errorMessage = parsed.errors?.join('; ') || 'Parsing failed';

        // Detect specific error types
        if (fileName.toLowerCase().endsWith('.pdf')) {
          throw new PDFParsingError(sourcePath, errorMessage);
        } else {
          const extension = ContentTypeDetector.getFileExtension(fileName);
          throw new FileParsingError(
            sourcePath,
            extension || 'unknown',
            errorMessage
          );
        }
      }

      logger.info('File parsed successfully', {
        fileName,
        extractedLength: parsed.content.length,
        wordCount: parsed.metadata.wordCount
      });

      // Return parsed content with enriched metadata (sanitized for PostgreSQL)
      return {
        text: this.sanitizeTextForPostgres(parsed.content),
        metadata: {
          ...metadata,
          ...parsed.metadata,
          source: sourcePath,
          filename: fileName,
          parsedFrom: parsed.metadata.format
        },
        detectedType: ContentType.FILEPATH
      };
    } catch (error) {
      // Re-throw if already a document processing error
      if (error instanceof PDFParsingError || error instanceof FileParsingError) {
        throw error;
      }

      // Wrap other errors
      throw new ContentPreprocessingError(
        'file',
        'document parsing',
        (error as Error).message,
        error as Error
      );
    }
  }

  /**
   * ========================================
   * POST-STORAGE VERIFICATION
   * ========================================
   * Verify storage quality to detect silent failures
   */
  private async verifyStorageQuality(
    documentId: string,
    chunks: Chunk[],
    originalContent: string
  ): Promise<void> {
    const minimumChunks = 1;

    // Check 1: Zero chunks indicates complete failure
    if (chunks.length === 0) {
      throw new InsufficientChunksError(
        documentId,
        0,
        minimumChunks,
        'No chunks created'
      );
    }

    // Check 2: Single tiny chunk indicates file path was stored
    if (chunks.length === 1) {
      const firstChunk = chunks[0];

      // If chunk is suspiciously small (< 100 chars) and looks like a file path
      if (firstChunk.content.length < 100) {
        const looksLikeFilePath =
          firstChunk.content.startsWith('/') ||
          firstChunk.content.includes('\\') ||
          firstChunk.content.match(/\.[a-z]{2,5}$/i);

        if (looksLikeFilePath) {
          throw new InsufficientChunksError(
            documentId,
            1,
            minimumChunks,
            firstChunk.content
          );
        }
      }

      // If chunk is very small relative to original content
      const compressionRatio = firstChunk.content.length / originalContent.length;
      if (compressionRatio < 0.1 && originalContent.length > 1000) {
        logger.warn('Single chunk is suspiciously small relative to original content', {
          documentId,
          chunkSize: firstChunk.content.length,
          originalSize: originalContent.length,
          compressionRatio
        });

        throw new InsufficientChunksError(
          documentId,
          1,
          minimumChunks,
          firstChunk.content.substring(0, 100)
        );
      }
    }

    // Check 3: Verify chunks contain actual content (not just whitespace)
    const nonEmptyChunks = chunks.filter(c => c.content.trim().length > 10);
    if (nonEmptyChunks.length === 0) {
      throw new InsufficientChunksError(
        documentId,
        chunks.length,
        minimumChunks,
        'All chunks contain only whitespace'
      );
    }

    logger.info('Storage quality verification passed', {
      documentId,
      totalChunks: chunks.length,
      nonEmptyChunks: nonEmptyChunks.length,
      averageChunkSize: Math.round(
        chunks.reduce((sum, c) => sum + c.content.length, 0) / chunks.length
      )
    });
  }

  private async storeFullDocument(
    documentId: string, 
    content: string, 
    metadata: DocumentMetadata
  ): Promise<void> {
    const client = await this.postgresPool.connect();
    
    try {
      await client.query('BEGIN');

      // DEFENSIVE: Ensure version is a valid integer (database constraint: version > 0)
      // Handles edge cases where validation layer might be bypassed
      let safeVersion = metadata.version;
      if (!Number.isInteger(safeVersion) || safeVersion < 1) {
        logger.warn('Invalid version detected in storage engine, coercing to 1', {
          providedVersion: safeVersion,
          providedType: typeof safeVersion,
          documentId
        });
        safeVersion = 1;
      }

      // Store document metadata
      // Note: tags must be converted to PostgreSQL array format using toPostgresArray()
      await client.query(`
        INSERT INTO graphrag.documents (
          id, title, type, format, size, hash,
          created_at, updated_at, version, tags, source, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        )
      `, [
        documentId,
        metadata.title,
        metadata.type,
        metadata.format,
        metadata.size,
        metadata.hash,
        metadata.created_at,
        metadata.updated_at,
        safeVersion, // Use validated version
        toPostgresArray(metadata.tags), // Convert JS array to PostgreSQL array format
        metadata.source,
        JSON.stringify(metadata.custom || {})
      ]);
      
      // Store document content
      await client.query(`
        INSERT INTO graphrag.document_content (document_id, content, encoding)
        VALUES ($1, $2, $3)
      `, [documentId, content, metadata.encoding || 'utf-8']);
      
      await client.query('COMMIT');
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  private async generateChunkEmbeddings(chunks: Chunk[]): Promise<Chunk[]> {
    const embeddedChunks: Chunk[] = [];
    const batchSize = 10;
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      
      try {
        const embeddings = await Promise.all(
          batch.map(chunk => 
            this.voyageClient.generateEmbedding(chunk.content, {
              contentType: this.getContentType(chunk),
              inputType: 'document',
              modelOptions: {
                truncate: true
              }
            })
          )
        );
        
        batch.forEach((chunk, idx) => {
          embeddedChunks.push({
            ...chunk,
            embedding: embeddings[idx].embedding  // Extract array from VoyageEmbedding object
          });
        });
        
      } catch (error) {
        logger.error('Batch embedding generation failed', { error, batchIndex: i / batchSize });
        
        // Fallback: try individual embeddings
        for (const chunk of batch) {
          try {
            const embeddingResult = await this.voyageClient.generateEmbedding(chunk.content, {
              contentType: this.getContentType(chunk),
              inputType: 'document'
            });

            embeddedChunks.push({
              ...chunk,
              embedding: embeddingResult.embedding  // Extract array from VoyageEmbedding object
            });
          } catch (individualError) {
            logger.error('Individual embedding generation failed', { error: individualError, chunkId: chunk.id });
            throw individualError;
          }
        }
      }
      
      // Rate limiting pause
      if (i + batchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return embeddedChunks;
  }
  
  private async storeChunksInQdrant(chunks: Chunk[]): Promise<void> {
    // Ensure collection exists
    const collections = await this.qdrantClient.getCollections();
    const collectionName = 'chunks';
    
    if (!collections.collections.some(c => c.name === collectionName)) {
      await this.qdrantClient.createCollection(collectionName, {
        vectors: {
          size: config.voyageAI.dimensions,
          distance: 'Cosine'
        },
        optimizers_config: {
          default_segment_number: 2
        },
        replication_factor: 2
      });
      
      // Create indexes for filtering
      // Note: createFieldIndex may not be available in this version of Qdrant client
      // Field indexes are created automatically when using payload filters
      // await (this.qdrantClient as any).createFieldIndex(collectionName, {
      //   field_name: 'document_id',
      //   field_schema: 'keyword'
      // });

      // await (this.qdrantClient as any).createFieldIndex(collectionName, {
      //   field_name: 'type',
      //   field_schema: 'keyword'
      // });
    }
    
    // Prepare points for insertion
    const points = chunks.map(chunk => ({
      id: chunk.id,
      vector: chunk.embedding!,
      payload: {
        document_id: chunk.document_id,
        content: chunk.content,
        type: chunk.type,
        position: chunk.position,
        metadata: chunk.metadata,
        tokens: chunk.tokens,
        summary: chunk.summary
      }
    }));
    
    // Batch upsert
    const batchSize = 100;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);

      try {
        console.log('=== QDRANT UPSERT START ===');
        console.log('Upserting batch to Qdrant:', {
          collectionName,
          batchSize: batch.length,
          firstPoint: batch[0] ? {
            id: batch[0].id,
            idType: typeof batch[0].id,
            vectorLength: batch[0].vector?.length,
            payloadKeys: Object.keys(batch[0].payload || {}),
            documentId: batch[0].payload?.document_id
          } : null
        });

        const upsertResult = await this.qdrantClient.upsert(collectionName, {
          wait: true,
          points: batch
        });

        console.log('=== QDRANT UPSERT RESULT ===', JSON.stringify(upsertResult));

        logger.debug('Upserted chunk batch to Qdrant', {
          batchStart: i,
          batchEnd: Math.min(i + batchSize, points.length),
          total: points.length,
          result: upsertResult
        });
      } catch (error: any) {
        console.error('Qdrant upsert failed:', {
          error: error.message,
          stack: error.stack,
          batchSize: batch.length,
          samplePoint: batch[0]
        });
        throw error;
      }
    }

    // ========================================
    // DUAL-WRITE: Also store in unified_content for memory recall searchability
    // This enables documents to be found via /api/memory/recall alongside episodic memories
    // ========================================
    try {
      // Generate unique UUIDs for unified_content by creating deterministic IDs
      // based on chunk ID + 'doc' namespace to avoid collisions with memories
      const unifiedPoints = chunks.map(chunk => {
        // Create a deterministic but different UUID by XORing with a fixed namespace
        // This ensures the same chunk always gets the same unified_content ID
        const chunkIdParts = chunk.id.split('-');
        const docNamespace = 'd0c00000'; // Doc namespace marker
        const unifiedId = `${docNamespace}-${chunkIdParts[1]}-${chunkIdParts[2]}-${chunkIdParts[3]}-${chunkIdParts[4]}`;
        return {
          id: unifiedId,
          vector: chunk.embedding!,
          payload: {
            content_type: 'document_chunk',
            content: chunk.content,
            document_id: chunk.document_id,
            chunk_id: chunk.id,
            position: chunk.position,
            page_number: chunk.metadata?.pageNumber || null,
            title: chunk.metadata?.title || null,
            tags: chunk.metadata?.tags || [],
            type: chunk.type,
            tokens: chunk.tokens,
            timestamp: new Date().toISOString(),
            // Artifact references for permanent file storage and page-specific viewing
            artifact_id: chunk.metadata?.artifactId || null,
            artifact_url: chunk.metadata?.artifactUrl || null,
            storage_backend: chunk.metadata?.storageBackend || null,
            // Tenant context - documents are system-level, shared across users
            company_id: 'adverant',
            app_id: 'fileprocess',
            user_id: 'system'
          }
        };
      });

      // Batch upsert to unified_content
      for (let i = 0; i < unifiedPoints.length; i += batchSize) {
        const batch = unifiedPoints.slice(i, i + batchSize);

        console.log('=== UNIFIED_CONTENT UPSERT START ===');
        console.log('Upserting to unified_content:', {
          batchSize: batch.length,
          firstPointId: batch[0]?.id,
          firstPointDocId: batch[0]?.payload?.document_id,
          firstPointPageNum: batch[0]?.payload?.page_number
        });

        const unifiedResult = await this.qdrantClient.upsert('unified_content', {
          wait: true,
          points: batch
        });

        console.log('=== UNIFIED_CONTENT UPSERT RESULT ===', JSON.stringify(unifiedResult));

        logger.debug('Upserted document chunks to unified_content', {
          batchStart: i,
          batchEnd: Math.min(i + batchSize, unifiedPoints.length),
          total: unifiedPoints.length,
          result: unifiedResult
        });
      }

      logger.info('Document chunks indexed in unified_content for memory recall', {
        chunkCount: chunks.length,
        documentId: chunks[0]?.document_id
      });
    } catch (unifiedError: any) {
      // Log but don't fail the main operation - unified_content is for search enhancement
      logger.warn('Failed to index document chunks in unified_content', {
        error: unifiedError.message,
        chunkCount: chunks.length
      });
    }
  }

  private async storeRelationshipsInNeo4j(
    documentId: string,
    chunks: Chunk[],
    relationships: ChunkRelationship[]
  ): Promise<void> {
    const session = this.neo4jDriver.session();

    try {
      logger.info('Creating Neo4j document node', {
        documentId,
        chunkCount: chunks.length,
        relationshipCount: relationships.length
      });

      // Use MERGE instead of CREATE to handle duplicates (idempotent)
      const docResult = await session.run(`
        MERGE (d:Document {id: $id})
        ON CREATE SET
          d.title = $title,
          d.type = $type,
          d.created_at = datetime($created_at),
          d.hash = $hash
        ON MATCH SET
          d.updated_at = datetime($updated_at)
        RETURN d
      `, {
        id: documentId,
        title: chunks[0]?.metadata.title || 'Untitled',
        type: chunks[0]?.metadata.type || 'unknown',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        hash: documentId.substring(0, 8) // Use first 8 chars as hash
      });

      if (!docResult.records.length) {
        throw new Error(`Failed to create document node for ${documentId}`);
      }

      logger.info('Document node created successfully', {
        documentId,
        nodeId: docResult.records[0].get('d').identity.toString()
      });

      // Create chunk nodes in batch with MERGE for idempotency
      const chunkQuery = `
        UNWIND $chunks AS chunk
        MERGE (c:Chunk {id: chunk.id})
        ON CREATE SET
          c.document_id = chunk.document_id,
          c.type = chunk.type,
          c.position_start = chunk.position.start,
          c.position_end = chunk.position.end,
          c.line_start = chunk.position.line_start,
          c.line_end = chunk.position.line_end,
          c.tokens = chunk.tokens,
          c.importance_score = chunk.metadata.importance_score,
          c.semantic_density = chunk.metadata.semantic_density,
          c.contains_key_info = chunk.metadata.contains_key_info,
          c.created_at = datetime($created_at)
        RETURN c
      `;

      const chunkResult = await session.run(chunkQuery, {
        chunks: chunks.map(chunk => ({
          ...chunk,
          position: chunk.position,
          metadata: chunk.metadata
        })),
        created_at: new Date().toISOString()
      });

      logger.info('Chunk nodes created', {
        documentId,
        chunksCreated: chunkResult.records.length,
        expectedChunks: chunks.length
      });

      // Create relationships between chunks
      if (relationships.length > 0) {
        const relationshipQuery = `
          UNWIND $relationships AS rel
          MATCH (source:Chunk {id: rel.source_id})
          MATCH (target:Chunk {id: rel.target_id})
          MERGE (source)-[r:${relationships[0].type}]->(target)
          ON CREATE SET r.weight = rel.weight
          RETURN r
        `;

        // Group relationships by type for efficient processing
        const relationshipsByType = relationships.reduce((acc, rel) => {
          if (!acc[rel.type]) acc[rel.type] = [];
          acc[rel.type].push(rel);
          return acc;
        }, {} as Record<string, ChunkRelationship[]>);

        let totalRelationships = 0;
        for (const [relType, rels] of Object.entries(relationshipsByType)) {
          const relResult = await session.run(
            relationshipQuery.replace(relationships[0].type, relType),
            { relationships: rels }
          );
          totalRelationships += relResult.records.length;
        }

        logger.info('Chunk relationships created', {
          documentId,
          relationshipsCreated: totalRelationships
        });
      }

      // Link chunks to document with MERGE
      const linkResult = await session.run(`
        MATCH (d:Document {id: $documentId})
        MATCH (c:Chunk {document_id: $documentId})
        MERGE (d)-[:CONTAINS]->(c)
        RETURN count(c) as linkedChunks
      `, { documentId });

      const linkedChunks = linkResult.records[0]?.get('linkedChunks').toNumber() || 0;

      logger.info('Neo4j storage complete', {
        documentId,
        linkedChunks,
        expectedChunks: chunks.length
      });

      if (linkedChunks !== chunks.length) {
        logger.warn('Chunk count mismatch in Neo4j', {
          documentId,
          expected: chunks.length,
          actual: linkedChunks
        });
      }

    } catch (error: any) {
      logger.error('Neo4j storage failed', {
        error: error.message,
        stack: error.stack,
        documentId,
        chunkCount: chunks.length,
        neo4jCode: error.code,
        neo4jName: error.name
      });

      // Re-throw to prevent silent failures
      throw new Error(`Neo4j storage failed for document ${documentId}: ${error.message}`);

    } finally {
      await session.close();
    }
  }
  
  private async storeSummaryAndOutline(
    documentId: string,
    summary: DocumentSummary,
    outline: DocumentOutline
  ): Promise<void> {
    const client = await this.postgresPool.connect();

    try {
      // Store summary (only if content exists)
      if (summary?.content) {
        await client.query(`
          INSERT INTO graphrag.document_summaries (
            document_id, summary, key_points,
            generated_at, generation_model
          ) VALUES ($1, $2, $3, $4, $5)
        `, [
          documentId,
          summary.content,
          toPostgresArray(summary.keyPoints), // Convert JS array to PostgreSQL text[] format
          new Date().toISOString(),
          summary.generationModel || 'claude-3-haiku'
        ]);
      } else {
        logger.warn('Summary not available, skipping summary storage', { documentId });
      }

      // Store outline (only if outline exists)
      if (outline?.sections) {
        await client.query(`
          INSERT INTO graphrag.document_outlines (
            document_id, outline_json, section_count,
            max_depth, generated_at
          ) VALUES ($1, $2, $3, $4, $5)
        `, [
          documentId,
          JSON.stringify(outline),
          outline.sections.length,
          this.calculateMaxDepth(outline),
          new Date().toISOString()
        ]);
      } else {
        logger.warn('Outline not available, skipping outline storage', { documentId });
      }

      // Store summary embedding for semantic search
      if (summary?.content) {
        const summaryEmbeddingResult = await this.voyageClient.generateEmbedding(summary.content, {
          contentType: 'text',
          inputType: 'document'
        });

        await this.qdrantClient.upsert('document_summaries', {
          wait: true,
          points: [{
            id: documentId,
            vector: summaryEmbeddingResult.embedding,
            payload: {
              document_id: documentId,
              content: summary.content,
              key_points: summary.keyPoints
            }
          }]
        });
      }
      
    } finally {
      client.release();
    }
  }
  
  private async updateSearchIndexes(
    documentId: string, 
    metadata: DocumentMetadata, 
    chunks: Chunk[]
  ): Promise<void> {
    const client = await this.postgresPool.connect();
    
    try {
      // Update full-text search index - store aggregated content for search
      // Note: search_index table only has: id, document_id, search_vector, content, metadata, created_at
      // title and tags are stored in metadata JSON
      const searchMetadata = {
        title: metadata.title,
        tags: metadata.tags || [],
        type: metadata.type,
        custom: metadata.custom || {}
      };

      await client.query(`
        INSERT INTO graphrag.search_index (
          document_id, content, metadata
        ) VALUES (
          $1, $2, $3
        )
      `, [
        documentId,
        chunks.map(c => c.content).join(' '),
        JSON.stringify(searchMetadata)
      ]);
      
    } finally {
      client.release();
    }
  }
  
  private async clearCaches(documentId: string): Promise<void> {
    const patterns = [
      `doc:${documentId}:*`,
      `retrieval:*:${documentId}:*`,
      `query:*`
    ];
    
    for (const pattern of patterns) {
      const keys = await this.redisClient.keys(pattern);
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
      }
    }
  }
  
  private async rollbackDocumentStorage(documentId: string): Promise<void> {
    logger.warn('Rolling back document storage', { documentId });
    
    try {
      // Remove from PostgreSQL
      const client = await this.postgresPool.connect();
      try {
        await client.query('DELETE FROM graphrag.documents WHERE id = $1', [documentId]);
        await client.query('DELETE FROM graphrag.document_content WHERE document_id = $1', [documentId]);
        await client.query('DELETE FROM graphrag.document_summaries WHERE document_id = $1', [documentId]);
        await client.query('DELETE FROM graphrag.document_outlines WHERE document_id = $1', [documentId]);
        await client.query('DELETE FROM graphrag.search_index WHERE document_id = $1', [documentId]);
      } finally {
        client.release();
      }
      
      // Remove from Qdrant
      await this.qdrantClient.delete('chunks', {
        filter: {
          must: [{
            key: 'document_id',
            match: { value: documentId }
          }]
        }
      });
      
      await this.qdrantClient.delete('document_summaries', {
        filter: {
          must: [{
            key: 'document_id',
            match: { value: documentId }
          }]
        }
      });
      
      // Remove from Neo4j
      const session = this.neo4jDriver.session();
      try {
        await session.run(`
          MATCH (d:Document {id: $documentId})
          OPTIONAL MATCH (d)-[r]->(c:Chunk)
          DETACH DELETE d, c
        `, { documentId });
      } finally {
        await session.close();
      }
      
      // Clear caches
      await this.clearCaches(documentId);
      
    } catch (rollbackError) {
      logger.error('Rollback failed', { error: rollbackError, documentId });
    }
  }
  
  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Sanitize text content for PostgreSQL UTF-8 storage
   * Removes null bytes and other problematic characters that PostgreSQL rejects
   */
  private sanitizeTextForPostgres(text: string): string {
    // Remove null bytes (0x00) - PostgreSQL UTF-8 encoding doesn't allow them
    let sanitized = text.replace(/\0/g, '');

    // Remove other control characters that might cause issues (optional, keeping only \n, \r, \t)
    // This preserves line breaks and tabs while removing other control chars
    sanitized = sanitized.replace(/[\x01-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

    return sanitized;
  }

  private async findDocumentByHash(hash: string): Promise<any> {
    const client = await this.postgresPool.connect();
    
    try {
      const result = await client.query(
        'SELECT id FROM graphrag.documents WHERE hash = $1',
        [hash]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }
  
  private getEmbeddingModel(documentType: string): string {
    const modelMap: Record<string, string> = {
      'code': 'voyage-code-3',
      'multimodal': 'voyage-3', // FIX: voyage-multimodal-3 doesn't exist, use voyage-3
      'text': 'voyage-3',
      'markdown': 'voyage-3',
      'structured': 'voyage-3'
    };

    return modelMap[documentType] || 'voyage-3';
  }
  
  private getContentType(chunk: Chunk): 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general' {
    if (chunk.type === 'code_block' || chunk.type === 'function' || chunk.type === 'class') {
      return 'code';
    }
    return 'text';
  }
  
  private calculateMaxDepth(outline: DocumentOutline): number {
    let maxDepth = 0;
    
    const traverse = (sections: any[], depth: number) => {
      maxDepth = Math.max(maxDepth, depth);
      for (const section of sections) {
        if (section.children && section.children.length > 0) {
          traverse(section.children, depth + 1);
        }
      }
    };
    
    traverse(outline.sections, 1);
    return maxDepth;
  }
  
  /**
   * Store Document DNA with triple-layer preservation
   *
   * This method stores documents in three layers:
   * 1. Semantic layer - meaning-based embeddings with voyage-3
   * 2. Structural layer - layout-preserving embeddings with voyage-code-3
   * 3. Original layer - raw document preservation
   */
  async storeDocumentDNA(
    documentId: string,
    dna: DocumentDNA,
    metadata: DocumentMetadata
  ): Promise<void> {
    const startTime = Date.now();

    logger.info('Storing Document DNA', {
      documentId,
      hasSemanticLayer: !!dna.layers.semantic,
      hasStructuralLayer: !!dna.layers.structural,
      hasOriginalLayer: !!dna.layers.original
    });

    const client = await this.postgresPool.connect();

    try {
      await client.query('BEGIN');

      // Store DNA metadata in PostgreSQL
      await client.query(`
        INSERT INTO graphrag.document_dna (
          id,
          document_id,
          version,
          created_at,
          metadata
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (document_id)
        DO UPDATE SET
          version = $3,
          updated_at = CURRENT_TIMESTAMP,
          metadata = $5
      `, [
        dna.id,
        documentId,
        dna.version,
        dna.createdAt,
        JSON.stringify({
          ...metadata,
          layers: {
            semantic: !!dna.layers.semantic,
            structural: !!dna.layers.structural,
            original: true
          }
        })
      ]);

      // Store semantic embeddings in Qdrant
      if (dna.layers.semantic?.embeddings) {
        await this.qdrantClient.upsert('dna_semantic', {
          wait: true,
          points: [{
            id: `${documentId}_semantic`,
            vector: dna.layers.semantic.embeddings,
            payload: {
              document_id: documentId,
              layer_type: 'semantic',
              model: dna.layers.semantic.metadata.model,
              created_at: dna.createdAt
            }
          }]
        });
      }

      // Store structural embeddings in Qdrant
      if (dna.layers.structural?.embeddings) {
        await this.qdrantClient.upsert('dna_structural', {
          wait: true,
          points: [{
            id: `${documentId}_structural`,
            vector: dna.layers.structural.embeddings,
            payload: {
              document_id: documentId,
              layer_type: 'structural',
              model: dna.layers.structural.metadata.model,
              layout: dna.layers.structural.layout,
              created_at: dna.createdAt
            }
          }]
        });
      }

      // Store original content in PostgreSQL
      if (dna.layers.original?.content) {
        await client.query(`
          INSERT INTO graphrag.document_originals (
            document_id,
            content,
            format,
            metadata,
            created_at
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (document_id)
          DO UPDATE SET
            content = $2,
            format = $3,
            metadata = $4,
            updated_at = CURRENT_TIMESTAMP
        `, [
          documentId,
          dna.layers.original.content,
          dna.layers.original.metadata.format,
          JSON.stringify(dna.layers.original.metadata),
          dna.createdAt
        ]);
      }

      // Store cross-references in Neo4j
      if (dna.crossReferences && dna.crossReferences.length > 0) {
        const session = this.neo4jDriver.session();
        try {
          for (const ref of dna.crossReferences) {
            await session.run(`
              MATCH (source:DocumentLayer {id: $sourceId, document_id: $documentId})
              MATCH (target:DocumentLayer {id: $targetId, document_id: $documentId})
              MERGE (source)-[r:${ref.type.toUpperCase()}]->(target)
              SET r.confidence = $confidence
            `, {
              sourceId: ref.sourceId,
              targetId: ref.targetId,
              documentId,
              confidence: ref.confidence
            });
          }
        } finally {
          await session.close();
        }
      }

      await client.query('COMMIT');

      const processingTime = Date.now() - startTime;

      logger.info('Document DNA stored successfully', {
        documentId,
        processingTime,
        semanticStored: !!dna.layers.semantic,
        structuralStored: !!dna.layers.structural
      });

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to store Document DNA', {
        documentId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieve Document DNA by document ID
   */
  async getDocumentDNA(documentId: string): Promise<DocumentDNA | null> {
    const client = await this.postgresPool.connect();

    try {
      // Get DNA metadata
      const dnaResult = await client.query(`
        SELECT * FROM graphrag.document_dna
        WHERE document_id = $1
      `, [documentId]);

      if (dnaResult.rows.length === 0) {
        return null;
      }

      const dnaRow = dnaResult.rows[0];

      // Get semantic embeddings from Qdrant
      let semanticLayer;
      try {
        const semanticPoints = await this.qdrantClient.retrieve('dna_semantic', {
          ids: [`${documentId}_semantic`],
          with_vector: true,
          with_payload: true
        });

        if (semanticPoints.length > 0) {
          semanticLayer = {
            type: 'semantic' as const,
            embeddings: semanticPoints[0].vector,
            metadata: semanticPoints[0].payload
          };
        }
      } catch (error) {
        logger.warn('Failed to retrieve semantic layer', { documentId, error });
      }

      // Get structural embeddings from Qdrant
      let structuralLayer;
      try {
        const structuralPoints = await this.qdrantClient.retrieve('dna_structural', {
          ids: [`${documentId}_structural`],
          with_vector: true,
          with_payload: true
        });

        if (structuralPoints.length > 0) {
          structuralLayer = {
            type: 'structural' as const,
            embeddings: structuralPoints[0].vector,
            layout: structuralPoints[0].payload?.layout,
            metadata: structuralPoints[0].payload
          };
        }
      } catch (error) {
        logger.warn('Failed to retrieve structural layer', { documentId, error });
      }

      // Get original content
      const originalResult = await client.query(`
        SELECT * FROM graphrag.document_originals
        WHERE document_id = $1
      `, [documentId]);

      const originalLayer = originalResult.rows.length > 0 ? {
        type: 'original' as const,
        content: originalResult.rows[0].content,
        metadata: originalResult.rows[0].metadata
      } : undefined;

      return {
        id: dnaRow.id,
        documentId,
        layers: {
          semantic: semanticLayer,
          structural: structuralLayer,
          original: originalLayer!
        },
        createdAt: dnaRow.created_at,
        updatedAt: dnaRow.updated_at,
        version: dnaRow.version
      } as DocumentDNA;

    } finally {
      client.release();
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down storage engine');

    await this.postgresPool.end();
    await this.neo4jDriver.close();
    await this.redisClient.quit();
  }
}
