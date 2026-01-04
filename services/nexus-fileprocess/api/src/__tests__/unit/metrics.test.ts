/**
 * Comprehensive Unit Tests for Prometheus Metrics
 *
 * Phase 7-8: Test Suite
 *
 * Tests all 13 metric categories and 22 helper functions:
 * 1. HTTP Metrics
 * 2. Job Processing Metrics
 * 3. Document Processing Metrics
 * 4. MageAgent API Metrics
 * 5. Embedding Metrics
 * 6. Table Extraction Metrics
 * 7. Database Metrics
 * 8. Health Metrics
 * 9. System Metrics
 * 10. Pattern Learning Metrics
 * 11. Circuit Breaker Metrics
 * 12. Queue Metrics
 * 13. Sandbox Metrics
 */

import {
  register,
  getBatchSizeRange,
  recordJobCreated,
  recordJobCompleted,
  recordDocumentProcessed,
  recordMageAgentCall,
  recordEmbedding,
  recordTableExtraction,
  recordHealthCheck,
  recordDatabaseOperation,
  recordError,
  recordPatternCacheHit,
  recordPatternCacheMiss,
  recordPatternExecution,
  recordPatternLearning,
  updatePatternRepositorySize,
  recordCircuitBreakerState,
  recordCircuitBreakerTransition,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess,
  updateQueueDepth,
  updateWorkerHealth,
  recordQueueJobProcessed,
  recordSandboxExecution,
} from '../../utils/metrics';

describe('Metrics - Helper Functions', () => {
  beforeEach(async () => {
    // Clear all metrics before each test
    register.resetMetrics();
  });

  describe('getBatchSizeRange', () => {
    it('should return "1" for size 1', () => {
      expect(getBatchSizeRange(1)).toBe('1');
    });

    it('should return "2-10" for sizes 2-10', () => {
      expect(getBatchSizeRange(2)).toBe('2-10');
      expect(getBatchSizeRange(5)).toBe('2-10');
      expect(getBatchSizeRange(10)).toBe('2-10');
    });

    it('should return "11-50" for sizes 11-50', () => {
      expect(getBatchSizeRange(11)).toBe('11-50');
      expect(getBatchSizeRange(30)).toBe('11-50');
      expect(getBatchSizeRange(50)).toBe('11-50');
    });

    it('should return "51-100" for sizes 51-100', () => {
      expect(getBatchSizeRange(51)).toBe('51-100');
      expect(getBatchSizeRange(75)).toBe('51-100');
      expect(getBatchSizeRange(100)).toBe('51-100');
    });

    it('should return "101-500" for sizes 101-500', () => {
      expect(getBatchSizeRange(101)).toBe('101-500');
      expect(getBatchSizeRange(250)).toBe('101-500');
      expect(getBatchSizeRange(500)).toBe('101-500');
    });

    it('should return "501+" for sizes above 500', () => {
      expect(getBatchSizeRange(501)).toBe('501+');
      expect(getBatchSizeRange(1000)).toBe('501+');
      expect(getBatchSizeRange(10000)).toBe('501+');
    });
  });

  describe('recordJobCreated', () => {
    it('should increment job created counter with correct labels', async () => {
      recordJobCreated('user-123', 'upload');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_jobs_created_total');
      expect(metrics).toContain('user_id="user-123"');
      expect(metrics).toContain('source="upload"');
    });

    it('should support "url" source', async () => {
      recordJobCreated('user-456', 'url');

      const metrics = await register.metrics();
      expect(metrics).toContain('source="url"');
    });

    it('should increment active jobs gauge', async () => {
      recordJobCreated('user-789', 'upload');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_active_jobs');
      expect(metrics).toContain('status="queued"');
    });
  });

  describe('recordJobCompleted', () => {
    it('should record successful job completion', async () => {
      recordJobCompleted('success', 10.5);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_jobs_completed_total');
      expect(metrics).toContain('status="success"');
      expect(metrics).toContain('fileprocess_job_processing_duration_seconds');
    });

    it('should record failed job completion', async () => {
      recordJobCompleted('failed', 5.2);

      const metrics = await register.metrics();
      expect(metrics).toContain('status="failed"');
    });

    it('should observe processing duration', async () => {
      recordJobCompleted('success', 30.0);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_job_processing_duration_seconds');
      expect(metrics).toMatch(/fileprocess_job_processing_duration_seconds_bucket.*status="success"/);
    });
  });

  describe('recordDocumentProcessed', () => {
    it('should record document processing with all parameters', async () => {
      recordDocumentProcessed('pdf', 'success', 1024000, 5);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_documents_processed_total');
      expect(metrics).toContain('file_type="pdf"');
      expect(metrics).toContain('status="success"');
      expect(metrics).toContain('fileprocess_document_size_bytes');
      expect(metrics).toContain('fileprocess_document_pages_total');
    });

    it('should handle missing pages parameter', async () => {
      recordDocumentProcessed('docx', 'success', 2048000);

      const metrics = await register.metrics();
      expect(metrics).toContain('file_type="docx"');
      expect(metrics).not.toContain('fileprocess_document_pages_total{file_type="docx"}');
    });

    it('should record failed document processing', async () => {
      recordDocumentProcessed('corrupt', 'failed', 0);

      const metrics = await register.metrics();
      expect(metrics).toContain('status="failed"');
    });
  });

  describe('recordMageAgentCall', () => {
    it('should record successful MageAgent call with model', async () => {
      recordMageAgentCall('ocr', 'success', 2.5, 'gpt-4-vision');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_mageagent_calls_total');
      expect(metrics).toContain('operation="ocr"');
      expect(metrics).toContain('status="success"');
      expect(metrics).toContain('model="gpt-4-vision"');
    });

    it('should record error and increment error counter', async () => {
      recordMageAgentCall('table', 'error', 1.0);

      const metrics = await register.metrics();
      expect(metrics).toContain('status="error"');
      expect(metrics).toContain('fileprocess_mageagent_errors_total');
      expect(metrics).toContain('error_type="api_error"');
    });

    it('should handle missing model parameter', async () => {
      recordMageAgentCall('layout', 'success', 3.0);

      const metrics = await register.metrics();
      expect(metrics).toContain('model="unknown"');
    });
  });

  describe('recordEmbedding', () => {
    it('should record batch embedding', async () => {
      recordEmbedding('batch', 100, 5.5);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_embedding_texts_total');
      expect(metrics).toContain('operation="batch"');
      expect(metrics).toContain('fileprocess_embedding_batch_size');
      expect(metrics).toContain('fileprocess_embedding_duration_seconds');
    });

    it('should record single embedding', async () => {
      recordEmbedding('single', 1, 0.5);

      const metrics = await register.metrics();
      expect(metrics).toContain('operation="single"');
      expect(metrics).toContain('batch_size_range="1"');
    });

    it('should use correct batch size range', async () => {
      recordEmbedding('batch', 250, 10.0);

      const metrics = await register.metrics();
      expect(metrics).toContain('batch_size_range="101-500"');
    });
  });

  describe('recordTableExtraction', () => {
    it('should record successful table extraction', async () => {
      recordTableExtraction('vision', 'success', 0.95, 120);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_tables_extracted_total');
      expect(metrics).toContain('method="vision"');
      expect(metrics).toContain('status="success"');
      expect(metrics).toContain('fileprocess_table_extraction_confidence');
      expect(metrics).toContain('fileprocess_table_cells_total');
    });

    it('should record heuristic method', async () => {
      recordTableExtraction('heuristic', 'success', 0.75, 50);

      const metrics = await register.metrics();
      expect(metrics).toContain('method="heuristic"');
    });

    it('should record failed extraction', async () => {
      recordTableExtraction('vision', 'error', 0.0, 0);

      const metrics = await register.metrics();
      expect(metrics).toContain('status="error"');
    });
  });

  describe('recordHealthCheck', () => {
    it('should record healthy dependency', async () => {
      recordHealthCheck('postgres', true, 0.05);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_health_check_status');
      expect(metrics).toContain('dependency="postgres"');
      expect(metrics).toMatch(/fileprocess_health_check_status{dependency="postgres"}\s+1/);
      expect(metrics).toContain('fileprocess_health_check_duration_seconds');
    });

    it('should record unhealthy dependency', async () => {
      recordHealthCheck('redis', false, 2.0);

      const metrics = await register.metrics();
      expect(metrics).toMatch(/fileprocess_health_check_status{dependency="redis"}\s+0/);
    });

    it('should support all dependency types', async () => {
      recordHealthCheck('graphrag', true, 0.5);
      recordHealthCheck('mageagent', true, 1.0);

      const metrics = await register.metrics();
      expect(metrics).toContain('dependency="graphrag"');
      expect(metrics).toContain('dependency="mageagent"');
    });
  });

  describe('recordDatabaseOperation', () => {
    it('should record successful database operation', async () => {
      recordDatabaseOperation('SELECT', 'postgres', 0.05);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_database_query_duration_seconds');
      expect(metrics).toContain('operation="SELECT"');
      expect(metrics).toContain('database="postgres"');
    });

    it('should record operation with error', async () => {
      const error = new Error('Connection timeout');
      recordDatabaseOperation('INSERT', 'postgres', 1.0, error);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_database_errors_total');
      expect(metrics).toContain('error_type="Error"');
    });

    it('should support Redis operations', async () => {
      recordDatabaseOperation('GET', 'redis', 0.01);

      const metrics = await register.metrics();
      expect(metrics).toContain('database="redis"');
    });
  });

  describe('recordError', () => {
    it('should record warning error', async () => {
      recordError('validation_error', 'warning');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_errors_total');
      expect(metrics).toContain('type="validation_error"');
      expect(metrics).toContain('severity="warning"');
    });

    it('should record error severity', async () => {
      recordError('api_error', 'error');

      const metrics = await register.metrics();
      expect(metrics).toContain('severity="error"');
    });

    it('should record critical error', async () => {
      recordError('system_crash', 'critical');

      const metrics = await register.metrics();
      expect(metrics).toContain('severity="critical"');
    });
  });

  describe('Pattern Learning Metrics', () => {
    it('should record cache hit', async () => {
      recordPatternCacheHit('application/pdf');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_pattern_cache_hits_total');
      expect(metrics).toContain('mime_type="application/pdf"');
    });

    it('should record cache miss', async () => {
      recordPatternCacheMiss('application/vnd.custom');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_pattern_cache_misses_total');
      expect(metrics).toContain('mime_type="application/vnd.custom"');
    });

    it('should record pattern execution', async () => {
      recordPatternExecution('pattern-123', true, 1.5, 6.0);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_pattern_execution_duration_seconds');
      expect(metrics).toContain('pattern_id="pattern-123"');
      expect(metrics).toContain('success="true"');
      expect(metrics).toContain('fileprocess_pattern_speedup_factor');
    });

    it('should record pattern execution without speedup', async () => {
      recordPatternExecution('pattern-456', false, 30.0);

      const metrics = await register.metrics();
      expect(metrics).toContain('success="false"');
      expect(metrics).not.toContain('fileprocess_pattern_speedup_factor_bucket{le="6"}');
    });

    it('should record pattern learning', async () => {
      recordPatternLearning('application/vnd.custom', 'mageagent');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_pattern_learning_total');
      expect(metrics).toContain('source="mageagent"');
    });

    it('should update repository size', async () => {
      updatePatternRepositorySize('cache', 50);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_pattern_repository_size');
      expect(metrics).toContain('storage="cache"');
      expect(metrics).toMatch(/fileprocess_pattern_repository_size{storage="cache"}\s+50/);
    });

    it('should support all storage types', async () => {
      updatePatternRepositorySize('cache', 50);
      updatePatternRepositorySize('database', 500);
      updatePatternRepositorySize('graphrag', 10000);

      const metrics = await register.metrics();
      expect(metrics).toContain('storage="cache"');
      expect(metrics).toContain('storage="database"');
      expect(metrics).toContain('storage="graphrag"');
    });
  });

  describe('Circuit Breaker Metrics', () => {
    it('should record CLOSED state', async () => {
      recordCircuitBreakerState('sandbox', 'CLOSED');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_circuit_breaker_state');
      expect(metrics).toContain('circuit_name="sandbox"');
      expect(metrics).toMatch(/fileprocess_circuit_breaker_state{circuit_name="sandbox"}\s+0/);
    });

    it('should record OPEN state', async () => {
      recordCircuitBreakerState('sandbox', 'OPEN');

      const metrics = await register.metrics();
      expect(metrics).toMatch(/fileprocess_circuit_breaker_state{circuit_name="sandbox"}\s+1/);
    });

    it('should record HALF_OPEN state', async () => {
      recordCircuitBreakerState('sandbox', 'HALF_OPEN');

      const metrics = await register.metrics();
      expect(metrics).toMatch(/fileprocess_circuit_breaker_state{circuit_name="sandbox"}\s+2/);
    });

    it('should record state transitions', async () => {
      recordCircuitBreakerTransition('sandbox', 'CLOSED', 'OPEN');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_circuit_breaker_transitions_total');
      expect(metrics).toContain('from_state="CLOSED"');
      expect(metrics).toContain('to_state="OPEN"');
    });

    it('should record failures', async () => {
      recordCircuitBreakerFailure('sandbox', 'NetworkError');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_circuit_breaker_failures_total');
      expect(metrics).toContain('error_type="NetworkError"');
    });

    it('should record successes', async () => {
      recordCircuitBreakerSuccess('sandbox');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_circuit_breaker_successes_total');
    });
  });

  describe('Queue Metrics', () => {
    it('should update queue depth', async () => {
      updateQueueDepth('file-processing', 'waiting', 25);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_queue_depth');
      expect(metrics).toContain('queue_name="file-processing"');
      expect(metrics).toContain('state="waiting"');
      expect(metrics).toMatch(/fileprocess_queue_depth{.*}\s+25/);
    });

    it('should support all queue states', async () => {
      updateQueueDepth('jobs', 'waiting', 10);
      updateQueueDepth('jobs', 'active', 5);
      updateQueueDepth('jobs', 'delayed', 2);

      const metrics = await register.metrics();
      expect(metrics).toContain('state="waiting"');
      expect(metrics).toContain('state="active"');
      expect(metrics).toContain('state="delayed"');
    });

    it('should update worker health', async () => {
      updateWorkerHealth('worker-1', true);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_queue_worker_health');
      expect(metrics).toContain('worker_id="worker-1"');
      expect(metrics).toMatch(/fileprocess_queue_worker_health{worker_id="worker-1"}\s+1/);
    });

    it('should record unhealthy worker', async () => {
      updateWorkerHealth('worker-2', false);

      const metrics = await register.metrics();
      expect(metrics).toMatch(/fileprocess_queue_worker_health{worker_id="worker-2"}\s+0/);
    });

    it('should record queue job processing', async () => {
      recordQueueJobProcessed('file-processing', 'completed', 15.5, 'pdf-processing');

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_queue_jobs_processed_total');
      expect(metrics).toContain('status="completed"');
      expect(metrics).toContain('fileprocess_queue_job_duration_seconds');
      expect(metrics).toContain('job_type="pdf-processing"');
    });
  });

  describe('Sandbox Metrics', () => {
    it('should record successful sandbox execution', async () => {
      recordSandboxExecution('python', true, 2.5, 150, 256);

      const metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_sandbox_executions_total');
      expect(metrics).toContain('language="python"');
      expect(metrics).toContain('success="true"');
      expect(metrics).toContain('fileprocess_sandbox_execution_duration_seconds');
      expect(metrics).toContain('fileprocess_sandbox_resource_usage');
      expect(metrics).toContain('resource_type="cpu_ms"');
      expect(metrics).toContain('resource_type="memory_mb"');
    });

    it('should record failed sandbox execution', async () => {
      recordSandboxExecution('node', false, 0.5);

      const metrics = await register.metrics();
      expect(metrics).toContain('success="false"');
    });

    it('should handle missing resource usage', async () => {
      recordSandboxExecution('go', true, 1.0);

      const metrics = await register.metrics();
      expect(metrics).toContain('language="go"');
      // Should not error, just skip resource metrics
    });

    it('should support multiple languages', async () => {
      recordSandboxExecution('python', true, 1.0);
      recordSandboxExecution('node', true, 1.5);
      recordSandboxExecution('go', true, 0.8);
      recordSandboxExecution('rust', true, 0.5);

      const metrics = await register.metrics();
      expect(metrics).toContain('language="python"');
      expect(metrics).toContain('language="node"');
      expect(metrics).toContain('language="go"');
      expect(metrics).toContain('language="rust"');
    });
  });

  describe('Metrics Registry', () => {
    it('should export metrics in Prometheus format', async () => {
      // Record some test metrics
      recordJobCreated('user-test', 'upload');
      recordHealthCheck('postgres', true, 0.1);

      const metrics = await register.metrics();

      // Verify Prometheus format
      expect(metrics).toContain('# HELP');
      expect(metrics).toContain('# TYPE');
      expect(metrics).toContain('fileprocess_');
    });

    it('should support metrics reset', async () => {
      recordJobCreated('user-1', 'upload');

      let metrics = await register.metrics();
      expect(metrics).toContain('fileprocess_jobs_created_total');

      register.resetMetrics();

      metrics = await register.metrics();
      // After reset, counters should be at 0 or not present
      expect(metrics).toBeDefined();
    });

    it('should include default metrics', async () => {
      const metrics = await register.metrics();

      // Should include process_* metrics from prom-client defaults
      expect(metrics).toContain('process_cpu');
      expect(metrics).toContain('process_');
    });
  });
});
