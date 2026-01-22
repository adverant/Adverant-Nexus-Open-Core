/**
 * Prompt Utilities for Nexus CLI
 *
 * Provides interactive prompts for user input
 */

import inquirer from 'inquirer';
import prompts from 'prompts';

/**
 * Prompt for text input
 */
export async function promptText(
  message: string,
  defaultValue?: string,
  validate?: (input: string) => true | string
): Promise<string> {
  const { value } = await inquirer.prompt([
    {
      type: 'input',
      name: 'value',
      message,
      default: defaultValue,
      validate,
    },
  ]);

  return value;
}

/**
 * Prompt for password input (hidden)
 */
export async function promptPassword(
  message: string,
  validate?: (input: string) => true | string
): Promise<string> {
  const { value } = await inquirer.prompt([
    {
      type: 'password',
      name: 'value',
      message,
      mask: '*',
      validate,
    },
  ]);

  return value;
}

/**
 * Prompt for confirmation (yes/no)
 */
export async function promptConfirm(
  message: string,
  defaultValue = false
): Promise<boolean> {
  const { value } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'value',
      message,
      default: defaultValue,
    },
  ]);

  return value;
}

/**
 * Prompt for selection from a list
 */
export async function promptSelect<T = string>(
  message: string,
  choices: Array<{ name: string; value: T; description?: string }>,
  defaultValue?: T
): Promise<T> {
  const { value } = await inquirer.prompt([
    {
      type: 'list',
      name: 'value',
      message,
      choices,
      default: defaultValue,
    },
  ]);

  return value;
}

/**
 * Prompt for multiple selections from a list
 */
export async function promptMultiSelect<T = string>(
  message: string,
  choices: Array<{ name: string; value: T; checked?: boolean }>,
  validate?: (input: T[]) => true | string
): Promise<T[]> {
  const { value } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'value',
      message,
      choices,
      validate,
    },
  ]);

  return value;
}

/**
 * Prompt with autocomplete
 */
export async function promptAutocomplete(
  message: string,
  choices: string[],
  defaultValue?: string
): Promise<string> {
  const result = await prompts({
    type: 'autocomplete',
    name: 'value',
    message,
    choices: choices.map(c => ({ title: c, value: c })),
    initial: defaultValue,
  });

  if (result.value === undefined) {
    throw new Error('Prompt was cancelled');
  }

  return result.value;
}

/**
 * Prompt for number input
 */
export async function promptNumber(
  message: string,
  defaultValue?: number,
  validate?: (input: number) => true | string
): Promise<number> {
  const { value } = await inquirer.prompt([
    {
      type: 'number',
      name: 'value',
      message,
      default: defaultValue,
      validate,
    },
  ]);

  return value;
}

/**
 * Prompt for editor input (multiline)
 */
export async function promptEditor(
  message: string,
  defaultValue?: string
): Promise<string> {
  const { value } = await inquirer.prompt([
    {
      type: 'editor',
      name: 'value',
      message,
      default: defaultValue,
    },
  ]);

  return value;
}

/**
 * Generic prompt function that handles any prompt type
 */
export async function prompt<T = any>(
  type: 'input' | 'password' | 'confirm' | 'list' | 'checkbox' | 'editor' | 'number',
  message: string,
  options: {
    default?: any;
    choices?: Array<{ name: string; value: any }>;
    validate?: (input: any) => true | string;
  } = {}
): Promise<T> {
  const { value } = await inquirer.prompt([
    {
      type,
      name: 'value',
      message,
      ...options,
    } as any,
  ]);

  return value;
}
