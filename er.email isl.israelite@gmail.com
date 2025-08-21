[33mad1a196[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mmain[m[33m, [m[1;31morigin/main[m[33m, [m[1;31morigin/HEAD[m[33m)[m clean up file management
D	LOCAL_BROWSER_CONFIG.md
A	SCRAPPER_STRUCTURE.md
D	filter_superdrug_progress.js
A	scrapper/input/archived/2025-08-20_superdrugs_input.json
A	scrapper/output/superdrug/superdrugs_input.output.json
R100	vendors/superdrugs/back-up/filtered/filtered_2025-08-19T13-57-50-049Z.json	scrapper/output/superdrug/superdrugs_input.output_0.json
A	scrapper/processing/superdrug_2025-08-20T23-09-58-424Z.json
R065	tools/stagehand_product_extractor.js	stagehand_product_extractor.js
R100	vendors/superdrugs/stagehand_sitemap_extractor.js	stagehand_sitemap_extractor.js
D	tools/fix_output_urls.js
A	tools/remove_urls_from_combined.js
M	tools/strategies/generic.js
D	tools/strategies/index.js
D	tools/test_superdrug_selectors.js
D	tools/test_superdrug_stagehand.js
R100	tools/utils/cacheManager.js	tools/utils/cache/cacheManager.js
A	tools/utils/cache/vendor-selectors.json
M	tools/utils/exclusion.js
A	tools/utils/manager/files/inputManager.js
A	tools/utils/manager/files/outputManager.js
A	tools/utils/manager/files/pendingManager.js
R099	tools/utils/sessionManager.js	tools/utils/manager/sessionManager.js
D	tools/utils/resume.js
D	vendor-selectors.json
R100	vendors/harrods/section-1/extract_harrods_urls.js	vendors/harrods/extract_harrods_urls.js
R100	vendors/harrods/section-1/product-index-1.xml	vendors/harrods/product-index-1.xml
R100	vendors/harrods/section-1/product-index-2.xml	vendors/harrods/product-index-2.xml
R100	vendors/harrods/section-1/product-index-3.xml	vendors/harrods/product-index-3.xml
R100	vendors/harrods/section-1/product-index-4.xml	vendors/harrods/product-index-4.xml
R100	vendors/harrods/section-1/product-index.xml	vendors/harrods/product-index.xml
D	vendors/harrods/product_urls/product-index-2.json
D	vendors/harrods/product_urls/product-index.json
D	vendors/harrods/section-1/product_urls/output/product-index-1.output.json
D	vendors/harrods/section-1/product_urls/product-index-1.json
D	vendors/harrods/section-1/product_urls/product-index-1.processing.json
D	vendors/superdrugs/back-up/combined-urls.output.json
D	vendors/superdrugs/back-up/combined-urls.processing.json
D	vendors/superdrugs/back-up/filtered/filtered_2025-08-19T13-53-57-535Z.json
D	vendors/superdrugs/back-up/filtered/summary_2025-08-19T13-53-57-535Z.txt
D	vendors/superdrugs/back-up/filtered/summary_2025-08-19T13-57-50-049Z.txt
D	vendors/superdrugs/back-up/progress/combined-urls.output__index_2.json
D	vendors/superdrugs/back-up/progress/combined-urls.output_index_1.json
D	vendors/superdrugs/combined-urls.json
D	vendors/superdrugs/combined-urls.processing.json
M	vendors/superdrugs/extract_superdrugs_urls.js
D	vendors/superdrugs/extracted-output/combined-urls.output.json
D	vendors/superdrugs/extracted-output/combined-urls.output.json.tmp
D	vendors/superdrugs/output/combined-urls.json
A	vendors/superdrugs/output/extracted-filtered-source-urls.json
A	vendors/superdrugs/output/marketplace_combined-urls.output.json
A	vendors/superdrugs/output/superdrugs_combined-urls.output.json
[33mfc92da4[m changes
[33m2269080[m changes
M	vendor-selectors.json
M	vendors/superdrugs/combined-urls.processing.json
M	vendors/superdrugs/extracted-output/combined-urls.output.json
[33m8655cb2[m scrapped and filter. result 17k products
M	env.template
A	filter_superdrug_progress.js
A	page_structure.html
M	tools/stagehand_product_extractor.js
M	tools/strategies/generic.js
M	tools/strategies/index.js
A	tools/strategies/superdrug.js
A	tools/test_superdrug_selectors.js
A	tools/test_superdrug_stagehand.js
A	tools/utils/cacheManager.js
M	tools/utils/exclusion.js
M	tools/utils/sessionManager.js
M	vendor-selectors.json
A	vendors/superdrugs/back-up/filtered/filtered_2025-08-19T13-53-57-535Z.json
A	vendors/superdrugs/back-up/filtered/filtered_2025-08-19T13-57-50-049Z.json
A	vendors/superdrugs/back-up/filtered/summary_2025-08-19T13-53-57-535Z.txt
A	vendors/superdrugs/back-up/filtered/summary_2025-08-19T13-57-50-049Z.txt
A	vendors/superdrugs/back-up/progress/combined-urls.output__index_2.json
A	vendors/superdrugs/back-up/progress/combined-urls.output_index_1.json
M	vendors/superdrugs/combined-urls.processing.json
M	vendors/superdrugs/extract_superdrugs_urls.js
M	vendors/superdrugs/extracted-output/combined-urls.output.json
A	vendors/superdrugs/extracted-output/combined-urls.output.json.tmp
A	vendors/superdrugs/output/combined-urls.json
D	vendors/superdrugs/product-sitemap-urls.json
D	vendors/superdrugs/product-sitemap-urls.processing.json
M	vendors/superdrugs/stagehand_sitemap_extractor.js
[33mc651310[m chore: include vendors and output json files
M	.gitignore
M	ai-scrapper/.gitignore
A	vendors/harrods/product_urls/product-index-2.json
A	vendors/harrods/product_urls/product-index.json
A	vendors/harrods/section-1/extract_harrods_urls.js
A	vendors/harrods/section-1/product-index-1.xml
A	vendors/harrods/section-1/product-index-2.xml
A	vendors/harrods/section-1/product-index-3.xml
A	vendors/harrods/section-1/product-index-4.xml
A	vendors/harrods/section-1/product-index.xml
A	vendors/harrods/section-1/product_urls/output/product-index-1.output.json
A	vendors/harrods/section-1/product_urls/product-index-1.json
A	vendors/harrods/section-1/product_urls/product-index-1.processing.json
A	vendors/superdrugs/README.md
A	vendors/superdrugs/back-up/combined-urls.output.json
A	vendors/superdrugs/back-up/combined-urls.processing.json
A	vendors/superdrugs/combined-urls.json
A	vendors/superdrugs/combined-urls.processing.json
A	vendors/superdrugs/extract_superdrugs_urls.js
A	vendors/superdrugs/extracted-output/combined-urls.output.json
A	vendors/superdrugs/product-index-1.xml
A	vendors/superdrugs/product-index-2.xml
A	vendors/superdrugs/product-index-3.xml
A	vendors/superdrugs/product-index-4.xml
A	vendors/superdrugs/product-index-5.xml
A	vendors/superdrugs/product-index-6.xml
A	vendors/superdrugs/product-index-7.xml
A	vendors/superdrugs/product-index-8.xml
A	vendors/superdrugs/product-sitemap-urls.json
A	vendors/superdrugs/product-sitemap-urls.processing.json
A	vendors/superdrugs/stagehand_sitemap_extractor.js
[33mc5a22c9[m chore: initial import
A	.env.example
A	.gitignore
A	LOCAL_BROWSER_CONFIG.md
A	ai-scrapper/.gitignore
A	env.template
A	package-lock.json
A	package.json
A	products.json
A	tools/fix_output_urls.js
A	tools/stagehand_product_extractor.js
A	tools/strategies/generic.js
A	tools/strategies/index.js
A	tools/utils/exclusion.js
A	tools/utils/resume.js
A	tools/utils/sessionManager.js
A	vendor-selectors.json
