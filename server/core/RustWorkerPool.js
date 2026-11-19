const RustFramedProcess = require('./RustFramedProcess');

class RustWorkerPool {
    constructor(command, slots = 2, idleMs = 1000) {
        this.command = command;
        this.slots = slots;
        this.idleMs = idleMs;
        this.binaries = new Map();
    }

    entry(binary) {
        if (!this.binaries.has(binary)) {
            const workers = Array.from({length:this.slots},()=>({pending:0,queue:Promise.resolve()}));
            this.binaries.set(binary,{binary,workers});
        }
        return this.binaries.get(binary);
    }

    async stop(entry) {
        clearTimeout(entry.idle);
        if (this.binaries.get(entry.binary)===entry) this.binaries.delete(entry.binary);
        await Promise.all(entry.workers.map(async worker=>{
            await worker.queue;
            await worker.process?.stop();
        }));
    }

    start(binary,{lazy = false} = {}) {
        const entry = this.entry(binary);
        entry.held = true;
        clearTimeout(entry.idle);
        if (!lazy) entry.workers[0].process ||= new RustFramedProcess(binary,this.command);
        return ()=>this.stop(entry);
    }

    async run(binary, request, consume, {signal,timeoutMs,onFailure,buffers = []} = {}) {
        const entry = this.entry(binary);
        clearTimeout(entry.idle);
        const worker = entry.workers.reduce((best,candidate)=>candidate.pending < best.pending
            || candidate.pending === best.pending && request.source && candidate.source === request.source ? candidate : best);
        worker.source = request.source;
        worker.pending++;
        const operation = worker.queue.then(async()=>{
            signal?.throwIfAborted();
            if (!worker.process || worker.process.failure) worker.process = new RustFramedProcess(binary,this.command);
            try {return await worker.process.request(request,buffers,consume,{signal,timeoutMs});}
            catch (error) {
                if (worker.process.failure) await onFailure?.();
                throw error;
            }
        });
        worker.queue = operation.catch(()=>{});
        try {return await operation;}
        finally {
            worker.pending--;
            if (!entry.held && !entry.workers.some(worker=>worker.pending) && this.binaries.get(binary)===entry)
                entry.idle = setTimeout(()=>{void this.stop(entry);},this.idleMs);
        }
    }
}

module.exports = RustWorkerPool;
