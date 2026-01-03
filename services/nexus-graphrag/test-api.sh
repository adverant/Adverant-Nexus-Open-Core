#!/bin/bash

# GraphRAG API Test Script
# Tests all GraphRAG endpoints with real data - NO MOCKS

set -euo pipefail

# Default values
API_ENDPOINT="${1:-http://localhost:8090}"
VERBOSE="${2:-false}"

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
while getopts "e:vh" opt; do
  case $opt in
    e) API_ENDPOINT="$OPTARG";;
    v) VERBOSE=true;;
    h) echo "Usage: $0 [-e endpoint] [-v verbose]"; exit 0;;
  esac
done

# Test functions
test_endpoint() {
    local method=$1
    local path=$2
    local data=$3
    local description=$4
    
    echo -e "${BLUE}Testing: ${description}${NC}"
    
    if [ "$method" == "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" -X GET "${API_ENDPOINT}${path}" -H "Content-Type: application/json")
    else
        response=$(curl -s -w "\n%{http_code}" -X $method "${API_ENDPOINT}${path}" \
            -H "Content-Type: application/json" \
            -d "$data")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)
    
    if [[ $http_code -ge 200 && $http_code -lt 300 ]]; then
        echo -e "${GREEN}✓ Success (${http_code})${NC}"
        if [ "$VERBOSE" == "true" ]; then
            echo "$body" | jq . 2>/dev/null || echo "$body"
        fi
    else
        echo -e "${RED}✗ Failed (${http_code})${NC}"
        echo "$body" | jq . 2>/dev/null || echo "$body"
    fi
    echo ""
}

# Test health endpoint
test_endpoint "GET" "/health" "" "Health Check"

# Store a document - Real Voyage AI embeddings will be generated
DOCUMENT_ID=""
store_response=$(curl -s -X POST "${API_ENDPOINT}/api/documents" \
    -H "Content-Type: application/json" \
    -d '{
      "content": "# GraphRAG Test Document\n\nThis is a comprehensive test document for the GraphRAG system.\n\n## Architecture Overview\n\nGraphRAG provides intelligent document storage and retrieval capabilities optimized for Large Language Models (LLMs). The system uses:\n\n- **Intelligent Chunking**: Documents are split into semantic chunks while preserving relationships\n- **Vector Embeddings**: Real Voyage AI embeddings for semantic search\n- **Graph Relationships**: Neo4j stores chunk relationships\n- **Smart Retrieval**: Multiple strategies including full document, semantic, hierarchical, and graph traversal\n\n## Key Features\n\n1. **Full Document Storage**: Store complete files without truncation\n2. **LLM Optimization**: Manage token budgets for context windows\n3. **NO MOCK DATA**: All embeddings use real AI models\n4. **Production Ready**: Built for scale with Kubernetes\n\n## Technical Implementation\n\nThe system integrates with existing vibe-server infrastructure:\n- PostgreSQL for metadata\n- Neo4j for relationships\n- Qdrant for vector search\n- Redis for caching\n\nThis ensures high performance and reliability in production environments.",
      "metadata": {
        "title": "GraphRAG Architecture Test",
        "type": "markdown",
        "format": "md",
        "tags": ["test", "architecture", "documentation"],
        "source": "api-test"
      }
    }')

if echo "$store_response" | grep -q "documentId"; then
    DOCUMENT_ID=$(echo "$store_response" | jq -r '.documentId')
    echo -e "${GREEN}✓ Document stored successfully: ${DOCUMENT_ID}${NC}"
    if [ "$VERBOSE" == "true" ]; then
        echo "$store_response" | jq .
    fi
else
    echo -e "${RED}✗ Failed to store document${NC}"
    echo "$store_response" | jq . 2>/dev/null || echo "$store_response"
fi
echo ""

# Test retrieval - full document
test_endpoint "POST" "/api/retrieve" '{
  "query": "provide me with the entire GraphRAG architecture test document",
  "options": {
    "strategy": "full_document",
    "includeFullDocument": true
  }
}' "Full Document Retrieval"

# Test retrieval - semantic search
test_endpoint "POST" "/api/retrieve" '{
  "query": "How does GraphRAG handle vector embeddings?",
  "options": {
    "strategy": "semantic_chunks",
    "maxTokens": 1000
  }
}' "Semantic Chunk Retrieval"

# Test retrieval - hierarchical
test_endpoint "POST" "/api/retrieve" '{
  "query": "What are the key features of GraphRAG?",
  "options": {
    "strategy": "hierarchical",
    "maxTokens": 2000
  }
}' "Hierarchical Retrieval"

# Test search
test_endpoint "POST" "/api/search" '{
  "query": "architecture",
  "filters": {
    "tags": ["test"]
  }
}' "Document Search"

# Get specific document if we have an ID
if [ ! -z "$DOCUMENT_ID" ]; then
    test_endpoint "GET" "/api/documents/$DOCUMENT_ID" "" "Get Specific Document"
fi

# Update document if we have an ID
if [ ! -z "$DOCUMENT_ID" ]; then
    test_endpoint "PUT" "/api/documents/$DOCUMENT_ID" '{
      "updates": {
        "metadata": {
          "version": "1.1",
          "updated": true
        }
      }
    }' "Update Document"
fi

echo -e "${BLUE}API tests completed!${NC}"
echo ""
echo "Summary:"
echo "- Endpoint: $API_ENDPOINT"
echo "- All tests use REAL Voyage AI embeddings"
echo "- Documents stored in real databases"
echo "- NO MOCK DATA anywhere in the system"
