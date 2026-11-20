const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {join} = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {connect, signIn, zip} = require('./rust-events-tests');

const password = 'resource-profile-fixture';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

async function library(dir) {
    const ids = Array.from({length:20}, (_, i) => String(i+1));
    const rows = ids.map(id => ['Tester,Smoke:', 'sf:', 'JXL '+id, '', '0', id, '100', id, '0',
        'fb2', '2026-09-14', 'en', '0', ''].join('\x04'));
    await fs.mkdir(join(dir,'covers'),{recursive:true});
    await zip(join(dir,'smoke.inpx'),[['collection.info','Cover probes'],['smoke.inp',rows.join('\n')+'\n']]);
    await zip(join(dir,'smoke.zip'),ids.map(id=>[id+'.fb2','<FictionBook><body/></FictionBook>']));
    const jxl = require('../server/core/benchmarkFixture');
    await zip(join(dir,'covers','smoke.zip'),ids.map(id=>[id,jxl]));
}

async function fixture(directory, runtimePath = directory) {
    await fs.mkdir(directory, {recursive:true});
    await fs.writeFile(join(directory,'sample.png'), png);
    await fs.writeFile(join(directory,'djxl'), [
        '#!/bin/sh','set -eu','test "$3" = "--num_threads=1"','dir=${0%/*}','echo start >> "$dir/events"',
        'while [ -f "$dir/hold" ]; do /bin/sleep 0.05; done',
        '/bin/cp "$dir/sample.png" "$2"','echo finish >> "$dir/events"','',
    ].join('\n'), {mode:0o755});
    await fs.writeFile(join(directory,'config.json'), JSON.stringify({converterPaths:{djxl:runtimePath+'/djxl'}}));
}

async function verify(base, directory, {libraryDir, profile, expected, conversions, switchToUnlimited}) {
    const client = await connect(base);
    try {
        const identity = await signIn(client, 'admin', password);
        const performance = await client.send('get-admin-performance',identity);
        assert.equal(performance.settings.requested, profile);
        assert.equal(performance.settings.selected, profile);
        assert.equal(performance.settings.limits.images, expected);
        if (conversions !== undefined) assert.equal(performance.settings.limits.conversions, conversions);
        const result = await client.send('bookSearch',{...identity,query:{del:'0',limit:20}});
        const urls = result.found.map(book => base+'/cover/by-uid?uid='+encodeURIComponent(book._uid));
        assert.equal(new Set(urls).size,20);
        // Hold the first wave until all available slots are occupied, even on slow CI hosts.
        const requests = expected === null || switchToUnlimited ? 20 : 6;
        const target = switchToUnlimited ? requests : expected ?? requests;
        const hold = join(directory,'hold');
        await fs.writeFile(hold,'');
        const responses = Promise.all(urls.slice(0,requests).map(async url => {
            const response = await fetch(url,{headers:{cookie:client.cookie}});
            assert.equal(response.status,200);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
        }));
        let switched = false;
        try {
            const deadline = Date.now()+15000;
            while (Date.now()<deadline) {
                const lines = await fs.readFile(join(directory,'events'),'utf8').catch(error=>{
                    if (error.code !== 'ENOENT') throw error;
                    return '';
                });
                const started = lines.trim().split('\n').filter(line=>line==='start').length;
                if (switchToUnlimited && started && !switched) {
                    assert.equal(started,expected);
                    const change = await client.send('set-admin-resource-profile',{...identity,profile:'unlimited'});
                    assert.equal(change.success,true,change.error);
                    switched = true;
                }
                if (started>=target) break;
                await Promise.race([delay(50), responses]);
            }
        } finally {
            await fs.unlink(hold);
        }
        await responses;
        const events = (await fs.readFile(join(directory,'events'),'utf8')).trim().split(/\s+/);
        assert.equal(events.length,requests*2);
        let active = 0, peak = 0;
        for (const event of events) {
            active += event === 'start' ? 1 : -1;
            peak = Math.max(peak,active);
        }
        assert.equal(active,0);
        assert.equal(peak,target);
        assert.equal(switched,switchToUnlimited);
        const again = await fetch(urls[0],{headers:{cookie:client.cookie}});
        assert.equal(again.status,200);
        assert.deepEqual(Buffer.from(await again.arrayBuffer()),png);
        assert.equal((await fs.readFile(join(directory,'events'),'utf8')).trim().split(/\s+/).length,events.length,
            'A repeat request must serve the staged cover without invoking djxl again');
        if (switchToUnlimited) {
            const archive = join(libraryDir,'covers','smoke.zip');
            const cached = join(directory,'public-files','source-verified-v1','book');
            const name = (await fs.readdir(cached)).find(file=>file.endsWith('.reader-cover'));
            assert(name);
            await fs.rename(archive,archive+'.offline');
            try {
                await fs.unlink(join(cached,name));
                const offline = await fetch(urls[0],{headers:{cookie:client.cookie}});
                assert.equal(offline.status,200);
                assert.deepEqual(Buffer.from(await offline.arrayBuffer()),png);
                const partial = await fetch(urls[0],{headers:{cookie:client.cookie,range:'bytes=0-7'}});
                assert.equal(partial.status,206);
                assert.deepEqual(Buffer.from(await partial.arrayBuffer()),png.subarray(0,8));
                const head = await fetch(urls[0],{method:'HEAD',headers:{cookie:client.cookie}});
                assert.equal(Number(head.headers.get('content-length')),png.length);
                const etag = offline.headers.get('etag');
                assert(etag);
                const unchanged = await fetch(urls[0],{headers:{cookie:client.cookie,'if-none-match':etag,'cache-control':'max-age=0'}});
                assert.equal(unchanged.status,304);
            } finally {
                await fs.rename(archive+'.offline',archive);
            }
            const image = await fetch(urls[0],{headers:{cookie:client.cookie}});
            assert.equal(image.status,200);
            assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
            const updated = await fs.readFile(join(__dirname,'../client/assets/pwa-icon-192.png'));
            await fs.writeFile(join(directory,'sample.png'),updated);
            const rebuilt = await client.send('admin-rebuild-cover',{...identity,bookUid:result.found[0]._uid});
            assert.equal(rebuilt.rebuilt,true,rebuilt.error);
            const refreshed = await fetch(urls[0],{headers:{cookie:client.cookie}});
            assert.equal(refreshed.status,200);
            assert.deepEqual(Buffer.from(await refreshed.arrayBuffer()),updated);
        }
        console.log(`ok ${switchToUnlimited ? profile+' -> unlimited' : profile}: ${peak} simultaneous cover decoders for ${requests} HTTP requests`);
    } finally { client.close(); }
}

module.exports = {password, library, fixture, verify};
