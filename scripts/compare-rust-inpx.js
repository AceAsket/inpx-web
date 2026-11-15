const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {createInterface} = require('node:readline');
const InpxParser = require('../server/core/InpxParser');

function fingerprint() {
    const hash = createHash('sha256');
    let records = 0;
    return {
        add(record) {
            hash.update(JSON.stringify(record)).update('\n');
            records++;
        },
        finish(info, started) {
            return {info, records, digest:hash.digest('hex'), wallMs:Math.round(performance.now() - started)};
        },
    };
}

async function readNode(indexPath) {
    const started = performance.now();
    const parser = new InpxParser();
    const result = fingerprint();
    await parser.parse(indexPath, null, rows => {
        for (const row of rows) result.add(row);
    });
    return result.finish(parser.info, started);
}

async function readRust(executable, indexPath) {
    const started = performance.now();
    const child = spawn(executable, [indexPath], {windowsHide:true, stdio:['ignore','pipe','pipe']});
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-8192);});
    const finished = new Promise(resolve => {
        child.once('error', error => resolve(error));
        child.once('close', (code, signal) => resolve(code === 0 ? null : new Error(stderr.trim() || `Rust reader exited with ${signal || code}`)));
    });
    const lines = createInterface({input:child.stdout, crlfDelay:Infinity});
    const result = fingerprint();
    let info;
    try {
        for await (const line of lines) {
            const value = JSON.parse(line);
            if (info) result.add(value);
            else {
                assert(value?.info, 'The first Rust output line must contain INPX metadata');
                info = value.info;
            }
        }
        const error = await finished;
        if (error) throw error;
        assert(info, 'Rust reader returned no INPX metadata');
        return result.finish(info, started);
    } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await finished;
    }
}

async function main() {
    const [executable, indexPath] = process.argv.slice(2);
    if (!executable || !indexPath || process.argv.length !== 4)
        throw new Error('Usage: node scripts/compare-rust-inpx.js <reader-binary> <index.inpx>');
    const node = await readNode(indexPath);
    const rust = await readRust(executable, indexPath);
    assert.deepStrictEqual(rust.info, node.info, 'INPX metadata differs');
    assert.strictEqual(rust.records, node.records, 'INPX record count differs');
    assert.strictEqual(rust.digest, node.digest, 'INPX fields, IDs, or record order differ');
    console.log(JSON.stringify({records:rust.records, digest:rust.digest, nodeMs:node.wallMs, rustJsonlMs:rust.wallMs}));
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
