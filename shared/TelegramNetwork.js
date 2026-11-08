function normalizeIpFamily(value = 'auto') {
    if (value != null && !['string', 'number'].includes(typeof value))
        throw new Error('Семейство IP для Telegram: auto, 4 или 6');
    const family = String(value ?? 'auto').trim().toLowerCase();
    if (family === '' || family === 'auto' || family === '0') return 'auto';
    if (family === '4' || family === '6') return family;
    throw new Error('Семейство IP для Telegram: auto, 4 или 6');
}

function requestOptions(config = {}) {
    const family = normalizeIpFamily(config.telegramIpFamily);
    // Axios forwards family to Node's connection options. Keep the default
    // dual-stack behavior unless the administrator explicitly selects a family.
    return family === 'auto' ? {} : {family: Number(family)};
}

const proxyDefaults={telegramProxyMode:'system',telegramProxyProtocol:'http',telegramProxyHost:'',telegramProxyPort:'',
    telegramProxyUsername:'',telegramProxyPassword:''};
const proxyFields=Object.keys(proxyDefaults);
function proxyText(value, maximum, label) {
    if(value!=null && typeof value!=='string')throw new Error(`Telegram прокси: неверное поле ${label}`);
    const text=String(value ?? '');
    if(text.length>maximum || /[\u0000-\u001f\u007f]/.test(text))throw new Error(`Telegram прокси: неверное поле ${label}`);
    return text;
}
function normalizeProxyConfig(config={}) {
    const result={};
    result.telegramProxyMode=proxyText(config.telegramProxyMode ?? 'system',16,'режим').trim().toLowerCase();
    if(!['direct','system','custom'].includes(result.telegramProxyMode))throw new Error('Telegram прокси: direct, system или custom');
    result.telegramProxyProtocol=proxyText(config.telegramProxyProtocol ?? 'http',16,'протокол').trim().toLowerCase();
    if(!['http','https','socks5','socks5h'].includes(result.telegramProxyProtocol))throw new Error('Telegram прокси: HTTP, HTTPS, SOCKS5 или SOCKS5h');
    let host=proxyText(config.telegramProxyHost,255,'адрес').trim();
    if(host.startsWith('[') && host.endsWith(']'))host=host.slice(1,-1);
    if(host && (/[\s\/@?#\\]/.test(host) || host.includes('://')))throw new Error('Telegram прокси: укажите только хост или IP без URL и пароля');
    if(host) {
        try {const url=new URL('http://'+(host.includes(':') ? '['+host+']':host)+'/');if(!url.hostname)throw new Error();}
        catch (_) {throw new Error('Telegram прокси: неверный хост или IP');}
    }
    result.telegramProxyHost=host;
    const port=config.telegramProxyPort;
    if(port==null || port==='')result.telegramProxyPort='';
    else {
        if(!['string','number'].includes(typeof port) || !/^\d+$/.test(String(port)))throw new Error('Telegram прокси: порт от 1 до 65535');
        const number=Number(port);
        if(!Number.isInteger(number)||number<1||number>65535)throw new Error('Telegram прокси: порт от 1 до 65535');
        result.telegramProxyPort=number;
    }
    result.telegramProxyUsername=proxyText(config.telegramProxyUsername,255,'логин');
    result.telegramProxyPassword=proxyText(config.telegramProxyPassword,255,'пароль');
    if(new TextEncoder().encode(result.telegramProxyUsername).length>255 || new TextEncoder().encode(result.telegramProxyPassword).length>255)
        throw new Error('Telegram прокси: логин и пароль не длиннее 255 байт');
    if(result.telegramProxyMode==='custom' && (!host || !result.telegramProxyPort))throw new Error('Telegram прокси: укажите хост и порт');
    return result;
}
function environmentPatch(env={}) {
    const result={};
    for(const field of proxyFields) {
        const name='TELEGRAM_PROXY_'+field.slice('telegramProxy'.length).replace(/([a-z])([A-Z])/g,'$1_$2').toUpperCase();
        if(Object.prototype.hasOwnProperty.call(env,name))result[field]=env[name];
    }
    return result;
}

module.exports = {normalizeIpFamily, requestOptions,proxyDefaults,proxyFields,normalizeProxyConfig,environmentPatch};
