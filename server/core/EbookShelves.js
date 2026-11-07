const SmartShelf=require('./SmartShelf');
const missing=()=>Object.assign(new Error('Полка не найдена.'),{status:404});

// A shelf page resolves only visible book records. Listing smart shelves does
// not evaluate their queries; unread smart shelves scan at most 200 rows.
async function lists(worker,userId){
    return (await worker.readingListStore.getLists(userId)).map(item=>({id:item.id,name:item.name,
        smart:!!item.filters,bookCount:item.filters?null:item.books.length}));
}
async function page(worker,user,id,{offset=0,size=10}={}){
    const item=await worker.readingListStore.getList(user.id,id);
    if(!item)throw missing();
    let books=[],next=null,total=null,scanned=0;
    if(item.filters){
        const filters=SmartShelf.query(SmartShelf.normalize(item.filters));
        const read=filters.unreadOnly?worker.getPersonalReadBookSet(user,await worker.readingListStore.getLists(user.id)):null;
        let cursor=offset,remaining=true;
        while(remaining&&books.length<size&&scanned<200){
            const limit=Math.min(size-books.length,200-scanned);
            const result=await worker.bookSearch({...filters,unreadOnly:false,limit,offset:cursor});
            total=read?null:result.totalFound;
            for(const book of result.found){if(!read||!read.has(book._uid))books.push(book);}
            scanned+=result.found.length;cursor+=result.found.length;
            remaining=result.found.length>0&&cursor<result.totalFound;
        }
        if(remaining)next=cursor;
    }else{
        total=item.books.length;
        const entries=item.books.slice(offset,offset+size);
        books=await Promise.all(entries.map(async entry=>{
            const book=await worker.getBookRecordByUid(entry.bookUid);
            return book?{...book,_shelfRead:entry.read===true}:{_uid:entry.bookUid,title:'Книга недоступна',unavailable:true};
        }));
        if(offset+size<total)next=offset+size;
    }
    return {id:item.id,name:item.name,smart:!!item.filters,books,next,total,scanned,unreadOnly:item.filters?.unreadOnly===true};
}
module.exports={lists,page};
