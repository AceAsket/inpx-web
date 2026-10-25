const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const Module = require('module');
const {ConversionRuntime} = require('../server/core/ConversionRuntime');

async function isolatedConverter(runner) {
    const filename = require.resolve('../server/core/BookConverter');
    const nativeRequire = Module.createRequire(filename);
    const isolated = new Module(filename, module);
    isolated.filename = filename;
    isolated.paths = module.paths;
    isolated.require = name => name === './ConversionRuntime'
        ? {ConversionRuntime, runProcess: runner} : nativeRequire(name);
    isolated._compile(await fs.readFile(filename, 'utf8'), filename);
    return isolated.exports;
}

async function withFixture(fn) {
    const previous = process.env.INPX_FB2CNG_ARGS;
    delete process.env.INPX_FB2CNG_ARGS;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-converter-options-'));
    try { await fn(dir); }
    finally {
        if (previous === undefined) delete process.env.INPX_FB2CNG_ARGS;
        else process.env.INPX_FB2CNG_ARGS = previous;
        await fs.remove(dir);
    }
}

async function testCustomConvertersFailWithoutDefaultFallback() {
    await withFixture(async dir => {
        const attempts = [];
        const converter = await isolatedConverter(async(command, args) => {
            attempts.push(command);
            if (command.startsWith('missing-')) throw Object.assign(new Error('missing executable'), {code: 'ENOENT'});
            // A silent fallback would succeed, reproducing issue #21.
            if (args.includes('convert')) await fs.outputFile(path.join(args.at(-1), 'result.epub'), 'fallback');
            else await fs.outputFile(args[2], 'fallback');
        });
        const inputFile = path.join(dir, 'source.fb2'), outputFile = path.join(dir, 'result.epub');
        await fs.writeFile(inputFile, 'source');
        await fs.writeFile(outputFile, 'previous complete result');
        for (const command of ['missing-fbc', 'missing-fbc --no-cover']) {
            await assert.rejects(converter.convert({inputFile, outputFile, format: 'epub', converterPaths: {fb2cng: command}}),
                error => error.code === 'INPX_CONVERTER_NOT_FOUND' && error.message.includes(command) && error.message.includes('fb2cngArgs'));
        }
        await assert.rejects(converter.convert({inputFile, outputFile, format: 'pdf', converterPaths: {mutool: 'missing-mutool'}}),
            {code: 'INPX_CONVERTER_NOT_FOUND'});
        assert.deepStrictEqual(attempts, ['missing-fbc', 'missing-fbc --no-cover', 'missing-mutool']);
        const configPath = path.join(dir, 'config.yaml');
        await fs.writeFile(configPath, 'document: {}');
        await assert.rejects(converter.convert({inputFile, outputFile, format: 'epub', converterPaths: {fb2cng: 'missing-probe'}, fb2cngConfigPath: configPath}),
            {code: 'INPX_CONVERTER_NOT_FOUND'});
        assert.strictEqual(attempts.at(-1), 'missing-probe', 'YAML validation must also use the configured executable');
        const attempted = attempts.length;
        await assert.rejects(converter.convert({inputFile, outputFile, format: 'epub', fb2cngArgs: '--no-cover'}),
            {code: 'INPX_INVALID_FB2CNG_ARGS'});
        assert.strictEqual(attempts.length, attempted, 'Invalid arguments must fail before starting the converter');
        assert.strictEqual(await fs.readFile(outputFile, 'utf8'), 'previous complete result');
        assert.ok(!(await fs.readdir(dir)).some(name => /\.work-|\.input-|\.fb2cng$/.test(name)));
        assert.deepStrictEqual(converter.fb2cngCommandCandidates({fbc: ['/first/fbc', '/second/fbc']}), ['/first/fbc', '/second/fbc']);
        assert.deepStrictEqual(converter.calibreCommandCandidates({calibre: '/custom/ebook-convert'}), ['/custom/ebook-convert']);
        assert.ok(converter.fb2cngCommandCandidates({}).includes('fbc'), 'Default discovery stays available without an override');
    });
}

async function testFb2cngArgumentsReachConversionAndSeparateCache() {
    await withFixture(async dir => {
        const calls = [];
        const converter = await isolatedConverter(async(command, args) => {
            calls.push({command, args});
            if (args.includes('dumpconfig')) return;
            await fs.outputFile(path.join(args.at(-1), 'result.epub'), 'converted');
        });
        const inputFile = path.join(dir, 'source.fb2'), configPath = path.join(dir, 'config.yaml');
        await fs.writeFile(inputFile, 'source');
        await fs.writeFile(configPath, 'document: {}');
        const options = {inputFile, cacheBasePath: path.join(dir, 'cache'), format: 'epub', sourceFileName: 'source.fb2', downFileName: 'source.fb2',
            config: {conversionEnabled: true, converterPaths: {fb2cng: '/custom path/fbc'}, fb2cngConfigPath: configPath}};
        const plain = await converter.getConversionCacheInfo(options);
        const fb2cngArgs = ['--no-cover', '--kfx-compression', 'lzma'];
        const custom = {...options, config: {...options.config, fb2cngArgs}};
        const prepared = await converter.prepareConvertedFile(custom);
        assert.notStrictEqual(prepared.filePath, plain.filePath);
        assert.strictEqual(await fs.readFile(prepared.filePath, 'utf8'), 'converted');
        assert.deepStrictEqual(calls[0], {command: '/custom path/fbc', args: ['--config', configPath, 'dumpconfig']});
        assert.deepStrictEqual(calls[1].args.slice(0, -2), ['--config', configPath, 'convert', '--to', 'epub2', '--overwrite', ...fb2cngArgs]);
        assert.strictEqual(calls[1].args.at(-2), inputFile);
        assert.strictEqual((await converter.prepareConvertedFile(custom)).created, false);
        assert.strictEqual(calls.length, 2, 'Identical options must reuse the completed conversion');
        const changed = await converter.getConversionCacheInfo({...options, config: {...options.config, fb2cngArgs: ['--no-cover']}});
        assert.notStrictEqual(changed.filePath, prepared.filePath);
        process.env.INPX_FB2CNG_ARGS = '["--no-cover"]';
        assert.strictEqual((await converter.getConversionCacheInfo(custom)).filePath, changed.filePath, 'Environment takes priority over config.json');
        delete process.env.INPX_FB2CNG_ARGS;
        const defaultCache = await converter.getConversionCacheInfo({...options, config: {conversionEnabled: true}});
        const emptyCache = await converter.getConversionCacheInfo({...options, config: {conversionEnabled: true, fb2cngArgs: []}});
        assert.strictEqual(defaultCache.filePath, emptyCache.filePath);
    });
}

async function testFb2cngArgumentsValidationAndConfigPersistence() {
    await withFixture(async dir => {
        const converter = require('../server/core/BookConverter');
        for (const value of ['--no-cover', [false], [''], ['bad\0value'], ['--to=pdf'], ['--config', '/other'], ['-o', '/other'], ['-o/other'], ['-c/other'], ['--']])
            assert.throws(() => converter.readFb2cngArgs(value), {code: 'INPX_INVALID_FB2CNG_ARGS'});
        const literal = ['--example', 'a value with spaces; $(command)'];
        assert.deepStrictEqual(converter.readFb2cngArgs(literal), literal, 'Each array value remains a separate literal argument');
        for (const value of ['not-json', '"--no-cover"', '[1]']) {
            process.env.INPX_FB2CNG_ARGS = value;
            assert.throws(() => converter.readFb2cngArgs([]), {code: 'INPX_INVALID_FB2CNG_ARGS'});
        }
        process.env.INPX_FB2CNG_ARGS = '[]';
        assert.deepStrictEqual(converter.readFb2cngArgs(['--no-cover']), []);
        delete process.env.INPX_FB2CNG_ARGS;
        const configFile = path.join(dir, 'config.json');
        await fs.writeJson(configFile, {dataDir: dir, fb2cngArgs: ['--no-cover']});
        const script = `const assert = require('assert');
            (async() => {
                const manager = new(require('./server/config'))();
                await manager.init(process.argv[1], process.argv[2]);
                await manager.load(); await manager.save(); await manager.load();
                assert.deepStrictEqual(manager.config.fb2cngArgs, ['--no-cover']);
                assert.deepStrictEqual((await require('fs-extra').readJson(process.argv[2])).fb2cngArgs, ['--no-cover']);
            })().catch(error => {console.error(error); process.exitCode = 1;});`;
        await require('util').promisify(require('child_process').execFile)(process.execPath, ['-e', script, dir, configFile], {cwd: path.resolve(__dirname, '..')});
    });
}

module.exports = [testCustomConvertersFailWithoutDefaultFallback, testFb2cngArgumentsReachConversionAndSeparateCache, testFb2cngArgumentsValidationAndConfigPersistence];
module.exports.isolatedConverter = isolatedConverter;
