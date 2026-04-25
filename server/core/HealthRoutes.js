function noStore(res) {
    res.set('Cache-Control', 'no-store');
}

function statusCode(ok) {
    return ok ? 200 : 503;
}

module.exports = function initHealthRoutes(app, config, webWorker) {
    app.get('/health', (req, res) => {
        noStore(res);
        res.status(statusCode(config.server.ready)).json({
            status: config.server.ready ? 'ok' : 'starting',
            ready: !!config.server.ready,
            version: config.version,
            uptime: process.uptime(),
        });
    });

    app.get('/ready', async(req, res) => {
        noStore(res);
        const index = await webWorker.getIndexStatus();
        const ok = !!(config.server.ready && index.ready);
        res.status(statusCode(ok)).json({
            status: ok ? 'ready' : 'not_ready',
            ready: ok,
            serverReady: !!config.server.ready,
            indexReady: !!index.ready,
            state: index.state,
            serverMessage: index.serverMessage,
            jobMessage: index.jobMessage,
            progress: index.progress,
            recsLoaded: index.recsLoaded,
            version: config.version,
        });
    });

    app.get('/api/index-status', async(req, res) => {
        noStore(res);
        const index = await webWorker.getIndexStatus();
        res.json(Object.assign({
            serverReady: !!config.server.ready,
            version: config.version,
        }, index));
    });
};
