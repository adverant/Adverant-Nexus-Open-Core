/**
 * TypeScript plugin template generator
 */

import fs from 'fs-extra';
import path from 'path';

interface TemplateConfig {
  name: string;
  displayName: string;
  description: string;
  author: string;
  email: string;
  category: string;
  pricingModel: string;
}

export async function generateTypescriptTemplate(
  targetDir: string,
  config: TemplateConfig
): Promise<void> {
  // Create directory structure
  await fs.ensureDir(targetDir);
  await fs.ensureDir(path.join(targetDir, 'src'));
  await fs.ensureDir(path.join(targetDir, 'src', 'tools'));

  // package.json
  const packageJson = {
    name: `@nexus-plugins/${config.name}`,
    version: '1.0.0',
    description: config.description,
    main: 'dist/index.js',
    type: 'module',
    scripts: {
      build: 'tsc',
      dev: 'tsx watch src/index.ts',
      start: 'node dist/index.js',
      test: 'jest',
      lint: 'eslint src/**/*.ts',
      typecheck: 'tsc --noEmit'
    },
    keywords: ['nexus', 'nexus', 'plugin', config.category],
    author: `${config.author} <${config.email}>`,
    license: 'MIT',
    dependencies: {
      '@adverant-nexus/sdk': '^1.0.0',
      'zod': '^3.22.4'
    },
    devDependencies: {
      '@types/node': '^20.10.5',
      '@typescript-eslint/eslint-plugin': '^6.15.0',
      '@typescript-eslint/parser': '^6.15.0',
      'eslint': '^8.56.0',
      'jest': '^29.7.0',
      'ts-jest': '^29.1.1',
      'tsx': '^4.6.2',
      'typescript': '^5.3.3'
    }
  };

  await fs.writeJson(path.join(targetDir, 'package.json'), packageJson, { spaces: 2 });

  // tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'node',
      lib: ['ES2022'],
      outDir: './dist',
      rootDir: './src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist']
  };

  await fs.writeJson(path.join(targetDir, 'tsconfig.json'), tsConfig, { spaces: 2 });

  // plugin.json
  const pluginJson = {
    name: config.name,
    displayName: config.displayName,
    description: config.description,
    version: '1.0.0',
    author: {
      name: config.author,
      email: config.email
    },
    category: config.category,
    tags: [config.category],
    pricingModel: config.pricingModel
  };

  await fs.writeJson(path.join(targetDir, 'plugin.json'), pluginJson, { spaces: 2 });

  // src/index.ts
  const indexTs = `import { NexusPluginServer } from '@adverant-nexus/sdk';
import { greetTool } from './tools/greet.js';
import { exampleTool } from './tools/example.js';

// Load plugin configuration
import pluginConfig from '../plugin.json' assert { type: 'json' };

// Create plugin server
const server = new NexusPluginServer(pluginConfig);

// Register tools
server
  .tool(greetTool)
  .tool(exampleTool);

// Start the server
server.start();
`;

  await fs.writeFile(path.join(targetDir, 'src', 'index.ts'), indexTs);

  // src/tools/greet.ts
  const greetToolTs = `import { ToolDefinition } from '@adverant-nexus/sdk';
import { z } from 'zod';

const GreetSchema = z.object({
  name: z.string().min(1, 'Name is required')
});

export const greetTool: ToolDefinition = {
  name: 'greet',
  description: 'Greets a user by name',
  inputSchema: GreetSchema,
  handler: async (args) => {
    const { name } = args;

    return {
      content: [{
        type: 'text',
        text: \`👋 Hello, \${name}! Welcome to ${config.displayName}!\`
      }]
    };
  }
};
`;

  await fs.writeFile(path.join(targetDir, 'src', 'tools', 'greet.ts'), greetToolTs);

  // src/tools/example.ts
  const exampleToolTs = `import { ToolDefinition, NexusClient } from '@adverant-nexus/sdk';
import { z } from 'zod';

const ExampleSchema = z.object({
  data: z.string(),
  save: z.boolean().optional()
});

// Optional: Create Nexus API client for accessing Nexus's 100+ tools
const nexusClient = new NexusClient({
  apiKey: process.env.NEXUS_API_KEY || ''
});

export const exampleTool: ToolDefinition = {
  name: 'example',
  description: 'Example tool that demonstrates Nexus integration',
  inputSchema: ExampleSchema,
  handler: async (args) => {
    const { data, save } = args;

    // Process the data
    const result = \`Processed: \${data.toUpperCase()}\`;

    // Optionally save to Nexus memory
    if (save) {
      try {
        await nexusClient.storeMemory({
          content: result,
          tags: ['${config.name}', 'example'],
          metadata: {
            plugin: '${config.name}',
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('Failed to store in Nexus:', error);
      }
    }

    return {
      content: [{
        type: 'text',
        text: result
      }]
    };
  }
};
`;

  await fs.writeFile(path.join(targetDir, 'src', 'tools', 'example.ts'), exampleToolTs);

  // .env.example
  const envExample = `# Nexus API Configuration
NEXUS_API_KEY=your_api_key_here
NEXUS_API_URL=http://nexus-api-gateway:8092

# Plugin Configuration
NODE_ENV=development
LOG_LEVEL=info
`;

  await fs.writeFile(path.join(targetDir, '.env.example'), envExample);

  // .gitignore
  const gitignore = `node_modules/
dist/
.env
*.log
.DS_Store
`;

  await fs.writeFile(path.join(targetDir, '.gitignore'), gitignore);

  // README.md
  const readme = `# ${config.displayName}

${config.description}

## Installation

\`\`\`bash
npm install
\`\`\`

## Development

\`\`\`bash
# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
\`\`\`

## Tools

### greet
Greets a user by name.

**Input:**
\`\`\`json
{
  "name": "Alice"
}
\`\`\`

**Output:**
\`\`\`
👋 Hello, Alice! Welcome to ${config.displayName}!
\`\`\`

### example
Example tool that demonstrates Nexus integration.

**Input:**
\`\`\`json
{
  "data": "test",
  "save": true
}
\`\`\`

## Deployment

\`\`\`bash
# Login to Nexus Nexus
nexus-cli login

# Register plugin
nexus-cli register

# Deploy to staging
nexus-cli deploy --environment staging

# Deploy to production
nexus-cli deploy --environment production
\`\`\`

## Configuration

Configure your plugin in \`plugin.json\`:

\`\`\`json
${JSON.stringify(pluginJson, null, 2)}
\`\`\`

## License

MIT © ${config.author}
`;

  await fs.writeFile(path.join(targetDir, 'README.md'), readme);
}
