/**
 * Route Utilities - Enhanced Error Handling
 *
 * Provides consistent error response formatting and helper functions for Express routes.
 * This file has been refactored to use the new ApiResponse and error class system.
 *
 * @deprecated Individual functions are deprecated in favor of ApiResponse class
 * Import ApiResponse from './api-response' for new code
 */

export * from './api-response';
export * from './errors';

// Re-export for backward compatibility
import {
  handleRouteError,
  handleBadRequest,
  handleNotFound,
  handleServiceUnavailable,
  ApiResponse
} from './api-response';

export {
  handleRouteError,
  handleBadRequest,
  handleNotFound,
  handleServiceUnavailable,
  ApiResponse
};
