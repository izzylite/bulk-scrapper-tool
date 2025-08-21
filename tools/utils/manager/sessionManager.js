'use strict';

const { withFileLock } = require('./files/pendingManager');

/**
 * SessionManager - Manages Browserbase session lifecycle with cost optimization
 * Features:
 * - Session reuse to avoid 1-minute minimum billing charges
 * - Automatic image blocking when using proxies
 * - Graceful session rotation and error handling
 * - Session pool management for cost efficiency
 */
class SessionManager {
    constructor() {
        // Proxy providers - using 'residential' type for Browserbase compatibility
        this.proxyProviders = {
            packetstream: {
                type: 'external',
                server: "http://proxy.packetstream.io:31112",
                username: process.env.PS_USER,
                password: process.env.PS_PASS,
                geolocation: {
                    country: (process.env.PROXY_COUNTRY || 'GB').toUpperCase(),
                    city: (process.env.PROXY_CITY || 'LONDON').toUpperCase()
                }
            },
            oxylabs: {
                type: 'external',
                server: "http://pr.oxylabs.io:7777",
                username: process.env.OXY_USER,
                password: process.env.OXY_PASS
            },
        };
        // Session ID storage for cost-effective reuse
        this.sessionIdPool = new Set();
        this.usedSessionIds = new Set();

        // Global session tracking for graceful shutdown
        this.activeSessionManagers = new Map();

        // Global instance creator for session rotation
        this.globalStagehandCtor = null;

        // Shutdown flag to prevent new sessions/actions during SIGINT/SIGTERM
        this.isShuttingDown = false;

        // Logging function (will be injected)
        this.logError = null;

        // Page performance configuration tracking
        this.pageRouteHandlers = new WeakMap(); // page -> handler
        this.pagePerfConfig = new WeakMap();    // page -> {blockImages, blockStyles, blockScripts}
    }

    /**
     * Initialize the SessionManager with required dependencies
     */
    initialize(stagehandCtor, logErrorFn) {
        this.globalStagehandCtor = stagehandCtor;
        this.logError = logErrorFn || (() => { });
    }

    /**
     * Configure per-page performance optimizations (request blocking), supports reconfiguration
     */
    async configurePagePerformance(workerSessionManager, options = {}) {
        try {
            const page = workerSessionManager.getStagehand().page;
            if (!page) return;

            // Resolve desired config with proxy-aware image blocking
            const enableProxy = workerSessionManager.getRotationCount() > 0 || false;
            const desired = {
                // Block images by default when proxies are enabled (cost optimization)
                // Can be overridden by explicit RES_BLOCK_IMAGES setting
                blockImages: process.env.RES_BLOCK_IMAGES ?
                    String(process.env.RES_BLOCK_IMAGES).toLowerCase() === 'true' :
                    enableProxy, // Default to blocking images when using proxies
                blockStyles: String(process.env.RES_BLOCK_STYLES || 'false').toLowerCase() !== 'false',
                blockScripts: String(process.env.RES_BLOCK_SCRIPTS || 'false').toLowerCase() === 'true',
                ...(options || {}),
            };

            const current = this.pagePerfConfig.get(page);
            if (current && current.blockImages === desired.blockImages && current.blockStyles === desired.blockStyles && current.blockScripts === desired.blockScripts) {
                return; // already configured with same settings
            }

            // Remove previous route handler if exists
            const prevHandler = this.pageRouteHandlers.get(page);
            if (prevHandler) {
                try { await page.unroute('**/*', prevHandler); } catch { }
            }

            // Create new handler with desired config
            const handler = route => {
                try {
                    const req = route.request();
                    const type = req.resourceType();
                    const url = req.url();
                    if (
                        type === 'font' ||
                        type === 'media' ||
                        (desired.blockImages && type === 'image') ||
                        (desired.blockStyles && type === 'stylesheet') ||
                        (desired.blockScripts && type === 'script') ||
                        /analytics|tracking|telemetry|pixel\.|doubleclick|googletagmanager/i.test(url)
                    ) {
                        return route.abort();
                    }
                    return route.continue();
                } catch {
                    return route.continue();
                }
            };

            await page.route('**/*', handler);
            this.pageRouteHandlers.set(page, handler);
            this.pagePerfConfig.set(page, desired);
            try { page.setDefaultNavigationTimeout?.(30000); } catch { }
        } catch { }
    }

    /**
     * Safely get a Stagehand page with automatic performance configuration
     */
    async getSafePage(workerSessionManager, options = {}) {
        try {
            const stagehandInst = workerSessionManager.getStagehand();
            const p = stagehandInst.page;
            await this.configurePagePerformance(workerSessionManager, options);
            return p;
        } catch (e) {
            const msg = String(e && e.message ? e.message : e || '');
            if (/StagehandNotInitializedError/i.test(msg)) {
                try {
                    const stagehandInst = workerSessionManager.getStagehand();
                    await stagehandInst.init();
                } catch { }
                const p2 = workerSessionManager.getStagehand().page;
                await this.configurePagePerformance(workerSessionManager, options);
                return p2;
            }
            throw e;
        }
    }

    /**
     * Add session ID to pool for reuse
     */
    addSessionIdToPool(sessionId) {
        if (sessionId && typeof sessionId === 'string') {
            this.sessionIdPool.add(sessionId);
            console.log(`[SESSION] Added session ID to pool: ${sessionId.slice(0, 8)}... (pool size: ${this.sessionIdPool.size})`);
        }
    }

    /**
     * Get available session ID for reuse
     */
    getAvailableSessionId() {
        const enableReuse = String(process.env.BROWSERBASE_SESSION_REUSE || 'true').toLowerCase() === 'true';
        if (!enableReuse || this.sessionIdPool.size === 0) return null;

        // Find first unused session ID
        for (const sessionId of this.sessionIdPool) {
            if (!this.usedSessionIds.has(sessionId)) {
                return sessionId;
            }
        }
        return null;
    }

    /**
     * Mark session as completed and available for reuse
     */
    markSessionAsCompleted(sessionId) {
        if (sessionId) {
            this.usedSessionIds.delete(sessionId);
            console.log(`[SESSION] Marked session as available for reuse: ${sessionId.slice(0, 8)}...`);
        }
    }

    /**
     * Extract session ID from a Stagehand instance
     */
    async extractSessionId(stagehandInstance) {
        try {
            // Try to get session ID from the Stagehand instance
            // This may vary depending on how Stagehand exposes session information
            const sessionId = stagehandInstance?.context?.sessionId ||
                stagehandInstance?.page?.context()?.sessionId ||
                stagehandInstance?.browserbaseSessionId;
            return sessionId;
        } catch (e) {
            console.log(`[SESSION] Could not extract session ID: ${e.message}`);
            return null;
        }
    }

    /**
     * Create a Stagehand instance with automatic fallback handling
     */
    async createStagehandInstanceWithFallback(enableProxy = false, reuseSessionId = null) {
        try {
            const instance = this.createStagehandInstance({ enable: true, external: false }, reuseSessionId);
            await instance.init();
            return instance;
        } catch (e) {
            const errorMsg = String(e?.message || e || '');
            console.log(`[SESSION] Primary configuration failed: ${errorMsg}`);

            // If proxy configuration failed, try without proxy as fallback
            if (enableProxy && /proxies|400|body\/proxies/i.test(errorMsg)) {
                console.log(`[SESSION] Retrying without proxy as fallback...`);
                try {
                    const fallbackInstance = this.createStagehandInstance({ enable: true, external: false }, reuseSessionId);
                    await fallbackInstance.init();
                    console.log(`[SESSION] Fallback session created successfully without proxy`);
                    return fallbackInstance;
                } catch (fallbackError) {
                    console.log(`[SESSION] Fallback also failed: ${fallbackError.message}`);
                    throw fallbackError;
                }
            }
            throw e;
        }
    }

    /**
     * Create a Stagehand instance with optional session reuse
     */
    createStagehandInstance(enableProxy = { enable: false, external: false }, reuseSessionId = null) {
        if (!this.globalStagehandCtor) throw new Error('SessionManager not initialized - call initialize() first');

        const local = true;
        const sessionTimeout = Number(process.env.BROWSERBASE_SESSION_TIMEOUT || 900); // seconds; default 15min

        // Check if proxies should be enabled via environment variable
        const shouldUseProxy = enableProxy.enable && this.proxyProviders.packetstream.username && this.proxyProviders.packetstream.password;

        const config = {
            env: local ? 'LOCAL' : 'BROWSERBASE',
            // verbose: 1, // Increased verbosity to help debug issues
            apiKey: process.env.BROWSERBASE_API_KEY,
            projectId: process.env.BROWSERBASE_PROJECT_ID,
            waitForCaptchaSolves: true,
            modelName: 'google/gemini-2.5-pro',
            modelClientOptions: { apiKey: process.env.GOOGLE_API_KEY },
            domSettleTimeoutMs: 3000, // Wait longer for DOM to settle
        };
        if (local) {
            config.localBrowserLaunchOptions = {
                headless: false,  // or false if you want to see the browser
            }
        }

        // Session reuse for cost optimization (1-minute minimum billing)
        if (reuseSessionId) {
            console.log(`[SESSION] Reusing existing session ID: ${reuseSessionId.slice(0, 8)}...`);
            config.browserbaseSessionId = reuseSessionId;
            // Mark session as used
            this.usedSessionIds.add(reuseSessionId);
        } else {
            // Create new session with parameters
            const sessionParams = {
                projectId: process.env.BROWSERBASE_PROJECT_ID,
                ...(sessionTimeout > 0 ? { timeout: sessionTimeout } : {}),
                browserSettings: {
                    blockAds: true,
                    viewport: { width: 1280, height: 800 },
                    // Add stealth features to avoid detection
                    advancedStealth: false, // Only for Enterprise plan
                    // Add better timeout handling
                    keepAlive: true,
                    // Reduce resource usage
                    solver: 'hcaptcha'
                },
            };

            // Only add proxy configuration if explicitly enabled and credentials are available
            if (shouldUseProxy && enableProxy.external) {
                console.log(`[SESSION] Enabling proxy configuration external...`);
                sessionParams.proxies = [this.proxyProviders.packetstream];
            }
            else if (shouldUseProxy && !enableProxy.external) {
                console.log(`[SESSION] Enabling proxy configuration browserbase...`);
                sessionParams.proxies = true;
            }
            else {
                console.log(`[SESSION] Creating session without proxy`);
                // Explicitly set proxies to false to disable them
                sessionParams.proxies = false;
            }

            config.browserbaseSessionCreateParams = sessionParams;
        }

        return new this.globalStagehandCtor(config);
    }

    /**
     * Helper function to safely close a Stagehand session with proper error handling
     */
    async safeCloseSession(stagehandInstance, workerId) {
        if (!stagehandInstance) return;

        try {
            await stagehandInstance.close();
        } catch (e) {
            const msg = String(e && e.message ? e.message : e || '');

            // Handle common CDP errors that are safe to ignore during cleanup
            const ignorableErrors = [
                /StagehandNotInitializedError/i,
                /DOM agent hasn't been enabled/i,
                /Protocol error.*DOM\.disable/i,
                /Session closed/i,
                /Target closed/i,
                /Connection closed/i,
                /Browser has been closed/i,
                /terminated/i
            ];

            const isIgnorable = ignorableErrors.some(pattern => pattern.test(msg));

            if (isIgnorable) {
                console.log(`[SESSION ${workerId}] Ignoring harmless cleanup error: ${msg}`);
            } else {
                // Re-throw non-ignorable errors
                throw e;
            }
        }
    }

    /**
     * Helper function to safely remove session manager
     */
    removeSessionManager(workerId) {
        if (this.activeSessionManagers.has(workerId)) {
            this.activeSessionManagers.delete(workerId);
            console.log(`[SESSION ${workerId}] Removed from active managers`);
        }
    }

    /**
     * Create a worker-scoped session manager with better isolation
     */
    createWorkerSessionManager(initialStagehand, workerId, appendBatchToOutputFn) {
        let current = initialStagehand;
        let rotating = null;
        let generation = 0;
        let currentSessionId = null;
        let rotationCount = 0;
        let buffer = { outputPath: null, sourceFile: null, processingFilePath: null, items: [] };


        const sessionManager = {
            getStagehand: () => current,
            getGeneration: () => generation,
            getWorkerId: () => workerId,
            getRotationCount: () => rotationCount,
            registerBuffer: (outputPath, sourceFile, processingFilePath) => {
                buffer.outputPath = outputPath;
                buffer.sourceFile = sourceFile;
                buffer.processingFilePath = processingFilePath;
                buffer.items = [];
            },
            addItemToBuffer: (item) => {
                if (!buffer.items) buffer.items = [];
                buffer.items.push(item);
            },
            clearBuffer: () => { buffer.items = []; },
            flushBuffer: async () => {
                if (!buffer || !Array.isArray(buffer.items) || buffer.items.length === 0) return;
                await appendBatchToOutputFn(
                    buffer.outputPath,
                    { source_file: buffer.sourceFile },
                    buffer.items,
                    buffer.processingFilePath
                );
                console.log(`[SESSION ${workerId}] Flushed ${buffer.items.length} in-progress items to output`);
                buffer.items = [];
            },
            rotate: async (reason) => {
                if (rotating) {
                    console.log(`[SESSION ${workerId}] Already rotating, waiting...`);
                    return rotating;
                }
                console.log(`[SESSION ${workerId}] Rotating session due to: ${reason}`);
                rotating = (async () => {

                    try {
                        // Extract session ID before closing for potential reuse
                        if (current && !currentSessionId) {
                            currentSessionId = await this.extractSessionId(current);
                            if (currentSessionId) {
                                this.addSessionIdToPool(currentSessionId);
                            }
                        }

                        console.log(`[SESSION ${workerId}] Closing old session...`);
                        await this.safeCloseSession(current, workerId);

                        // Mark current session as available for reuse if it was terminated gracefully
                        if (currentSessionId && reason !== 'session_error') {
                            this.markSessionAsCompleted(currentSessionId);
                        }
                    } catch (e) {
                        console.log(`[SESSION ${workerId}] Error closing old session:`, e.message);
                    }
                    if (this.isShuttingDown) {
                        console.log(`[SESSION ${workerId}] Skipping session rotation; shutdown in progress`);
                        throw new Error('Shutdown in progress');
                    }

                    // Try to reuse an existing session first (cost optimization)
                    const reuseSessionId = this.getAvailableSessionId();
                    if (reuseSessionId) {
                        console.log(`[SESSION ${workerId}] Attempting to reuse session...`);
                        try {
                            current = await this.createStagehandInstanceWithFallback(rotationCount > 0, reuseSessionId);
                            currentSessionId = reuseSessionId;
                            generation++;
                            console.log(`[SESSION ${workerId}] Session reused successfully (gen ${generation})`);
                            try { this.logError('session_reused', { reason, generation, workerId, sessionId: reuseSessionId.slice(0, 8) }); } catch { }
                            return current;
                        } catch (e) {
                            console.log(`[SESSION ${workerId}] Session reuse failed: ${e.message}, creating new session...`);
                            // Remove failed session from pool
                            this.sessionIdPool.delete(reuseSessionId);
                            this.usedSessionIds.delete(reuseSessionId);
                        }
                    }

                    // Create new session if reuse failed or not available
                    console.log(`[SESSION ${workerId}] Creating new session${rotationCount > 0 ? ' with proxy...' : '...'}`);
                    rotationCount++;
                    // Add small delay before creating new session to prevent rapid reconnections
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    current = await this.createStagehandInstanceWithFallback(rotationCount > 0);

                    // Extract and store new session ID
                    currentSessionId = await this.extractSessionId(current);
                    if (currentSessionId) {
                        this.addSessionIdToPool(currentSessionId);
                    }

                    generation++;
                    console.log(`[SESSION ${workerId}] New session created successfully (gen ${generation})`);
                    try { this.logError('session_rotated', { reason, generation, workerId }); } catch { }
                    return current;
                })();
                try {
                    return await rotating;
                } catch (e) {
                    console.log(`[SESSION ${workerId}] Session rotation failed:`, e.message);
                    throw e;
                } finally {
                    rotating = null;
                }
            },
            close: async () => {
                try {
                    // Extract and store session ID before closing for reuse
                    if (current && !currentSessionId) {
                        currentSessionId = await this.extractSessionId(current);
                        if (currentSessionId) {
                            this.addSessionIdToPool(currentSessionId);
                        }
                    }

                    await this.safeCloseSession(current, workerId);

                    // Mark session as available for reuse after graceful shutdown
                    if (currentSessionId) {
                        this.markSessionAsCompleted(currentSessionId);
                    }
                } catch (error) {
                    console.log(`[SESSION ${workerId}] Error during close:`, error.message);
                } finally {
                    // Always remove from active managers, even if close fails
                    this.removeSessionManager(workerId);
                }
            }
        };

        // Register this session manager for graceful shutdown
        this.activeSessionManagers.set(workerId, sessionManager);

        return sessionManager;
    }

    /**
     * Create multiple session managers with session reuse
     */
    async createMultipleSessionManagers(maxConcurrentBatches, appendBatchToOutputFn) {
        console.log(`[SESSIONS] Creating ${maxConcurrentBatches} concurrent browser sessions...`);

        // Create and initialize all sessions with delays to prevent connection issues
        const sessionPromises = Array.from({ length: maxConcurrentBatches }, async (_, workerIdx) => {
            const workerId = workerIdx + 1;
            console.log(`[SESSION ${workerId}] Initializing Stagehand instance...`);
            const initialStagehand = await this.createStagehandInstanceWithFallback(false); // Start without proxy for initial session

            // Extract and store session ID for cost optimization
            const sessionId = await this.extractSessionId(initialStagehand);
            if (sessionId) {
                this.addSessionIdToPool(sessionId);
            }

            console.log(`[SESSION ${workerId}] Stagehand initialized successfully`);
            return this.createWorkerSessionManager(initialStagehand, workerId, appendBatchToOutputFn);
        });

        const sessionManagers = await Promise.all(sessionPromises);
        console.log(`[SESSIONS] All ${maxConcurrentBatches} sessions initialized and ready`);

        return sessionManagers;
    }

    /**
     * Graceful shutdown handler
     */
    async gracefulShutdown(signal) {
        console.log(`\n[SHUTDOWN] Received ${signal}, gracefully closing ${this.activeSessionManagers.size} active sessions...`);

        if (this.activeSessionManagers.size === 0) {
            console.log(`[SHUTDOWN] No active sessions to close. Exiting...`);
            process.exit(0);
        }

        // First, ask sessions to flush their own buffers so we don't lose in-progress items
        await Promise.allSettled(Array.from(this.activeSessionManagers.values()).map(async (sm) => {
            try { await sm.flushBuffer?.(); } catch { }
        }));

        const shutdownPromises = Array.from(this.activeSessionManagers.entries()).map(async ([workerId, sessionManager]) => {
            try {
                console.log(`[SHUTDOWN] Closing session ${workerId}...`);
                await this.safeCloseSession(sessionManager.getStagehand(), workerId);
                console.log(`[SHUTDOWN] Session ${workerId} closed successfully`);
            } catch (error) {
                console.log(`[SHUTDOWN] Error closing session ${workerId}:`, error.message);
            } finally {
                // Ensure session is removed from tracking
                this.removeSessionManager(workerId);
            }
        });

        try {
            // Add timeout to prevent hanging
            const timeoutPromise = new Promise(resolve => setTimeout(resolve, 30000)); // 30 second timeout
            await Promise.race([
                Promise.allSettled(shutdownPromises),
                timeoutPromise
            ]);
            console.log(`[SHUTDOWN] All sessions closed. Exiting...`);
        } catch (error) {
            console.log(`[SHUTDOWN] Error during shutdown:`, error.message);
        }

        process.exit(0);
    }

    /**
     * Set shutdown flag
     */
    setShuttingDown(flag) {
        this.isShuttingDown = flag;
    }

    /**
     * Get shutdown status
     */
    getShuttingDown() {
        return this.isShuttingDown;
    }

    /**
     * Get active session managers count
     */
    getActiveSessionCount() {
        return this.activeSessionManagers.size;
    }

    /**
     * Get session pool statistics
     */
    getSessionPoolStats() {
        return {
            poolSize: this.sessionIdPool.size,
            usedSessions: this.usedSessionIds.size,
            availableSessions: this.sessionIdPool.size - this.usedSessionIds.size
        };
    }
}

module.exports = SessionManager;
