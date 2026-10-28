const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const policy = require('./ResourcePolicy');
const runtime = require('./ResourceRuntime');
const {writeFileAtomic} = require('./FilePersistence');
const ZipReader = require('./ZipReader');
const {getEnabledLibrarySources} = require('./LibrarySources');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (items, p = 0.95) => items.length ? items.slice().sort((a,b) => a-b)[Math.floor((items.length - 1) * p)] : null;

function recommend(rows, automatic) {
    const safe = rows.filter(row => row.completed && row.probeSamples >= 5 && row.probeP95Ms < 100
        && row.timerLagP95Ms < 100 && row.memoryRatio < 0.85);
    if (!safe.length) return {profile:automatic, measured:false, reason:'Недостаточно устойчивых замеров; предложен осторожный профиль по ресурсам.'};
    const best = Math.min(...safe.map(row => row.elapsedMs));
    const selected = safe.find(row => row.elapsedMs <= best * 1.1);
    return {profile:selected.profile, measured:true,
        reason:'Минимальная параллельность в пределах 10% от лучшего результата, с запасом памяти и сохранением отклика каталога.'};
}

class ResourceBenchmark {
    constructor(config, options = {}) {
        this.config = config;
        this.runtime = options.runtime || runtime;
        this.hardware = options.hardware || policy.hardware;
        this.probe = options.probe || (async() => {});
        this.prepare = options.prepare || this.prepareFixtures.bind(this);
        this.job = null; this.controller = null; this.last = null; this.loaded = false;
        this.resultFile = path.join(config.dataDir, 'resource-benchmark.json');
    }

    sources() {
        return getEnabledLibrarySources(this.config).filter(source => !source.remote && source.libDir);
    }

    async snapshot() {
        if (!this.loaded) {
            this.loaded = true;
            try {
                const stat = await fs.stat(this.resultFile);
                if (stat.size <= 256 * 1024) {
                    const result = await fs.readJson(this.resultFile);
                    if (result.schema === 1 && Array.isArray(result.rows) && result.rows.length <= 3
                        && this.runtime.settings.profiles.some(item => item.id === result.recommendation?.profile)) this.last = result;
                }
            } catch (_) { /* No saved result on first launch. */ }
        }
        const machine = this.hardware(), settings = this.runtime.settings;
        const source = this.sources().find(item => item.id === this.last?.source?.id);
        const stale = !!this.last && (!source || this.last.fingerprint !== policy.fingerprint(this.config, settings, machine, source));
        return {settings, machine, runtime:this.runtime.snapshot(),
            sources:this.sources().map(({id, name}) => ({id, name})), job:this.job,
            report:this.last ? {...this.last, stale} : null,
            recommendation:!stale && this.last ? this.last.recommendation : {profile:settings.automatic, measured:false,
                reason:stale ? 'Параметры окружения изменились. Повторите проверку.' : 'Предварительная оценка по CPU и памяти. Для уточнения запустите проверку.'}};
    }

    async start(options = {}) {
        if (!this.runtime.settings.benchmarkEnabled) throw new Error('Проверка отключена параметром INPX_RESOURCE_BENCH_ENABLED');
        if (this.controller) throw new Error('Проверка производительности уже выполняется');
        const sources = this.sources();
        const source = options.sourceId ? sources.find(item => item.id === options.sourceId) : sources[0];
        if (!source) throw new Error('Выберите доступный источник библиотеки');
        this.lastError = null;
        this.controller = new AbortController();
        require('events').setMaxListeners(64, this.controller.signal);
        this.job = {id:crypto.randomBytes(12).toString('hex'), state:'running', progress:0, stage:'Подготовка тестовых файлов',
            startedAt:new Date().toISOString(), sourceName:source.name};
        const signal = this.controller.signal;
        this.completion = this.execute(source, signal).catch(error => {
            this.lastError = error;
            const logger = new (require('./AppLogger'))();
            if (logger.inited && !signal.aborted) logger.log(LM_WARN, `resource benchmark ${error.code || 'failed'}: ${String(error.message).slice(0, 2000)}`);
            this.job.state = signal.aborted ? (this.stopReason || 'cancelled') : 'failed';
            this.job.message = signal.aborted ? (this.stopReason === 'timed-out' ? 'Проверка остановлена по лимиту времени'
                : this.stopReason === 'memory-pressure' ? 'Проверка остановлена из-за нагрузки на память' : 'Проверка отменена')
                : 'Не удалось завершить проверку. Действующие настройки не изменены.';
            this.job.errorCode = error.code || 'BENCHMARK_FAILED';
        }).finally(() => {this.job.finishedAt = new Date().toISOString(); this.controller = null;});
        return {job:{...this.job}};
    }

    cancel() {
        if (this.controller) {this.stopReason = 'cancelled'; this.job.state = 'cancelling'; this.controller.abort();}
        return {job:this.job};
    }

    async prepareFixtures(directory, source) {
        const image = require('./ImageUtils'), converter = require('./BookConverter');
        const jxl = require('./benchmarkFixture');
        const input = path.join(directory, 'fixture.fb2'), archive = path.join(directory, 'fixture.7z');
        await fs.writeFile(input, '<?xml version="1.0" encoding="UTF-8"?>\n<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>sf</genre><author><nickname>INPX</nickname></author><book-title>Проверка производительности</book-title><lang>ru</lang></title-info><document-info><author><nickname>INPX</nickname></author><date>2026-10-28</date><id>inpx-benchmark</id><version>1</version></document-info></description><body><section><title><p>Тест</p></title>'
            + '<p>Короткий текст для проверки конвертации и обработки файлов.</p>'.repeat(500) + '</section></body></FictionBook>');
        const stages = [], coverage = [], warnings = [];
        const add = async(name, task) => {
            try {await task('warmup'); stages.push({name, task}); coverage.push(name);}
            catch (error) {
                if (error.code === 'ABORT_ERR') throw error;
                const logger = new (require('./AppLogger'))();
                if (logger.inited) logger.log(LM_WARN, `resource benchmark ${name}: ${String(error.message).slice(0, 2000)}`);
                warnings.push(`${name}: инструмент недоступен или тест не выполнен`);
            }
        };
        await add('Изображения', async() => {await image.jxlToPng(jxl, directory, [], this.config.converterPaths);});
        try {
            await new ZipReader(this.config).run7z(['a', '-t7z', '-mmt=1', '-y', archive, input]);
            await add('Архивы', async() => {
                const reader = new ZipReader({...this.config, resourceMaxOutputBytes:8 * 1024 * 1024});
                try {await reader.open(archive, false); await reader.extractToBuf('fixture.fb2');}
                finally {await reader.close();}
            });
        } catch (error) {
            if (error.code === 'ABORT_ERR') throw error;
            warnings.push('Архивы: 7-Zip недоступен или тест не выполнен');
        }
        if (this.config.conversionEnabled !== false) await add('Конвертация EPUB', async id => {
            const outputFile = path.join(directory, `converted-${id}.epub`);
            try {await converter.convert({inputFile:input, outputFile, format:'epub', sourceFileName:'fixture.fb2', converterPaths:this.config.converterPaths});}
            finally {await fs.remove(outputFile);}
        });
        else warnings.push('Конвертация EPUB отключена в этом запуске');

        // Only bounded reads of existing, regular files in the selected source.
        // Repeated reads may hit OS/NAS caches; no claim of a cold-storage test.
        const samples = [];
        try {
            const listing = await fs.opendir(source.libDir);
            let inspected = 0;
            for await (const item of listing) {
                if (item.isFile() && /\.(7z|zip|fb2|epub)$/i.test(item.name)) samples.push(path.join(source.libDir, item.name));
                if (samples.length >= 2 || ++inspected >= 256) break;
            }
            if (samples.length) stages.push({name:'Хранилище', task:() => this.runtime.run(async() => {
                for (const file of samples) {
                    const handle = await fs.promises.open(file, 'r');
                    try {
                        const stat = await handle.stat(), buffer = Buffer.alloc(128 * 1024);
                        for (const position of [0, Math.floor(stat.size / 2)]) await handle.read(buffer, 0, buffer.length, position);
                    } finally {await handle.close();}
                }
            }, {kind:'reviews'})});
        } catch (_) { /* A missing/offline source is reported as unmeasured. */ }
        if (samples.length) coverage.push('Хранилище');
        else warnings.push('Хранилище не измерено: подходящие файлы не найдены или источник недоступен');
        warnings.push('Повторные чтения могут использовать кэш ОС и NAS. Silero в отдельном контейнере не измеряется.');
        return {stages, coverage, warnings};
    }

    async measure(profile, stages, signal) {
        const start = Date.now(), probes = [], lags = [];
        let peakMemory = this.hardware().memoryUsed || 0, memoryRatio = 0, stopped = false, otherWork = false;
        const sampling = (async() => {
            while (!stopped) {
                const due = Date.now() + 50; await delay(50);
                if (stopped) break;
                const began = Date.now(); lags.push(Math.max(0, began - due));
                let probeTimer;
                try {
                    await Promise.race([this.probe(), new Promise((resolve, reject) => {
                        probeTimer = setTimeout(() => reject(new Error('Probe timeout')), 250);
                    })]);
                    probes.push(Date.now() - began);
                } catch (_) {probes.push(1000);}
                finally {clearTimeout(probeTimer);}
                const machine = this.hardware();
                const load = this.runtime.snapshot();
                otherWork ||= load.foreground + load.background > 0;
                peakMemory = Math.max(peakMemory, machine.memoryUsed || 0);
                memoryRatio = Math.max(memoryRatio, (machine.memoryUsed || 0) / machine.memoryLimit);
                if ((machine.memoryScope !== 'host' && memoryRatio >= 0.9) || machine.memoryAvailable < 128 * 1024 * 1024) {
                    this.stopReason = 'memory-pressure'; this.job.state = 'cancelling'; this.controller.abort();
                }
            }
        })();
        const rounds = [];
        try {
            for (let round = 0; round < 12; round++) {
                const before = Date.now();
                const jobs = stages.flatMap(stage => Array.from({length:6}, (_, n) => () => stage.task(`${profile.id}-${round}-${n}`)));
                const settled = await this.runtime.withBenchmark(profile.limits, signal, () => Promise.allSettled(jobs.map(task => task())));
                const failure = settled.find(item => item.status === 'rejected');
                if (failure) throw failure.reason;
                rounds.push(Date.now() - before);
                if (round >= 1 && Date.now() - start >= 400 && probes.length >= 5) break;
            }
            if (signal.aborted) throw Object.assign(new Error('Cancelled'), {code:'ABORT_ERR'});
        } finally {stopped = true; await sampling;}
        return {profile:profile.id, limits:profile.limits, completed:true, elapsedMs:percentile(rounds.slice(1), 0.5),
            rounds:rounds.length, totalDurationMs:Date.now() - start,
            firstPassMs:rounds[0], repeatPassMs:rounds[1], probeP95Ms:percentile(probes), probeSamples:probes.length,
            timerLagP95Ms:percentile(lags), peakMemory, memoryRatio, otherWork};
    }

    async execute(source, signal) {
        this.stopReason = '';
        const settings = this.runtime.settings, machine = this.hardware();
        if ((machine.memoryScope !== 'host' && machine.memoryUsed / machine.memoryLimit >= 0.85)
            || machine.memoryAvailable < 128 * 1024 * 1024) {
            this.stopReason = 'memory-pressure'; this.controller.abort();
            throw Object.assign(new Error('Insufficient memory reserve'), {code:'ABORT_ERR'});
        }
        const busyAtStart = this.runtime.snapshot().active > 0;
        const root = this.config.tempDir || path.join(this.config.dataDir, 'tmp');
        await fs.ensureDir(root);
        const directory = await fs.mkdtemp(path.join(root, 'resource-benchmark-'));
        const timer = setTimeout(() => {this.stopReason = 'timed-out'; this.job.state = 'cancelling'; this.controller?.abort();}, settings.benchmarkTimeoutMs);
        try {
            const fixtures = await this.runtime.withBenchmark(settings.profiles[0].limits, signal, () => this.prepare(directory, source));
            if (!fixtures.stages.length) throw new Error('No available benchmark stages');
            const rows = [];
            for (const [index, profile] of settings.profiles.entries()) {
                if (signal.aborted) throw Object.assign(new Error('Cancelled'), {code:'ABORT_ERR'});
                this.job.stage = profile.name; this.job.progress = (index + 0.2) / settings.profiles.length;
                try {rows.push(await this.measure(profile, fixtures.stages, signal));}
                catch (error) {
                    if (signal.aborted) throw error;
                    rows.push({profile:profile.id, limits:profile.limits, completed:false, errorCode:error.code || 'TASK_FAILED'});
                    fixtures.warnings.push(`${profile.name}: тестовые задачи завершились с ошибкой; профиль не рекомендуется.`);
                }
            }
            if (!rows.some(row => row.completed)) throw new Error('No completed benchmark profiles');
            const recommendation = recommend(rows, settings.automatic);
            if (fixtures.coverage.filter(item => item !== 'Хранилище').length < 2) {
                recommendation.profile = settings.automatic; recommendation.measured = false;
                recommendation.reason = 'Для сравнения профилей недостаточно доступных конвертеров. Предложен профиль по ресурсам.';
            }
            const full = ['cgroup','container'].includes(machine.memoryScope) && fixtures.coverage.includes('Хранилище')
                && fixtures.coverage.filter(item => item !== 'Хранилище').length >= 2 && !busyAtStart && !rows.some(row => row.otherWork);
            if (!full) {
                recommendation.measured = false;
                recommendation.reason += ' Оценка предварительная: не все ресурсы измерены либо присутствовала другая нагрузка.';
            }
            if (!full && recommendation.profile === 'performance') recommendation.profile = settings.automatic;
            const report = {schema:1, measuredAt:new Date().toISOString(), source:{id:source.id, name:source.name},
                fingerprint:policy.fingerprint(this.config, settings, machine, source), machine, rows,
                coverage:fixtures.coverage, warnings:fixtures.warnings, confidence:full ? 'measured' : 'partial', recommendation};
            await writeFileAtomic(this.resultFile, JSON.stringify(report));
            this.last = report; this.loaded = true;
            this.job.state = 'completed'; this.job.stage = 'Проверка завершена'; this.job.progress = 1;
        } finally {
            clearTimeout(timer);
            await fs.remove(directory);
        }
    }
}

module.exports = {ResourceBenchmark, recommend, percentile};
