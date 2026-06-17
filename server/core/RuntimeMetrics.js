const ACTION_SAMPLE_LIMIT = 120;
const MAX_ACTIONS = 220;
const EVENT_LOOP_SAMPLE_LIMIT = 180;
const EVENT_LOOP_SAMPLE_INTERVAL = 2000;

function quantile(values, q) {
    if (!values.length)
        return 0;

    const sorted = values.slice().sort((a, b) => a - b);
    const pos = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1)*q)));
    return Number(sorted[pos].toFixed(2));
}

function pushBounded(list, value, max) {
    list.push(value);
    if (list.length > max)
        list.shift();
}

function normalizeActionLabel(action = '') {
    const text = String(action || 'unknown').trim() || 'unknown';
    return text
        .replace(/[A-Za-z0-9+/=_-]{32,}/g, ':token')
        .replace(/\d{5,}/g, ':n')
        .slice(0, 96);
}

class RuntimeMetrics {
    constructor() {
        this.actionStats = new Map();
        this.totalActions = 0;
        this.inFlightActions = 0;
        this.lastEventLoopLagMs = 0;
        this.eventLoopLagSamples = [];
        this.lastSlowAction = null;
        this.slowActionThresholdMs = 1500;

        this.startEventLoopSampler();
    }

    startEventLoopSampler() {
        const sample = () => {
            const started = process.hrtime.bigint();
            const timer = setTimeout(() => {
                const elapsedMs = Number(process.hrtime.bigint() - started) / 1000000;
                const lagMs = Math.max(0, elapsedMs - EVENT_LOOP_SAMPLE_INTERVAL);
                this.lastEventLoopLagMs = Number(lagMs.toFixed(2));
                pushBounded(this.eventLoopLagSamples, lagMs, EVENT_LOOP_SAMPLE_LIMIT);
                sample();
            }, EVENT_LOOP_SAMPLE_INTERVAL);

            if (typeof timer.unref === 'function')
                timer.unref();
        };

        sample();
    }

    beginAction(action = '') {
        this.totalActions++;
        this.inFlightActions++;
        return {
            action: normalizeActionLabel(action),
            startedAt: process.hrtime.bigint(),
        };
    }

    endAction(token, ok = true) {
        if (!token)
            return null;

        this.inFlightActions = Math.max(0, this.inFlightActions - 1);
        const durationMs = Number(process.hrtime.bigint() - token.startedAt) / 1000000;
        const action = token.action || 'unknown';
        const stats = this.getOrCreateActionStats(action);
        stats.count++;
        if (!ok)
            stats.errors++;
        stats.totalMs += durationMs;
        stats.maxMs = Math.max(stats.maxMs, durationMs);
        stats.lastMs = durationMs;
        stats.lastAt = new Date().toISOString();
        pushBounded(stats.samples, durationMs, ACTION_SAMPLE_LIMIT);

        if (durationMs >= this.slowActionThresholdMs) {
            this.lastSlowAction = {
                action,
                durationMs: Number(durationMs.toFixed(2)),
                at: stats.lastAt,
            };
        }

        return durationMs;
    }

    getOrCreateActionStats(action) {
        let stats = this.actionStats.get(action);
        if (stats)
            return stats;

        if (this.actionStats.size >= MAX_ACTIONS) {
            const oldest = this.actionStats.keys().next().value;
            if (oldest !== undefined)
                this.actionStats.delete(oldest);
        }

        stats = {
            count: 0,
            errors: 0,
            totalMs: 0,
            maxMs: 0,
            lastMs: 0,
            lastAt: '',
            samples: [],
        };
        this.actionStats.set(action, stats);
        return stats;
    }

    getSnapshot() {
        const actions = Array.from(this.actionStats.entries()).map(([action, stats]) => ({
            action,
            count: stats.count,
            errors: stats.errors,
            avgMs: stats.count ? Number((stats.totalMs / stats.count).toFixed(2)) : 0,
            p95Ms: quantile(stats.samples, 0.95),
            maxMs: Number(stats.maxMs.toFixed(2)),
            lastMs: Number(stats.lastMs.toFixed(2)),
            lastAt: stats.lastAt,
        }));

        actions.sort((a, b) => b.p95Ms - a.p95Ms || b.avgMs - a.avgMs || b.count - a.count);

        return {
            totalActions: this.totalActions,
            inFlightActions: this.inFlightActions,
            actionCount: this.actionStats.size,
            lastEventLoopLagMs: this.lastEventLoopLagMs,
            eventLoopLagP95Ms: quantile(this.eventLoopLagSamples, 0.95),
            lastSlowAction: this.lastSlowAction,
            slowestActions: actions.slice(0, 8),
        };
    }
}

module.exports = new RuntimeMetrics();
