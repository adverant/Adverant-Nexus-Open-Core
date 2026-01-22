# GraphRAG Geo-Tagged Memories Scripts

This directory contains scripts for seeding and testing geo-tagged memory data for the Data Explorer map visualization feature.

## Scripts Overview

### 1. `seed-geo-data.ts`

TypeScript script that seeds the database with 50+ geo-tagged memories across major world cities.

**Features:**
- Seeds memories in 35+ locations worldwide (Europe, Asia, Americas, Oceania, Africa)
- Creates 1-2 memories per location with variety (travel, events, photos, meetings, restaurants, etc.)
- Adds realistic metadata (placeName, city, region, country)
- Randomly applies privacy blurring to some locations
- Distributes memories across the last 90 days
- Provides detailed verification and statistics

**Usage:**

```bash
# From the nexus-graphrag directory
npx ts-node src/scripts/seed-geo-data.ts

# Or use the helper script
bash src/scripts/run-seed-geo.sh
```

**Environment Variables:**
- `DATABASE_URL` - PostgreSQL connection string (default: `postgresql://nexus:nexuspassword@localhost:5432/nexus`)

**Sample Output:**
```
=== Geo Data Seeding Script ===

Connecting to database...
✓ Database connection successful

✓ Table graphrag.memories exists

Clearing existing geo memories...
✓ Cleared 0 existing seed memories

Generating geo-tagged memories...

Inserting 67 geo-tagged memories...
  Inserted 10/67 memories...
  Inserted 20/67 memories...
  ...

✓ Successfully inserted 67 geo-tagged memories

Verifying seeded data...

✓ Total geo memories in database: 67

Top 10 cities by memory count:
  Paris, France: 4 memories
  London, United Kingdom: 3 memories
  New York, USA: 3 memories
  ...
```

### 2. `test-geo-endpoints.sh`

Bash script that comprehensively tests all geo-related API endpoints.

**Features:**
- Tests 15 different geo endpoint scenarios
- Validates response status codes
- Shows sample data from responses
- Tests different geographic regions (Europe, Americas, Asia)
- Tests filtering, search, clustering, heatmaps, and temporal queries
- Color-coded output for easy reading

**Usage:**

```bash
# Make executable
chmod +x src/scripts/test-geo-endpoints.sh

# Run tests
bash src/scripts/test-geo-endpoints.sh
```

**Prerequisites:**
- GraphRAG service running on `localhost:9082`
- `curl` and `jq` installed (jq optional but recommended for pretty output)

**Endpoints Tested:**

1. **POST /geo/memories** - Basic geo queries (Europe, Americas, Asia)
2. **POST /geo/heatmap** - Memory density heatmaps
3. **POST /geo/clusters** - Clustered markers at different zoom levels
4. **POST /geo/search** - Enhanced search with filters, relationships, communities
5. **POST /geo/temporal** - Temporal aggregation for timeline animation
6. **POST /geo/ask** - AI-powered natural language queries
7. **GET /memories/:id/related** - Related memories finder

**Sample Output:**
```
=== GraphRAG Geo Endpoints Testing ===

Target: http://localhost:9082

=== Test 1: Geo Memories (Europe) ===
Testing: Geo Memories - Europe
  Endpoint: POST /geo/memories
  ✓ Status: 200
  Response preview:
  [
    {
      "id": "...",
      "content": "Visited Eiffel Tower in Paris, France...",
      "location": {
        "latitude": 48.8566,
        "longitude": 2.3522,
        "city": "Paris",
        "country": "France"
      }
    }
  ]
  Records returned: 15
```

### 3. `run-seed-geo.sh`

Helper script that runs the seed script either locally or inside a Docker container.

**Features:**
- Auto-detects if running inside Docker or on host
- Executes via `docker exec` if on host
- Validates container is running before execution

**Usage:**

```bash
# Make executable
chmod +x src/scripts/run-seed-geo.sh

# Run
bash src/scripts/run-seed-geo.sh
```

## Workflow

### Initial Setup

1. **Ensure GraphRAG service is running:**
   ```bash
   docker-compose -f docker/docker-compose.nexus.yml up -d nexus-graphrag
   ```

2. **Seed the database:**
   ```bash
   npx ts-node src/scripts/seed-geo-data.ts
   ```

3. **Verify the data:**
   ```bash
   bash src/scripts/test-geo-endpoints.sh
   ```

### On Remote Server (YOUR_SERVER_IP)

1. **SSH into server:**
   ```bash
   ssh root@YOUR_SERVER_IP
   ```

2. **Navigate to GraphRAG directory:**
   ```bash
   cd /root/Adverant-Nexus/services/nexus-graphrag
   ```

3. **Seed data inside container:**
   ```bash
   docker exec -it nexus-graphrag-1 npx ts-node /app/src/scripts/seed-geo-data.ts
   ```

4. **Test endpoints:**
   ```bash
   bash src/scripts/test-geo-endpoints.sh
   ```

## Data Schema

Geo-tagged memories are stored in `graphrag.memories` table with metadata in JSONB format:

```typescript
interface GeoMemoryMetadata {
  latitude: string;        // "48.856600"
  longitude: string;       // "2.352200"
  placeName: string;       // "Eiffel Tower"
  city: string;           // "Paris"
  region?: string;        // "Île-de-France"
  country: string;        // "France"
  source: string;         // "seed-script"
  type: string;           // "location", "event", "photo", etc.
  blurred?: boolean;      // Privacy feature
  blurRadiusKm?: number;  // 5 or 10
}
```

## Geographic Coverage

The seed script covers:

- **Europe:** Paris, London, Berlin, Rome, Barcelona, Moscow
- **North America:** New York, San Francisco, Los Angeles, Chicago, Toronto, Vancouver
- **Asia:** Tokyo, Beijing, Shanghai, Hong Kong, Singapore, Bangkok, Mexico City
- **Oceania:** Sydney, Melbourne, Wellington
- **South America:** Rio de Janeiro, São Paulo, Santiago, Lima
- **Africa & Middle East:** Cairo, Cape Town, Dubai, Jerusalem

## Memory Types

- **location** - Visits to landmarks and places
- **event** - Conferences, meetings, gatherings
- **photo** - Photography and scenic memories
- **meeting** - Business meetings and professional events
- **restaurant** - Dining and food experiences
- **cultural** - Cultural heritage and education
- **activity** - Fitness, sports, outdoor activities
- **work** - Remote work and productivity

## Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Check DATABASE_URL environment variable
echo $DATABASE_URL

# Test direct connection
psql $DATABASE_URL -c "SELECT NOW();"
```

### No Memories Returned

```bash
# Check memory count
psql $DATABASE_URL -c "SELECT COUNT(*) FROM graphrag.memories WHERE metadata->>'latitude' IS NOT NULL;"

# Check specific bounds
psql $DATABASE_URL -c "
  SELECT
    metadata->>'city' as city,
    metadata->>'latitude' as lat,
    metadata->>'longitude' as lng
  FROM graphrag.memories
  WHERE metadata->>'latitude' IS NOT NULL
  LIMIT 10;
"
```

### Endpoint 401/403 Errors

Ensure you're passing the required headers:
- `X-Company-ID: test-company`
- `X-App-ID: test-app`
- `X-User-ID: test-user`

### Service Not Running

```bash
# Check service status
docker ps | grep nexus-graphrag

# View logs
docker logs nexus-graphrag-1 --tail 50

# Restart service
docker-compose -f docker/docker-compose.nexus.yml restart nexus-graphrag
```

## Performance Considerations

- Initial seed creates ~67 memories
- Each endpoint query is limited (default 500 max)
- Queries use indexed JSONB fields for fast filtering
- For production, consider:
  - Partitioning by geographic region
  - Caching popular queries
  - Rate limiting on AI queries
  - PostGIS for advanced spatial queries

## Next Steps

1. **Frontend Integration:**
   - Verify data appears on map visualization
   - Test clustering and zoom behaviors
   - Validate filtering and search UI

2. **Data Enhancement:**
   - Add more memory types
   - Create relationships between nearby memories
   - Implement semantic communities by location

3. **Production Deployment:**
   - Scale seed data to 1000+ memories
   - Add real user data migration
   - Implement privacy controls
   - Add geographic search optimization

## Support

For issues or questions:
- Check GraphRAG service logs: `docker logs nexus-graphrag-1`
- Review database schema: `src/database/migrations/001_complete_schema.sql`
- Test endpoints manually: See examples in `test-geo-endpoints.sh`
- Check API routes: `src/api/data-explorer-routes.ts` (lines 788-1550)
