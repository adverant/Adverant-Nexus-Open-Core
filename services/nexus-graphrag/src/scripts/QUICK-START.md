# Geo Endpoints Quick Start

## 🚀 30-Second Setup

```bash
# 1. Seed the database
docker exec nexus-graphrag-1 npx ts-node /app/src/scripts/seed-geo-data.ts

# 2. Test endpoints
bash src/scripts/test-geo-endpoints.sh

# 3. Done! All endpoints working ✅
```

---

## 📍 Available Endpoints

| Endpoint | Purpose | Example Request |
|----------|---------|-----------------|
| `POST /geo/memories` | Get memories in bounds | `{"north": 50, "south": 40, "east": 10, "west": -5}` |
| `POST /geo/heatmap` | Heatmap density | `{...bounds, "resolution": 10}` |
| `POST /geo/clusters` | Clustered markers | `{...bounds, "zoom": 8}` |
| `POST /geo/search` | Search with filters | `{bounds, "query": "paris"}` |
| `POST /geo/temporal` | Timeline buckets | `{bounds, "startDate": "...", "bucketSize": "day"}` |
| `POST /geo/ask` | AI queries | `{bounds, "question": "What...?"}` |
| `GET /memories/:id/related` | Related memories | Query param: `?limit=5` |

---

## 🧪 Quick Test

```bash
curl -X POST http://localhost:9082/api/v1/data-explorer/geo/memories \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: test-company" \
  -H "X-App-ID: test-app" \
  -H "X-User-ID: test-user" \
  -d '{"north": 50, "south": 48, "east": 3, "west": 2}'
```

Expected: Array of Paris memories

---

## 📊 Seeded Data

**67 memories** across **35+ cities**:
- Europe: Paris, London, Berlin, Rome, Barcelona, Moscow
- Americas: NYC, SF, LA, Chicago, Toronto, Vancouver, Rio, Mexico City
- Asia: Tokyo, Beijing, Shanghai, Hong Kong, Singapore, Bangkok
- Oceania: Sydney, Melbourne, Wellington
- Africa/ME: Cairo, Cape Town, Dubai, Jerusalem

---

## 🔧 Troubleshooting

**No data returned?**
```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM graphrag.memories WHERE metadata->>'latitude' IS NOT NULL;"
```

**Service not running?**
```bash
docker ps | grep nexus-graphrag
docker logs nexus-graphrag-1 --tail 20
```

**Need to reseed?**
```bash
docker exec nexus-graphrag-1 npx ts-node /app/src/scripts/seed-geo-data.ts
```

---

## 📚 Full Documentation

- **Full Spec:** `/BACKEND-GEO-IMPLEMENTATION.md`
- **Quick Summary:** `/BACKEND-GEO-SUMMARY.md`
- **Detailed Guide:** `src/scripts/README-GEO.md`

---

## ✅ Ready to Integrate!

All endpoints verified and working. Frontend can now connect to the geo API.
