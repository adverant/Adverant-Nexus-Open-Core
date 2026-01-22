# Query Enhancement Techniques in RAG Systems

## Overview

Query enhancement is a pre-retrieval optimization technique that transforms user queries into forms more likely to retrieve relevant documents. Poor queries are the leading cause of retrieval failures, making query enhancement critical for RAG system performance.

## Query Enhancement Techniques

### 1. Query Rewriting

LLM-based reformulation of the original query to improve clarity and retrieval effectiveness.

**Process**:
```
Original: "how does the plan work?"
Rewritten: "Explain the implementation details, workflow, and execution process of the planning system"
```

**Benefits**:
- Adds specificity to vague queries
- Expands abbreviations and acronyms
- Removes ambiguity
- Typical improvement: 20-30% better retrieval

**Implementation**:
```typescript
const rewritePrompt = `
Rewrite this query to be more specific and suitable for retrieval:
Query: ${userQuery}
Rewritten query:
`;
```

### 2. HyDE (Hypothetical Document Embeddings)

Generate a hypothetical answer document, then use it for embedding-based retrieval.

**Concept**: Instead of searching "query → documents", search "hypothetical answer → similar documents"

**Process**:
1. LLM generates a hypothetical answer to the query
2. Embed the hypothetical answer
3. Search for documents similar to the hypothetical answer

**Example**:
```
Query: "How to implement caching in Node.js?"

Hypothetical Document:
"Caching in Node.js can be implemented using Redis or in-memory stores like
node-cache. For Redis, install the ioredis package and create a client
connection. Use set() to store cached values with optional TTL, and get()
to retrieve them. For in-memory caching, node-cache provides a simple
key-value store with automatic expiration..."
```

**Benefits**:
- Answer-to-answer similarity often outperforms query-to-document
- Generates domain-specific vocabulary
- Handles abstract queries well
- Typical improvement: 15-25% better retrieval

### 3. Multi-Query Expansion

Generate multiple query variations to increase retrieval recall.

**Process**:
1. Generate 3-5 variations of the original query
2. Execute retrieval for each variation
3. Merge and deduplicate results
4. Rerank combined results

**Example**:
```
Original: "machine learning model deployment"

Variations:
1. "ML model deployment to production"
2. "deploying trained models to cloud"
3. "model serving infrastructure setup"
4. "MLOps deployment best practices"
```

**Benefits**:
- Increases recall significantly
- Captures different phrasings of same concept
- Handles multi-faceted queries
- Typical improvement: 10-20% better recall

### 4. Query Decomposition

Break complex queries into simpler sub-queries.

**Process**:
1. Identify multiple aspects in the query
2. Generate separate sub-queries for each aspect
3. Retrieve documents for each sub-query
4. Synthesize final answer from all retrievals

**Example**:
```
Original: "Compare Redis and Memcached for caching in microservices"

Sub-queries:
1. "Redis features and capabilities"
2. "Memcached features and capabilities"
3. "Caching patterns in microservices architecture"
4. "Redis vs Memcached performance comparison"
```

**Best for**: Complex analytical queries, comparison questions, multi-step problems

### 5. Step-Back Prompting

Generate a higher-level, more abstract version of the query.

**Process**:
1. Identify the core concept behind the query
2. Generate a broader, more fundamental query
3. Retrieve for both specific and abstract queries
4. Combine context for comprehensive answers

**Example**:
```
Original: "Why does my React useEffect run twice?"
Step-back: "How does React's useEffect lifecycle work in strict mode?"
```

## Query Analysis

Before enhancement, analyze the query to determine the best strategy:

### Query Classification

| Query Type | Characteristics | Best Enhancement |
|------------|-----------------|------------------|
| Factual | Seeking specific facts | Query rewriting |
| Exploratory | Understanding concepts | HyDE, Multi-query |
| Comparative | Comparing options | Query decomposition |
| Procedural | How-to questions | HyDE |
| Troubleshooting | Problem solving | Step-back, Multi-query |

### Intent Detection

```typescript
interface QueryAnalysis {
  intent: 'factual' | 'exploratory' | 'comparative' | 'procedural';
  complexity: 'simple' | 'moderate' | 'complex';
  entities: string[];
  keywords: string[];
}
```

## Adaptive Query Routing

Route queries to optimal enhancement strategies based on analysis:

```
┌─────────────────────────────────────────────┐
│                Query Router                  │
├─────────────────────────────────────────────┤
│  Greeting/Chat → Direct LLM (no retrieval)  │
│  Simple factual → Light rewriting           │
│  Complex query → Full enhancement pipeline  │
│  Comparison → Query decomposition           │
│  Abstract → HyDE + Step-back                │
└─────────────────────────────────────────────┘
```

## Implementation Best Practices

1. **Cache enhanced queries** to avoid redundant LLM calls
2. **Set quality thresholds** for when to apply enhancement
3. **Monitor enhancement latency** (typically 100-300ms per technique)
4. **A/B test enhancement strategies** for your domain
5. **Combine techniques** for complex queries
6. **Preserve original query** for fallback

## Performance Considerations

| Technique | Latency | LLM Calls | Improvement |
|-----------|---------|-----------|-------------|
| Query Rewriting | 100-200ms | 1 | 20-30% |
| HyDE | 150-300ms | 1 | 15-25% |
| Multi-Query | 200-400ms | 1 | 10-20% |
| Decomposition | 200-500ms | 1-2 | 15-30% |
| Step-Back | 100-200ms | 1 | 10-15% |

## References

- Gao et al. (2022): "Precise Zero-Shot Dense Retrieval without Relevance Labels" (HyDE)
- Ma et al. (2023): "Query Rewriting for Retrieval-Augmented Large Language Models"
- Zheng et al. (2023): "Take a Step Back: Evoking Reasoning via Abstraction"
