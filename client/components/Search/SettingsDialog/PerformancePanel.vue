<template>
    <section class="performance-panel">
        <header class="performance-heading">
            <h3>Производительность</h3>
            <q-btn flat dense round icon="la la-sync" aria-label="Обновить показатели производительности" :disable="busy" @click="refresh" />
        </header>
        <div v-if="error" class="text-negative" role="alert">{{ error }}</div>
        <template v-if="info">
            <div class="performance-active" data-testid="performance-active">
                <div><span class="performance-muted">Режим сервера</span><strong>{{ profileName(info.settings.selected) }}</strong></div>
                <span>В работе <b>{{ info.runtime.active }}</b> · в очереди <b>{{ info.runtime.queued }}</b></span>
            </div>
            <details class="performance-details">
                <summary>Ресурсы и лимиты</summary>
                <div class="performance-stats">
                    <span>Всего <b>{{ limitLabel(info.settings.limits.total) }}</b></span>
                    <span>Изображения <b>{{ limitLabel(info.settings.limits.images) }}</b></span>
                    <span>Архивы <b>{{ limitLabel(info.settings.limits.reviews) }}</b></span>
                    <span>Конвертация <b>{{ limitLabel(info.settings.limits.conversions) }}</b></span>
                    <span>Фон <b>{{ limitLabel(info.settings.limits.background) }}</b></span>
                </div>
                <div class="performance-stats">
                    <span>CPU, ядер <b>{{ number(cpuPercent === null ? null : cpuPercent / 100) }} / {{ number(info.machine.cpu) }}</b></span>
                    <span>Память <b>{{ bytes(info.machine.memoryUsed) }} / {{ bytes(info.machine.memoryLimit) }}</b></span>
                    <span v-if="info.processMemory">RSS {{ info.settings.native ? 'Rust' : 'Node' }} <b>{{ bytes(info.processMemory.rss) }}</b></span>
                    <span v-if="info.settings.native && info.databaseCache?.available">Кэш каталога <b>{{ bytes(info.databaseCache.readCacheBytes) }}</b></span>
                    <span v-if="info.databaseCache?.workerHeapUsed">Heap каталога <b>{{ bytes(info.databaseCache.workerHeapUsed) }} / {{ bytes(info.databaseCache.workerHeapLimit) }}</b></span>
                </div>
            </details>
            <div v-if="info.databaseCache?.available === false" class="text-negative" role="alert">
                {{ info.databaseCache.error || 'Каталог недоступен. Перезапустите сервер для восстановления.' }}
            </div>
            <h4>Проверка нагрузки</h4>
            <div class="performance-form">
                <div>
                    <label for="performance-check-mode">Режим проверки</label>
                    <select id="performance-check-mode" v-model="selected" :disabled="running || busy">
                        <option v-for="profile in info.settings.profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
                        <option value="compare">Сравнить три режима</option>
                        <option value="custom">Свои значения</option>
                    </select>
                </div>
                <div class="performance-source">
                    <label for="performance-check-source">Хранилище</label>
                    <select id="performance-check-source" v-model="sourceId" :disabled="running || busy || !info.sources.length" @change="sourceNotice = ''">
                        <option v-if="!info.sources.length" value="">Нет доступных хранилищ</option>
                        <option v-for="source in info.sources" :key="source.id" :value="source.id">{{ source.name }}</option>
                    </select>
                </div>
            </div>
            <div v-if="selected === 'custom' && customLimits" class="performance-custom">
                <q-input v-for="field in editableFields" :key="field.key" v-model.number="customLimits[field.key]" type="number" outlined dense :label="field.label" min="1" :max="info.settings.hardMax" step="1" :disable="running || busy" />
                <div v-if="customError" class="text-negative" role="alert">{{ customError }}</div>
            </div>
            <div v-if="preferenceStatus" class="performance-muted" role="status">{{ preferenceStatus }}</div>
            <div v-if="sourceNotice" class="performance-muted" role="status">{{ sourceNotice }}</div>
            <div class="performance-actions">
                <q-btn v-if="!running" color="primary" no-caps label="Запустить проверку" :loading="busy" data-testid="performance-start"
                    :disable="!sourceId || !info.settings.benchmarkEnabled || info.databaseCache?.available === false || !!customError" @click="start" />
                <q-btn v-else outline no-caps label="Остановить" :loading="busy || info.job.state === 'cancelling'" @click="cancel" />
                <span v-if="!info.settings.benchmarkEnabled" class="performance-muted">Проверка отключена при запуске сервера.</span>
                <span v-else-if="!running" class="performance-muted">До {{ Math.round(info.settings.benchmarkTimeoutMs / 1000) }} с<template v-if="selected === 'unlimited' && info.benchmarkSampleSize"> · {{ info.benchmarkSampleSize }} операций на этап</template></span>
            </div>
            <div v-if="info.job && info.job.state !== 'completed'" class="performance-job" role="status">
                <div>{{ running ? info.job.stage : (info.job.message || info.job.stage) }} <span v-if="running">· {{ Math.round(info.job.progress * 100) }}%</span></div>
                <q-linear-progress v-if="running" rounded size="6px" :value="info.job.progress" color="primary" />
                <div v-if="running && info.job.sample" class="performance-muted">Память {{ bytes(info.job.sample.memoryUsed) }} · CPU {{ number(info.job.sample.cpuPercent / 100) }} ядра</div>
            </div>
            <template v-if="reportSummary">
                <h4>Последняя проверка</h4>
                <div class="performance-result" :data-status="reportSummary.status" data-testid="performance-result">
                    <strong>{{ resultHeadline }}</strong>
                    <span class="performance-muted">{{ [info.report.source?.name, date(info.report.measuredAt)].filter(Boolean).join(' · ') }}</span>
                    <table v-if="info.report.mode === 'compare' && info.report.rows.length" class="performance-comparison">
                        <thead><tr><th>Режим</th><th>Отклик p95</th><th>Пик памяти</th></tr></thead>
                        <tbody><tr v-for="row in info.report.rows" :key="row.profile">
                            <th scope="row">{{ profileName(row.profile) }}</th><td data-label="Отклик p95">{{ duration(row.probeP95Ms) }}</td><td data-label="Пик памяти">{{ bytes(row.peakMemory) }}</td>
                        </tr></tbody>
                    </table>
                    <span v-if="info.recommendation.measured && !info.report.stale && !info.report.legacy && info.report.schema === 2">Рекомендуемый режим — {{ profileName(info.recommendation.profile) }}</span>
                </div>
                <details class="performance-details">
                    <summary>Подробности проверки</summary>
                    <div class="performance-table-wrap" tabindex="0" role="region" aria-label="Замеры по режимам">
                        <table>
                            <thead><tr><th>Режим</th><th>Лимит задач</th><th>Отклик p95</th><th>Пик памяти</th><th>Прирост памяти</th><th>Средний CPU, ядер</th><th>CPU-время</th><th>Первый проход</th><th>Второй проход</th><th>Медиана повторов</th></tr></thead>
                            <tbody><tr v-for="row in info.report.rows" :key="row.profile">
                                <th scope="row">{{ profileName(row.profile) }}</th><td>{{ limitLabel(row.limits?.total) }}</td><td>{{ duration(row.probeP95Ms) }}</td>
                                <td>{{ bytes(row.peakMemory) }}</td><td>{{ bytes(row.memoryDelta) }}</td><td>{{ number(Number.isFinite(row.cpuPercent) ? row.cpuPercent / 100 : null) }}</td>
                                <td>{{ duration(row.cpuTimeMs) }}</td><td>{{ duration(row.firstPassMs) }}</td><td>{{ duration(row.repeatPassMs) }}</td><td>{{ duration(row.elapsedMs) }}</td>
                            </tr></tbody>
                        </table>
                    </div>
                    <div v-for="(row,index) in info.report.rows" :key="row.profile" class="performance-row">
                        <strong>{{ profileName(row.profile) }}</strong> · {{ statusLabel(reportSummary.rows[index]?.status) }}
                        <div class="performance-muted">Архивы {{ limitLabel(row.limits?.reviews) }} · {{ info.settings.native ? 'проверка содержимого' : 'конвертация' }} {{ limitLabel(row.limits?.conversions) }}<template v-if="!info.settings.native"> · изображения {{ limitLabel(row.limits?.images) }}</template></div>
                        <ul v-if="reportSummary.rows[index]?.notes.length"><li v-for="note in reportSummary.rows[index].notes" :key="note">{{ note }}</li></ul>
                    </div>
                    <ul><li v-for="note in [...reportSummary.notes, ...(info.report.warnings || [])]" :key="note">{{ note }}</li></ul>
                    <div v-if="info.recommendation.reason" class="performance-muted">{{ info.recommendation.reason }}</div>
                </details>
            </template>
            <details v-if="selected !== 'compare'" class="performance-details">
                <summary>Параметры запуска · {{ profileName(selected) }}</summary>
                <p class="performance-muted">Для применения измените окружение и перезапустите сервер.</p>
                <pre>{{ compose }}</pre>
                <div class="performance-copy">
                    <q-btn outline no-caps label="Скопировать Compose" :disable="!!customError" @click="copy(compose)" />
                    <q-btn flat no-caps label="Скопировать docker run" :disable="!!customError" @click="copy(docker)" />
                </div>
            </details>
        </template>
        <div v-else-if="!error" class="performance-muted" role="status">Загрузка показателей…</div>
    </section>
</template>

<script>
import {copyToClipboard} from 'quasar';
import preferencesModel from './performancePreferences';
import {summarizeReport} from '../../../../shared/ResourceBenchmarkSummary';

export default {
    data: () => ({info:null, sourceId:'', selected:'', error:'', busy:false, timer:null, generation:0, disposed:false,
        customLimits:null, previousCpu:null, cpuPercent:null,
        preferences:new preferencesModel.PerformancePreferences(), preferenceContext:'', preferencesReady:false, contextVersion:0,
        preferenceStatus:'',sourceNotice:'',
        customFields:[{key:'total', label:'Всего одновременно'}, {key:'images', label:'Изображения'}, {key:'reviews', label:'Архивы'}, {key:'conversions', label:'Конвертация'}]}),
    computed: {
        preferenceIdentity() {return preferencesModel.preferenceScope(this.$store?.state.config,this.$store?.state.settings);},
        testDraft() {return {selected:this.selected,sourceId:this.sourceId,customLimits:this.customLimits};},
        reportSummary() {return this.info?.report ? summarizeReport(this.info.report):null;},
        resultHeadline() {
            const {report} = this.info, summary = this.reportSummary;
            if (report.legacy || report.schema !== 2) return 'Старый формат отчёта. Повторите проверку.';
            if (report.stale) return 'Параметры сервера изменились. Повторите проверку.';
            if (summary.status === 'attention') {
                const slow = summary.rows.find(row => row.checks.probe?.status === 'fail');
                if (slow) return this.profileName(slow.profile) + ' — отклик ' + this.duration(slow.checks.probe.value) + ' при пороге ' + this.duration(slow.checks.probe.maximum);
            }
            return {pass:'Показатели в норме', insufficient:'Предварительный результат', attention:'Есть отклонения', failed:'Проверка завершилась с ошибкой'}[summary.status];
        },
        running() {return ['running','cancelling'].includes(this.info?.job?.state);},
        editableFields() {
            if (!this.info?.settings.native) return this.customFields;
            return this.customFields.filter(field=>field.key !== 'images').map(field =>
                field.key === 'conversions' ? {...field,label:'Проверка содержимого'} : field);
        },
        customError() {
            if (this.selected !== 'custom') return '';
            const limits = this.customLimits, max = this.info?.settings.hardMax || 1;
            if (!limits || this.editableFields.some(({key}) => !Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max)) return `Укажите целые значения от 1 до ${max}.`;
            return this.editableFields.some(({key}) => key !== 'total' && limits[key] > limits.total) ? 'Лимит отдельного вида задач превышает общий.' : '';
        },
        environment() {
            if(this.selected==='compare')return {};
            const env = {...this.info?.settings?.launchEnv, INPX_RESOURCE_PROFILE:this.selected === 'custom' ? 'performance' : this.selected};
            if (this.selected === 'custom' && this.customLimits && !this.customError) Object.assign(env, {
                INPX_RESOURCE_MAX_PROCESSES:String(this.customLimits.total), INPX_RESOURCE_IMAGES:String(this.customLimits.images),
                INPX_RESOURCE_TOTAL:String(this.customLimits.total),
                INPX_RESOURCE_BACKGROUND:String(Math.min(this.info.settings.limits.background ?? this.customLimits.total, this.customLimits.total)),
                INPX_RESOURCE_REVIEWS:String(this.customLimits.reviews), INPX_RESOURCE_CONVERSIONS:String(this.customLimits.conversions)});
            return env;
        },
        compose() {return 'environment:\n' + Object.entries(this.environment).map(([name, value]) => `  ${name}: "${value}"`).join('\n');},
        docker() {return Object.entries(this.environment).map(([name, value]) => `-e ${name}=${value}`).join(' ');},
    },
    watch: {
        preferenceIdentity() {this.restorePreferences();this.refresh();},
        testDraft: {deep:true,handler() {this.savePreferences();}},
    },
    mounted() {this.restorePreferences();this.refresh();},
    beforeUnmount() {this.savePreferences();this.disposed = true;this.generation++;clearTimeout(this.timer);},
    methods: {
        restorePreferences() {
            if(this.preferencesReady)this.savePreferences(this.preferenceContext);
            this.preferencesReady=false;this.contextVersion++;this.generation++;clearTimeout(this.timer);this.timer=null;
            this.info=null;this.previousCpu=null;this.cpuPercent=null;this.error='';this.busy=false;this.sourceNotice='';
            this.preferenceContext=this.preferenceIdentity;
            const saved=this.preferences.read(this.preferenceContext);
            this.selected=saved?.selected || '';this.sourceId=saved?.sourceId || '';this.customLimits=saved?.customLimits || null;
            this.preferencesReady=true;
            this.preferenceStatus = this.preferences.available ? '' : 'Выбор сохранится только на время сеанса.';
        },
        savePreferences(scope=this.preferenceContext) {
            if(!this.preferencesReady || !scope || !this.selected || !this.customLimits)return;
            const saved=this.preferences.write(scope,this.testDraft);
            if(scope===this.preferenceContext)this.preferenceStatus=saved ? ''
                : 'Не удалось сохранить выбор в браузере. Настройки доступны до закрытия панели.';
        },
        scheduleRefresh() {
            clearTimeout(this.timer);
            if(!this.disposed)this.timer=setTimeout(()=>this.refresh(),this.running ? 1000:5000);
        },
        async refresh() {
            clearTimeout(this.timer);this.timer=null;
            const generation = ++this.generation;
            try {
                const info = await this.$root.api.getAdminPerformance();
                if (this.disposed || generation !== this.generation) return;
                const at = performance.now();
                const scope = info.machine.memoryScope === 'cgroup' && Number.isFinite(info.machine.cpuUsageUs) ? 'cgroup' : 'process';
                const usage = scope === 'cgroup' ? info.machine.cpuUsageUs
                    : info.processCpu ? info.processCpu.user + info.processCpu.system : null;
                this.cpuPercent = null;
                if (Number.isFinite(usage) && this.previousCpu?.scope === scope && usage >= this.previousCpu.usage && at > this.previousCpu.at)
                    this.cpuPercent = 100 * (usage - this.previousCpu.usage) / ((at - this.previousCpu.at) * 1000);
                this.previousCpu = Number.isFinite(usage) ? {at, usage, scope} : null;
                this.info = info; this.error = '';
                if (!info.sources.some(item => item.id === this.sourceId)) {
                    if(this.sourceId)this.sourceNotice=info.sources[0] ? 'Хранилище недоступно. Выбрано «'+info.sources[0].name+'».' : '';
                    this.sourceId = info.sources[0]?.id || '';
                }
                if (!this.selected || !['custom','compare',...info.settings.profiles.map(profile=>profile.id)].includes(this.selected))
                    this.selected = info.settings.selected;
                if (!this.customLimits) {
                    const defaults = info.settings.selected === 'unlimited'
                        ? info.settings.profiles.find(p => p.id === 'balanced').limits : info.settings.limits;
                    const {total, images, reviews, conversions} = defaults;
                    this.customLimits = {total, images, reviews, conversions};
                }
            } catch (error) {
                if (!this.disposed && generation === this.generation) this.error = error.message || String(error);
            } finally {
                if (!this.disposed && generation === this.generation)this.scheduleRefresh();
            }
        },
        start() {
            if(this.busy || this.running || !this.sourceId || this.customError)return;
            this.sourceNotice = '';
            const options=preferencesModel.testOptions(this.testDraft);
            if (this.info.settings.native && options.mode === 'custom') options.limits.images = 1;
            return this.performAction(()=>this.$root.api.startAdminBenchmark(options));
        },
        cancel() {return this.performAction(()=>this.$root.api.cancelAdminBenchmark());},
        async performAction(operation) {
            if(this.disposed || this.busy)return;
            const context=this.contextVersion;
            this.busy=true;this.generation++;clearTimeout(this.timer);this.timer=null;
            try {await operation();if(!this.disposed && context===this.contextVersion)await this.refresh();}
            catch(error) {if(!this.disposed && context===this.contextVersion)this.error=error.message || String(error);}
            finally {if(!this.disposed && context===this.contextVersion){this.busy=false;if(!this.timer)this.scheduleRefresh();}}
        },
        async copy(value) {
            try {await copyToClipboard(value); this.$q.notify({type:'positive', message:'Настройки запуска скопированы'});}
            catch (_) {this.error = 'Не удалось скопировать. Выделите настройки в блоке выше.';}
        },
        limitLabel(value) {return value === null ? 'без лимита' : value ?? '—';},
        profileName(id) {return id === 'custom' ? 'Свои значения' : id==='compare' ? 'Сравнение трёх режимов' : this.info?.settings.profiles.find(item => item.id === id)?.name || id;},
        statusLabel(value) {return {pass:'В пределах критериев',attention:'Требует внимания',failed:'Ошибка проверки',insufficient:'Предварительно'}[value] || 'Предварительно';},
        number(value) {return Number.isFinite(value) ? value.toLocaleString('ru-RU', {maximumFractionDigits:1}) : '—';},
        bytes(value) {return Number.isFinite(value) ? (value / (1024 * 1024)).toLocaleString('ru-RU', {maximumFractionDigits:0}) + ' МиБ' : '—';},
        duration(value) {return Number.isFinite(value) ? Math.round(value) + ' мс' : '—';},
        date(value) {return value ? new Date(value).toLocaleString('ru-RU', {dateStyle:'short',timeStyle:'short'}) : '';},
    },
};
</script>

<style scoped>
.performance-panel {container-type:inline-size; grid-column:1/-1; min-width:0; padding:18px; border:1px solid var(--app-border); border-radius:12px; color:var(--app-text); background:var(--app-surface);}
.performance-heading,.performance-active,.performance-actions,.performance-copy {display:flex; align-items:center; justify-content:space-between; gap:10px 16px; flex-wrap:wrap;}
.performance-panel h3,.performance-panel h4 {margin:0; font-weight:700; line-height:1.3; letter-spacing:normal;}
.performance-panel h3 {font-size:18px;} .performance-panel h4 {font-size:15px; margin:20px 0 10px;}
.performance-muted {color:var(--app-muted); font-size:13px; line-height:1.45;}
.performance-active,.performance-result {padding:12px 14px; margin-top:8px; background:var(--app-surface-2); border-radius:8px;}
.performance-active div,.performance-result {display:grid; gap:3px;}
.performance-active > span {font-size:13px; color:var(--app-muted);}
.performance-active b {color:var(--app-text);}
.performance-details {border-bottom:1px solid var(--app-border); min-width:0; padding:9px 0;}
.performance-details:last-child {border-bottom:0; padding-bottom:0;}
.performance-details summary {cursor:pointer; width:fit-content; max-width:100%; padding:4px 0; font-size:13px; color:var(--app-link); font-weight:600;}
.performance-details :is(summary,pre):focus-visible,.performance-table-wrap:focus-visible {outline:2px solid var(--app-link); outline-offset:2px;}
.performance-stats,.performance-actions,.performance-copy {display:flex; gap:8px 16px; flex-wrap:wrap; margin:10px 0; justify-content:flex-start;}
.performance-form,.performance-custom {display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:10px;}
.performance-form > div {display:grid; min-width:0; gap:4px;}
.performance-form label {font-size:13px; color:var(--app-muted);}
.performance-form select {width:100%; min-width:0; min-height:40px; font:inherit; font-size:14px; color:var(--app-text); background:var(--app-surface-2); border:1px solid var(--app-border); border-radius:7px; padding:6px 9px;}
.performance-form select:focus-visible {outline:2px solid var(--app-link); outline-offset:1px;}
.performance-custom,.performance-job {margin-top:12px;}
.performance-custom > .text-negative {grid-column:1/-1;}
.performance-job {display:grid; gap:6px;}
.performance-result[data-status="attention"],.performance-result[data-status="failed"] {border-inline-start:3px solid var(--q-negative);}
.performance-result[data-status="insufficient"] {border-inline-start:3px solid var(--q-warning);}
.performance-table-wrap,.performance-details pre {max-width:100%; overflow-x:auto; margin:10px 0;}
.performance-details pre {padding:10px; background:var(--app-surface-2); border-radius:6px; font-size:12px;}
.performance-details p,.performance-details ul {margin:8px 0;}
.performance-details ul {padding-inline-start:20px; font-size:13px;}
.performance-row {margin:10px 0;}
table {border-collapse:collapse; font-size:13px;}
th,td {text-align:start; padding:6px 10px; border-bottom:1px solid var(--app-border); white-space:nowrap;}
.performance-comparison {width:100%; margin-top:6px;}
.performance-comparison th,.performance-comparison td {padding:5px 3px; white-space:normal; overflow-wrap:anywhere;}
.performance-comparison th[scope="row"] {font-weight:500;}
.performance-comparison tr:last-child td,.performance-comparison tr:last-child th[scope="row"] {border:0;}
@media (max-width:600px) {.performance-panel {padding:12px;} .performance-form {grid-template-columns:1fr;}}
@container (max-width:330px) {
    .performance-heading {gap:4px;}
    .performance-heading h3 {font-size:15px;}
    .performance-comparison thead {position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%);}
    .performance-comparison tbody,.performance-comparison {display:block;}
    .performance-comparison tr {display:grid; grid-template-columns:1fr 1fr; gap:3px 7px; padding:6px 0; border-top:1px solid var(--app-border);}
    .performance-comparison tr > * {padding:0; border:0;}
    .performance-comparison th[scope="row"] {grid-column:1/-1; font-weight:600;}
    .performance-comparison td::before {content:attr(data-label); display:block; font-size:11px; color:var(--app-muted);}
}
</style>
