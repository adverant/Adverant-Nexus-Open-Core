/**
 * Repository Analyze Command
 *
 * Full repository analysis with AI-powered insights
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { CommandResult } from '../../types/command.js';

interface AnalyzeOptions {
  branch?: string;
  depth: 'quick' | 'standard' | 'deep';
  security: boolean;
  force: boolean;
  output?: string;
  outputFormat: string;
  mageagentUrl: string;
  graphragUrl: string;
  noAi: boolean;
}

export function createRepoAnalyzeCommand(): Command {
  const command = new Command('analyze')
    .description('Analyze a repository with AI-powered insights')
    .argument('<target>', 'Repository URL or local path')
    .option('-b, --branch <branch>', 'Branch to analyze', 'main')
    .option(
      '-d, --depth <level>',
      'Analysis depth: quick, standard, or deep',
      'standard'
    )
    .option('--security', 'Include security scan', true)
    .option('--no-security', 'Disable security scan')
    .option('-f, --force', 'Force re-analysis (ignore cache)', false)
    .option('-o, --output <path>', 'Output file path for .arch.md')
    .option('--output-format <format>', 'Output format (text|json|yaml)', 'text')
    .option(
      '--mageagent-url <url>',
      'MageAgent service URL',
      process.env.MAGEAGENT_URL || 'http://localhost:9010'
    )
    .option(
      '--graphrag-url <url>',
      'GraphRAG service URL for caching',
      process.env.GRAPHRAG_URL || 'http://localhost:8090'
    )
    .option('--no-ai', 'Disable AI analysis (fast mode)')
    .action(async (target: string, options: AnalyzeOptions) => {
      try {
        const result = await analyzeRepository(target, options);

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else if (options.outputFormat === 'yaml') {
          // Simple YAML output for basic results
          console.log(formatAsYaml(result));
        }

        process.exit(result.success ? 0 : 1);
      } catch (error) {
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  return command;
}

/**
 * Execute repository analysis
 */
async function analyzeRepository(
  target: string,
  options: AnalyzeOptions
): Promise<CommandResult> {
  const spinner = ora({
    text: chalk.cyan('Initializing repository analyzer...'),
    color: 'cyan',
  }).start();

  try {
    // Dynamically import the analyzer to avoid loading heavy deps if not needed
    const { RepositoryAnalyzer } = await import('@adverant/repo-analyzer');

    const analyzer = new RepositoryAnalyzer({
      mageAgentUrl: options.mageagentUrl,
      graphRagUrl: options.graphragUrl,
      enableAiAnalysis: !options.noAi,
    });

    // Determine if target is URL or local path
    const isUrl =
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('git@');

    const isLocalPath = !isUrl && existsSync(resolve(target));

    if (!isUrl && !isLocalPath) {
      spinner.fail(chalk.red('Invalid target: not a valid URL or local path'));
      return {
        success: false,
        error: 'Invalid target',
        message: 'Target must be a valid repository URL or local directory path',
      };
    }

    spinner.text = chalk.cyan('Starting analysis...');

    // Run analysis with progress callback
    const analysis = await analyzer.analyze(
      {
        repoUrl: isUrl ? target : `file://${resolve(target)}`,
        branch: options.branch,
        analysisDepth: options.depth,
        includeSecurityScan: options.security,
        force: options.force,
      },
      undefined,
      (progress) => {
        spinner.text = chalk.cyan(
          `[${progress.progress}%] ${progress.currentStep}`
        );
      }
    );

    spinner.succeed(chalk.green('Analysis complete'));

    // Display results
    if (options.outputFormat === 'text') {
      displayTextResults(analysis.result);
    }

    // Write output file if specified
    if (options.output && analysis.result?.archMd) {
      const { writeFileSync } = await import('fs');
      const outputPath = resolve(options.output);
      writeFileSync(outputPath, analysis.result.archMd, 'utf-8');
      console.log(chalk.green(`\nArchitecture documentation written to: ${outputPath}`));
    }

    return {
      success: true,
      data: analysis.result,
      message: `Analysis completed for ${target}`,
      metadata: {
        duration: analysis.usage?.durationMs,
        service: 'repo-analyzer',
      },
    };
  } catch (error) {
    spinner.fail(chalk.red('Analysis failed'));

    // Check if it's a module not found error
    if (
      error instanceof Error &&
      error.message.includes('Cannot find module')
    ) {
      console.log(
        chalk.yellow('\nNote: @adverant/repo-analyzer package not found.')
      );
      console.log(
        chalk.gray('Install it with: npm install @adverant/repo-analyzer')
      );
    }

    throw error;
  }
}

/**
 * Display text results in terminal
 */
function displayTextResults(result: any): void {
  if (!result) {
    console.log(chalk.yellow('\nNo analysis results available'));
    return;
  }

  console.log('\n' + chalk.bold.underline('Repository Analysis Results'));
  console.log('');

  // Repository type
  if (result.detectedType) {
    console.log(
      chalk.bold('Repository Type: ') +
        chalk.cyan(result.detectedType.primaryType)
    );
    if (result.detectedType.confidence) {
      console.log(
        chalk.gray(`  Confidence: ${Math.round(result.detectedType.confidence * 100)}%`)
      );
    }
  }

  // Tech stack
  if (result.techStack && result.techStack.length > 0) {
    console.log('');
    console.log(chalk.bold('Tech Stack:'));
    const grouped = groupTechStack(result.techStack);
    for (const [category, techs] of Object.entries(grouped)) {
      console.log(chalk.gray(`  ${category}: `) + chalk.white(techs.join(', ')));
    }
  }

  // Architecture patterns
  if (result.patterns && result.patterns.length > 0) {
    console.log('');
    console.log(chalk.bold('Architecture Patterns:'));
    for (const pattern of result.patterns) {
      console.log(chalk.gray('  - ') + chalk.white(pattern));
    }
  }

  // AI insights
  if (result.aiInsights) {
    console.log('');
    console.log(chalk.bold('AI Insights:'));
    if (result.aiInsights.summary) {
      console.log(chalk.gray('  Summary: ') + result.aiInsights.summary);
    }
    if (result.aiInsights.recommendations) {
      console.log(chalk.gray('  Recommendations:'));
      for (const rec of result.aiInsights.recommendations) {
        console.log(chalk.gray('    - ') + rec);
      }
    }
  }

  // Security findings
  if (result.securityFindings && result.securityFindings.length > 0) {
    console.log('');
    console.log(chalk.bold('Security Findings:'));
    for (const finding of result.securityFindings) {
      const severity = finding.severity || 'info';
      const color =
        severity === 'critical'
          ? chalk.red
          : severity === 'high'
          ? chalk.yellow
          : severity === 'medium'
          ? chalk.cyan
          : chalk.gray;
      console.log(color(`  [${severity.toUpperCase()}] ${finding.message}`));
    }
  }

  console.log('');
}

/**
 * Group tech stack by category
 */
function groupTechStack(techStack: string[]): Record<string, string[]> {
  const categories: Record<string, string[]> = {
    Languages: [],
    Frameworks: [],
    Databases: [],
    Tools: [],
  };

  const languagePatterns = [
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'java',
    'kotlin',
    'swift',
    'ruby',
    'php',
    'c#',
    'c++',
  ];
  const frameworkPatterns = [
    'react',
    'vue',
    'angular',
    'nextjs',
    'express',
    'fastapi',
    'django',
    'flask',
    'nestjs',
    'spring',
    'rails',
  ];
  const dbPatterns = [
    'postgres',
    'mysql',
    'mongodb',
    'redis',
    'neo4j',
    'qdrant',
    'elasticsearch',
    'sqlite',
  ];

  for (const tech of techStack) {
    const lower = tech.toLowerCase();
    if (languagePatterns.some((p) => lower.includes(p))) {
      categories['Languages'].push(tech);
    } else if (frameworkPatterns.some((p) => lower.includes(p))) {
      categories['Frameworks'].push(tech);
    } else if (dbPatterns.some((p) => lower.includes(p))) {
      categories['Databases'].push(tech);
    } else {
      categories['Tools'].push(tech);
    }
  }

  // Remove empty categories
  return Object.fromEntries(
    Object.entries(categories).filter(([_, v]) => v.length > 0)
  );
}

/**
 * Simple YAML formatter
 */
function formatAsYaml(result: CommandResult): string {
  const lines: string[] = [];

  function formatValue(value: any, indent: number = 0): void {
    const prefix = '  '.repeat(indent);

    if (value === null || value === undefined) {
      lines.push('null');
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object') {
          lines.push(`${prefix}-`);
          formatValue(item, indent + 1);
        } else {
          lines.push(`${prefix}- ${item}`);
        }
      }
      return;
    }

    if (typeof value === 'object') {
      for (const [key, val] of Object.entries(value)) {
        if (typeof val === 'object' && val !== null) {
          lines.push(`${prefix}${key}:`);
          formatValue(val, indent + 1);
        } else {
          lines.push(`${prefix}${key}: ${val}`);
        }
      }
      return;
    }

    lines.push(`${prefix}${value}`);
  }

  formatValue(result);
  return lines.join('\n');
}

export default createRepoAnalyzeCommand;
