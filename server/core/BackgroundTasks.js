const crypto = require('crypto');

class BackgroundTasks {
    constructor() { this.tasks = new Map(); }
    start(kind, title, options = {}) {
        this.prune();
        const id = crypto.randomBytes(12).toString('hex');
        this.tasks.set(id, {id, kind, title, visibility:options.visibility || 'admin', userId:options.userId || '',
            state:'running', phase:'Подготовка', done:0, total:null, startedAt:Date.now(), updatedAt:Date.now()});
        return id;
    }
    update(id, patch) {
        const task = this.tasks.get(id);
        if (task) Object.assign(task, patch, {updatedAt:Date.now()});
    }
    finish(id, error = null) { this.update(id, {state:error ? 'error' : 'ready', error:error ? String(error.message || error).slice(0,2000) : '', waitingReason:'', finishedAt:Date.now()}); }
    prune() {
        for (const [id, task] of this.tasks) {
            if (task.finishedAt && (Date.now() - task.finishedAt > 3600000 || this.tasks.size >= 100)) this.tasks.delete(id);
        }
    }
    list(user) {
        this.prune();
        return [...this.tasks.values()].filter(task => user.isAdmin || task.visibility === 'public' || task.userId === user.id)
            .map(task => {
                const result = {...task};
                delete result.visibility; delete result.userId;
                result.progress = task.total > 0 ? Math.min(1, task.done / task.total) : null;
                result.remainingSeconds = task.state === 'running' && task.done > 0 && task.total > task.done
                    ? Math.ceil((Date.now() - task.startedAt) / 1000 * (task.total - task.done) / task.done) : null;
                return result;
            }).sort((a,b) => b.startedAt - a.startedAt);
    }
}

module.exports = new BackgroundTasks();
module.exports.BackgroundTasks = BackgroundTasks;
