'use strict';

/**
 * Centralized cache management utility for Stagehand product extraction
 * Provides memory-efficient caching with automatic cleanup and size limits
 */

class CacheManager {
    constructor() {
        // Individual cache stores
        this.caches = {
            imageValidation: new Map(),
            vendorSelectors: null,
            vendorSelectorsLastModified: 0,
            urlResults: new Map(),
            problemUrls: new Map(),
        };
        
        // Cache configuration
        this.config = {
            imageValidation: { maxSize: 10000, keepSize: 5000 },
            urlResults: { maxSize: 1000, keepSize: 500 },
            problemUrls: { maxSize: 500, keepSize: 250 },
        };
        
        // Auto-cleanup interval (every 5 minutes)
        this.cleanupInterval = setInterval(() => this.maintainAllCaches(), 5 * 60 * 1000);
    }
    
    /**
     * Get a value from a specific cache
     */
    get(cacheName, key) {
        const cache = this.caches[cacheName];
        if (cache instanceof Map) {
            return cache.get(key);
        }
        return cache;
    }
    
    /**
     * Set a value in a specific cache
     */
    set(cacheName, key, value) {
        const cache = this.caches[cacheName];
        if (cache instanceof Map) {
            cache.set(key, value);
            this.maintainCache(cacheName);
        } else {
            this.caches[cacheName] = value;
        }
    }
    
    /**
     * Clear a specific cache or all caches
     */
    clear(cacheName = null) {
        if (cacheName) {
            const cache = this.caches[cacheName];
            if (cache instanceof Map) {
                cache.clear();
            } else {
                this.caches[cacheName] = null;
            }
        } else {
            // Clear all caches
            Object.keys(this.caches).forEach(name => this.clear(name));
        }
    }
    
    /**
     * Maintain a specific cache by removing old entries when size limit is reached
     */
    maintainCache(cacheName) {
        const cache = this.caches[cacheName];
        const config = this.config[cacheName];
        
        if (!cache || !config || !(cache instanceof Map)) return;
        
        if (cache.size > config.maxSize) {
            const entries = Array.from(cache.entries());
            cache.clear();
            
            // Keep only the most recent entries (LRU-style)
            const keepEntries = entries.slice(-config.keepSize);
            keepEntries.forEach(([key, value]) => cache.set(key, value));
            
            console.log(`[CACHE] Cleaned ${cacheName}: kept ${keepEntries.length}/${entries.length} entries`);
        }
    }
    
    /**
     * Maintain all caches
     */
    maintainAllCaches() {
        Object.keys(this.config).forEach(cacheName => this.maintainCache(cacheName));
    }
    
    /**
     * Get cache statistics
     */
    getStats() {
        const stats = {};
        Object.keys(this.caches).forEach(name => {
            const cache = this.caches[name];
            if (cache instanceof Map) {
                stats[name] = {
                    size: cache.size,
                    maxSize: this.config[name]?.maxSize || 'unlimited',
                    hitRate: this.getHitRate(name),
                };
            } else if (name === 'vendorSelectors' || name === 'vendorSelectorsLastModified') {
                // Skip internal cache tracking entries from stats display
                return;
            } else {
                stats[name] = {
                    type: typeof cache,
                    cached: cache !== null,
                };
            }
        });
        return stats;
    }
    
    /**
     * Calculate approximate hit rate for a cache (simplified)
     */
    getHitRate(cacheName) {
        // This is a simplified implementation - in production you might want to track hits/misses
        const cache = this.caches[cacheName];
        if (cache instanceof Map && cache.size > 0) {
            // Estimate hit rate based on cache utilization
            const utilization = cache.size / (this.config[cacheName]?.maxSize || 1000);
            return Math.min(Math.max(utilization * 0.8, 0.1), 0.95); // Rough estimate
        }
        return 0;
    }
    
    /**
     * Cleanup resources
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.clear();
    }
}

// Export singleton instance
const cacheManager = new CacheManager();

// Graceful cleanup on process exit
process.on('exit', () => cacheManager.destroy());
process.on('SIGINT', () => cacheManager.destroy());
process.on('SIGTERM', () => cacheManager.destroy());

module.exports = cacheManager;
