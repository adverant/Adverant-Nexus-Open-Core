/**
 * Plugin Init Command
 *
 * Initialize a new plugin from template
 */

import { Command } from 'commander';
import prompts from 'prompts';
import ora from 'ora';
import chalk from 'chalk';
import path from 'path';
import {
  pluginTemplateGenerator,
  type PluginTemplateType,
} from '../../plugins/template-generator.js';
import { logger } from '../../utils/logger.js';

export const initCommand = new Command('init')
  .description('Initialize a new plugin from template')
  .argument('<name>', 'Plugin name')
  .option('-t, --template <type>', 'Template type (typescript|python)', 'typescript')
  .option('-d, --description <desc>', 'Plugin description')
  .option('-a, --author <author>', 'Plugin author')
  .option('-o, --output <path>', 'Output directory', '.')
  .option('-y, --yes', 'Skip prompts and use defaults')
  .action(async (name: string, options) => {
    try {
      let template = options.template as PluginTemplateType;
      let description = options.description;
      let author = options.author;
      const outputPath = options.output;

      // Interactive prompts if not using --yes
      if (!options.yes) {
        const responses = await prompts([
          {
            type: 'select',
            name: 'template',
            message: 'Select plugin template:',
            choices: [
              { title: 'TypeScript', value: 'typescript' },
              { title: 'Python', value: 'python' },
            ],
            initial: template === 'typescript' ? 0 : 1,
          },
          {
            type: 'text',
            name: 'description',
            message: 'Plugin description:',
            initial: description || `${name} plugin for Nexus CLI`,
          },
          {
            type: 'text',
            name: 'author',
            message: 'Author name:',
            initial: author || 'Plugin Developer',
          },
        ]);

        template = responses.template || template;
        description = responses.description || description;
        author = responses.author || author;
      }

      // Generate plugin
      const spinner = ora('Generating plugin scaffold...').start();

      const pluginPath = await pluginTemplateGenerator.generate({
        name,
        description,
        author,
        template,
        outputPath,
      });

      spinner.succeed('Plugin scaffold generated successfully!');

      // Show next steps
      console.log();
      console.log(chalk.bold('Next steps:'));
      console.log();
      console.log(`  1. cd ${path.relative(process.cwd(), pluginPath)}`);
      console.log(`  2. npm install`);
      console.log(`  3. npm run build`);
      console.log(`  4. nexus plugin install .`);
      console.log();
      console.log(chalk.dim('For more info, see README.md'));
    } catch (error) {
      logger.error('Failed to initialize plugin:', error);
      process.exit(1);
    }
  });
