const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const InpxParser = require('./InpxParser');

const infoFiles = ['collection.info', 'structure.info', 'version.info'];

async function parse(binary, file, onFile, onBooks) {
    const child = spawn(binary, ['--stream', file], {windowsHide:true, stdio:['ignore','pipe','pipe']});
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', data => {stderr = (stderr + data).slice(-2048);});
    const done = new Promise(resolve => {
        child.once('error', resolve);
        child.once('close', (code, signal) => resolve(code === 0 ? null :
            new Error(stderr.trim() || `Rust INPX reader exited (${signal || code})`)));
    });
    const lines = createInterface({input:child.stdout, crlfDelay:Infinity});
    let metadata, totalFiles, current = 0, batch = [];
    try {
        for await (const line of lines) {
            const frame = JSON.parse(line);
            if (!metadata) {
                if (!Array.isArray(frame.info?.recStruct) || !Number.isSafeInteger(frame.totalFiles) || frame.totalFiles < 3)
                    throw new Error('Invalid Rust INPX header');
                metadata = frame.info;
                totalFiles = frame.totalFiles;
                await onFile({totalFiles});
                for (const fileName of infoFiles) await onFile({fileName, current:++current});
            } else if (typeof frame.file === 'string') {
                await onFile({fileName:frame.file, current:++current});
            } else if (Array.isArray(frame.records) && frame.records.length > 0 && frame.records.length <= 512) {
                const remaining = 10000 - batch.length;
                batch.push(...frame.records.slice(0, remaining));
                if (batch.length === 10000) {
                    await onBooks(batch);
                    batch = frame.records.slice(remaining);
                }
            } else {
                throw new Error('Invalid Rust INPX frame');
            }
        }
        const error = await done;
        if (error) throw error;
        if (!metadata || current !== totalFiles) throw new Error('Incomplete Rust INPX stream');
        if (batch.length) await onBooks(batch);
        return metadata;
    } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await done;
    }
}

class RustInpxParser {
    constructor(binary) {
        this.binary = binary;
    }

    async parse(file, onFile, onBooks) {
        let beganImport = false;
        try {
            this.info = await parse(this.binary, file, onFile, async books => {
                beganImport = true;
                await onBooks(books);
            });
            this.usedRust = true;
        } catch (error) {
            if (beganImport) throw error;
            const fallback = new InpxParser();
            await fallback.parse(file, onFile, onBooks);
            this.info = fallback.info;
        }
    }
}

module.exports = RustInpxParser;
