# RAG Triad: Quality Evaluation Framework

## Overview

The RAG Triad is a comprehensive evaluation framework for assessing the quality of Retrieval-Augmented Generation systems. It evaluates three critical dimensions: Context Relevance, Groundedness, and Answer Relevance.

## The Three Pillars

### 1. Context Relevance

**Definition**: How relevant is the retrieved context to the user's query?

**What it measures**:
- Are the retrieved documents actually about the query topic?
- Do the chunks contain information needed to answer the question?
- Is there noise or irrelevant content in the context?

**Scoring**:
- **1.0**: All retrieved content directly relates to the query
- **0.7-0.9**: Most content is relevant with minor noise
- **0.4-0.6**: Mixed relevance, significant irrelevant content
- **0.0-0.3**: Mostly or entirely irrelevant content

**Evaluation Approach**:
```typescript
async function evaluateContextRelevance(
  query: string,
  retrievedChunks: string[]
): Promise<number> {
  const prompt = `
    Query: ${query}

    Retrieved Context:
    ${retrievedChunks.join('\n---\n')}

    Rate how relevant the retrieved context is to answering the query.
    Consider:
    - Does the context contain information about the query topic?
    - Is the context specific enough to be useful?
    - How much irrelevant content is included?

    Score (0.0 to 1.0):
  `;
  return await llm.generateScore(prompt);
}
```

### 2. Groundedness (Faithfulness)

**Definition**: Is the generated answer supported by the retrieved context?

**What it measures**:
- Are all claims in the answer backed by the context?
- Is the model hallucinating information not in the context?
- Are there unsupported statements or fabrications?

**Scoring**:
- **1.0**: Every claim is directly supported by context
- **0.7-0.9**: Most claims supported, minor extrapolations
- **0.4-0.6**: Some claims unsupported or questionable
- **0.0-0.3**: Significant hallucination or fabrication

**Evaluation Approach**:
```typescript
async function evaluateGroundedness(
  context: string,
  answer: string
): Promise<GroundednessResult> {
  const prompt = `
    Context:
    ${context}

    Generated Answer:
    ${answer}

    For each claim in the answer, determine if it is:
    1. Directly supported by the context
    2. Reasonably inferred from the context
    3. Not supported by the context (potential hallucination)

    List unsupported claims and provide overall groundedness score (0.0 to 1.0):
  `;

  const result = await llm.generate(prompt);
  return {
    score: extractScore(result),
    unsupportedClaims: extractClaims(result)
  };
}
```

### 3. Answer Relevance

**Definition**: Does the generated answer actually address the user's query?

**What it measures**:
- Is the answer on-topic for the question asked?
- Does it provide the information the user was seeking?
- Is it complete or does it miss key aspects?

**Scoring**:
- **1.0**: Fully addresses the query with complete information
- **0.7-0.9**: Addresses most aspects, minor gaps
- **0.4-0.6**: Partially addresses query, significant gaps
- **0.0-0.3**: Does not address the query or is off-topic

**Evaluation Approach**:
```typescript
async function evaluateAnswerRelevance(
  query: string,
  answer: string
): Promise<AnswerRelevanceResult> {
  const prompt = `
    User Query: ${query}

    Generated Answer:
    ${answer}

    Evaluate how well the answer addresses the user's query:
    1. Does it answer what was asked?
    2. Is it complete or are there unanswered aspects?
    3. Is it appropriately detailed for the question?

    List any unanswered aspects and provide overall relevance score (0.0 to 1.0):
  `;

  const result = await llm.generate(prompt);
  return {
    score: extractScore(result),
    unansweredAspects: extractAspects(result)
  };
}
```

## Combined RAG Triad Score

### Weighting Strategy

Default weights (adjustable per use case):
```typescript
const TRIAD_WEIGHTS = {
  contextRelevance: 0.35,
  groundedness: 0.35,
  answerRelevance: 0.30
};

function calculateOverallScore(triad: TriadScores): number {
  return (
    triad.contextRelevance * TRIAD_WEIGHTS.contextRelevance +
    triad.groundedness * TRIAD_WEIGHTS.groundedness +
    triad.answerRelevance * TRIAD_WEIGHTS.answerRelevance
  );
}
```

### Quality Thresholds

| Overall Score | Quality Level | Action |
|---------------|---------------|--------|
| >= 0.85 | Excellent | Return with confidence |
| 0.70 - 0.84 | Good | Return, log for review |
| 0.50 - 0.69 | Fair | Consider refinement |
| < 0.50 | Poor | Trigger self-correction |

## Diagnostic Information

### Identifying Issues

The RAG Triad provides actionable diagnostics:

```typescript
interface TriadDiagnostics {
  // From Context Relevance
  irrelevantChunks: string[];

  // From Groundedness
  unsupportedClaims: string[];

  // From Answer Relevance
  unansweredAspects: string[];

  // Suggested improvements
  suggestions: string[];
}
```

### Remediation Strategies

| Issue | Metric Affected | Remediation |
|-------|-----------------|-------------|
| Irrelevant docs retrieved | Context Relevance | Improve query, rerank |
| Hallucinated content | Groundedness | Add citations, constrain generation |
| Incomplete answer | Answer Relevance | Expand retrieval, decompose query |
| All metrics low | Overall | Full pipeline refinement |

## Implementation Example

```typescript
class RAGTriadEvaluator {
  async evaluate(
    query: string,
    context: string[],
    answer: string
  ): Promise<TriadEvaluation> {
    // Evaluate all three dimensions in parallel
    const [contextRel, grounded, answerRel] = await Promise.all([
      this.evaluateContextRelevance(query, context),
      this.evaluateGroundedness(context.join('\n'), answer),
      this.evaluateAnswerRelevance(query, answer)
    ]);

    // Calculate overall score
    const overall = this.calculateOverall(contextRel, grounded, answerRel);

    // Generate diagnostics
    const diagnostics = this.generateDiagnostics(
      contextRel,
      grounded,
      answerRel
    );

    return {
      scores: {
        contextRelevance: contextRel.score,
        groundedness: grounded.score,
        answerRelevance: answerRel.score,
        overall
      },
      diagnostics,
      suggestions: this.generateSuggestions(diagnostics)
    };
  }
}
```

## Optimizing Each Dimension

### Improving Context Relevance
1. Better embedding models (domain-specific)
2. Hybrid retrieval (dense + sparse)
3. Query enhancement techniques
4. Metadata filtering
5. Reranking with cross-encoders

### Improving Groundedness
1. Explicit citation instructions in prompts
2. Lower temperature for generation
3. Constrained decoding
4. Post-generation verification
5. Source attribution requirements

### Improving Answer Relevance
1. Query decomposition for complex questions
2. Multiple retrieval passes
3. Answer format instructions
4. Iterative refinement
5. User intent clarification

## Continuous Monitoring

### Metrics to Track
- Average scores per dimension over time
- Distribution of scores (identify outliers)
- Correlation between dimensions
- Impact of system changes on scores

### Alerting Thresholds
```typescript
const ALERT_THRESHOLDS = {
  contextRelevance: { warning: 0.6, critical: 0.4 },
  groundedness: { warning: 0.7, critical: 0.5 },
  answerRelevance: { warning: 0.6, critical: 0.4 },
  overall: { warning: 0.65, critical: 0.45 }
};
```

## References

- TruLens: "The RAG Triad" evaluation framework
- RAGAS: "Retrieval Augmented Generation Assessment"
- Anthropic: "Constitutional AI" for self-evaluation
