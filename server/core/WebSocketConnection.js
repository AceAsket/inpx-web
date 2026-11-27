const isBrowser = (typeof window !== 'undefined');

const utils = {
    sleep: (ms) => { return new Promise(resolve => setTimeout(resolve, ms)); }
};

const cleanPeriod = 5*1000;//5 секунд

class WebSocketConnection {
    //messageLifeTime в секундах (проверка каждый cleanPeriod интервал)
    constructor(url, openTimeoutSecs = 10, messageLifeTimeSecs = 30, webSocketOptions = {}) {
        this.WebSocket = (isBrowser ? WebSocket : require('ws'));
        this.url = url;
        this.webSocketOptions = webSocketOptions;

        this.ws = null;

        this.listeners = [];
        this.observers = new Set();
        this.messageQueue = [];
        this.messageLifeTime = messageLifeTimeSecs*1000;
        this.openTimeout = openTimeoutSecs*1000;
        this.requestId = 0;

        this.wsErrored = false;
        this.closed = false;

        this.connecting = false;
        this._openPromise = null;
        this._abortOpen = null;
        this.periodicClean();//no await
    }

    //рассылаем сообщение и удаляем те обработчики, которые его получили
    emit(mes, isError) {
        const len = this.listeners.length;
        let delivered = false;
        if (len > 0) {
            let newListeners = [];
            for (const listener of this.listeners) {
                let emitted = false;
                if (isError) {
                    listener.onError(mes);
                    emitted = true;
                    delivered = true;
                } else {
                    if ( (listener.requestId && mes.requestId && listener.requestId === mes.requestId) ||
                        (!listener.requestId && !mes.requestId) ) {
                        emitted = listener.onMessage(mes) !== false;
                        delivered = true;
                    }
                }

                if (!emitted)
                    newListeners.push(listener);
            }
            this.listeners = newListeners;
        }
        
        return delivered;
    }

    get isOpen() {
        return (this.ws && this.ws.readyState == this.WebSocket.OPEN);
    }

    observe(observer) {
        this.observers.add(observer);
        return () => this.observers.delete(observer);
    }

    notify(event, ...args) {
        for (const observer of this.observers) {
            try {observer[event]?.(...args);} catch (_) { /* The socket can outlive a view. */ }
        }
    }

    processMessageQueue() {
        let newMessageQueue = [];
        for (const message of this.messageQueue) {
            if (!this.emit(message.mes)) {
                newMessageQueue.push(message);
            }
        }

        this.messageQueue = newMessageQueue;
    }

    _open() {
        if (this.closed)
            return Promise.reject(new Error('Этот экземпляр класса уничтожен. Пожалуйста, создайте новый.'));

        if (this.isOpen)
            return Promise.resolve(this.ws);

        if (this._openPromise)
            return this._openPromise;

        this.terminate();

        let openPromise = null;
        let settled = false;
        let openTimer = null;
        let rejectOpen = null;
        const abortOpen = (reason) => {
            if (rejectOpen) rejectOpen(reason);
        };
        const clearOpenState = () => {
            if (openTimer) {
                clearTimeout(openTimer);
                openTimer = null;
            }
            this.connecting = false;
            if (this._openPromise === openPromise) this._openPromise = null;
            if (this._abortOpen === abortOpen) this._abortOpen = null;
        };

        this.connecting = true;
        this._abortOpen = abortOpen;
        openPromise = new Promise((resolve, reject) => {
            const finishResolve = (value) => {
                if (settled) return;
                settled = true;
                clearOpenState();
                resolve(value);
            };
            const finishReject = (error) => {
                if (settled) return;
                settled = true;
                clearOpenState();
                reject(error);
            };
            rejectOpen = finishReject;

            let socket;
            try {
                if (isBrowser) {
                    const protocol = (window.location.protocol == 'https:' ? 'wss:' : 'ws:');
                    const url = this.url || `${protocol}//${window.location.host}/ws`;
                    socket = new this.WebSocket(url);
                } else {
                    socket = new this.WebSocket(this.url, this.webSocketOptions);
                }
            } catch (error) {
                finishReject(error);
                return;
            }
            this.ws = socket;

            openTimer = setTimeout(() => {
                finishReject(new Error('Соединение не удалось'));
                if (this.ws === socket) this.terminate();
            }, this.openTimeout);
            openTimer.unref?.();

            const onopen = () => {
                finishResolve(socket);
                this.notify('open', socket);
            };

            const onmessage = (data) => {
                try {
                    if (isBrowser)
                        data = data.data;
                    const mes = JSON.parse(data);
                    if (mes?.type === 'client-event' && !mes.requestId) {
                        this.notify('event', mes, socket);
                        return;
                    }
                    this.messageQueue.push({regTime: Date.now(), mes});

                    this.processMessageQueue();
                } catch (e) {
                    this.emit(e.message, true);
                }
            };

            let disconnected = false;
            const onDisconnect = (event) => {
                if (this.ws && this.ws !== socket) return;
                if (disconnected) return;
                disconnected = true;
                const message = event?.message || 'Соединение с библиотекой по WebSocket не установлено или прервалось.';
                this.emit(message, true);
                this.notify('close', socket);
                finishReject(new Error(message));
            };

            try {
                if (isBrowser) {
                    socket.onopen = onopen;
                    socket.onmessage = onmessage;
                    socket.onerror = onDisconnect;
                    socket.onclose = onDisconnect;
                } else {
                    socket.on('open', onopen);
                    socket.on('message', onmessage);
                    socket.on('error', onDisconnect);
                    socket.on('close', onDisconnect);
                }
            } catch (error) {
                finishReject(error);
                if (this.ws === socket) this.terminate();
            }
        });
        if (!settled) this._openPromise = openPromise;
        return openPromise;
    }

    //timeout в секундах (проверка каждый cleanPeriod интервал)
    message(requestId, timeoutSecs = 4, onProgress = null) {
        return new Promise((resolve, reject) => {
            const listener = {
                regTime: Date.now(),
                requestId,
                timeout: timeoutSecs*1000,
                onMessage: (mes) => {
                    if (mes._progress) {
                        listener.regTime = Date.now();
                        try {onProgress?.(mes.progress);} catch (_) { /* Ignore observers detached from their view. */ }
                        return false;
                    }
                    resolve(mes);
                },
                onError: (mes) => {
                    reject(new Error(mes));
                }
            };
            this.listeners.push(listener);
            
            this.processMessageQueue();
        });
    }

    async send(req, timeoutSecs = 4) {
        await this._open();
        if (this.isOpen) {
            this.requestId = (this.requestId < 1000000 ? this.requestId + 1 : 1);
            const requestId = this.requestId;//реентерабельность!!!

            this.ws.send(JSON.stringify(Object.assign({requestId}, req)));

            let resp = {};
            try {
                resp = await this.message(requestId, timeoutSecs);
            } catch(e) {
                if (!this.isOpen) this.terminate();
                throw new Error('WebSocket не отвечает');
            }

            if (resp._rok) {                
                return requestId;
            } else {
                throw new Error('Запрос не принят сервером');
            }
        } else {
            throw new Error('WebSocket коннект закрыт');
        }
    }

    terminate() {
        const ws = this.ws;
        this.ws = null;
        if (this._abortOpen)
            this._abortOpen(new Error('Соединение с библиотекой по WebSocket не установлено или прервалось.'));
        this._openPromise = null;
        this.connecting = false;
        if (ws) {
            try {
                if (isBrowser) {
                    ws.close();
                } else {
                    ws.terminate();
                }
            } catch (_) { /* Socket may already be closed. */ }
        }
    }

    close() {
        this.closed = true;
        this.terminate();
    }

    async periodicClean() {
        while (!this.closed) {
            try {
                const now = Date.now();
                //чистка listeners
                let newListeners = [];
                for (const listener of this.listeners) {
                    if (now - listener.regTime < listener.timeout) {
                        newListeners.push(listener);
                    } else {
                        if (listener.onError)
                            listener.onError('Время ожидания ответа истекло');
                    }
                }
                this.listeners = newListeners;

                //чистка messageQueue
                let newMessageQueue = [];
                for (const message of this.messageQueue) {
                    if (now - message.regTime < this.messageLifeTime) {
                        newMessageQueue.push(message);
                    }
                }
                this.messageQueue = newMessageQueue;
            } catch(e) {
                //
            }

            await utils.sleep(cleanPeriod);
        }
    }
}

module.exports = WebSocketConnection;
