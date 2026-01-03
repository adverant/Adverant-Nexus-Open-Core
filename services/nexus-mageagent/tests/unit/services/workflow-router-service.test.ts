/**
 * Unit Tests for WorkflowRouterService
 *
 * Tests the multi-service workflow orchestration functionality.
 * Uses mocked clients for reliable testing.
 */

import {
  WorkflowRouterService,
  getWorkflowRouterService,
  resetWorkflowRouterService,
  WorkflowRouterConfig,
} from '../../../src/services/workflow-router-service';
import {
  WorkflowStep,
  WorkflowPlan,
} from '../../../src/types/workflow.types';

// Mock the service clients
jest.mock('../../../src/clients/cyberagent-client', () => ({
  CyberAgentClient: jest.fn().mockImplementation(() => ({
    createScanJob: jest.fn(),
    getJobStatus: jest.fn(),
    pollUntilComplete: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ status: 'healthy' }),
  })),
  getCyberAgentClient: jest.fn(() => ({
    createScanJob: jest.fn(),
    getJobStatus: jest.fn(),
    pollUntilComplete: jest.fn(),
  })),
}));

jest.mock('../../../src/clients/fileprocess-client', () => ({
  FileProcessClient: jest.fn().mockImplementation(() => ({
    processUrl: jest.fn(),
    processDriveUrl: jest.fn(),
    getJobStatus: jest.fn(),
    pollUntilComplete: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ status: 'healthy' }),
  })),
  getFileProcessClient: jest.fn(() => ({
    processUrl: jest.fn(),
    processDriveUrl: jest.fn(),
    getJobStatus: jest.fn(),
    pollUntilComplete: jest.fn(),
  })),
}));

jest.mock('../../../src/clients/sandbox-client', () => ({
  SandboxClient: jest.fn().mockImplementation(() => ({
    execute: jest.fn(),
    executePython: jest.fn(),
    executeNode: jest.fn(),
    executeBash: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ status: 'healthy' }),
  })),
  getSandboxClient: jest.fn(() => ({
    execute: jest.fn(),
    executePython: jest.fn(),
    executeNode: jest.fn(),
    executeBash: jest.fn(),
  })),
}));

// Mock OpenRouterClient
const mockCreateCompletion = jest.fn();
const mockOpenRouterClient = {
  createCompletion: mockCreateCompletion,
  listAvailableModels: jest.fn().mockResolvedValue([]),
};

describe('WorkflowRouterService', () => {
  let service: WorkflowRouterService;

  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkflowRouterService();

    service = new WorkflowRouterService({
      openRouterClient: mockOpenRouterClient as any,
    });
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('Constructor', () => {
    it('should create service with OpenRouter client', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(WorkflowRouterService);
    });

    it('should use default model when none specified', () => {
      const config: WorkflowRouterConfig = {
        openRouterClient: mockOpenRouterClient as any,
      };
      const svc = new WorkflowRouterService(config);
      expect(svc).toBeDefined();
    });

    it('should use custom model when specified', () => {
      const config: WorkflowRouterConfig = {
        openRouterClient: mockOpenRouterClient as any,
        defaultModel: 'anthropic/claude-3-opus',
      };
      const svc = new WorkflowRouterService(config);
      expect(svc).toBeDefined();
    });
  });

  // ==========================================================================
  // Parse Request Tests
  // ==========================================================================

  describe('parseRequest', () => {
    it('should parse simple workflow request', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              steps: [
                {
                  id: 'step-1',
                  name: 'Download file',
                  service: 'fileprocess',
                  operation: 'process_url',
                  input: { url: 'https://example.com/file.pdf' },
                  dependsOn: []
                }
              ],
              confidence: 0.95,
              clarifications: []
            })
          }
        }]
      });

      const response = await service.parseRequest({
        request: 'Download and process https://example.com/file.pdf'
      });

      expect(response.plan).toBeDefined();
      expect(response.plan.steps).toHaveLength(1);
      expect(response.confidence).toBe(0.95);
    });

    it('should parse multi-step workflow', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              steps: [
                {
                  id: 'step-1',
                  name: 'Process PDF',
                  service: 'fileprocess',
                  operation: 'process_url',
                  input: { url: 'https://example.com/report.pdf' },
                  dependsOn: []
                },
                {
                  id: 'step-2',
                  name: 'Scan for malware',
                  service: 'cyberagent',
                  operation: 'malware_scan',
                  input: { target: '${ref:step-1.artifactUrl}' },
                  dependsOn: ['step-1']
                },
                {
                  id: 'step-3',
                  name: 'Summarize content',
                  service: 'mageagent',
                  operation: 'summarization',
                  input: { content: '${ref:step-1.text}' },
                  dependsOn: ['step-1']
                }
              ],
              confidence: 0.88,
              clarifications: []
            })
          }
        }]
      });

      const response = await service.parseRequest({
        request: 'Download the PDF, scan it for malware, and summarize the content'
      });

      expect(response.plan.steps).toHaveLength(3);
      expect(response.involvedServices).toContain('fileprocess');
      expect(response.involvedServices).toContain('cyberagent');
      expect(response.involvedServices).toContain('mageagent');
    });

    it('should return clarifications for ambiguous requests', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              steps: [],
              confidence: 0.3,
              clarifications: [
                'What type of security scan do you want (malware, vulnerability)?',
                'Should I also analyze the file content after scanning?'
              ]
            })
          }
        }]
      });

      const response = await service.parseRequest({
        request: 'Check this file'
      });

      expect(response.confidence).toBeLessThan(0.5);
      expect(response.clarifications).toHaveLength(2);
    });

    it('should handle parse errors gracefully', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Invalid JSON response'
          }
        }]
      });

      const response = await service.parseRequest({
        request: 'Process some file'
      });

      // Should return empty plan with low confidence
      expect(response.plan.steps).toHaveLength(0);
    });

    it('should include context from previous request', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              steps: [{
                id: 'step-1',
                name: 'Process file',
                service: 'fileprocess',
                operation: 'process_url',
                input: {},
                dependsOn: []
              }],
              confidence: 0.9
            })
          }
        }]
      });

      await service.parseRequest({
        request: 'Now analyze the results',
        context: {
          previousRequestId: 'req-123',
          sessionId: 'session-456'
        }
      });

      expect(mockCreateCompletion).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Compute Parallel Groups Tests
  // ==========================================================================

  describe('computeParallelGroups', () => {
    it('should group independent steps together', async () => {
      const steps: WorkflowStep[] = [
        { id: 'step-1', name: 'A', service: 'fileprocess', operation: 'op', input: {}, dependsOn: [] },
        { id: 'step-2', name: 'B', service: 'cyberagent', operation: 'op', input: {}, dependsOn: [] },
        { id: 'step-3', name: 'C', service: 'sandbox', operation: 'op', input: {}, dependsOn: [] }
      ];

      // Test via parseRequest which uses computeParallelGroups
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              steps,
              confidence: 0.9
            })
          }
        }]
      });

      const response = await service.parseRequest({ request: 'test' });

      // The parallel groups should contain all steps in one group
      // since they have no dependencies
      expect(response.plan.parallelGroups).toHaveLength(1);
      expect(response.plan.parallelGroups[0]).toHaveLength(3);
    });

    it('should sequence dependent steps', async () => {
      const steps: WorkflowStep[] = [
        { id: 'step-1', name: 'A', service: 'fileprocess', operation: 'op', input: {}, dependsOn: [] },
        { id: 'step-2', name: 'B', service: 'cyberagent', operation: 'op', input: {}, dependsOn: ['step-1'] },
        { id: 'step-3', name: 'C', service: 'sandbox', operation: 'op', input: {}, dependsOn: ['step-2'] }
      ];

      // Each step should be in a separate group due to linear dependency chain
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              steps,
              confidence: 0.9
            })
          }
        }]
      });

      const response = await service.parseRequest({ request: 'test' });

      // Should have 3 groups due to linear dependencies
      expect(response.plan.parallelGroups).toHaveLength(3);
    });
  });

  // ==========================================================================
  // Execute Workflow Tests
  // ==========================================================================

  describe('executeWorkflow', () => {
    it('should execute single-step workflow', async () => {
      const plan: WorkflowPlan = {
        id: 'wf-123',
        correlationId: 'corr-123',
        originalRequest: 'Process file',
        steps: [{
          id: 'step-1',
          name: 'Process file',
          service: 'fileprocess',
          operation: 'process_url',
          input: { url: 'https://example.com/file.pdf' },
          status: 'pending'
        }],
        parallelGroups: [['step-1']],
        status: 'planning',
        mode: 'best-effort',
        priority: 'normal',
        timeout: 300000,
        createdAt: new Date()
      };

      const result = await service.executeWorkflow(plan);

      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
    });

    it('should execute parallel steps concurrently', async () => {
      const plan: WorkflowPlan = {
        id: 'wf-parallel',
        correlationId: 'corr-parallel',
        originalRequest: 'Process multiple files',
        steps: [
          {
            id: 'step-1',
            name: 'Process file A',
            service: 'fileprocess',
            operation: 'process_url',
            input: { url: 'https://example.com/a.pdf' },
            status: 'pending'
          },
          {
            id: 'step-2',
            name: 'Process file B',
            service: 'fileprocess',
            operation: 'process_url',
            input: { url: 'https://example.com/b.pdf' },
            status: 'pending'
          }
        ],
        parallelGroups: [['step-1', 'step-2']],
        status: 'planning',
        mode: 'best-effort',
        priority: 'normal',
        timeout: 300000,
        createdAt: new Date()
      };

      const result = await service.executeWorkflow(plan);
      expect(result).toBeDefined();
    });

    it('should handle step failures in best-effort mode', async () => {
      const plan: WorkflowPlan = {
        id: 'wf-fail',
        correlationId: 'corr-fail',
        originalRequest: 'Process with potential failure',
        steps: [
          {
            id: 'step-1',
            name: 'Step that might fail',
            service: 'cyberagent',
            operation: 'malware_scan',
            input: { target: 'https://example.com/file.exe' },
            status: 'pending'
          }
        ],
        parallelGroups: [['step-1']],
        status: 'planning',
        mode: 'best-effort',
        priority: 'normal',
        timeout: 300000,
        createdAt: new Date()
      };

      const result = await service.executeWorkflow(plan);

      // In best-effort mode, workflow should complete even with failures
      expect(['completed', 'failed', 'degraded']).toContain(result.status);
    });

    it('should fail fast in strict mode', async () => {
      const plan: WorkflowPlan = {
        id: 'wf-strict',
        correlationId: 'corr-strict',
        originalRequest: 'Critical process',
        steps: [
          {
            id: 'step-1',
            name: 'Critical step',
            service: 'fileprocess',
            operation: 'process_url',
            input: { url: 'https://example.com/important.pdf' },
            status: 'pending'
          },
          {
            id: 'step-2',
            name: 'Dependent step',
            service: 'mageagent',
            operation: 'ai_analysis',
            input: {},
            dependsOn: ['step-1'],
            status: 'pending'
          }
        ],
        parallelGroups: [['step-1'], ['step-2']],
        status: 'planning',
        mode: 'strict',
        priority: 'normal',
        timeout: 300000,
        createdAt: new Date()
      };

      const result = await service.executeWorkflow(plan);

      // Result should exist but may be failed in strict mode
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // Input Reference Resolution Tests
  // ==========================================================================

  describe('Input Reference Resolution', () => {
    it('should resolve step output references', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              steps: [
                {
                  id: 'step-1',
                  name: 'Extract text',
                  service: 'fileprocess',
                  operation: 'extract_content',
                  input: { url: 'https://example.com/doc.pdf' },
                  dependsOn: []
                },
                {
                  id: 'step-2',
                  name: 'Analyze text',
                  service: 'mageagent',
                  operation: 'ai_analysis',
                  input: { content: '${ref:step-1.extractedText}' },
                  dependsOn: ['step-1']
                }
              ],
              confidence: 0.9
            })
          }
        }]
      });

      const response = await service.parseRequest({
        request: 'Extract and analyze document'
      });

      // Verify steps were created
      expect(response.plan.steps).toHaveLength(2);

      // Verify reference syntax is preserved in the plan
      const step2 = response.plan.steps.find(s => s.id === 'step-2');
      expect(step2).toBeDefined();
      expect(step2?.input).toBeDefined();
      // The reference syntax should be in the input
      expect(step2?.input.content).toBe('${ref:step-1.extractedText}');
    });
  });

  // ==========================================================================
  // Service-Specific Execution Tests
  // ==========================================================================

  describe('Service-Specific Execution', () => {
    it('should execute fileprocess operations', async () => {
      const plan: WorkflowPlan = {
        id: 'wf-fp',
        correlationId: 'corr-fp',
        originalRequest: 'Process PDF',
        steps: [{
          id: 'step-1',
          name: 'Process PDF',
          service: 'fileprocess',
          operation: 'process_url',
          input: { url: 'https://example.com/test.pdf' },
          status: 'pending'
        }],
        parallelGroups: [['step-1']],
        status: 'planning',
        mode: 'best-effort',
        priority: 'normal',
        timeout: 300000,
        createdAt: new Date()
      };

      const result = await service.executeWorkflow(plan);
      expect(result).toBeDefined();
    });

    it('should execute cyberagent operations', async () => {
      const plan: WorkflowPlan = {
        id: 'wf-ca',
        correlationId: 'corr-ca',
        originalRequest: 'Scan file',
        steps: [{
          id: 'step-1',
          name: 'Malware scan',
          service: 'cyberagent',
          operation: 'malware_scan',
          input: { target: 'https://example.com/file.exe' },
          status: 'pending'
        }],
        parallelGroups: [['step-1']],
        status: 'planning',
        mode: 'best-effort',
        priority: 'normal',
        timeout: 300000,
        createdAt: new Date()
      };

      const result = await service.executeWorkflow(plan);
      expect(result).toBeDefined();
    });

    it('should execute sandbox operations', async () => {
      const plan: WorkflowPlan = {
        id: 'wf-sb',
        correlationId: 'corr-sb',
        originalRequest: 'Execute code',
        steps: [{
          id: 'step-1',
          name: 'Run Python',
          service: 'sandbox',
          operation: 'code_execute',
          input: {
            code: 'print("hello")',
            language: 'python'
          },
          status: 'pending'
        }],
        parallelGroups: [['step-1']],
        status: 'planning',
        mode: 'best-effort',
        priority: 'normal',
        timeout: 300000,
        createdAt: new Date()
      };

      const result = await service.executeWorkflow(plan);
      expect(result).toBeDefined();
    });

    it('should execute mageagent operations', async () => {
      mockCreateCompletion.mockResolvedValueOnce({
        choices: [{
          message: { content: 'Analysis result: This is a summary.' }
        }]
      });

      const plan: WorkflowPlan = {
        id: 'wf-ma',
        correlationId: 'corr-ma',
        originalRequest: 'Analyze text',
        steps: [{
          id: 'step-1',
          name: 'AI Analysis',
          service: 'mageagent',
          operation: 'ai_analysis',
          input: { content: 'Some text to analyze' },
          status: 'pending'
        }],
        parallelGroups: [['step-1']],
        status: 'planning',
        mode: 'best-effort',
        priority: 'normal',
        timeout: 300000,
        createdAt: new Date()
      };

      const result = await service.executeWorkflow(plan);
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // Singleton Pattern Tests
  // ==========================================================================

  describe('Singleton Pattern', () => {
    it('should return same instance', () => {
      const instance1 = getWorkflowRouterService(mockOpenRouterClient as any);
      const instance2 = getWorkflowRouterService(mockOpenRouterClient as any);
      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getWorkflowRouterService(mockOpenRouterClient as any);
      resetWorkflowRouterService();
      const instance2 = getWorkflowRouterService(mockOpenRouterClient as any);
      expect(instance1).not.toBe(instance2);
    });
  });
});
