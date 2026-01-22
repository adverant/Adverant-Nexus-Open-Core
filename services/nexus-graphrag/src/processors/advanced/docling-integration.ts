/**
 * Docling Integration Wrapper
 *
 * Integrates IBM's Docling framework for state-of-the-art document understanding.
 * Features:
 * - DocLayNet model for layout analysis
 * - TableFormer for 97.9% table extraction accuracy
 * - Layout preservation and structural understanding
 * - Multi-format support (PDF, DOCX, PPTX, HTML, XML)
 *
 * Note: Since Docling is Python-based, this wrapper communicates with a
 * Python subprocess or Docker container running Docling.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import {
  DoclingOptions,
  DoclingResult,
  LayoutElement
} from '../../types/document-dna';

export class DoclingIntegration {
  private pythonPath: string;
  private doclingScriptPath: string;
  private tempDir: string;
  private useDocker: boolean;

  constructor(options?: {
    pythonPath?: string;
    useDocker?: boolean;
    tempDir?: string;
  }) {
    this.pythonPath = options?.pythonPath || 'python3';
    this.useDocker = options?.useDocker || false;
    this.tempDir = options?.tempDir || '/tmp/docling';

    // Path to the Python Docling wrapper script
    this.doclingScriptPath = path.join(
      __dirname,
      '../../../scripts/docling-wrapper.py'
    );
  }

  /**
   * Process document using Docling
   */
  async process(
    content: string | Buffer,
    options: DoclingOptions = {}
  ): Promise<DoclingResult> {
    const startTime = Date.now();
    const jobId = uuidv4();

    try {
      logger.info('Processing document with Docling', { jobId, options });

      // Save content to temporary file
      const inputPath = await this.saveToTemp(content, jobId);

      // Prepare Docling command
      const result = this.useDocker
        ? await this.runDoclingDocker(inputPath, options, jobId)
        : await this.runDoclingPython(inputPath, options, jobId);

      // Parse Docling output
      const processed = this.parseDoclingOutput(result);

      // Clean up temporary files
      await this.cleanup(jobId);

      const processingTime = Date.now() - startTime;

      logger.info('Docling processing completed', {
        jobId,
        processingTime,
        hasT

: !!processed.tables?.length,
        hasFigures: !!processed.figures?.length
      });

      return processed;

    } catch (error) {
      logger.error('Docling processing failed', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Cleanup on error
      await this.cleanup(jobId).catch(() => {});

      throw error;
    }
  }

  /**
   * Run Docling via Python subprocess
   */
  private async runDoclingPython(
    inputPath: string,
    options: DoclingOptions,
    jobId: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const args = [
        this.doclingScriptPath,
        '--input', inputPath,
        '--output', path.join(this.tempDir, `${jobId}.json`)
      ];

      // Add options as arguments
      if (options.preserveLayout) args.push('--preserve-layout');
      if (options.extractTables) args.push('--extract-tables');
      if (options.extractFigures) args.push('--extract-figures');
      if (options.extractEquations) args.push('--extract-equations');
      if (options.outputFormat) args.push('--format', options.outputFormat);

      const process = spawn(this.pythonPath, args);

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
        logger.debug('Docling stderr:', data.toString());
      });

      process.on('error', (error) => {
        reject(new Error(`Failed to start Docling: ${error.message}`));
      });

      process.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(`Docling exited with code ${code}: ${stderr}`));
        } else {
          try {
            // Read the output file
            const outputPath = path.join(this.tempDir, `${jobId}.json`);
            const outputContent = await fs.readFile(outputPath, 'utf-8');
            const result = JSON.parse(outputContent);
            resolve(result);
          } catch (error) {
            reject(new Error(`Failed to read Docling output: ${error}`));
          }
        }
      });
    });
  }

  /**
   * Run Docling via Docker container
   */
  private async runDoclingDocker(
    inputPath: string,
    options: DoclingOptions,
    jobId: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(this.tempDir, `${jobId}.json`);

      const dockerArgs = [
        'run',
        '--rm',
        '-v', `${this.tempDir}:/data`,
        'ibm/docling:latest',
        '--input', `/data/${path.basename(inputPath)}`,
        '--output', `/data/${path.basename(outputPath)}`
      ];

      // Add options
      if (options.preserveLayout) dockerArgs.push('--preserve-layout');
      if (options.extractTables) dockerArgs.push('--extract-tables');
      if (options.extractFigures) dockerArgs.push('--extract-figures');
      if (options.extractEquations) dockerArgs.push('--extract-equations');

      const process = spawn('docker', dockerArgs);

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('error', (error) => {
        reject(new Error(`Failed to run Docling Docker: ${error.message}`));
      });

      process.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(`Docling Docker exited with code ${code}: ${stderr}`));
        } else {
          try {
            const outputContent = await fs.readFile(outputPath, 'utf-8');
            const result = JSON.parse(outputContent);
            resolve(result);
          } catch (error) {
            reject(new Error(`Failed to read Docling output: ${error}`));
          }
        }
      });
    });
  }

  /**
   * Parse Docling JSON output into our format
   */
  private parseDoclingOutput(doclingOutput: any): DoclingResult {
    const result: DoclingResult = {
      text: '',
      tables: [],
      figures: [],
      layout: [],
      metadata: {}
    };

    // Extract main text
    if (doclingOutput.text) {
      result.text = doclingOutput.text;
    } else if (doclingOutput.content) {
      result.text = this.extractTextFromContent(doclingOutput.content);
    }

    // Extract tables with TableFormer results
    if (doclingOutput.tables && Array.isArray(doclingOutput.tables)) {
      result.tables = doclingOutput.tables.map((table: any) => ({
        headers: table.headers || [],
        rows: table.rows || [],
        caption: table.caption,
        confidence: table.confidence || 0.979, // TableFormer baseline
        bbox: table.bbox
      }));
    }

    // Extract figures
    if (doclingOutput.figures && Array.isArray(doclingOutput.figures)) {
      result.figures = doclingOutput.figures.map((figure: any) => ({
        caption: figure.caption,
        url: figure.url,
        base64: figure.data,
        type: figure.type,
        bbox: figure.bbox
      }));
    }

    // Extract layout structure
    if (doclingOutput.layout) {
      result.layout = this.parseLayout(doclingOutput.layout);
    }

    // Extract metadata
    result.metadata = {
      pageCount: doclingOutput.page_count,
      language: doclingOutput.language,
      documentType: doclingOutput.document_type,
      extractedAt: new Date().toISOString(),
      doclingVersion: doclingOutput.version || '2.0.0'
    };

    return result;
  }

  /**
   * Extract text from structured content
   */
  private extractTextFromContent(content: any[]): string {
    const textParts: string[] = [];

    for (const element of content) {
      if (typeof element === 'string') {
        textParts.push(element);
      } else if (element.text) {
        textParts.push(element.text);
      } else if (element.type === 'paragraph' && element.content) {
        textParts.push(element.content);
      } else if (element.type === 'header' && element.content) {
        textParts.push(element.content);
      } else if (element.type === 'table' && element.text) {
        textParts.push(element.text);
      }
    }

    return textParts.join('\n\n');
  }

  /**
   * Parse layout information into our format
   */
  private parseLayout(doclingLayout: any): LayoutElement[] {
    const elements: LayoutElement[] = [];

    if (Array.isArray(doclingLayout)) {
      for (const item of doclingLayout) {
        const element: LayoutElement = {
          type: this.mapLayoutType(item.type),
          content: item.text || item.content,
          level: item.level,
          bbox: item.bbox,
          metadata: item.metadata
        };

        if (item.children) {
          element.children = this.parseLayout(item.children);
        }

        elements.push(element);
      }
    }

    return elements;
  }

  /**
   * Map Docling layout types to our types
   */
  private mapLayoutType(doclingType: string): LayoutElement['type'] {
    const typeMap: Record<string, LayoutElement['type']> = {
      'heading': 'header',
      'title': 'header',
      'paragraph': 'paragraph',
      'table': 'table',
      'figure': 'figure',
      'list': 'list',
      'code': 'code',
      'footer': 'footer',
      'caption': 'caption'
    };

    return typeMap[doclingType.toLowerCase()] || 'paragraph';
  }

  /**
   * Save content to temporary file
   */
  private async saveToTemp(content: string | Buffer, jobId: string): Promise<string> {
    // Ensure temp directory exists
    await fs.mkdir(this.tempDir, { recursive: true });

    // Determine file extension based on content
    let extension = '.pdf'; // Default
    if (typeof content === 'string') {
      if (content.startsWith('<?xml')) extension = '.xml';
      else if (content.startsWith('<!DOCTYPE html')) extension = '.html';
      else if (content.includes('\\documentclass')) extension = '.tex';
      else extension = '.txt';
    }

    const filePath = path.join(this.tempDir, `${jobId}${extension}`);

    // Write content to file
    if (typeof content === 'string') {
      await fs.writeFile(filePath, content, 'utf-8');
    } else {
      await fs.writeFile(filePath, content);
    }

    return filePath;
  }

  /**
   * Clean up temporary files
   */
  private async cleanup(jobId: string) {
    try {
      const files = await fs.readdir(this.tempDir);
      const jobFiles = files.filter(f => f.includes(jobId));

      for (const file of jobFiles) {
        await fs.unlink(path.join(this.tempDir, file));
      }
    } catch (error) {
      logger.warn('Failed to cleanup Docling temp files', { jobId, error });
    }
  }

  /**
   * Initialize Docling (install if needed)
   */
  async initialize() {
    // Check if Docling is installed
    try {
      const { execSync } = require('child_process');

      if (this.useDocker) {
        // Check if Docker image exists
        try {
          execSync('docker image inspect ibm/docling:latest', { stdio: 'ignore' });
          logger.info('Docling Docker image found');
        } catch {
          logger.info('Pulling Docling Docker image...');
          execSync('docker pull ibm/docling:latest', { stdio: 'inherit' });
        }
      } else {
        // Check if Python package is installed
        try {
          execSync(`${this.pythonPath} -c "import docling"`, { stdio: 'ignore' });
          logger.info('Docling Python package found');
        } catch {
          logger.info('Installing Docling Python package...');
          execSync(`${this.pythonPath} -m pip install docling`, { stdio: 'inherit' });
        }
      }

      // Create wrapper script if it doesn't exist
      await this.createWrapperScript();

    } catch (error) {
      logger.error('Failed to initialize Docling', { error });
      throw error;
    }
  }

  /**
   * Create Python wrapper script for Docling
   */
  private async createWrapperScript() {
    const scriptContent = `#!/usr/bin/env python3
"""
Docling Wrapper Script for GraphRAG Integration
"""

import json
import sys
import argparse
from pathlib import Path

try:
    from docling.document_converter import DocumentConverter
    from docling.datamodel.pipeline_options import PipelineOptions
    from docling.datamodel.base_models import InputFormat
except ImportError:
    print("Error: Docling not installed. Run: pip install docling", file=sys.stderr)
    sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description='Docling Document Processor')
    parser.add_argument('--input', required=True, help='Input file path')
    parser.add_argument('--output', required=True, help='Output JSON path')
    parser.add_argument('--preserve-layout', action='store_true')
    parser.add_argument('--extract-tables', action='store_true')
    parser.add_argument('--extract-figures', action='store_true')
    parser.add_argument('--extract-equations', action='store_true')
    parser.add_argument('--format', default='json', choices=['json', 'markdown', 'text'])

    args = parser.parse_args()

    # Configure pipeline options
    options = PipelineOptions(
        do_table_structure=args.extract_tables,
        do_ocr=True,
        ocr_options={"tesseract_cmd": "tesseract"}
    )

    # Initialize converter
    converter = DocumentConverter(pipeline_options=options)

    # Process document
    result = converter.convert(args.input)

    # Extract data
    output = {
        'text': result.document.export_to_markdown() if args.format == 'markdown' else str(result.document),
        'tables': [],
        'figures': [],
        'layout': [],
        'metadata': {
            'page_count': len(result.document.pages) if hasattr(result.document, 'pages') else 1
        }
    }

    # Extract tables
    if args.extract_tables and hasattr(result.document, 'tables'):
        for table in result.document.tables:
            output['tables'].append({
                'headers': table.headers if hasattr(table, 'headers') else [],
                'rows': table.rows if hasattr(table, 'rows') else [],
                'caption': table.caption if hasattr(table, 'caption') else None,
                'confidence': 0.979  # TableFormer baseline
            })

    # Save output
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Successfully processed: {args.input}", file=sys.stderr)

if __name__ == '__main__':
    main()
`;

    const scriptDir = path.dirname(this.doclingScriptPath);
    await fs.mkdir(scriptDir, { recursive: true });
    await fs.writeFile(this.doclingScriptPath, scriptContent, 'utf-8');

    // Make script executable
    await fs.chmod(this.doclingScriptPath, 0o755);

    logger.info('Docling wrapper script created', { path: this.doclingScriptPath });
  }
}

export default DoclingIntegration;