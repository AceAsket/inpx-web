const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {join} = require('node:path');
const {connect, signIn} = require('./rust-events-tests');

const mib = 1024 * 1024;
const password = 'cache-settings-fixture';
const env = {
    INPX_BOOK_CACHE_SIZE: String(3 * mib), INPX_BOOK_CACHE_SIZE_MB: '9',
    INPX_COVER_CACHE_SIZE: '', INPX_COVER_CACHE_SIZE_MB: '2',
    INPX_CACHE_CLEAN_TARGET_RATIO: '0.5', INPX_CACHE_CLEAN_INTERVAL_MINUTES: '33',
    INPX_METRICS_ENABLED: 'true',
};

async function verify(base, data) {
    const client = await connect(base);
    try {
        const identity = await signIn(client, 'admin', password);
        const send = (action, fields) => client.send(action, {...identity, ...fields});
        const config = (await send('get-config')).adminCache;
        assert.equal(config.bookCacheSize, 3 * mib);
        assert.equal(config.coverCacheSize, 2 * mib);
        assert.equal(config.cacheCleanTargetRatio, 0.5);
        assert.equal(config.cacheCleanInterval, 33);
        assert(Number.isFinite(Date.parse(config.cacheCleanNextRunAt)));

        async function checkMetrics(book, cover) {
            const response = await fetch(base + '/metrics');
            assert.equal(response.status, 200);
            const metrics = await response.text();
            for (const [kind, size] of [['book', book], ['cover', cover]])
                assert(metrics.split('\n').includes(`inpx_web_${kind}_cache_limit_bytes ${size}`));
        }
        await checkMetrics(3 * mib, 2 * mib);
        const cache = join(data, 'public-files', 'source-verified-v1', 'book');
        const contents = Buffer.alloc(mib);
        for (let i = 0; i < 4; i++) {
            await fs.writeFile(join(cache, i + '.fb2'), contents);
            await fs.writeFile(join(cache, i + '.reader-cover'), contents);
        }
        const {cleaned} = await send('admin-clean-cache', {kind:'all'});
        for (const [id, max] of [['book', 3 * mib], ['cover', 2 * mib]]) {
            const row = cleaned.find(item => item.id === id);
            assert.equal(row.maxSize, max);
            assert.equal(row.targetSize, max / 2);
            assert(row.removed > 0 && row.after <= row.targetSize);
        }
        assert((await fs.readdir(cache)).length <= 2);

        const changed = await send('update-admin-cache', {cache:{bookCacheSizeMb:5, coverCacheSizeMb:4}});
        assert.equal(changed.cache.coverCacheSize, 4 * mib);
        await checkMetrics(5 * mib, 4 * mib);
        assert.equal(changed.cache.cacheCleanInterval, 33);
        assert(changed.cache.cacheCleanNextRunAt);
        const disabled = await send('update-admin-cache', {cache:{cacheCleanSchedule:''}});
        assert.equal(disabled.cache.cacheCleanNextRunAt, '');
    } finally { client.close(); }
}

module.exports = {env, password, verify};
