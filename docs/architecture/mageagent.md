# MageAgent Architecture: Multi-Agent Orchestration

**How Adverant Nexus orchestrates 320+ LLM models with production-grade async patterns, intelligent routing, and real-time streaming.**

---

## Table of Contents

1. [Why Multi-Agent Orchestration?](#why-multi-agent-orchestration)
2. [Architecture Overview](#architecture-overview)
3. [Async Task Pattern](#async-task-pattern)
4. [Intelligent Model Routing](#intelligent-model-routing)
5. [Tool Integration](#tool-integration)
6. [Streaming Architecture](#streaming-architecture)
7. [Queue Management](#queue-management)
8. [Performance & Optimization](#performance--optimization)

---

## Why Multi-Agent Orchestration?

### The Problem with Synchronous LLM Calls

Traditional approach: **blocking HTTP requests** to LLM APIs

```typescript
// ❌ PROBLEM: Blocks server thread for 5-30 seconds
app.post('/chat', async (req, res) => {
    const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: req.body.messages
    });
    res.json(response);  // Client waits 5-30 seconds!
});
```

**Issues:**
- ❌ **Timeouts**: HTTP requests timeout after 30-60s
- ❌ **Resource waste**: Server threads blocked waiting for LLM
- ❌ **No progress updates**: Client sees nothing until completion
- ❌ **Poor UX**: Users stare at loading spinners
- ❌ **No cancellation**: Can't abort running tasks

### The MageAgent Solution

**Async task pattern** with real-time streaming:

```typescript
// ✅ SOLUTION: Return task ID immediately, stream results
app.post('/tasks', async (req, res) => {
    // Enqueue task (returns in <10ms)
    const taskId = await mageAgent.enqueueTask(req.body);

    // Return task ID immediately
    res.json({ taskId, status: 'queued' });
});

// Client can then:
// 1. Poll: GET /tasks/:id
// 2. Stream (SSE): GET /tasks/:id/stream
// 3. WebSocket: WS /tasks/:id/ws
```

**Benefits:**
- ✅ **No timeouts**: Client not blocked
- ✅ **Real-time updates**: See partial results as they stream
- ✅ **Cancellable**: Can abort tasks
- ✅ **Scalable**: Queue buffers load spikes
- ✅ **Better UX**: Streaming text appears character-by-character

---

## Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                   MageAgent Service (:8080)                      │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │   API        │  │   Task       │  │   Model               │ │
│  │   Gateway    │  │   Queue      │  │   Router              │ │
│  │              │  │   (BullMQ)   │  │   (320+ models)       │ │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────────────┘ │
│         │                 │                  │                  │
│         └─────────────────┼──────────────────┘                  │
│                           │                                     │
│  ┌────────────────────────┴────────────────────────┐            │
│  │          Agent Worker Pool (1-10 workers)       │            │
│  │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐        │            │
│  │  │Worker│  │Worker│  │Worker│  │Worker│  ...   │            │
│  │  │  #1  │  │  #2  │  │  #3  │  │  #4  │        │            │
│  │  └──────┘  └──────┘  └──────┘  └──────┘        │            │
│  │      │          │          │          │         │            │
│  │      └──────────┴──────────┴──────────┘         │            │
│  │                     │                           │            │
│  └─────────────────────┼───────────────────────────┘            │
│                        │                                        │
└────────────────────────┼────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │  Redis   │   │ GraphRAG │   │  LLM     │
    │  Queue   │   │ Context  │   │  APIs    │
    │  + Pub/  │   │ Retrieval│   │ (OpenAI, │
    │   Sub    │   │          │   │Anthropic)│
    └──────────┘   └──────────┘   └──────────┘
```

### Request Flow

```
1. Client → POST /mageagent/api/v1/tasks
         ↓
2. API Gateway validates + authenticates
         ↓
3. Task enqueued in BullMQ (Redis)
         │
         ├─→ Return taskId to client (immediate response)
         │
         ▼
4. Worker picks up task from queue
         ↓
5. Worker executes task:
         │
         ├─→ Retrieve context from GraphRAG (if needed)
         ├─→ Route to appropriate LLM (model selection)
         ├─→ Execute tools (web search, code exec, etc.)
         ├─→ Stream response chunks
         └─→ Update task status in Redis
              │
              ▼
6. Client receives updates via:
   - Polling: GET /tasks/:id
   - SSE: GET /tasks/:id/stream
   - WebSocket: WS /tasks/:id/ws
```

---

## Async Task Pattern

### Task Lifecycle

```
QUEUED → PROCESSING → COMPLETED
   │         │              ↑
   │         └──→ FAILED ───┘
   │
   └──→ CANCELLED
```

### Task Schema

```typescript
interface Task {
    id: string;              // UUID
    company_id: string;      // Multi-tenant isolation
    app_id: string;
    status: TaskStatus;      // queued, processing, completed, failed, cancelled

    // Input
    prompt: string;
    model?: string;          // Optional model selection
    context?: {
        useGraphRAG?: boolean;
        graphragQuery?: string;
        additionalContext?: string;
    };
    tools?: string[];        // ['web_search', 'code_execution']
    stream?: boolean;        // Enable streaming

    // Output
    result?: {
        content: string;
        model: string;
        tokensUsed: number;
        finishReason: string;
    };
    error?: {
        message: string;
        code: string;
        stack?: string;
    };

    // Metadata
    created_at: Date;
    started_at?: Date;
    completed_at?: Date;
    estimated_duration_ms?: number;
}
```

### Task Enqueuing

```typescript
class MageAgentService {
    async enqueueTask(input: TaskInput): Promise<Task> {
        // 1. Validate input
        this.validateTaskInput(input);

        // 2. Create task record
        const task: Task = {
            id: uuidv4(),
            company_id: this.context.companyId,
            app_id: this.context.appId,
            status: 'queued',
            prompt: input.prompt,
            model: input.model,
            context: input.context,
            tools: input.tools || [],
            stream: input.stream ?? true,
            created_at: new Date()
        };

        // 3. Store task in Redis (for status tracking)
        await this.redis.setex(
            `task:${task.id}`,
            86400,  // 24 hour TTL
            JSON.stringify(task)
        );

        // 4. Enqueue in BullMQ
        await this.taskQueue.add('execute-task', task, {
            jobId: task.id,
            attempts: 3,              // Retry 3 times on failure
            backoff: {
                type: 'exponential',
                delay: 2000            // Start with 2s, double each retry
            },
            timeout: 300000            // 5 minute timeout
        });

        return task;
    }
}
```

### Task Worker

```typescript
class TaskWorker {
    constructor(
        private queue: Queue,
        private modelRouter: ModelRouter,
        private graphragClient: GraphRAGClient,
        private redis: Redis
    ) {
        this.setupWorker();
    }

    private setupWorker() {
        // Process jobs from queue
        this.queue.process('execute-task', async (job) => {
            const task: Task = job.data;

            try {
                // Update status
                await this.updateTaskStatus(task.id, 'processing');

                // Execute task
                const result = await this.executeTask(task);

                // Store result
                await this.updateTaskStatus(task.id, 'completed', result);

                return result;
            } catch (error) {
                // Handle failure
                await this.updateTaskStatus(task.id, 'failed', null, error);
                throw error;  // BullMQ will retry
            }
        });
    }

    private async executeTask(task: Task): Promise<TaskResult> {
        const steps: string[] = [];

        // Step 1: Retrieve context from GraphRAG (if needed)
        let context = task.context?.additionalContext || '';
        if (task.context?.useGraphRAG && task.context.graphragQuery) {
            const graphragResults = await this.graphragClient.retrieve({
                query: task.context.graphragQuery,
                limit: 5
            });
            context += '\n\nRelevant context:\n' + graphragResults.map(r => r.content).join('\n\n');
            steps.push('graphrag_retrieval');
        }

        // Step 2: Route to appropriate LLM
        const model = await this.modelRouter.selectModel({
            requestedModel: task.model,
            prompt: task.prompt,
            context: context,
            tools: task.tools
        });
        steps.push(`model_selected:${model.provider}:${model.name}`);

        // Step 3: Execute LLM call with streaming
        const result = await this.executeLLMCall(task, model, context);
        steps.push('llm_execution');

        return {
            ...result,
            steps,
            model: `${model.provider}/${model.name}`
        };
    }

    private async executeLLMCall(
        task: Task,
        model: ModelInfo,
        context: string
    ): Promise<LLMResult> {
        // Build messages
        const messages = [
            { role: 'system', content: 'You are a helpful AI assistant.' },
            ...(context ? [{ role: 'system', content: `Context:\n${context}` }] : []),
            { role: 'user', content: task.prompt }
        ];

        // Call LLM with streaming
        const stream = await model.client.chat.completions.create({
            model: model.name,
            messages,
            stream: true,
            tools: this.buildTools(task.tools)
        });

        // Stream chunks to client via Redis Pub/Sub
        let fullContent = '';
        let tokensUsed = 0;

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || '';
            if (delta) {
                fullContent += delta;

                // Publish chunk to subscribers
                await this.redis.publish(
                    `task:${task.id}:stream`,
                    JSON.stringify({ type: 'chunk', content: delta })
                );
            }

            tokensUsed += chunk.usage?.total_tokens || 0;
        }

        // Publish completion
        await this.redis.publish(
            `task:${task.id}:stream`,
            JSON.stringify({ type: 'done' })
        );

        return {
            content: fullContent,
            tokensUsed,
            finishReason: 'stop'
        };
    }
}
```

---

## Intelligent Model Routing

### Model Selection Strategy

MageAgent supports **320+ LLM models** via multiple providers:

| Provider | Models | Strengths |
|----------|--------|-----------|
| **OpenAI** | GPT-4, GPT-3.5 Turbo | Best general quality, function calling |
| **Anthropic** | Claude 3.5 Sonnet, Opus, Haiku | 200K context, best for long documents |
| **Google** | Gemini Pro, Ultra | Multimodal (vision), fast |
| **Cohere** | Command, Command-R | Best for retrieval, reranking |
| **OpenRouter** | 320+ models | Llama 3, Mixtral, Qwen, etc. |

### Routing Logic

```typescript
class ModelRouter {
    async selectModel(request: ModelRequest): Promise<ModelInfo> {
        // 1. If model explicitly requested, use it
        if (request.requestedModel) {
            return this.getModelInfo(request.requestedModel);
        }

        // 2. Otherwise, route based on task characteristics
        const characteristics = this.analyzeTask(request);

        // Route by context length
        if (characteristics.tokenCount > 100000) {
            return this.getModelInfo('claude-3-5-sonnet-20241022');  // 200K context
        }

        // Route by tool usage
        if (request.tools?.length > 0) {
            return this.getModelInfo('gpt-4-turbo');  // Best function calling
        }

        // Route by cost optimization
        if (characteristics.complexity === 'simple') {
            return this.getModelInfo('gpt-3.5-turbo');  // Fast + cheap
        }

        // Route by quality requirement
        if (characteristics.complexity === 'complex') {
            return this.getModelInfo('gpt-4-turbo');  // Best quality
        }

        // Default to balanced option
        return this.getModelInfo('claude-3-5-sonnet-20241022');
    }

    private analyzeTask(request: ModelRequest): TaskCharacteristics {
        const promptTokens = this.countTokens(request.prompt);
        const contextTokens = this.countTokens(request.context || '');
        const totalTokens = promptTokens + contextTokens;

        // Estimate complexity based on prompt
        const complexity = this.estimateComplexity(request.prompt);

        return {
            tokenCount: totalTokens,
            complexity,
            hasTools: (request.tools?.length || 0) > 0,
            estimatedCost: this.estimateCost(totalTokens, complexity)
        };
    }

    private estimateComplexity(prompt: string): 'simple' | 'medium' | 'complex' {
        const indicators = {
            simple: ['summarize', 'translate', 'extract'],
            complex: ['analyze', 'reason', 'explain', 'compare', 'evaluate']
        };

        const lowerPrompt = prompt.toLowerCase();

        if (indicators.complex.some(word => lowerPrompt.includes(word))) {
            return 'complex';
        }
        if (indicators.simple.some(word => lowerPrompt.includes(word))) {
            return 'simple';
        }
        return 'medium';
    }
}
```

### Cost Optimization

**Smart routing can save 40-60% on LLM costs:**

| Task | Without Routing | With Routing | Savings |
|------|----------------|--------------|---------|
| Simple summary (500 tokens) | GPT-4: $0.03 | GPT-3.5: $0.001 | **97%** |
| Long document analysis (150K tokens) | GPT-4: $4.50 | Claude Sonnet: $1.50 | **67%** |
| Function calling | GPT-4: $0.03 | GPT-4 Turbo: $0.02 | **33%** |

---

## Tool Integration

### Available Tools

MageAgent agents can use external tools for extended capabilities:

```typescript
interface Tool {
    name: string;
    description: string;
    parameters: JSONSchema;
    execute: (params: any) => Promise<any>;
}

const AVAILABLE_TOOLS: Tool[] = [
    {
        name: 'web_search',
        description: 'Search the web for current information',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                num_results: { type: 'number', default: 5 }
            },
            required: ['query']
        },
        execute: async ({ query, num_results }) => {
            return await webSearchService.search(query, num_results);
        }
    },
    {
        name: 'code_execution',
        description: 'Execute code in a secure sandbox (Python, JavaScript, etc.)',
        parameters: {
            type: 'object',
            properties: {
                language: { type: 'string', enum: ['python', 'javascript', 'bash'] },
                code: { type: 'string', description: 'Code to execute' }
            },
            required: ['language', 'code']
        },
        execute: async ({ language, code }) => {
            return await sandboxService.execute(language, code);
        }
    },
    {
        name: 'graphrag_search',
        description: 'Search the knowledge base for relevant information',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                limit: { type: 'number', default: 5 }
            },
            required: ['query']
        },
        execute: async ({ query, limit }) => {
            return await graphragClient.retrieve({ query, limit });
        }
    },
    {
        name: 'file_processing',
        description: 'Process files (PDF, images, etc.)',
        parameters: {
            type: 'object',
            properties: {
                file_url: { type: 'string', description: 'URL of file to process' },
                operation: { type: 'string', enum: ['extract_text', 'ocr', 'summarize'] }
            },
            required: ['file_url', 'operation']
        },
        execute: async ({ file_url, operation }) => {
            return await fileProcessService.process(file_url, operation);
        }
    }
];
```

### Function Calling Flow

```
1. Agent receives task with tools enabled
         ↓
2. LLM generates response with function call
   Example: { "name": "web_search", "arguments": { "query": "latest AI news" } }
         ↓
3. Agent executes tool
   Result: [{ "title": "OpenAI releases GPT-5", "url": "...", "snippet": "..." }]
         ↓
4. Agent sends tool result back to LLM
   Message: { "role": "function", "name": "web_search", "content": "..." }
         ↓
5. LLM generates final response incorporating tool results
   Output: "Based on the latest search results, OpenAI just released GPT-5 which..."
```

---

## Streaming Architecture

### Three Streaming Methods

#### 1. Server-Sent Events (SSE)

**Best for:** Web browsers, simple integration

```typescript
// Server-side
app.get('/tasks/:id/stream', async (req, res) => {
    const taskId = req.params.id;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Subscribe to Redis pub/sub for this task
    const subscriber = this.redis.duplicate();
    await subscriber.subscribe(`task:${taskId}:stream`);

    // Forward messages to client
    subscriber.on('message', (channel, message) => {
        const data = JSON.parse(message);

        if (data.type === 'chunk') {
            res.write(`data: ${JSON.stringify({ content: data.content })}\n\n`);
        } else if (data.type === 'done') {
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            res.end();
        }
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        subscriber.unsubscribe();
        subscriber.quit();
    });
});
```

**Client-side:**
```javascript
const eventSource = new EventSource(`/tasks/${taskId}/stream`);

eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.done) {
        eventSource.close();
    } else {
        // Append chunk to UI
        appendText(data.content);
    }
};
```

#### 2. WebSocket

**Best for:** Bidirectional communication, mobile apps

```typescript
// Server-side (Socket.io)
io.on('connection', (socket) => {
    socket.on('subscribe-task', async ({ taskId }) => {
        // Subscribe to Redis pub/sub
        const subscriber = redis.duplicate();
        await subscriber.subscribe(`task:${taskId}:stream`);

        subscriber.on('message', (channel, message) => {
            const data = JSON.parse(message);
            socket.emit('task-update', data);
        });

        socket.on('disconnect', () => {
            subscriber.unsubscribe();
            subscriber.quit();
        });
    });
});
```

**Client-side:**
```javascript
const socket = io('http://localhost:8080');

socket.emit('subscribe-task', { taskId });

socket.on('task-update', (data) => {
    if (data.type === 'chunk') {
        appendText(data.content);
    }
});
```

#### 3. HTTP Polling

**Best for:** Simple clients, fallback option

```typescript
// Client polls every 1 second
const poll = async () => {
    const response = await fetch(`/tasks/${taskId}`);
    const task = await response.json();

    if (task.status === 'completed') {
        displayResult(task.result.content);
        clearInterval(pollInterval);
    } else if (task.status === 'failed') {
        displayError(task.error);
        clearInterval(pollInterval);
    }
};

const pollInterval = setInterval(poll, 1000);
```

---

## Queue Management

### BullMQ Configuration

```typescript
const taskQueue = new Queue('agent-tasks', {
    connection: {
        host: 'localhost',
        port: 6379
    },
    defaultJobOptions: {
        attempts: 3,              // Retry failed jobs 3 times
        backoff: {
            type: 'exponential',
            delay: 2000            // 2s, 4s, 8s
        },
        removeOnComplete: {
            count: 1000,           // Keep last 1000 completed jobs
            age: 86400             // Remove after 24 hours
        },
        removeOnFail: {
            count: 5000            // Keep last 5000 failed jobs for debugging
        }
    }
});
```

### Worker Concurrency

```typescript
// Process up to 10 jobs concurrently per worker
const worker = new Worker('agent-tasks', async (job) => {
    return await executeTask(job.data);
}, {
    connection: { host: 'localhost', port: 6379 },
    concurrency: 10,              // 10 concurrent jobs
    limiter: {
        max: 100,                 // Max 100 jobs per duration
        duration: 1000            // Per second
    }
});
```

### Queue Monitoring

```typescript
// Get queue metrics
const metrics = await taskQueue.getMetrics();

console.log({
    waiting: metrics.waiting,      // Jobs in queue
    active: metrics.active,        // Jobs being processed
    completed: metrics.completed,  // Jobs completed
    failed: metrics.failed,        // Jobs failed
    delayed: metrics.delayed       // Jobs scheduled for future
});

// Calculate average processing time
const jobs = await taskQueue.getCompleted(0, 100);
const avgTime = jobs.reduce((sum, job) => {
    return sum + (job.finishedOn - job.processedOn);
}, 0) / jobs.length;

console.log(`Average processing time: ${avgTime}ms`);
```

---

## Performance & Optimization

### Throughput Benchmarks

| Configuration | Concurrent Tasks | Throughput (tasks/sec) |
|--------------|------------------|------------------------|
| 1 worker, concurrency=1 | 1 | 0.2-0.5 (LLM limited) |
| 1 worker, concurrency=10 | 10 | 2-5 |
| 5 workers, concurrency=10 | 50 | 10-25 |
| 10 workers, concurrency=10 | 100 | 20-50 |

**Bottleneck:** LLM API rate limits (not CPU or memory)

### Latency Breakdown

```
Total latency: 3,500ms

1. Queue enqueue:           5ms   (0.1%)
2. Worker pickup:          50ms   (1.4%)
3. GraphRAG context:      200ms   (5.7%)
4. LLM API call:        3,000ms   (85.7%)
5. Result storage:         20ms   (0.6%)
6. Pub/sub broadcast:       5ms   (0.1%)
7. Client receives:       220ms   (6.3%)
```

**Optimization target:** Reduce LLM latency (use faster models for simple tasks)

### Memory Usage

```
Per worker process:
- Base Node.js:           50MB
- BullMQ client:          20MB
- Redis connections:      10MB
- LLM SDK clients:        30MB
- Active job contexts:   100MB (10 jobs × 10MB each)
-----------------------------------
Total per worker:        210MB

With 10 workers: ~2.1GB RAM
```

### Scaling Strategy

**Vertical Scaling:**
- Increase worker concurrency (10 → 20)
- Add more workers on same machine (limited by CPU)

**Horizontal Scaling:**
- Deploy workers across multiple machines
- All workers connect to same Redis queue
- Load automatically distributed

**Auto-scaling:**
```typescript
// Scale workers based on queue depth
const scaleWorkers = async () => {
    const waiting = await taskQueue.count({ status: 'waiting' });

    if (waiting > 100) {
        // Spin up more workers (Kubernetes HPA)
        await k8s.scaleDeployment('mageagent-workers', { replicas: 10 });
    } else if (waiting < 10) {
        // Scale down
        await k8s.scaleDeployment('mageagent-workers', { replicas: 2 });
    }
};
```

---

## Next Steps

- **[Infrastructure Packages](infrastructure.md)** - Shared libraries used by MageAgent
- **[Data Flow](data-flow.md)** - Request lifecycle across services
- **[API Reference](../api/mageagent.md)** - MageAgent API endpoints
- **[Tutorials](../tutorials/custom-agent.md)** - Build custom agents

---

**[← Back to GraphRAG Architecture](graphrag.md)** | **[Next: Infrastructure Packages →](infrastructure.md)**
