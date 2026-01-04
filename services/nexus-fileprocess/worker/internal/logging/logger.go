package logging

import (
	"fmt"
	"log"
	"os"
)

// Logger provides structured logging for the worker
type Logger struct {
	prefix string
	logger *log.Logger
}

// NewLogger creates a new logger with a prefix
func NewLogger(prefix string) *Logger {
	return &Logger{
		prefix: prefix,
		logger: log.New(os.Stdout, fmt.Sprintf("[%s] ", prefix), log.LstdFlags),
	}
}

// Info logs an informational message with key-value pairs
func (l *Logger) Info(msg string, keysAndValues ...interface{}) {
	l.logWithKV("INFO", msg, keysAndValues...)
}

// Warn logs a warning message with key-value pairs
func (l *Logger) Warn(msg string, keysAndValues ...interface{}) {
	l.logWithKV("WARN", msg, keysAndValues...)
}

// Error logs an error message with key-value pairs
func (l *Logger) Error(msg string, keysAndValues ...interface{}) {
	l.logWithKV("ERROR", msg, keysAndValues...)
}

// Debug logs a debug message with key-value pairs
func (l *Logger) Debug(msg string, keysAndValues ...interface{}) {
	l.logWithKV("DEBUG", msg, keysAndValues...)
}

func (l *Logger) logWithKV(level, msg string, keysAndValues ...interface{}) {
	kvStr := ""
	for i := 0; i < len(keysAndValues); i += 2 {
		if i+1 < len(keysAndValues) {
			kvStr += fmt.Sprintf(" %v=%v", keysAndValues[i], keysAndValues[i+1])
		}
	}
	l.logger.Printf("[%s] %s%s", level, msg, kvStr)
}
