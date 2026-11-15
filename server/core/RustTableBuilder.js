const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const TableIndex = require('jembadb/src/TableIndex');
const compareIndexKeys = new Intl.Collator('en').compare;

class RustTableBuilder {
    static async open(binary, directory, command) {
        const writer = new RustTableBuilder(binary, directory, command);
        try {
            const ready = await Promise.race([writer.ready, writer.done.then(error => {
                throw error || new Error('Rust table writer exited before opening the table');
            })]);
            if (ready !== 'ready') throw new Error('Invalid Rust table writer handshake');
            return writer;
        } catch (error) {
            await writer.close();
            throw error;
        }
    }

    static async buildIndex(binary, directory, rows, report, type = 'string') {
        const writer = await this.open(binary, directory, type === 'number' ? 'build-number-index' : 'build-index');
        const index = new TableIndex({type, depth:1000000, unique:true});
        if (type === 'string') index.cmp = compareIndexKeys;
        const chunkSize = 10000;
        try {
            for (let offset = 0; offset < rows.length; offset += chunkSize) {
                const frames = [];
                for (const row of rows.slice(offset, offset + chunkSize)) {
                    const key = index.add(row.value, row.id);
                    frames.push(JSON.stringify([row.id, key, row]) + '\n');
                }
                await writer.append(frames);
                report({progress:Math.min(1, (offset + chunkSize) / rows.length)});
            }
            await writer.finish(rows.length, index.sorted);
        } finally {
            await writer.close();
        }
    }

    constructor(binary, directory, command) {
        this.child = spawn(binary, [command, directory], {windowsHide:true, stdio:['pipe','pipe','pipe']});
        this.lines = createInterface({input:this.child.stdout, crlfDelay:Infinity});
        let stderr = '';
        this.child.stderr.setEncoding('utf8').on('data', data => {stderr = (stderr + data).slice(-2048);});
        this.child.stdin.on('error', () => {});
        this.ready = new Promise(resolve => this.lines.once('line', resolve));
        this.done = new Promise(resolve => {
            this.child.once('error', resolve);
            this.child.once('close', (code, signal) => resolve(code === 0 ? null :
                new Error(stderr.trim() || `Rust table writer exited (${signal || code})`)));
        });
    }

    async append(rows) {
        await this.waitForWrite();
        // While this block drains, the producer can prepare one more. The
        // next append waits, so backpressure bounds the queue to one block.
        this.writing = new Promise(resolve =>
            this.child.stdin.write(rows.join(''), error => resolve(error ?? null)));
    }

    async waitForWrite() {
        const error = await this.writing;
        if (error) throw error;
    }

    async finish(count, sorted) {
        await this.waitForWrite();
        this.child.stdin.end(`finish ${count}\n` + (sorted ? JSON.stringify(sorted) + '\n' : ''));
        const error = await this.done;
        if (error) throw error;
    }

    async close() {
        this.lines.close();
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
        await this.done;
    }
}

module.exports = RustTableBuilder;
