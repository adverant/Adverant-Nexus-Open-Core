/**
 * Global Test Type Declarations
 * Defines types for global test utilities and custom matchers
 */

declare global {
  /**
   * Global test utilities available in all test files
   */
  var testUtils: {
    /**
     * Delay execution for specified milliseconds
     */
    delay: (ms: number) => Promise<void>;

    /**
     * Retry a function with exponential backoff
     */
    retry: (fn: () => Promise<any>, retries?: number, delay?: number) => Promise<any>;

    /**
     * Generate a random string of specified length
     */
    randomString: (length?: number) => string;

    /**
     * Measure execution time of an async function
     */
    measureTime: (fn: () => Promise<any>) => Promise<{ result: any; duration: number }>;
  };

  namespace jest {
    interface Matchers<R> {
      /**
       * Custom matcher to check if value has real data
       */
      toHaveRealData(): R;
    }
  }
}

export {};
