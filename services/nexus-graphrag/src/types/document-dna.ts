/**
 * Document DNA Type Definitions
 *
 * Defines the structure for triple-layer document storage that preserves
 * semantic meaning, structural layout, and original content.
 */

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'html' | 'xml' |
                            'png' | 'jpg' | 'jpeg' | 'tiff' | 'bmp' | 'gif' |
                            'webp' | 'txt' | 'md' | 'rtf' | 'epub' | 'unknown';

export interface DocumentLayer {
  type: 'semantic' | 'structural' | 'original';
  content?: string;
  embeddings?: number[];
  layout?: LayoutElement[];
  metadata: Record<string, any>;
}

export interface LayoutElement {
  type: 'header' | 'paragraph' | 'table' | 'figure' | 'list' | 'code' | 'footer' | 'caption';
  content?: string;
  level?: number; // For headers (h1, h2, etc.)
  bbox?: BoundingBox; // Bounding box for spatial location
  children?: LayoutElement[];
  metadata?: Record<string, any>;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  page?: number;
}

export interface TableData {
  headers: string[];
  rows: string[][];
  caption?: string;
  bbox?: BoundingBox;
  confidence?: number;
}

export interface FigureData {
  caption?: string;
  url?: string;
  base64?: string;
  bbox?: BoundingBox;
  type?: 'chart' | 'diagram' | 'photo' | 'illustration';
}

export interface DocumentDNA {
  id: string;
  documentId: string;
  layers: {
    semantic?: DocumentLayer;
    structural?: DocumentLayer;
    original: DocumentLayer;
  };
  crossReferences?: CrossReference[];
  createdAt: string;
  updatedAt?: string;
  version: string;
}

export interface CrossReference {
  sourceLayer: 'semantic' | 'structural' | 'original';
  targetLayer: 'semantic' | 'structural' | 'original';
  sourceId: string;
  targetId: string;
  type: 'relates_to' | 'contains' | 'references' | 'derived_from';
  confidence: number;
}

export interface ProcessingOptions {
  documentId?: string;
  title?: string;
  metadata?: Record<string, any>;
}

export interface ProcessingResult {
  text: string;
  metadata: Record<string, any>;
  tables?: TableData[];
  figures?: FigureData[];
  layout?: LayoutElement[];
  dna?: DocumentDNA;
  documentId?: string;
  storageResult?: any;
  processingTime?: number;
}

export interface OCROptions {
  tier: 'auto' | 'fast' | 'quality' | 'premium';
  budget?: number;
  preserveLayout?: boolean;
  language?: string;
  confidence_threshold?: number;
}

export interface OCRResult {
  text: string;
  confidence: number;
  tier: string;
  layout?: LayoutElement[];
  metadata: Record<string, any>;
  cost?: number;
}

export interface DoclingOptions {
  preserveLayout?: boolean;
  extractTables?: boolean;
  extractFigures?: boolean;
  extractEquations?: boolean;
  outputFormat?: 'text' | 'markdown' | 'json';
}

export interface DoclingResult {
  text: string;
  tables?: TableData[];
  figures?: FigureData[];
  layout?: LayoutElement[];
  metadata: Record<string, any>;
}