const collator = new Intl.Collator('en');
const {MemoryCache} = require('./MemoryCache');

function bound(order,run,key,after) {
    let left=0,right=run.length;
    while (left<right) {
        const mid = (left+right)>>>1;
        if (goRight(order.labels[run[mid]][1],key,after)) left=mid+1;
        else right=mid;
    }
    return left;
}

function range(order,from,to) {
    const groups = order.runs.map(run => {
        const start = bound(order,run,from,false), end = bound(order,run,to,true);
        const ids = new Set();
        for (let offset=start;offset<end;offset++) ids.add(order.labels[run[offset]][0]);
        return ids;
    });
    const largest = groups.reduce((best,group) => group.size>best.size ? group : best,new Set());
    const result = new Set(largest);
    for (const group of groups) if (group!==largest) for (const id of group) result.add(id);
    return [...result];
}

function boundedRange(order,from,to,limit) {
    const runs = order.runs.map(run => ({run,at:bound(order,run,from,false),end:bound(order,run,to,true)}));
    const ids = new Set();
    let inspected = 0;
    while (ids.size<limit && inspected++<limit*4+128) {
        let next, label;
        for (const item of runs) {
            if (item.at>=item.end) continue;
            const candidate = order.labels[item.run[item.at]];
            if (!label || collator.compare(candidate[1],label[1])<0) {next=item;label=candidate;}
        }
        if (!next) break;
        next.at++;
        ids.add(label[0]);
    }
    return {ids:[...ids],limited:runs.some(run=>run.at<run.end)};
}

function suggestions(order,keys,limit,maxChar) {
    const ids = new Set();
    let limited = false;
    for (const key of keys) {
        const exact = boundedRange(order,key,key,limit);
        for (const id of exact.ids) ids.add(id);
        limited ||= exact.limited;
        if (!maxChar) continue;
        const prefix = boundedRange(order,key,key+maxChar,limit);
        for (const id of prefix.ids) {
            if (ids.size<limit) ids.add(id);
            else limited=true;
        }
        limited ||= prefix.limited;
    }
    return {ids:[...ids],limited};
}

class NativeNameRanges {
    constructor(process) {
        this.process=process;
        this.directories=new Map();
        this.cache=new MemoryCache({bytes:4*1024*1024,entries:256});
    }

    async available(feature = 'nameRanges') {
        this.capabilities ||= this.process.query({op:'probe',capabilities:true})
            .catch(error=>{this.capabilities=null;throw error;});
        return (await this.capabilities)?.[feature] === true;
    }

    directory(table) {
        if (!this.directories.has(table)) {
            const ready=this.process.query({op:'nameDirectory',table}).then(runs=>{
                if (runs===null) return null;
                if (!Array.isArray(runs) || runs.some(({length,pivots})=>!Number.isSafeInteger(length) || length<0 || !Array.isArray(pivots)))
                    throw new Error('Invalid Rust name range directory');
                return runs.map(({length,pivots})=>({length,pivots:new Map(pivots)}));
            }).catch(error=>{this.directories.delete(table);throw error;});
            this.directories.set(table,ready);
        }
        return this.directories.get(table);
    }

    async windows(table,ranges,feature) {
        if (ranges.some(([from,to])=>from.length>1000000 || to.length>1000000 || !from.isWellFormed() || !to.isWellFormed())) return null;
        if (!await this.available(feature)) return null;
        const requestKey=JSON.stringify([table,ranges]);
        const resolved=this.cache.get(requestKey);
        if (resolved) return resolved;
        const runs=await this.directory(table);
        if (!runs) return null;
        const needed=new Map(), pages=new Map();
        const boundary=(runIndex,key,after)=>{
            const run=runs[runIndex];
            let left=0,right=run.length;
            while (left<right) {
                const mid=(left+right)>>>1, label=run.pivots.get(mid);
                if (label===undefined) break;
                if (goRight(label,key,after)) left=mid+1;
                else right=mid;
            }
            if (left===right) return {left,right};
            const window=[runIndex,left,right];
            const pageKey=table+':'+window.join(':');
            if (!pages.has(pageKey) && !needed.has(pageKey)) {
                const page=this.cache.get(pageKey);
                if (page) pages.set(pageKey,page);
                else needed.set(pageKey,window);
            }
            return {left,right,pageKey,key,after};
        };
        const bounds=ranges.map(([from,to])=>runs.map((_,run)=>[boundary(run,from,false),boundary(run,to,true)]));
        const requests=[...needed];
        for (let offset=0;offset<requests.length;offset+=32) {
            const batch=requests.slice(offset,offset+32);
            const labels=await this.process.query({op:'nameSlices',table,windows:batch.map(([,window])=>window)});
            if (!Array.isArray(labels) || labels.length!==batch.length) throw new Error('Invalid Rust name label slices');
            for (const [index,[key,[,left,right]]] of batch.entries()) {
                const page=labels[index];
                if (!Array.isArray(page) || page.length!==right-left || page.some(label=>typeof label!=='string'))
                    throw new Error('Invalid Rust name label slice');
                pages.set(key,page);
                this.cache.set(key,page);
            }
        }
        const windows=bounds.map(byRun=>byRun.map(pair=>pair.map(({left,right,pageKey,key,after})=>{
            const start=left, page=pages.get(pageKey);
            while (left<right) {
                const mid=(left+right)>>>1;
                if (goRight(page[mid-start],key,after)) left=mid+1;
                else right=mid;
            }
            return left;
        })));
        this.cache.set(requestKey,windows);
        return windows;
    }

    close() {this.directories.clear(); this.cache.close();}
}

function goRight(label,key,after) {
    const cmp=collator.compare(label,key);
    return cmp<0 || after && cmp===0;
}

module.exports = {range,suggestions,NativeNameRanges};
