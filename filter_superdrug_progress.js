const fs = require('fs');
const path = require('path');

// Configuration
const EXCLUDED_CATEGORIES = ['fashion', 'health']; // Categories to filter OUT
const INPUT_DIR = 'vendors/superdrugs/back-up/progress';
const OUTPUT_DIR = 'vendors/superdrugs/back-up/filtered';

// Input files
const INPUT_FILES = [
    'combined-urls.output_index_1.json',
    'combined-urls.output__index_2.json'
];

// Helper function to check if a product should be excluded based on categories
function shouldExcludeProduct(product) {
    if (!product.category) return false;
    
    const category = product.category.toLowerCase();
    
    // Check if product belongs to excluded categories
    return EXCLUDED_CATEGORIES.some(excludedCat => {
        const excluded = excludedCat.toLowerCase();
        return category.includes(excluded) || excluded.includes(category);
    });
}

// Helper function to extract product identifier for deduplication
function getProductIdentifier(product) {
    // Use product_id as primary identifier, fallback to name if not available
    return product.product_id || product.name || product.source_url;
}

// Helper function to clean and validate product data
function cleanProduct(product) {
    // Remove products without essential fields
    if (!product.name || !product.source_url) {
        return null;
    }
    
    // Clean up common data issues
    const cleaned = { ...product };
    
    // Clean price field (remove encoding issues)
    if (cleaned.price) {
        cleaned.price = cleaned.price.replace(/Â£/g, '£').trim();
    }
    
    // Clean name field
    if (cleaned.name) {
        cleaned.name = cleaned.name.trim();
    }
    
    // Ensure images is always an array
    if (!Array.isArray(cleaned.images)) {
        cleaned.images = [];
    }
    
    return cleaned;
}

// Main filtering function
async function filterAndDeduplicate() {
    console.log('🚀 Starting Superdrug progress file filtering...');
    console.log(`🚫 Excluding categories: ${EXCLUDED_CATEGORIES.join(', ')}`);
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        console.log(`📁 Created output directory: ${OUTPUT_DIR}`);
    }
    
    const allProducts = [];
    const seenProducts = new Set();
    let duplicateCount = 0;
    
    // Process each input file
    for (const filename of INPUT_FILES) {
        const filePath = path.join(INPUT_DIR, filename);
        
        if (!fs.existsSync(filePath)) {
            console.log(`⚠️  File not found: ${filePath}`);
            continue;
        }
        
        console.log(`\n📖 Processing: ${filename}`);
        
        try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(fileContent);
            
            let products = [];
            if (Array.isArray(data)) {
                products = data;
            } else if (data.items && Array.isArray(data.items)) {
                products = data.items;
            } else {
                console.log(`⚠️  Unexpected file structure in ${filename}`);
                continue;
            }
            
            console.log(`   Found ${products.length} products in ${filename}`);
            
            // Process products from this file
            for (const product of products) {
                const cleaned = cleanProduct(product);
                if (!cleaned) continue;
                
                const identifier = getProductIdentifier(cleaned);
                if (!identifier) continue;
                
                // Check for duplicates
                if (seenProducts.has(identifier)) {
                    duplicateCount++;
                    continue;
                }
                
                // Check if product should be excluded
                if (!shouldExcludeProduct(cleaned)) {
                    seenProducts.add(identifier);
                    allProducts.push(cleaned);
                }
            }
            
        } catch (error) {
            console.error(`❌ Error processing ${filename}:`, error.message);
        }
    }
    
    console.log(`\n📊 Processing complete!`);
    console.log(`   Total products found: ${allProducts.length}`);
    console.log(`   Duplicates removed: ${duplicateCount}`);
    
    // Sort products by name for better organization
    allProducts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    // Create output files
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Save filtered results
    const filteredOutputPath = path.join(OUTPUT_DIR, `filtered_${timestamp}.json`);
    const filteredData = {
        metadata: {
            created_at: new Date().toISOString(),
                    source_files: INPUT_FILES,
        excluded_categories: EXCLUDED_CATEGORIES,
        total_products: allProducts.length,
        duplicates_removed: duplicateCount
        },
        products: allProducts
    };
    
    fs.writeFileSync(filteredOutputPath, JSON.stringify(filteredData, null, 2));
    console.log(`💾 Saved filtered results to: ${filteredOutputPath}`);
    
    // Save summary report
    const summaryPath = path.join(OUTPUT_DIR, `summary_${timestamp}.txt`);
    const summary = [
        `Superdrug Progress Files Filtering Summary`,
        `=============================================`,
        `Generated: ${new Date().toISOString()}`,
        ``,
        `Source Files:`,
        ...INPUT_FILES.map(f => `  - ${f}`),
        ``,
        `Excluded Categories: ${EXCLUDED_CATEGORIES.join(', ')}`,
        ``,
        `Results:`,
        `  Total Products Found: ${allProducts.length}`,
        `  Duplicates Removed: ${duplicateCount}`,
        ``,
        `Output Files:`,
        `  - Filtered Data: filtered_${timestamp}.json`,
        `  - Summary: summary_${timestamp}.txt`,
        ``,
        `Category Breakdown:`,
    ];
    
    // Add category breakdown for remaining categories
    const categoryCounts = {};
    allProducts.forEach(product => {
        if (product.category) {
            const category = product.category.toLowerCase();
            // Only count categories that are NOT in excluded list
            const isExcluded = EXCLUDED_CATEGORIES.some(excludedCat => 
                category.includes(excludedCat.toLowerCase()) || excludedCat.toLowerCase().includes(category)
            );
            if (!isExcluded) {
                categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            }
        }
    });
    
    // Sort categories by count (highest first)
    Object.entries(categoryCounts)
        .sort(([,a], [,b]) => b - a)
        .forEach(([category, count]) => {
            summary.push(`  ${category}: ${count} products`);
        });
    
    fs.writeFileSync(summaryPath, summary.join('\n'));
    console.log(`📋 Saved summary report to: ${summaryPath}`);
    
    // Display sample of results
    console.log(`\n🔍 Sample of filtered products:`);
    allProducts.slice(0, 5).forEach((product, index) => {
        console.log(`   ${index + 1}. ${product.name}`);
        console.log(`      Category: ${product.category || 'N/A'}`);
        console.log(`      Price: ${product.price || 'N/A'}`);
        console.log(`      Images: ${product.images ? product.images.length : 0}`);
        console.log(``);
    });
    
    if (allProducts.length > 5) {
        console.log(`   ... and ${allProducts.length - 5} more products`);
    }
    
    console.log(`\n✅ Filtering complete! Check the ${OUTPUT_DIR} directory for results.`);
}

// Run the script
if (require.main === module) {
    filterAndDeduplicate().catch(console.error);
}

module.exports = { filterAndDeduplicate, shouldExcludeProduct, getProductIdentifier };
