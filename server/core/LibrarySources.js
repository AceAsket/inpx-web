const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const utils = require('./utils');

function stableId(value, fallback = 'source') {
    const base = String(value || fallback)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 40);

    if (base)
        return base;

    return `${fallback}-${crypto.createHash('sha1').update(String(value || '')).digest('hex').substring(0, 8)}`;
}

function parseSourcesFromString(value = '') {
    const raw = String(value || '').trim();
    if (!raw)
        return [];

    if (raw[0] === '[' || raw[0] === '{') {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [parsed];
    }

    return raw
        .split(';')
        .map(item => item.trim())
        .filter(Boolean)
        .map((item, index) => {
            const parts = item.split('|').map(part => part.trim());
            if (parts.length >= 4) {
                return {
                    id: parts[0],
                    name: parts[1],
                    inpx: parts[2],
                    libDir: parts[3],
                };
            }

            if (parts.length >= 3) {
                return {
                    name: parts[0],
                    inpx: parts[1],
                    libDir: parts[2],
                };
            }

            return {
                id: `source-${index + 1}`,
                inpx: parts[0],
                libDir: parts[1] || '',
            };
        });
}

function sourcesFromEnv() {
    return parseSourcesFromString(process.env.INPX_LIBRARY_SOURCES || process.env.LIBRARY_SOURCES || '');
}

async function findSingleInpx(libDir) {
    const inpxFiles = [];
    await utils.findFiles((file) => {
        if (path.extname(file).toLowerCase() === '.inpx')
            inpxFiles.push(file);
    }, libDir, false);

    if (inpxFiles.length === 1)
        return inpxFiles[0];

    if (inpxFiles.length > 1)
        throw new Error(`Found more than one .inpx files: \n${inpxFiles.join('\n')}`);

    throw new Error(`No .inpx files found here: ${libDir}`);
}

function getConfiguredSources(config = {}) {
    const envSources = sourcesFromEnv();
    if (envSources.length)
        return envSources;

    if (Array.isArray(config.librarySources) && config.librarySources.length)
        return config.librarySources;

    return [];
}

async function normalizeSource(source, index, options = {}) {
    const requireExists = options.requireExists !== false;
    const rawInpx = String(source.inpx || source.inpxFile || '').trim();
    const rawLibDir = String(source.libDir || source.libraryDir || '').trim();
    const inpx = rawInpx ? path.resolve(rawInpx) : '';
    const libDir = rawLibDir ? path.resolve(rawLibDir) : (inpx ? path.dirname(inpx) : '');

    if (!libDir)
        throw new Error(`Library source #${index + 1}: libDir is empty`);

    if (requireExists && !await fs.pathExists(libDir))
        throw new Error(`Library source #${index + 1}: directory "${libDir}" not exists`);

    const resolvedInpx = inpx || await findSingleInpx(libDir);
    if (requireExists && !await fs.pathExists(resolvedInpx))
        throw new Error(`Library source #${index + 1}: file "${resolvedInpx}" not found`);

    const id = stableId(source.id || source.name || path.basename(resolvedInpx, path.extname(resolvedInpx)), `source-${index + 1}`);
    const name = String(source.name || '').trim() || path.basename(resolvedInpx, path.extname(resolvedInpx)) || id;

    return {
        id,
        name,
        inpx: resolvedInpx,
        inpxFile: resolvedInpx,
        libDir,
        enabled: source.enabled !== false,
    };
}

async function resolveLibrarySources(config, argv = {}) {
    if (config.remoteLib) {
        config.librarySources = [{
            id: 'remote',
            name: 'Remote library',
            inpx: config.inpxFile,
            inpxFile: config.inpxFile,
            libDir: config.libDir || config.dataDir,
            enabled: true,
            remote: true,
        }];
        return config.librarySources;
    }

    let sources = getConfiguredSources(config);
    if (!sources.length) {
        let libDir = argv['lib-dir'] || config.libDir || config.execDir;
        if (!await fs.pathExists(libDir))
            throw new Error(`Directory "${libDir}" not exists`);

        libDir = path.resolve(libDir);
        const inpx = argv.inpx || config.inpx || await findSingleInpx(libDir);
        sources = [{
            id: 'main',
            name: 'Main library',
            inpx,
            libDir,
            enabled: true,
        }];
    }

    const result = [];
    for (let i = 0; i < sources.length; i++) {
        if (sources[i] && sources[i].enabled === false)
            continue;

        const normalized = await normalizeSource(sources[i], i);
        result.push(normalized);
    }

    if (!result.length)
        throw new Error('No enabled INPX library sources configured');

    config.librarySources = result;
    config.libDir = result[0].libDir;
    config.inpx = result[0].inpx;
    config.inpxFile = result[0].inpxFile;

    return result;
}

function getEnabledLibrarySources(config = {}) {
    const sources = Array.isArray(config.librarySources) ? config.librarySources.filter(source => source && source.enabled !== false) : [];
    if (sources.length)
        return sources.map((source, index) => ({
            id: stableId(source.id || source.name || source.inpx || `source-${index + 1}`, `source-${index + 1}`),
            name: String(source.name || source.id || `Source ${index + 1}`).trim(),
            inpx: source.inpx || source.inpxFile,
            inpxFile: source.inpxFile || source.inpx,
            libDir: source.libDir || config.libDir,
            enabled: source.enabled !== false,
            remote: !!source.remote,
        }));

    return [{
        id: 'main',
        name: 'Main library',
        inpx: config.inpxFile || config.inpx,
        inpxFile: config.inpxFile || config.inpx,
        libDir: config.libDir,
        enabled: true,
    }];
}

module.exports = {
    parseSourcesFromString,
    resolveLibrarySources,
    getEnabledLibrarySources,
};
