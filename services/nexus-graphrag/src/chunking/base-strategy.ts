import { ChunkingOptions, Chunk } from '../types';
import { v4 as uuidv4 } from 'uuid';

export abstract class ChunkingStrategy {
  abstract chunk(content: string, options: ChunkingOptions): Promise<Chunk[]>;

  protected estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters
    // This is a simplified approach - in production, you might use a proper tokenizer
    return Math.ceil(text.length / 4);
  }

  protected createChunk(
    content: string,
    type: Chunk['type'],
    position: Chunk['position'],
    metadata: Partial<Chunk['metadata']>,
    documentId: string
  ): Chunk {
    return {
      id: uuidv4(),
      document_id: documentId,
      content,
      type,
      position,
      metadata: {
        importance_score: metadata.importance_score || 0.5,
        semantic_density: metadata.semantic_density || 0.5,
        contains_key_info: metadata.contains_key_info || false,
        ...metadata
      },
      tokens: this.estimateTokens(content)
    };
  }

  protected findLinePosition(content: string, charPosition: number): number {
    const lines = content.substring(0, charPosition).split('\n');
    return lines.length - 1;
  }
}

export interface CodeUnit {
  type: 'function' | 'class' | 'module' | 'block';
  name: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  dependencies: string[];
  importance: number;
}

export interface CodeStructure {
  units: CodeUnit[];
  imports: string[];
  exports: string[];
}

export interface MarkdownSection {
  type: 'header' | 'section' | 'paragraph' | 'code_block' | 'list' | 'table';
  level?: number;
  title?: string;
  content: string;
  position: {
    start: number;
    end: number;
  };
  children?: MarkdownSection[];
}
