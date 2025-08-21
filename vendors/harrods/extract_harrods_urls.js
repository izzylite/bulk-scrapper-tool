#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseCliArgs(argv) {
	const args = { input: '', output: '', dir: '' };
	for (let i = 2; i < argv.length; i++) {
		const token = argv[i];
		if (!token) continue;
		if (token === '--dir' || token === '-d') {
			args.dir = argv[i + 1] || '';
			i++;
			continue;
		}
		if (token.startsWith('--dir=')) {
			args.dir = token.slice('--dir='.length);
			continue;
		}
		if (token === '--in' || token === '-i') {
			args.input = argv[i + 1] || '';
			i++;
			continue;
		}
		if (token.startsWith('--in=')) {
			args.input = token.slice('--in='.length);
			continue;
		}
		if (token === '--out' || token === '-o') {
			args.output = argv[i + 1] || '';
			i++;
			continue;
		}
		if (token.startsWith('--out=')) {
			args.output = token.slice('--out='.length);
			continue;
		}
		// Allow simple positional usage: node script.js ./dir
		if (!args.dir && !token.startsWith('-')) { args.dir = token; continue; }
	}
	return args;
}

function ensureReadableFile(filePath) {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) throw new Error('Not a file');
		return true;
	} catch {
		return false;
	}
}

function ensureReadableDirectory(dirPath) {
	try {
		const stat = fs.statSync(dirPath);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

// Regex that matches Harrods product URLs in both compact text and XML contexts.
// Examples:
// - https://www.harrods.com/en-gb/p/dior-backstage-rosy-glow-stick-000000000007796111
// - <loc>https://www.harrods.com/en-gb/p/.../</loc>
const PRODUCT_URL_REGEX = /https?:\/\/(?:www\.)?harrods\.com\/en-gb\/p\/[\w\-/%?=&.#,:+()]+/gi;

async function extractProductUrlsStreaming(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
		const absoluteInputPath = path.resolve(inputPath);
		const absoluteOutputPath = path.resolve(outputPath);

		const readStream = fs.createReadStream(absoluteInputPath, {
			encoding: 'utf8',
			highWaterMark: 1 << 20 // 1 MiB chunks to handle very large single-line files
		});

        const outputDir = path.dirname(absoluteOutputPath);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

		let carryover = '';
        const seen = new Set();
        const urls = [];
        let matchCount = 0;

		function emitMatches(buffer) {
			let m;
			PRODUCT_URL_REGEX.lastIndex = 0;
            while ((m = PRODUCT_URL_REGEX.exec(buffer)) !== null) {
                const url = m[0];
                if (!seen.has(url)) {
                    seen.add(url);
                    urls.push(url);
                    matchCount++;
                }
            }
		}

		readStream.on('data', chunk => {
			const text = carryover + chunk;
			// Keep a tail to prevent splitting URLs between chunks
			// Tail length chosen to be longer than any reasonable URL length (~8KB)
			const tailLength = 8192;
			const scanLength = Math.max(0, text.length - tailLength);
			const head = text.slice(0, scanLength);
			carryover = text.slice(scanLength);
			emitMatches(head);
		});

        readStream.on('end', () => {
            if (carryover) emitMatches(carryover);
            try {
                const json = { total_count: urls.length, urls };
                fs.writeFileSync(absoluteOutputPath, JSON.stringify(json, null, 2), 'utf8');
                resolve({ count: matchCount, unique: seen.size });
            } catch (err) {
                reject(err);
            }
        });

        readStream.on('error', err => reject(err));
	});
}

async function main() {
	const args = parseCliArgs(process.argv);

	// If a specific file is provided, process only that file for backward compatibility
	if (args.input) {
		const resolvedInput = path.resolve(args.input);
		const inputDir = path.dirname(resolvedInput);
		const inputBase = path.basename(resolvedInput, path.extname(resolvedInput));
		const outputDir = path.join(inputDir, 'product_urls');
		const outputPath = path.join(outputDir, `${inputBase}.json`);

		if (!ensureReadableFile(resolvedInput)) {
			console.error(`Input file not found or unreadable: ${resolvedInput}`);
			process.exit(1);
		}

		const start = Date.now();
		try {
			const { count, unique } = await extractProductUrlsStreaming(resolvedInput, outputPath);
			const ms = Date.now() - start;
			console.log(`Extracted ${unique} unique product URLs (${count} matches) in ${ms}ms`);
			console.log(`Saved -> ${path.resolve(outputPath)}`);
		} catch (err) {
			console.error('Extraction failed:', err && err.message ? err.message : err);
			process.exit(1);
		}
		return;
	}

	const dirPath = path.resolve(args.dir || process.cwd());
	if (!ensureReadableDirectory(dirPath)) {
		console.error(`Directory not found or unreadable: ${dirPath}`);
		process.exit(1);
	}

	const entries = fs.readdirSync(dirPath, { withFileTypes: true });
	const xmlFiles = entries
		.filter(d => d.isFile() && d.name.toLowerCase().endsWith('.xml'))
		.map(d => path.join(dirPath, d.name));

	if (xmlFiles.length === 0) {
		console.error(`No .xml files found in directory: ${dirPath}`);
		process.exit(1);
	}

	let totalProcessed = 0;
	for (const xmlPath of xmlFiles) {
		const inputBase = path.basename(xmlPath, path.extname(xmlPath));
		const outputDir = path.join(path.dirname(xmlPath), 'product_urls');
		const outputPath = path.join(outputDir, `${inputBase}.json`);
		const start = Date.now();
		try {
			const { count, unique } = await extractProductUrlsStreaming(xmlPath, outputPath);
			const ms = Date.now() - start;
			console.log(`[${inputBase}] Extracted ${unique} unique URLs (${count} matches) in ${ms}ms`);
			console.log(`[${inputBase}] Saved -> ${path.resolve(outputPath)}`);
			totalProcessed++;
		} catch (err) {
			console.error(`[${inputBase}] Extraction failed:`, err && err.message ? err.message : err);
		}
	}

	console.log(`Completed: ${totalProcessed}/${xmlFiles.length} XML files processed in ${dirPath}`);

}

if (require.main === module) {
	main();
}


