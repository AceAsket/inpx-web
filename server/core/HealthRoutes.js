const os = require('os');

function noStore(res) {
    res.set('Cache-Control', 'no-store');
}

function statusCode(ok) {
    return ok ? 200 : 503;
}

function metricNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function labelValue(value = '') {
    return String(value || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(data = {}) {
    const entries = Object.entries(data).filter(([, value]) => value !== undefined && value !== null);
    if (!entries.length)
        return '';

    return `{${entries.map(([key, value]) => `${key}="${labelValue(value)}"`).join(',')}}`;
}

function addMetric(lines, name, help, type, samples = []) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const sample of samples) {
        lines.push(`${name}${labels(sample.labels)} ${metricNumber(sample.value)}`);
    }
}

function adminEventCounts(webWorker) {
    const counts = new Map();
    const events = (webWorker.config.adminEventLogEnabled === false ? [] : webWorker.adminEvents || []);
    for (const event of events) {
        const level = String(event.level || 'info').toLowerCase();
        const category = String(event.category || 'system').toLowerCase();
        const key = `${level}\t${category}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    return Array.from(counts.entries()).map(([key, value]) => {
        const [level, category] = key.split('\t');
        return {labels: {level, category}, value};
    });
}

async function buildMetrics(config, webWorker, security = null, webSocketController = null) {
    const index = await webWorker.getIndexStatus();
    const stats = index.stats || {};
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const loadAverage = os.loadavg();
    const dbSize = await webWorker.dirSize(`${config.dataDir}/db`);
    const bookCacheSize = await webWorker.dirSize(config.bookDir);
    const coverCacheSize = await webWorker.dirSize(config.coverDir || `${config.publicFilesDir}/cover`);
    const sources = Array.isArray(config.librarySources) ? config.librarySources : [];
    const enabledSources = sources.filter(source => source.enabled !== false);
    const loginMetrics = security && security.getLoginMetrics ? security.getLoginMetrics() : null;
    const onlineMetrics = webSocketController && webSocketController.getOnlineMetrics
        ? webSocketController.getOnlineMetrics()
        : {clients: 0, users: 0, anonymousClients: 0};
    const lines = [];

    addMetric(lines, 'inpx_web_build_info', 'Application build information.', 'gauge', [{
        labels: {version: config.version || '', branch: config.branch || ''},
        value: 1,
    }]);
    addMetric(lines, 'inpx_web_uptime_seconds', 'Process uptime in seconds.', 'gauge', [{value: process.uptime()}]);
    addMetric(lines, 'inpx_web_memory_rss_bytes', 'Resident set size in bytes.', 'gauge', [{value: memory.rss}]);
    addMetric(lines, 'inpx_web_memory_heap_used_bytes', 'Used V8 heap in bytes.', 'gauge', [{value: memory.heapUsed}]);
    addMetric(lines, 'inpx_web_process_cpu_user_seconds_total', 'Total user CPU time spent by the process.', 'counter', [{value: cpu.user / 1000000}]);
    addMetric(lines, 'inpx_web_process_cpu_system_seconds_total', 'Total system CPU time spent by the process.', 'counter', [{value: cpu.system / 1000000}]);
    addMetric(lines, 'inpx_web_process_cpu_seconds_total', 'Total CPU time spent by the process.', 'counter', [{value: (cpu.user + cpu.system) / 1000000}]);
    addMetric(lines, 'inpx_web_load_average_1m', 'System load average for the last minute.', 'gauge', [{value: loadAverage[0]}]);
    addMetric(lines, 'inpx_web_load_average_5m', 'System load average for the last 5 minutes.', 'gauge', [{value: loadAverage[1]}]);
    addMetric(lines, 'inpx_web_load_average_15m', 'System load average for the last 15 minutes.', 'gauge', [{value: loadAverage[2]}]);
    addMetric(lines, 'inpx_web_index_ready', 'Whether the search index is ready.', 'gauge', [{value: index.ready ? 1 : 0}]);
    addMetric(lines, 'inpx_web_index_progress', 'Current indexing progress from 0 to 1.', 'gauge', [{value: metricNumber(index.progress)}]);
    addMetric(lines, 'inpx_web_index_records_loaded', 'Records loaded while indexing.', 'gauge', [{value: index.recsLoaded || stats.recsLoaded || 0}]);
    addMetric(lines, 'inpx_web_books_total', 'Indexed non-deleted books.', 'gauge', [{value: stats.bookCount || 0}]);
    addMetric(lines, 'inpx_web_authors_total', 'Indexed non-empty authors.', 'gauge', [{value: stats.authorCount || 0}]);
    addMetric(lines, 'inpx_web_series_total', 'Indexed series.', 'gauge', [{value: stats.seriesCount || 0}]);
    addMetric(lines, 'inpx_web_files_total', 'Indexed non-deleted files.', 'gauge', [{value: stats.filesCount || 0}]);
    addMetric(lines, 'inpx_web_db_size_bytes', 'Search database directory size in bytes.', 'gauge', [{value: dbSize.size}]);
    addMetric(lines, 'inpx_web_book_cache_size_bytes', 'Prepared book cache size in bytes.', 'gauge', [{value: bookCacheSize.size}]);
    addMetric(lines, 'inpx_web_book_cache_limit_bytes', 'Prepared book cache limit in bytes.', 'gauge', [{value: config.bookCacheSize || config.maxFilesDirSize || 0}]);
    addMetric(lines, 'inpx_web_cover_cache_size_bytes', 'Cover cache size in bytes.', 'gauge', [{value: coverCacheSize.size}]);
    addMetric(lines, 'inpx_web_cover_cache_limit_bytes', 'Cover cache limit in bytes.', 'gauge', [{value: config.coverCacheSize || 0}]);
    addMetric(lines, 'inpx_web_cover_cache_files', 'Cover cache file count.', 'gauge', [{value: coverCacheSize.files}]);
    addMetric(lines, 'inpx_web_library_sources_total', 'Configured library sources by enabled state.', 'gauge', [
        {labels: {enabled: 'true'}, value: enabledSources.length},
        {labels: {enabled: 'false'}, value: sources.length - enabledSources.length},
    ]);
    addMetric(lines, 'inpx_web_admin_events_total', 'Admin event log entries by level and category.', 'gauge', adminEventCounts(webWorker));
    addMetric(lines, 'inpx_web_ws_clients', 'Active WebSocket clients.', 'gauge', [{value: onlineMetrics.clients}]);
    addMetric(lines, 'inpx_web_users_online', 'Distinct authorized user profiles with active WebSocket sessions.', 'gauge', [{value: onlineMetrics.users}]);
    addMetric(lines, 'inpx_web_ws_anonymous_clients', 'Active WebSocket clients without an authorized user profile.', 'gauge', [{value: onlineMetrics.anonymousClients}]);
    addMetric(lines, 'inpx_web_login_attempts_total', 'Login and access attempts by kind and result.', 'counter', loginMetrics ? loginMetrics.attempts : []);
    addMetric(lines, 'inpx_web_login_rate_limit_enabled', 'Whether internal login rate limiting is enabled.', 'gauge', [{value: !loginMetrics || loginMetrics.enabled ? 1 : 0}]);
    addMetric(lines, 'inpx_web_login_failed_attempts_active', 'Failed login/access attempts currently kept in the rate-limit window.', 'gauge', [{value: loginMetrics ? loginMetrics.activeFailedAttempts : 0}]);
    addMetric(lines, 'inpx_web_login_rate_limited_ips', 'Client IP buckets currently blocked by login rate limiting.', 'gauge', [{value: loginMetrics ? loginMetrics.rateLimitedIps : 0}]);

    lines.push('');
    return lines.join('\n');
}

function metricsAuthorized(req, config, security) {
    if (!security)
        return !config.metricsToken;

    if (security.hasValidMetricsToken(req))
        return true;

    if (config.metricsToken)
        return false;

    return true;
}

module.exports = function initHealthRoutes(app, config, webWorker, security = null, webSocketController = null) {
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

    const metricsPath = config.metricsPath || '/metrics';
    app.get(metricsPath, async(req, res) => {
        noStore(res);
        if (!config.metricsEnabled) {
            res.sendStatus(404);
            return;
        }

        if (!metricsAuthorized(req, config, security)) {
            res.status(401).send('Metrics token required');
            return;
        }

        res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(await buildMetrics(config, webWorker, security, webSocketController));
    });
};
