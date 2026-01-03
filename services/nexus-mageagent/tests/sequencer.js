/**
 * Custom test sequencer to run tests in optimal order
 * Unit tests first, then integration, then e2e, etc.
 */

const Sequencer = require('@jest/test-sequencer').default;

class CustomSequencer extends Sequencer {
  sort(tests) {
    // Define test priority order
    const priority = {
      'unit': 1,
      'integration': 2,
      'e2e': 3,
      'performance': 4,
      'chaos': 5,
      'security': 6
    };

    const copyTests = Array.from(tests);

    return copyTests.sort((testA, testB) => {
      // Extract test type from path
      const getTestType = (path) => {
        const match = path.match(/tests\/(unit|integration|e2e|performance|chaos|security)\//);
        return match ? match[1] : 'other';
      };

      const typeA = getTestType(testA.path);
      const typeB = getTestType(testB.path);

      const priorityA = priority[typeA] || 999;
      const priorityB = priority[typeB] || 999;

      // Sort by priority first
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      // Within same type, sort alphabetically
      return testA.path.localeCompare(testB.path);
    });
  }
}

module.exports = CustomSequencer;