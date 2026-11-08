const dns=require('dns');
const net=require('net');
const tls=require('tls');
const {HttpsProxyAgent}=require('https-proxy-agent');
const {SocksProxyAgent}=require('socks-proxy-agent');
const {SocksClient}=require('socks');

const cancelled=()=>Object.assign(new Error('Telegram proxy connection cancelled'),{code:'ABORT_ERR'});
const timedOut=()=>Object.assign(new Error('Telegram proxy connection timed out'),{code:'ETIMEDOUT'});
const timeoutFor=options=>Number.isFinite(options.timeout)&&options.timeout>0 ? options.timeout:20000;

function initialize(agent,controller,options) {
    agent.proxyController=controller;
    agent.proxyCleanups=new Set();
    agent.proxyConnectionTimeout=timeoutFor(options);
    if(options.signal) {
        const abort=()=>controller.abort(cancelled());
        options.signal.addEventListener('abort',abort,{once:true});
        agent.proxyCleanups.add(()=>options.signal.removeEventListener('abort',abort));
        if(options.signal.aborted)abort();
    }
}

function bindRequest(agent,request) {
    const controller=agent.proxyController;
    const abort=()=>controller.abort(cancelled());
    // While agent-base owns only a placeholder, ClientRequest.destroy() may not
    // emit close/error yet. Axios cancels through this method synchronously.
    const destroy=request.destroy;
    const destroyRequest=function(...args){abort();return destroy.apply(this,args);};
    request.destroy=destroyRequest;
    request.once('close',abort);request.once('abort',abort);request.once('error',abort);
    const timer=setTimeout(()=>controller.abort(timedOut()),agent.proxyConnectionTimeout);
    timer.unref?.();
    const cleanup=()=>{
        clearTimeout(timer);
        if(request.destroy===destroyRequest)request.destroy=destroy;
        request.removeListener('close',abort);request.removeListener('abort',abort);request.removeListener('error',abort);
        agent.proxyCleanups.delete(cleanup);
    };
    agent.proxyCleanups.add(cleanup);
    if(request.destroyed || request.aborted)abort();
    return cleanup;
}

function abortPending(agent) {
    agent.proxyController.abort(cancelled());
    for(const cleanup of agent.proxyCleanups)cleanup();
    agent.proxyCleanups.clear();
}

function withSignal(promise,signal) {
    return new Promise((resolve,reject)=>{
        const abort=()=>{cleanup();reject(signal.reason||cancelled());};
        const cleanup=()=>signal.removeEventListener('abort',abort);
        // Always subscribe to the underlying operation, including when already
        // aborted, so a late DNS/connect failure cannot become unhandled.
        Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
        if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    });
}

// Factories return disposable agents for one Telegram API request. Native
// Agent.destroy() cannot see sockets still private to an asynchronous proxy
// handshake, so the signal owns those sockets before agent-base receives them.
class TelegramHttpProxyAgent extends HttpsProxyAgent {
    constructor(proxy,options={}) {
        const controller=new AbortController();
        super(proxy,{...options,signal:controller.signal});
        initialize(this,controller,options);
    }
    async connect(request,options) {
        const cleanup=bindRequest(this,request);
        try {return await withSignal(super.connect(request,options),this.proxyController.signal);}
        finally {cleanup();}
    }
    destroy() {abortPending(this);super.destroy();}
}

class TelegramSocksProxyAgent extends SocksProxyAgent {
    constructor(proxy,options={}) {
        const controller=new AbortController();
        super(proxy,options);
        initialize(this,controller,options);
        this.proxy.host=this.proxy.host.replace(/^\[|\]$/g,'');
    }
    async connect(request,options) {
        const cleanup=bindRequest(this,request),signal=this.proxyController.signal;
        let socket,tlsSocket;
        try {
            if(signal.aborted)throw signal.reason||cancelled();
            if(!options.host)throw new Error('Telegram proxy target is missing');
            let host=options.host;
            if(this.shouldLookup) {
                const lookup=options.lookup||dns.lookup;
                host=await withSignal(new Promise((resolve,reject)=>lookup(host,{},(error,address)=>error ? reject(error):resolve(address))),signal);
            }
            if(signal.aborted)throw signal.reason||cancelled();
            socket=new net.Socket({signal});
            // SOCKS library handlers are removed after negotiation. Keep an
            // error listener while TLS takes ownership, including cancellation.
            socket.on('error',()=>{});
            await withSignal(new Promise((resolve,reject)=>{
                const connected=()=>{socket.removeListener('error',failed);resolve();};
                const failed=error=>{socket.removeListener('connect',connected);reject(error);};
                socket.once('connect',connected);socket.once('error',failed);
                socket.connect({...this.socketOptions,host:this.proxy.host,port:this.proxy.port});
            }),signal);
            // existing_socket must already be connected. The library retains
            // authentication and protocol validation; no SOCKS bytes are copied.
            await withSignal(SocksClient.createConnection({proxy:this.proxy,command:'connect',
                destination:{host,port:Number(options.port)},existing_socket:socket,timeout:this.proxyConnectionTimeout}),signal);
            if(signal.aborted)throw signal.reason||cancelled();
            socket.setTimeout(this.proxyConnectionTimeout,()=>{
                request.destroy(timedOut());socket.destroy();tlsSocket?.destroy();
            });
            if(!options.secureEndpoint)return socket;
            const tlsOptions={...options,socket,signal};
            delete tlsOptions.host;delete tlsOptions.path;delete tlsOptions.port;
            if(tlsOptions.servername===undefined&&!net.isIP(options.host))tlsOptions.servername=options.host;
            tlsSocket=tls.connect(tlsOptions);
            tlsSocket.once('error',()=>{request.destroy();socket.destroy();tlsSocket.destroy();});
            return tlsSocket;
        } catch(error) {socket?.destroy();tlsSocket?.destroy();throw error;}
        finally {cleanup();}
    }
    destroy() {abortPending(this);super.destroy();}
}

module.exports={TelegramHttpProxyAgent,TelegramSocksProxyAgent,
    createHttpProxyAgent:(proxy,options)=>new TelegramHttpProxyAgent(proxy,options),
    createSocksProxyAgent:(proxy,options)=>new TelegramSocksProxyAgent(proxy,options)};
