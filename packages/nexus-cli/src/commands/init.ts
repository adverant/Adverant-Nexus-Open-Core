/**
 * nexus-cli init command
 * Scaffolds a new plugin project
 */

import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { generateTypescriptTemplate } from '../templates/typescript.js';
import { generatePythonTemplate } from '../templates/python.js';
import { validateEmail, validatePluginName, isValidationError } from '../utils/validation.js';

interface InitOptions {
  template: 'typescript' | 'python';
  directory: string;
}

export async function initCommand(name: string, options: InitOptions): Promise<void> {
  console.log(chalk.blue(`\n🚀 Initializing plugin: ${chalk.bold(name)}\n`));

  // Validate plugin name format
  const nameValidation = validatePluginName(name);
  if (isValidationError(nameValidation)) {
    console.error(chalk.red(`\n✗ ${nameValidation}`));
    console.error(chalk.yellow('\nPlugin name requirements:'));
    console.error(chalk.white('  - Must start with a letter'));
    console.error(chalk.white('  - Lowercase letters, numbers, and hyphens only'));
    console.error(chalk.white('  - Cannot end with a hyphen'));
    console.error(chalk.white('  - Length: 3-50 characters'));
    console.error(chalk.gray('\n  Examples: my-plugin, data-processor, auth-manager\n'));
    process.exit(1);
  }

  const targetDir = path.join(options.directory, name);

  // Check if directory exists
  if (await fs.pathExists(targetDir)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Directory ${name} already exists. Overwrite?`,
        default: false
      }
    ]);

    if (!overwrite) {
      console.log(chalk.yellow('Aborted.'));
      return;
    }

    await fs.remove(targetDir);
  }

  const spinner = ora('Creating plugin project...').start();

  try {
    // Collect plugin information
    spinner.stop();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'displayName',
        message: 'Display name:',
        default: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description:',
        default: 'A Nexus Nexus plugin'
      },
      {
        type: 'input',
        name: 'author',
        message: 'Author name:'
      },
      {
        type: 'input',
        name: 'email',
        message: 'Author email:',
        validate: (input: string) => {
          const result = validateEmail(input);
          return isValidationError(result) ? result : true;
        }
      },
      {
        type: 'list',
        name: 'category',
        message: 'Category:',
        choices: [
          'productivity',
          'development',
          'data_analysis',
          'security',
          'healthcare',
          'finance',
          'education',
          'communication',
          'entertainment',
          'other'
        ]
      },
      {
        type: 'list',
        name: 'pricingModel',
        message: 'Pricing model:',
        choices: ['free', 'paid', 'freemium', 'usage_based']
      }
    ]);

    spinner.start('Generating project files...');

    // Generate template based on type
    if (options.template === 'typescript') {
      await generateTypescriptTemplate(targetDir, {
        name,
        ...answers
      });
    } else {
      await generatePythonTemplate(targetDir, {
        name,
        ...answers
      });
    }

    spinner.succeed(chalk.green('Plugin project created successfully!'));

    // Print next steps
    console.log(chalk.cyan('\n📋 Next steps:\n'));
    console.log(chalk.white(`  cd ${name}`));
    console.log(chalk.white(`  npm install`));
    console.log(chalk.white(`  npm run dev`));
    console.log(chalk.white(`  nexus-cli register`));
    console.log(chalk.white(`  nexus-cli deploy\n`));

  } catch (error) {
    spinner.fail(chalk.red('Failed to create plugin project'));
    console.error(error);
    throw error;
  }
}
