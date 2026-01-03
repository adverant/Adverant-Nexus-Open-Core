# Vector Databases and Embedding Systems

## Overview

Vector databases are specialized storage systems designed for high-dimensional vector data, enabling fast similarity search across millions or billions of embeddings. They are the backbone of modern semantic search and RAG systems.

## Core Concepts

### Embeddings

Embeddings are dense numerical representations of data (text, images, audio) in high-dimensional space where similar items are located close together.

**Properties**:
- Fixed dimensionality (e.g., 768, 1024, 1536, 3072)
- Normalized or unnormalized vectors
- Capture semantic meaning, not just keywords
- Enable similarity computation

### Embedding Models

| Model | Dimensions | Context | Use Case |
|-------|------------|---------|----------|
| Voyage AI voyage-3 | 1024 | 32K | General purpose, high quality |
| Voyage AI voyage-3-lite | 512 | 32K | Fast, cost-effective |
| OpenAI text-embedding-3-large | 3072 | 8K | High accuracy |
| OpenAI text-embedding-3-small | 1536 | 8K | Balanced |
| Cohere embed-v3 | 1024 | - | Multilingual |

### Similarity Metrics

**Cosine Similarity**:
```
cos(A, B) = (A · B) / (||A|| × ||B||)
```
- Range: -1 to 1 (normalized vectors: 0 to 1)
- Direction-based, ignores magnitude
- Most common for text embeddings

**Dot Product**:
```
dot(A, B) = Σ(Ai × Bi)
```
- Unbounded range
- Considers both direction and magnitude
- Fast computation

**Euclidean Distance**:
```
dist(A, B) = √(Σ(Ai - Bi)²)
```
- Range: 0 to infinity
- Lower is more similar
- Sensitive to magnitude

## Vector Database Architectures

### Qdrant

**Architecture**:
- Written in Rust for performance
- HNSW index for approximate search
- Supports filtering during search
- Horizontal scaling with sharding

**Key Features**:
- Payload (metadata) storage
- Quantization for memory efficiency
- Batch operations
- gRPC and REST APIs

**Example**:
```typescript
// Store vectors
await qdrant.upsert('collection', {
  points: [{
    id: 'doc-1',
    vector: embedding,
    payload: { title: 'Document', source: 'web' }
  }]
});

// Search with filter
const results = await qdrant.search('collection', {
  vector: queryEmbedding,
  filter: { source: 'web' },
  limit: 10
});
```

### Pinecone

**Architecture**:
- Fully managed cloud service
- Serverless and pod-based options
- Multi-region deployment
- Real-time indexing

**Key Features**:
- Metadata filtering
- Sparse-dense hybrid search
- Namespaces for data isolation
- Built-in analytics

### Weaviate

**Architecture**:
- GraphQL interface
- Modular vectorizer integrations
- HNSW + inverted index hybrid
- Schema-based collections

**Key Features**:
- Native multimodal support
- Generative search (built-in LLM)
- Hybrid BM25 + vector search
- Cross-references between objects

### Milvus

**Architecture**:
- Distributed, cloud-native
- Separation of compute and storage
- Multiple index types
- GPU acceleration support

**Key Features**:
- Partition-based data management
- Time-travel queries
- PyMilvus SDK
- Kubernetes-native

## Indexing Algorithms

### HNSW (Hierarchical Navigable Small World)

The most common algorithm for approximate nearest neighbor search.

**How it works**:
1. Build multi-layer graph structure
2. Upper layers contain skip connections (long jumps)
3. Lower layers contain local connections (short jumps)
4. Search starts from top layer, descends to find neighbors

**Parameters**:
- `M`: Max connections per node (higher = better recall, more memory)
- `efConstruction`: Build-time search width
- `efSearch`: Query-time search width

**Trade-offs**:
- Very fast queries (sub-millisecond)
- Good recall with tuning (95-99%)
- Higher memory usage than IVF
- Slower indexing than IVF

### IVF (Inverted File Index)

Partition-based approach using clustering.

**How it works**:
1. Cluster vectors into `nlist` partitions
2. Store vectors with their cluster assignments
3. At query time, search only `nprobe` nearest clusters

**Parameters**:
- `nlist`: Number of clusters
- `nprobe`: Clusters to search at query time

**Trade-offs**:
- Lower memory than HNSW
- Faster indexing
- Requires training on data distribution
- Quality depends on clustering

### Quantization

Reduce memory usage by compressing vectors.

**Scalar Quantization**:
- Map float32 to int8 (4x compression)
- Minimal accuracy loss for most use cases

**Product Quantization**:
- Split vector into sub-vectors
- Quantize each independently
- Higher compression (up to 64x)
- Some accuracy trade-off

## Hybrid Search

Combining vector search with traditional keyword search.

### Architecture

```
Query → [Vector Search] → Dense Results
      → [Keyword Search] → Sparse Results
                       ↓
              [Fusion / Reranking]
                       ↓
                 Final Results
```

### Fusion Methods

**Reciprocal Rank Fusion (RRF)**:
```
score(d) = Σ 1 / (k + rank_i(d))
```
where k is a constant (typically 60)

**Weighted Combination**:
```
score(d) = α × vector_score(d) + (1-α) × keyword_score(d)
```

### Implementation

```typescript
async function hybridSearch(query: string) {
  // Parallel search
  const [vectorResults, keywordResults] = await Promise.all([
    vectorStore.search(embed(query), { limit: 20 }),
    keywordStore.search(query, { limit: 20 })
  ]);

  // Fuse results
  return reciprocalRankFusion([vectorResults, keywordResults], {
    k: 60,
    limit: 10
  });
}
```

## Performance Optimization

### Indexing Best Practices
1. Batch inserts (1000+ vectors at a time)
2. Use appropriate index for data size
3. Configure sharding for large datasets
4. Pre-compute embeddings offline

### Query Optimization
1. Use metadata filters to reduce search space
2. Tune `efSearch` / `nprobe` for recall/speed trade-off
3. Cache frequent queries
4. Use quantization for memory-bound workloads

### Capacity Planning

| Vectors | Dimensions | Memory (HNSW) | Memory (IVF) |
|---------|------------|---------------|--------------|
| 1M | 1024 | ~8GB | ~4GB |
| 10M | 1024 | ~80GB | ~40GB |
| 100M | 1024 | ~800GB | ~400GB |

## Best Practices

1. **Choose the right embedding model** for your domain
2. **Normalize embeddings** for cosine similarity
3. **Add metadata** for filtering and context
4. **Monitor recall** with ground truth evaluation
5. **Implement hybrid search** for best results
6. **Plan for scale** with sharding strategy

## References

- Malkov & Yashunin (2016): "Efficient and Robust Approximate Nearest Neighbor using HNSW"
- Qdrant Documentation: https://qdrant.tech/documentation/
- Voyage AI: https://docs.voyageai.com/
