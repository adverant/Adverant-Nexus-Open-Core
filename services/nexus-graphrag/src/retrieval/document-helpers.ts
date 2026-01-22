import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { DocumentOutline, Chunk } from '../types';

interface Document {
  id: string;
  name?: string;
  content: string;
  metadata?: any;
}

export class DocumentHelpers {
  constructor(private postgresPool: Pool) {}

  async getDocumentByName(name: string): Promise<Document | null> {
    const client = await this.postgresPool.connect();
    
    try {
      // Search by exact title match first
      let result = await client.query(`
        SELECT d.*, dc.content 
        FROM graphrag.documents d
        JOIN graphrag.document_content dc ON d.id = dc.document_id
        WHERE LOWER(d.title) = LOWER($1)
        LIMIT 1
      `, [name]);
      
      // If no exact match, try partial match
      if (result.rows.length === 0) {
        result = await client.query(`
          SELECT d.*, dc.content 
          FROM graphrag.documents d
          JOIN graphrag.document_content dc ON d.id = dc.document_id
          WHERE LOWER(d.title) LIKE LOWER($1)
          ORDER BY similarity(LOWER(d.title), LOWER($2)) DESC
          LIMIT 1
        `, [`%${name}%`, name]);
      }
      
      if (result.rows.length === 0) {
        logger.debug('Document not found by name', { name });
        return null;
      }
      
      const row = result.rows[0];
      return {
        id: row.id,
        content: row.content,
        metadata: {
          title: row.title,
          type: row.type,
          format: row.format,
          size: row.size,
          hash: row.hash,
          created_at: row.created_at,
          updated_at: row.updated_at,
          version: row.version,
          tags: row.tags || [],
          source: row.source,
          encoding: row.encoding,
          custom: row.metadata || {}
        }
      };
    } finally {
      client.release();
    }
  }
  
  async getDocumentById(id: string): Promise<Document | null> {
    const client = await this.postgresPool.connect();
    
    try {
      const result = await client.query(`
        SELECT d.*, dc.content 
        FROM graphrag.documents d
        JOIN graphrag.document_content dc ON d.id = dc.document_id
        WHERE d.id = $1
      `, [id]);
      
      if (result.rows.length === 0) {
        logger.debug('Document not found by id', { id });
        return null;
      }
      
      const row = result.rows[0];
      return {
        id: row.id,
        content: row.content,
        metadata: {
          title: row.title,
          type: row.type,
          format: row.format,
          size: row.size,
          hash: row.hash,
          created_at: row.created_at,
          updated_at: row.updated_at,
          version: row.version,
          tags: row.tags || [],
          source: row.source,
          encoding: row.encoding,
          custom: row.metadata || {}
        }
      };
    } finally {
      client.release();
    }
  }
  
  async getDocumentOutline(documentId: string): Promise<DocumentOutline | null> {
    const client = await this.postgresPool.connect();
    
    try {
      const result = await client.query(`
        SELECT outline_json
        FROM graphrag.document_outlines
        WHERE document_id = $1
        ORDER BY generated_at DESC
        LIMIT 1
      `, [documentId]);
      
      if (result.rows.length === 0) {
        logger.debug('Document outline not found', { documentId });
        return null;
      }
      
      return result.rows[0].outline_json;
    } finally {
      client.release();
    }
  }
  
  async getChunksForDocument(documentId: string): Promise<Chunk[]> {
    const client = await this.postgresPool.connect();
    
    try {
      // First get chunks from PostgreSQL if we have a chunks table
      const pgResult = await client.query(`
        SELECT * FROM graphrag.chunks
        WHERE document_id = $1
        ORDER BY position_start ASC
      `, [documentId]);
      
      if (pgResult.rows.length > 0) {
        return pgResult.rows.map(row => ({
          id: row.id,
          document_id: row.document_id,
          content: row.content,
          type: row.type,
          position: {
            start: row.position_start,
            end: row.position_end,
            line_start: row.line_start,
            line_end: row.line_end
          },
          metadata: row.metadata || {},
          tokens: row.tokens,
          summary: row.summary
        }));
      }
      
      // If no chunks in PostgreSQL, they might only be in Qdrant
      // In a real implementation, you would query Qdrant here
      logger.warn('No chunks found in PostgreSQL', { documentId });
      return [];
      
    } catch (error) {
      // If chunks table doesn't exist, return empty array
      if (error && typeof error === 'object' && 'code' in error && error.code === '42P01') { // table does not exist
        logger.debug('Chunks table does not exist', { documentId });
        return [];
      }
      throw error;
    } finally {
      client.release();
    }
  }
  
  async getDocumentsByTags(tags: string[]): Promise<Document[]> {
    const client = await this.postgresPool.connect();
    
    try {
      const result = await client.query(`
        SELECT d.*, dc.content 
        FROM graphrag.documents d
        JOIN graphrag.document_content dc ON d.id = dc.document_id
        WHERE d.tags && $1
        ORDER BY d.created_at DESC
        LIMIT 100
      `, [tags]);
      
      return result.rows.map(row => ({
        id: row.id,
        content: row.content,
        metadata: {
          title: row.title,
          type: row.type,
          format: row.format,
          size: row.size,
          hash: row.hash,
          created_at: row.created_at,
          updated_at: row.updated_at,
          version: row.version,
          tags: row.tags || [],
          source: row.source,
          encoding: row.encoding,
          custom: row.metadata || {}
        }
      }));
    } finally {
      client.release();
    }
  }
  
  async searchDocumentsByContent(searchQuery: string, limit: number = 10): Promise<Document[]> {
    const client = await this.postgresPool.connect();
    
    try {
      const result = await client.query(`
        SELECT d.*, dc.content,
               ts_rank(si.search_vector, plainto_tsquery('english', $1)) as rank
        FROM graphrag.documents d
        JOIN graphrag.document_content dc ON d.id = dc.document_id
        JOIN graphrag.search_index si ON d.id = si.document_id
        WHERE si.search_vector @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $2
      `, [searchQuery, limit]);
      
      return result.rows.map(row => ({
        id: row.id,
        content: row.content,
        metadata: {
          title: row.title,
          type: row.type,
          format: row.format,
          size: row.size,
          hash: row.hash,
          created_at: row.created_at,
          updated_at: row.updated_at,
          version: row.version,
          tags: row.tags || [],
          source: row.source,
          encoding: row.encoding,
          custom: row.metadata || {},
          searchRank: row.rank
        }
      }));
    } finally {
      client.release();
    }
  }
}
