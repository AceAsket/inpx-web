const {EventEmitter} = require('node:events');
const WebSocket = require('ws');
const {isWebSocketBridge} = require('./RustHttpServer');

const text = 1, binary = 2, request = 3, close = 8, complete = 9, terminate = 10, peerClosed = 11;
const headerSize = 5;
const requestPrefix = 9;
const empty = Buffer.alloc(0);

class BridgeClient extends EventEmitter {
    constructor(socket,maxPayload) {
        super();
        this.socket = socket;
        this.maxPayload = maxPayload;
        this.readyState = WebSocket.OPEN;
        socket.on('readable',() => this.read());
        socket.on('error',error => {if (this.listenerCount('error')) this.emit('error',error);});
        socket.once('close',() => this.markClosed());
    }

    read() {
        while (!this.socket.destroyed) {
            const header = this.header ||= this.socket.read(headerSize);
            if (!header) return;
            if (header.length !== headerSize) return this.socket.destroy();
            const kind = header[0], size = header.readUInt32LE(1);
            if (kind === request ? size < requestPrefix || size > this.maxPayload + requestPrefix
                : kind === peerClosed ? size !== 0 : (kind !== text && kind !== binary) || size > this.maxPayload)
                return this.socket.destroy();
            const payload = size ? this.socket.read(size) : empty;
            if (!payload) return;
            if (payload.length !== size) return this.socket.destroy();
            this.header = null;
            if (kind === peerClosed) this.markClosed();
            else if (kind === request) this.receiveRequest(payload);
            else if (this.readyState === WebSocket.OPEN) this.emit('message',payload,kind === binary);
        }
    }

    receiveRequest(payload) {
        const validation = payload[8];
        if (validation > 2) return this.socket.destroy();
        const ticket = Buffer.from(payload.subarray(0,8));
        const done = () => {if (!this.socket.destroyed) this.write(complete,ticket);};
        if (this.readyState === WebSocket.OPEN) this.emit('message',payload.subarray(requestPrefix),false,{validation,complete:done});
        else done();
    }

    markClosed() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.emit('close');
    }

    write(kind,payload) {
        const header = Buffer.allocUnsafe(headerSize);
        header[0] = kind;
        header.writeUInt32LE(payload.length,1);
        this.socket.cork();
        this.socket.write(header);
        if (payload.length) this.socket.write(payload);
        this.socket.uncork();
    }

    send(payload, options = {}) {
        if (this.readyState !== WebSocket.OPEN) return;
        const isBinary = options.binary ?? typeof payload !== 'string';
        this.write(isBinary ? binary : text, Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    }

    close(code,reason = '') {
        if (this.readyState !== WebSocket.OPEN) return;
        let payload = empty;
        if (code !== undefined) {
            const message = Buffer.from(reason);
            if (message.length > 123) throw new RangeError('Invalid WebSocket close reason');
            payload = Buffer.allocUnsafe(message.length + 2);
            payload.writeUInt16BE(code);
            message.copy(payload,2);
        }
        this.readyState = WebSocket.CLOSING;
        this.write(close,payload);
    }

    terminate() {
        if (this.readyState !== WebSocket.OPEN) return;
        this.readyState = WebSocket.CLOSING;
        this.write(terminate,empty);
    }
}

function attach(server,{maxPayload,verify}) {
    const listener = new EventEmitter();
    listener.clients = new Set();
    const fallback = new WebSocket.Server({noServer:true,clientTracking:false,maxPayload,
        verifyClient:(info,done) => done(verify(info.req),403,'Forbidden')});
    let closed = false;
    const connected = (client,req) => {
        listener.clients.add(client);
        client.once('close',() => listener.clients.delete(client));
        listener.emit('connection',client,req);
    };
    const upgrade = (req,socket,head) => {
        if (!isWebSocketBridge(req)) return fallback.handleUpgrade(req,socket,head,connected);
        if (!verify(req)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 9\r\n\r\nForbidden');
            return;
        }
        if (head.length) socket.unshift(head);
        socket.setNoDelay(true);
        const client = new BridgeClient(socket,maxPayload);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: inpx-websocket\r\nConnection: Upgrade\r\n\r\n');
        connected(client,req);
    };
    listener.close = () => {
        if (closed) return;
        closed = true;
        server.off('upgrade',upgrade);
        server.off('close',listener.close);
        fallback.close();
        listener.emit('close');
    };
    server.on('upgrade',upgrade);
    server.once('close',listener.close);
    return listener;
}

module.exports = {attach};
