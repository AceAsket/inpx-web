const collator = new Intl.Collator('en');

function bound(order,run,key,after) {
    let left=0,right=run.length;
    while (left<right) {
        const mid = (left+right)>>>1;
        const cmp = collator.compare(order.labels[run[mid]][1],key);
        if (cmp<0 || after && cmp===0) left=mid+1;
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

module.exports = {range,suggestions};
