/**
 * Plugin Template Generator
 *
 * Scaffolds new plugins from templates
 */

import fs from 'fs-extra';
import path from 'path';
import { logger } from '../utils/logger.js';

export type PluginTemplateType = 'typescript' | 'python';

export interface PluginScaffoldOptions {
  name: string;
  description?: string;
  author?: string;
  template: PluginTemplateType;
  outputPath: string;
}

/**
 * Plugin Template Generator Class
 */
export class PluginTemplateGenerator {
  /**
   * Generate plugin scaffold
   */
  async generate(options: PluginScaffoldOptions): Promise<string> {
    const { name, description, author, template, outputPath } = options;

    const pluginPath = path.join(outputPath, name);

    // Check if directory already exists
    if (await fs.pathExists(pluginPath)) {
      throw new Error(`Directory already exists: ${pluginPath}`);
    }

    try {
      // Create plugin directory
      await fs.ensureDir(pluginPath);

      // Generate based on template type
      if (template === 'typescript') {
        await this.generateTypeScriptPlugin(name, pluginPath, description, author);
      } else if (template === 'python') {
        await this.generatePythonPlugin(name, pluginPath, description, author);
      } else {
        throw new Error(`Unknown template type: ${template}`);
      }

      logger.info(`Plugin scaffolded successfully at: ${pluginPath}`);
      return pluginPath;
    } catch (error) {
      // Cleanup on failure
      await fs.remove(pluginPath);
      throw error;
    }
  }

  /**
   * Generate TypeScript plugin
   */
  private async generateTypeScriptPlugin(
    name: string,
    pluginPath: string,
    description?: string,
    author?: string
  ): Promise<void> {
    // Create directory structure
    await fs.ensureDir(path.join(pluginPath, 'src'));
    await fs.ensureDir(path.join(pluginPath, 'src', 'commands'));
    await fs.ensureDir(path.join(pluginPath, 'dist'));

    // plugin.json
    const pluginJson = {
      name,
      version: '1.0.0',
      description: description || `${name} plugin for Nexus CLI`,
      author: author || 'Plugin Developer',
      main: 'dist/index.js',
      commands: [
        {
          name: 'greet',
          description: 'Greet the user',
          args: [
            {
              name: 'name',
              type: 'string',
              required: true,
              description: 'Name to greet',
            },
          ],
        },
      ],
      permissions: [
        {
          type: 'file',
          scope: 'read',
          level: 'read',
        },
      ],
      dependencies: [],
    };

    await fs.writeFile(
      path.join(pluginPath, 'plugin.json'),
      JSON.stringify(pluginJson, null, 2)
    );

    // src/index.ts
    const indexContent = `/**
 * ${name} Plugin
 *
 * ${description || `Example plugin for Nexus CLI`}
 */

import { PluginBuilder } from '@adverant-nexus/cli-sdk';
import { greetCommand } from './commands/greet.js';

export default PluginBuilder.create('${name}')
  .version('1.0.0')
  .description('${description || `${name} plugin for Nexus CLI`}')
  .author('${author || 'Plugin Developer'}')

  .command('greet', {
    description: 'Greet the user',
    args: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'Name to greet',
      },
    ],
    handler: greetCommand,
  })

  .onLoad(async () => {
    console.log('${name} plugin loaded');
  })

  .onUnload(async () => {
    console.log('${name} plugin unloaded');
  })

  .build();
`;

    await fs.writeFile(path.join(pluginPath, 'src', 'index.ts'), indexContent);

    // src/commands/greet.ts
    const greetCommandContent = `/**
 * Greet Command
 */

import type { PluginCommandHandler } from '@adverant-nexus/cli-sdk';

export const greetCommand: PluginCommandHandler = async (args, context) => {
  const { name } = args;

  context.logger.info(\`Hello, \${name}! Welcome to ${name} plugin.\`);

  return {
    success: true,
    message: \`Greeted \${name} successfully\`,
  };
};
`;

    await fs.writeFile(
      path.join(pluginPath, 'src', 'commands', 'greet.ts'),
      greetCommandContent
    );

    // package.json
    const packageJson = {
      name: `@nexus-plugin/${name}`,
      version: '1.0.0',
      description: description || `${name} plugin for Nexus CLI`,
      main: 'dist/index.js',
      type: 'module',
      scripts: {
        build: 'tsc',
        'build:watch': 'tsc --watch',
        dev: 'tsc --watch',
        clean: 'rm -rf dist',
      },
      keywords: ['nexus', 'plugin', name],
      author: author || 'Plugin Developer',
      license: 'MIT',
      dependencies: {
        '@adverant-nexus/cli-sdk': '^2.0.0',
      },
      devDependencies: {
        typescript: '^5.3.3',
        '@types/node': '^20.10.5',
      },
    };

    await fs.writeFile(
      path.join(pluginPath, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // tsconfig.json
    const tsconfigJson = {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        lib: ['ES2022'],
        outDir: './dist',
        rootDir: './src',
        moduleResolution: 'node',
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    };

    await fs.writeFile(
      path.join(pluginPath, 'tsconfig.json'),
      JSON.stringify(tsconfigJson, null, 2)
    );

    // README.md
    const readmeContent = `# ${name}

${description || `Example plugin for Nexus CLI`}

## Installation

\`\`\`bash
# Install dependencies
npm install

# Build plugin
npm run build
\`\`\`

## Usage

\`\`\`bash
# Install plugin to Nexus CLI
nexus plugin install .

# Enable plugin
nexus plugin enable ${name}

# Use plugin command
nexus plugin ${name} greet "World"
\`\`\`

## Development

\`\`\`bash
# Watch mode
npm run dev

# Build
npm run build
\`\`\`

## Commands

### greet

Greet the user.

\`\`\`bash
nexus plugin ${name} greet <name>
\`\`\`

## License

MIT
`;

    await fs.writeFile(path.join(pluginPath, 'README.md'), readmeContent);

    // .gitignore
    const gitignoreContent = `node_modules/
dist/
*.log
.DS_Store
*.tsbuildinfo
`;

    await fs.writeFile(path.join(pluginPath, '.gitignore'), gitignoreContent);
  }

  /**
   * Generate Python plugin
   */
  private async generatePythonPlugin(
    name: string,
    pluginPath: string,
    description?: string,
    author?: string
  ): Promise<void> {
    // Create directory structure
    await fs.ensureDir(path.join(pluginPath, 'src'));
    await fs.ensureDir(path.join(pluginPath, 'src', 'commands'));

    // plugin.json
    const pluginJson = {
      name,
      version: '1.0.0',
      description: description || `${name} plugin for Nexus CLI`,
      author: author || 'Plugin Developer',
      main: 'src/main.py',
      commands: [
        {
          name: 'greet',
          description: 'Greet the user',
          args: [
            {
              name: 'name',
              type: 'string',
              required: true,
              description: 'Name to greet',
            },
          ],
        },
      ],
      permissions: [
        {
          type: 'file',
          scope: 'read',
          level: 'read',
        },
      ],
      dependencies: [],
    };

    await fs.writeFile(
      path.join(pluginPath, 'plugin.json'),
      JSON.stringify(pluginJson, null, 2)
    );

    // src/__init__.py
    await fs.writeFile(path.join(pluginPath, 'src', '__init__.py'), '');

    // src/main.py
    const mainContent = `"""
${name} Plugin

${description || `Example plugin for Nexus CLI`}
"""

from typing import Dict, Any
from .commands.greet import greet_command

# Plugin definition
plugin = {
    'name': '${name}',
    'version': '1.0.0',
    'description': '${description || `${name} plugin for Nexus CLI`}',
    'author': '${author || 'Plugin Developer'}',
    'commands': {
        'greet': greet_command
    }
}

def on_load():
    """Called when plugin is loaded"""
    print('${name} plugin loaded')

def on_unload():
    """Called when plugin is unloaded"""
    print('${name} plugin unloaded')
`;

    await fs.writeFile(path.join(pluginPath, 'src', 'main.py'), mainContent);

    // src/commands/__init__.py
    await fs.writeFile(path.join(pluginPath, 'src', 'commands', '__init__.py'), '');

    // src/commands/greet.py
    const greetCommandContent = `"""
Greet Command
"""

from typing import Dict, Any

async def greet_command(args: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Greet the user

    Args:
        args: Command arguments
        context: Plugin context

    Returns:
        Command result
    """
    name = args.get('name')

    context.logger.info(f'Hello, {name}! Welcome to ${name} plugin.')

    return {
        'success': True,
        'message': f'Greeted {name} successfully'
    }
`;

    await fs.writeFile(
      path.join(pluginPath, 'src', 'commands', 'greet.py'),
      greetCommandContent
    );

    // pyproject.toml
    const pyprojectContent = `[tool.poetry]
name = "${name}"
version = "1.0.0"
description = "${description || `${name} plugin for Nexus CLI`}"
authors = ["${author || 'Plugin Developer'}"]
license = "MIT"

[tool.poetry.dependencies]
python = "^3.9"

[tool.poetry.dev-dependencies]
pytest = "^7.0"
black = "^23.0"
mypy = "^1.0"

[build-system]
requires = ["poetry-core>=1.0.0"]
build-backend = "poetry.core.masonry.api"
`;

    await fs.writeFile(path.join(pluginPath, 'pyproject.toml'), pyprojectContent);

    // README.md
    const readmeContent = `# ${name}

${description || `Example plugin for Nexus CLI`}

## Installation

\`\`\`bash
# Install dependencies
poetry install

# Or with pip
pip install -e .
\`\`\`

## Usage

\`\`\`bash
# Install plugin to Nexus CLI
nexus plugin install .

# Enable plugin
nexus plugin enable ${name}

# Use plugin command
nexus plugin ${name} greet "World"
\`\`\`

## Commands

### greet

Greet the user.

\`\`\`bash
nexus plugin ${name} greet <name>
\`\`\`

## License

MIT
`;

    await fs.writeFile(path.join(pluginPath, 'README.md'), readmeContent);

    // .gitignore
    const gitignoreContent = `__pycache__/
*.py[cod]
*$py.class
*.so
.Python
venv/
env/
.venv/
.env
.pytest_cache/
.mypy_cache/
dist/
build/
*.egg-info/
`;

    await fs.writeFile(path.join(pluginPath, '.gitignore'), gitignoreContent);
  }
}

/**
 * Singleton instance
 */
export const pluginTemplateGenerator = new PluginTemplateGenerator();
