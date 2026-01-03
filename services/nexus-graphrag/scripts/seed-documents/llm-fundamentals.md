# Large Language Model Fundamentals

## Overview

Large Language Models (LLMs) are neural networks trained on vast amounts of text data to understand and generate human language. They form the generation component of RAG systems and power modern AI assistants.

## Transformer Architecture

### Core Components

**Self-Attention Mechanism**:
The key innovation enabling LLMs to understand context across long sequences.

```
Attention(Q, K, V) = softmax(QK^T / √d_k) V
```

Where:
- Q (Query): What we're looking for
- K (Key): What each token offers
- V (Value): The actual information
- d_k: Dimension of keys (for scaling)

**Multi-Head Attention**:
Multiple attention heads capture different relationship types:
- Syntactic relationships
- Semantic similarities
- Long-range dependencies
- Co-reference resolution

**Feed-Forward Networks**:
Process each position independently after attention:
```
FFN(x) = max(0, xW₁ + b₁)W₂ + b₂
```

### Architecture Variants

| Type | Examples | Characteristics |
|------|----------|-----------------|
| Decoder-only | GPT, Claude, Llama | Autoregressive, best for generation |
| Encoder-only | BERT, RoBERTa | Bidirectional, best for understanding |
| Encoder-Decoder | T5, BART | Seq2seq, best for translation |

## Context Windows

### What is a Context Window?

The maximum number of tokens the model can process in a single forward pass.

| Model | Context Window |
|-------|---------------|
| GPT-3.5 | 16K tokens |
| GPT-4 | 128K tokens |
| Claude 3 | 200K tokens |
| Gemini 1.5 | 1M+ tokens |

### Token Counting

Tokens are subword units, not words:
- Average: 1 word ≈ 1.3-1.5 tokens
- Code: Often more tokens per line
- Non-English: Typically more tokens

```typescript
// Approximate token counting
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // Rough estimate
}
```

### Context Management

**Strategies for limited context**:
1. Summarization of older content
2. Sliding window with overlap
3. Hierarchical summarization
4. RAG for external knowledge

## Tokenization

### Subword Tokenization

Modern LLMs use subword tokenization (BPE, SentencePiece):

```
"Tokenization" → ["Token", "ization"]
"unhappiness" → ["un", "happiness"]
```

**Benefits**:
- Handles unknown words
- Balances vocabulary size and sequence length
- Language-agnostic

### Special Tokens

| Token | Purpose |
|-------|---------|
| `<|begin|>` | Start of sequence |
| `<|end|>` | End of sequence |
| `<|user|>` | User turn marker |
| `<|assistant|>` | Assistant turn marker |
| `<|system|>` | System prompt marker |

## Generation Parameters

### Temperature

Controls randomness in token selection:
- **0.0**: Deterministic (always picks highest probability)
- **0.7**: Balanced creativity
- **1.0**: Standard sampling
- **1.5+**: High creativity, more random

```typescript
// Softmax with temperature
P(token) = exp(logit / T) / Σ exp(logits / T)
```

### Top-P (Nucleus Sampling)

Sample from tokens comprising top P probability mass:
- **0.1**: Very focused, repetitive
- **0.9**: Standard setting
- **1.0**: Consider all tokens

### Top-K

Only consider the K highest probability tokens:
- **1**: Greedy decoding
- **40**: Common default
- **Unlimited**: Consider all tokens

### Frequency/Presence Penalties

Reduce repetition:
- **Frequency penalty**: Penalize based on occurrence count
- **Presence penalty**: Penalize any repeated token equally

## Prompt Engineering

### System Prompts

Set the model's behavior and constraints:
```
You are a helpful assistant that answers questions based on
the provided context. Only use information from the context.
If you don't know, say so.
```

### Few-Shot Prompting

Provide examples to guide behavior:
```
Q: What is the capital of France?
A: Paris

Q: What is the capital of Japan?
A: Tokyo

Q: What is the capital of Brazil?
A:
```

### Chain-of-Thought

Encourage step-by-step reasoning:
```
Think through this step by step:
1. First, identify the key concepts
2. Then, analyze their relationships
3. Finally, form your conclusion
```

### Structured Output

Request specific formats:
```
Respond in JSON format:
{
  "answer": "your answer",
  "confidence": 0.0-1.0,
  "sources": ["source1", "source2"]
}
```

## Model Capabilities

### Reasoning
- Mathematical computation
- Logical inference
- Causal reasoning
- Analogical thinking

### Language Understanding
- Sentiment analysis
- Named entity recognition
- Summarization
- Translation

### Code
- Code generation
- Bug fixing
- Code explanation
- Language translation

### Following Instructions
- Complex multi-step tasks
- Format adherence
- Constraint satisfaction
- Role-playing

## Limitations

### Hallucination
Models can generate plausible-sounding but incorrect information.

**Mitigation**:
- RAG for factual grounding
- Citation requirements
- Confidence calibration

### Knowledge Cutoff
Training data has a cutoff date.

**Mitigation**:
- RAG for current information
- Web search integration
- Clear disclosure

### Context Limitations
Cannot process unlimited text.

**Mitigation**:
- Summarization
- Hierarchical processing
- Chunked retrieval

## Best Practices

1. **Use clear, specific prompts** with examples
2. **Set appropriate temperature** for the task
3. **Implement RAG** for factual accuracy
4. **Validate outputs** before using
5. **Handle errors gracefully** with fallbacks
6. **Monitor token usage** for cost control

## Model Selection

| Use Case | Recommended |
|----------|-------------|
| High accuracy, complex reasoning | Claude 3 Opus, GPT-4 |
| Fast responses, simple tasks | Claude 3 Haiku, GPT-3.5 |
| Cost-sensitive | Open-source (Llama, Mistral) |
| Code generation | Claude 3.5 Sonnet, GPT-4 |
| Long documents | Claude 3 (200K), Gemini 1.5 |

## References

- Vaswani et al. (2017): "Attention Is All You Need"
- Brown et al. (2020): "Language Models are Few-Shot Learners"
- Anthropic: Claude Model Card
- OpenAI: GPT-4 Technical Report
