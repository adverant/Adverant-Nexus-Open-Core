/**
 * Dynamic Commands Index
 *
 * Export all dynamically generated service commands
 */

export { graphragCommands } from './graphrag-commands.js';
export { mageagentCommands } from './mageagent-commands.js';
export { sandboxCommands } from './sandbox-commands.js';

import { graphragCommands } from './graphrag-commands.js';
import { mageagentCommands } from './mageagent-commands.js';
import { sandboxCommands } from './sandbox-commands.js';

export const allDynamicCommands = [
  ...graphragCommands,
  ...mageagentCommands,
  ...sandboxCommands,
];
