/**
 * Vision Analyzer Service for GOD-MODE Agent
 *
 * AI-powered vision analysis for autonomous browser automation:
 * - Screenshot analysis and element identification
 * - OCR-like text extraction from screenshots
 * - Change detection between screenshots
 * - AI-powered action suggestions based on visual context
 *
 * Cost Management Features:
 * - Tier-based daily call limits
 * - Screenshot caching with 5-second TTL
 * - Perceptual hashing for duplicate detection
 * - Usage tracking per user
 */

import { createHash } from 'crypto';
import { OpenRouterClient, CompletionResponse } from '../clients/openrouter-client';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  ValidationError,
  RateLimitError,
  ServiceUnavailableError,
} from '../utils/errors';

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Subscription tiers matching autonomous-loop.ts
 */
export type SubscriptionTier =
  | 'open_source'
  | 'shared_access'
  | 'teams'
  | 'dedicated_vps'
  | 'custom_install'
  | 'government'
  | 'admin';

/**
 * Tier-based vision API call limits per day
 */
export const TIER_VISION_LIMITS: Record<SubscriptionTier, number> = {
  open_source: 10,
  shared_access: 50,
  teams: 200,
  dedicated_vps: 500,
  custom_install: 500,
  government: 1000,
  admin: Infinity,
};

/**
 * Result of vision analysis
 */
export interface VisionAnalysisResult {
  /** Human-readable description of the page */
  description: string;
  /** Elements identified on the page */
  elements: IdentifiedElement[];
  /** Suggested next actions based on visual context */
  suggestedActions: SuggestedAction[];
  /** Overall confidence score (0-1) */
  confidence: number;
  /** Model used for analysis */
  modelUsed: string;
  /** Processing time in milliseconds */
  processingTime: number;
  /** Whether result was served from cache */
  fromCache: boolean;
}

/**
 * Identified element on the page
 */
export interface IdentifiedElement {
  /** Type of element (button, input, link, text, image, etc.) */
  type: 'button' | 'input' | 'link' | 'text' | 'image' | 'checkbox' | 'dropdown' | 'navigation' | 'form' | 'other';
  /** Description of the element */
  description: string;
  /** Text content if any */
  textContent?: string;
  /** Approximate location description */
  location: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  /** Confidence score for this element (0-1) */
  confidence: number;
}

/**
 * Suggested action based on visual analysis
 */
export interface SuggestedAction {
  /** Action type */
  action: 'click' | 'type' | 'scroll' | 'hover' | 'select' | 'wait' | 'navigate';
  /** Target element description */
  target: string;
  /** Value to input (for type/select actions) */
  value?: string;
  /** Reasoning for this suggestion */
  reasoning: string;
  /** Priority (1 = highest) */
  priority: number;
}

/**
 * Element location with coordinates
 */
export interface ElementLocation {
  /** Element description */
  description: string;
  /** Estimated bounding box */
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Center coordinates for clicking */
  center: {
    x: number;
    y: number;
  };
  /** Confidence score (0-1) */
  confidence: number;
  /** Alternative locations if multiple matches */
  alternatives?: Array<{
    boundingBox: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
}

/**
 * Screenshot comparison result
 */
export interface ScreenshotComparisonResult {
  /** Whether significant changes were detected */
  hasChanges: boolean;
  /** List of detected changes */
  changes: DetectedChange[];
  /** Similarity score (0-1, 1 = identical) */
  similarityScore: number;
  /** Summary of changes */
  summary: string;
  /** Model used for comparison */
  modelUsed: string;
  /** Processing time in milliseconds */
  processingTime: number;
}

/**
 * Individual detected change between screenshots
 */
export interface DetectedChange {
  /** Type of change */
  type: 'added' | 'removed' | 'modified' | 'moved';
  /** Description of what changed */
  description: string;
  /** Location on the page */
  location: string;
  /** Significance level */
  significance: 'high' | 'medium' | 'low';
}

/**
 * Vision quota status for a user
 */
export interface VisionQuotaStatus {
  /** User ID */
  userId: string;
  /** Subscription tier */
  tier: SubscriptionTier;
  /** Daily limit */
  dailyLimit: number;
  /** Calls used today */
  usedToday: number;
  /** Remaining calls */
  remaining: number;
  /** Reset time (UTC) */
  resetsAt: Date;
  /** Whether limit is reached */
  limitReached: boolean;
}

/**
 * Cached analysis entry
 */
interface CacheEntry {
  result: VisionAnalysisResult;
  timestamp: number;
  hash: string;
}

/**
 * User usage tracking
 */
interface UserUsage {
  userId: string;
  tier: SubscriptionTier;
  callsToday: number;
  lastReset: Date;
}

// ============================================================================
// Vision Analyzer Class
// ============================================================================

export class VisionAnalyzer {
  private openRouterClient: OpenRouterClient;

  /** Cache for screenshot analysis with 5-second TTL */
  private analysisCache: Map<string, CacheEntry> = new Map();

  /** User usage tracking */
  private userUsage: Map<string, UserUsage> = new Map();

  /** Cache TTL in milliseconds (5 seconds) */
  private readonly CACHE_TTL = 5000;

  /** Perceptual hash cache for duplicate detection */
  private hashCache: Map<string, string> = new Map();

  /** Primary vision model */
  private readonly PRIMARY_MODEL = 'anthropic/claude-opus-4.6';

  /** Fallback vision model (cost-effective) */
  private readonly FALLBACK_MODEL = 'openai/gpt-4o-mini';

  constructor(openRouterClient?: OpenRouterClient) {
    this.openRouterClient = openRouterClient || new OpenRouterClient(
      config.openRouter.apiKey,
      config.openRouter.baseUrl,
      { filterFreeModels: true }
    );

    logger.info('[VisionAnalyzer] Initialized', {
      primaryModel: this.PRIMARY_MODEL,
      fallbackModel: this.FALLBACK_MODEL,
      cacheTTL: this.CACHE_TTL,
    });

    // Start cache cleanup interval
    this.startCacheCleanup();
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Analyze a screenshot to describe the page, identify elements, and suggest actions
   */
  async analyzeScreenshot(
    base64Image: string,
    options: {
      prompt?: string;
      userId?: string;
      tier?: SubscriptionTier;
      skipCache?: boolean;
    } = {}
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();
    const { prompt, userId = 'anonymous', tier = 'open_source', skipCache = false } = options;

    logger.info('[VisionAnalyzer] Starting screenshot analysis', {
      userId,
      tier,
      imageSize: base64Image.length,
      hasPrompt: !!prompt,
    });

    // Check quota
    await this.enforceQuota(userId, tier);

    // Check cache (unless skipped)
    if (!skipCache) {
      const cachedResult = this.getCachedAnalysis(base64Image);
      if (cachedResult) {
        logger.info('[VisionAnalyzer] Returning cached result', { userId });
        return { ...cachedResult, fromCache: true };
      }
    }

    // Prepare image URL
    const imageUrl = this.prepareImageUrl(base64Image);

    // Build analysis prompt
    const analysisPrompt = this.buildAnalysisPrompt(prompt);

    try {
      // Try primary model first
      const response = await this.callVisionModel(
        this.PRIMARY_MODEL,
        imageUrl,
        analysisPrompt
      );

      const result = this.parseAnalysisResponse(response, this.PRIMARY_MODEL, startTime);

      // Cache result
      this.cacheAnalysis(base64Image, result);

      // Track usage
      this.trackUsage(userId, tier);

      logger.info('[VisionAnalyzer] Analysis complete', {
        userId,
        modelUsed: result.modelUsed,
        elementsFound: result.elements.length,
        suggestedActions: result.suggestedActions.length,
        processingTime: result.processingTime,
      });

      return result;
    } catch (primaryError) {
      logger.warn('[VisionAnalyzer] Primary model failed, trying fallback', {
        primaryModel: this.PRIMARY_MODEL,
        error: primaryError instanceof Error ? primaryError.message : String(primaryError),
      });

      try {
        // Try fallback model
        const response = await this.callVisionModel(
          this.FALLBACK_MODEL,
          imageUrl,
          analysisPrompt
        );

        const result = this.parseAnalysisResponse(response, this.FALLBACK_MODEL, startTime);

        // Cache result
        this.cacheAnalysis(base64Image, result);

        // Track usage
        this.trackUsage(userId, tier);

        return result;
      } catch (fallbackError) {
        logger.error('[VisionAnalyzer] All models failed', {
          primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
          fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });

        throw new ServiceUnavailableError(
          'Vision analysis failed: All models unavailable',
          {
            primaryModel: this.PRIMARY_MODEL,
            fallbackModel: this.FALLBACK_MODEL,
          },
          'Try again in a few moments'
        );
      }
    }
  }

  /**
   * Identify an element by natural language description and return its coordinates
   */
  async identifyElementByDescription(
    base64Image: string,
    description: string,
    options: {
      userId?: string;
      tier?: SubscriptionTier;
      imageWidth?: number;
      imageHeight?: number;
    } = {}
  ): Promise<ElementLocation> {
    const startTime = Date.now();
    const {
      userId = 'anonymous',
      tier = 'open_source',
      imageWidth = 1920,
      imageHeight = 1080,
    } = options;

    logger.info('[VisionAnalyzer] Identifying element', {
      userId,
      description,
      imageWidth,
      imageHeight,
    });

    // Check quota
    await this.enforceQuota(userId, tier);

    const imageUrl = this.prepareImageUrl(base64Image);

    const prompt = `You are a visual element detector. Your task is to locate a specific element in this screenshot.

**Target Element**: "${description}"

**Image Dimensions**: ${imageWidth}px x ${imageHeight}px

**Instructions**:
1. Find the element that best matches the description
2. Estimate its bounding box coordinates (x, y, width, height) in pixels
3. Coordinates start from top-left (0, 0)
4. Be as precise as possible based on visual inspection

**Response Format** (JSON only, no markdown):
{
  "found": true/false,
  "element": {
    "description": "what you found",
    "boundingBox": {
      "x": <number>,
      "y": <number>,
      "width": <number>,
      "height": <number>
    },
    "confidence": <0.0-1.0>
  },
  "alternatives": [
    {
      "description": "alternative match",
      "boundingBox": { "x": <n>, "y": <n>, "width": <n>, "height": <n> },
      "confidence": <0.0-1.0>
    }
  ]
}

If the element is not found, set "found": false and explain in "element.description".`;

    try {
      const response = await this.callVisionModel(this.PRIMARY_MODEL, imageUrl, prompt);
      const content = response.choices[0]?.message?.content || '{}';

      // Parse response
      const parsed = this.parseJsonResponse(content);

      if (!parsed.found || !parsed.element?.boundingBox) {
        throw new ValidationError(
          `Element not found: "${description}"`,
          { description, imageWidth, imageHeight }
        );
      }

      const bbox = parsed.element.boundingBox;

      // Track usage
      this.trackUsage(userId, tier);

      const result: ElementLocation = {
        description: parsed.element.description || description,
        boundingBox: {
          x: Math.round(bbox.x),
          y: Math.round(bbox.y),
          width: Math.round(bbox.width),
          height: Math.round(bbox.height),
        },
        center: {
          x: Math.round(bbox.x + bbox.width / 2),
          y: Math.round(bbox.y + bbox.height / 2),
        },
        confidence: parsed.element.confidence || 0.8,
        alternatives: parsed.alternatives?.map((alt: any) => ({
          boundingBox: {
            x: Math.round(alt.boundingBox.x),
            y: Math.round(alt.boundingBox.y),
            width: Math.round(alt.boundingBox.width),
            height: Math.round(alt.boundingBox.height),
          },
          confidence: alt.confidence || 0.5,
        })),
      };

      logger.info('[VisionAnalyzer] Element identified', {
        description,
        center: result.center,
        confidence: result.confidence,
        processingTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }

      logger.error('[VisionAnalyzer] Element identification failed', {
        description,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceUnavailableError(
        'Element identification failed',
        { description },
        'Try a more specific description'
      );
    }
  }

  /**
   * Extract all visible text from a screenshot (OCR-like functionality)
   */
  async extractTextFromScreenshot(
    base64Image: string,
    options: {
      userId?: string;
      tier?: SubscriptionTier;
      preserveLayout?: boolean;
    } = {}
  ): Promise<{
    text: string;
    sections: Array<{ heading?: string; content: string; location: string }>;
    confidence: number;
    modelUsed: string;
    processingTime: number;
  }> {
    const startTime = Date.now();
    const { userId = 'anonymous', tier = 'open_source', preserveLayout = true } = options;

    logger.info('[VisionAnalyzer] Extracting text from screenshot', {
      userId,
      preserveLayout,
    });

    // Check quota
    await this.enforceQuota(userId, tier);

    const imageUrl = this.prepareImageUrl(base64Image);

    const prompt = `Extract ALL visible text from this screenshot with maximum accuracy.

**Requirements**:
1. Extract every piece of readable text
2. ${preserveLayout ? 'Preserve the layout and structure' : 'Output as continuous text'}
3. Organize text by sections if there are clear visual separations
4. Include navigation menus, buttons, labels, body text, footers

**Response Format** (JSON only, no markdown):
{
  "fullText": "all text concatenated with proper spacing",
  "sections": [
    {
      "heading": "section heading if any",
      "content": "text content in this section",
      "location": "top-left/top-center/etc."
    }
  ],
  "confidence": <0.0-1.0>
}`;

    try {
      const response = await this.callVisionModel(this.PRIMARY_MODEL, imageUrl, prompt);
      const content = response.choices[0]?.message?.content || '{}';
      const parsed = this.parseJsonResponse(content);

      // Track usage
      this.trackUsage(userId, tier);

      const result = {
        text: parsed.fullText || '',
        sections: parsed.sections || [],
        confidence: parsed.confidence || 0.85,
        modelUsed: this.PRIMARY_MODEL,
        processingTime: Date.now() - startTime,
      };

      logger.info('[VisionAnalyzer] Text extraction complete', {
        textLength: result.text.length,
        sectionCount: result.sections.length,
        processingTime: result.processingTime,
      });

      return result;
    } catch (error) {
      logger.error('[VisionAnalyzer] Text extraction failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceUnavailableError(
        'Text extraction failed',
        {},
        'Try again with a clearer screenshot'
      );
    }
  }

  /**
   * Compare two screenshots to detect changes
   */
  async compareScreenshots(
    beforeBase64: string,
    afterBase64: string,
    options: {
      userId?: string;
      tier?: SubscriptionTier;
    } = {}
  ): Promise<ScreenshotComparisonResult> {
    const startTime = Date.now();
    const { userId = 'anonymous', tier = 'open_source' } = options;

    logger.info('[VisionAnalyzer] Comparing screenshots', { userId });

    // Check quota (this counts as 2 calls due to complexity)
    await this.enforceQuota(userId, tier, 2);

    // Quick perceptual hash check for identical images
    const beforeHash = this.calculatePerceptualHash(beforeBase64);
    const afterHash = this.calculatePerceptualHash(afterBase64);

    if (beforeHash === afterHash) {
      logger.info('[VisionAnalyzer] Screenshots are identical (hash match)');
      return {
        hasChanges: false,
        changes: [],
        similarityScore: 1.0,
        summary: 'No visual changes detected - screenshots are identical',
        modelUsed: 'perceptual-hash',
        processingTime: Date.now() - startTime,
      };
    }

    const beforeUrl = this.prepareImageUrl(beforeBase64);
    const afterUrl = this.prepareImageUrl(afterBase64);

    const prompt = `Compare these two screenshots and identify all changes.

**Before Image**: First image
**After Image**: Second image

**Analysis Required**:
1. Identify what has been added, removed, modified, or moved
2. Rate the significance of each change (high/medium/low)
3. Provide an overall similarity score

**Response Format** (JSON only, no markdown):
{
  "hasChanges": true/false,
  "changes": [
    {
      "type": "added|removed|modified|moved",
      "description": "what changed",
      "location": "where on the page",
      "significance": "high|medium|low"
    }
  ],
  "similarityScore": <0.0-1.0>,
  "summary": "brief overall summary of changes"
}`;

    try {
      // Send both images for comparison
      const response = await this.openRouterClient.createCompletion({
        model: this.PRIMARY_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: beforeUrl, detail: 'high' } },
              { type: 'image_url', image_url: { url: afterUrl, detail: 'high' } },
            ],
          },
        ],
        max_tokens: 2000,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || '{}';
      const parsed = this.parseJsonResponse(content);

      // Track usage (2 calls worth)
      this.trackUsage(userId, tier);
      this.trackUsage(userId, tier);

      const result: ScreenshotComparisonResult = {
        hasChanges: parsed.hasChanges ?? true,
        changes: parsed.changes || [],
        similarityScore: parsed.similarityScore || 0.5,
        summary: parsed.summary || 'Changes detected between screenshots',
        modelUsed: this.PRIMARY_MODEL,
        processingTime: Date.now() - startTime,
      };

      logger.info('[VisionAnalyzer] Comparison complete', {
        hasChanges: result.hasChanges,
        changeCount: result.changes.length,
        similarityScore: result.similarityScore,
        processingTime: result.processingTime,
      });

      return result;
    } catch (error) {
      logger.error('[VisionAnalyzer] Screenshot comparison failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceUnavailableError(
        'Screenshot comparison failed',
        {},
        'Try again with smaller or clearer screenshots'
      );
    }
  }

  /**
   * Suggest the next action to take based on current screenshot and goal
   */
  async suggestNextAction(
    base64Image: string,
    goal: string,
    completedSteps: string[],
    options: {
      userId?: string;
      tier?: SubscriptionTier;
      availableActions?: string[];
    } = {}
  ): Promise<{
    suggestedAction: SuggestedAction;
    reasoning: string;
    confidence: number;
    alternativeActions: SuggestedAction[];
    modelUsed: string;
    processingTime: number;
  }> {
    const startTime = Date.now();
    const {
      userId = 'anonymous',
      tier = 'open_source',
      availableActions = ['click', 'type', 'scroll', 'hover', 'select', 'wait', 'navigate'],
    } = options;

    logger.info('[VisionAnalyzer] Suggesting next action', {
      userId,
      goal: goal.substring(0, 50),
      completedStepsCount: completedSteps.length,
    });

    // Check quota
    await this.enforceQuota(userId, tier);

    const imageUrl = this.prepareImageUrl(base64Image);

    const prompt = `You are an AI agent helping to complete a goal through browser automation.

**Goal**: ${goal}

**Completed Steps**:
${completedSteps.length > 0 ? completedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') : 'None yet'}

**Available Actions**: ${availableActions.join(', ')}

**Current Screenshot**: Analyze the current state of the page

**Task**: Determine the BEST next action to progress toward the goal.

**Response Format** (JSON only, no markdown):
{
  "suggestedAction": {
    "action": "${availableActions[0]}",
    "target": "specific element to interact with",
    "value": "text to type if applicable",
    "reasoning": "why this action",
    "priority": 1
  },
  "reasoning": "detailed explanation of why this is the right next step",
  "confidence": <0.0-1.0>,
  "alternativeActions": [
    {
      "action": "...",
      "target": "...",
      "reasoning": "...",
      "priority": 2
    }
  ],
  "goalProgress": "assessment of how far along we are",
  "blockers": ["any obstacles detected"]
}`;

    try {
      const response = await this.callVisionModel(this.PRIMARY_MODEL, imageUrl, prompt);
      const content = response.choices[0]?.message?.content || '{}';
      const parsed = this.parseJsonResponse(content);

      // Track usage
      this.trackUsage(userId, tier);

      const result = {
        suggestedAction: parsed.suggestedAction || {
          action: 'wait',
          target: 'page',
          reasoning: 'Unable to determine next action',
          priority: 1,
        },
        reasoning: parsed.reasoning || 'Analysis complete',
        confidence: parsed.confidence || 0.7,
        alternativeActions: parsed.alternativeActions || [],
        modelUsed: this.PRIMARY_MODEL,
        processingTime: Date.now() - startTime,
      };

      logger.info('[VisionAnalyzer] Action suggestion complete', {
        action: result.suggestedAction.action,
        target: result.suggestedAction.target,
        confidence: result.confidence,
        processingTime: result.processingTime,
      });

      return result;
    } catch (error) {
      logger.error('[VisionAnalyzer] Action suggestion failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceUnavailableError(
        'Action suggestion failed',
        { goal },
        'Try simplifying the goal or providing more context'
      );
    }
  }

  // ==========================================================================
  // Quota & Usage Management
  // ==========================================================================

  /**
   * Get quota status for a user
   */
  getQuotaStatus(userId: string, tier: SubscriptionTier = 'open_source'): VisionQuotaStatus {
    const usage = this.getUserUsage(userId, tier);
    const dailyLimit = TIER_VISION_LIMITS[tier];

    // Calculate reset time (next midnight UTC)
    const now = new Date();
    const resetsAt = new Date(now);
    resetsAt.setUTCHours(24, 0, 0, 0);

    return {
      userId,
      tier,
      dailyLimit: dailyLimit === Infinity ? -1 : dailyLimit,
      usedToday: usage.callsToday,
      remaining: dailyLimit === Infinity ? -1 : Math.max(0, dailyLimit - usage.callsToday),
      resetsAt,
      limitReached: dailyLimit !== Infinity && usage.callsToday >= dailyLimit,
    };
  }

  /**
   * Enforce quota limits
   */
  private async enforceQuota(
    userId: string,
    tier: SubscriptionTier,
    callCount: number = 1
  ): Promise<void> {
    const dailyLimit = TIER_VISION_LIMITS[tier];

    // Admin tier has no limits
    if (dailyLimit === Infinity) {
      return;
    }

    const usage = this.getUserUsage(userId, tier);

    // Reset if new day
    const now = new Date();
    const lastResetDate = new Date(usage.lastReset).toDateString();
    const currentDate = now.toDateString();

    if (lastResetDate !== currentDate) {
      usage.callsToday = 0;
      usage.lastReset = now;
    }

    // Check limit
    if (usage.callsToday + callCount > dailyLimit) {
      const status = this.getQuotaStatus(userId, tier);

      logger.warn('[VisionAnalyzer] Quota exceeded', {
        userId,
        tier,
        usedToday: usage.callsToday,
        dailyLimit,
        requestedCalls: callCount,
      });

      throw new RateLimitError(
        `Vision API quota exceeded for ${tier} tier. Used ${usage.callsToday}/${dailyLimit} calls today.`,
        status.resetsAt.getTime() - Date.now(),
        {
          tier,
          dailyLimit,
          usedToday: usage.callsToday,
          resetsAt: status.resetsAt.toISOString(),
          upgradeUrl: 'https://dashboard.adverant.ai/billing',
        }
      );
    }
  }

  /**
   * Track usage for a user
   */
  private trackUsage(userId: string, tier: SubscriptionTier): void {
    const usage = this.getUserUsage(userId, tier);
    usage.callsToday++;

    logger.debug('[VisionAnalyzer] Usage tracked', {
      userId,
      tier,
      callsToday: usage.callsToday,
      dailyLimit: TIER_VISION_LIMITS[tier],
    });
  }

  /**
   * Get or create user usage record
   */
  private getUserUsage(userId: string, tier: SubscriptionTier): UserUsage {
    let usage = this.userUsage.get(userId);

    if (!usage) {
      usage = {
        userId,
        tier,
        callsToday: 0,
        lastReset: new Date(),
      };
      this.userUsage.set(userId, usage);
    }

    // Update tier if changed
    usage.tier = tier;

    return usage;
  }

  // ==========================================================================
  // Caching & Deduplication
  // ==========================================================================

  /**
   * Get cached analysis result
   */
  private getCachedAnalysis(base64Image: string): VisionAnalysisResult | null {
    const hash = this.calculatePerceptualHash(base64Image);
    const cached = this.analysisCache.get(hash);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      logger.debug('[VisionAnalyzer] Cache hit', { hash });
      return cached.result;
    }

    return null;
  }

  /**
   * Cache analysis result
   */
  private cacheAnalysis(base64Image: string, result: VisionAnalysisResult): void {
    const hash = this.calculatePerceptualHash(base64Image);

    this.analysisCache.set(hash, {
      result,
      timestamp: Date.now(),
      hash,
    });

    logger.debug('[VisionAnalyzer] Result cached', { hash });
  }

  /**
   * Calculate perceptual hash for image deduplication
   * Uses a simple approach: hash of image size + first/last 100 chars
   */
  private calculatePerceptualHash(base64Image: string): string {
    // Check cache first
    const cachedHash = this.hashCache.get(base64Image.substring(0, 200));
    if (cachedHash) {
      return cachedHash;
    }

    // Create hash from image characteristics
    const hashInput = [
      base64Image.length.toString(),
      base64Image.substring(0, 100),
      base64Image.substring(Math.max(0, base64Image.length - 100)),
    ].join('|');

    const hash = createHash('md5').update(hashInput).digest('hex');

    // Cache the hash
    this.hashCache.set(base64Image.substring(0, 200), hash);

    return hash;
  }

  /**
   * Start cache cleanup interval
   */
  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, entry] of this.analysisCache.entries()) {
        if (now - entry.timestamp > this.CACHE_TTL) {
          this.analysisCache.delete(key);
          cleaned++;
        }
      }

      // Clean hash cache if it gets too large
      if (this.hashCache.size > 1000) {
        this.hashCache.clear();
        logger.debug('[VisionAnalyzer] Hash cache cleared');
      }

      if (cleaned > 0) {
        logger.debug('[VisionAnalyzer] Cache cleanup', { entriesRemoved: cleaned });
      }
    }, this.CACHE_TTL);
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Prepare image URL for vision model
   */
  private prepareImageUrl(base64Image: string): string {
    if (base64Image.startsWith('data:')) {
      return base64Image;
    }

    // Detect image type
    let mimeType = 'image/png';
    if (base64Image.startsWith('/9j/')) {
      mimeType = 'image/jpeg';
    } else if (base64Image.startsWith('R0lGOD')) {
      mimeType = 'image/gif';
    } else if (base64Image.startsWith('UklGR')) {
      mimeType = 'image/webp';
    }

    return `data:${mimeType};base64,${base64Image}`;
  }

  /**
   * Build analysis prompt
   */
  private buildAnalysisPrompt(customPrompt?: string): string {
    const basePrompt = `Analyze this screenshot and provide a comprehensive description.

**Required Analysis**:
1. **Page Description**: What type of page is this? What is its purpose?
2. **Elements**: Identify all interactive and notable elements (buttons, links, inputs, menus, etc.)
3. **Suggested Actions**: What actions could a user take on this page?

${customPrompt ? `\n**Additional Context**: ${customPrompt}\n` : ''}

**Response Format** (JSON only, no markdown):
{
  "description": "comprehensive description of the page",
  "elements": [
    {
      "type": "button|input|link|text|image|checkbox|dropdown|navigation|form|other",
      "description": "what this element is",
      "textContent": "visible text if any",
      "location": "top-left|top-center|top-right|center-left|center|center-right|bottom-left|bottom-center|bottom-right",
      "confidence": <0.0-1.0>
    }
  ],
  "suggestedActions": [
    {
      "action": "click|type|scroll|hover|select|wait|navigate",
      "target": "description of target element",
      "value": "value if applicable",
      "reasoning": "why this action makes sense",
      "priority": <1-5>
    }
  ],
  "confidence": <0.0-1.0>
}`;

    return basePrompt;
  }

  /**
   * Call vision model via OpenRouter
   */
  private async callVisionModel(
    model: string,
    imageUrl: string,
    prompt: string
  ): Promise<CompletionResponse> {
    return this.openRouterClient.createCompletion({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
          ],
        },
      ],
      max_tokens: 4000,
      temperature: 0.1,
    });
  }

  /**
   * Parse analysis response into structured result
   */
  private parseAnalysisResponse(
    response: CompletionResponse,
    modelUsed: string,
    startTime: number
  ): VisionAnalysisResult {
    const content = response.choices[0]?.message?.content || '{}';
    const parsed = this.parseJsonResponse(content);

    return {
      description: parsed.description || 'Unable to analyze screenshot',
      elements: (parsed.elements || []).map((el: any) => ({
        type: el.type || 'other',
        description: el.description || '',
        textContent: el.textContent,
        location: el.location || 'center',
        confidence: el.confidence || 0.5,
      })),
      suggestedActions: (parsed.suggestedActions || []).map((action: any) => ({
        action: action.action || 'wait',
        target: action.target || '',
        value: action.value,
        reasoning: action.reasoning || '',
        priority: action.priority || 5,
      })),
      confidence: parsed.confidence || 0.7,
      modelUsed,
      processingTime: Date.now() - startTime,
      fromCache: false,
    };
  }

  /**
   * Parse JSON from potentially markdown-wrapped response
   */
  private parseJsonResponse(content: string): any {
    let jsonStr = content.trim();

    // Remove markdown code blocks if present
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?$/g, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```\n?/g, '');
    }

    try {
      return JSON.parse(jsonStr);
    } catch (error) {
      logger.warn('[VisionAnalyzer] Failed to parse JSON response', {
        content: content.substring(0, 200),
        error: error instanceof Error ? error.message : String(error),
      });

      return {};
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.analysisCache.clear();
    this.hashCache.clear();
    this.userUsage.clear();

    logger.info('[VisionAnalyzer] Cleanup complete');
  }
}

// ============================================================================
// Singleton Pattern & Factory
// ============================================================================

let visionAnalyzerInstance: VisionAnalyzer | null = null;

/**
 * Get or create the VisionAnalyzer singleton
 */
export function getVisionAnalyzer(): VisionAnalyzer {
  if (!visionAnalyzerInstance) {
    visionAnalyzerInstance = new VisionAnalyzer();
  }
  return visionAnalyzerInstance;
}

/**
 * Create a new VisionAnalyzer instance (for testing or custom configuration)
 */
export function createVisionAnalyzer(openRouterClient?: OpenRouterClient): VisionAnalyzer {
  return new VisionAnalyzer(openRouterClient);
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetVisionAnalyzer(): void {
  if (visionAnalyzerInstance) {
    visionAnalyzerInstance.cleanup();
    visionAnalyzerInstance = null;
  }
}

// Export singleton instance for convenience
export const visionAnalyzer = getVisionAnalyzer();
