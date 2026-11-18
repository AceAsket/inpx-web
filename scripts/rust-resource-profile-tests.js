const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {join} = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {connect, signIn} = require('./rust-events-tests');

const password = 'resource-profile-fixture';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

async function fixture(directory, runtimePath = directory) {
    await fs.mkdir(directory, {recursive:true});
    await fs.writeFile(join(directory,'sample.png'), png);
    await fs.writeFile(join(directory,'djxl'), [
        '#!/bin/sh','set -eu','dir=${0%/*}','echo start >> "$dir/events"',
        'while [ -f "$dir/hold" ]; do /bin/sleep 0.05; done',
        '/bin/cp "$dir/sample.png" "$2"','echo finish >> "$dir/events"','',
    ].join('\n'), {mode:0o755});
    await fs.writeFile(join(directory,'config.json'), JSON.stringify({converterPaths:{djxl:runtimePath+'/djxl'}}));
}

async function verify(base, directory, profile, expected, conversions, switchToUnlimited = false) {
    const client = await connect(base);
    try {
        const identity = await signIn(client, 'admin', password);
        const performance = await client.send('get-admin-performance',identity);
        assert.equal(performance.settings.requested, profile);
        assert.equal(performance.settings.selected, profile);
        assert.equal(performance.settings.limits.images, expected);
        if (conversions !== undefined) assert.equal(performance.settings.limits.conversions, conversions);
        const result = await client.send('bookSearch',{...identity,query:{del:'0',limit:5}});
        const book = result.found.find(b => b.title === 'JXL' || b.title === 'Packaged smoke book');
        assert(book);
        const url = base+'/cover/by-uid?uid='+encodeURIComponent(book._uid);
        // Hold the first wave until all available slots are occupied, even on slow CI hosts.
        const requests = expected === null || switchToUnlimited ? 20 : 6;
        const target = switchToUnlimited ? requests : expected ?? requests;
        const hold = join(directory,'hold');
        await fs.writeFile(hold,'');
        const responses = Promise.all(Array.from({length:requests}, async () => {
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
        console.log(`ok ${switchToUnlimited ? profile+' -> unlimited' : profile}: ${peak} simultaneous cover decoders for ${requests} HTTP requests`);
    } finally { client.close(); }
}

module.exports = {password, fixture, verify};
