/**
 * AI Document Service
 *
 * Provides AI-powered features for the Universal Document Viewer:
 * - Document summarization (full or section-based)
 * - Text explanation in document context
 * - Question answering with RAG
 * - Content extraction from unknown formats
 *
 * Uses OpenRouter for LLM access and Qdrant for RAG retrieval.
 */

import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { logger } from '../utils/logger';
import { OpenRouterModelSelector, ModelSelectionCriteria } from '../clients/openrouter-model-selector';
import { VoyageAIClient } from '../clients/voyage-ai-unified-client';
import type {
  AIDocumentSummary,
  AIDocumentExplanation,
  AIDocumentQuestion,
  AITextExtraction,
} from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface AIDocumentServiceConfig {
  postgresPool: Pool;
  qdrantClient: QdrantClient;
  voyageClient: VoyageAIClient;
  openRouterApiKey: string;
  redisCache?: any;
}

interface SummarizeOptions {
  scope: 'full' | 'section';
  sectionId?: string;
  length?: 'brief' | 'detailed';
}

interface ExplainOptions {
  context?: 'simplify' | 'expand' | 'technical';
}

interface AskOptions {
  includeRelated?: boolean;
  maxChunks?: number;
}

interface ExtractOptions {
  format?: 'text';
  method?: 'auto' | 'llm';
}

// ============================================================================
// SERVICE
// ============================================================================

export class AIDocumentService {
  private postgresPool: Pool;
  private qdrantClient: QdrantClient;
  private voyageClient: VoyageAIClient;
  private openRouterSelector: OpenRouterModelSelector;
  private httpClient: AxiosInstance;
  private redisCache?: any;

  private readonly SUMMARY_CACHE_TTL = 3600; // 1 hour
  private readonly QDRANT_COLLECTION = 'document_chunks';

  constructor(config: AIDocumentServiceConfig) {
    this.postgresPool = config.postgresPool;
    this.qdrantClient = config.qdrantClient;
    this.voyageClient = config.voyageClient;
    this.redisCache = config.redisCache;

    if (!config.openRouterApiKey) {
      throw new Error('OpenRouter API key is required for AI document features');
    }

    // Initialize OpenRouter model selector
    this.openRouterSelector = new OpenRouterModelSelector(config.openRouterApiKey);

    // Initialize HTTP client for OpenRouter API
    this.httpClient = axios.create({
      baseURL: 'https://openrouter.ai/api/v1',
      timeout: 120000, // 2 minute timeout for long LLM calls
      headers: {
        'Authorization': `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://api.adverant.ai',
        'X-Title': 'Nexus GraphRAG - AI Document Service'
      }
    });

    logger.info('AI Document Service initialized');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC METHODS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Summarize a document (full or section)
   */
  async summarizeDocument(
    documentId: string,
    tenantId: string,
    options: SummarizeOptions = { scope: 'full', length: 'detailed' }
  ): Promise<AIDocumentSummary> {
    try {
      logger.info('Summarizing document', { documentId, tenantId, options });

      // Check cache first
      const cacheKey = `ai:summary:${documentId}:${options.scope}:${options.sectionId || 'full'}:${options.length}`;
      if (this.redisCache) {
        const cached = await this.getCachedResult<AIDocumentSummary>(cacheKey);
        if (cached) {
          logger.debug('Using cached summary', { documentId, cacheKey });
          return cached;
        }
      }

      // Fetch document content
      const content = await this.getDocumentContent(documentId, tenantId, options);

      // Check if summary already exists in metadata
      if (options.scope === 'full' && options.length === 'detailed') {
        const existingSummary = await this.getExistingSummary(documentId, tenantId);
        if (existingSummary) {
          logger.debug('Using existing document summary', { documentId });
          return existingSummary;
        }
      }

      // Generate summary using LLM
      const model = await this.openRouterSelector.selectBestModel({
        task: 'general',
        minContextLength: 32000,
        preferredProviders: ['anthropic', 'openai']
      });

      const prompt = this.buildSummaryPrompt(content, options);
      const summary = await this.callLLM(model.id, prompt, {
        temperature: 0.3,
        maxTokens: options.length === 'brief' ? 500 : 2000
      });

      const result: AIDocumentSummary = {
        summary: summary.text,
        keyPoints: summary.keyPoints || [],
        topics: summary.topics || [],
        confidence: 0.9,
        model: model.id,
        generatedAt: new Date().toISOString()
      };

      // Cache the result
      if (this.redisCache) {
        await this.cacheResult(cacheKey, result, this.SUMMARY_CACHE_TTL);
      }

      // Store summary in database if it's a full document summary
      if (options.scope === 'full') {
        await this.storeSummary(documentId, tenantId, result);
      }

      logger.info('Document summarized successfully', {
        documentId,
        keyPointsCount: result.keyPoints.length,
        model: model.id
      });

      return result;
    } catch (error) {
      logger.error('Failed to summarize document', { error, documentId, tenantId });
      throw new Error(`Document summarization failed: ${error.message}`);
    }
  }

  /**
   * Explain selected text in document context
   */
  async explainText(
    documentId: string,
    tenantId: string,
    text: string,
    options: ExplainOptions = {}
  ): Promise<AIDocumentExplanation> {
    try {
      logger.info('Explaining text', { documentId, tenantId, textLength: text.length, options });

      // Get document context
      const docMetadata = await this.getDocumentMetadata(documentId, tenantId);

      // Select model based on context requirement
      const model = await this.openRouterSelector.selectBestModel({
        task: options.context === 'technical' ? 'code' : 'general',
        minContextLength: 16000,
        preferredProviders: ['anthropic', 'openai']
      });

      // Build explanation prompt
      const prompt = this.buildExplainPrompt(text, docMetadata, options);

      // Call LLM
      const response = await this.callLLM(model.id, prompt, {
        temperature: 0.5,
        maxTokens: 1000
      });

      const result: AIDocumentExplanation = {
        explanation: response.text,
        relatedConcepts: response.relatedConcepts || [],
        sources: response.sources || [],
        confidence: 0.85
      };

      logger.info('Text explained successfully', { documentId, conceptsCount: result.relatedConcepts.length });

      return result;
    } catch (error) {
      logger.error('Failed to explain text', { error, documentId, tenantId });
      throw new Error(`Text explanation failed: ${error.message}`);
    }
  }

  /**
   * Answer questions about a document using RAG
   */
  async askQuestion(
    documentId: string,
    tenantId: string,
    question: string,
    options: AskOptions = {}
  ): Promise<AIDocumentQuestion> {
    try {
      logger.info('Answering question', { documentId, tenantId, question, options });

      // Retrieve relevant chunks using RAG
      const relevantChunks = await this.retrieveRelevantChunks(
        question,
        documentId,
        tenantId,
        options
      );

      if (relevantChunks.length === 0) {
        logger.warn('No relevant chunks found for question', { documentId, question });
        return {
          question,
          answer: 'I could not find relevant information in the document to answer this question.',
          confidence: 0.1,
          sources: []
        };
      }

      // Select model for question answering
      const model = await this.openRouterSelector.selectBestModel({
        task: 'general',
        minContextLength: 32000,
        preferredProviders: ['anthropic', 'openai']
      });

      // Build RAG prompt with retrieved chunks
      const prompt = this.buildRAGPrompt(question, relevantChunks);

      // Call LLM
      const response = await this.callLLM(model.id, prompt, {
        temperature: 0.3,
        maxTokens: 1500
      });

      // Calculate confidence based on chunk relevance
      const avgRelevance = relevantChunks.reduce((sum, chunk) => sum + chunk.relevance, 0) / relevantChunks.length;

      const result: AIDocumentQuestion = {
        question,
        answer: response.text,
        confidence: avgRelevance,
        sources: relevantChunks.map(chunk => ({
          chunkId: chunk.id,
          pageNumber: chunk.pageNumber,
          relevance: chunk.relevance
        }))
      };

      logger.info('Question answered successfully', {
        documentId,
        sourcesCount: result.sources.length,
        confidence: result.confidence
      });

      return result;
    } catch (error) {
      logger.error('Failed to answer question', { error, documentId, tenantId, question });
      throw new Error(`Question answering failed: ${error.message}`);
    }
  }

  /**
   * Extract text content from unknown/binary file types using LLM
   */
  async extractContent(
    documentId: string,
    tenantId: string,
    options: ExtractOptions = {}
  ): Promise<AITextExtraction> {
    try {
      logger.info('Extracting content from unknown format', { documentId, tenantId, options });

      // Get binary content
      const binaryContent = await this.getBinaryContent(documentId, tenantId);

      // Convert to base64 for LLM
      const base64Content = binaryContent.toString('base64');

      // Check if content is too large
      if (base64Content.length > 100000) {
        throw new Error('Document too large for AI extraction (>100KB base64)');
      }

      // Select vision-capable model if available
      const model = await this.openRouterSelector.selectBestModel({
        task: 'vision',
        requiresVision: true,
        minContextLength: 32000,
        preferredProviders: ['anthropic', 'openai']
      });

      // Build extraction prompt
      const prompt = this.buildExtractionPrompt(base64Content);

      // Call LLM with vision capabilities
      const response = await this.callLLM(model.id, prompt, {
        temperature: 0.1,
        maxTokens: 4000,
        includeImage: true
      });

      const result: AITextExtraction = {
        extractedText: response.text,
        confidence: response.confidence || 0.7,
        method: 'llm',
        metadata: {
          model: model.id,
          base64Length: base64Content.length,
          extractedAt: new Date().toISOString()
        }
      };

      logger.info('Content extracted successfully', {
        documentId,
        extractedLength: result.extractedText.length,
        confidence: result.confidence
      });

      return result;
    } catch (error) {
      logger.error('Failed to extract content', { error, documentId, tenantId });
      throw new Error(`Content extraction failed: ${error.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPER METHODS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get document content for summarization
   */
  private async getDocumentContent(
    documentId: string,
    tenantId: string,
    options: SummarizeOptions
  ): Promise<string> {
    if (options.scope === 'section' && options.sectionId) {
      // Get specific section content
      const result = await this.postgresPool.query(
        `SELECT content
         FROM graphrag.document_chunks
         WHERE document_id = $1 AND id = $2`,
        [documentId, options.sectionId]
      );

      if (result.rows.length === 0) {
        throw new Error(`Section not found: ${options.sectionId}`);
      }

      return result.rows[0].content;
    }

    // Get full document content
    const result = await this.postgresPool.query(
      `SELECT content, metadata
       FROM graphrag.documents
       WHERE id = $1 AND tenant_id = $2`,
      [documentId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Document not found: ${documentId}`);
    }

    return result.rows[0].content;
  }

  /**
   * Check if document already has a summary
   */
  private async getExistingSummary(
    documentId: string,
    tenantId: string
  ): Promise<AIDocumentSummary | null> {
    const result = await this.postgresPool.query(
      `SELECT summary, metadata
       FROM graphrag.documents
       WHERE id = $1 AND tenant_id = $2`,
      [documentId, tenantId]
    );

    if (result.rows.length === 0 || !result.rows[0].summary) {
      return null;
    }

    const metadata = result.rows[0].metadata || {};
    return {
      summary: result.rows[0].summary,
      keyPoints: metadata.keyPoints || [],
      topics: metadata.topics || [],
      confidence: 0.9,
      model: metadata.summaryModel || 'unknown',
      generatedAt: metadata.summaryGeneratedAt || new Date().toISOString()
    };
  }

  /**
   * Get document metadata for context
   */
  private async getDocumentMetadata(documentId: string, tenantId: string): Promise<any> {
    const result = await this.postgresPool.query(
      `SELECT metadata FROM graphrag.documents WHERE id = $1 AND tenant_id = $2`,
      [documentId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Document not found: ${documentId}`);
    }

    return result.rows[0].metadata || {};
  }

  /**
   * Retrieve relevant chunks using RAG
   */
  private async retrieveRelevantChunks(
    query: string,
    documentId: string,
    tenantId: string,
    options: AskOptions
  ): Promise<Array<{ id: string; content: string; relevance: number; pageNumber?: number }>> {
    try {
      // Generate query embedding
      const queryEmbedding = await this.voyageClient.embed([query], {
        model: 'voyage-3',
        inputType: 'query'
      });

      // Search in Qdrant
      const searchResult = await this.qdrantClient.search(this.QDRANT_COLLECTION, {
        vector: queryEmbedding[0],
        filter: {
          must: [
            { key: 'tenant_id', match: { value: tenantId } },
            { key: 'document_id', match: { value: documentId } }
          ]
        },
        limit: options.maxChunks || 5,
        with_payload: true
      });

      return searchResult.map(hit => ({
        id: hit.id as string,
        content: (hit.payload as any).content || '',
        relevance: hit.score,
        pageNumber: (hit.payload as any).page_number
      }));
    } catch (error) {
      logger.error('Failed to retrieve relevant chunks', { error, documentId, query });
      return [];
    }
  }

  /**
   * Get binary content from database
   */
  private async getBinaryContent(documentId: string, tenantId: string): Promise<Buffer> {
    const result = await this.postgresPool.query(
      `SELECT content FROM graphrag.documents WHERE id = $1 AND tenant_id = $2`,
      [documentId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Document not found: ${documentId}`);
    }

    return Buffer.from(result.rows[0].content, 'base64');
  }

  /**
   * Store summary in database
   */
  private async storeSummary(
    documentId: string,
    tenantId: string,
    summary: AIDocumentSummary
  ): Promise<void> {
    await this.postgresPool.query(
      `UPDATE graphrag.documents
       SET summary = $1,
           metadata = metadata || jsonb_build_object(
             'keyPoints', $2::jsonb,
             'topics', $3::jsonb,
             'summaryModel', $4,
             'summaryGeneratedAt', $5
           )
       WHERE id = $6 AND tenant_id = $7`,
      [
        summary.summary,
        JSON.stringify(summary.keyPoints),
        JSON.stringify(summary.topics),
        summary.model,
        summary.generatedAt,
        documentId,
        tenantId
      ]
    );
  }

  /**
   * Call OpenRouter LLM API
   */
  private async callLLM(
    modelId: string,
    prompt: string,
    options: {
      temperature?: number;
      maxTokens?: number;
      includeImage?: boolean;
    } = {}
  ): Promise<any> {
    try {
      const messages: any[] = [
        {
          role: 'user',
          content: prompt
        }
      ];

      const request = {
        model: modelId,
        messages,
        temperature: options.temperature || 0.5,
        max_tokens: options.maxTokens || 1000,
        response_format: { type: 'json_object' }
      };

      logger.debug('Calling LLM', { model: modelId, promptLength: prompt.length });

      const response = await this.httpClient.post('/chat/completions', request);

      const messageContent = response.data?.choices?.[0]?.message?.content;
      if (!messageContent) {
        throw new Error('Empty response from LLM');
      }

      // Parse JSON response
      const parsed = JSON.parse(messageContent);

      return parsed;
    } catch (error) {
      logger.error('LLM call failed', { error, modelId });
      throw new Error(`LLM call failed: ${error.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PROMPT BUILDERS
  // ──────────────────────────────────────────────────────────────────────────

  private buildSummaryPrompt(content: string, options: SummarizeOptions): string {
    const lengthInstruction = options.length === 'brief'
      ? 'Provide a brief summary (2-3 sentences) and 3-5 key points.'
      : 'Provide a detailed summary (5-7 sentences) and 5-10 key points.';

    const scopeInstruction = options.scope === 'section'
      ? 'Summarize this section of the document:'
      : 'Summarize this entire document:';

    return `${scopeInstruction}

${lengthInstruction}

Document content:
${content.substring(0, 15000)}

Return JSON in this format:
{
  "text": "your summary here",
  "keyPoints": ["point 1", "point 2", ...],
  "topics": ["topic1", "topic2", ...]
}`;
  }

  private buildExplainPrompt(text: string, docMetadata: any, options: ExplainOptions): string {
    let contextInstruction = '';

    if (options.context === 'simplify') {
      contextInstruction = 'Explain this text in simple, easy-to-understand language suitable for a general audience.';
    } else if (options.context === 'expand') {
      contextInstruction = 'Provide an expanded explanation with additional context and examples.';
    } else if (options.context === 'technical') {
      contextInstruction = 'Provide a technical, detailed explanation with precise terminology.';
    } else {
      contextInstruction = 'Explain this text clearly and comprehensively.';
    }

    return `${contextInstruction}

Document context: ${docMetadata.title || 'Unknown'} (${docMetadata.type || 'Unknown type'})

Text to explain:
"${text}"

Return JSON in this format:
{
  "text": "your explanation here",
  "relatedConcepts": ["concept1", "concept2", ...],
  "sources": ["reference1", "reference2", ...]
}`;
  }

  private buildRAGPrompt(question: string, chunks: any[]): string {
    const context = chunks
      .map((chunk, idx) => `[Chunk ${idx + 1}] ${chunk.content}`)
      .join('\n\n');

    return `Answer the following question based ONLY on the provided document chunks. If the answer cannot be found in the chunks, say so.

Question: ${question}

Document chunks:
${context}

Return JSON in this format:
{
  "text": "your answer here",
  "confidence": 0.0-1.0
}`;
  }

  private buildExtractionPrompt(base64Content: string): string {
    return `Extract all readable text content from this document image or binary file.
Preserve the structure and formatting as much as possible.

Return JSON in this format:
{
  "text": "extracted text content here",
  "confidence": 0.0-1.0
}`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CACHE HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  private async getCachedResult<T>(key: string): Promise<T | null> {
    if (!this.redisCache) return null;

    try {
      const cached = await this.redisCache.get(key);
      if (cached) {
        return JSON.parse(cached) as T;
      }
    } catch (error) {
      logger.warn('Cache get failed', { error, key });
    }
    return null;
  }

  private async cacheResult<T>(key: string, value: T, ttl: number): Promise<void> {
    if (!this.redisCache) return;

    try {
      await this.redisCache.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      logger.warn('Cache set failed', { error, key });
    }
  }
}
