const {spawn} = require('node:child_process');
const {randomBytes,timingSafeEqual} = require('node:crypto');
const {maxHeaderSize} = require('node:http');
const {createServer,isIP} = require('node:net');
const {relative,resolve} = require('node:path');
const {createInterface} = require('node:readline');
const {isDeepStrictEqual} = require('node:util');
const appDirectory = require('../../build/appdir');
const programs = require('./RustPrograms');

const binaryName = programs.fileName('server');
const prefaceLimit = 160;
const transports = new WeakMap();
const nativePeer = Symbol('native HTTP peer');
const assetProbeHeader = 'x-inpx-managed-asset';
const fileHeader = 'x-inpx-file';
const accessHeader = 'x-inpx-request-access';

class RustHttpServer {
    constructor(http, onFailure) {
        this.http = http;
        const key = randomBytes(32).toString('hex');
        this.key = key;
        this.control = new Map();
        this.deliveries = new Map();
        this.sequence = 0;
        this.sockets = new Set();
        this.listener = createServer(socket=>{
            this.sockets.add(socket);
            socket.once('close',()=>this.sockets.delete(socket));
            bindPeer(socket,http,key,this);
        });
        this.onFailure = onFailure;
    }

    async start(binary, config, options) {
        this.config = config;
        this.options = options;
        this.direct = this.directRoutes();
        const routes = this.wireRoutes(this.direct,++this.sequence);
        this.files = config.bookPathStatic && config.bookDir ? {
            bookRoute:config.bookPathStatic,
            coverRoute:`${config.rootPathStatic || ''}/cover`,
            book:resolve(config.bookDir),
            cover:resolve(config.coverDir || resolve(config.publicFilesDir || config.bookDir,'cover')),
            batch:config.tempDir ? resolve(config.tempDir) : undefined,
        } : undefined;
        // Hyper owns the public connection lifetime. Avoid closing an idle private connection first.
        this.http.keepAliveTimeout = 0;
        await new Promise((resolve,reject)=>{
            this.listener.once('error',reject);
            this.listener.listen(0,'127.0.0.1',()=>{
                this.listener.removeListener('error',reject);
                resolve();
            });
        });
        this.listener.on('error',error=>{if (!this.closing) this.onFailure(error);});

        const ready = Promise.withResolvers();
        const child = this.child = spawn(binary,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
        let detail = '';
        child.stderr.setEncoding('utf8').on('data',chunk=>{detail = (detail+chunk).slice(-2048);});
        const lines = createInterface({input:child.stdout});
        lines.on('line',line=>{
            try {
                const {port,updated,delivery,complete,websocketRejected,peer} = JSON.parse(line);
                if (updated !== undefined && this.control.has(updated)) {
                    this.control.get(updated).resolve();
                } else if (!this.ready && Number.isInteger(port) && port>=1 && port<=65535) {
                    ready.resolve(port);
                } else if (Number.isSafeInteger(delivery) && typeof complete==='boolean') {
                    this.finishDelivery(delivery,complete);
                } else if (['missing-proxy-user','untrusted-peer','foreign-origin'].includes(websocketRejected) && isIP(peer)) {
                    this.options.onWebSocketRejected?.(websocketRejected,peer);
                } else {
                    throw new Error('Некорректный ответ управления Rust HTTP');
                }
            } catch (error) {
                ready.reject(error);
                if (this.ready && !this.closing) this.onFailure(error);
            }
        });
        lines.on('error',ready.reject);
        this.exited = new Promise(resolve=>{
            child.once('close',(code,signal)=>{
                const error = new Error(detail.trim() || `Rust HTTP завершился (${signal || code})`);
                ready.reject(error);
                for (const pending of this.control.values()) pending.reject(error);
                for (const delivery of this.deliveries.keys()) this.finishDelivery(delivery,false);
                resolve();
                if (this.ready && !this.closing) this.onFailure(error);
            });
        });
        child.once('error',ready.reject);
        child.stdin.on('error',ready.reject);
        child.stdin.write(JSON.stringify({
            host:config.server.host,port:Number(config.server.port),upstreamPort:this.listener.address().port,
            key:this.key,...routes,version:config.version,uptime:process.uptime(),opdsPath:config.opdsRoot,files:this.files,
            websocket:options.websocket,
            assets:options.assets && config.publicDir ? {
                directory:resolve(config.publicDir),prefix:config.rootPathStatic || '',appDirectory,
                metricsPath:config.metricsPath || '/metrics',
                opdsPath:config.opdsRoot,
            } : undefined,
            headerBytes:this.http.maxHeaderSize || maxHeaderSize,headerCount:this.http.maxHeadersCount || 2000,
            headerTimeoutMs:this.http.headersTimeout,
        })+'\n');
        const timeout = setTimeout(()=>ready.reject(new Error('Истекло время запуска Rust HTTP')),10_000);
        try {
            this.port = await ready.promise;
            this.approvedAccess = routes.requestAccess?.revision;
            this.ready = true;
            this.http.emit('listening');
        } finally {clearTimeout(timeout);}
    }

    finishDelivery(id,complete) {
        const callback = this.deliveries.get(id);
        this.deliveries.delete(id);
        callback?.(complete);
    }

    directRoutes() {
        const active = !this.pauses && !this.config.logQueries;
        const proxy = String(this.config.authMode || '').trim().toLowerCase()==='proxy';
        const opdsRoot = this.config.opdsRoot?.toLowerCase().replace(/\/+$/,'');
        return {
            health:!!(active && this.options.health && this.config.authExemptHealth!==false
                && (opdsRoot===undefined || opdsRoot!=='' && opdsRoot!=='/health')),
            serveAssets:!!(active && this.options.assets),
            assetGate:proxy && !!(this.config.requireAuth || this.config.proxyBindProfile),
            websocketRequests:this.options.websocketRequests ? require('./RequestLimits').websocketLimits(this.config) : undefined,
            requestAccess:active ? this.options.requestAccess?.() : undefined,
        };
    }

    wireRoutes(direct,revision) {
        return {...direct,requestAccess:direct.requestAccess ? {...direct.requestAccess,revision} : undefined};
    }

    applyDirectRoutes() {
        const apply = () => this.setDirectRoutes(this.directRoutes());
        return this.routeUpdate = (this.routeUpdate || Promise.resolve()).then(apply,apply);
    }

    async setDirectRoutes(direct) {
        if (this.closing || isDeepStrictEqual(direct,this.direct)) return;
        const id = ++this.sequence;
        const routes = this.wireRoutes(direct,id);
        // Approvals already on the private connection must be checked against
        // the current application settings once a policy transition begins.
        this.approvedAccess = undefined;
        const pending = Promise.withResolvers();
        const timeout = setTimeout(()=>pending.reject(new Error('Истекло время применения настройки Rust HTTP')),5000);
        this.control.set(id,pending);
        this.child.stdin.write(JSON.stringify({id,...routes})+'\n',error=>{if (error) pending.reject(error);});
        try {
            await pending.promise;
            this.direct = direct;
            this.approvedAccess = routes.requestAccess?.revision;
        } catch (error) {
            if (!this.closing) this.onFailure(error);
            throw error;
        } finally {
            clearTimeout(timeout);
            this.control.delete(id);
        }
    }

    stop() {
        return this.closing ||= (async()=>{
            const kill = setTimeout(()=>this.child?.kill(),2000);
            try {
                this.child?.stdin.end();
                this.http.close(()=>{});
                for (const socket of this.sockets) socket.destroy();
                await Promise.all([
                    this.exited,
                    new Promise(resolve=>this.listener.close(()=>resolve())),
                ]);
            } finally {clearTimeout(kill);}
        })();
    }
}

function bindPeer(socket,http,key,transport) {
    const expected = Buffer.from(key,'ascii');
    const deny = ()=>socket.destroy();
    let preface = Buffer.alloc(0);
    socket.on('error',deny);
    socket.setTimeout(5000,deny);
    const receive = chunk=>{
        const data = preface.length ? Buffer.concat([preface,chunk]) : chunk;
        const end = data.indexOf(10);
        if (end<0 && data.length<=prefaceLimit) {
            preface = data;
            return;
        }
        if (end<0 || end>prefaceLimit) return deny();
        const pieces = data.toString('latin1',0,end).split(' ');
        if (pieces.length!==4) return deny();
        const [protocol,secret,address,port] = pieces;
        const family = isIP(address);
        if (protocol!=='INPX1' || !family || !/^\d{1,5}$/.test(port)
            || Number(port)<1 || Number(port)>65535 || secret.length!==expected.length
            || !timingSafeEqual(Buffer.from(secret,'latin1'),expected)) return deny();

        // An upstream connection is dedicated to one public peer, including its WebSocket upgrades.
        socket.pause();
        socket.removeListener('data',receive);
        socket.removeListener('timeout',deny);
        socket.setTimeout(0);
        preface = null;
        Object.defineProperties(socket,{
            remoteAddress:{value:address},remotePort:{value:Number(port)},remoteFamily:{value:`IPv${family}`},
            [nativePeer]:{value:transport},
        });
        if (end+1<data.length) socket.unshift(data.subarray(end+1));
        http.emit('connection',socket);
        socket.resume();
    };
    socket.on('data',receive);
}

async function start(http,config,options) {
    const binary = programs.executable('server');
    if (!binary) return null;
    const transport = new RustHttpServer(http,options.onFailure);
    try {
        await transport.start(binary,config,options);
        transports.set(config,transport);
        return transport;
    } catch (error) {
        await transport.stop();
        throw error;
    }
}

async function pauseDirectRoutes(config,patch) {
    const transport = transports.get(config);
    if (!transport || !patch || !['authExemptHealth','authMode','requireAuth','proxyBindProfile','logQueries',
        'wsMessageLimitMb','importLimitMb','backupUploadLimitMb','trustProxy','trustedProxyCidrs','proxyAuthHeader',
        'metricsEnabled','metricsPath','metricsExemptAuth','metricsToken','absEnabled','absToken','rootPathStatic'].some(key=>Object.hasOwn(patch,key))) return;
    transport.pauses = (transport.pauses || 0) + 1;
    try {
        await transport.applyDirectRoutes();
    } catch (error) {
        transport.pauses--;
        throw error;
    }
    return () => {
        transport.pauses--;
        return transport.applyDirectRoutes();
    };
}

function assetProbe(req,res,next) {
    if (!req.socket[nativePeer] || req.headers[assetProbeHeader]!=='1') return next();
    res.setHeader(assetProbeHeader,'1');
    res.statusCode = 204;
    res.end();
}

function opdsModelRequested(req) {
    return !!req.socket?.[nativePeer] && req.headers['x-inpx-opds-model']==='1';
}

function isWebSocketBridge(req) {
    return !!req.socket?.[nativePeer] && req.headers.upgrade === 'inpx-websocket';
}

function acceptAccess(req,protocol) {
    const marker = req.headers?.[accessHeader];
    if (marker === undefined) return false;
    delete req.headers[accessHeader];
    const revision = req.socket?.[nativePeer]?.approvedAccess;
    return revision !== undefined && marker === `${revision}:${protocol}`;
}

function deliverFile(req,res,kind,file,complete) {
    const transport = req.socket?.[nativePeer];
    const directory = transport?.files?.[kind];
    if (!directory || req.headers[fileHeader]!=='1' || transport.closing) return false;
    const name = relative(directory,resolve(file));
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,239}$/.test(name) || name.endsWith('.')) return false;
    if (kind==='batch' && !/^batch-[0-9a-f]{64}\.zip$/.test(name)) return false;
    if (res.destroyed || res.headersSent) return false;
    let delivery;
    if (complete) {
        if (transport.deliveries.size >= 4096) return false;
        delivery = ++transport.sequence;
        transport.deliveries.set(delivery,complete);
        res.once('close',()=>{if (!res.writableFinished) transport.finishDelivery(delivery,false);});
    }
    const model = Buffer.from(JSON.stringify({kind,name,delivery}));
    res.set(fileHeader,'1');
    res.set('Content-Length',String(model.length));
    res.end(model);
    return true;
}

module.exports = {start,pauseDirectRoutes,assetProbe,opdsModelRequested,deliverFile,isWebSocketBridge,acceptAccess,binaryName};
