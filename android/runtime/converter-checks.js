'use strict';

// Explicit device preflight, requested by instrumentation; never runs on normal startup.
module.exports = async function(dataDir, mount, config) {
    const fs = require('fs-extra');
    const path = require('path');
    const assert = require('assert/strict');
    const ZipReader = require('./server/core/ZipReader');
    const converter = require('./server/core/BookConverter');
    const directory = path.join(dataDir, 'converter-checks');
    const report = {checks: [], passed: false};
    await fs.ensureDir(directory);
    const inputFile = path.join(directory, 'sample.fb2');
    const reader = new ZipReader(config);
    try {
        await reader.open(`${mount}/zip-books.zip`);
        await fs.writeFile(inputFile, await reader.extractToBuf('1.fb2'));
    } finally { await reader.close(); }
    converter.configure({conversionConcurrency: 1, conversionTimeoutMs: 180000});
    for (const format of ['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf', 'mobi']) {
        const started = Date.now();
        const outputFile = path.join(directory, `sample.${converter.getConvertedExtension(format)}`);
        try {
            await converter.convert({inputFile, outputFile, format, sourceFileName: 'sample.fb2', converterPaths: config.converterPaths, mobiEnabled: true, kindlingPath: config.kindlingPath});
            const bytes = await fs.readFile(outputFile);
            assert.ok(bytes.length > 100);
            if (['epub', 'epub3', 'kepub'].includes(format)) {
                const zip = new ZipReader(config);
                try { await zip.open(outputFile); assert.equal((await zip.extractToBuf('mimetype')).toString(), 'application/epub+zip'); }
                finally { await zip.close(); }
            }
            if (format === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
            if (format === 'mobi') await require('./server/core/MobiValidation').validateMobi(outputFile);
            report.checks.push({format, passed: true, bytes: bytes.length, ms: Date.now() - started, signature: bytes.subarray(0, 16).toString('hex')});
        } catch (e) { report.checks.push({format, passed: false, ms: Date.now() - started, error: e.stack}); }
    }
    report.passed = report.checks.every(check => check.passed);
    await fs.writeJson(path.join(dataDir, 'converter-checks.json'), report, {spaces: 2});
    console.log('Android converter checks:', JSON.stringify(report));
};
