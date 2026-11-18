function watchReaderEvents(connection, subscribe, refresh, expired) {
    const stop = new AbortController();
    let socket, pending = false, timer, delay = 250;

    function schedule(wait) {
        if (stop.signal.aborted || pending || timer) return;
        timer = setTimeout(connect, wait);
    }

    async function connect() {
        timer = null;
        if (stop.signal.aborted) return;
        pending = true;
        let retry = false;
        try {
            const result = await subscribe(stop.signal);
            if (stop.signal.aborted) return;
            if (connection.isOpen) {
                socket = connection.ws;
                delay = 250;
                if (result.enabled) refresh();
            } else retry = true;
        } catch (error) {
            if (stop.signal.aborted) return;
            if (['need_profile_login', 'need_access_token', 'Профиль недоступен'].includes(error.message)) {
                expired();
                cleanup();
                return;
            }
            retry = true;
        } finally {
            pending = false;
            if (retry) {
                schedule(delay);
                delay = Math.min(5000, delay * 2);
            }
        }
    }

    const remove = connection.observe({
        open(next) {if (next !== socket) schedule(0);},
        close() {
            socket = null;
            schedule(delay);
        },
        event(message, source) {
            if (source === socket && message.kind === 'reader') refresh();
        },
    });
    schedule(0);

    function cleanup() {
        stop.abort();
        clearTimeout(timer);
        remove();
    }
    return cleanup;
}

module.exports = {watchReaderEvents};
