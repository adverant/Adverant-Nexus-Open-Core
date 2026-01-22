/**
 * OCR Cascade Implementation
 *
 * Three-tier OCR cascade that automatically escalates to higher-quality
 * (and more expensive) models based on confidence scores:
 *
 * Tier 1: Tesseract.js (Free, Fast) - Local OCR for standard documents
 * Tier 2: GPT-4o Vision ($0.15-0.30/1K) - OpenRouter vision model
 * Tier 3: Qwen2.5-VL-72B ($0.40/1K) - Premium vision model for complex layouts
 *
 * Leverages GraphRAG's existing OpenRouterModelSelector for intelligent
 * model selection and fallback chains.
 */

import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { logger } from '../../utils/logger';
import { OpenRouterModelSelector } from '../../clients/openrouter-model-selector';
import { OCROptions, OCRResult, LayoutElement } from '../../types/document-dna';

export interface OCRTierResult {
  text: string;
  confidence: number;
  tier: 'tesseract' | 'gpt-4o' | 'qwen-vl';
  cost: number;
  processingTime: number;
}

export class OCRCascade {
  private openRouterSelector: OpenRouterModelSelector;
  private confidenceThreshold: number;
  private tesseractWorker?: Tesseract.Worker;

  constructor(
    openRouterSelector: OpenRouterModelSelector,
    confidenceThreshold = 0.85
  ) {
    this.openRouterSelector = openRouterSelector;
    this.confidenceThreshold = confidenceThreshold;
  }

  /**
   * Process image through OCR cascade
   */
  async process(
    content: string | Buffer,
    options: OCROptions
  ): Promise<OCRResult> {
    const startTime = Date.now();

    logger.info('Starting OCR cascade', { tier: options.tier });

    // Prepare image buffer
    const imageBuffer = await this.prepareImage(content);

    let result: OCRTierResult;

    if (options.tier === 'fast' || options.tier === 'auto') {
      // Start with Tier 1: Tesseract
      result = await this.runTesseract(imageBuffer);

      // Check if we need to escalate
      if (options.tier === 'auto' && result.confidence < this.confidenceThreshold) {
        logger.info('Tesseract confidence low, escalating to GPT-4o', {
          confidence: result.confidence,
          threshold: this.confidenceThreshold
        });

        // Tier 2: GPT-4o
        const tier2Result = await this.runGPT4Vision(imageBuffer, options);

        if (tier2Result.confidence > result.confidence) {
          result = tier2Result;
        }

        // Check if we need premium tier
        if (result.confidence < this.confidenceThreshold && (!options.budget || options.budget > 0.40)) {
          logger.info('GPT-4o confidence still low, escalating to Qwen-VL', {
            confidence: result.confidence,
            threshold: this.confidenceThreshold
          });

          // Tier 3: Qwen2.5-VL
          const tier3Result = await this.runQwenVL(imageBuffer, options);

          if (tier3Result.confidence > result.confidence) {
            result = tier3Result;
          }
        }
      }
    } else if (options.tier === 'quality') {
      // Start directly with GPT-4o
      result = await this.runGPT4Vision(imageBuffer, options);
    } else if (options.tier === 'premium') {
      // Start directly with Qwen-VL
      result = await this.runQwenVL(imageBuffer, options);
    } else {
      // Default to Tesseract for 'fast'
      result = await this.runTesseract(imageBuffer);
    }

    // Extract layout if requested
    let layout: LayoutElement[] | undefined;
    if (options.preserveLayout && result.tier !== 'tesseract') {
      layout = await this.extractLayout(result.text, imageBuffer);
    }

    const processingTime = Date.now() - startTime;

    logger.info('OCR cascade completed', {
      tier: result.tier,
      confidence: result.confidence,
      cost: result.cost,
      processingTime
    });

    return {
      text: result.text,
      confidence: result.confidence,
      tier: result.tier,
      layout,
      metadata: {
        processingTime,
        cost: result.cost,
        imageSize: imageBuffer.length,
        language: options.language || 'eng'
      }
    };
  }

  /**
   * Tier 1: Run Tesseract.js (free, local)
   */
  private async runTesseract(imageBuffer: Buffer): Promise<OCRTierResult> {
    const startTime = Date.now();

    try {
      // Initialize worker if not already done
      if (!this.tesseractWorker) {
        this.tesseractWorker = await Tesseract.createWorker('eng');
      }

      // Run OCR
      const result = await this.tesseractWorker.recognize(imageBuffer);

      const processingTime = Date.now() - startTime;

      return {
        text: result.data.text,
        confidence: result.data.confidence / 100, // Convert to 0-1 scale
        tier: 'tesseract',
        cost: 0, // Free!
        processingTime
      };

    } catch (error) {
      logger.error('Tesseract OCR failed', { error });
      return {
        text: '',
        confidence: 0,
        tier: 'tesseract',
        cost: 0,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Tier 2: Run GPT-4o vision model via OpenRouter
   */
  private async runGPT4Vision(
    imageBuffer: Buffer,
    _options: OCROptions
  ): Promise<OCRTierResult> {
    const startTime = Date.now();

    try {
      // Select best vision model (GPT-4o or equivalent)
      const models = await this.openRouterSelector.selectModelChain({
        taskType: 'vision',
        maxCostPerMillion: 300 // $0.30 per 1K tokens
      }, 1);

      const model = models[0];

      if (!model) {
        throw new Error('No vision model available within budget');
      }

      logger.info('Using vision model for OCR', { model: model.id });

      // Convert image to base64
      const base64Image = imageBuffer.toString('base64');

      // Make OpenRouter API call
      const response = await this.callOpenRouterVision(
        model.id,
        base64Image,
        'Extract all text from this image. Preserve the layout and formatting as much as possible. Include all tables, headers, and text elements.'
      );

      const processingTime = Date.now() - startTime;

      // Estimate cost based on token usage
      const estimatedTokens = Math.ceil(response.text.length / 4) + 500; // Input tokens
      const costPerMillion = model.pricing?.prompt || 0.15;
      const cost = (estimatedTokens / 1000000) * costPerMillion;

      return {
        text: response.text,
        confidence: response.confidence || 0.90, // GPT-4o typically has high confidence
        tier: 'gpt-4o',
        cost,
        processingTime
      };

    } catch (error) {
      logger.error('GPT-4 Vision OCR failed', { error });
      return {
        text: '',
        confidence: 0,
        tier: 'gpt-4o',
        cost: 0,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Tier 3: Run Qwen2.5-VL-72B for premium quality
   */
  private async runQwenVL(
    imageBuffer: Buffer,
    _options: OCROptions
  ): Promise<OCRTierResult> {
    const startTime = Date.now();

    try {
      // Find Qwen-VL model specifically
      const models = await this.openRouterSelector.selectModelChain({
        taskType: 'vision'
      }, 5);

      const qwenModel = models.find((m: any) =>
        m.id.toLowerCase().includes('qwen') && m.id.toLowerCase().includes('vl')
      ) || models[0]; // Fallback to best available

      logger.info('Using premium vision model for OCR', { model: qwenModel.id });

      // Convert image to base64
      const base64Image = imageBuffer.toString('base64');

      // Premium prompt for maximum quality
      const response = await this.callOpenRouterVision(
        qwenModel.id,
        base64Image,
        `Extract ALL text from this image with maximum accuracy.
        Requirements:
        1. Preserve exact layout and formatting
        2. Accurately extract all tables with proper column alignment
        3. Identify and preserve headers, subheaders, and text hierarchy
        4. Extract figure captions and labels
        5. Maintain paragraph boundaries
        6. Include any footnotes or side notes
        Output the complete text with layout preserved.`
      );

      const processingTime = Date.now() - startTime;

      // Estimate cost for premium tier
      const estimatedTokens = Math.ceil(response.text.length / 4) + 1000;
      const costPerMillion = qwenModel.pricing?.prompt || 0.40;
      const cost = (estimatedTokens / 1000000) * costPerMillion;

      return {
        text: response.text,
        confidence: response.confidence || 0.95, // Premium models have highest confidence
        tier: 'qwen-vl',
        cost,
        processingTime
      };

    } catch (error) {
      logger.error('Qwen-VL OCR failed', { error });
      return {
        text: '',
        confidence: 0,
        tier: 'qwen-vl',
        cost: 0,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Call OpenRouter vision API
   */
  private async callOpenRouterVision(
    modelId: string,
    base64Image: string,
    prompt: string
  ): Promise<{ text: string; confidence?: number }> {
    const axios = (await import('axios')).default;

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: modelId,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        temperature: 0.1, // Low temperature for accuracy
        max_tokens: 4096
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const text = response.data.choices[0]?.message?.content || '';

    // Simple confidence estimation based on response quality
    const confidence = this.estimateConfidence(text);

    return { text, confidence };
  }

  /**
   * Prepare image for OCR (resize, enhance, etc.)
   */
  private async prepareImage(content: string | Buffer): Promise<Buffer> {
    let buffer: Buffer;

    if (typeof content === 'string') {
      // Assume it's a base64 string or file path
      if (content.startsWith('data:image')) {
        // Extract base64 data
        const base64Data = content.split(',')[1];
        buffer = Buffer.from(base64Data, 'base64');
      } else {
        // Treat as file path
        const fs = await import('fs');
        buffer = await fs.promises.readFile(content);
      }
    } else {
      buffer = content;
    }

    // Enhance image for better OCR
    try {
      const enhanced = await sharp(buffer)
        .grayscale() // Convert to grayscale
        .normalize() // Enhance contrast
        .sharpen() // Sharpen text
        .toBuffer();

      return enhanced;
    } catch (error) {
      logger.warn('Image enhancement failed, using original', { error });
      return buffer;
    }
  }

  /**
   * Extract layout structure from OCR text
   */
  private async extractLayout(text: string, _imageBuffer: Buffer): Promise<LayoutElement[]> {
    // Basic layout extraction from text structure
    const lines = text.split('\n');
    const elements: LayoutElement[] = [];

    for (const line of lines) {
      if (line.trim()) {
        // Detect headers (simple heuristic)
        if (line.length < 50 && line === line.toUpperCase()) {
          elements.push({
            type: 'header',
            content: line,
            level: 1
          });
        }
        // Detect tables (lines with multiple tabs or pipes)
        else if (line.includes('\t\t') || line.includes('|')) {
          elements.push({
            type: 'table',
            content: line
          });
        }
        // Regular paragraph
        else {
          elements.push({
            type: 'paragraph',
            content: line
          });
        }
      }
    }

    return elements;
  }

  /**
   * Estimate confidence based on text quality indicators
   */
  private estimateConfidence(text: string): number {
    if (!text || text.length < 10) return 0;

    let score = 0.5; // Base score

    // Check for common OCR errors
    const gibberishPattern = /[^\x00-\x7F]{5,}/g; // Non-ASCII sequences
    const repeatedChars = /(.)\1{5,}/g; // Repeated characters

    if (!gibberishPattern.test(text)) score += 0.2;
    if (!repeatedChars.test(text)) score += 0.1;

    // Check for proper word boundaries
    const words = text.split(/\s+/);
    const validWords = words.filter(w => w.length > 1 && w.length < 20);
    const wordRatio = validWords.length / words.length;

    score += wordRatio * 0.2;

    return Math.min(score, 1.0);
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.tesseractWorker) {
      await this.tesseractWorker.terminate();
      this.tesseractWorker = undefined;
    }
  }
}

export default OCRCascade;