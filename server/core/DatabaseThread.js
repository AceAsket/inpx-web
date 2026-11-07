const {Worker} = require('worker_threads');
const {JembaDbThread} = require('jembadb');
class DatabaseThread extends JembaDbThread {
    constructor(config) {
        super(); this.cachePolicy = require('./DatabaseCache').policy(config);
        this.available = false; this.failure = null; this.termination = Promise.resolve();
    }

    unavailableError() {
        const detail = this.failure?.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'поток завершился из-за нехватки памяти'
            : this.failure ? 'поток базы данных неожиданно завершился' : 'база данных закрыта';
        return Object.assign(new Error(`Поисковая база недоступна: ${detail}. Перезапустите сервер для восстановления.`),
            {code:'INPX_DATABASE_UNAVAILABLE', causeCode:this.failure?.code});
    }

    rejectPending(error) {
        for (const listener of [...this.listeners.values()])
            listener({error:error.message, errorCode:error.code, causeCode:error.causeCode});
        this.listeners.clear();
    }

    stopWorker(worker) {
        try {this.termination = Promise.resolve(worker.terminate()).catch(() => {});}
        catch (_) {this.termination = Promise.resolve();}
    }

    failed(worker, error, exitCode) {
        if (this.worker !== worker) return;
        this.failure = {code:error?.code || 'INPX_DATABASE_WORKER_EXIT',
            message:String(error?.message || `Database worker exited with code ${exitCode}`).slice(0,500),
            at:new Date().toISOString(), ...(exitCode === undefined ? {} : {exitCode})};
        this.worker = null; this.available = false;
        this.rejectPending(this.unavailableError());
        this.stopWorker(worker);
    }

    _terminate() {
        const worker = this.worker;
        this.worker = null; this.available = false;
        this.rejectPending(this.unavailableError());
        if (worker) this.stopWorker(worker);
    }

    _action(action, query) {
        const worker = this.worker;
        if (!worker || !this.available) return Promise.reject(this.unavailableError());
        return new Promise((resolve,reject) => {
            const requestId = ++this.requestId;
            this.listeners.set(requestId, message => {
                this.listeners.delete(requestId);
                if (message.error) reject(Object.assign(new Error(message.error),
                    {code:message.errorCode, causeCode:message.causeCode}));
                else resolve(message.result);
            });
            try {worker.postMessage({requestId, action, query});}
            catch (error) {
                this.listeners.delete(requestId);
                if (error.code === 'ERR_WORKER_NOT_RUNNING') this.failed(worker,error);
                reject(error);
            }
        });
    }

    async lock(query) {
        await this.termination;
        return super.lock(query);
    }

    async unlock() {
        try {if (this.worker) await this._action('unlock');}
        finally {this._terminate(); await this.termination;}
    }

    _runWoker() {
        const worker = new Worker(`require(${JSON.stringify(require.resolve('./DatabaseWorker'))})`, {eval:true, workerData:this.cachePolicy});
        this.worker = worker; this.available = true; this.failure = null;
        worker.on('message', message => {if (this.worker === worker) this.listeners.get(message.requestId)?.(message);});
        worker.on('error', error => this.failed(worker,error));
        worker.on('exit', code => this.failed(worker,null,code));
    }
    cacheStats() {return this._action('cacheStats');}
}
module.exports = DatabaseThread;
