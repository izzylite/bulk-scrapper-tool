# Process all XML files in current directory (separate outputs)
node extract_superdrugs_urls.js --directory .

# Process all XML files and combine into single file
node extract_superdrugs_urls.js --directory . --combined

# Process with limit (100 URLs per file, or 100 total if combined)
node extract_superdrugs_urls.js --directory . --limit 100

# Still works with single files (backward compatible)
node extract_superdrugs_urls.js --input product-index-1.xml

cd G:/Projects/ai-scrapper/vendors/superdrugs && node extract_superdrugs_urls.js --directory . --combined