const fs = require('fs');
const path = require('path');

/**
 * Script to update category values with the last breadcrumb item from Backup files
 * This script reads files in the Backup directory and updates the category field
 * with the last item from the breadcrumbs array
 */

// Configuration
const BACKUP_DIR = 'scrapper/output/superdrug/updates/Backup';
const OUTPUT_DIR = 'scrapper/output/superdrug/updates/Backup/updated';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`✅ Created output directory: ${OUTPUT_DIR}`);
}

/**
 * Update category with last breadcrumb item
 * @param {Object} product - Product object
 * @returns {Object} - Updated product object
 */
function updateCategoryFromBreadcrumbs(product) {
    if (!product || typeof product !== 'object') {
        return product;
    }

    const updatedProduct = { ...product };
    
    // Check if breadcrumbs exist and have items
    if (Array.isArray(updatedProduct.breadcrumbs) && updatedProduct.breadcrumbs.length > 0) {
        const lastBreadcrumb = updatedProduct.breadcrumbs[updatedProduct.breadcrumbs.length - 1];
        
        if (lastBreadcrumb && typeof lastBreadcrumb === 'string' && lastBreadcrumb.trim()) {
            // Update category with the last breadcrumb item (lowercase for consistency)
            updatedProduct.category = lastBreadcrumb.trim().toLowerCase();
        }
    } else if (updatedProduct.breadcrumbs && updatedProduct.breadcrumbs.length === 0) {
        // Handle empty breadcrumbs array
        updatedProduct.category = null;
    }
    updatedProduct.height = 0;
    updatedProduct.length = 0;
    return updatedProduct;
}

/**
 * Process a single JSON file
 * @param {string} filePath - Path to the JSON file
 * @returns {Object} - Processing result
 */
function processFile(filePath) {
    try {
        console.log(`📁 Processing file: ${path.basename(filePath)}`);
        
        // Read the file
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(fileContent);
        
        let updatedCount = 0;
        let totalCount = 0;
        let errors = [];
        
        // Check if data has the expected structure with 'items' array
        if (data && typeof data === 'object' && Array.isArray(data.items)) {
            totalCount = data.items.length;
            
            // Process each product in the items array
            const updatedItems = data.items.map((product, index) => {
                try {
                    const originalCategory = product.category;
                    const updatedProduct = updateCategoryFromBreadcrumbs(product);
                    
                    // Check if category was actually changed
                    if (originalCategory !== updatedProduct.category) {
                        updatedCount++;
                        console.log(`  ✅ Updated product ${index + 1}: "${originalCategory}" → "${updatedProduct.category}"`);
                    }
                    
                    return updatedProduct;
                } catch (error) {
                    errors.push(`Product ${index + 1}: ${error.message}`);
                    return product; // Return original product on error
                }
            });
            
            // Create updated data structure preserving metadata
            const updatedData = {
                ...data,
                items: updatedItems
            };
            
            // Write updated data to output file
            const outputFileName = `updated_${path.basename(filePath)}`;
            const outputPath = path.join(OUTPUT_DIR, outputFileName);
            
            fs.writeFileSync(outputPath, JSON.stringify(updatedData, null, 2));
            console.log(`💾 Saved updated file: ${outputFileName}`);
            
        } else if (Array.isArray(data)) {
            // Handle case where data is directly an array of products
            totalCount = data.length;
            
            // Process each product
            const updatedData = data.map((product, index) => {
                try {
                    const originalCategory = product.category;
                    const updatedProduct = updateCategoryFromBreadcrumbs(product);
                    
                    // Check if category was actually changed
                    if (originalCategory !== updatedProduct.category) {
                        updatedCount++;
                        console.log(`  ✅ Updated product ${index + 1}: "${originalCategory}" → "${updatedProduct.category}"`);
                    }
                    
                    return updatedProduct;
                } catch (error) {
                    errors.push(`Product ${index + 1}: ${error.message}`);
                    return product; // Return original product on error
                }
            });
            
            // Write updated data to output file
            const outputFileName = `updated_${path.basename(filePath)}`;
            const outputPath = path.join(OUTPUT_DIR, outputFileName);
            
            fs.writeFileSync(outputPath, JSON.stringify(updatedData, null, 2));
            console.log(`💾 Saved updated file: ${outputFileName}`);
            
        } else if (data && typeof data === 'object') {
            // Handle single product object
            totalCount = 1;
            const originalCategory = data.category;
            const updatedData = updateCategoryFromBreadcrumbs(data);
            
            // Check if category was actually changed
            if (originalCategory !== updatedData.category) {
                updatedCount++;
                console.log(`  ✅ Updated product: "${originalCategory}" → "${updatedData.category}"`);
            }
            
            // Write updated data to output file
            const outputFileName = `updated_${path.basename(filePath)}`;
            const outputPath = path.join(OUTPUT_DIR, outputFileName);
            
            fs.writeFileSync(outputPath, JSON.stringify(updatedData, null, 2));
            console.log(`💾 Saved updated file: ${outputFileName}`);
            
        } else {
            throw new Error('Invalid data format: expected object with items array, array, or single object');
        }
        
        return {
            success: true,
            filePath,
            totalCount,
            updatedCount,
            errors
        };
        
    } catch (error) {
        console.error(`❌ Error processing ${path.basename(filePath)}:`, error.message);
        return {
            success: false,
            filePath,
            error: error.message
        };
    }
}

/**
 * Main function to process all files in Backup directory
 */
async function main() {
    try {
        console.log('🚀 Starting category update process...');
        console.log(`📂 Backup directory: ${BACKUP_DIR}`);
        console.log(`📂 Output directory: ${OUTPUT_DIR}`);
        console.log('');
        
        // Check if Backup directory exists
        if (!fs.existsSync(BACKUP_DIR)) {
            throw new Error(`Backup directory not found: ${BACKUP_DIR}`);
        }
        
        // Get all JSON files in Backup directory
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(file => file.endsWith('.json'))
            .map(file => path.join(BACKUP_DIR, file));
        
        if (files.length === 0) {
            console.log('ℹ️  No JSON files found in Backup directory');
            return;
        }
        
        console.log(`📋 Found ${files.length} JSON file(s) to process:`);
        files.forEach(file => console.log(`  - ${path.basename(file)}`));
        console.log('');
        
        // Process each file
        const results = [];
        for (const file of files) {
            const result = processFile(file);
            results.push(result);
            console.log(''); // Add spacing between files
        }
        
        // Summary
        console.log('📊 Processing Summary:');
        console.log('=====================');
        
        let totalFiles = 0;
        let successfulFiles = 0;
        let totalProducts = 0;
        let totalUpdated = 0;
        let totalErrors = 0;
        
        results.forEach(result => {
            totalFiles++;
            if (result.success) {
                successfulFiles++;
                totalProducts += result.totalCount || 0;
                totalUpdated += result.updatedCount || 0;
                totalErrors += result.errors ? result.errors.length : 0;
                
                console.log(`✅ ${path.basename(result.filePath)}: ${result.updatedCount}/${result.totalCount} products updated`);
                
                if (result.errors && result.errors.length > 0) {
                    console.log(`   ⚠️  ${result.errors.length} errors encountered`);
                }
            } else {
                console.log(`❌ ${path.basename(result.filePath)}: Failed - ${result.error}`);
            }
        });
        
        console.log('');
        console.log('📈 Overall Results:');
        console.log(`   Files processed: ${totalFiles}`);
        console.log(`   Files successful: ${successfulFiles}`);
        console.log(`   Total products: ${totalProducts}`);
        console.log(`   Products updated: ${totalUpdated}`);
        console.log(`   Total errors: ${totalErrors}`);
        
        if (totalUpdated > 0) {
            console.log('');
            console.log(`🎉 Successfully updated ${totalUpdated} product categories!`);
            console.log(`📁 Updated files saved to: ${OUTPUT_DIR}`);
        }
        
    } catch (error) {
        console.error('💥 Fatal error:', error.message);
        process.exit(1);
    }
}

// Run the script
if (require.main === module) {
    main().catch(error => {
        console.error('💥 Unhandled error:', error);
        process.exit(1);
    });
}

module.exports = {
    updateCategoryFromBreadcrumbs,
    processFile,
    main
};
