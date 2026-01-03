/**
 * Document Classifier
 *
 * Classifies documents to determine the best processing strategy.
 * Uses heuristics and optional AI model classification.
 */

import { logger } from '../../utils/logger';
import { OpenRouterModelSelector } from '../../clients/openrouter-model-selector';
import { DocumentFormat } from '../../types/document-dna';

export interface DocumentClassification {
  format: DocumentFormat;
  isScanned: boolean;
  hasImages: boolean;
  hasTables: boolean;
  hasComplexLayout: boolean;
  hasEquations: boolean;
  confidence: number;
  metadata: Record<string, any>;
}

export class DocumentClassifier {
  private openRouterSelector?: OpenRouterModelSelector;

  constructor(openRouterSelector?: OpenRouterModelSelector) {
    this.openRouterSelector = openRouterSelector;
  }

  /**
   * Classify document content
   */
  async classify(content: string | Buffer): Promise<DocumentClassification> {
    const startTime = Date.now();

    try {
      // Step 1: Detect format
      const format = this.detectFormat(content);

      // Step 2: Analyze content characteristics
      const characteristics = await this.analyzeCharacteristics(content, format);

      // Step 3: Optional AI-based classification for complex cases
      let aiClassification;
      if (this.openRouterSelector && characteristics.needsAIClassification) {
        aiClassification = await this.classifyWithAI(content, format);
      }

      // Merge results
      const classification: DocumentClassification = {
        format,
        isScanned: characteristics.isScanned || aiClassification?.isScanned || false,
        hasImages: characteristics.hasImages || aiClassification?.hasImages || false,
        hasTables: characteristics.hasTables || aiClassification?.hasTables || false,
        hasComplexLayout: characteristics.hasComplexLayout || aiClassification?.hasComplexLayout || false,
        hasEquations: characteristics.hasEquations || aiClassification?.hasEquations || false,
        confidence: aiClassification?.confidence || characteristics.confidence,
        metadata: {
          processingTime: Date.now() - startTime,
          usedAI: !!aiClassification,
          ...characteristics.metadata,
          ...aiClassification?.metadata
        }
      };

      logger.info('Document classified', { classification });

      return classification;

    } catch (error) {
      logger.error('Document classification failed', { error });

      // Return basic classification on error
      return {
        format: 'unknown',
        isScanned: false,
        hasImages: false,
        hasTables: false,
        hasComplexLayout: false,
        hasEquations: false,
        confidence: 0,
        metadata: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  /**
   * Detect document format
   */
  private detectFormat(content: string | Buffer): DocumentFormat {
    // Check if it's a Buffer (binary content)
    if (Buffer.isBuffer(content)) {
      // Check magic bytes for common formats
      const magic = content.slice(0, 8).toString('hex');

      if (magic.startsWith('255044462d')) return 'pdf'; // %PDF-
      if (magic.startsWith('504b0304')) return 'docx'; // PK.. (ZIP)
      if (magic.startsWith('d0cf11e0')) return 'docx'; // Old Office
      if (magic.startsWith('ffd8ff')) return 'jpg';
      if (magic.startsWith('89504e47')) return 'png';
      if (magic.startsWith('47494638')) return 'gif';
      if (magic.startsWith('49492a00') || magic.startsWith('4d4d002a')) return 'tiff';

      return 'unknown';
    }

    // String content - check for text formats
    const str = content.toString().slice(0, 1000); // Check first 1000 chars

    if (str.startsWith('<?xml')) return 'xml';
    if (str.startsWith('<!DOCTYPE html') || str.startsWith('<html')) return 'html';
    if (str.startsWith('{\\rtf')) return 'rtf';
    if (str.includes('\\documentclass') || str.includes('\\begin{document}')) return 'txt'; // LaTeX

    // Check for markdown patterns
    if (str.includes('# ') || str.includes('## ') || str.includes('```')) return 'md';

    return 'txt';
  }

  /**
   * Analyze document characteristics using heuristics
   */
  private async analyzeCharacteristics(
    content: string | Buffer,
    format: DocumentFormat
  ): Promise<any> {
    const result = {
      isScanned: false,
      hasImages: false,
      hasTables: false,
      hasComplexLayout: false,
      hasEquations: false,
      confidence: 0.8,
      needsAIClassification: false,
      metadata: {} as { pageCount?: number; hasText?: boolean; [key: string]: any }
    };

    // Binary formats likely need AI classification
    if (Buffer.isBuffer(content)) {
      result.needsAIClassification = true;

      // PDF-specific checks
      if (format === 'pdf') {
        try {
          const pdfParse = require('pdf-parse');
          const data = await pdfParse(content);

          result.metadata.pageCount = data.numpages;
          result.metadata.hasText = data.text && data.text.trim().length > 0;

          // If PDF has no extractable text, it's likely scanned
          if (!result.metadata.hasText) {
            result.isScanned = true;
          }

          // Check for tables (simple heuristic)
          if (data.text) {
            result.hasTables = /\t|\|/.test(data.text) || data.text.includes('Table');
            result.hasEquations = /[∫∑∏√±≈≠≤≥]/.test(data.text);
          }

        } catch (error) {
          logger.warn('PDF analysis failed', { error });
        }
      }

      return result;
    }

    // Text format analysis
    const text = content.toString();

    // Check for images (markdown/HTML)
    result.hasImages = /!\[.*?\]\(.*?\)/.test(text) || // Markdown images
                      /<img\s+[^>]*src=/.test(text); // HTML images

    // Check for tables
    result.hasTables = /\|.*\|.*\|/.test(text) || // Markdown tables
                      /<table/.test(text) || // HTML tables
                      /\t.*\t.*\t/.test(text); // Tab-separated

    // Check for equations (LaTeX, MathML, Unicode math)
    result.hasEquations = /\$.*?\$/.test(text) || // LaTeX inline
                         /\\\[.*?\\\]/.test(text) || // LaTeX display
                         /<math/.test(text) || // MathML
                         /[∫∑∏√±≈≠≤≥]/.test(text); // Unicode math

    // Check for complex layout indicators
    const lines = text.split('\n');
    const hasShortLines = lines.filter(l => l.trim().length > 0 && l.trim().length < 40).length > lines.length * 0.3;
    const hasMultipleColumns = hasShortLines && lines.length > 50;
    const hasHeaders = /^#{1,6}\s/.test(text) || /<h[1-6]/.test(text);

    result.hasComplexLayout = hasMultipleColumns ||
                             (result.hasTables && result.hasImages) ||
                             (hasHeaders && result.hasTables);

    // Confidence based on format clarity
    if (format === 'unknown') {
      result.confidence = 0.5;
      result.needsAIClassification = true;
    }

    return result;
  }

  /**
   * Use AI model for advanced classification
   */
  private async classifyWithAI(
    content: string | Buffer,
    format: DocumentFormat
  ): Promise<Partial<DocumentClassification>> {
    if (!this.openRouterSelector) {
      return {};
    }

    try {
      // Select classification model
      const models = await this.openRouterSelector.selectModelChain({
        taskType: 'classification'
      }, 1);

      const model = models[0];
      if (!model) {
        return {};
      }

      // Prepare content sample
      let sample: string;
      if (Buffer.isBuffer(content)) {
        // For binary, use format and size info
        sample = `Binary ${format} document, size: ${content.length} bytes`;
      } else {
        // For text, use first 1000 characters
        sample = content.toString().slice(0, 1000);
      }

      // Call model for classification
      const prompt = `Analyze this document and classify its characteristics. Return JSON only:
{
  "isScanned": boolean,
  "hasImages": boolean,
  "hasTables": boolean,
  "hasComplexLayout": boolean,
  "hasEquations": boolean,
  "documentType": "technical|business|academic|general",
  "confidence": 0.0-1.0
}

Document format: ${format}
Sample content:
${sample}`;

      const response = await this.callClassificationModel(model.id, prompt);

      if (response) {
        return {
          ...response,
          metadata: { aiModel: model.id }
        };
      }

    } catch (error) {
      logger.warn('AI classification failed', { error });
    }

    return {};
  }

  /**
   * Call OpenRouter for classification
   */
  private async callClassificationModel(modelId: string, prompt: string): Promise<any> {
    try {
      const axios = (await import('axios')).default;

      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: modelId,
          messages: [
            {
              role: 'system',
              content: 'You are a document classification expert. Always respond with valid JSON only.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1,
          max_tokens: 500,
          response_format: { type: 'json_object' }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const content = response.data.choices[0]?.message?.content;
      if (content) {
        return JSON.parse(content);
      }

    } catch (error) {
      logger.error('Classification model call failed', { error });
    }

    return null;
  }
}

export default DocumentClassifier;