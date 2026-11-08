// Count retained values without serializing large query results a second time.
function sizeOf(value, limit = Infinity, seen = new Set()) {
    if (typeof value === 'string') return 32 + value.length * 2;
    if (!value || typeof value !== 'object') return 16;
    if (seen.has(value)) return 0;
    seen.add(value);
    if (ArrayBuffer.isView(value)) return 64 + sizeOf(value.buffer, limit, seen);
    if (value instanceof ArrayBuffer) return 64 + value.byteLength;
    let bytes = 64;
    if (Array.isArray(value)) {
        for (const item of value) {
            bytes += 8 + sizeOf(item, limit - bytes, seen);
            if (bytes > limit) break;
        }
        return bytes;
    }
    for (const key of Object.keys(value)) {
        bytes += 16 + key.length * 2 + sizeOf(value[key], limit - bytes, seen);
        if (bytes > limit) break;
    }
    return bytes;
}

class MemoryCache extends Map {
    constructor({bytes, entries = 100, ttl = 300000}) {
        if (!Number.isFinite(bytes) || bytes < 0 || bytes > 1024 ** 3) throw new Error('Memory cache budget must be between 0 and 1024 MiB');
        super(); this.limit = bytes; this.entries = entries; this.ttl = ttl;
        this.bytes = 0; this.metadata = new Map();
        // The timer must not keep a cache belonging to a replaced DB alive.
        const reference = new global.WeakRef(this);
        const timer = setInterval(() => {
            const cache = reference.deref();
            if (cache) cache.prune(); else clearInterval(timer);
        }, Math.max(100, Math.min(ttl, 30000)));
        timer.unref?.(); this.timer = timer;
    }
    prune() {for (const [key, info] of this.metadata) if (Date.now() - info.at >= this.ttl) this.delete(key);}
    has(key) {
        if (this.metadata.has(key) && Date.now() - this.metadata.get(key).at >= this.ttl) this.delete(key);
        return super.has(key);
    }
    get(key) {
        if (!this.has(key)) return undefined;
        const value = super.get(key), info = this.metadata.get(key);
        super.delete(key); super.set(key, value); info.at = Date.now();
        return value;
    }
    set(key, value) {
        this.delete(key); this.prune();
        const bytes = sizeOf(value, this.limit) + sizeOf(key);
        if (bytes > this.limit || this.entries <= 0) return this;
        while (this.size && (this.bytes + bytes > this.limit || this.size >= this.entries)) this.delete(this.keys().next().value);
        super.set(key, value); this.metadata.set(key, {at:Date.now(), bytes}); this.bytes += bytes;
        return this;
    }
    delete(key) {this.bytes -= this.metadata.get(key)?.bytes || 0; this.metadata.delete(key); return super.delete(key);}
    clear() {super.clear(); this.metadata.clear(); this.bytes = 0;}
    close() {clearInterval(this.timer); this.clear();}
}
module.exports = {MemoryCache, sizeOf};
