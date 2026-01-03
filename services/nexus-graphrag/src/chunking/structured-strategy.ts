import { ChunkingStrategy } from './base-strategy';
import { ChunkingOptions, Chunk } from '../types';
import { logger } from '../utils/logger';

export class StructuredDataChunkingStrategy extends ChunkingStrategy {
  async chunk(content: string, options: ChunkingOptions): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    
    try {
      // Parse structured data based on format
      const data = this.parseStructuredData(content, options.metadata.format);
      
      // Chunk by logical structure
      const structuredChunks = await this.chunkByStructure(data, options);
      chunks.push(...structuredChunks);
      
    } catch (error) {
      logger.warn('Failed to parse structured data, falling back to text chunking', { 
        error, 
        format: options.metadata.format 
      });
      
      // Fallback to text-based chunking
      chunks.push(...await this.fallbackTextChunking(content, options));
    }
    
    logger.debug('Structured data chunking completed', { 
      documentId: options.metadata.id,
      format: options.metadata.format,
      chunksCreated: chunks.length 
    });
    
    return chunks;
  }
  
  private parseStructuredData(content: string, format: string): any {
    switch (format.toLowerCase()) {
      case 'json':
        return JSON.parse(content);
      
      case 'yaml':
      case 'yml':
        // In production, use a proper YAML parser like js-yaml
        // For now, we'll treat it as JSON if it fails
        try {
          return JSON.parse(content);
        } catch {
          throw new Error('YAML parsing not implemented - install js-yaml');
        }
      
      case 'xml':
        // In production, use an XML parser
        throw new Error('XML parsing not implemented');
      
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }
  
  private async chunkByStructure(data: any, options: ChunkingOptions): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const paths: Array<{ path: string; value: any; depth: number }> = [];
    
    // Traverse the data structure and collect paths
    this.traverseObject(data, '', paths, 0);
    
    // Group paths into chunks based on size
    let currentChunk: Array<{ path: string; value: any }> = [];
    let currentSize = 0;
    
    for (const item of paths) {
      const itemStr = this.stringifyValue(item.value);
      const itemSize = this.estimateTokens(itemStr);
      
      if (currentSize + itemSize > options.maxTokens && currentChunk.length > 0) {
        // Create chunk from current items
        chunks.push(this.createStructuredChunk(currentChunk, options));
        
        // Start new chunk
        currentChunk = [item];
        currentSize = itemSize;
      } else {
        currentChunk.push(item);
        currentSize += itemSize;
      }
    }
    
    // Add final chunk
    if (currentChunk.length > 0) {
      chunks.push(this.createStructuredChunk(currentChunk, options));
    }
    
    return chunks;
  }
  
  private traverseObject(obj: any, path: string, paths: Array<{ path: string; value: any; depth: number }>, depth: number): void {
    if (depth > 10) return; // Prevent infinite recursion
    
    if (Array.isArray(obj)) {
      // For arrays, chunk by groups of items
      const chunkSize = 10; // Items per chunk
      for (let i = 0; i < obj.length; i += chunkSize) {
        const slice = obj.slice(i, Math.min(i + chunkSize, obj.length));
        paths.push({
          path: `${path}[${i}-${Math.min(i + chunkSize - 1, obj.length - 1)}]`,
          value: slice,
          depth
        });
      }
    } else if (typeof obj === 'object' && obj !== null) {
      // For objects, traverse each property
      for (const [key, value] of Object.entries(obj)) {
        const newPath = path ? `${path}.${key}` : key;
        
        if (typeof value === 'object' && value !== null) {
          // Recurse into nested objects/arrays
          this.traverseObject(value, newPath, paths, depth + 1);
        } else {
          // Leaf node
          paths.push({ path: newPath, value, depth });
        }
      }
    } else {
      // Primitive value
      paths.push({ path, value: obj, depth });
    }
  }
  
  private createStructuredChunk(items: Array<{ path: string; value: any }>, options: ChunkingOptions): Chunk {
    // Reconstruct a partial object from the paths
    const reconstructed: any = {};
    
    for (const item of items) {
      this.setValueByPath(reconstructed, item.path, item.value);
    }
    
    const content = JSON.stringify(reconstructed, null, 2);
    items[0].path;
    items[items.length - 1].path;

    return this.createChunk(
      content,
      'structured' as any,
      {
        start: 0, // Position tracking is less meaningful for structured data
        end: content.length
      },
      {
        paths: items.map(i => i.path),
        importance_score: this.calculateStructuredImportance(items),
        semantic_density: 0.8,
        contains_key_info: items.some(i => this.isKeyPath(i.path))
      },
      options.metadata.id!
    );
  }
  
  private setValueByPath(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      
      // Handle array indices
      const arrayMatch = part.match(/^(.+)\[(\d+)-(\d+)\]$/);
      if (arrayMatch) {
        const key = arrayMatch[1];
        if (!current[key]) {
          current[key] = [];
        }
        current = current[key];
      } else {
        if (!current[part]) {
          current[part] = {};
        }
        current = current[part];
      }
    }
    
    const lastPart = parts[parts.length - 1];
    const arrayMatch = lastPart.match(/^(.+)\[(\d+)-(\d+)\]$/);
    
    if (arrayMatch) {
      const key = arrayMatch[1];
      if (!current[key]) {
        current[key] = [];
      }
      current[key] = value;
    } else {
      current[lastPart] = value;
    }
  }
  
  private stringifyValue(value: any): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }
  
  private calculateStructuredImportance(items: Array<{ path: string; value: any }>): number {
    let score = 0.5;
    
    // Root-level properties are more important
    const rootLevelItems = items.filter(i => !i.path.includes('.'));
    score += rootLevelItems.length * 0.05;
    
    // Common important keys
    const importantKeys = ['id', 'name', 'title', 'type', 'version', 'config', 'settings'];
    for (const item of items) {
      if (importantKeys.some(key => item.path.toLowerCase().includes(key))) {
        score += 0.1;
      }
    }
    
    return Math.min(score, 1.0);
  }
  
  private isKeyPath(path: string): boolean {
    const keyPatterns = [
      /^(id|name|title|type|version)$/i,
      /config|settings|options/i,
      /api|endpoint|url/i,
      /key|token|secret/i
    ];
    
    return keyPatterns.some(pattern => pattern.test(path));
  }
  
  private async fallbackTextChunking(content: string, options: ChunkingOptions): Promise<Chunk[]> {
    // Simple line-based chunking for structured text
    const lines = content.split('\n');
    const chunks: Chunk[] = [];
    
    let currentChunk = '';
    let currentTokens = 0;
    let lineStart = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = this.estimateTokens(line);
      
      if (currentTokens + lineTokens > options.maxTokens && currentChunk) {
        chunks.push(this.createChunk(
          currentChunk,
          'structured' as any,
          {
            start: this.getLinePosition(lines, lineStart),
            end: this.getLinePosition(lines, i)
          },
          {
            importance_score: 0.5,
            semantic_density: 0.6,
            contains_key_info: false
          },
          options.metadata.id!
        ));
        
        currentChunk = line;
        currentTokens = lineTokens;
        lineStart = i;
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
        currentTokens += lineTokens;
      }
    }
    
    // Add final chunk
    if (currentChunk) {
      chunks.push(this.createChunk(
        currentChunk,
        'structured' as any,
        {
          start: this.getLinePosition(lines, lineStart),
          end: content.length
        },
        {
          importance_score: 0.5,
          semantic_density: 0.6,
          contains_key_info: false
        },
        options.metadata.id!
      ));
    }
    
    return chunks;
  }
  
  private getLinePosition(lines: string[], lineNumber: number): number {
    let position = 0;
    for (let i = 0; i < lineNumber && i < lines.length; i++) {
      position += lines[i].length + 1;
    }
    return position;
  }
}
