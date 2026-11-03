function serverUrl(origin,rootPath='') {
    const url=new URL(origin);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Некорректный адрес сервера');
    url.pathname='/' + String(rootPath).replace(/^\/+|\/+$/g,'') + '/';
    url.pathname=url.pathname.replace(/\/{2,}/g,'/');url.search='';url.hash='';
    return url.href;
}
function qrPayload(url) {
    const parsed=new URL(url);
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)
        throw new Error('Некорректный адрес сервера');
    return `inpx-reader://connect?v=1&server=${encodeURIComponent(parsed.href)}`;
}
module.exports={serverUrl,qrPayload};
