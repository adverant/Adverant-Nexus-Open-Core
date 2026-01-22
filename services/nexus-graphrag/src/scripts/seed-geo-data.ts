#!/usr/bin/env ts-node
/**
 * Seed Geo-Tagged Memories Script
 *
 * This script seeds the database with 50+ geo-tagged memories across major world cities.
 * These memories enable testing of the map visualization feature in the Data Explorer.
 *
 * Usage:
 *   ts-node src/scripts/seed-geo-data.ts
 *
 * Requirements:
 *   - PostgreSQL database running
 *   - DATABASE_URL environment variable set
 */

import { Pool } from 'pg';
import { config } from 'dotenv';

// Load environment variables
config();

// ============================================================================
// TYPES
// ============================================================================

interface GeoLocation {
  latitude: number;
  longitude: number;
  placeName: string;
  city: string;
  region?: string;
  country: string;
}

interface GeoMemory {
  content: string;
  tags: string[];
  metadata: {
    latitude: string;
    longitude: string;
    placeName: string;
    city: string;
    region?: string;
    country: string;
    source: string;
    type: string;
    blurred?: boolean;
    blurRadiusKm?: number;
  };
}

// ============================================================================
// GEO-TAGGED MEMORY DATA
// ============================================================================

const LOCATIONS: GeoLocation[] = [
  // Europe
  { latitude: 48.8566, longitude: 2.3522, placeName: 'Eiffel Tower', city: 'Paris', country: 'France' },
  { latitude: 48.8606, longitude: 2.3376, placeName: 'Louvre Museum', city: 'Paris', country: 'France' },
  { latitude: 51.5074, longitude: -0.1278, placeName: 'Big Ben', city: 'London', country: 'United Kingdom' },
  { latitude: 51.5007, longitude: -0.1246, placeName: 'Buckingham Palace', city: 'London', country: 'United Kingdom' },
  { latitude: 52.5200, longitude: 13.4050, placeName: 'Brandenburg Gate', city: 'Berlin', country: 'Germany' },
  { latitude: 41.9028, longitude: 12.4964, placeName: 'Colosseum', city: 'Rome', country: 'Italy' },
  { latitude: 41.4036, longitude: 2.1744, placeName: 'Sagrada Familia', city: 'Barcelona', country: 'Spain' },
  { latitude: 55.7558, longitude: 37.6173, placeName: 'Red Square', city: 'Moscow', country: 'Russia' },

  // North America
  { latitude: 40.7128, longitude: -74.0060, placeName: 'Times Square', city: 'New York', region: 'NY', country: 'USA' },
  { latitude: 40.7589, longitude: -73.9851, placeName: 'Central Park', city: 'New York', region: 'NY', country: 'USA' },
  { latitude: 37.7749, longitude: -122.4194, placeName: 'Golden Gate Bridge', city: 'San Francisco', region: 'CA', country: 'USA' },
  { latitude: 37.8199, longitude: -122.4783, placeName: 'Alcatraz Island', city: 'San Francisco', region: 'CA', country: 'USA' },
  { latitude: 34.0522, longitude: -118.2437, placeName: 'Hollywood Sign', city: 'Los Angeles', region: 'CA', country: 'USA' },
  { latitude: 41.8781, longitude: -87.6298, placeName: 'Cloud Gate', city: 'Chicago', region: 'IL', country: 'USA' },
  { latitude: 43.6532, longitude: -79.3832, placeName: 'CN Tower', city: 'Toronto', region: 'ON', country: 'Canada' },
  { latitude: 49.2827, longitude: -123.1207, placeName: 'Stanley Park', city: 'Vancouver', region: 'BC', country: 'Canada' },

  // Asia
  { latitude: 35.6762, longitude: 139.6503, placeName: 'Tokyo Tower', city: 'Tokyo', country: 'Japan' },
  { latitude: 35.3606, longitude: 138.7274, placeName: 'Mount Fuji', city: 'Fujinomiya', country: 'Japan' },
  { latitude: 39.9042, longitude: 116.4074, placeName: 'Forbidden City', city: 'Beijing', country: 'China' },
  { latitude: 31.2304, longitude: 121.4737, placeName: 'Oriental Pearl Tower', city: 'Shanghai', country: 'China' },
  { latitude: 22.3193, longitude: 114.1694, placeName: 'Victoria Harbour', city: 'Hong Kong', country: 'China' },
  { latitude: 1.3521, longitude: 103.8198, placeName: 'Marina Bay Sands', city: 'Singapore', country: 'Singapore' },
  { latitude: 13.7563, longitude: 100.5018, placeName: 'Grand Palace', city: 'Bangkok', country: 'Thailand' },
  { latitude: 19.4326, longitude: -99.1332, placeName: 'Zócalo', city: 'Mexico City', country: 'Mexico' },

  // Oceania
  { latitude: -33.8688, longitude: 151.2093, placeName: 'Sydney Opera House', city: 'Sydney', region: 'NSW', country: 'Australia' },
  { latitude: -33.8568, longitude: 151.2153, placeName: 'Sydney Harbour Bridge', city: 'Sydney', region: 'NSW', country: 'Australia' },
  { latitude: -37.8136, longitude: 144.9631, placeName: 'Federation Square', city: 'Melbourne', region: 'VIC', country: 'Australia' },
  { latitude: -41.2865, longitude: 174.7762, placeName: 'Te Papa Museum', city: 'Wellington', country: 'New Zealand' },

  // South America
  { latitude: -22.9519, longitude: -43.2105, placeName: 'Christ the Redeemer', city: 'Rio de Janeiro', country: 'Brazil' },
  { latitude: -23.5505, longitude: -46.6333, placeName: 'Paulista Avenue', city: 'São Paulo', country: 'Brazil' },
  { latitude: -33.4489, longitude: -70.6693, placeName: 'Plaza de Armas', city: 'Santiago', country: 'Chile' },
  { latitude: -12.0464, longitude: -77.0428, placeName: 'Plaza Mayor', city: 'Lima', country: 'Peru' },

  // Africa & Middle East
  { latitude: 30.0444, longitude: 31.2357, placeName: 'Great Pyramid of Giza', city: 'Cairo', country: 'Egypt' },
  { latitude: -33.9249, longitude: 18.4241, placeName: 'Table Mountain', city: 'Cape Town', country: 'South Africa' },
  { latitude: 25.2048, longitude: 55.2708, placeName: 'Burj Khalifa', city: 'Dubai', country: 'UAE' },
  { latitude: 31.7683, longitude: 35.2137, placeName: 'Old City', city: 'Jerusalem', country: 'Israel' },
];

// Memory content templates
const MEMORY_TEMPLATES = [
  { type: 'location', template: 'Visited {place} in {city}, {country}. Beautiful architecture and rich history.', tags: ['travel', 'location', 'landmark'] },
  { type: 'event', template: 'Attended a conference near {place} in {city}. Great networking opportunity.', tags: ['event', 'professional', 'conference'] },
  { type: 'photo', template: 'Took stunning photos of {place} during sunset. {city} is breathtaking!', tags: ['photography', 'location', 'memory'] },
  { type: 'meeting', template: 'Had a business meeting at {place}, {city}. Productive discussions about future projects.', tags: ['business', 'meeting', 'professional'] },
  { type: 'restaurant', template: 'Enjoyed an amazing meal near {place} in {city}. Local cuisine is fantastic!', tags: ['food', 'restaurant', 'travel'] },
  { type: 'cultural', template: 'Explored the cultural heritage around {place} in {city}, {country}. So much to learn!', tags: ['culture', 'education', 'travel'] },
  { type: 'activity', template: 'Morning jog around {place} in {city}. Perfect weather and scenic views.', tags: ['fitness', 'activity', 'health'] },
  { type: 'work', template: 'Remote work session at a cafe near {place}, {city}. Productive day with great coffee!', tags: ['work', 'remote', 'productivity'] },
];

// ============================================================================
// MAIN SCRIPT
// ============================================================================

async function seedGeoData(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://nexus:nexuspassword@localhost:5432/nexus';

  console.log('=== Geo Data Seeding Script ===\n');
  console.log('Connecting to database...');

  const pool = new Pool({ connectionString: dbUrl });

  try {
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✓ Database connection successful\n');

    // Check if memories table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'graphrag'
        AND table_name = 'memories'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      throw new Error('Table graphrag.memories does not exist. Run migrations first.');
    }
    console.log('✓ Table graphrag.memories exists\n');

    // Clear existing geo memories (optional - comment out to keep existing data)
    console.log('Clearing existing geo memories...');
    const deleteResult = await pool.query(`
      DELETE FROM graphrag.memories
      WHERE metadata->>'latitude' IS NOT NULL
      AND metadata->>'source' = 'seed-script'
    `);
    console.log(`✓ Cleared ${deleteResult.rowCount} existing seed memories\n`);

    // Generate and insert geo-tagged memories
    console.log('Generating geo-tagged memories...\n');
    const memories: GeoMemory[] = [];

    for (const location of LOCATIONS) {
      // Create 1-2 memories per location
      const memoryCount = Math.random() > 0.5 ? 2 : 1;

      for (let i = 0; i < memoryCount; i++) {
        const template = MEMORY_TEMPLATES[Math.floor(Math.random() * MEMORY_TEMPLATES.length)];

        const content = template.template
          .replace('{place}', location.placeName)
          .replace('{city}', location.city)
          .replace('{country}', location.country);

        // Add slight random offset to coordinates (for clustering variety)
        const latOffset = (Math.random() - 0.5) * 0.01; // ~1km variation
        const lngOffset = (Math.random() - 0.5) * 0.01;

        const memory: GeoMemory = {
          content,
          tags: template.tags,
          metadata: {
            latitude: (location.latitude + latOffset).toFixed(6),
            longitude: (location.longitude + lngOffset).toFixed(6),
            placeName: location.placeName,
            city: location.city,
            region: location.region,
            country: location.country,
            source: 'seed-script',
            type: template.type,
            // Randomly add privacy blur for some locations
            ...(Math.random() > 0.8 && {
              blurred: true,
              blurRadiusKm: Math.random() > 0.5 ? 5 : 10,
            }),
          },
        };

        memories.push(memory);
      }
    }

    // Insert memories in batches
    console.log(`Inserting ${memories.length} geo-tagged memories...`);
    let insertedCount = 0;

    for (const memory of memories) {
      try {
        await pool.query(
          `INSERT INTO graphrag.memories (content, tags, metadata, created_at)
           VALUES ($1, $2, $3, $4)`,
          [
            memory.content,
            memory.tags,
            JSON.stringify(memory.metadata),
            new Date(Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000), // Random date within last 90 days
          ]
        );
        insertedCount++;

        // Progress indicator
        if (insertedCount % 10 === 0) {
          console.log(`  Inserted ${insertedCount}/${memories.length} memories...`);
        }
      } catch (error) {
        console.error(`✗ Failed to insert memory: ${error}`);
      }
    }

    console.log(`\n✓ Successfully inserted ${insertedCount} geo-tagged memories\n`);

    // Verify the data
    console.log('Verifying seeded data...');

    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM graphrag.memories
      WHERE metadata->>'latitude' IS NOT NULL
      AND metadata->>'source' = 'seed-script'
    `);

    const cityStats = await pool.query(`
      SELECT
        metadata->>'city' as city,
        metadata->>'country' as country,
        COUNT(*) as count
      FROM graphrag.memories
      WHERE metadata->>'latitude' IS NOT NULL
      AND metadata->>'source' = 'seed-script'
      GROUP BY metadata->>'city', metadata->>'country'
      ORDER BY count DESC
      LIMIT 10
    `);

    const typeStats = await pool.query(`
      SELECT
        metadata->>'type' as type,
        COUNT(*) as count
      FROM graphrag.memories
      WHERE metadata->>'latitude' IS NOT NULL
      AND metadata->>'source' = 'seed-script'
      GROUP BY metadata->>'type'
      ORDER BY count DESC
    `);

    console.log(`\n✓ Total geo memories in database: ${countResult.rows[0].total}`);
    console.log('\nTop 10 cities by memory count:');
    for (const row of cityStats.rows) {
      console.log(`  ${row.city}, ${row.country}: ${row.count} memories`);
    }

    console.log('\nMemories by type:');
    for (const row of typeStats.rows) {
      console.log(`  ${row.type}: ${row.count} memories`);
    }

    // Test a geo query
    console.log('\n\nTesting geo query (Europe bounds)...');
    const geoTest = await pool.query(`
      SELECT
        content,
        metadata->>'city' as city,
        metadata->>'latitude' as lat,
        metadata->>'longitude' as lng
      FROM graphrag.memories
      WHERE metadata->>'latitude' IS NOT NULL
        AND metadata->>'longitude' IS NOT NULL
        AND CAST(metadata->>'latitude' AS FLOAT) BETWEEN 40 AND 60
        AND CAST(metadata->>'longitude' AS FLOAT) BETWEEN -10 AND 30
        AND metadata->>'source' = 'seed-script'
      LIMIT 5
    `);

    console.log(`Found ${geoTest.rows.length} memories in Europe bounds:`);
    for (const row of geoTest.rows) {
      console.log(`  • [${row.city}] (${row.lat}, ${row.lng}): ${row.content.substring(0, 60)}...`);
    }

    console.log('\n=== Seeding Complete! ===\n');
    console.log('You can now test the geo endpoints:');
    console.log('  POST /api/v1/data-explorer/geo/memories');
    console.log('  POST /api/v1/data-explorer/geo/heatmap');
    console.log('  POST /api/v1/data-explorer/geo/clusters');
    console.log('  POST /api/v1/data-explorer/geo/search');
    console.log('  POST /api/v1/data-explorer/geo/temporal\n');

  } catch (error) {
    console.error('\n✗ Error during seeding:', error);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('Database connection closed.');
  }
}

// Run the script
if (require.main === module) {
  seedGeoData()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { seedGeoData };
