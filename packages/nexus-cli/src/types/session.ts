/**
 * Session Type Definitions
 *
 * Types for session management, checkpointing, and history
 */

import type { CommandArgs, CommandResult } from './command.js';
import type { WorkspaceInfo } from './command.js';

export interface Session {
  id: string;
  name: string;
  created: Date;
  updated: Date;
  context: SessionContext;
  history: HistoryEntry[];
  results: SessionResult[];
  nexusMemories: string[]; // Linked Nexus memory IDs
  metadata: SessionMetadata;
}

export interface SessionContext {
  workspace?: WorkspaceInfo;
  cwd: string;
  config: any;
  environment: Record<string, string>;
  services: Record<string, any>;
}

export interface HistoryEntry {
  id: string;
  timestamp: Date;
  command: string;
  args: CommandArgs;
  namespace?: string;
  success: boolean;
  duration: number;
}

export interface SessionResult {
  historyId: string;
  timestamp: Date;
  result: CommandResult;
  output?: string;
}

export interface SessionMetadata {
  totalCommands: number;
  successfulCommands: number;
  failedCommands: number;
  totalDuration: number;
  lastCommand?: string;
  tags: string[];
}

export interface SessionStorage {
  save(session: Session): Promise<void>;
  load(nameOrId: string): Promise<Session | null>;
  list(): Promise<SessionSummary[]>;
  delete(nameOrId: string): Promise<void>;
  export(nameOrId: string): Promise<string>;
  import(data: string): Promise<Session>;
}

export interface SessionSummary {
  id: string;
  name: string;
  created: Date;
  updated: Date;
  commandCount: number;
  tags: string[];
}

export interface HistoryManager {
  add(entry: HistoryEntry): void;
  get(id: string): HistoryEntry | undefined;
  list(limit?: number): HistoryEntry[];
  search(query: string): HistoryEntry[];
  clear(): void;
}

export interface CommandHistory {
  commands: string[];
  add(command: string): void;
  get(index: number): string | undefined;
  last(n?: number): string[];
  search(query: string): string[];
  clear(): void;
}
