const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {ConversionRuntime, runProcess: run} = require('./ConversionRuntime');
const runtime = new ConversionRuntime();
const externalTools = require('./ExternalTools');
const {bundledBinDir} = externalTools;
const bookNaming = require('./BookNaming');
const yaml = require('js-yaml');
const {validateMobi} = require('./MobiValidation');
const {validateEpubForMobi} = require('./MobiEpubValidation');
const {withFileTransaction} = require('./FilePersistence');

const pending = new Map();
const validatedFb2cngConfigs = new Set();
const conversionCacheSchema = 'v2';
const targetFormats = new Set(['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf', 'mobi']);
const fb2cngFormats = new Map([
    ['epub', 'epub2'],
    ['epub3', 'epub3'],
    ['kepub', 'kepub'],
    ['kfx', 'kfx'],
    ['azw8', 'azw8'],
]);
const fb2cngOutputExtensions = new Map([
    ['epub3', 'epub'],
    ['kepub', 'kepub.epub'],
]);

function getConvertedExtension(fileType) {
    const normalizedFileType = String(fileType || '').toLowerCase();
    const outputExtension = fb2cngOutputExtensions.get(normalizedFileType) || normalizedFileType;
    return outputExtension;
}

function getConvertedFileName(originalFileName, format) {
    const ext = path.extname(originalFileName);
    const base = (ext ? originalFileName.slice(0, -ext.length) : originalFileName);
    const extNew = getConvertedExtension(format);
    return `${base}.${extNew}`;
}

function bundledToolPath(fileName) {
    const dir = bundledBinDir();
    return dir ? path.join(dir, fileName) : '';
}

function localToolPath(fileName) {
    return path.join(process.cwd(), 'bin', fileName);
}

const fbcFileName = process.platform === 'win32' ? 'fbc.exe' : 'fbc';
const mutoolFileName = process.platform === 'win32' ? 'mutool.exe' : 'mutool';
function fb2cngCommandCandidates(converterPaths = null) {
    const configured = externalTools.configuredToolCandidates(externalTools.resolveConverterPaths(converterPaths), ['fb2cng', 'fbc']);
    if (configured.length) return configured.map(command => /[\\/]/.test(command) && !path.isAbsolute(command) ? path.resolve(command) : command);
    return [
        bundledToolPath(fbcFileName),
        localToolPath(fbcFileName),
        'fbc',
        '/usr/local/bin/fbc',
        '/usr/bin/fbc',
    ].filter(Boolean);
}

function mutoolCommandCandidates(converterPaths = null) {
    const configured = externalTools.configuredToolCandidates(externalTools.resolveConverterPaths(converterPaths), ['mutool', 'mupdf']);
    if (configured.length) return configured;
    return [
        bundledToolPath(mutoolFileName),
        localToolPath(mutoolFileName),
        'mutool',
        '/usr/bin/mutool',
        '/usr/local/bin/mutool',
    ].filter(Boolean);
}

function calibreCommandCandidates(converterPaths = null) {
    const configured = externalTools.configuredToolCandidates(externalTools.resolveConverterPaths(converterPaths), ['calibre', 'ebookConvert', 'ebook-convert']);
    if (configured.length) return configured;
    return [
        'ebook-convert',
        '/usr/bin/ebook-convert',
        '/usr/local/bin/ebook-convert',
        'C:\\Program Files\\Calibre2\\ebook-convert.exe',
    ].filter(Boolean);
}

function kindlingCommandCandidates(configuredPath = '') {
    if (String(configuredPath || '').trim()) return [String(configuredPath).trim()];
    const file = process.platform === 'win32' ? 'kindling.exe' : 'kindling';
    return [bundledToolPath(file), localToolPath(file), 'kindling', '/usr/local/bin/kindling', '/usr/bin/kindling'].filter(Boolean);
}

function stableStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof(value) === 'object') {
        return `{${Object.keys(value).sort()
            .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function readFb2cngArgs(value = []) {
    const error = message => Object.assign(new Error(`Неверные аргументы fb2cng: ${message}`), {code: 'INPX_INVALID_FB2CNG_ARGS'});
    if (process.env.INPX_FB2CNG_ARGS !== undefined) {
        try {
            value = process.env.INPX_FB2CNG_ARGS.trim() ? JSON.parse(process.env.INPX_FB2CNG_ARGS) : [];
        } catch (err) {
            throw error('INPX_FB2CNG_ARGS должен содержать JSON-массив строк.');
        }
    }
    if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string' || !arg.trim() || arg.includes('\0')))
        throw error('fb2cngArgs должен быть массивом непустых строк, например ["--no-cover"].');
    const managed = new Set(['--config', '-c', '--to', '--output-file', '-o', '--overwrite', '--']);
    if (value.some(arg => managed.has(arg.split('=')[0]) || /^-[co].+/.test(arg)))
        throw error('формат, конфиг и пути файлов задаёт приложение; служебные флаги нельзя переопределять через fb2cngArgs.');
    return value.slice();
}

function fb2cngConfigError(configPath, message) {
    const error = new Error(`Invalid fb2cng config "${configPath}": ${message}`);
    error.code = 'INPX_INVALID_FB2CNG_CONFIG';
    return error;
}

async function readFb2cngConfig(configPath = '') {
    const rawPath = String(configPath || '').trim();
    if (!rawPath)
        return {path: '', fingerprint: 'default'};

    const resolvedPath = path.resolve(rawPath);
    let stat;
    try {
        stat = await fs.stat(resolvedPath);
        await fs.access(resolvedPath, fs.constants.R_OK);
    } catch (err) {
        throw fb2cngConfigError(resolvedPath, 'file does not exist or is not readable');
    }

    if (!stat.isFile())
        throw fb2cngConfigError(resolvedPath, 'path is not a regular file');

    let content;
    try {
        content = await fs.readFile(resolvedPath);
    } catch (err) {
        throw fb2cngConfigError(resolvedPath, 'file cannot be read');
    }

    const fingerprint = crypto.createHash('sha256')
        .update(resolvedPath)
        .update('\0')
        .update(content)
        .digest('hex');
    return {path: resolvedPath, fingerprint};
}

async function validateFb2cngConfig(configInfo, converterPaths = null, runner = runFirst) {
    if (!configInfo || !configInfo.path)
        return;

    const commands = fb2cngCommandCandidates(converterPaths);
    const validationKey = crypto.createHash('sha256')
        .update(configInfo.fingerprint)
        .update('\0')
        .update(stableStringify(commands))
        .digest('hex');
    if (validatedFb2cngConfigs.has(validationKey))
        return;

    try {
        await runner(commands, ['--config', configInfo.path, 'dumpconfig'], {cwd: path.dirname(configInfo.path)});
    } catch (err) {
        if (err.code === 'INPX_CONVERSION_TIMEOUT' || err.code === 'INPX_CONVERTER_NOT_FOUND')
            throw err;
        throw fb2cngConfigError(configInfo.path, err.message);
    }
    validatedFb2cngConfigs.add(validationKey);
}

async function getConversionCacheInfo({cacheBasePath, inputFile = '', sourceFileName = '', format, config = {}, book = {}}) {
    const normalizedFormat = String(format || '').toLowerCase();
    const sourceExt = path.extname(sourceFileName || inputFile).toLowerCase();
    if (!cacheBasePath)
        throw new Error('Conversion cache base path is empty');
    if (!canConvertSourceTo(sourceExt, normalizedFormat))
        throw new Error(`Unsupported convert format: ${sourceExt || 'unknown'} -> ${normalizedFormat}`);

    const usesFb2cng = sourceExt === '.fb2' && (fb2cngFormats.has(normalizedFormat) || normalizedFormat === 'mobi');
    const fb2cngConfig = usesFb2cng
        ? await readFb2cngConfig(config.fb2cngConfigPath)
        : {path: '', fingerprint: 'not-used'};
    const fb2cngArgs = usesFb2cng ? readFb2cngArgs(config.fb2cngArgs) : [];
    const bookTitle = usesFb2cng ? bookNaming.title(book, getConvertedExtension(normalizedFormat), config) : null;
    const signature = stableStringify({
        schema: conversionCacheSchema,
        format: normalizedFormat,
        sourceExt,
        fb2cngConfigFingerprint: fb2cngConfig.fingerprint,
        fb2cngVersion: usesFb2cng ? String(config.fb2cngVersion || '') : '',
        converterPaths: config.converterPaths || {},
        ...(normalizedFormat === 'mobi' ? {mobiProfile: 'dual-v1', kindlingVersion: config.kindlingVersion || 'v0.45.6', kindlingPath: config.kindlingPath || ''} : {}),
        ...(fb2cngArgs.length ? {fb2cngArgs} : {}),
        ...(bookTitle !== null ? {bookTitleTemplate: config.bookTitleTemplate, bookTitle} : {}),
        ...(Object.keys(config.converterPaths || {}).length ? {configuredToolPolicy: 'strict-v1'} : {}),
    });
    const fingerprint = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 20);
    const extension = getConvertedExtension(normalizedFormat);

    return {
        filePath: `${cacheBasePath}.converted-${conversionCacheSchema}-${normalizedFormat}-${fingerprint}.${extension}`,
        fingerprint,
        fb2cngConfig,
        format: normalizedFormat,
        sourceExt,
        usesFb2cng,
        fb2cngArgs,
        bookTitle,
    };
}

function canConvertTo(format) {
    return targetFormats.has((format || '').toLowerCase());
}

function canConvertSourceTo(sourceExt, format) {
    sourceExt = String(sourceExt || '').toLowerCase().replace(/^\./, '');
    format = String(format || '').toLowerCase();

    if (!canConvertTo(format))
        return false;
    if (sourceExt === 'fb2')
        return true;

    return sourceExt === 'epub' && ['pdf', 'mobi'].includes(format);
}

async function buildCalibreEnv() {
    const runtimeDir = path.join(require('os').tmpdir(), 'ebook-convert-runtime');
    await fs.ensureDir(runtimeDir);
    await fs.chmod(runtimeDir, 0o700);

    const chromiumFlags = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
    ].join(' ');

    return {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        QTWEBENGINE_DISABLE_SANDBOX: '1',
        QTWEBENGINE_CHROMIUM_FLAGS: chromiumFlags,
        QT_QPA_PLATFORM: (process.env.QT_QPA_PLATFORM || 'offscreen'),
    };
}

async function runFirst(commands, args, options = {}) {
    let lastError = null;

    for (const command of commands) {
        try {
            await run(command, args, options);
            return;
        } catch(e) {
            lastError = e;
            if (e.code !== 'ENOENT')
                throw e;
        }
    }

    if (lastError && lastError.code === 'ENOENT') {
        throw Object.assign(new Error(`Не найден конвертер: ${commands.join(', ')}. ` +
            'В converterPaths укажите путь к исполняемому файлу без аргументов. Дополнительные флаги fb2cng задаются в fb2cngArgs.'),
        {code: 'INPX_CONVERTER_NOT_FOUND'});
    }
    throw (lastError || new Error('converter not found'));
}

async function runCalibre(args, converterPaths = null) {
    await runFirst(calibreCommandCandidates(converterPaths), args, {env: await buildCalibreEnv()});
}

async function convertWithFb2cng(inputFile, outputFile, format, converterPaths = null, fb2cngConfigPath = null, extraArgs = [], bookTitle = null) {
    const configInfo = await readFb2cngConfig(fb2cngConfigPath);
    const task = () => convertWithFb2cngIsolated(inputFile, outputFile, format, converterPaths, configInfo, extraArgs, bookTitle);
    // Custom YAML may reference relative CSS/fonts. Keep that working directory
    // and serialize its fbc processes, whose panic logs otherwise conflict.
    return configInfo.path ? await withFileTransaction(path.join(path.dirname(configInfo.path), '.inpx-fbc-runtime'), task) : await task();
}

async function convertWithFb2cngIsolated(inputFile, outputFile, format, converterPaths, configInfo, extraArgs, bookTitle) {
    const outputDir = `${outputFile}.fb2cng`;
    const fb2cngFormat = fb2cngFormats.get(format);
    const conversionArgs = readFb2cngArgs(extraArgs);
    await validateFb2cngConfig(configInfo, converterPaths);
    let titleConfigDir = '';
    try {
        let effectiveConfig = configInfo.path;
        if (bookTitle !== null) {
            titleConfigDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'inpx-fbc-title-'));
            effectiveConfig = path.join(titleConfigDir, 'config.yaml');
            let data = {};
            if (configInfo.path) {
                // Keep the original working directory for dump and conversion:
                // fbc leaves relative CSS/font paths relative in its dumped YAML.
                await runFirst(fb2cngCommandCandidates(converterPaths), ['--config', configInfo.path, 'dumpconfig', effectiveConfig], {cwd: path.dirname(configInfo.path)});
                data = yaml.load(await fs.readFile(effectiveConfig, 'utf8'), {schema: yaml.CORE_SCHEMA}) || {};
            }
            data.document = data.document || {};
            data.document.metainformation = data.document.metainformation || {};
            // A Go string literal keeps quotes and template-like book text literal.
            data.document.metainformation.title_template = `{{ ${JSON.stringify(String(bookTitle))} }}`;
            await fs.writeFile(effectiveConfig, yaml.dump(data, {schema: yaml.CORE_SCHEMA, noRefs: true, lineWidth: -1}), {mode: 0o600});
        }
        const fb2cngArgs = [
            ...(effectiveConfig ? ['--config', effectiveConfig] : []),
            'convert', '--to', fb2cngFormat, '--overwrite', ...conversionArgs, path.resolve(inputFile), path.resolve(outputDir),
        ];
        await fs.remove(outputDir);
        await fs.ensureDir(outputDir);
        // Default conversions have a private working directory for fbc.log and
        // fbc-panic.log; they must not race in the application's directory.
        await runFirst(fb2cngCommandCandidates(converterPaths), fb2cngArgs, {cwd: configInfo.path ? path.dirname(configInfo.path) : outputDir});

        const outputExtension = `.${getConvertedExtension(format)}`;
        const firstMatchedFile = (await fs.readdir(outputDir))
            .find(file => file.toLowerCase().endsWith(outputExtension));
        const converted = firstMatchedFile ? path.join(outputDir, firstMatchedFile) : undefined;

        if (!converted)
            throw new Error(`fb2cng did not produce ${format}`);

        await fs.move(converted, outputFile, {overwrite: true});
    } finally {
        await fs.remove(outputDir);
        if (titleConfigDir) await fs.remove(titleConfigDir);
    }
}

async function convertWithMutool(inputFile, outputFile, converterPaths = null) {
    await runFirst(mutoolCommandCandidates(converterPaths), ['convert', '-o', outputFile, inputFile]);
}

async function convertWithCalibre(inputFile, outputFile, format, converterPaths = null) {
    let tempIntermediate = '';

    try {
        if (format === 'pdf' && path.extname(inputFile).toLowerCase() !== '.epub') {
            tempIntermediate = `${outputFile}.intermediate.epub`;
            await runCalibre([inputFile, tempIntermediate], converterPaths);
            await runCalibre([tempIntermediate, outputFile], converterPaths);
        } else {
            await runCalibre([inputFile, outputFile], converterPaths);
        }
    } finally {
        if (tempIntermediate)
            await fs.remove(tempIntermediate);
    }
}

async function convertWithKindling(inputFile, outputFile, converterPaths, fb2cngConfigPath, fb2cngArgs, bookTitle, kindlingPath) {
    const dir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'inpx-mobi-'));
    try {
        const intermediate = path.join(dir, 'book.epub');
        if (path.extname(inputFile).toLowerCase() === '.fb2')
            await convertWithFb2cng(inputFile, intermediate, 'epub', converterPaths, fb2cngConfigPath, fb2cngArgs, bookTitle);
        else
            await fs.copyFile(inputFile, intermediate);
        await validateEpubForMobi(intermediate);
        // The KDP publishing preflight rejects fbc's Amazon-specific CSS media
        // queries. Sideloading does not need KDP rules; preserve the stylesheet
        // and keep Kindling's separate structural self-check enabled.
        try {
            await runFirst(kindlingCommandCandidates(kindlingPath), ['build', intermediate, '--legacy-mobi', '--no-embed-source', '--no-validate', '-o', path.resolve(outputFile)], {cwd: dir});
        } catch (error) {
            if (error.code === 'INPX_CONVERTER_NOT_FOUND')
                throw Object.assign(new Error('Не найден Kindling. Укажите INPX_KINDLING_PATH при запуске или положите kindling / kindling.exe в bin рядом с приложением.'), {code:error.code});
            throw error;
        }
        await validateMobi(outputFile);
    } finally {
        await fs.remove(dir);
    }
}

async function convertPrepared(convertInput, outputFile, format, converterPaths = null, fb2cngConfigPath = null, fb2cngArgs = [], bookTitle = null, kindlingPath = '') {
    if (format === 'mobi') {
        await convertWithKindling(convertInput, outputFile, converterPaths, fb2cngConfigPath, fb2cngArgs, bookTitle, kindlingPath);
        return;
    }
    if (fb2cngFormats.has(format) && path.extname(convertInput).toLowerCase() === '.fb2') {
        await convertWithFb2cng(convertInput, outputFile, format, converterPaths, fb2cngConfigPath, fb2cngArgs, bookTitle);
        return;
    }

    if (format === 'pdf' && ['.fb2', '.epub'].includes(path.extname(convertInput).toLowerCase())) {
        await convertWithMutool(convertInput, outputFile, converterPaths);
        return;
    }

    await convertWithCalibre(convertInput, outputFile, format, converterPaths);
}

async function convert({inputFile, outputFile, format, sourceFileName = '', converterPaths = null, fb2cngConfigPath = null, fb2cngArgs = [], bookTitle = null, mobiEnabled = false, kindlingPath = ''}) {
    format = String(format || '').toLowerCase();
    if (format === 'mobi' && mobiEnabled !== true)
        throw new Error('Конвертация в MOBI выключена. Для включения задайте INPX_MOBI_ENABLED=true при запуске.');
    const sourceExt = path.extname(sourceFileName || inputFile).toLowerCase();
    if (!canConvertSourceTo(sourceExt, format))
        throw new Error(`Unsupported convert format: ${sourceExt || 'unknown'} -> ${format}`);

    const key = `${inputFile}=>${outputFile}`;
    if (pending.has(key))
        return await pending.get(key);

    const tasks = require('./BackgroundTasks');
    const taskId = tasks.start('conversion', `Конвертация ${format.toUpperCase()}`);
    tasks.update(taskId, {state:'queued',phase:'Ожидание очереди конвертации'});
    const job = runtime.run(() => require('./ResourceRuntime').withTask(taskId, async() => {
        tasks.update(taskId, {state:'running',phase:'Конвертация файла'});
        await fs.ensureDir(path.dirname(outputFile));
        let convertInput = inputFile;
        let tempInput = '';
        const workingOutput = `${outputFile}.work-${crypto.randomBytes(8).toString('hex')}.${getConvertedExtension(format)}`;
        const sourceExt = path.extname(sourceFileName || '').toLowerCase();

        try {
            if (sourceExt && sourceExt !== path.extname(inputFile).toLowerCase()) {
                tempInput = `${outputFile}.input-${crypto.randomBytes(8).toString('hex')}${sourceExt}`;
                await fs.copyFile(inputFile, tempInput);
                convertInput = tempInput;
            }
            await convertPrepared(convertInput, workingOutput, format, converterPaths, fb2cngConfigPath, fb2cngArgs, bookTitle, kindlingPath);
            await fs.rename(workingOutput, outputFile);
        } finally {
            await fs.remove(workingOutput);
            if (tempInput)
                await fs.remove(tempInput);
        }
    }));

    pending.set(key, job);
    try {
        await job;
        tasks.finish(taskId);
    } catch (error) {
        tasks.finish(taskId,error);
        throw error;
    } finally {
        pending.delete(key);
    }
}

async function prepareConvertedFile({
    inputFile,
    cacheBasePath,
    format,
    sourceFileName,
    downFileName,
    config,
    book = {},
    unsupportedMessage = '',
    disabledMessage = '',
}) {
    const sourceExt = path.extname(sourceFileName || inputFile).toLowerCase();
    if (!canConvertSourceTo(sourceExt, format))
        throw new Error(unsupportedMessage || `Unsupported convert format: ${sourceExt || 'unknown'} -> ${format}`);

    if (!config.conversionEnabled)
        throw new Error(disabledMessage || 'Book conversion is disabled');

    if (String(format).toLowerCase() === 'mobi' && config.mobiEnabled !== true)
        throw new Error('Конвертация в MOBI выключена. Для включения задайте INPX_MOBI_ENABLED=true при запуске.');

    const cacheInfo = await getConversionCacheInfo({
        cacheBasePath,
        inputFile,
        sourceFileName,
        format,
        config,
        book,
    });

    const created = !await fs.pathExists(cacheInfo.filePath);
    if (created) {
        await convert({
            inputFile,
            outputFile: cacheInfo.filePath,
            format: cacheInfo.format,
            sourceFileName,
            converterPaths: config.converterPaths,
            fb2cngConfigPath: config.fb2cngConfigPath,
            fb2cngArgs: cacheInfo.fb2cngArgs,
            bookTitle: cacheInfo.bookTitle,
            mobiEnabled: config.mobiEnabled,
            kindlingPath: config.kindlingPath,
        });
    }

    return {
        filePath: cacheInfo.filePath,
        downloadName: bookNaming.filename(book, getConvertedFileName(downFileName, cacheInfo.format), getConvertedExtension(cacheInfo.format), config),
        created,
    };
}

module.exports = {
    configure: config => runtime.configure(config),
    canConvertTo,
    canConvertSourceTo,
    fb2cngCommandCandidates,
    mutoolCommandCandidates,
    calibreCommandCandidates,
    kindlingCommandCandidates,
    convert,
    prepareConvertedFile,
    readFb2cngConfig,
    validateFb2cngConfig,
    readFb2cngArgs,
    getConversionCacheInfo,
    getConvertedFileName,
    getConvertedExtension,
};
