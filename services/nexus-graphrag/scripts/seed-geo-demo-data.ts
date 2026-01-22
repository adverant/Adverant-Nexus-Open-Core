#!/usr/bin/env tsx
/**
 * Seed Script: Geo-Tagged Demo Data for GeoViewer
 *
 * Creates realistic geo-tagged memories across major cities to demonstrate:
 * - Marker clustering at different zoom levels
 * - Heatmap density visualization
 * - Memory popup information
 * - Geographic filtering
 *
 * Usage: npx tsx scripts/seed-geo-demo-data.ts
 *
 * Environment:
 *   DATABASE_URL - PostgreSQL connection string (default: postgresql://nexus:nexus@localhost:5432/nexus)
 *
 * The script is idempotent - running it multiple times will not create duplicates
 * because it uses deterministic UUIDs based on content hash.
 */

import { Pool } from 'pg';
import { createHash } from 'crypto';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://nexus:nexus@localhost:5432/nexus';

// ============================================================================
// DEMO MEMORY TYPES
// ============================================================================

interface DemoMemory {
  content: string;
  tags: string[];
  metadata: {
    latitude: number;
    longitude: number;
    placeName: string;
    city: string;
    region: string;
    country: string;
    accuracy?: number;
    source: string;
    category: string;
  };
}

// ============================================================================
// DEMO DATA - 55+ MEMORIES ACROSS 12 GLOBAL CITIES
// ============================================================================

const DEMO_MEMORIES: DemoMemory[] = [
  // === SAN FRANCISCO BAY AREA (8 memories - cluster demo) ===
  {
    content: 'Q4 2024 All-Hands Meeting at SF HQ - Announced expansion into Europe and Asia-Pacific markets. Revenue up 45% YoY. Team celebrated with catered lunch from local Vietnamese restaurant.',
    tags: ['meeting', 'company', 'quarterly', 'san-francisco', 'hq'],
    metadata: {
      latitude: 37.7749, longitude: -122.4194,
      placeName: 'Adverant SF Headquarters',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'calendar', category: 'corporate'
    }
  },
  {
    content: 'GraphRAG Architecture Deep Dive - Technical session on vector indexing optimization and multi-tenant isolation patterns. Covered Qdrant sharding strategies and PostgreSQL RLS policies.',
    tags: ['engineering', 'technical', 'graphrag', 'san-francisco'],
    metadata: {
      latitude: 37.7850, longitude: -122.4085,
      placeName: 'SF Tech Campus - Building A',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'confluence', category: 'engineering'
    }
  },
  {
    content: 'Customer Success Workshop - Training session for new enterprise accounts on Memory Lens and Data Explorer features. Covered decay curves, relevance scoring, and geo visualization.',
    tags: ['training', 'customer-success', 'workshop', 'san-francisco'],
    metadata: {
      latitude: 37.7855, longitude: -122.4064,
      placeName: 'SF Training Center',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'learning-platform', category: 'training'
    }
  },
  {
    content: 'AI Ethics Board Meeting - Reviewed responsible AI guidelines for memory systems. Approved new privacy-by-design framework. Discussed geo-location blurring requirements for sensitive data.',
    tags: ['ethics', 'ai', 'governance', 'san-francisco'],
    metadata: {
      latitude: 37.7862, longitude: -122.4090,
      placeName: 'SF Ethics & Compliance',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'board-minutes', category: 'governance'
    }
  },
  {
    content: 'Product Launch Party - Celebrated GeoViewer release with 200+ team members. Featured live demo of global memory visualization with real-time clustering.',
    tags: ['celebration', 'product', 'team', 'san-francisco'],
    metadata: {
      latitude: 37.7695, longitude: -122.4129,
      placeName: 'SF Event Space',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'events', category: 'social'
    }
  },
  {
    content: 'Stanford AI Lab Partnership - Signed MOU for joint research on episodic memory systems and temporal reasoning. Will collaborate on decay curve optimization algorithms.',
    tags: ['research', 'partnership', 'stanford', 'palo-alto'],
    metadata: {
      latitude: 37.4275, longitude: -122.1697,
      placeName: 'Stanford University - Gates Building',
      city: 'Palo Alto', region: 'California', country: 'United States',
      source: 'partnerships', category: 'research'
    }
  },
  {
    content: 'VC Pitch Meeting - Series C discussion with Andreessen Horowitz. Presented growth metrics and enterprise expansion roadmap. Key focus: memory graph differentiation.',
    tags: ['fundraising', 'vc', 'finance', 'palo-alto'],
    metadata: {
      latitude: 37.4419, longitude: -122.1430,
      placeName: 'Sand Hill Road - a16z',
      city: 'Palo Alto', region: 'California', country: 'United States',
      source: 'investor-relations', category: 'finance'
    }
  },
  {
    content: 'Oakland Tech Hub Opening - New satellite office for distributed engineering team. 50-person capacity with hybrid setup. Focus on Memory Lens backend development.',
    tags: ['expansion', 'office', 'oakland', 'real-estate'],
    metadata: {
      latitude: 37.8044, longitude: -122.2712,
      placeName: 'Oakland Tech Hub',
      city: 'Oakland', region: 'California', country: 'United States',
      source: 'facilities', category: 'operations'
    }
  },

  // === NEW YORK (5 memories) ===
  {
    content: 'Wall Street Client Summit - Met with 25 financial institutions to discuss AI-powered knowledge management for trading floors. Strong interest in real-time memory recall features.',
    tags: ['client', 'finance', 'summit', 'new-york', 'wall-street'],
    metadata: {
      latitude: 40.7074, longitude: -74.0113,
      placeName: 'NYSE Building',
      city: 'New York', region: 'New York', country: 'United States',
      source: 'crm', category: 'sales'
    }
  },
  {
    content: 'NYC Office Grand Opening - Times Square location with 30,000 sq ft. Keynote by CEO on East Coast expansion strategy. Featured Memory Lens live demo wall.',
    tags: ['expansion', 'office', 'new-york', 'times-square'],
    metadata: {
      latitude: 40.7580, longitude: -73.9855,
      placeName: 'Times Square Tower',
      city: 'New York', region: 'New York', country: 'United States',
      source: 'events', category: 'corporate'
    }
  },
  {
    content: 'Media Interview - TechCrunch feature on enterprise memory systems. Discussed future of organizational knowledge graphs and temporal reasoning in AI assistants.',
    tags: ['media', 'pr', 'techcrunch', 'new-york'],
    metadata: {
      latitude: 40.7527, longitude: -73.9772,
      placeName: 'TechCrunch NYC Studio',
      city: 'New York', region: 'New York', country: 'United States',
      source: 'pr', category: 'marketing'
    }
  },
  {
    content: 'Columbia University Guest Lecture - Presented on AI memory systems to 300+ CS graduate students. Covered vector embeddings, graph databases, and multi-agent retrieval.',
    tags: ['education', 'lecture', 'columbia', 'new-york'],
    metadata: {
      latitude: 40.8075, longitude: -73.9626,
      placeName: 'Columbia - Davis Auditorium',
      city: 'New York', region: 'New York', country: 'United States',
      source: 'education', category: 'outreach'
    }
  },
  {
    content: 'Healthcare AI Consortium Meeting - Discussed HIPAA-compliant memory systems with 12 hospital networks. Key requirement: geo-location blurring for patient data.',
    tags: ['healthcare', 'compliance', 'hipaa', 'new-york'],
    metadata: {
      latitude: 40.7648, longitude: -73.9536,
      placeName: 'NewYork-Presbyterian',
      city: 'New York', region: 'New York', country: 'United States',
      source: 'healthcare-vertical', category: 'industry'
    }
  },

  // === LONDON (4 memories) ===
  {
    content: 'London Office Launch - Canary Wharf location for EMEA headquarters. 75 employees, serving UK and EU markets. Focus on GDPR-compliant memory architecture.',
    tags: ['expansion', 'london', 'emea', 'headquarters'],
    metadata: {
      latitude: 51.5054, longitude: -0.0235,
      placeName: 'Canary Wharf Tower',
      city: 'London', region: 'England', country: 'United Kingdom',
      source: 'facilities', category: 'corporate'
    }
  },
  {
    content: 'GDPR Compliance Workshop - Trained 50+ team members on EU data protection requirements for memory systems. Covered right-to-be-forgotten implementation.',
    tags: ['compliance', 'gdpr', 'legal', 'london'],
    metadata: {
      latitude: 51.5074, longitude: -0.1278,
      placeName: 'London Legal Hub',
      city: 'London', region: 'England', country: 'United Kingdom',
      source: 'legal', category: 'compliance'
    }
  },
  {
    content: 'UK FinTech Partnership - Signed deal with Revolut for AI-powered customer service memory systems. Will integrate with their support ticketing workflow.',
    tags: ['partnership', 'fintech', 'revolut', 'london'],
    metadata: {
      latitude: 51.5155, longitude: -0.0922,
      placeName: 'Revolut HQ - Broadgate',
      city: 'London', region: 'England', country: 'United Kingdom',
      source: 'partnerships', category: 'business-development'
    }
  },
  {
    content: 'AI UK Conference Keynote - Presented "The Future of Organizational Memory" to 2,000 attendees at ExCeL London. Demoed real-time GeoViewer clustering.',
    tags: ['conference', 'keynote', 'ai-uk', 'london'],
    metadata: {
      latitude: 51.5087, longitude: 0.0293,
      placeName: 'ExCeL London',
      city: 'London', region: 'England', country: 'United Kingdom',
      source: 'events', category: 'speaking'
    }
  },

  // === TOKYO (3 memories) ===
  {
    content: 'Tokyo Office Opening - Shibuya location for APAC expansion. Local team of 25 engineers and sales. Japanese language support fully implemented.',
    tags: ['expansion', 'tokyo', 'apac', 'office'],
    metadata: {
      latitude: 35.6595, longitude: 139.7004,
      placeName: 'Shibuya Hikarie Tower',
      city: 'Tokyo', region: 'Tokyo', country: 'Japan',
      source: 'facilities', category: 'corporate'
    }
  },
  {
    content: 'SoftBank Partnership Meeting - Discussed enterprise deployment for SoftBank portfolio companies. Interest in Memory Lens for VC knowledge management.',
    tags: ['partnership', 'softbank', 'vc', 'tokyo'],
    metadata: {
      latitude: 35.6581, longitude: 139.7414,
      placeName: 'SoftBank HQ - Shiodome',
      city: 'Tokyo', region: 'Tokyo', country: 'Japan',
      source: 'partnerships', category: 'business-development'
    }
  },
  {
    content: 'Japanese Localization Sprint - Completed full Japanese language support for all UI and documentation. Includes kanji/hiragana NLP improvements.',
    tags: ['localization', 'japanese', 'engineering', 'tokyo'],
    metadata: {
      latitude: 35.6762, longitude: 139.6503,
      placeName: 'Tokyo Engineering Center',
      city: 'Tokyo', region: 'Tokyo', country: 'Japan',
      source: 'engineering', category: 'i18n'
    }
  },

  // === SINGAPORE (2 memories) ===
  {
    content: 'Singapore Data Center Launch - New APAC infrastructure hub for low-latency regional access. Partnered with AWS ap-southeast-1 for Qdrant hosting.',
    tags: ['infrastructure', 'datacenter', 'singapore', 'apac'],
    metadata: {
      latitude: 1.2789, longitude: 103.8536,
      placeName: 'Singapore Data Center',
      city: 'Singapore', region: 'Singapore', country: 'Singapore',
      source: 'infrastructure', category: 'operations'
    }
  },
  {
    content: 'ASEAN Tech Summit - Presented to government officials on AI memory systems for public sector digital transformation. Strong interest from Singapore GovTech.',
    tags: ['government', 'asean', 'summit', 'singapore'],
    metadata: {
      latitude: 1.2931, longitude: 103.8558,
      placeName: 'Marina Bay Sands Convention',
      city: 'Singapore', region: 'Singapore', country: 'Singapore',
      source: 'events', category: 'government'
    }
  },

  // === BERLIN (2 memories) ===
  {
    content: 'Berlin Engineering Hub - Opened 40-person R&D center focused on privacy-preserving AI and federated learning. Key focus: on-premise deployment options.',
    tags: ['engineering', 'r&d', 'berlin', 'privacy'],
    metadata: {
      latitude: 52.5200, longitude: 13.4050,
      placeName: 'Berlin Tech Campus',
      city: 'Berlin', region: 'Berlin', country: 'Germany',
      source: 'facilities', category: 'engineering'
    }
  },
  {
    content: 'German Automotive Partnership - Signed deal with BMW for AI-powered engineering knowledge management. Will integrate with their CAD documentation workflow.',
    tags: ['partnership', 'automotive', 'bmw', 'berlin'],
    metadata: {
      latitude: 52.5068, longitude: 13.3330,
      placeName: 'BMW Innovation Lab Berlin',
      city: 'Berlin', region: 'Berlin', country: 'Germany',
      source: 'partnerships', category: 'automotive'
    }
  },

  // === SYDNEY (2 memories) ===
  {
    content: 'Sydney Office Launch - Circular Quay location for Australia and New Zealand operations. 30-person team covering ANZ enterprise accounts.',
    tags: ['expansion', 'sydney', 'anz', 'office'],
    metadata: {
      latitude: -33.8568, longitude: 151.2153,
      placeName: 'Circular Quay Tower',
      city: 'Sydney', region: 'New South Wales', country: 'Australia',
      source: 'facilities', category: 'corporate'
    }
  },
  {
    content: 'Australian Banking Consortium - Presented to Big Four banks on secure memory systems for financial services. Key interest: regulatory compliance features.',
    tags: ['banking', 'finance', 'australia', 'sydney'],
    metadata: {
      latitude: -33.8688, longitude: 151.2093,
      placeName: 'Sydney Financial District',
      city: 'Sydney', region: 'New South Wales', country: 'Australia',
      source: 'sales', category: 'finance'
    }
  },

  // === TORONTO (2 memories) ===
  {
    content: 'Toronto AI Research Lab - Partnership with Vector Institute on next-gen memory architectures. Focus on attention mechanisms for long-context retrieval.',
    tags: ['research', 'ai', 'vector-institute', 'toronto'],
    metadata: {
      latitude: 43.6532, longitude: -79.3832,
      placeName: 'MaRS Discovery District',
      city: 'Toronto', region: 'Ontario', country: 'Canada',
      source: 'research', category: 'r&d'
    }
  },
  {
    content: 'Canadian Tech Summit Keynote - Presented to 1,500 attendees on enterprise memory systems. Live demo of GeoViewer with Canadian customer data.',
    tags: ['conference', 'keynote', 'canada', 'toronto'],
    metadata: {
      latitude: 43.6426, longitude: -79.3871,
      placeName: 'Metro Toronto Convention Centre',
      city: 'Toronto', region: 'Ontario', country: 'Canada',
      source: 'events', category: 'speaking'
    }
  },

  // === PARIS (2 memories) ===
  {
    content: 'Paris Fashion Tech Partnership - Deployed memory systems for LVMH design team collaboration. Integrates with their mood board and trend forecasting workflow.',
    tags: ['fashion', 'luxury', 'lvmh', 'paris'],
    metadata: {
      latitude: 48.8606, longitude: 2.3376,
      placeName: 'LVMH Innovation Center',
      city: 'Paris', region: 'Île-de-France', country: 'France',
      source: 'partnerships', category: 'luxury'
    }
  },
  {
    content: 'Station F Accelerator Demo Day - Showcased GeoViewer to 50+ startups and investors. Three potential pilot customers signed letters of intent.',
    tags: ['startup', 'accelerator', 'demo-day', 'paris'],
    metadata: {
      latitude: 48.8345, longitude: 2.3698,
      placeName: 'Station F',
      city: 'Paris', region: 'Île-de-France', country: 'France',
      source: 'events', category: 'startup'
    }
  },

  // === MUMBAI (2 memories) ===
  {
    content: 'India Tech Center Opening - BKC location for engineering and customer support. 100-person team focused on 24/7 support coverage and backend development.',
    tags: ['expansion', 'india', 'mumbai', 'office'],
    metadata: {
      latitude: 19.0760, longitude: 72.8777,
      placeName: 'BKC Tech Tower',
      city: 'Mumbai', region: 'Maharashtra', country: 'India',
      source: 'facilities', category: 'corporate'
    }
  },
  {
    content: 'Reliance Jio Partnership - Deployed memory systems for telecom customer service AI. Processing 1M+ customer interactions daily for memory extraction.',
    tags: ['partnership', 'telecom', 'jio', 'mumbai'],
    metadata: {
      latitude: 19.0619, longitude: 72.8626,
      placeName: 'Jio World Centre',
      city: 'Mumbai', region: 'Maharashtra', country: 'India',
      source: 'partnerships', category: 'telecom'
    }
  },

  // === ADDITIONAL MEMORIES FOR DENSITY DEMO ===
  // More SF Bay Area memories to show clustering
  {
    content: 'Security Audit Completion - Passed SOC 2 Type II audit for memory storage systems. All controls operating effectively. Ready for enterprise deployments.',
    tags: ['security', 'audit', 'soc2', 'compliance'],
    metadata: {
      latitude: 37.7891, longitude: -122.4012,
      placeName: 'SF Security Operations',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'security', category: 'compliance'
    }
  },
  {
    content: 'ML Model Deployment - Released Memory Decay v2.0 model with improved Ebbinghaus curve fitting. 40% better accuracy on recall prediction tasks.',
    tags: ['ml', 'model', 'deployment', 'memory-decay'],
    metadata: {
      latitude: 37.7823, longitude: -122.3915,
      placeName: 'SF ML Lab',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'mlops', category: 'engineering'
    }
  },
  {
    content: 'Board Meeting Q4 - Reviewed annual performance. ARR growth 180% YoY. Approved Series D timeline and geographic expansion budget.',
    tags: ['board', 'finance', 'strategy', 'quarterly'],
    metadata: {
      latitude: 37.7944, longitude: -122.3994,
      placeName: 'SF Board Room',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'board-minutes', category: 'governance'
    }
  },
  {
    content: 'UX Research Sprint - Conducted 25 user interviews on GeoViewer. Key findings: users want more filtering options and heatmap intensity controls.',
    tags: ['ux', 'research', 'geoviewer', 'product'],
    metadata: {
      latitude: 37.7867, longitude: -122.4089,
      placeName: 'SF Design Studio',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'product', category: 'design'
    }
  },
  {
    content: 'API Performance Optimization - Reduced p99 latency for geo queries from 450ms to 120ms. Implemented spatial indexing on PostgreSQL metadata JSONB.',
    tags: ['performance', 'api', 'optimization', 'geo'],
    metadata: {
      latitude: 37.7801, longitude: -122.3967,
      placeName: 'SF Engineering - Perf Team',
      city: 'San Francisco', region: 'California', country: 'United States',
      source: 'engineering', category: 'performance'
    }
  },

  // More London memories
  {
    content: 'UK Enterprise Sales Kickoff - Q1 planning with EMEA sales team. Set targets: 50 new enterprise accounts, focus on financial services vertical.',
    tags: ['sales', 'kickoff', 'emea', 'planning'],
    metadata: {
      latitude: 51.5115, longitude: -0.0231,
      placeName: 'London Sales Office',
      city: 'London', region: 'England', country: 'United Kingdom',
      source: 'sales', category: 'planning'
    }
  },
  {
    content: 'Brexit Data Compliance - Completed UK Adequacy Framework alignment. Established UK-specific data processing agreement templates.',
    tags: ['compliance', 'brexit', 'data', 'legal'],
    metadata: {
      latitude: 51.5129, longitude: -0.0889,
      placeName: 'London Compliance Center',
      city: 'London', region: 'England', country: 'United Kingdom',
      source: 'legal', category: 'compliance'
    }
  },

  // More NYC memories
  {
    content: 'Media & Entertainment Vertical Launch - Partnered with NBCUniversal for production workflow memory management. Pilot with Saturday Night Live writers.',
    tags: ['media', 'entertainment', 'nbcuniversal', 'partnership'],
    metadata: {
      latitude: 40.7590, longitude: -73.9795,
      placeName: 'NBCUniversal NYC',
      city: 'New York', region: 'New York', country: 'United States',
      source: 'partnerships', category: 'media'
    }
  },
  {
    content: 'Legal Tech Partnership - Signed deal with Cravath for AI-powered legal research memory. Will integrate with their document review workflow.',
    tags: ['legal', 'partnership', 'cravath', 'enterprise'],
    metadata: {
      latitude: 40.7536, longitude: -73.9762,
      placeName: 'Cravath NYC',
      city: 'New York', region: 'New York', country: 'United States',
      source: 'partnerships', category: 'legal'
    }
  },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a deterministic UUID from content hash
 * This ensures idempotency - running the script twice won't create duplicates
 */
function generateDeterministicId(content: string, metadata: DemoMemory['metadata']): string {
  const hash = createHash('sha256')
    .update(content + JSON.stringify(metadata))
    .digest('hex');
  // Format as UUID v4 (with proper version bits)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Generate a random date within the past N days
 */
function randomDateWithinDays(days: number): Date {
  const now = Date.now();
  const offset = Math.random() * days * 24 * 60 * 60 * 1000;
  return new Date(now - offset);
}

// ============================================================================
// MAIN SEED FUNCTION
// ============================================================================

async function seedGeoData(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  console.log('🌍 Starting Geo Demo Data Seed...');
  console.log(`📊 Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`📍 Memories to seed: ${DEMO_MEMORIES.length}`);
  console.log('');

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  try {
    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'graphrag'
        AND table_name = 'memories'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.error('❌ Error: graphrag.memories table does not exist!');
      console.error('   Run database migrations first.');
      process.exit(1);
    }

    console.log('✅ Database connection verified');
    console.log('');

    for (const memory of DEMO_MEMORIES) {
      const id = generateDeterministicId(memory.content, memory.metadata);
      const createdAt = randomDateWithinDays(90); // Random date within last 90 days

      try {
        // Upsert to handle idempotency
        const result = await pool.query(`
          INSERT INTO graphrag.memories (
            id,
            content,
            tags,
            metadata,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $5)
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `, [
          id,
          memory.content,
          memory.tags,
          JSON.stringify(memory.metadata),
          createdAt,
        ]);

        if (result.rowCount && result.rowCount > 0) {
          successCount++;
          console.log(`✅ Created: ${memory.metadata.city} - ${memory.metadata.placeName}`);
        } else {
          skipCount++;
          console.log(`⏭️  Skipped (exists): ${memory.metadata.city} - ${memory.metadata.placeName}`);
        }
      } catch (error: any) {
        errorCount++;
        console.error(`❌ Error: ${memory.metadata.city} - ${memory.metadata.placeName}`);
        console.error(`   ${error.message}`);
      }
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 SEED SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`   ✅ Created:  ${successCount}`);
    console.log(`   ⏭️  Skipped:  ${skipCount}`);
    console.log(`   ❌ Errors:   ${errorCount}`);
    console.log(`   ────────────────────`);
    console.log(`   📍 Total:    ${DEMO_MEMORIES.length}`);
    console.log('');

    // City breakdown
    const cities = [...new Set(DEMO_MEMORIES.map(m => m.metadata.city))];
    console.log('📍 CITIES COVERED:');
    cities.forEach(city => {
      const count = DEMO_MEMORIES.filter(m => m.metadata.city === city).length;
      console.log(`   • ${city}: ${count} memories`);
    });
    console.log('');

    // Category breakdown
    const categories = [...new Set(DEMO_MEMORIES.map(m => m.metadata.category))];
    console.log('🏷️  CATEGORIES:');
    categories.forEach(cat => {
      const count = DEMO_MEMORIES.filter(m => m.metadata.category === cat).length;
      console.log(`   • ${cat}: ${count} memories`);
    });
    console.log('');

    if (successCount > 0 || skipCount > 0) {
      console.log('🎉 Geo demo data is ready! Navigate to GeoViewer in the dashboard to see it.');
    }

  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

seedGeoData()
  .then(() => {
    console.log('✨ Seed script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Seed script failed:', error);
    process.exit(1);
  });
