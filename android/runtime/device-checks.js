'use strict';

module.exports = async function(dataDir, mount) {
    const fs = require('fs');
    const assert = require('assert/strict');
    const path = require('path');
    const ZipReader = require('./server/core/ZipReader');
    const report = {node: process.version, platform: process.platform, arch: process.arch, checks: [], passed: false};
    try {
        for (const [archive, entry] of [['demo.inpx', 'collection.info'], ['zip-books.zip', '1.fb2'], ['seven-books.7z', '2.fb2']]) {
            const reader = new ZipReader({converterPaths: {sevenZip: path.join(process.env.INPX_ANDROID_NATIVE_DIR, 'lib7zz.so')}});
            try {
                await reader.open(`${mount}/${archive}`);
                const data = await reader.extractToBuf(entry);
                assert.ok(data.length > 0);
                if (entry.endsWith('.fb2')) assert.ok(data.toString().includes('Библиотека работает'));
                report.checks.push({archive, bytes: data.length, passed: true});
            } finally { await reader.close(); }
        }
        const {Worker} = require('worker_threads');
        const result = await new Promise((resolve, reject) => {
            const worker = new Worker("require('worker_threads').parentPort.postMessage(42)", {eval: true});
            worker.once('message', resolve); worker.once('error', reject);
        });
        assert.equal(result, 42); report.checks.push({worker_threads: true, passed: true});
        report.passed = true;
        console.log('Android device checks passed:', JSON.stringify(report));
    } catch (e) {
        report.error = e.stack;
        console.error('Android device checks failed:', e);
        throw e;
    } finally {
        fs.writeFileSync(path.join(dataDir, 'device-checks.json'), JSON.stringify(report, null, 2));
    }
};
