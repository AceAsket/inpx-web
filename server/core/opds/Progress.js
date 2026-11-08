// Progress belongs to the resolved OPDS profile, never to a cached book row.
function icon(percent,read=false) {
    const value=Number(percent);
    if(read||Number.isFinite(value)&&value>=.999)return '⬤';
    if(!Number.isFinite(value)||value<=0)return '';
    return value<=.25?'◔':value<=.5?'◑':'◕';
}

function bookEntry(entry,unavailable) {
    const links=Array.isArray(entry.link)?entry.link:entry.link?[entry.link]:[];
    return links.some(link=>{
        const attrs=link?.['*ATTRS'];
        return attrs&&(String(attrs.rel||'').startsWith('http://opds-spec.org/acquisition')
            ||/kind=acquisition/.test(attrs.type||''));
    }) || unavailable&&entry.content?.['*ATTRS']?.type==='text';
}

function decorate(content,req,unavailable=false) {
    const user=req?.opdsUser;
    if(!user||String(req.query?.user||'')!==String(user.id))return content;
    const progress=user.readerProgress||{};
    return {...content,entry:(content.entry||[]).map(entry=>{
        if(!entry||!bookEntry(entry,unavailable))return entry;
        const uid=String(entry.id||''),row=Object.hasOwn(progress,uid)?progress[uid]:null;
        if(row?.relinkedTo)return entry;
        const readMark=/^✓\s/.test(entry.title||''),mark=icon(row?.percent,readMark);
        return mark?{...entry,title:mark+' '+String(entry.title).replace(/^✓\s+/,'')}:entry;
    })};
}
module.exports={icon,decorate};
