// Bound work across sockets. Disconnecting a client does not stop a running database query.
class ClientRequestBudget {
    constructor({parallel=4,perUser=1,queued=32,waitMs=30000}={}) {
        Object.assign(this,{parallel,perUser,maximumQueued:queued,waitMs});
        this.active=0; this.users=new Map(); this.queue=[]; this.shared=new Map();
    }
    busy() {return Object.assign(new Error('Сервер занят. Повторите запрос позже.'),{code:'server_busy',retryAfterMs:2000});}
    run(identity,key,work,alive=()=>true) {
        const signature=JSON.stringify([identity,key]);
        const shared=this.shared.get(signature);
        if (shared) {shared.alive.push(alive);return shared.promise;}
        if (this.queue.length >= this.maximumQueued) return Promise.reject(this.busy());
        const subscribers=[alive];
        const promise=new Promise((resolve,reject)=>{
            const job={identity,work,resolve,reject,alive:()=>subscribers.some(check=>check())};
            job.timer=setTimeout(()=>{
                const index=this.queue.indexOf(job);
                if(index>=0){this.queue.splice(index,1);reject(this.busy());}
            },this.waitMs);
            job.timer.unref?.(); this.queue.push(job); this.drain();
        });
        this.shared.set(signature,{promise,alive:subscribers});
        promise.then(()=>this.shared.delete(signature),()=>this.shared.delete(signature));
        return promise;
    }
    drain() {
        while(this.active<this.parallel) {
            const index=this.queue.findIndex(job=>(this.users.get(job.identity)||0)<this.perUser);
            if(index<0)return;
            const job=this.queue.splice(index,1)[0];clearTimeout(job.timer);
            if(!job.alive()){job.reject(Object.assign(new Error('Запрос отменён'),{code:'request_cancelled'}));continue;}
            this.active++;this.users.set(job.identity,(this.users.get(job.identity)||0)+1);
            Promise.resolve().then(job.work).then(job.resolve,job.reject).finally(()=>{
                this.active--;this.users.set(job.identity,this.users.get(job.identity)-1);
                if(!this.users.get(job.identity))this.users.delete(job.identity);
                this.drain();
            });
        }
    }
    snapshot(){return {active:this.active,queued:this.queue.length,parallel:this.parallel,perUser:this.perUser};}
}
module.exports=ClientRequestBudget;
