const limits=Object.freeze({annotationChars:6000,prefixBytes:2*1024**2,epubBytes:32*1024**2,
    timeoutMs:10000,cacheBytes:4*1024**2,cacheEntries:200,cacheTtlMs:5*60*1000});
const statuses=Object.freeze(['ready','empty','limited','unsupported','unavailable']);
function annotationText(value) {
    const text=String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
        .replace(/[\t\r ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    let end=limits.annotationChars;
    if(end<text.length&&/[\ud800-\udbff]/.test(text[end-1]))end--;
    return {annotation:text.slice(0,end),limited:text.length>end};
}
function year(value){const match=String(value||'').trim().match(/^([1-9]\d{3})(?:$|[-/.\s])/);return match?match[1]:'';}
function tokens(value){return [...new Set((Array.isArray(value)?value.slice(0,12):String(value||'').slice(0,1200).split(/[,;\n]/)).map(v=>String(v||'').trim().slice(0,120)).filter(Boolean))].slice(0,12);}
module.exports={limits,statuses,annotationText,year,tokens};
