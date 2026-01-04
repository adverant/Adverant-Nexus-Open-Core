/**
 * Command Type Definitions
 *
 * Types for command registration, execution, and handling
 */

import type { ServiceMetadata } from './service.js';
import type { OutputFormat } from './output.js';

export interface Command {
  name: string;
  namespace?: string;
  description: string;
  aliases?: string[];

  // Arguments
  args?: ArgumentDefinition[];
  options?: OptionDefinition[];

  // Execution
  handler: CommandHandler;
  validator?: CommandValidator;

  // Metadata
  examples?: string[];
  usage?: string;
  category?: string;
  hidden?: boolean;

  // Features
  streaming?: boolean;
  requiresAuth?: boolean;
  requiresWorkspace?: boolean;
}

export interface ArgumentDefinition {
  name: string;
  description: string;
  required: boolean;
  type: ArgumentType;
  default?: any;
  choices?: any[];
  variadic?: boolean;
}

export interface OptionDefinition {
  short?: string;
  long: string;
  description: string;
  required?: boolean;
  type: ArgumentType;
  default?: any;
  choices?: any[];
  env?: string; // Environment variable name
}

export type ArgumentType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'file'
  | 'directory'
  | 'url'
  | 'json';

export type CommandHandler = (
  args: CommandArgs,
  context: CommandContext
) => Promise<CommandResult>;

export type CommandValidator = (
  args: CommandArgs,
  context: CommandContext
) => Promise<ValidationResult>;

export interface CommandArgs {
  _: string[]; // Positional arguments
  [key: string]: any; // Named options
}

export interface CommandContext {
  cwd: string;
  config: any;
  workspace?: WorkspaceInfo;
  services: Map<string, ServiceMetadata>;
  verbose: boolean;
  quiet: boolean;
  outputFormat: OutputFormat;
  transport: any; // Transport layer
}

export interface WorkspaceInfo {
  root: string;
  type: 'typescript' | 'python' | 'go' | 'rust' | 'java' | 'unknown';
  git: boolean;
  branch?: string;
  config?: any;
  dockerCompose: string[];
}

export interface CommandResult {
  success: boolean;
  data?: any;
  message?: string;
  error?: Error | string;
  metadata?: {
    duration?: number;
    service?: string;
    streaming?: boolean;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

export interface CommandRegistry {
  register(command: Command): void;
  unregister(name: string, namespace?: string): void;
  get(name: string, namespace?: string): Command | undefined;
  list(namespace?: string): Command[];
  has(name: string, namespace?: string): boolean;
}

export interface DynamicCommandSource {
  namespace: string;
  discover(): Promise<Command[]>;
  refresh(): Promise<void>;
}
