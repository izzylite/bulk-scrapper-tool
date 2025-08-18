# Local Browser Configuration Guide

Your SessionManager has been successfully configured to run with local headless browsers instead of Browserbase cloud service.

## Key Changes Made

### ✅ **Environment Configuration**
- Changed from `env: 'BROWSERBASE'` to `env: 'LOCAL'`
- Removed Browserbase-specific API keys and project IDs
- Added Playwright browser configuration

### ✅ **Proxy Support** 
- External proxy support via PacketStream/OxyLabs
- Automatic fallback to non-proxy mode if proxy fails
- Proxy authentication handled through Playwright

### ✅ **Performance Optimizations**
- Resource blocking for images, media, fonts
- Stealth mode to avoid bot detection
- Configurable viewport and browser settings
- Optimized Chrome/Chromium arguments

## Environment Variables

```bash
# Required
OPENAI_API_KEY=your_openai_api_key_here

# Browser Settings
HEADLESS=true                    # true/false
BROWSER_NAME=chromium           # chromium/chrome/firefox/webkit
STAGEHAND_VERBOSE=0             # 0/1/2
BLOCK_RESOURCES=false           # true/false

# Proxy Settings (Optional)
PS_USER=your_packetstream_username
PS_PASS=your_packetstream_password
PROXY_COUNTRY=GB
PROXY_CITY=LONDON
```

## Usage Examples

### 1. Basic Headless Scraping
```javascript
// No additional configuration needed
// Uses default headless Chromium without proxy
const sessionManager = new SessionManager();
```

### 2. With External Proxy
```javascript
// Set environment variables:
// PS_USER=username, PS_PASS=password
const sessionManager = new SessionManager();
// Proxy will be enabled automatically during session rotation
```

### 3. Debug Mode (Visible Browser)
```javascript
// Set: HEADLESS=false, STAGEHAND_VERBOSE=2
// Browser window will be visible for debugging
```

### 4. Performance Mode
```javascript
// Set: BLOCK_RESOURCES=true, RES_BLOCK_IMAGES=true
// Faster scraping with blocked resources
```

## How Session Management Changed

- **Session Reuse**: Local browsers create new instances instead of reusing Browserbase sessions
- **Session IDs**: Generated locally using browser process ID + timestamp
- **Rotation**: Creates new browser instances with proxy on rotation
- **Fallback**: Automatically disables proxy if connection fails

## Browser Features

### Stealth Mode
- Disabled automation indicators
- Randomized user agents
- Reduced fingerprinting
- CAPTCHA solver integration

### Resource Management  
- Configurable resource blocking
- Memory optimization
- Process cleanup on shutdown
- Graceful error handling

## Testing Your Setup

1. Ensure you have the required dependencies:
   ```bash
   npm install playwright @stagehand/core
   ```

2. Set your environment variables (especially `OPENAI_API_KEY`)

3. Run your scraping tool - it should now use local browsers instead of Browserbase

4. Check the logs for messages like:
   ```
   [SESSION 1] Creating local headless browser instance
   [SESSION 1] Browser: chromium, Viewport: 1280x800
   ```

## Troubleshooting

- **Browser launch fails**: Check if Playwright browsers are installed (`npx playwright install`)
- **Proxy errors**: Verify credentials and try `{enable: false, external: false}` 
- **Performance issues**: Enable `BLOCK_RESOURCES=true` and `RES_BLOCK_IMAGES=true`
- **Debug issues**: Set `HEADLESS=false` and `STAGEHAND_VERBOSE=2`

Your SessionManager is now ready to run with local browsers! 🚀
