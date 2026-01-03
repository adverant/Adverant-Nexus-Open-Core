/**
 * Geospatial Prediction Types
 * Type definitions for geospatial prediction requests and responses
 */

/**
 * Dynamic operation type - accepts ANY string operation name
 * No hardcoded operations - fully extensible without code changes
 */
export type PredictionType = string;

export interface GeospatialLocation {
  latitude: number;
  longitude: number;
  name?: string;
}

export interface ImageryData {
  ndvi?: number; // Normalized Difference Vegetation Index (-1 to 1)
  landCover?: string; // Land cover classification
  elevation?: number; // Elevation in meters
  temperature?: number; // Surface temperature in Celsius
  precipitation?: number; // Precipitation in mm
}

export interface TimeRange {
  start: string; // ISO 8601 date string
  end: string; // ISO 8601 date string
}

export interface PredictionParams {
  // Core location data (required for most operations)
  location?: GeospatialLocation;

  // Satellite imagery context (from Earth Engine if available)
  imagery?: ImageryData;

  // Time range for temporal predictions
  timeRange?: TimeRange;

  // Additional features (operation-specific)
  features?: Record<string, any>;

  // Custom prompt for 'custom' operation type
  customPrompt?: string;
}

export interface PredictionOptions {
  // Use slower, more accurate models
  preferAccuracy?: boolean;

  // Enable WebSocket streaming for real-time updates
  stream?: boolean;

  // Operation timeout in milliseconds
  timeout?: number;

  // Session ID for WebSocket streaming
  sessionId?: string;
}

export interface GeospatialPredictionRequest {
  // Operation type - ANY string describing the desired prediction
  // Examples: 'land_use_classification', 'solar_potential_analysis', 'earthquake_risk', etc.
  operation: PredictionType;

  // Prediction parameters
  params: PredictionParams;

  // Execution options
  options?: PredictionOptions;

  // Job ID for tracking (auto-generated if not provided)
  jobId?: string;
}

// ============================================================================
// Response Types
// ============================================================================

export interface PredictionMetadata {
  operation: PredictionType;
  location?: string;
  timestamp: string;
  modelUsed: string;
  processingTime: number;
}

export interface GeospatialPredictionResponse {
  // Structured prediction result (operation-specific format)
  prediction: any;

  // Confidence score (0-1)
  confidence: number;

  // Human-readable reasoning
  reasoning: string;

  // Model that generated the prediction
  modelUsed: string;

  // Processing time in milliseconds
  processingTime: number;

  // Additional metadata
  metadata: PredictionMetadata;
}

// ============================================================================
// Structured Prediction Results (Operation-Specific)
// ============================================================================

export interface LandUsePrediction {
  category: 'Residential' | 'Commercial' | 'Industrial' | 'Agricultural' | 'Forest' | 'Water' | 'Urban Green Space' | 'Undeveloped';
  confidence: number;
  subcategory?: string;
}

export interface WildfireRiskPrediction {
  riskLevel: 'Low' | 'Moderate' | 'High' | 'Extreme';
  riskScore: number; // 1-10
  factors: {
    vegetationDensity?: number;
    weatherConditions?: string;
    terrainRisk?: number;
  };
  recommendations?: string[];
}

export interface TrafficPrediction {
  level: 'Light' | 'Moderate' | 'Heavy' | 'Severe';
  expectedSpeed: number; // mph
  delayEstimate: number; // minutes
  factors?: string[];
}

export interface AgriculturePrediction {
  cropHealth: 'Poor' | 'Fair' | 'Good' | 'Excellent';
  growthStage: 'Early' | 'Mid' | 'Late' | 'Harvest';
  stressIndicators?: ('Drought' | 'Disease' | 'Pest')[];
  yieldPotential: 'Low' | 'Moderate' | 'High';
  recommendations?: string[];
}

export interface FloodRiskPrediction {
  riskLevel: 'Low' | 'Moderate' | 'High' | 'Extreme';
  riskScore: number; // 1-10
  factors: {
    elevation?: number;
    proximityToWater?: number;
    drainageQuality?: string;
  };
  mitigationMeasures?: string[];
}

export interface UrbanGrowthPrediction {
  developmentLikelihood: 'Low' | 'Moderate' | 'High';
  expectedDevelopmentType?: 'Residential' | 'Commercial' | 'Industrial' | 'Mixed';
  growthRate: 'Slow' | 'Moderate' | 'Rapid';
  infrastructureNeeds?: string[];
}

export interface EnvironmentalImpactPrediction {
  healthRating: 'Poor' | 'Fair' | 'Good' | 'Excellent';
  impactFactors: string[];
  biodiversityRisk: 'Low' | 'Moderate' | 'High';
  recommendations?: string[];
}

// ============================================================================
// API Response Types (for routes)
// ============================================================================

export interface PredictionJobResponse {
  success: boolean;
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
  streaming?: {
    enabled: boolean;
    subscribe: {
      room: string;
      events: string[];
    };
  };
  result?: GeospatialPredictionResponse;
  error?: string;
}

export interface PredictionStatusResponse {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  result?: GeospatialPredictionResponse;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ============================================================================
// Error Types
// ============================================================================

export class GeospatialPredictionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, any>
  ) {
    super(message);
    this.name = 'GeospatialPredictionError';
  }
}
