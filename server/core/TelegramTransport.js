// Node-only transport: the shared settings validator remains browser-safe.
const dns=require('dns');
const crypto=require('crypto');
const https=require('https');
const {getProxyForUrl}=require('proxy-from-env');
const {createHttpProxyAgent,createSocksProxyAgent}=require('./TelegramProxyAgents');
const network=require('../../shared/TelegramNetwork');

function effectiveConfig(config={},env=process.env) {
    return {...config,...network.normalizeProxyConfig({...config,...network.environmentPatch(env)}),
        telegramIpFamily:network.normalizeIpFamily(Object.hasOwn(env,'TELEGRAM_IP_FAMILY') ? env.TELEGRAM_IP_FAMILY:config.telegramIpFamily)};
}
function requestOptions(config={}, agentOptions={},target='https://api.telegram.org') {
    let current=effectiveConfig(config);
    if(current.telegramProxyMode==='system') {
        const proxy=getProxyForUrl(target);
        if(!proxy)current={...current,telegramProxyMode:'direct'};
        else {
            try {
                const url=new URL(proxy),protocol=url.protocol.slice(0,-1);
                current={...current,...network.normalizeProxyConfig({telegramProxyMode:'custom',
                    telegramProxyProtocol:protocol==='socks' ? 'socks5h':protocol,
                    telegramProxyHost:url.hostname,telegramProxyPort:url.port || (protocol==='https' ? 443:protocol==='http' ? 80:1080),
                    telegramProxyUsername:decodeURIComponent(url.username),telegramProxyPassword:decodeURIComponent(url.password)})};
            } catch (_) {throw new Error('Telegram: некорректная настройка системного прокси');}
        }
    }
    const options={...network.requestOptions(current),proxy:false,maxRedirects:0};
    if(current.telegramProxyMode==='direct') {
        // An explicit agent also bypasses Node24's NODE_USE_ENV_PROXY global
        // agent. Axios proxy:false alone only disables Axios's environment layer.
        options.httpsAgent=new https.Agent({...agentOptions,keepAlive:false,proxyEnv:{}});
        return options;
    }
    const family=options.family,host=current.telegramProxyHost;
    const url=new URL(`${current.telegramProxyProtocol}://${host.includes(':') ? '['+host+']':host}:${current.telegramProxyPort}`);
    let agent;
    if(current.telegramProxyProtocol.startsWith('socks')) {
        url.username=current.telegramProxyUsername;url.password=current.telegramProxyPassword;
        agent=createSocksProxyAgent(url,{timeout:20000,...agentOptions,socketOptions:{...agentOptions.socketOptions,...(family ? {family}:{})}});
        // socks5 resolves the destination locally; socks5h delegates it to the
        // proxy. family always constrains the connection to the proxy itself.
        if(family)options.lookup=(hostname,opts,callback)=>dns.lookup(hostname,{...opts,family},callback);
    } else {
        const headers={};
        if(current.telegramProxyUsername || current.telegramProxyPassword)
            headers['Proxy-Authorization']='Basic '+Buffer.from(current.telegramProxyUsername+':'+current.telegramProxyPassword).toString('base64');
        // Keep credentials out of the proxy URL (including agent debug output).
        agent=createHttpProxyAgent(url,{...agentOptions,...(family ? {family}:{}),headers});
    }
    options.httpsAgent=agent;
    return options;
}
function safeError(cause,config={},token='') {
    const environment=network.environmentPatch(process.env);
    const secrets=[token,config.telegramProxyUsername,config.telegramProxyPassword,environment.telegramProxyUsername,environment.telegramProxyPassword]
        .filter(value=>typeof value==='string' && value.length);
    let effective={};try {effective=effectiveConfig(config);} catch (_) { /* Invalid fields must not hide the original safe error. */ }
    for(const value of [config,environment,effective])if(value.telegramProxyUsername || value.telegramProxyPassword)
        secrets.push(Buffer.from((value.telegramProxyUsername || '')+':'+(value.telegramProxyPassword || '')).toString('base64'));
    for(const name of ['HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy']) {
        try {const url=new URL(process.env[name]),user=decodeURIComponent(url.username),pass=decodeURIComponent(url.password);
            secrets.push(user,pass,Buffer.from(user+':'+pass).toString('base64'));} catch (_) { /* No URL to redact. */ }
    }
    let message=typeof cause?.response?.data?.description==='string' ? cause.response.data.description:'Telegram API недоступен; проверьте сеть и прокси';
    message=message.replace(/\b(?:https?|socks5h?):\/\/[^\s]+/gi,'[URL]');
    for(const secret of secrets.filter(Boolean))for(const value of [secret,encodeURIComponent(secret)])message=message.split(value).join('[redacted]');
    const error=new Error(message.slice(0,240));
    const status=Number(cause?.response?.status);
    error.status=status>=400&&status<=599 ? status:502;
    error.retryAfter=Math.min(120,Math.max(1,Number(cause?.response?.data?.parameters?.retry_after)||0));
    return error;
}
function signature(config={}) {
    const current=effectiveConfig(config);
    return crypto.createHash('sha256').update(JSON.stringify([current.telegramIpFamily,...network.proxyFields.map(field=>current[field])])).digest('hex');
}
module.exports={requestOptions,safeError,effectiveConfig,signature};
