const {spawn} = require('node:child_process');
const {resolve} = require('node:path');
const {createInterface} = require('node:readline');

async function readInventory(binary, root, signal) {
    signal?.throwIfAborted();
    const child = spawn(binary, ['folder-inventory', resolve(root)], {
        windowsHide:true, stdio:['ignore','pipe','pipe'], signal,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', data => {stderr = (stderr + data).slice(-2048);});
    const done = new Promise(resolve => {
        let failure;
        child.once('error', error => {failure = error;});
        child.once('close', (code, signalCode) => resolve(failure || (code === 0 ? null :
            new Error(stderr.trim() || `Rust folder inventory exited (${signalCode || code})`))));
    });
    const lines = createInterface({input:child.stdout, crlfDelay:Infinity});
    const files = [];
    try {
        for await (const line of lines) {
            signal?.throwIfAborted();
            const batch = JSON.parse(line);
            if (!Array.isArray(batch) || batch.length > 512)
                throw new Error('Invalid Rust folder inventory batch');
            files.push(...batch);
        }
        const error = await done;
        signal?.throwIfAborted();
        if (error) throw error;
        return files;
    } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await done;
    }
}

module.exports = {readInventory};
