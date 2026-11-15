const {spawn} = require('node:child_process');
const {join} = require('node:path');
const {createInterface} = require('node:readline');
const runtime = require('./ResourceRuntime');
const {catalogGeneration} = require('./RustShelfIndex');

const fileName = 'lookup.redb';
const maxPending = 16;
const maxRequestBytes = 4 * 1024 * 1024;
const retryMs = 30_000;

function executable() {
    return process.env.INPX_RUST_CATALOG_BINARY;
}

function lookupGeneration(config) {
    return catalogGeneration({...config, indexUpdate:{updatedAt:config?.rustLookupBuiltAt}});
}

class LookupProcess {
    constructor(binary, file, generation, command = 'lookup') {
        this.generation = generation;
        this.pending = new Map();
        this.sequence = 0;
        this.child = spawn(binary, [command, file], {windowsHide:true, stdio:['pipe','pipe','pipe']});
        let stderr = '';
        this.child.stderr.setEncoding('utf8').on('data', data => {stderr = (stderr + data).slice(-2048);});
        this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
            this.fail(new Error(stderr.trim() || `Rust lookup exited (${signal || code})`));
            resolve();
        }));
        this.child.once('error', error => this.fail(error));
        this.child.stdin.on('error', error => this.fail(error));
        this.lines = createInterface({input:this.child.stdout, crlfDelay:Infinity});
        this.lines.on('line', line => this.receive(line));
        this.lines.on('error', error => this.fail(error));
    }

    receive(line) {
        try {
            const {id, result, error} = JSON.parse(line);
            const entry = this.pending.get(id);
            if (!entry) throw new Error('Unexpected Rust lookup response');
            entry.finish(error ? new Error(error) : null, result);
        } catch (error) {this.fail(error);}
    }

    query(request) {
        if (this.failure) throw this.failure;
        const signal = runtime.signal();
        signal?.throwIfAborted();
        const id = ++this.sequence;
        const line = JSON.stringify({...request, id, generation:this.generation}) + '\n';
        if (this.pending.size >= maxPending || Buffer.byteLength(line) > maxRequestBytes)
            throw Object.assign(new Error('Rust lookup capacity exceeded'), {code:'INPX_RUST_LOOKUP_BUSY'});
        return new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            const timer = setTimeout(() => this.fail(new Error('Rust lookup timed out')), runtime.settings.taskTimeoutMs);
            this.pending.set(id, {finish:(error, result) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                this.pending.delete(id);
                if (error) reject(error);
                else resolve(result);
            }});
            signal?.addEventListener('abort', abort, {once:true});
            this.child.stdin.write(line);
        });
    }

    fail(error) {
        if (this.failure) return;
        this.failure = error;
        for (const entry of this.pending.values()) entry.finish(error);
        this.lines?.close();
        this.child.stdin.destroy();
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    }

    close() {
        this.fail(new Error('Rust lookup closed'));
        return this.closed;
    }
}

class RustLookupIndex {
    constructor(dbPath, config, store = null) {
        this.binary = executable();
        this.file = store?.directory || join(dbPath, fileName);
        this.generation = store?.generation ?? lookupGeneration(config);
        this.command = store ? 'store' : 'lookup';
        this.retryAt = 0;
    }

    async run(work, fallback) {
        if (this.binary && this.generation && !this.closed && Date.now() >= this.retryAt) {
            try {
                this.process ||= new LookupProcess(this.binary, this.file, this.generation, this.command);
                return await work(this.process);
            } catch (error) {
                runtime.signal()?.throwIfAborted();
                if (error.code !== 'INPX_RUST_LOOKUP_BUSY') {
                    this.lastError = error.message;
                    this.retryAt = Date.now() + retryMs;
                    const failed = this.process;
                    await failed?.close();
                    if (this.process === failed) this.process = null;
                }
            }
        }
        return fallback();
    }

    close() {
        this.closed = true;
        return this.process?.close();
    }
}

module.exports = {RustLookupIndex, executable, fileName, lookupGeneration};
