# Prompt Engineering for RAG Systems

## Overview

Prompt engineering is the practice of designing effective prompts to guide LLM behavior. In RAG systems, prompts must effectively incorporate retrieved context while maintaining clarity and encouraging grounded responses.

## RAG Prompt Structure

### Basic Template

```
System: You are a helpful assistant that answers questions based on
the provided context. Use only the information in the context to
answer. If you cannot find the answer in the context, say so.

Context:
{retrieved_documents}

User: {user_query}
```

### Advanced Template with Citations

```
System: You are a research assistant. Answer questions using ONLY
the provided sources. Cite sources using [1], [2], etc.

Sources:
[1] {document_1}
[2] {document_2}
[3] {document_3}

Question: {user_query}

Instructions:
- Use only information from the sources above
- Cite every claim with the source number
- If the sources don't contain the answer, say so
- Be concise and direct
```

## System Prompt Design

### Key Elements

1. **Role Definition**: Who the assistant is
2. **Behavior Guidelines**: How to respond
3. **Constraints**: What NOT to do
4. **Output Format**: How to structure responses

### Example System Prompts

**Factual Assistant**:
```
You are a factual assistant that provides accurate information.
Always base your answers on the provided context.
If you're unsure or the context doesn't contain the answer, say
"I don't have enough information to answer that."
Never make up information.
```

**Technical Documentation**:
```
You are a technical documentation assistant.
Provide clear, step-by-step instructions based on the context.
Use code blocks for any code snippets.
Include relevant examples when helpful.
Format your response with headers and bullet points for clarity.
```

**Conversational Assistant**:
```
You are a friendly assistant helping users with questions.
Be conversational but informative.
When using information from the context, naturally incorporate it.
Ask clarifying questions if the query is ambiguous.
```

## Context Formatting

### Numbered Sources

```
The following sources may help answer the question:

Source 1: {title_1}
{content_1}

Source 2: {title_2}
{content_2}
```

### XML-Tagged Context

```xml
<context>
  <document id="1" title="User Guide">
    {content_1}
  </document>
  <document id="2" title="API Reference">
    {content_2}
  </document>
</context>
```

### Relevance-Ordered

```
Most relevant context (use this first):
{highest_relevance_doc}

Additional context:
{medium_relevance_docs}

Background information:
{lower_relevance_docs}
```

## Prompting Techniques

### Chain-of-Thought (CoT)

Encourage step-by-step reasoning:

```
Question: {query}

Think through this step by step:
1. First, identify the key information in the context
2. Then, determine what's directly relevant to the question
3. Finally, synthesize an answer based on the evidence

Your reasoning:
```

### Few-Shot Examples

Provide examples of desired behavior:

```
Here are examples of good answers:

Q: What is the maximum file size?
Context: "Files up to 50MB are supported."
A: The maximum supported file size is 50MB.

Q: How do I reset my password?
Context: "Go to Settings > Security > Reset Password"
A: To reset your password, go to Settings, then Security,
   and click Reset Password.

Now answer this question:
Q: {user_query}
Context: {retrieved_context}
A:
```

### Self-Consistency

Generate multiple answers and select the most common:

```
Generate 3 different answers to this question based on the context.
Then provide your final answer based on what appears most often.

Question: {query}
Context: {context}

Answer 1:
Answer 2:
Answer 3:

Final Answer:
```

## Handling Edge Cases

### No Relevant Context

```
If the provided context does not contain information to answer
the question, respond with:

"I don't have enough information in my current knowledge to
answer that question. The available context covers [topics in
context] but not [aspect of query]."
```

### Conflicting Information

```
If the context contains conflicting information:
1. Acknowledge the conflict
2. Present both perspectives
3. Indicate which source is more authoritative if clear
4. Let the user know there's uncertainty
```

### Partial Information

```
If you can only partially answer the question:
1. Answer what you can based on the context
2. Clearly indicate what aspects you cannot address
3. Suggest what additional information might help
```

## Output Formatting

### Structured Responses

```
Format your response as:

## Answer
[Direct answer to the question]

## Details
[Supporting information from context]

## Sources
[List of sources used]
```

### JSON Output

```
Respond in JSON format:
{
  "answer": "The direct answer",
  "confidence": 0.0-1.0,
  "sources_used": ["source1", "source2"],
  "limitations": "Any caveats or missing information"
}
```

### Markdown Formatting

```
Use markdown formatting:
- Headers for sections
- **Bold** for emphasis
- `code` for technical terms
- Bullet points for lists
- > Blockquotes for citations
```

## Anti-Patterns to Avoid

### Hallucination Triggers

**Bad**: "Based on my knowledge..."
**Good**: "Based on the provided context..."

**Bad**: Open-ended generation without constraints
**Good**: Explicit instruction to use only context

### Vague Instructions

**Bad**: "Answer the question well"
**Good**: "Provide a 2-3 sentence answer citing specific sources"

### Missing Fallback

**Bad**: No instruction for when context is insufficient
**Good**: "If the context doesn't contain the answer, say 'I cannot find this information in the provided sources.'"

## Prompt Optimization

### A/B Testing

Test different prompt variations:
- System prompt wording
- Context formatting
- Output format instructions
- Example selection

### Metrics to Track

- Answer accuracy (human evaluation)
- Groundedness (claims supported by context)
- Relevance (answer addresses query)
- User satisfaction

### Iterative Improvement

1. Start with basic prompt
2. Identify failure cases
3. Add specific instructions for failures
4. Test improvements
5. Repeat

## Token Efficiency

### Minimizing Context Tokens

```typescript
// Bad: Full documents
const context = documents.join('\n\n');

// Good: Relevant excerpts only
const context = documents
  .map(d => d.relevantExcerpt)
  .join('\n\n');
```

### Concise Instructions

**Verbose** (40 tokens):
```
I would like you to please provide a comprehensive and detailed
answer to the following question based on the context provided.
```

**Concise** (15 tokens):
```
Answer based on the context. Be specific and cite sources.
```

## Best Practices Summary

1. **Be explicit** about what you want
2. **Provide examples** for complex tasks
3. **Set constraints** to prevent hallucination
4. **Format context** clearly with sources
5. **Include fallbacks** for edge cases
6. **Iterate** based on failure analysis
7. **Keep prompts focused** and token-efficient

## References

- Anthropic: "Prompt Engineering Guide"
- OpenAI: "Best Practices for Prompt Engineering"
- Microsoft: "Prompt Engineering Techniques"
