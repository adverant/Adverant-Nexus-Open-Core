/**
 * Session Manager for Nexus CLI
 *
 * Manages session checkpointing with save/load/resume functionality
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import type {
  Session,
  SessionStorage,
  SessionSummary,
  SessionContext,
  HistoryEntry,
  SessionResult,
} from '../../types/session.js';

const SESSIONS_DIR = path.join(os.homedir(), '.nexus', 'sessions');

export class SessionManager implements SessionStorage {
  constructor() {
    this.ensureSessionsDir();
  }

  /**
   * Save session to disk
   */
  async save(session: Session): Promise<void> {
    await this.ensureSessionsDir();

    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  /**
   * Load session by name or ID
   */
  async load(nameOrId: string): Promise<Session | null> {
    await this.ensureSessionsDir();

    // Try loading by ID first
    let filePath = path.join(SESSIONS_DIR, `${nameOrId}.json`);

    if (!(await fs.pathExists(filePath))) {
      // Try finding by name
      const sessions = await this.list();
      const session = sessions.find(s => s.name === nameOrId);

      if (!session) {
        return null;
      }

      filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Convert date strings back to Date objects
      return {
        ...data,
        created: new Date(data.created),
        updated: new Date(data.updated),
        history: data.history.map((entry: any) => ({
          ...entry,
          timestamp: new Date(entry.timestamp),
        })),
        results: data.results.map((result: any) => ({
          ...result,
          timestamp: new Date(result.timestamp),
        })),
      };
    } catch (error) {
      console.error('Failed to load session:', error);
      return null;
    }
  }

  /**
   * List all sessions
   */
  async list(): Promise<SessionSummary[]> {
    await this.ensureSessionsDir();

    try {
      const files = await fs.readdir(SESSIONS_DIR);
      const sessionFiles = files.filter(f => f.endsWith('.json'));

      const summaries: SessionSummary[] = [];

      for (const file of sessionFiles) {
        try {
          const content = await fs.readFile(
            path.join(SESSIONS_DIR, file),
            'utf-8'
          );
          const data = JSON.parse(content);

          summaries.push({
            id: data.id,
            name: data.name,
            created: new Date(data.created),
            updated: new Date(data.updated),
            commandCount: data.metadata.totalCommands,
            tags: data.metadata.tags,
          });
        } catch {
          // Skip invalid files
        }
      }

      // Sort by updated date, newest first
      return summaries.sort(
        (a, b) => b.updated.getTime() - a.updated.getTime()
      );
    } catch (error) {
      return [];
    }
  }

  /**
   * Delete session by name or ID
   */
  async delete(nameOrId: string): Promise<void> {
    const session = await this.load(nameOrId);

    if (!session) {
      throw new Error(`Session not found: ${nameOrId}`);
    }

    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
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

    return JSON.stringify(session, null, 2);
  }

  /**
   * Import session from JSON string
   */
  async import(data: string): Promise<Session> {
    const session = JSON.parse(data);

    // Generate new ID if collision
    const existing = await this.load(session.id);
    if (existing) {
      session.id = randomUUID();
    }

    // Convert date strings back to Date objects
    session.created = new Date(session.created);
    session.updated = new Date(session.updated);
    session.history = session.history.map((entry: any) => ({
      ...entry,
      timestamp: new Date(entry.timestamp),
    }));
    session.results = session.results.map((result: any) => ({
      ...result,
      timestamp: new Date(result.timestamp),
    }));

    await this.save(session);
    return session;
  }

  /**
   * Resume last session
   */
  async resumeLast(): Promise<Session | null> {
    const sessions = await this.list();

    if (sessions.length === 0) {
      return null;
    }

    // Return most recently updated session
    return this.load(sessions[0].id);
  }

  /**
   * Create new session
   */
  createSession(
    name: string,
    context: SessionContext,
    tags: string[] = []
  ): Session {
    return {
      id: randomUUID(),
      name,
      created: new Date(),
      updated: new Date(),
      context,
      history: [],
      results: [],
      nexusMemories: [],
      metadata: {
        totalCommands: 0,
        successfulCommands: 0,
        failedCommands: 0,
        totalDuration: 0,
        tags,
      },
    };
  }

  /**
   * Update session with new history entry
   */
  updateSession(
    session: Session,
    entry: HistoryEntry,
    result?: SessionResult
  ): Session {
    const updated: Session = {
      ...session,
      updated: new Date(),
      history: [...session.history, entry],
      results: result ? [...session.results, result] : session.results,
      metadata: {
        ...session.metadata,
        totalCommands: session.metadata.totalCommands + 1,
        successfulCommands:
          session.metadata.successfulCommands + (entry.success ? 1 : 0),
        failedCommands:
          session.metadata.failedCommands + (entry.success ? 0 : 1),
        totalDuration: session.metadata.totalDuration + entry.duration,
        lastCommand: entry.command,
      },
    };

    return updated;
  }

  /**
   * Ensure sessions directory exists
   */
  private async ensureSessionsDir(): Promise<void> {
    await fs.ensureDir(SESSIONS_DIR);
  }
}
