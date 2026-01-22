/**
 * Type declarations for node-unrar-js
 * No official @types package available
 */

declare module 'node-unrar-js' {
  export interface FileHeader {
    name?: string;
    flags?: {
      directory?: boolean;
      encrypted?: boolean;
    };
    unpSize?: number;
    packSize?: number;
  }

  export interface ExtractedFile {
    fileHeader?: FileHeader;
    extraction?: Uint8Array;
  }

  export interface ExtractionState {
    state: 'SUCCESS' | 'FAIL';
    files?: ExtractedFile[];
  }

  export interface Extractor {
    extract(): ExtractionState;
  }

  export function createExtractorFromData(options: {
    data: Buffer | Uint8Array;
  }): Extractor;

  export function createExtractorFromFile(options: {
    filepath: string;
    targetPath?: string;
  }): Extractor;
}
