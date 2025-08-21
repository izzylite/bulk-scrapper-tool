'use strict';

const fs = require('fs');
const path = require('path');
const { logError, logErrorWithDetails, extractErrorDetails } = require('./logUtil');

// Global state for tracking active learning processes
let activeLearningTask = null;
let pendingLearningFields = new Map(); // vendor -> Set of fields needing learning

/**
 * Add fields that need selector learning for a vendor
 * @param {string} vendor - The vendor name
 * @param {Array<string>} fields - Array of field names that need learning
 */
function reportFieldsNeedingLearning(vendor, fields) {
    if (!fields || fields.length === 0) return;
    
    if (!pendingLearningFields.has(vendor)) {
        pendingLearningFields.set(vendor, new Set());
    }
    
    console.log(`[SELECTOR_LEARNING] Reported ${fields.length} fields needing learning for ${vendor}: ${fields.join(', ')}`); 
}

/**
 * Check if there's an active learning task
 * @returns {boolean} True if learning is in progress
 */
function isLearningActive() {
    return activeLearningTask !== null;
}

/**
 * Wait for any active learning task to complete
 * @returns {Promise<void>}
 */
async function waitForLearningCompletion() {
    if (activeLearningTask) {
        console.log(`[SELECTOR_LEARNING] Waiting for active learning task to complete...`);
        try {
            await activeLearningTask;
        } catch (error) {
            console.log(`[SELECTOR_LEARNING] Active learning task failed: ${error.message}`);
            logErrorWithDetails('selector_learning_wait_completion_failed', error);
        }
        console.log(`[SELECTOR_LEARNING] Learning task completed, proceeding...`);
    }
}

/**
 * Get the current pending learning fields for a vendor and clear them
 * @param {string} vendor - The vendor name
 * @returns {Array<string>} Array of field names that need learning
 */
function getAndClearPendingFields(vendor) {
    if (!pendingLearningFields.has(vendor)) {
        return [];
    }
    
    const fields = Array.from(pendingLearningFields.get(vendor));
    pendingLearningFields.set(vendor, new Set());
    return fields;
}

/**
 * Process all pending selector learning for a vendor
 * @param {Object} page - The Playwright page object
 * @param {string} vendor - The vendor name
 * @param {Object} extractedItem - The extracted item with field values
 * @returns {Promise<void>}
 */
async function processPendingSelectorLearning(page, vendor, extractedItem) {
    // Check if we already have an active learning task
    if (activeLearningTask) {
        console.log(`[SELECTOR_LEARNING] Learning already in progress, skipping...`);
        return;
    }
    
    // Get pending fields for this vendor
    const fieldsToLearn = getAndClearPendingFields(vendor);
    if (fieldsToLearn.length === 0) {
        return;
    }
     
    // Create the learning task
    activeLearningTask = executeFieldLearning(page, vendor, extractedItem, fieldsToLearn)
        .catch(error => {
            // Log learning task failure
            console.log(`[SELECTOR_LEARNING] Learning task failed for ${vendor}: ${error.message}`);
            logErrorWithDetails('selector_learning_task_failed', error, { 
                vendor, 
                fieldsToLearn
            });
            throw error; // Re-throw to maintain error handling chain
        })
        .finally(() => {
            activeLearningTask = null;
        });
    
    // Don't await here - let it run in background
    return activeLearningTask;
}

/**
 * Execute the actual selector learning logic
 * @param {Object} page - The Playwright page object
 * @param {string} vendor - The vendor name
 * @param {Object} extractedItem - The extracted item with field values
 * @param {Array<string>} fieldsToLearn - Array of field names to learn
 * @returns {Promise<void>}
 */
async function executeFieldLearning(page, vendor, extractedItem, fieldsToLearn) {
    // Import the learning functions from generic.js
    const { learnAndCacheSelectors } = require('./selectorLearningCore');
    
    // Filter the extracted item to only include fields we want to learn
    const itemForLearning = {};
    for (const field of fieldsToLearn) {
        if (extractedItem[field] !== undefined && extractedItem[field] !== null && extractedItem[field] !== '') {
            itemForLearning[field] = extractedItem[field];
        }
    }
     
    if (Object.keys(itemForLearning).length > 0) {
        try {
            await learnAndCacheSelectors(page, vendor, itemForLearning);
        } catch (error) { 
            // Log field learning execution failure
            console.log(`[SELECTOR_LEARNING] Field learning execution failed for ${vendor}: ${error.message}`);
            logErrorWithDetails('selector_learning_execution_failed', error, { 
                vendor, 
                fieldsToLearn, 
                itemForLearning: Object.keys(itemForLearning)
            });
            throw error;
        }
    } else {
        // Log when no fields have values to learn from
        console.log(`[SELECTOR_LEARNING] No fields with values to learn for ${vendor}`);
        logError('selector_learning_no_fields_with_values', { 
            vendor, 
            fieldsToLearn,
            extractedItemKeys: Object.keys(extractedItem)
        });
    }
}

/**
 * Get statistics about pending learning tasks
 * @returns {Object} Statistics object
 */
function getLearningStats() {
    const stats = {
        isActive: isLearningActive(),
        pendingVendors: pendingLearningFields.size,
        totalPendingFields: 0
    };
    
    for (const [vendor, fields] of pendingLearningFields) {
        stats.totalPendingFields += fields.size;
    }
    
    return stats;
}

module.exports = {
    reportFieldsNeedingLearning,
    isLearningActive,
    waitForLearningCompletion,
    processPendingSelectorLearning,
    getLearningStats
};
