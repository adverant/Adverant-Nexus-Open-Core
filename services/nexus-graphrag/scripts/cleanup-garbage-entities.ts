/**
 * Neo4j Garbage Entity Cleanup Script
 *
 * This script removes stopword entities that were incorrectly stored in Neo4j
 * before the entity validation fix was applied.
 *
 * Usage:
 *   npx ts-node scripts/cleanup-garbage-entities.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be deleted without actually deleting
 */

import neo4j, { Driver, Session } from 'neo4j-driver';

// List of stopwords that should never be entities
const GARBAGE_ENTITIES = [
  // Articles and pronouns
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'i', 'we', 'you', 'he', 'she', 'it', 'they', 'me', 'us', 'him', 'her', 'them',
  'my', 'our', 'your', 'his', 'its', 'their',
  // Common verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'can', 'may', 'might', 'must', 'shall',
  'get', 'got', 'make', 'made', 'let', 'set', 'put', 'take', 'took',
  'create', 'created', 'execute', 'executed', 'run', 'ran',
  'add', 'added', 'update', 'updated', 'delete', 'deleted', 'remove', 'removed',
  // Prepositions and conjunctions
  'for', 'from', 'with', 'without', 'to', 'of', 'in', 'on', 'at', 'by',
  'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'how', 'why',
  // Greetings and conversational
  'hello', 'hi', 'hey', 'bye', 'goodbye', 'thanks', 'thank', 'please', 'sorry', 'welcome',
  // Question words
  'what', 'which', 'who', 'whom', 'whose', 'why', 'how', 'where', 'when',
  // Quantifiers
  'some', 'any', 'all', 'each', 'every', 'both', 'few', 'many', 'much', 'more', 'most',
  // Common nouns that aren't useful entities
  'thing', 'things', 'stuff', 'way', 'ways', 'time', 'times', 'day', 'days',
  'example', 'examples', 'case', 'cases', 'type', 'types', 'kind', 'kinds',
  'summary', 'executive', 'overview', 'introduction', 'conclusion',
  // Generic tech words
  'data', 'code', 'file', 'files', 'function', 'functions', 'class', 'classes',
  'method', 'methods', 'variable', 'variables', 'value', 'values',
  'script', 'scripts', 'test', 'tests', 'testing', 'config', 'configuration',
  'build', 'builds', 'deploy', 'deployment', 'server', 'servers', 'client', 'clients',
  'user', 'users', 'system', 'systems', 'service', 'services', 'api', 'apis',
  // Common adjectives
  'new', 'old', 'good', 'bad', 'great', 'small', 'large', 'big', 'little',
  'first', 'last', 'next', 'previous', 'current', 'main', 'other',
  'important', 'specific', 'different', 'same', 'similar', 'various',
  // Meta words
  'here', 'there', 'now', 'then', 'today', 'tomorrow', 'yesterday',
  'true', 'false', 'yes', 'no', 'ok', 'okay',
  // Misc garbage
  'something', 'anything', 'everything', 'nothing', 'someone', 'anyone', 'everyone'
];

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('=== Neo4j Garbage Entity Cleanup ===');
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes)' : 'LIVE (will delete entities)'}`);
  console.log('');

  // Connect to Neo4j
  const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER || 'neo4j';
  const password = process.env.NEO4J_PASSWORD || 'password';

  console.log(`Connecting to Neo4j at ${uri}...`);

  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session: Session = driver.session();

  try {
    // First, count all entities
    const countResult = await session.run('MATCH (e:Entity) RETURN count(e) as total');
    const totalEntities = countResult.records[0].get('total').toNumber();
    console.log(`Total entities in database: ${totalEntities}`);

    // Find garbage entities
    console.log('');
    console.log('Searching for garbage entities...');

    const findGarbageQuery = `
      MATCH (e:Entity)
      WHERE toLower(e.name) IN $stopwords
      RETURN e.name as name, e.type as type, count(*) as count
      ORDER BY count DESC
    `;

    const garbageResult = await session.run(findGarbageQuery, { stopwords: GARBAGE_ENTITIES });

    if (garbageResult.records.length === 0) {
      console.log('No garbage entities found!');
      return;
    }

    console.log('');
    console.log('Garbage entities found:');
    console.log('------------------------');

    let totalGarbage = 0;
    for (const record of garbageResult.records) {
      const name = record.get('name');
      const type = record.get('type');
      const count = record.get('count').toNumber();
      totalGarbage += count;
      console.log(`  "${name}" (${type}): ${count} occurrences`);
    }

    console.log('------------------------');
    console.log(`Total garbage entities: ${totalGarbage}`);
    console.log(`Percentage of total: ${((totalGarbage / totalEntities) * 100).toFixed(2)}%`);

    if (isDryRun) {
      console.log('');
      console.log('DRY RUN: No entities were deleted.');
      console.log('Run without --dry-run to delete these entities.');
      return;
    }

    // Delete garbage entities
    console.log('');
    console.log('Deleting garbage entities...');

    const deleteQuery = `
      MATCH (e:Entity)
      WHERE toLower(e.name) IN $stopwords
      DETACH DELETE e
      RETURN count(*) as deleted
    `;

    const deleteResult = await session.run(deleteQuery, { stopwords: GARBAGE_ENTITIES });
    const deletedCount = deleteResult.records[0].get('deleted').toNumber();

    console.log(`Deleted ${deletedCount} garbage entities.`);

    // Verify cleanup
    const verifyResult = await session.run('MATCH (e:Entity) RETURN count(e) as total');
    const remainingEntities = verifyResult.records[0].get('total').toNumber();

    console.log('');
    console.log('=== Cleanup Complete ===');
    console.log(`Entities before: ${totalEntities}`);
    console.log(`Entities deleted: ${deletedCount}`);
    console.log(`Entities remaining: ${remainingEntities}`);
    console.log(`Reduction: ${((deletedCount / totalEntities) * 100).toFixed(2)}%`);

  } catch (error: any) {
    console.error('Error during cleanup:', error.message);
    process.exit(1);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
