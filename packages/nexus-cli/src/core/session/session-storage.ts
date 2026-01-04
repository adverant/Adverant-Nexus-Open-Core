/**
 * Session Storage
 *
 * Handles persistence of CLI sessions to disk
 * Saves sessions to ~/.nexus/sessions/
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import type {
  Session,
  SessionSummary,
  SessionStorage as ISessionStorage,
} from '../../types/session.js';

const SESSIONS_DIR = path.join(os.homedir(), '.nexus', 'sessions');

// Session validation schema
const sessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  created: z.date(),
  updated: z.date(),
  context: z.object({
    workspace: z.any().optional(),
    cwd: z.string(),
    config: z.any(),
    environment: z.record(z.string()),
    services: z.record(z.any()),
  }),
  history: z.array(z.any()),
  results: z.array(z.any()),
  nexusMemories: z.array(z.string()),
  metadata: z.object({
    totalCommands: z.number(),
    successfulCommands: z.number(),
    failedCommands: z.number(),
    totalDuration: z.number(),
    lastCommand: z.string().optional(),
    tags: z.array(z.string()),
  }),
});

export class SessionStorage implements ISessionStorage {
  /**
   * Ensure sessions directory exists
   */
  private async ensureSessionsDir(): Promise<void> {
    await fs.ensureDir(SESSIONS_DIR);
  }

  /**
   * Get session file path
   */
  private getSessionPath(nameOrId: string): string {
    // If it looks like a filename, use it directly
    if (nameOrId.endsWith('.json')) {
      return path.join(SESSIONS_DIR, nameOrId);
    }

    // Otherwise, use as name
    return path.join(SESSIONS_DIR, `${nameOrId}.json`);
  }

  /**
   * Save session to disk
   */
  async save(session: Session): Promise<void> {
    await this.ensureSessionsDir();

    const filePath = this.getSessionPath(session.name);

    // Convert dates to ISO strings for JSON serialization
    const serialized = this.serializeSession(session);

    await fs.writeJson(filePath, serialized, { spaces: 2 });
  }

  /**
   * Load session from disk
   */
  async load(nameOrId: string): Promise<Session | null> {
    const filePath = this.getSessionPath(nameOrId);

    if (!(await fs.pathExists(filePath))) {
      // Try to find by ID
      const sessions = await this.list();
      const session = sessions.find(s => s.id === nameOrId);

      if (session) {
        return this.load(session.name);
      }

      return null;
    }

    const data = await fs.readJson(filePath);
    return this.deserializeSession(data);
  }

  /**
   * List all sessions
   */
  async list(): Promise<SessionSummary[]> {
    await this.ensureSessionsDir();

    const files = await fs.readdir(SESSIONS_DIR);
    const sessionFiles = files.filter(f => f.endsWith('.json'));

    const summaries: SessionSummary[] = [];

    for (const file of sessionFiles) {
      try {
        const data = await fs.readJson(path.join(SESSIONS_DIR, file));
        summaries.push({
          id: data.id,
          name: data.name,
          created: new Date(data.created),
          updated: new Date(data.updated),
          commandCount: data.metadata?.totalCommands ?? 0,
          tags: data.metadata?.tags ?? [],
        });
      } catch (error) {
        // Skip invalid session files
        console.warn(`Skipping invalid session file: ${file}`);
      }
    }

    // Sort by updated date, most recent first
    summaries.sort((a, b) => b.updated.getTime() - a.updated.getTime());

    return summaries;
  }

  /**
   * Delete session
   */
  async delete(nameOrId: string): Promise<void> {
    const filePath = this.getSessionPath(nameOrId);

    if (!(await fs.pathExists(filePath))) {
      // Try to find by ID
      const sessions = await this.list();
      const session = sessions.find(s => s.id === nameOrId);

      if (session) {
        return this.delete(session.name);
      }

      throw new Error(`Session not found: ${nameOrId}`);
    }

    await fs.remove(filePath);
  }

  /**
   * Export session to JSON string
   */
  async export(nameOrId: string): Promise<string> {
    const session = await this.load(nameOrId);

    if (!session) {
      throw new Error(`Session not found: ${nameOrId}`);
    }

    return JSON.stringify(this.serializeSession(session), null, 2);
  }

  /**
   * Import session from JSON string
   */
  async import(data: string): Promise<Session> {
    const parsed = JSON.parse(data);
    const session = this.deserializeSession(parsed);

    // Validate session
    sessionSchema.parse(session);

    // Save imported session
    await this.save(session);

    return session;
  }

  /**
   * Get most recent session
   */
  async getMostRecent(): Promise<Session | null> {
    const sessions = await this.list();

    if (sessions.length === 0) {
      return null;
    }

    // First session is most recent (already sorted)
    return this.load(sessions[0].name);
  }

  /**
   * Compress old sessions (optional)
   */
  async compress(olderThanDays: number = 30): Promise<number> {
    await this.ensureSessionsDir();

    const sessions = await this.list();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    let compressed = 0;

    for (const session of sessions) {
      if (session.updated < cutoffDate) {
        const filePath = this.getSessionPath(session.name);
        const gzipPath = filePath + '.gz';

        // Check if already compressed
        if (await fs.pathExists(gzipPath)) {
          continue;
        }

        // Compress using gzip
        const content = await fs.readFile(filePath, 'utf-8');
        const zlib = await import('zlib');
        const compressed_data = zlib.gzipSync(content);

        await fs.writeFile(gzipPath, compressed_data);
        await fs.remove(filePath);

        compressed++;
      }
    }

    return compressed;
  }

  /**
   * Serialize session for JSON storage
   */
  private serializeSession(session: Session): any {
    return {
      ...session,
      created: session.created.toISOString(),
      updated: session.updated.toISOString(),
      history: session.history.map(entry => ({
        ...entry,
        timestamp: entry.timestamp.toISOString(),
      })),
      results: session.results.map(result => ({
        ...result,
        timestamp: result.timestamp.toISOString(),
      })),
    };
  }

  /**
   * Deserialize session from JSON
   */
  private deserializeSession(data: any): Session {
    return {
      ...data,
      created: new Date(data.created),
      updated: new Date(data.updated),
      history: (data.history ?? []).map((entry: any) => ({
        ...entry,
        timestamp: new Date(entry.timestamp),
      })),
      results: (data.results ?? []).map((result: any) => ({
        ...result,
        timestamp: new Date(result.timestamp),
      })),
    };
  }
}

export default SessionStorage;
