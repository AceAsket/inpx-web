const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MiB = 1024 * 1024;
const profiles = {
    economy: {name:'Бережный', total:2, images:1, reviews:2, conversions:1, background:1},
    balanced: {name:'Сбалансированный', total:4, images:2, reviews:4, conversions:2, background:1},
    performance: {name:'Производительный', total:6, images:3, reviews:6, conversions:3, background:2},
};

function read(file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { return ''; }
}

function finite(value) {
    const n = Number(value);
    return value !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

function cgroupDirectory(readFile, controller = '') {
    const rows = readFile('/proc/self/cgroup').split('\n');
    const row = rows.find(line => controller ? line.split(':')[1]?.split(',').includes(controller) : line.startsWith('0::'));
    const group = row?.split(':').slice(2).join(':');
    if (!group) return null;
    const marker = controller === 'memory' ? 'memory.usage_in_bytes' : controller === 'cpu' ? 'cpu.cfs_period_us'
        : controller === 'cpuacct' ? 'cpuacct.usage' : 'memory.current';
    for (const line of readFile('/proc/self/mountinfo').split('\n')) {
        const [left, right = ''] = line.split(' - '), metadata = right.split(' ');
        if (controller ? metadata[0] !== 'cgroup' || !metadata.slice(2).join(',').split(',').includes(controller) : metadata[0] !== 'cgroup2') continue;
        const fields = left.split(' '), decode = value => value.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
        const root = decode(fields[3]), mount = decode(fields[4]);
        const relative = path.posix.relative(root, group);
        if (relative.startsWith('..')) continue;
        const directory = path.posix.join(mount, relative);
        if (readFile(path.posix.join(directory, marker)) !== '') return {directory, mount};
    }
    const mount = controller ? '/sys/fs/cgroup/' + controller : '/sys/fs/cgroup';
    return readFile(path.posix.join(mount, marker)) !== '' ? {directory:mount, mount} : null;
}

function walkGroup(group, callback) {
    if (!group) return;
    let directory = group.directory;
    for (;;) {
        callback(directory);
        if (directory === group.mount) return;
        const parent = path.posix.dirname(directory);
        if (parent === directory || (parent !== group.mount && !parent.startsWith(group.mount + '/'))) return;
        directory = parent;
    }
}

function hardware(options = {}) {
    const readFile = options.read || read, exists = options.exists || fs.existsSync;
    const platform = options.platform || process.platform;
    const cpus = Math.max(1, os.availableParallelism());
    let cpu = cpus, memoryLimit = os.totalmem(), memoryUsed = process.memoryUsage().rss;
    let memoryAvailable = Math.min(os.freemem(), process.availableMemory() || Infinity);
    const constrained = process.constrainedMemory();
    if (constrained > 0) memoryLimit = Math.min(memoryLimit, constrained);
    const v2 = platform === 'linux' ? cgroupDirectory(readFile) : null;
    const memoryGroup = v2 || (platform === 'linux' ? cgroupDirectory(readFile, 'memory') : null);
    const cpuGroup = v2 || (platform === 'linux' ? cgroupDirectory(readFile, 'cpu') : null);
    let cpuUsageUs = null, throttledUs = null;
    const memoryName = v2 ? 'memory.current' : 'memory.usage_in_bytes';
    if (memoryGroup) {
        memoryUsed = finite(readFile(path.posix.join(memoryGroup.directory, memoryName)));
        walkGroup(memoryGroup, directory => {
            const max = finite(readFile(path.posix.join(directory, v2 ? 'memory.max' : 'memory.limit_in_bytes')));
            const used = finite(readFile(path.posix.join(directory, memoryName)));
            if (max !== null && max > 0) {
                memoryLimit = Math.min(memoryLimit, max);
                if (used !== null) memoryAvailable = Math.min(memoryAvailable, Math.max(0, max - used));
            }
        });
    }
    if (cpuGroup) {
        const stat = Object.fromEntries(readFile(path.posix.join(cpuGroup.directory, 'cpu.stat')).split('\n').map(line => line.split(/\s+/)));
        const throttled = finite((v2 ? stat.throttled_usec : stat.throttled_time) || '');
        throttledUs = throttled === null ? null : throttled / (v2 ? 1 : 1000);
        cpuUsageUs = v2 ? finite(stat.usage_usec || '') : null;
        walkGroup(cpuGroup, directory => {
            const [quota, period] = v2 ? readFile(path.posix.join(directory, 'cpu.max')).split(/\s+/)
                : [readFile(path.posix.join(directory, 'cpu.cfs_quota_us')), readFile(path.posix.join(directory, 'cpu.cfs_period_us'))];
            if (finite(quota) > 0 && finite(period) > 0) cpu = Math.min(cpu, Number(quota) / Number(period));
        });
        if (!v2) {
            const accounting = cgroupDirectory(readFile, 'cpuacct') || cpuGroup;
            const usage = finite(readFile(path.posix.join(accounting.directory, 'cpuacct.usage')));
            if (usage !== null) cpuUsageUs = usage / 1000;
        }
    }
    const isolated = memoryGroup && (memoryGroup.directory !== memoryGroup.mount || memoryLimit < os.totalmem()
        || exists('/.dockerenv') || exists('/run/.containerenv'));
    return {cpu, affinityCpus:cpus, memoryLimit, memoryAvailable, memoryUsed,
        memoryScope:memoryGroup ? (isolated ? 'cgroup' : 'host') : 'process',
        cgroupVersion:v2 ? 'v2' : memoryGroup || cpuGroup ? 'v1' : 'none',
        cpuUsageUs, throttledUs, platform, architecture:process.arch};
}

function integer(env, name, fallback, min, max) {
    if (env[name] === undefined || env[name] === '') return fallback;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: expected an integer from ${min} to ${max}`);
    return n;
}

function resolve(env = process.env, machine = hardware()) {
    const requested = env.INPX_RESOURCE_PROFILE || 'auto';
    if (requested !== 'auto' && !Object.hasOwn(profiles, requested)) throw new Error('INPX_RESOURCE_PROFILE: auto, economy, balanced or performance required');
    const automatic = machine.cpu < 2 || machine.memoryLimit < 2 * 1024 * MiB ? 'economy' : 'balanced';
    const selected = requested === 'auto' ? automatic : requested;
    const estimated = Math.max(1, Math.min(8, Math.ceil(machine.cpu * 2), Math.floor((machine.memoryLimit * 0.7) / (256 * MiB))));
    const hardMax = integer(env, 'INPX_RESOURCE_MAX_PROCESSES', estimated, 1, 16);
    const overrides = {};
    for (const [key, variable] of Object.entries({images:'INPX_RESOURCE_IMAGES', reviews:'INPX_RESOURCE_REVIEWS', conversions:'INPX_RESOURCE_CONVERSIONS', background:'INPX_RESOURCE_BACKGROUND'})) {
        if (env[variable] !== undefined && env[variable] !== '') overrides[key] = integer(env, variable, 1, 1, 16);
    }
    const choices = Object.entries(profiles).map(([id, item]) => {
        const limits = {total:Math.min(item.total, hardMax, estimated)};
        for (const key of ['images','reviews','conversions','background']) limits[key] = Math.min(overrides[key] || item[key], limits.total);
        return {id, name:item.name, limits};
    });
    const current = choices.find(item => item.id === selected);
    const launchEnv = {};
    for (const name of ['INPX_RESOURCE_MAX_PROCESSES', 'INPX_RESOURCE_IMAGES', 'INPX_RESOURCE_REVIEWS',
        'INPX_RESOURCE_CONVERSIONS', 'INPX_RESOURCE_BACKGROUND', 'INPX_RESOURCE_TASK_TIMEOUT_MS', 'INPX_RESOURCE_BENCH_TIMEOUT_MS']) {
        if (env[name] !== undefined && env[name] !== '') launchEnv[name] = String(Number(env[name]));
    }
    if (env.INPX_RESOURCE_BENCH_ENABLED !== undefined) launchEnv.INPX_RESOURCE_BENCH_ENABLED = env.INPX_RESOURCE_BENCH_ENABLED === 'false' ? 'false' : 'true';
    return {requested, selected, automatic, limits:current.limits, hardMax, hardwareMax:estimated, overrides, profiles:choices,
        launchEnv,
        taskTimeoutMs:integer(env, 'INPX_RESOURCE_TASK_TIMEOUT_MS', 120000, 1000, 3600000),
        benchmarkTimeoutMs:integer(env, 'INPX_RESOURCE_BENCH_TIMEOUT_MS', 60000, 10000, 180000),
        benchmarkEnabled:env.INPX_RESOURCE_BENCH_ENABLED !== 'false'};
}

function fingerprint(config, policy, machine, source = {}) {
    return crypto.createHash('sha256').update(JSON.stringify({schema:1, cpu:machine.cpu,
        memory:machine.memoryLimit, platform:machine.platform, arch:machine.architecture, version:config.version,
        tools:config.converterPaths || {}, fb2cng:config.fb2cngVersion, conversionEnabled:config.conversionEnabled,
        node:process.versions.node, memoryScope:machine.memoryScope, cgroupVersion:machine.cgroupVersion,
        hardMax:policy.hardMax, overrides:policy.overrides,
        taskTimeoutMs:policy.taskTimeoutMs,
        source:[source.id, source.libDir]})).digest('hex');
}

function isResourceError(error) {
    return /^INPX_RESOURCE_|^INPX_CONVERSION_TIMEOUT$|^ABORT_ERR$/.test(error?.code || '');
}

module.exports = {resolve, hardware, fingerprint, isResourceError};
