#!/usr/bin/env python3
"""
Docling Wrapper Script

This script provides a command-line interface to IBM's Docling framework
for advanced document processing with 97.9% table extraction accuracy.

It handles:
- Document parsing (PDF, DOCX, PPTX, XLSX, HTML, XML)
- Table extraction with TableFormer
- Layout preservation
- Figure/image extraction
- Equation detection

The script is designed to be called as a subprocess from the Node.js
AdvancedDocumentProcessor class.

Usage:
  python docling-wrapper.py <input_file> [options]

Options:
  --output-format <format>  Output format: text, markdown, json (default: json)
  --preserve-layout        Preserve document layout structure
  --extract-tables         Extract tables with high accuracy
  --extract-figures        Extract figures and images
  --extract-equations      Extract mathematical equations
  --output-file <file>     Output file path (default: stdout)
"""

import sys
import json
import argparse
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
import base64

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

try:
    # Import Docling components
    from docling.document_converter import DocumentConverter
    from docling.datamodel.pipeline_options import PipelineOptions
    from docling.datamodel.base import Document
except ImportError as e:
    logger.error(f"Docling not installed: {e}")
    logger.error("Install with: pip install docling")
    sys.exit(1)

class DoclingProcessor:
    """Wrapper for Docling document processing"""

    def __init__(self):
        """Initialize the Docling converter"""
        self.converter = None

    def initialize_converter(self, options: Dict[str, Any]) -> None:
        """Initialize converter with specified options"""
        pipeline_options = PipelineOptions()

        # Configure pipeline based on options
        if options.get('extract_tables', True):
            pipeline_options.table_extraction = True
            pipeline_options.table_structure_recognition = True

        if options.get('extract_figures', True):
            pipeline_options.figure_extraction = True

        if options.get('extract_equations', False):
            pipeline_options.equation_extraction = True

        if options.get('preserve_layout', True):
            pipeline_options.layout_preservation = True

        # Initialize converter with options
        self.converter = DocumentConverter(
            pipeline_options=pipeline_options,
            logging_level=logging.INFO
        )

    def process_document(self, input_path: Path, options: Dict[str, Any]) -> Dict[str, Any]:
        """Process a document and return structured data"""

        # Initialize converter if not already done
        if not self.converter:
            self.initialize_converter(options)

        try:
            # Convert document
            logger.info(f"Processing document: {input_path}")
            result = self.converter.convert(str(input_path))

            # Extract structured data
            output = {
                'success': True,
                'format': options.get('output_format', 'json'),
                'metadata': {
                    'filename': input_path.name,
                    'file_size': input_path.stat().st_size,
                    'pages': 0
                },
                'content': '',
                'tables': [],
                'figures': [],
                'layout': []
            }

            # Process based on document type
            if isinstance(result, Document):
                # Extract text content
                if options['output_format'] == 'markdown':
                    output['content'] = result.to_markdown()
                elif options['output_format'] == 'text':
                    output['content'] = result.to_text()
                else:  # json
                    output['content'] = result.to_text()

                # Extract metadata
                if hasattr(result, 'metadata'):
                    output['metadata'].update({
                        'title': result.metadata.get('title', ''),
                        'author': result.metadata.get('author', ''),
                        'pages': result.metadata.get('page_count', 0)
                    })

                # Extract tables
                if options.get('extract_tables', True) and hasattr(result, 'tables'):
                    for table in result.tables:
                        table_data = {
                            'headers': [],
                            'rows': [],
                            'caption': '',
                            'confidence': 0.979  # TableFormer baseline
                        }

                        # Extract table headers
                        if hasattr(table, 'header'):
                            table_data['headers'] = [str(cell) for cell in table.header]

                        # Extract table rows
                        if hasattr(table, 'rows'):
                            for row in table.rows:
                                table_data['rows'].append([str(cell) for cell in row])

                        # Extract caption if available
                        if hasattr(table, 'caption'):
                            table_data['caption'] = str(table.caption)

                        output['tables'].append(table_data)

                # Extract figures
                if options.get('extract_figures', True) and hasattr(result, 'figures'):
                    for figure in result.figures:
                        figure_data = {
                            'caption': '',
                            'type': 'figure',
                            'base64': None
                        }

                        # Extract caption
                        if hasattr(figure, 'caption'):
                            figure_data['caption'] = str(figure.caption)

                        # Extract image data if available
                        if hasattr(figure, 'image'):
                            # Convert image to base64
                            try:
                                import io
                                from PIL import Image

                                img = figure.image
                                if isinstance(img, Image.Image):
                                    buffer = io.BytesIO()
                                    img.save(buffer, format='PNG')
                                    figure_data['base64'] = base64.b64encode(buffer.getvalue()).decode('utf-8')
                            except Exception as e:
                                logger.warning(f"Could not extract figure image: {e}")

                        output['figures'].append(figure_data)

                # Extract layout structure
                if options.get('preserve_layout', True) and hasattr(result, 'layout'):
                    for element in result.layout:
                        layout_element = {
                            'type': 'paragraph',  # Default
                            'content': '',
                            'level': None,
                            'metadata': {}
                        }

                        # Determine element type
                        if hasattr(element, 'type'):
                            element_type = str(element.type).lower()
                            if 'header' in element_type or 'heading' in element_type:
                                layout_element['type'] = 'header'
                                # Extract header level if available
                                if hasattr(element, 'level'):
                                    layout_element['level'] = int(element.level)
                            elif 'table' in element_type:
                                layout_element['type'] = 'table'
                            elif 'figure' in element_type or 'image' in element_type:
                                layout_element['type'] = 'figure'
                            elif 'list' in element_type:
                                layout_element['type'] = 'list'
                            elif 'code' in element_type:
                                layout_element['type'] = 'code'
                            elif 'footer' in element_type:
                                layout_element['type'] = 'footer'
                            elif 'caption' in element_type:
                                layout_element['type'] = 'caption'

                        # Extract content
                        if hasattr(element, 'text'):
                            layout_element['content'] = str(element.text)
                        elif hasattr(element, 'content'):
                            layout_element['content'] = str(element.content)

                        # Extract bounding box if available
                        if hasattr(element, 'bbox'):
                            layout_element['metadata']['bbox'] = {
                                'x': element.bbox.x,
                                'y': element.bbox.y,
                                'width': element.bbox.width,
                                'height': element.bbox.height
                            }

                        # Extract page number if available
                        if hasattr(element, 'page'):
                            layout_element['metadata']['page'] = element.page

                        output['layout'].append(layout_element)

            return output

        except Exception as e:
            logger.error(f"Error processing document: {e}")
            return {
                'success': False,
                'error': str(e),
                'format': options.get('output_format', 'json')
            }

def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description='Docling document processor wrapper')
    parser.add_argument('input_file', type=str, help='Input document file path')
    parser.add_argument('--output-format', type=str, default='json',
                      choices=['text', 'markdown', 'json'],
                      help='Output format (default: json)')
    parser.add_argument('--preserve-layout', action='store_true',
                      help='Preserve document layout structure')
    parser.add_argument('--extract-tables', action='store_true',
                      help='Extract tables with high accuracy')
    parser.add_argument('--extract-figures', action='store_true',
                      help='Extract figures and images')
    parser.add_argument('--extract-equations', action='store_true',
                      help='Extract mathematical equations')
    parser.add_argument('--output-file', type=str, default=None,
                      help='Output file path (default: stdout)')

    args = parser.parse_args()

    # Validate input file
    input_path = Path(args.input_file)
    if not input_path.exists():
        logger.error(f"Input file not found: {input_path}")
        sys.exit(1)

    # Prepare options
    options = {
        'output_format': args.output_format,
        'preserve_layout': args.preserve_layout,
        'extract_tables': args.extract_tables,
        'extract_figures': args.extract_figures,
        'extract_equations': args.extract_equations
    }

    # Process document
    processor = DoclingProcessor()
    result = processor.process_document(input_path, options)

    # Output results
    if args.output_file:
        output_path = Path(args.output_file)
        with open(output_path, 'w', encoding='utf-8') as f:
            if args.output_format == 'json':
                json.dump(result, f, indent=2, ensure_ascii=False)
            else:
                f.write(result.get('content', ''))
        logger.info(f"Output written to: {output_path}")
    else:
        # Output to stdout for subprocess capture
        if args.output_format == 'json':
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(result.get('content', ''))

    return 0 if result.get('success', False) else 1

if __name__ == '__main__':
    sys.exit(main())