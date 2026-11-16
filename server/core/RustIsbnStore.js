const {resolve} = require('node:path');
const RustWorkerPool = require('./RustWorkerPool');
const {executable} = require('./RustLookupIndex');

const workers = new RustWorkerPool('isbn-store',1,5000);

class RustIsbnStore {
    constructor(binary,file) {
        this.binary = binary;
        this.file = resolve(file);
    }

    request(header,buffers = []) {
        const consume = async stream=>{
            const chunks = [];
            let size = 0;
            for await (const chunk of stream) {
                size += chunk.length;
                if (size > 32*1024*1024) throw new Error('Слишком большой ответ индекса ISBN');
                chunks.push(chunk);
            }
            if (size) return JSON.parse(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks,size));
        };
        return workers.run(this.binary,{file:this.file,...header},consume,{buffers});
    }

    load() {return this.request({op:'load'});}

    save(state,reset) {
        const bytes = Buffer.from(JSON.stringify(state));
        return this.request({op:'save',bytes:bytes.length,reset},[bytes]);
    }

    select(state,value) {
        return this.request({op:'select',signature:state.signature,revision:state.revision,value});
    }

    release() {
        if (!workers.binaries.has(this.binary)) return;
        return this.request({op:'release'});
    }
}

function open(file) {
    const binary = executable();
    return binary ? new RustIsbnStore(binary,file) : null;
}

module.exports = {open};
