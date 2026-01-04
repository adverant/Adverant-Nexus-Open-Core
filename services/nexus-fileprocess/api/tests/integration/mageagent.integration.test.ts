/**
 * MageAgent Client Integration Tests
 *
 * Tests integration with MageAgent service for:
 * - Vision OCR
 * - Layout analysis
 * - Table extraction
 *
 * SETUP:
 * 1. Ensure MageAgent service is running at MAGEAGENT_URL
 * 2. Set required environment variables
 * 3. Prepare sample test images
 *
 * RUN:
 * npm run test:integration
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Configuration
const MAGEAGENT_URL = process.env.MAGEAGENT_URL || 'http://nexus-mageagent:8080';
const TEST_TIMEOUT = 30000; // 30 seconds for vision models

// Test data paths
const TEST_DATA_DIR = path.join(__dirname, '../fixtures');
const TEST_IMAGE_PATH = path.join(TEST_DATA_DIR, 'sample-document.png');
const TEST_TABLE_IMAGE_PATH = path.join(TEST_DATA_DIR, 'sample-table.png');

describe('MageAgent Integration Tests', () => {
  let testImageBase64: string;
  let testTableImageBase64: string;

  beforeAll(() => {
    // Create test fixtures if they don't exist
    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    }

    // Load or create test images
    if (fs.existsSync(TEST_IMAGE_PATH)) {
      const imageBuffer = fs.readFileSync(TEST_IMAGE_PATH);
      testImageBase64 = imageBuffer.toString('base64');
    } else {
      console.warn('Test image not found, some tests will be skipped');
      testImageBase64 = '';
    }

    if (fs.existsSync(TEST_TABLE_IMAGE_PATH)) {
      const imageBuffer = fs.readFileSync(TEST_TABLE_IMAGE_PATH);
      testTableImageBase64 = imageBuffer.toString('base64');
    } else {
      console.warn('Test table image not found, table tests will be skipped');
      testTableImageBase64 = '';
    }
  });

  describe('Health Check', () => {
    it('should confirm MageAgent service is available', async () => {
      const response = await axios.get(`${MAGEAGENT_URL}/api/health`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
      expect(response.data.status).toBe('ok');
    });
  });

  describe('Vision OCR', () => {
    it('should extract text from image using vision models', async () => {
      if (!testImageBase64) {
        console.log('Skipping: No test image available');
        return;
      }

      const response = await axios.post(
        `${MAGEAGENT_URL}/api/internal/vision/extract-text`,
        {
          image: testImageBase64,
          format: 'base64',
          preferAccuracy: true,
          language: 'en',
        },
        { timeout: TEST_TIMEOUT }
      );

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data).toHaveProperty('text');
      expect(response.data.data).toHaveProperty('confidence');
      expect(response.data.data).toHaveProperty('modelUsed');
      expect(response.data.data.text.length).toBeGreaterThan(0);
      expect(response.data.data.confidence).toBeGreaterThan(0.5);

      console.log(`✅ OCR complete: model=${response.data.data.modelUsed}, confidence=${response.data.data.confidence}`);
    }, TEST_TIMEOUT);

    it('should handle async OCR with polling', async () => {
      if (!testImageBase64) {
        console.log('Skipping: No test image available');
        return;
      }

      // Start async OCR
      const asyncResponse = await axios.post(
        `${MAGEAGENT_URL}/api/internal/vision/extract-text`,
        {
          image: testImageBase64,
          format: 'base64',
          preferAccuracy: true,
          language: 'en',
          async: true,
          jobId: 'test-job-123',
        },
        { timeout: TEST_TIMEOUT }
      );

      expect(asyncResponse.status).toBe(202);
      expect(asyncResponse.data.success).toBe(true);
      expect(asyncResponse.data.data).toHaveProperty('taskId');

      const taskId = asyncResponse.data.data.taskId;
      console.log(`✅ Async task created: ${taskId}`);

      // Poll for completion
      let completed = false;
      let attempts = 0;
      const maxAttempts = 30;

      while (!completed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const statusResponse = await axios.get(
          `${MAGEAGENT_URL}/api/tasks/${taskId}`
        );

        expect(statusResponse.status).toBe(200);
        const taskStatus = statusResponse.data.data.task.status;

        if (taskStatus === 'completed') {
          completed = true;
          expect(statusResponse.data.data.task.result).toHaveProperty('text');
          console.log(`✅ Async OCR completed after ${attempts} polls`);
        } else if (taskStatus === 'failed') {
          throw new Error(`Task failed: ${statusResponse.data.data.task.error}`);
        }

        attempts++;
      }

      expect(completed).toBe(true);
    }, TEST_TIMEOUT * 2);
  });

  describe('Layout Analysis', () => {
    it('should analyze document layout', async () => {
      if (!testImageBase64) {
        console.log('Skipping: No test image available');
        return;
      }

      const response = await axios.post(
        `${MAGEAGENT_URL}/api/internal/vision/analyze-layout`,
        {
          image: testImageBase64,
          format: 'base64',
          language: 'en',
        },
        { timeout: TEST_TIMEOUT }
      );

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data).toHaveProperty('elements');
      expect(response.data.data).toHaveProperty('readingOrder');
      expect(response.data.data).toHaveProperty('confidence');
      expect(response.data.data).toHaveProperty('modelUsed');
      expect(Array.isArray(response.data.data.elements)).toBe(true);

      const elements = response.data.data.elements;
      console.log(`✅ Layout analysis complete: ${elements.length} elements detected`);

      // Validate element structure
      if (elements.length > 0) {
        const element = elements[0];
        expect(element).toHaveProperty('id');
        expect(element).toHaveProperty('type');
        expect(element).toHaveProperty('boundingBox');
        expect(element).toHaveProperty('content');
        expect(element).toHaveProperty('confidence');
      }
    }, TEST_TIMEOUT);
  });

  describe('Table Extraction', () => {
    it('should extract table structure with high accuracy', async () => {
      if (!testTableImageBase64) {
        console.log('Skipping: No test table image available');
        return;
      }

      const response = await axios.post(
        `${MAGEAGENT_URL}/api/internal/vision/extract-table`,
        {
          image: testTableImageBase64,
          format: 'base64',
          language: 'en',
        },
        { timeout: TEST_TIMEOUT }
      );

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data).toHaveProperty('rows');
      expect(response.data.data).toHaveProperty('columns');
      expect(response.data.data).toHaveProperty('confidence');
      expect(response.data.data).toHaveProperty('modelUsed');
      expect(Array.isArray(response.data.data.rows)).toBe(true);

      const { rows, columns, confidence } = response.data.data;
      console.log(`✅ Table extracted: ${rows.length} rows, ${columns} columns, confidence=${confidence}`);

      // Target: 97.9% accuracy
      expect(confidence).toBeGreaterThan(0.85);

      // Validate row structure
      if (rows.length > 0) {
        const row = rows[0];
        expect(row).toHaveProperty('rowIndex');
        expect(row).toHaveProperty('cells');
        expect(Array.isArray(row.cells)).toBe(true);

        // Validate cell structure
        if (row.cells.length > 0) {
          const cell = row.cells[0];
          expect(cell).toHaveProperty('rowIndex');
          expect(cell).toHaveProperty('colIndex');
          expect(cell).toHaveProperty('content');
          expect(cell).toHaveProperty('confidence');
        }
      }
    }, TEST_TIMEOUT);

    it('should handle merged cells (rowspan/colspan)', async () => {
      if (!testTableImageBase64) {
        console.log('Skipping: No test table image available');
        return;
      }

      const response = await axios.post(
        `${MAGEAGENT_URL}/api/internal/vision/extract-table`,
        {
          image: testTableImageBase64,
          format: 'base64',
          language: 'en',
        },
        { timeout: TEST_TIMEOUT }
      );

      expect(response.status).toBe(200);
      const { rows } = response.data.data;

      // Check if any cells have rowspan/colspan
      let foundMergedCells = false;
      for (const row of rows) {
        for (const cell of row.cells) {
          if (cell.rowSpan > 1 || cell.colSpan > 1) {
            foundMergedCells = true;
            console.log(`✅ Found merged cell: rowSpan=${cell.rowSpan}, colSpan=${cell.colSpan}`);
          }
        }
      }

      // Note: Not all tables have merged cells
      console.log(`Merged cells detected: ${foundMergedCells}`);
    }, TEST_TIMEOUT);
  });

  describe('Performance', () => {
    it('should complete OCR within acceptable time', async () => {
      if (!testImageBase64) {
        console.log('Skipping: No test image available');
        return;
      }

      const startTime = Date.now();

      await axios.post(
        `${MAGEAGENT_URL}/api/internal/vision/extract-text`,
        {
          image: testImageBase64,
          format: 'base64',
          preferAccuracy: false, // Use speed mode
          language: 'en',
        },
        { timeout: TEST_TIMEOUT }
      );

      const duration = Date.now() - startTime;
      console.log(`✅ OCR completed in ${duration}ms`);

      // Speed mode should complete within 10 seconds
      expect(duration).toBeLessThan(10000);
    }, TEST_TIMEOUT);

    it('should complete table extraction within acceptable time', async () => {
      if (!testTableImageBase64) {
        console.log('Skipping: No test table image available');
        return;
      }

      const startTime = Date.now();

      await axios.post(
        `${MAGEAGENT_URL}/api/internal/vision/extract-table`,
        {
          image: testTableImageBase64,
          format: 'base64',
          language: 'en',
        },
        { timeout: TEST_TIMEOUT }
      );

      const duration = Date.now() - startTime;
      console.log(`✅ Table extraction completed in ${duration}ms`);

      // Table extraction should complete within 15 seconds
      expect(duration).toBeLessThan(15000);
    }, TEST_TIMEOUT);
  });

  describe('Error Handling', () => {
    it('should handle invalid image data gracefully', async () => {
      try {
        await axios.post(
          `${MAGEAGENT_URL}/api/internal/vision/extract-text`,
          {
            image: 'invalid-base64-data',
            format: 'base64',
            language: 'en',
          },
          { timeout: TEST_TIMEOUT }
        );

        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        console.log(`✅ Invalid image handled correctly: ${error.response.status}`);
      }
    });

    it('should handle missing required fields', async () => {
      try {
        await axios.post(
          `${MAGEAGENT_URL}/api/internal/vision/extract-text`,
          {
            // Missing image field
            format: 'base64',
            language: 'en',
          },
          { timeout: TEST_TIMEOUT }
        );

        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        console.log(`✅ Missing field handled correctly: ${error.response.status}`);
      }
    });
  });
});
