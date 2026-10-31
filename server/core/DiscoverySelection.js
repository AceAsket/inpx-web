// Exact prefix of the old full sort, expanding only when author/series diversity needs more rows.
// Kept self-contained because Jemba executes it in the database worker.
function selectDiverseBest(rows,compare,limit) {
    const total=rows.size;
    let size=Math.min(total,Math.max(64,limit*8));
    for(;;) {
        const heap=[];
        const down=index=>{
            for(;;){let worst=index,left=index*2+1,right=left+1;
                if(left<heap.length&&compare(heap[left],heap[worst])>0)worst=left;
                if(right<heap.length&&compare(heap[right],heap[worst])>0)worst=right;
                if(worst===index)return;
                [heap[index],heap[worst]]=[heap[worst],heap[index]];index=worst;
            }
        };
        for(const row of rows.values()) {
            if(heap.length<size){heap.push(row);let index=heap.length-1;
                while(index>0){const parent=(index-1)>>1;if(compare(heap[index],heap[parent])<=0)break;
                    [heap[index],heap[parent]]=[heap[parent],heap[index]];index=parent;}
            } else if(size&&compare(row,heap[0])<0){heap[0]=row;down(0);}
        }
        heap.sort(compare);
        const selected=[],authors=new Map(),series=new Map();
        for(const row of heap){
            const author=String(row.author||'').trim().toLowerCase(),name=String(row.series||'').trim().toLowerCase();
            if(author&&(authors.get(author)||0)>=2||name&&(series.get(name)||0)>=2)continue;
            selected.push(row);
            if(author)authors.set(author,(authors.get(author)||0)+1);
            if(name)series.set(name,(series.get(name)||0)+1);
            if(selected.length>=limit)return selected;
        }
        if(size>=total)return selected;
        size=Math.min(total,size*2);
    }
}
module.exports={selectDiverseBest};
