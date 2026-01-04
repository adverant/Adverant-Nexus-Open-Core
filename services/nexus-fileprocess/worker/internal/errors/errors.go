package errors

import (
	"fmt"
	"time"
)

/**
 * Custom error types for FileProcessAgent Worker
 *
 * Design Pattern: Factory Pattern for error creation
 * SOLID Principle: Single Responsibility (each error type has one purpose)
 */

// ErrorCode enum for structured error handling
type ErrorCode string

const (
	// Processing errors
	ErrorProcessingTimeout ErrorCode = "PROCESSING_TIMEOUT"
	ErrorOCRFailed         ErrorCode = "OCR_FAILED"
	ErrorUnsupportedFormat ErrorCode = "UNSUPPORTED_FORMAT"

	// Storage errors
	ErrorStorageFailed  ErrorCode = "STORAGE_FAILED"
	ErrorDatabaseFailed ErrorCode = "DATABASE_FAILED"

	// Network errors
	ErrorNetworkTimeout ErrorCode = "NETWORK_TIMEOUT"
	ErrorAPICallFailed  ErrorCode = "API_CALL_FAILED"
)

// ProcessingError represents a structured processing error
type ProcessingError struct {
	Code      ErrorCode
	Message   string
	JobID     string
	Timestamp time.Time
	Details   map[string]interface{}
	Cause     error
}

func (e *ProcessingError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s (caused by: %v)", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *ProcessingError) Unwrap() error {
	return e.Cause
}

// Factory functions for common errors

func NewProcessingTimeoutError(jobID string, duration time.Duration, cause error) *ProcessingError {
	return &ProcessingError{
		Code:      ErrorProcessingTimeout,
		Message:   fmt.Sprintf("Processing timed out after %v", duration),
		JobID:     jobID,
		Timestamp: time.Now(),
		Details: map[string]interface{}{
			"timeout_duration": duration.String(),
		},
		Cause: cause,
	}
}

func NewOCRFailedError(jobID string, tier string, cause error) *ProcessingError {
	return &ProcessingError{
		Code:      ErrorOCRFailed,
		Message:   fmt.Sprintf("OCR failed at tier: %s", tier),
		JobID:     jobID,
		Timestamp: time.Now(),
		Details: map[string]interface{}{
			"ocr_tier": tier,
		},
		Cause: cause,
	}
}

func NewUnsupportedFormatError(jobID string, mimeType string) *ProcessingError {
	return &ProcessingError{
		Code:      ErrorUnsupportedFormat,
		Message:   fmt.Sprintf("Unsupported file format: %s", mimeType),
		JobID:     jobID,
		Timestamp: time.Now(),
		Details: map[string]interface{}{
			"mime_type": mimeType,
		},
	}
}

func NewStorageFailedError(jobID string, cause error) *ProcessingError {
	return &ProcessingError{
		Code:      ErrorStorageFailed,
		Message:   "Failed to store processing results",
		JobID:     jobID,
		Timestamp: time.Now(),
		Cause:     cause,
	}
}

// ToMap converts error to map for database storage
func (e *ProcessingError) ToMap() map[string]interface{} {
	result := map[string]interface{}{
		"error_code": string(e.Code),
		"message":    e.Message,
		"timestamp":  e.Timestamp,
	}

	for k, v := range e.Details {
		result[k] = v
	}

	if e.Cause != nil {
		result["cause"] = e.Cause.Error()
	}

	return result
}
