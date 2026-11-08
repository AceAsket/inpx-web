// Request-scoped observers share real work counters, never a clock-based estimate.
class LoadProgress {
    constructor(intervalMs = 200) {
        this.steps = new Map(); this.listeners = new Set(); this.intervalMs = intervalMs; this.sentAt = 0;
    }
    snapshot() {return {steps:[...this.steps.values()].map(step => ({...step}))};}
    update(id, patch) {
        if (this.closed) return;
        const previous = this.steps.get(id) || {id,phase:'Подготовка',done:0,total:null,unit:''};
        const value = {...previous,...patch,id};
        value.phase = String(value.phase || '').slice(0,160);
        value.done = Number.isFinite(value.done) && value.done >= 0 ? value.done : 0;
        value.total = Number.isFinite(value.total) && value.total > 0 ? value.total : null;
        if (value.total !== null) value.done = Math.min(value.done,value.total);
        this.steps.set(id,value);
        const remaining = this.intervalMs - (Date.now() - this.sentAt);
        if (remaining <= 0) this.flush();
        else if (!this.timer) {
            this.timer = setTimeout(() => {this.timer = null; this.flush();},remaining);
            this.timer.unref?.();
        }
    }
    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        if (this.steps.size) this.deliver(listener);
        if (this.closed) return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    deliver(listener) {try {listener(this.snapshot());} catch (_) { /* A closed view must not fail shared I/O. */ }}
    flush() {
        clearTimeout(this.timer); this.timer = null; this.sentAt = Date.now();
        for (const listener of this.listeners) this.deliver(listener);
    }
    close() {this.closed = true; clearTimeout(this.timer); this.timer = null; this.listeners.clear();}
}

async function sharedLoad(state, key, initial, work, onProgress) {
    if (!state[key]) {
        const source = new LoadProgress(); state[key+'Progress'] = source;
        source.update('work',initial);
        state[key] = Promise.resolve().then(() => work(patch => source.update('work',patch)))
            .catch(error => {state[key] = null; throw error;})
            .finally(() => {source.flush(); source.close();});
    }
    const source = state[key+'Progress'];
    const unsubscribe = source?.subscribe(snapshot => onProgress?.(snapshot.steps[0]));
    try {return await state[key];} finally {unsubscribe?.();}
}

module.exports = {LoadProgress,sharedLoad};
