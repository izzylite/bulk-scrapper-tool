'use strict';

const fs = require('fs');
const path = require('path');

// Logging configuration
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_LEVELS = {
    ERROR: 'error',
    WARN: 'warn',
    INFO: 'info',
    DEBUG: 'debug'
};

/**
 * Ensure log directory exists
 */
function ensureLogDirectory() {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
    } catch (error) {
        // Silently fail if we can't create log directory
        console.error(`Failed to create log directory: ${error.message}`);
    }
}

/**
 * Get log file path for current date
 * @returns {string} Path to today's log file
 */
function getLogFilePath() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD format
    return path.join(LOG_DIR, `${today}.log`);
}

/**
 * Write log entry to file
 * @param {string} level - Log level (error, warn, info, debug)
 * @param {string} event - Event name/type
 * @param {Object} details - Additional details to log
 */
function writeLogEntry(level, event, details = {}) {
    try {
        ensureLogDirectory();
        
        const logFile = getLogFilePath();
        const entry = {
            ts: new Date().toISOString(),
            level: level,
            event: event,
            ...details
        };
        
        const logLine = JSON.stringify(entry) + '\n';
        fs.appendFileSync(logFile, logLine, 'utf8');
    } catch (error) {
        // Silently fail to avoid infinite loops
        console.error(`Failed to write log entry: ${error.message}`);
    }
}

/**
 * Log an error event
 * @param {string} event - Error event name/type
 * @param {Object} details - Error details (should include error message, stack, etc.)
 */
function logError(event, details = {}) {
    writeLogEntry(LOG_LEVELS.ERROR, event, details);
}

/**
 * Log a warning event
 * @param {string} event - Warning event name/type
 * @param {Object} details - Warning details
 */
function logWarning(event, details = {}) {
    writeLogEntry(LOG_LEVELS.WARN, event, details);
}

/**
 * Log an info event
 * @param {string} event - Info event name/type
 * @param {Object} details - Info details
 */
function logInfo(event, details = {}) {
    writeLogEntry(LOG_LEVELS.INFO, event, details);
}

/**
 * Log a debug event
 * @param {string} event - Debug event name/type
 * @param {Object} details - Debug details
 */
function logDebug(event, details = {}) {
    writeLogEntry(LOG_LEVELS.DEBUG, event, details);
}

/**
 * Helper function to safely extract error information
 * @param {Error} error - Error object
 * @returns {Object} Safe error details object
 */
function extractErrorDetails(error) {
    if (!error) return {};
    
    return {
        error: error.message || String(error),
        stack: error.stack || undefined,
        name: error.name || undefined,
        code: error.code || undefined
    };
}

/**
 * Log an error with automatic error detail extraction
 * @param {string} event - Error event name/type
 * @param {Error} error - Error object
 * @param {Object} additionalDetails - Additional context details
 */
function logErrorWithDetails(event, error, additionalDetails = {}) {
    const errorDetails = extractErrorDetails(error);
    logError(event, { ...errorDetails, ...additionalDetails });
}

/**
 * Get log statistics
 * @returns {Object} Log statistics
 */
function getLogStats() {
    try {
        const logFile = getLogFilePath();
        if (!fs.existsSync(logFile)) {
            return { exists: false, size: 0, entries: 0 };
        }
        
        const stats = fs.statSync(logFile);
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());
        
        return {
            exists: true,
            size: stats.size,
            entries: lines.length,
            lastModified: stats.mtime,
            path: logFile
        };
    } catch (error) {
        return { 
            exists: false, 
            size: 0, 
            entries: 0, 
            error: error.message 
        };
    }
}

/**
 * Read recent log entries
 * @param {number} maxEntries - Maximum number of entries to return
 * @param {string} level - Filter by log level (optional)
 * @returns {Array} Array of log entry objects
 */
function getRecentLogEntries(maxEntries = 50, level = null) {
    try {
        const logFile = getLogFilePath();
        if (!fs.existsSync(logFile)) {
            return [];
        }
        
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());
        
        const entries = lines
            .slice(-maxEntries) // Get last N lines
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(entry => entry !== null);
        
        if (level) {
            return entries.filter(entry => entry.level === level);
        }
        
        return entries;
    } catch (error) {
        logError('log_read_failed', extractErrorDetails(error));
        return [];
    }
}

module.exports = {
    // Main logging functions
    logError,
    logWarning,
    logInfo,
    logDebug,
    
    // Enhanced logging functions
    logErrorWithDetails,
    extractErrorDetails,
    
    // Utility functions
    getLogStats,
    getRecentLogEntries,
    
    // Constants
    LOG_LEVELS,
    LOG_DIR
};
