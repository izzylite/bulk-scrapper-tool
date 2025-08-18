#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

function parseArgs(argv) {
    const args = { input: '', output: '', limit: 0, directory: '', combined: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a) continue;
        if (a === '--input' || a === '-i') {
            args.input = argv[i + 1] || '';
            i++;
            continue;
        }
        if (a.startsWith('--input=')) {
            args.input = a.slice('--input='.length);
            continue;
        }
        if (a === '--directory' || a === '-d') {
            args.directory = argv[i + 1] || '';
            i++;
            continue;
        }
        if (a.startsWith('--directory=')) {
            args.directory = a.slice('--directory='.length);
            continue;
        }
        if (a === '--output' || a === '-o') {
            args.output = argv[i + 1] || '';
            i++;
            continue;
        }
        if (a.startsWith('--output=')) {
            args.output = a.slice('--output='.length);
            continue;
        }
        if (a === '--limit' || a === '-l') {
            const n = parseInt(argv[i + 1], 10);
            if (!Number.isNaN(n) && n > 0) args.limit = n;
            i++;
            continue;
        }
        if (a.startsWith('--limit=')) {
            const n = parseInt(a.slice('--limit='.length), 10);
            if (!Number.isNaN(n) && n > 0) args.limit = n;
            continue;
        }
        if (a === '--combined' || a === '-c') {
            args.combined = true;
            continue;
        }
        if (!args.input && !args.directory && !a.startsWith('-')) {
            args.input = a;
            continue;
        }
    }
    return args;
}

function extractUrlsAndImages(xmlContent) {
    // First, let's try to clean up the XML content and check its validity
    console.log('XML content length:', xmlContent.length);
    console.log('First 500 chars:', xmlContent.substring(0, 500));
    
    // Use a simpler regex-based approach for large XML files
    const extracted = [];
    
    // Split into URL blocks
    const urlBlocks = xmlContent.split('<url>').slice(1); // Skip the first empty part
    console.log(`Found ${urlBlocks.length} URL blocks`);
    
    for (let i = 0; i < urlBlocks.length; i++) {
        const block = urlBlocks[i];
        
        // Extract URL
        const locMatch = block.match(/<loc>(.*?)<\/loc>/);
        if (!locMatch) continue;
        
        const url = locMatch[1].trim();
        
        // Extract image URL
        const imageMatch = block.match(/<image:loc>(.*?)<\/image:loc>/);
        const imageUrl = imageMatch ? imageMatch[1].trim() : null;
        
        // Extract other metadata
        const lastmodMatch = block.match(/<lastmod>(.*?)<\/lastmod>/);
        const changefreqMatch = block.match(/<changefreq>(.*?)<\/changefreq>/);
        const priorityMatch = block.match(/<priority>(.*?)<\/priority>/);
        
        const item = {
            url: url,
            image_url: imageUrl,
            lastmod: lastmodMatch ? lastmodMatch[1].trim() : null,
            changefreq: changefreqMatch ? changefreqMatch[1].trim() : null,
            priority: priorityMatch ? priorityMatch[1].trim() : null
        };
        
        extracted.push(item);
        
        // Log progress for every 10000 items
        if ((i + 1) % 10000 === 0) {
            console.log(`Processed ${i + 1} URL blocks...`);
        }
    }
    
    return extracted;
}

function findXmlFiles(directory) {
    const files = fs.readdirSync(directory);
    return files
        .filter(file => file.toLowerCase().endsWith('.xml'))
        .map(file => path.join(directory, file))
        .sort();
}

function processXmlFile(filePath, limit) {
    console.log(`\n=== Processing: ${path.basename(filePath)} ===`);
    console.log(`Reading XML file: ${filePath}`);
    
    const xmlContent = fs.readFileSync(filePath, 'utf8');
    console.log('Parsing XML and extracting URLs and images...');
    
    const extracted = extractUrlsAndImages(xmlContent);
    
    let finalData = extracted;
    if (limit > 0 && extracted.length > limit) {
        finalData = extracted.slice(0, limit);
        console.log(`Limited output to first ${limit} items (out of ${extracted.length} total)`);
    } else {
        console.log(`Extracted ${extracted.length} URL entries`);
    }
    
    return finalData;
}

function processDirectory(directoryPath, outputPath, limit, combined) {
    console.log(`Processing all XML files in directory: ${directoryPath}`);
    
    const xmlFiles = findXmlFiles(directoryPath);
    if (xmlFiles.length === 0) {
        console.log('No XML files found in the specified directory.');
        return;
    }
    
    // Create output directory
    const outputDir = outputPath || path.join(directoryPath, 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }
    
    console.log(`Found ${xmlFiles.length} XML files:`);
    xmlFiles.forEach((file, idx) => {
        console.log(`${idx + 1}. ${path.basename(file)}`);
    });
    
    if (combined) {
        // Combined output: process all files and merge results
        let allExtracted = [];
        let totalWithImages = 0;
        
        for (const xmlFile of xmlFiles) {
            const extracted = processXmlFile(xmlFile, 0); // No limit per file when combining
            allExtracted = allExtracted.concat(extracted);
            totalWithImages += extracted.filter(item => item.image_url).length;
        }
        
        // Apply global limit if specified
        let finalData = allExtracted;
        if (limit > 0 && allExtracted.length > limit) {
            finalData = allExtracted.slice(0, limit);
            console.log(`\nApplied global limit: ${limit} items (out of ${allExtracted.length} total)`);
        }
        
        // Determine output path for combined file
        const combinedOutputPath = path.join(outputDir, 'combined-urls.json');
        
        // Create simplified data and output object
        const simplifiedData = finalData.map(item => ({
            url: item.url,
            image_url: item.image_url
        }));
        
        const outputData = {
            total_count: finalData.length,
            source_files: xmlFiles.map(f => path.basename(f)),
            items: simplifiedData
        };
        
        fs.writeFileSync(combinedOutputPath, JSON.stringify(outputData, null, 2), 'utf8');
        console.log(`\n=== COMBINED RESULTS ===`);
        console.log(`Combined data saved to: ${combinedOutputPath}`);
        console.log(`- Total URLs: ${finalData.length}`);
        console.log(`- URLs with images: ${finalData.filter(item => item.image_url).length}`);
        console.log(`- Source files: ${xmlFiles.length}`);
        
    } else {
        // Separate output: process each file individually
        const results = [];
        
        for (const xmlFile of xmlFiles) {
            const extracted = processXmlFile(xmlFile, limit);
            
            // Generate output path for this file
            const inputName = path.basename(xmlFile, path.extname(xmlFile));
            const fileOutputPath = path.join(outputDir, `${inputName}.json`);
            
            // Create simplified data and output object
            const simplifiedData = extracted.map(item => ({
                url: item.url,
                image_url: item.image_url
            }));
            
            const outputData = {
                total_count: extracted.length,
                source_file: path.basename(xmlFile),
                items: simplifiedData
            };
            
            fs.writeFileSync(fileOutputPath, JSON.stringify(outputData, null, 2), 'utf8');
            console.log(`Data saved to: ${fileOutputPath}`);
            
            const withImages = extracted.filter(item => item.image_url).length;
            results.push({
                file: path.basename(xmlFile),
                totalUrls: extracted.length,
                withImages: withImages,
                outputPath: fileOutputPath
            });
        }
        
        // Print summary
        console.log(`\n=== SUMMARY ===`);
        console.log(`Processed ${xmlFiles.length} XML files:`);
        let grandTotal = 0;
        let grandTotalWithImages = 0;
        
        results.forEach((result, idx) => {
            console.log(`${idx + 1}. ${result.file}:`);
            console.log(`   - URLs: ${result.totalUrls}`);
            console.log(`   - With images: ${result.withImages}`);
            console.log(`   - Output: ${path.basename(result.outputPath)}`);
            grandTotal += result.totalUrls;
            grandTotalWithImages += result.withImages;
        });
        
        console.log(`\nGrand Total:`);
        console.log(`- URLs: ${grandTotal}`);
        console.log(`- With images: ${grandTotalWithImages}`);
    }
}

function main() {
    const { input, directory, output, limit, combined } = parseArgs(process.argv);
    
    // Validate arguments
    if (!input && !directory) {
        console.error('Either input file or directory is required.');
        console.error('');
        console.error('Usage:');
        console.error('  Single file: node extract_superdrugs_urls.js --input product-index-1.xml [--output output.json] [--limit 1000]');
        console.error('  Directory:   node extract_superdrugs_urls.js --directory /path/to/xml/files [--output output.json] [--limit 1000] [--combined]');
        console.error('');
        console.error('Options:');
        console.error('  -i, --input FILE      Process a single XML file');
        console.error('  -d, --directory DIR   Process all XML files in directory');
        console.error('  -o, --output FILE     Output file/directory path (defaults to ./output/)');
        console.error('  -l, --limit NUMBER    Limit number of URLs to extract');
        console.error('  -c, --combined        Combine all directory results into single file');
        console.error('');
        console.error('Note: Output files are saved in ./output/ directory by default.');
        console.error('');
        console.error('Examples:');
        console.error('  node extract_superdrugs_urls.js --input product-index-1.xml');
        console.error('  node extract_superdrugs_urls.js --directory . --combined');
        console.error('  node extract_superdrugs_urls.js --directory . --limit 5000');
        process.exit(1);
    }
    
    if (input && directory) {
        console.error('Cannot specify both --input and --directory. Choose one.');
        process.exit(1);
    }
    
    if (directory) {
        // Directory processing mode
        const directoryPath = path.resolve(directory);
        if (!fs.existsSync(directoryPath)) {
            console.error(`Directory does not exist: ${directoryPath}`);
            process.exit(1);
        }
        
        if (!fs.statSync(directoryPath).isDirectory()) {
            console.error(`Path is not a directory: ${directoryPath}`);
            process.exit(1);
        }
        
        processDirectory(directoryPath, output, limit, combined);
    } else {
        // Single file processing mode (original functionality)
        const inputPath = path.resolve(input);
        if (!fs.existsSync(inputPath)) {
            console.error(`Input file does not exist: ${inputPath}`);
            process.exit(1);
        }
        
        console.log(`Reading XML file: ${inputPath}`);
        const xmlContent = fs.readFileSync(inputPath, 'utf8');
        
        console.log('Parsing XML and extracting URLs and images...');
        const extracted = extractUrlsAndImages(xmlContent);
        
        let finalData = extracted;
        if (limit > 0 && extracted.length > limit) {
            finalData = extracted.slice(0, limit);
            console.log(`Limited output to first ${limit} items (out of ${extracted.length} total)`);
        } else {
            console.log(`Extracted ${extracted.length} URL entries`);
        }
        
        // Determine output path
        let outputPath;
        if (output) {
            outputPath = path.resolve(output);
        } else {
            const inputDir = path.dirname(inputPath);
            const outputDir = path.join(inputDir, 'output');
            
            // Create output directory if it doesn't exist
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
                console.log(`Created output directory: ${outputDir}`);
            }
            
            const inputName = path.basename(inputPath, path.extname(inputPath));
            outputPath = path.join(outputDir, `${inputName}.json`);
        }
        
        // Create simple format with url and image_url only
        const simplifiedData = finalData.map(item => ({
            url: item.url,
            image_url: item.image_url
        }));
        
        // Create output object with total_count
        const outputData = {
            total_count: finalData.length,
            source_file: path.basename(inputPath),
            items: simplifiedData
        };
        
        // Write the data with total_count
        fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf8');
        console.log(`URL and image data saved to: ${outputPath}`);
        
        // Log some statistics
        const withImages = finalData.filter(item => item.image_url).length;
        console.log(`\nStatistics:`);
        console.log(`- Total URLs: ${finalData.length}`);
        console.log(`- URLs with images: ${withImages}`);
        console.log(`- URLs without images: ${finalData.length - withImages}`);
        
        if (finalData.length > 0) {
            console.log(`\nFirst few URLs:`);
            finalData.slice(0, 3).forEach((item, idx) => {
                console.log(`${idx + 1}. ${item.url}`);
                if (item.image_url) {
                    console.log(`   Image: ${item.image_url}`);
                }
            });
        }
    }
}

if (require.main === module) {
    main();
}

module.exports = { 
    extractUrlsAndImages, 
    findXmlFiles, 
    processXmlFile, 
    processDirectory 
};
