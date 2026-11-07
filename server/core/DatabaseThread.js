const {Worker} = require('worker_threads');
const {JembaDbThread} = require('jembadb');
class DatabaseThread extends JembaDbThread {
    constructor(config) {super(); this.cachePolicy = require('./DatabaseCache').policy(config);}
    _runWoker() {
        const worker = new Worker(`require(${JSON.stringify(require.resolve('./DatabaseWorker'))})`, {eval:true, workerData:this.cachePolicy});
        this.worker = worker;
        worker.on('message', message => this.listeners.get(message.requestId)?.(message));
        worker.on('error', error => {
            for (const listener of this.listeners.values()) listener({error:error.message});
            if (this.worker === worker) this._terminate();
        });
        worker.on('exit', () => {if (this.worker === worker) this._terminate();});
    }
    cacheStats() {return this._action('cacheStats');}
}
module.exports = DatabaseThread;
