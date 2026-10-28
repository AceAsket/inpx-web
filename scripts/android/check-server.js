'use strict';

const assert = require('assert/strict');
const WebSocket = require('ws');
const fs = require('fs');
async function check(base, expectedSource = '', converters = false) {
    const report = {url: base, checks: [], books: [], passed: false};
    let socket;
    try {
        let ready;
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            try { const r = await fetch(base + '/ready', {signal: AbortSignal.timeout(1500)}); ready = await r.json(); if (r.ok && ready.ready) break; } catch {}
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.equal(ready?.ready, true, 'Server index must become ready');
        report.checks.push({name: 'ready', passed: true, records: ready.recsLoaded});
        const index = await fetch(base + '/'); assert.equal(index.status, 200); assert.match(await index.text(), /<html/i);
        report.checks.push({name: 'web-interface', passed: true});
        socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        let counter = 0;
        const perform = data => new Promise((resolve, reject) => {
            const requestId = ++counter;
            const timer = setTimeout(() => finish(new Error('WebSocket timeout')), 20000);
            const listener = raw => {
                const value = JSON.parse(raw);
                if (value.requestId !== requestId || value._rok) return;
                finish(value.error ? new Error(value.error) : null, value);
            };
            const finish = (error, result) => { clearTimeout(timer); socket.off('message', listener); error ? reject(error) : resolve(result); };
            socket.on('message', listener); socket.send(JSON.stringify({...data, requestId}));
        });
        const request = async data => {
            for (let attempt = 0; ; attempt++) {
                try { return await perform(data); }
                catch (e) { if (e.message !== 'server_busy' || attempt >= 30) throw e; await new Promise(resolve => setTimeout(resolve, 300)); }
            }
        };
        const config = await request({action: 'get-config'});
        report.checks.push({name: 'websocket-config', passed: true, version: config.version});
        if (converters) {
            assert.equal(config.conversionEnabled, true);
            assert.deepEqual([...config.conversionFormats].sort(), ['azw8', 'epub', 'epub3', 'kepub', 'kfx', 'mobi', 'pdf']);
            report.conversions = [];
        }
        const found = await request({action: 'bookSearch', query: {title: 'Проверка', limit: 20, offset: 0}});
        const books = found.found;
        assert.ok(Array.isArray(books) && books.length >= 2, JSON.stringify(found));
        for (const book of books) {
            if (expectedSource) assert.equal(book.sourceId, expectedSource, 'Search must use the selected source, not a previous index');
            const value = await request({action: 'get-book-link', bookUid: book._uid});
            assert.ok(value.link, JSON.stringify(value));
            const downloaded = await fetch(new URL(value.link, base)); assert.equal(downloaded.status, 200);
            const bytes = Buffer.from(await downloaded.arrayBuffer());
            assert.match(bytes.toString(), /Библиотека работает/);
            report.books.push({title: book.title, sourceId: book.sourceId, bytes: bytes.length, passed: true});
            if (converters) for (const format of config.conversionFormats) {
                const started = Date.now();
                const response = await fetch(new URL(`${value.link}/${format}`, base), {signal: AbortSignal.timeout(180000)});
                const output = Buffer.from(await response.arrayBuffer());
                assert.equal(response.status, 200, output.toString().slice(0, 500));
                assert.ok(output.length > 100);
                if (['epub', 'epub3', 'kepub'].includes(format)) assert.equal(output.subarray(0, 2).toString(), 'PK');
                if (['kfx', 'azw8'].includes(format)) assert.equal(output.subarray(0, 4).toString(), 'CONT');
                if (format === 'mobi') assert.equal(output.subarray(60, 68).toString(), 'BOOKMOBI');
                if (format === 'pdf') assert.equal(output.subarray(0, 5).toString(), '%PDF-');
                report.conversions.push({title: book.title, format, bytes: output.length, ms: Date.now() - started, passed: true});
            }
        }
        report.passed = true;
        return report;
    } finally { if (socket) socket.terminate(); }
}
module.exports = check;
if (require.main === module) check(process.argv[2] || 'http://127.0.0.1:22380', process.argv[4], process.argv.includes('--converters')).then(report => {
    if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; });
