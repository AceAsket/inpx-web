const {spawn} = require('node:child_process');
const runtime = require('./ResourceRuntime');
const frameBytes = 128*1024;

class RustFramedProcess {
    constructor(binary, command) {
        this.child = spawn(binary, [command,'.'], {windowsHide:true, stdio:['pipe','pipe','pipe']});
        this.output = this.child.stdout[Symbol.asyncIterator]();
        this.buffer = Buffer.alloc(0);
        let stderr = '';
        this.child.stderr.setEncoding('utf8').on('data', chunk => {stderr = (stderr + chunk).slice(-2048);});
        this.child.once('error', error => {this.failure ||= error;});
        this.child.stdin.on('error', error => {this.failure ||= error;});
        this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
            this.failure ||= new Error(stderr.trim().replace(/^inpx-catalog: /, '') || `Rust worker exited (${signal || code})`);
            resolve();
        }));
    }

    async read(size) {
        if (size === 0) return this.buffer.subarray(0,0);
        if (!this.buffer.length) await this.refill();
        if (this.buffer.length >= size) {
            const bytes = this.buffer.subarray(0,size);
            this.buffer = this.buffer.subarray(size);
            return bytes;
        }
        const bytes = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
            if (!this.buffer.length) await this.refill();
            const length = this.buffer.copy(bytes,offset,0,Math.min(this.buffer.length,size-offset));
            this.buffer = this.buffer.subarray(length);
            offset += length;
        }
        return bytes;
    }

    async refill() {
        const next = await this.output.next();
        if (next.done) throw this.failure || new Error('Неполный ответ процесса Rust');
        this.buffer = next.value;
    }

    async *body() {
        for (;;) {
            const length = (await this.read(4)).readUInt32LE();
            if (!length) return;
            if (length > frameBytes) throw new Error('Слишком большой блок ответа процесса Rust');
            yield await this.read(length);
        }
    }

    async transmit(request, buffers) {
        const header = JSON.stringify(request)+'\n';
        for (const data of [header, ...buffers])
            await new Promise((resolve,reject) => this.child.stdin.write(data, error => error ? reject(error) : resolve()));
    }

    interrupt(error) {
        this.failure ||= error;
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    }

    async request(header, buffers, consume, {signal, timeoutMs = runtime.settings.taskTimeoutMs} = {}) {
        signal?.throwIfAborted();
        const abort = () => this.interrupt(signal.reason || Object.assign(new Error('Запрос к Rust отменён'),{code:'ABORT_ERR'}));
        signal?.addEventListener('abort',abort,{once:true});
        const timer = timeoutMs === null ? undefined : setTimeout(() => this.interrupt(Object.assign(new Error('Истекло время запроса к Rust'),{code:'INPX_RESOURCE_TIMEOUT'})), timeoutMs);
        const sent = this.transmit(header,buffers);
        const received = Promise.resolve().then(() => consume(this.body()));
        let result, status;
        try {
            [result] = await Promise.all([received,sent]);
            const length = (await this.read(4)).readUInt32LE();
            if (length > frameBytes) throw new Error('Некорректный ответ процесса Rust');
            status = JSON.parse((await this.read(length)).toString('utf8'));
            if (status?.error !== null && typeof status?.error !== 'string' ||
                status?.code !== undefined && typeof status.code !== 'string')
                throw new Error('Некорректный ответ процесса Rust');
        } catch (error) {
            this.interrupt(error);
            await Promise.allSettled([sent,received,this.closed]);
            throw this.failure;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort',abort);
        }
        if (status.error !== null) {
            if (Buffer.isBuffer(result)) result.fill(0);
            throw Object.assign(new Error(status.error),status.code ? {code:status.code} : {});
        }
        return result;
    }

    stop() {
        this.child.stdin.end();
        return this.closed;
    }
}

module.exports = RustFramedProcess;
