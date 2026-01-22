import { ChunkingStrategy, CodeUnit, CodeStructure } from './base-strategy';
import { ChunkingOptions, Chunk } from '../types';
import { logger } from '../utils/logger';

export class CodeChunkingStrategy extends ChunkingStrategy {
  async chunk(content: string, options: ChunkingOptions): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const lines = content.split('\n');
    
    // Parse code structure based on language
    const structure = await this.parseCodeStructure(content, options.metadata.language || 'javascript');
    
    // Chunk by logical units (functions, classes, modules)
    for (const unit of structure.units) {
      const unitContent = lines.slice(unit.startLine, unit.endLine + 1).join('\n');
      const tokens = this.estimateTokens(unitContent);
      
      if (tokens <= options.maxTokens) {
        // Single chunk for the unit
        chunks.push(this.createChunk(
          unitContent,
          unit.type as Chunk['type'],
          {
            start: unit.startChar,
            end: unit.endChar,
            line_start: unit.startLine,
            line_end: unit.endLine
          },
          {
            function_name: unit.name,
            language: options.metadata.language,
            dependencies: unit.dependencies,
            importance_score: unit.importance,
            semantic_density: 0.8,
            contains_key_info: true
          },
          options.metadata.id!
        ));
      } else {
        // Split large units into smaller chunks
        const subChunks = await this.splitLargeCodeUnit(unit, unitContent, options);
        chunks.push(...subChunks);
      }
    }
    
    // Add imports/exports as a separate chunk if they exist
    if (structure.imports.length > 0) {
      const importsContent = structure.imports.join('\n');
      chunks.unshift(this.createChunk(
        importsContent,
        'code_block',
        {
          start: 0,
          end: importsContent.length,
          line_start: 0,
          line_end: structure.imports.length - 1
        },
        {
          language: options.metadata.language,
          importance_score: 0.9,
          semantic_density: 0.6,
          contains_key_info: true,
          dependencies: this.extractImportDependencies(structure.imports)
        },
        options.metadata.id!
      ));
    }
    
    logger.debug('Code chunking completed', { 
      documentId: options.metadata.id,
      language: options.metadata.language,
      unitsFound: structure.units.length,
      chunksCreated: chunks.length 
    });
    
    return chunks;
  }
  
  private async parseCodeStructure(content: string, language: string): Promise<CodeStructure> {
    // This is a simplified parser. In production, you'd use proper parsers like:
    // - tree-sitter for multi-language support
    // - babel for JavaScript/TypeScript
    // - ast module for Python
    
    switch (language) {
      case 'javascript':
      case 'typescript':
      case 'jsx':
      case 'tsx':
        return this.parseJavaScriptStructure(content);
      case 'python':
        return this.parsePythonStructure(content);
      case 'java':
      case 'csharp':
        return this.parseClassBasedStructure(content, language);
      default:
        return this.parseGenericStructure(content);
    }
  }
  
  private parseJavaScriptStructure(content: string): CodeStructure {
    const structure: CodeStructure = {
      units: [],
      imports: [],
      exports: []
    };
    
    const lines = content.split('\n');
    let currentPosition = 0;
    
    // Extract imports
    const importRegex = /^(import|const|let|var)\s+.*\s+from\s+['"]/;
    const requireRegex = /require\s*\(['"]/;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (importRegex.test(line) || requireRegex.test(line)) {
        structure.imports.push(line);
      }
      
      // Function detection
      const functionMatch = line.match(/^(export\s+)?(async\s+)?function\s+(\w+)|^(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?\(/);
      if (functionMatch) {
        const functionName = functionMatch[3] || functionMatch[5];
        const startLine = i;
        const endLine = this.findFunctionEnd(lines, i);
        
        structure.units.push({
          type: 'function',
          name: functionName,
          startLine,
          endLine,
          startChar: currentPosition,
          endChar: currentPosition + lines.slice(startLine, endLine + 1).join('\n').length,
          dependencies: this.extractFunctionDependencies(lines.slice(startLine, endLine + 1)),
          importance: 0.8
        });
      }
      
      // Class detection
      const classMatch = line.match(/^(export\s+)?(abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        const className = classMatch[3];
        const startLine = i;
        const endLine = this.findClassEnd(lines, i);
        
        structure.units.push({
          type: 'class',
          name: className,
          startLine,
          endLine,
          startChar: currentPosition,
          endChar: currentPosition + lines.slice(startLine, endLine + 1).join('\n').length,
          dependencies: this.extractClassDependencies(lines.slice(startLine, endLine + 1)),
          importance: 0.9
        });
      }
      
      currentPosition += line.length + 1; // +1 for newline
    }
    
    return structure;
  }
  
  private parsePythonStructure(content: string): CodeStructure {
    const structure: CodeStructure = {
      units: [],
      imports: [],
      exports: []
    };
    
    const lines = content.split('\n');
    let currentPosition = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Import detection
      if (line.match(/^(from|import)\s+/)) {
        structure.imports.push(line);
      }
      
      // Function detection
      const functionMatch = line.match(/^def\s+(\w+)\s*\(/);
      if (functionMatch) {
        const functionName = functionMatch[1];
        const startLine = i;
        const endLine = this.findPythonBlockEnd(lines, i);
        
        structure.units.push({
          type: 'function',
          name: functionName,
          startLine,
          endLine,
          startChar: currentPosition,
          endChar: currentPosition + lines.slice(startLine, endLine + 1).join('\n').length,
          dependencies: [],
          importance: 0.8
        });
      }
      
      // Class detection
      const classMatch = line.match(/^class\s+(\w+)/);
      if (classMatch) {
        const className = classMatch[1];
        const startLine = i;
        const endLine = this.findPythonBlockEnd(lines, i);
        
        structure.units.push({
          type: 'class',
          name: className,
          startLine,
          endLine,
          startChar: currentPosition,
          endChar: currentPosition + lines.slice(startLine, endLine + 1).join('\n').length,
          dependencies: [],
          importance: 0.9
        });
      }
      
      currentPosition += line.length + 1;
    }
    
    return structure;
  }
  
  private parseClassBasedStructure(content: string, language: string): CodeStructure {
    // Simplified parser for Java/C# style languages
    const structure: CodeStructure = {
      units: [],
      imports: [],
      exports: []
    };
    
    const lines = content.split('\n');
    let currentPosition = 0;
    
    const importPattern = language === 'java' ? /^import\s+/ : /^using\s+/;
    const classPattern = /^(public\s+)?(abstract\s+)?(class|interface)\s+(\w+)/;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (importPattern.test(line)) {
        structure.imports.push(line);
      } else if (classPattern.test(line)) {
        const match = line.match(classPattern)!;
        const className = match[4];
        const startLine = i;
        const endLine = this.findBlockEnd(lines, i);
        
        structure.units.push({
          type: 'class',
          name: className,
          startLine,
          endLine,
          startChar: currentPosition,
          endChar: currentPosition + lines.slice(startLine, endLine + 1).join('\n').length,
          dependencies: [],
          importance: 0.9
        });
      }
      
      currentPosition += line.length + 1;
    }
    
    return structure;
  }
  
  private parseGenericStructure(content: string): CodeStructure {
    // Fallback for unknown languages - chunk by size
    const structure: CodeStructure = {
      units: [],
      imports: [],
      exports: []
    };
    
    const lines = content.split('\n');
    const blockSize = 50; // Lines per block
    
    for (let i = 0; i < lines.length; i += blockSize) {
      const startLine = i;
      const endLine = Math.min(i + blockSize - 1, lines.length - 1);
      lines.slice(startLine, endLine + 1);

      structure.units.push({
        type: 'block',
        name: `block_${Math.floor(i / blockSize)}`,
        startLine,
        endLine,
        startChar: this.getCharPosition(lines, startLine),
        endChar: this.getCharPosition(lines, endLine + 1),
        dependencies: [],
        importance: 0.5
      });
    }
    
    return structure;
  }
  
  private async splitLargeCodeUnit(unit: CodeUnit, content: string, options: ChunkingOptions): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const lines = content.split('\n');
    
    let currentChunk = '';
    let currentTokens = 0;
    let startLine = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = this.estimateTokens(line);
      
      if (currentTokens + lineTokens > options.maxTokens && currentChunk) {
        // Save current chunk
        chunks.push(this.createChunk(
          currentChunk,
          unit.type as Chunk['type'],
          {
            start: this.getCharPosition(lines, unit.startLine + startLine),
            end: this.getCharPosition(lines, unit.startLine + i),
            line_start: unit.startLine + startLine,
            line_end: unit.startLine + i - 1
          },
          {
            function_name: `${unit.name}_part${chunks.length + 1}`,
            language: options.metadata.language,
            dependencies: unit.dependencies,
            importance_score: unit.importance,
            semantic_density: 0.7,
            contains_key_info: chunks.length === 0 // First chunk is most important
          },
          options.metadata.id!
        ));
        
        // Start new chunk with overlap
        const overlapLines = Math.min(5, i - startLine);
        currentChunk = lines.slice(i - overlapLines, i + 1).join('\n');
        currentTokens = this.estimateTokens(currentChunk);
        startLine = i - overlapLines;
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
        currentTokens += lineTokens;
      }
    }
    
    // Add final chunk
    if (currentChunk) {
      chunks.push(this.createChunk(
        currentChunk,
        unit.type as Chunk['type'],
        {
          start: this.getCharPosition(lines, unit.startLine + startLine),
          end: this.getCharPosition(lines, unit.startLine + lines.length),
          line_start: unit.startLine + startLine,
          line_end: unit.startLine + lines.length - 1
        },
        {
          function_name: `${unit.name}_part${chunks.length + 1}`,
          language: options.metadata.language,
          dependencies: unit.dependencies,
          importance_score: unit.importance * 0.8,
          semantic_density: 0.7,
          contains_key_info: false
        },
        options.metadata.id!
      ));
    }
    
    return chunks;
  }
  
  private findFunctionEnd(lines: string[], startLine: number): number {
    let braceCount = 0;
    let inFunction = false;
    
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      
      for (const char of line) {
        if (char === '{') {
          braceCount++;
          inFunction = true;
        } else if (char === '}') {
          braceCount--;
          if (inFunction && braceCount === 0) {
            return i;
          }
        }
      }
    }
    
    return lines.length - 1;
  }
  
  private findClassEnd(lines: string[], startLine: number): number {
    return this.findFunctionEnd(lines, startLine); // Same brace counting logic
  }
  
  private findPythonBlockEnd(lines: string[], startLine: number): number {
    const indentMatch = lines[startLine].match(/^(\s*)/);
    const baseIndent = indentMatch ? indentMatch[1].length : 0;
    
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue; // Skip empty lines
      
      const currentIndentMatch = line.match(/^(\s*)/);
      const currentIndent = currentIndentMatch ? currentIndentMatch[1].length : 0;
      
      if (currentIndent <= baseIndent && line.trim() !== '') {
        return i - 1;
      }
    }
    
    return lines.length - 1;
  }
  
  private findBlockEnd(lines: string[], startLine: number): number {
    let braceCount = 0;
    
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;
      
      if (braceCount === 0 && i > startLine) {
        return i;
      }
    }
    
    return lines.length - 1;
  }
  
  private getCharPosition(lines: string[], lineNumber: number): number {
    let position = 0;
    for (let i = 0; i < lineNumber && i < lines.length; i++) {
      position += lines[i].length + 1; // +1 for newline
    }
    return position;
  }
  
  private extractFunctionDependencies(lines: string[]): string[] {
    const dependencies: Set<string> = new Set();
    const content = lines.join('\n');
    
    // Look for function calls
    const functionCallRegex = /(\w+)\s*\(/g;
    let match;
    while ((match = functionCallRegex.exec(content)) !== null) {
      const functionName = match[1];
      // Filter out common keywords
      if (!['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(functionName)) {
        dependencies.add(functionName);
      }
    }
    
    return Array.from(dependencies);
  }
  
  private extractClassDependencies(lines: string[]): string[] {
    const dependencies: Set<string> = new Set();
    const content = lines.join('\n');
    
    // Look for class instantiations and extends
    const newRegex = /new\s+(\w+)/g;
    const extendsRegex = /extends\s+(\w+)/g;
    
    let match;
    while ((match = newRegex.exec(content)) !== null) {
      dependencies.add(match[1]);
    }
    while ((match = extendsRegex.exec(content)) !== null) {
      dependencies.add(match[1]);
    }
    
    return Array.from(dependencies);
  }
  
  private extractImportDependencies(imports: string[]): string[] {
    const dependencies: string[] = [];
    
    for (const imp of imports) {
      // Extract module names from various import styles
      const fromMatch = imp.match(/from\s+['"](.*?)['"]/);
      const requireMatch = imp.match(/require\s*\(['"](.*?)['"]\)/);
      const importMatch = imp.match(/import\s+.*\s+from\s+['"](.*?)['"]/);
      
      const moduleName = fromMatch?.[1] || requireMatch?.[1] || importMatch?.[1];
      if (moduleName) {
        dependencies.push(moduleName);
      }
    }
    
    return dependencies;
  }
}
