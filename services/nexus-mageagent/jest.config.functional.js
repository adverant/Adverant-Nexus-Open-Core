module.exports = {
  displayName: 'functional',
  testMatch: ['<rootDir>/tests/functional/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  testEnvironment: 'node',
  testTimeout: 120000, // 2 minutes per test
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'tests/functional/**/*.ts',
    '!tests/functional/**/*.test.ts',
    '!tests/functional/test-config.ts'
  ],
  coverageDirectory: '<rootDir>/coverage/functional',
  setupFilesAfterEnv: ['<rootDir>/tests/functional/setup.ts'],
  globals: {
    'ts-jest': {
      tsconfig: {
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      }
    }
  },
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: '<rootDir>/test-results',
        outputName: 'functional-test-results.xml',
        suiteName: 'MageAgent Functional Tests',
        classNameTemplate: '{classname}',
        titleTemplate: '{title}'
      }
    ],
    [
      'jest-html-reporter',
      {
        pageTitle: 'MageAgent Functional Test Report',
        outputPath: '<rootDir>/test-results/functional-test-report.html',
        includeFailureMsg: true,
        includeConsoleLog: true
      }
    ]
  ]
};