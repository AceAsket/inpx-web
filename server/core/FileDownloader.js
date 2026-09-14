const axios = require('axios');

const userAgent = 'Mozilla/5.0 (X11; HasCodingOs 1.0; Linux x64) AppleWebKit/637.36 (KHTML, like Gecko) Chrome/70.0.3112.101 Safari/637.36 HasBrowser/5.0';

class FileDownloader {
    constructor(limitDownloadSize = 0) {
        this.limitDownloadSize = limitDownloadSize;
    }

    async load(url, opts = {}, callback, abort) {
        opts = opts || {};
        const controller = new AbortController();
        const options = {
            timeout: 300*1000,
            ...opts,
            headers: {'accept-encoding': 'gzip, compress, deflate', 'user-agent': userAgent, ...opts.headers},
            responseType: 'stream',
            signal: controller.signal,
        };
        let response;
        let failure;
        const cancel = message => {
            failure = failure || new Error(message);
            controller.abort();
            if (response)
                response.data.destroy(failure);
        };
        const onAbort = () => cancel('abort');
        const checkAbort = () => {
            try {
                if (abort && abort())
                    onAbort();
            } catch (error) {
                cancel(error.message);
            }
        };
        // Bound total duration as well as socket inactivity, including peers
        // sending an endless trickle. Cancellation also works before headers.
        const deadline = setTimeout(() => cancel('FileDownloader: timed out'), options.timeout > 0 ? options.timeout : 300*1000);
        const abortTimer = abort ? setInterval(checkAbort, 100) : null;
        if (opts.signal)
            opts.signal.addEventListener('abort', onAbort, {once: true});
        try {
            checkAbort();
            if (opts.signal && opts.signal.aborted)
                onAbort();
            response = await axios.get(url, options);
            const estimatedSize = Number(response.headers['content-length']) || 0;
            if (this.limitDownloadSize && estimatedSize > this.limitDownloadSize)
                throw new Error('Файл слишком большой');

            let transferred = 0;
            let previousProgress = 0;
            return await this.streamToBuffer(response.data, chunk => {
                transferred += chunk.length;
                if (this.limitDownloadSize && transferred > this.limitDownloadSize)
                    throw new Error('Файл слишком большой');
                const progress = Math.round(transferred/(estimatedSize || transferred + 200000)*100);
                if (progress !== previousProgress && callback)
                    callback(progress);
                previousProgress = progress;
                checkAbort();
                if (failure)
                    throw failure;
            }, opts.idleTimeout || 30*1000);
        } catch (error) {
            throw failure || error;
        } finally {
            clearTimeout(deadline);
            clearInterval(abortTimer);
            if (opts.signal)
                opts.signal.removeEventListener('abort', onAbort);
            if (response)
                response.data.destroy();
            controller.abort();
        }
    }

    async head(url, opts = {}) {
        const response = await axios.head(url, {
            timeout: 10*1000,
            ...opts,
            headers: {'user-agent': userAgent, ...opts.headers},
        });
        return response.headers;
    }

    streamToBuffer(stream, progress = () => {}, timeout = 30*1000) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let settled = false;
            let timer;
            const finish = error => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                stream.removeListener('data', onData);
                stream.removeListener('end', onEnd);
                stream.removeListener('aborted', onAborted);
                stream.removeListener('close', onClose);
                // A transport error can arrive after timeout/cancellation.
                if (stream.closed)
                    stream.removeListener('error', onError);
                else
                    stream.once('close', () => stream.removeListener('error', onError));
                if (error) {
                    stream.destroy();
                    reject(error);
                } else {
                    resolve(Buffer.concat(chunks));
                }
            };
            const resetTimer = () => {
                clearTimeout(timer);
                timer = setTimeout(() => finish(new Error('FileDownloader: timed out')), timeout);
            };
            const onData = chunk => {
                try {
                    progress(chunk);
                    if (!settled) {
                        chunks.push(chunk);
                        resetTimer();
                    }
                } catch (error) {
                    finish(error);
                }
            };
            const onEnd = () => finish();
            const onError = error => finish(error);
            const onAborted = () => finish(new Error('aborted'));
            const onClose = () => finish(new Error('Download closed before completion'));
            stream.on('data', onData);
            stream.once('end', onEnd);
            stream.on('error', onError);
            stream.once('aborted', onAborted);
            stream.once('close', onClose);
            resetTimer();
        });
    }
}

module.exports = FileDownloader;
