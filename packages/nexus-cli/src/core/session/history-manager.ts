/**
 * History Manager for Nexus CLI
 *
 * Manages command history with persistence to disk
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HistoryEntry, HistoryManager as IHistoryManager } from '../../types/session.js';
import { randomUUID } from 'crypto';

const HISTORY_FILE = path.join(os.homedir(), '.nexus', 'history');
const MAX_HISTORY_SIZE = 1000;

export class HistoryManager implements IHistoryManager {
  private history: HistoryEntry[] = [];
  private currentIndex = -1;

  constructor() {
    this.loadHistory();
  }

  /**
   * Add command to history
   */
  add(entry: HistoryEntry): void {
    this.history.push(entry);

    // Trim to max size
    if (this.history.length > MAX_HISTORY_SIZE) {
      this.history = this.history.slice(-MAX_HISTORY_SIZE);
    }

    this.currentIndex = this.history.length;
    this.saveHistory();
  }

  /**
   * Get entry by ID
   */
  get(id: string): HistoryEntry | undefined {
    return this.history.find(entry => entry.id === id);
  }

  /**
   * List recent entries
   */
  list(limit?: number): HistoryEntry[] {
    const entries = [...this.history].reverse();
    return limit ? entries.slice(0, limit) : entries;
  }

  /**
   * Search history by query
   */
  search(query: string): HistoryEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.history.filter(entry =>
      entry.command.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.history = [];
    this.currentIndex = -1;
    this.saveHistory();
  }

  /**
   * Get previous command (for up arrow)
   */
  getPrevious(): string | undefined {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      return this.history[this.currentIndex]?.command;
    }
    return undefined;
  }

  /**
   * Get next command (for down arrow)
   */
  getNext(): string | undefined {
    if (this.currentIndex < this.history.length - 1) {
      this.currentIndex++;
      return this.history[this.currentIndex]?.command;
    } else if (this.currentIndex === this.history.length - 1) {
      this.currentIndex = this.history.length;
      return '';
    }
    return undefined;
  }

  /**
   * Reset navigation index
   */
  resetIndex(): void {
    this.currentIndex = this.history.length;
  }

  /**
   * Get all commands as strings (for readline history)
   */
  getCommands(): string[] {
    return this.history.map(entry => entry.command);
  }

  /**
   * Load history from disk
   */
  private async loadHistory(): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(HISTORY_FILE));

      if (await fs.pathExists(HISTORY_FILE)) {
        const content = await fs.readFile(HISTORY_FILE, 'utf-8');
        const data = JSON.parse(content);

        if (Array.isArray(data)) {
          this.history = data.map(entry => ({
            ...entry,
            timestamp: new Date(entry.timestamp),
          }));
          this.currentIndex = this.history.length;
        }
      }
    } catch (error) {
      // Ignore errors, start with empty history
      console.error('Failed to load history:', error);
    }
  }

  /**
   * Save history to disk
   */
  private async saveHistory(): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(HISTORY_FILE));
      await fs.writeFile(
        HISTORY_FILE,
        JSON.stringify(this.history, null, 2),
        'utf-8'
      );
    } catch (error) {
      // Ignore errors
      console.error('Failed to save history:', error);
    }
  }

  /**
   * Create history entry from command
   */
  createEntry(
    command: string,
    args: any,
    namespace?: string,
    success = true,
    duration = 0
  ): HistoryEntry {
    return {
      id: randomUUID(),
      timestamp: new Date(),
      command,
      args,
      namespace,
      success,
      duration,
    };
  }
}

/**
 * Command history for simple string-based history (readline integration)
 */
export class CommandHistory {
  commands: string[] = [];

  add(command: string): void {
    if (command.trim()) {
      this.commands.push(command);

      if (this.commands.length > MAX_HISTORY_SIZE) {
        this.commands = this.commands.slice(-MAX_HISTORY_SIZE);
      }
    }
  }

  get(index: number): string | undefined {
    return this.commands[index];
  }

  last(n = 1): string[] {
    return this.commands.slice(-n);
  }

  search(query: string): string[] {
    const lowerQuery = query.toLowerCase();
    return this.commands.filter(cmd =>
      cmd.toLowerCase().includes(lowerQuery)
    );
  }

  clear(): void {
    this.commands = [];
  }

  toArray(): string[] {
    return [...this.commands];
  }
}
