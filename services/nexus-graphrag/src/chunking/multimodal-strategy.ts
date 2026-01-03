import { v4 as uuidv4 } from 'uuid';
import { ChunkingStrategy } from './base-strategy';
import { ChunkingOptions, Chunk } from '../types';
import { logger } from '../utils/logger';
import axios from 'axios';

interface ImageReference {
  id: string;
  type: 'image' | 'diagram' | 'chart';
  source: string;
  alt?: string;
  caption?: string;
  position: {
    start: number;
    end: number;
  };
  base64?: string;
  description?: string;
}

export class MultimodalChunkingStrategy extends ChunkingStrategy {
  private readonly imagePattern = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']([^"']+)["'][^>]*>/g;
  private readonly diagramPattern = /```(?:mermaid|plantuml|graphviz|dot)\n([\s\S]*?)```/g;
  private readonly chartPattern = /```(?:chart|vega|plotly)\n([\s\S]*?)```/g;
  
  async chunk(content: string, options: ChunkingOptions): Promise<Chunk[]> {
    logger.info('Starting multimodal chunking', { 
      documentId: options.metadata.id 
    });
    
    // Extract all multimodal elements
    const images = await this.extractImages(content);
    const diagrams = this.extractDiagrams(content);
    const charts = this.extractCharts(content);
    
    // Process images with vision API if available
    const processedImages = await this.processImagesWithVision(images);
    
    // Create content segments with placeholders
    const segments = this.segmentContentWithPlaceholders(
      content, 
      [...processedImages, ...diagrams, ...charts]
    );
    
    // Chunk the segments intelligently
    const chunks: Chunk[] = [];
    
    for (const segment of segments) {
      if (segment.type === 'text') {
        // Text chunking with awareness of nearby images
        const textChunks = await this.chunkTextSegment(
          segment.content, 
          segment.nearbyImages,
          options
        );
        chunks.push(...textChunks);
      } else if (segment.type === 'image') {
        // Create dedicated chunk for image with description
        const imageChunk = this.createImageChunk(segment, options);
        chunks.push(imageChunk);
      } else if (segment.type === 'diagram' || segment.type === 'chart') {
        // Create dedicated chunk for diagrams/charts
        const visualChunk = this.createVisualChunk(segment, options);
        chunks.push(visualChunk);
      }
    }
    
    // Ensure chunks maintain references to related visual content
    return this.linkVisualReferences(chunks, processedImages);
  }
  
  private async extractImages(content: string): Promise<ImageReference[]> {
    const images: ImageReference[] = [];
    let match;
    
    while ((match = this.imagePattern.exec(content)) !== null) {
      const image: ImageReference = {
        id: uuidv4(),
        type: 'image',
        source: match[2] || match[3], // Markdown or HTML format
        alt: match[1] || this.extractAltFromHtml(match[0]),
        position: {
          start: match.index,
          end: match.index + match[0].length
        }
      };
      
      // Extract caption if present (usually follows the image)
      const captionMatch = content.substring(image.position.end).match(/^\s*(?:<figcaption>|_)([^<\n]+)(?:<\/figcaption>|_)/);
      if (captionMatch) {
        image.caption = captionMatch[1];
        image.position.end += captionMatch.index! + captionMatch[0].length;
      }
      
      images.push(image);
    }
    
    return images;
  }
  
  private extractDiagrams(content: string): ImageReference[] {
    const diagrams: ImageReference[] = [];
    let match;
    
    this.diagramPattern.lastIndex = 0;
    while ((match = this.diagramPattern.exec(content)) !== null) {
      diagrams.push({
        id: uuidv4(),
        type: 'diagram',
        source: match[1],
        position: {
          start: match.index,
          end: match.index + match[0].length
        },
        description: `Diagram code: ${match[1].substring(0, 100)}...`
      });
    }
    
    return diagrams;
  }
  
  private extractCharts(content: string): ImageReference[] {
    const charts: ImageReference[] = [];
    let match;
    
    this.chartPattern.lastIndex = 0;
    while ((match = this.chartPattern.exec(content)) !== null) {
      charts.push({
        id: uuidv4(),
        type: 'chart',
        source: match[1],
        position: {
          start: match.index,
          end: match.index + match[0].length
        },
        description: `Chart specification: ${match[1].substring(0, 100)}...`
      });
    }
    
    return charts;
  }
  
  private async processImagesWithVision(images: ImageReference[]): Promise<ImageReference[]> {
    const processedImages = [];
    
    for (const image of images) {
      try {
        // For external URLs, fetch and process
        if (image.source.startsWith('http')) {
          const description = await this.generateImageDescription(image.source);
          processedImages.push({
            ...image,
            description
          });
        } else if (image.source.startsWith('data:')) {
          // Base64 encoded images
          const base64Data = image.source.split(',')[1];
          const description = await this.generateImageDescriptionFromBase64(base64Data);
          processedImages.push({
            ...image,
            base64: base64Data,
            description
          });
        } else {
          // Local file references - store path for later processing
          processedImages.push({
            ...image,
            description: `Local image: ${image.alt || 'No description'}`
          });
        }
      } catch (error) {
        logger.error('Failed to process image with vision API', { error, imageId: image.id });
        processedImages.push({
          ...image,
          description: image.alt || 'Image processing failed'
        });
      }
    }
    
    return processedImages;
  }
  
  private async generateImageDescription(imageUrl: string): Promise<string> {
    try {
      // Use OpenAI Vision API or similar
      // This is where we'd make a real API call to a vision model
      // For now, implementing with OpenRouter's multimodal support
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-4-vision-preview',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe this image in detail for a document retrieval system. Include any text, diagrams, or important visual elements.'
              },
              {
                type: 'image_url',
                image_url: { url: imageUrl }
              }
            ]
          }],
          temperature: 0.3,
          max_tokens: 300
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data.choices[0].message.content;
    } catch (error) {
      logger.error('Vision API call failed', { error, imageUrl });
      throw error;
    }
  }
  
  private async generateImageDescriptionFromBase64(base64Data: string): Promise<string> {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-4-vision-preview',
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe this image in detail for a document retrieval system.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Data}`
                }
              }
            ]
          }],
          temperature: 0.3,
          max_tokens: 300
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data.choices[0].message.content;
    } catch (error) {
      logger.error('Vision API call failed for base64 image', { error });
      throw error;
    }
  }
  
  private segmentContentWithPlaceholders(
    content: string, 
    visualElements: ImageReference[]
  ): any[] {
    // Sort visual elements by position
    const sortedElements = visualElements.sort((a, b) => a.position.start - b.position.start);
    
    const segments = [];
    let lastEnd = 0;
    
    for (const element of sortedElements) {
      // Add text segment before this visual element
      if (element.position.start > lastEnd) {
        segments.push({
          type: 'text',
          content: content.substring(lastEnd, element.position.start),
          nearbyImages: this.findNearbyImages(lastEnd, element.position.start, visualElements)
        });
      }
      
      // Add the visual element segment
      segments.push({
        type: element.type,
        element,
        content: content.substring(element.position.start, element.position.end)
      });
      
      lastEnd = element.position.end;
    }
    
    // Add final text segment
    if (lastEnd < content.length) {
      segments.push({
        type: 'text',
        content: content.substring(lastEnd),
        nearbyImages: []
      });
    }
    
    return segments;
  }
  
  private async chunkTextSegment(
    text: string, 
    nearbyImages: ImageReference[],
    options: ChunkingOptions
  ): Promise<Chunk[]> {
    // Use semantic text chunking with awareness of nearby images
    const { TextChunkingStrategy } = await import('./text-strategy');
    const textStrategy = new TextChunkingStrategy();
    
    const baseChunks = await textStrategy.chunk(text, options);
    
    // Enhance chunks with image references
    return baseChunks.map(chunk => ({
      ...chunk,
      metadata: {
        ...chunk.metadata,
        nearbyImages: nearbyImages.map(img => ({
          id: img.id,
          description: img.description || img.alt || 'Image'
        }))
      }
    }));
  }
  
  private createImageChunk(segment: any, options: ChunkingOptions): Chunk {
    const image = segment.element;
    const content = [
      `[IMAGE: ${image.alt || 'Untitled'}]`,
      image.description || '',
      image.caption ? `Caption: ${image.caption}` : '',
      `Source: ${image.source}`
    ].filter(Boolean).join('\n');
    
    return {
      id: uuidv4(),
      document_id: options.metadata.id!,
      content,
      type: 'image',
      position: image.position,
      metadata: {
        image_id: image.id,
        image_type: image.type,
        has_description: !!image.description,
        importance_score: 0.8, // Images are generally important
        semantic_density: 0.9, // High information density
        contains_key_info: true
      },
      tokens: this.estimateTokens(content)
    };
  }
  
  private createVisualChunk(segment: any, options: ChunkingOptions): Chunk {
    const visual = segment.element;
    const content = [
      `[${visual.type.toUpperCase()}: ${visual.type} specification]`,
      visual.description || '',
      'Code:',
      visual.source.substring(0, 500) + (visual.source.length > 500 ? '...' : '')
    ].join('\n');
    
    return {
      id: uuidv4(),
      document_id: options.metadata.id!,
      content,
      type: visual.type === 'diagram' ? 'image' : 'table', // Map to supported chunk types
      position: visual.position,
      metadata: {
        visual_type: visual.type,
        code_length: visual.source.length,
        importance_score: 0.7,
        semantic_density: 0.8,
        contains_key_info: true
      },
      tokens: this.estimateTokens(content)
    };
  }
  
  private linkVisualReferences(chunks: Chunk[], images: ImageReference[]): Chunk[] {
    // Create a map of image positions for quick lookup
    new Map(images.map(img => [img.id, img]));
    
    // For each text chunk, check if it references any images
    return chunks.map(chunk => {
      if (chunk.type !== 'image') {
        // Look for references like "see Figure 1" or "as shown in the diagram"
        const referencePattern = /(?:see|shown in|refer to|figure|diagram|image|chart)\s*(?:\d+|above|below)/gi;
        const matches = chunk.content.match(referencePattern);
        
        if (matches) {
          // Find the closest image chunks
          const referencedImages = this.findReferencedImages(chunk, chunks, matches);
          
          return {
            ...chunk,
            metadata: {
              ...chunk.metadata,
              referencedImages: referencedImages.map(img => img.id)
            }
          };
        }
      }
      
      return chunk;
    });
  }
  
  private findNearbyImages(start: number, end: number, images: ImageReference[]): ImageReference[] {
    // Find images within a reasonable distance (e.g., 500 characters)
    const threshold = 500;
    
    return images.filter(img => {
      const distance = Math.min(
        Math.abs(img.position.start - end),
        Math.abs(img.position.end - start)
      );
      return distance <= threshold;
    });
  }
  
  private findReferencedImages(
    textChunk: Chunk, 
    allChunks: Chunk[], 
    references: string[]
  ): Chunk[] {
    const imageChunks = allChunks.filter(c => c.type === 'image');
    const referencedImages: Chunk[] = [];
    
    for (const ref of references) {
      // Check for numbered references
      const numberMatch = ref.match(/\d+/);
      if (numberMatch) {
        const index = parseInt(numberMatch[0]) - 1;
        if (imageChunks[index]) {
          referencedImages.push(imageChunks[index]);
        }
      }
      
      // Check for positional references
      if (ref.includes('above') || ref.includes('below')) {
        const textPos = textChunk.position.start;
        const nearestImage = ref.includes('above') 
          ? imageChunks.filter(img => img.position.end < textPos).pop()
          : imageChunks.find(img => img.position.start > textChunk.position.end);
        
        if (nearestImage) {
          referencedImages.push(nearestImage);
        }
      }
    }
    
    return referencedImages;
  }
  
  private extractAltFromHtml(htmlImg: string): string {
    const altMatch = htmlImg.match(/alt=["']([^"']+)["']/);
    return altMatch ? altMatch[1] : '';
  }
}
