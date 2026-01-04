/**
 * Qdrant Vector Database Client for FileProcessAgent Worker
 *
 * Handles vector storage and semantic search operations for document embeddings.
 * Uses Qdrant's native gRPC API for high-performance vector operations.
 */

package storage

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	qdrant "github.com/qdrant/go-client/qdrant"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// QdrantClient handles vector database operations
type QdrantClient struct {
	client         qdrant.PointsClient
	collectionClient qdrant.CollectionsClient
	conn           *grpc.ClientConn
	collectionName string
}

// VectorPoint represents a vector with metadata
type VectorPoint struct {
	ID        string
	Vector    []float32
	Metadata  map[string]interface{}
	Timestamp int64
}

// NewQdrantClient creates a new Qdrant client
func NewQdrantClient(address string, collectionName string) (*QdrantClient, error) {
	if address == "" {
		return nil, fmt.Errorf("qdrant address is required")
	}

	if collectionName == "" {
		return nil, fmt.Errorf("collection name is required")
	}

	// Connect to Qdrant using gRPC
	conn, err := grpc.Dial(address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Qdrant: %w", err)
	}

	qc := &QdrantClient{
		client:         qdrant.NewPointsClient(conn),
		collectionClient: qdrant.NewCollectionsClient(conn),
		conn:           conn,
		collectionName: collectionName,
	}

	// Ensure collection exists
	if err := qc.ensureCollection(context.Background()); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to ensure collection: %w", err)
	}

	return qc, nil
}

// ensureCollection creates the collection if it doesn't exist
func (q *QdrantClient) ensureCollection(ctx context.Context) error {
	// List collections to check if ours exists
	listResp, err := q.collectionClient.List(ctx, &qdrant.ListCollectionsRequest{})
	if err != nil {
		return fmt.Errorf("failed to list collections: %w", err)
	}

	// Check if collection exists
	exists := false
	for _, col := range listResp.Collections {
		if col.Name == q.collectionName {
			exists = true
			break
		}
	}

	if exists {
		return nil
	}

	// Create collection with VoyageAI embedding configuration
	// 1024 dimensions, cosine similarity
	_, err = q.collectionClient.Create(ctx, &qdrant.CreateCollection{
		CollectionName: q.collectionName,
		VectorsConfig: &qdrant.VectorsConfig{
			Config: &qdrant.VectorsConfig_Params{
				Params: &qdrant.VectorParams{
					Size:     1024, // VoyageAI voyage-3 dimensions
					Distance: qdrant.Distance_Cosine,
				},
			},
		},
		// Note: OptimizersConfig and HnswConfig are optional and use defaults
		// The Qdrant go-client v1.7.0 doesn't support these fields directly
	})

	if err != nil {
		return fmt.Errorf("failed to create collection: %w", err)
	}

	return nil
}

// UpsertVector stores or updates a vector point in Qdrant
func (q *QdrantClient) UpsertVector(ctx context.Context, point *VectorPoint) error {
	if point == nil {
		return fmt.Errorf("point is required")
	}

	if len(point.Vector) != 1024 {
		return fmt.Errorf("invalid vector dimensions: expected 1024, got %d", len(point.Vector))
	}

	// Generate UUID if not provided
	if point.ID == "" {
		point.ID = uuid.New().String()
	}

	// Convert metadata to Qdrant payload
	payload := make(map[string]*qdrant.Value)
	for k, v := range point.Metadata {
		// Convert interface{} to qdrant.Value
		switch val := v.(type) {
		case string:
			payload[k] = &qdrant.Value{
				Kind: &qdrant.Value_StringValue{StringValue: val},
			}
		case int64:
			payload[k] = &qdrant.Value{
				Kind: &qdrant.Value_IntegerValue{IntegerValue: val},
			}
		case float64:
			payload[k] = &qdrant.Value{
				Kind: &qdrant.Value_DoubleValue{DoubleValue: val},
			}
		case bool:
			payload[k] = &qdrant.Value{
				Kind: &qdrant.Value_BoolValue{BoolValue: val},
			}
		default:
			// Convert to string as fallback
			payload[k] = &qdrant.Value{
				Kind: &qdrant.Value_StringValue{StringValue: fmt.Sprintf("%v", val)},
			}
		}
	}

	// Add timestamp
	if point.Timestamp > 0 {
		payload["timestamp"] = &qdrant.Value{
			Kind: &qdrant.Value_IntegerValue{IntegerValue: point.Timestamp},
		}
	}

	// Upsert point
	pointStruct := &qdrant.PointStruct{
		Id: &qdrant.PointId{
			PointIdOptions: &qdrant.PointId_Uuid{
				Uuid: point.ID,
			},
		},
		Vectors: &qdrant.Vectors{
			VectorsOptions: &qdrant.Vectors_Vector{
				Vector: &qdrant.Vector{
					Data: point.Vector,
				},
			},
		},
		Payload: payload,
	}

	_, err := q.client.Upsert(ctx, &qdrant.UpsertPoints{
		CollectionName: q.collectionName,
		Points:         []*qdrant.PointStruct{pointStruct},
	})

	if err != nil {
		return fmt.Errorf("failed to upsert vector: %w", err)
	}

	return nil
}

// SearchVectors performs similarity search
func (q *QdrantClient) SearchVectors(ctx context.Context, queryVector []float32, limit int) ([]*VectorPoint, error) {
	if len(queryVector) != 1024 {
		return nil, fmt.Errorf("invalid query vector dimensions: expected 1024, got %d", len(queryVector))
	}

	if limit <= 0 {
		limit = 10
	}

	// Search with vector
	searchReq := &qdrant.SearchPoints{
		CollectionName: q.collectionName,
		Vector:         queryVector,
		Limit:          uint64(limit),
		WithPayload:    &qdrant.WithPayloadSelector{
			SelectorOptions: &qdrant.WithPayloadSelector_Enable{
				Enable: true,
			},
		},
	}

	results, err := q.client.Search(ctx, searchReq)
	if err != nil {
		return nil, fmt.Errorf("failed to search vectors: %w", err)
	}

	// Convert results
	points := make([]*VectorPoint, 0, len(results.Result))
	for _, result := range results.Result {
		pointID := ""
		if result.Id != nil {
			if uuidVal := result.Id.GetUuid(); uuidVal != "" {
				pointID = uuidVal
			}
		}

		point := &VectorPoint{
			ID:       pointID,
			Metadata: make(map[string]interface{}),
		}

		// Extract metadata
		if result.Payload != nil {
			for k, v := range result.Payload {
				// Convert qdrant.Value to interface{}
				switch val := v.Kind.(type) {
				case *qdrant.Value_StringValue:
					point.Metadata[k] = val.StringValue
				case *qdrant.Value_IntegerValue:
					point.Metadata[k] = val.IntegerValue
				case *qdrant.Value_DoubleValue:
					point.Metadata[k] = val.DoubleValue
				case *qdrant.Value_BoolValue:
					point.Metadata[k] = val.BoolValue
				}
			}
		}

		// Extract score
		point.Metadata["score"] = result.Score

		points = append(points, point)
	}

	return points, nil
}

// GetVector retrieves a vector by ID
func (q *QdrantClient) GetVector(ctx context.Context, pointID string) (*VectorPoint, error) {
	if pointID == "" {
		return nil, fmt.Errorf("point ID is required")
	}

	// Get point
	getReq := &qdrant.GetPoints{
		CollectionName: q.collectionName,
		Ids: []*qdrant.PointId{
			{
				PointIdOptions: &qdrant.PointId_Uuid{
					Uuid: pointID,
				},
			},
		},
		WithPayload: &qdrant.WithPayloadSelector{
			SelectorOptions: &qdrant.WithPayloadSelector_Enable{
				Enable: true,
			},
		},
		WithVectors: &qdrant.WithVectorsSelector{
			SelectorOptions: &qdrant.WithVectorsSelector_Enable{
				Enable: true,
			},
		},
	}

	results, err := q.client.Get(ctx, getReq)
	if err != nil {
		return nil, fmt.Errorf("failed to get vector: %w", err)
	}

	if len(results.Result) == 0 {
		return nil, fmt.Errorf("vector not found: %s", pointID)
	}

	result := results.Result[0]

	point := &VectorPoint{
		ID:       pointID,
		Metadata: make(map[string]interface{}),
	}

	// Extract vector
	if result.Vectors != nil {
		if vec := result.Vectors.GetVector(); vec != nil {
			point.Vector = vec.Data
		}
	}

	// Extract metadata
	if result.Payload != nil {
		for k, v := range result.Payload {
			// Convert qdrant.Value to interface{}
			switch val := v.Kind.(type) {
			case *qdrant.Value_StringValue:
				point.Metadata[k] = val.StringValue
			case *qdrant.Value_IntegerValue:
				point.Metadata[k] = val.IntegerValue
			case *qdrant.Value_DoubleValue:
				point.Metadata[k] = val.DoubleValue
			case *qdrant.Value_BoolValue:
				point.Metadata[k] = val.BoolValue
			}
		}
	}

	return point, nil
}

// DeleteVector removes a vector by ID
func (q *QdrantClient) DeleteVector(ctx context.Context, pointID string) error {
	if pointID == "" {
		return fmt.Errorf("point ID is required")
	}

	// Delete point
	deleteReq := &qdrant.DeletePoints{
		CollectionName: q.collectionName,
		Points: &qdrant.PointsSelector{
			PointsSelectorOneOf: &qdrant.PointsSelector_Points{
				Points: &qdrant.PointsIdsList{
					Ids: []*qdrant.PointId{
						{
							PointIdOptions: &qdrant.PointId_Uuid{
								Uuid: pointID,
							},
						},
					},
				},
			},
		},
	}

	_, err := q.client.Delete(ctx, deleteReq)
	if err != nil {
		return fmt.Errorf("failed to delete vector: %w", err)
	}

	return nil
}

// GetCollectionInfo returns collection statistics
func (q *QdrantClient) GetCollectionInfo(ctx context.Context) (map[string]interface{}, error) {
	info, err := q.collectionClient.Get(ctx, &qdrant.GetCollectionInfoRequest{
		CollectionName: q.collectionName,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get collection info: %w", err)
	}

	stats := map[string]interface{}{
		"collection_name":  q.collectionName,
		"vectors_count":    info.Result.GetVectorsCount(),
		"points_count":     info.Result.GetPointsCount(),
		"indexed_vectors":  info.Result.GetIndexedVectorsCount(),
		"status":           info.Result.GetStatus().String(),
	}

	return stats, nil
}

// Close closes the Qdrant client connection
func (q *QdrantClient) Close() error {
	if q.conn != nil {
		return q.conn.Close()
	}
	return nil
}