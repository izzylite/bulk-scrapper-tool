#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// Load environment variables from .env file
try { 
    require('dotenv').config({ path: path.join(__dirname, '../../../.env') }); 
} catch (e) {
    console.log('Note: .env file not found or dotenv not installed');
}

// Load Stagehand in a way that works for both ESM and CJS builds
async function loadStagehandCtor() {
    const mod = await import('@browserbasehq/stagehand');
    return mod.Stagehand || (mod.default && (mod.default.Stagehand || mod.default));
}

const SITEMAP_URL = 'https://www.superdrug.com/sitemap.xml';
const OUTPUT_DIR = path.join(__dirname, 'product_urls');

async function extractSitemapUrls() {
    console.log('🤖 Stagehand Sitemap URL Extractor');
    console.log('=================================');
    
    let stagehand = null;
    
    try {
        // Initialize Stagehand
        console.log('🚀 Initializing Stagehand...');
        const StagehandCtor = await loadStagehandCtor();
        stagehand = new StagehandCtor({
            env: 'BROWSERBASE',
            verbose: 0,
            apiKey: process.env.BROWSERBASE_API_KEY,
            projectId: process.env.BROWSERBASE_PROJECT_ID,
            modelName: 'gpt-4o',
            modelClientOptions: { apiKey: process.env.OPENAI_API_KEY },
            browserbaseSessionCreateParams: {
                projectId: process.env.BROWSERBASE_PROJECT_ID,
                browserSettings: {
                    blockAds: true,
                    viewport: { width: 1280, height: 800 },
                },
            },
        });
        
        await stagehand.init();
        console.log('✅ Stagehand initialized');
        
        console.log(`🌐 Navigating to sitemap: ${SITEMAP_URL}`);
        await stagehand.page.goto(SITEMAP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        console.log('📄 Extracting sitemap content...');
        const xmlContent = await stagehand.page.content();
        
        // Parse XML to find product URLs
        const productUrls = [];
        const urlMatches = xmlContent.match(/<loc>(.*?)<\/loc>/g) || [];
        
        for (const match of urlMatches) {
            const url = match.replace(/<\/?loc>/g, '');
            if (url.includes('Product') && url.includes('en_GB-GBP')) {
                productUrls.push(url.trim());
            }
        }
        
        console.log(`✅ Found ${productUrls.length} product sitemap URLs:`);
        productUrls.forEach((url, i) => {
            console.log(`   ${i + 1}. ${url}`);
        });
        
        // Save URLs to file
        const urlsFile = path.join(OUTPUT_DIR, 'product-sitemap-urls.json');
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
        
        const urlsData = {
            extracted_at: new Date().toISOString(),
            extraction_method: 'stagehand',
            sitemap_url: SITEMAP_URL,
            total_urls: productUrls.length,
            urls: productUrls
        };
        
        fs.writeFileSync(urlsFile, JSON.stringify(urlsData, null, 2), 'utf8');
        console.log(`💾 URLs saved to: ${path.basename(urlsFile)}`);
        
        console.log('\n📋 Manual Download Instructions:');
        console.log('================================');
        console.log('Since automated download is blocked, you can now:');
        console.log('1. Open each URL in your browser');
        console.log('2. Save the downloaded .xml.gz files to the downloads folder');
        console.log('3. Run the manual processing script');
        console.log('');
        console.log('URLs to download manually:');
        productUrls.forEach((url, i) => {
            console.log(`${i + 1}. ${url}`);
        });
        
        return productUrls;
        
    } catch (error) {
        console.error('💥 Failed to extract sitemap URLs:', error.message);
        throw error;
    } finally {
        if (stagehand) {
            try {
                console.log('🔒 Closing Stagehand session...');
                await stagehand.close();
            } catch (e) {
                console.error('Error closing Stagehand:', e.message);
            }
        }
    }
}

if (require.main === module) {
    extractSitemapUrls();
}

module.exports = { extractSitemapUrls };

