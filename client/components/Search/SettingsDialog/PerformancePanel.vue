<template>
    <section class="performance-panel">
        <div class="performance-heading">
            <div>
                <div class="performance-title">
                    Производительность
                </div>
                <div class="performance-muted">
                    Выберите параметры проверки и сравните расход ресурсов. Серверные лимиты меняются при следующем запуске контейнера.
                </div>
            </div>
            <q-btn flat dense round icon="la la-sync" aria-label="Обновить показатели производительности" :disable="busy" @click="refresh" />
        </div>
        <div v-if="error" class="text-negative" role="alert">
            {{ error }}
        </div>
        <template v-if="info">
            <h3 class="performance-section-title">Действует на сервере</h3>
            <div class="performance-active" data-testid="performance-active">
                <strong>{{ profileName(info.settings.selected) }}</strong>
                <span>Всего {{ info.settings.limits.total }} · изображения {{ info.settings.limits.images }} · архивы {{ info.settings.limits.reviews }} · конвертация {{ info.settings.limits.conversions }}</span>
            </div>
            <div class="performance-stats">
                <span>Доступно CPU: <b>{{ number(info.machine.cpu) }}</b></span>
                <span>CPU сейчас, ядер: <b>{{ number(cpuPercent === null ? null : cpuPercent / 100) }}</b></span>
                <span>Лимит памяти: <b>{{ bytes(info.machine.memoryLimit) }}</b></span>
                <span>Память сейчас: <b>{{ bytes(info.machine.memoryUsed) }}</b></span>
                <span v-if="info.processMemory">RSS Node: <b>{{ bytes(info.processMemory.rss) }}</b></span>
                <span v-if="info.databaseCache?.workerHeapUsed">Heap каталога: <b>{{ bytes(info.databaseCache.workerHeapUsed) }}<template v-if="info.databaseCache.workerHeapLimit"> / {{ bytes(info.databaseCache.workerHeapLimit) }}</template></b></span>
                <span>Задачи: <b>{{ info.runtime.active }}</b> · в очереди {{ info.runtime.queued }}</span>
            </div>
            <div v-if="info.databaseCache?.available === false" class="text-negative" role="alert">
                {{ info.databaseCache.error || 'Каталог недоступен. Перезапустите сервер для восстановления.' }}
            </div>
            <div class="performance-muted">Текущая память — {{ memoryScope(info.machine.memoryScope) }}. CPU рассчитан между обновлениями показателей.</div>
            <h3 class="performance-section-title">Настройки для теста</h3>
            <p class="performance-muted">Выбор сохраняется в этом браузере для текущего профиля. Он задаёт следующую проверку и не меняет действующие лимиты.</p>
            <div class="performance-profiles">
                <button
                    v-for="profile in info.settings.profiles" :key="profile.id" type="button"
                    class="performance-profile" :class="{'performance-profile--selected': selected === profile.id}"
                    :aria-pressed="selected === profile.id" :disabled="running || busy" @click="selected = profile.id"
                >
                    <strong>{{ profile.name }}</strong>
                    <span v-if="selected === profile.id" class="performance-badge">Для теста</span>
                    <span>Одновременно: {{ profile.limits.total }}</span>
                    <small>Изображения {{ profile.limits.images }} · архивы {{ profile.limits.reviews }} · конвертация {{ profile.limits.conversions }}</small>
                </button>
                <button type="button" class="performance-profile" :class="{'performance-profile--selected': selected === 'custom'}" :aria-pressed="selected === 'custom'" :disabled="running || busy" @click="selected = 'custom'">
                    <strong>Свои значения</strong>
                    <span>Задать параллельность</span>
                    <small>Проверить расход CPU и памяти с выбранными лимитами</small>
                </button>
                <button type="button" class="performance-profile" :class="{'performance-profile--selected': selected === 'compare'}" :aria-pressed="selected === 'compare'" :disabled="running || busy" @click="selected = 'compare'">
                    <strong>Сравнить три режима</strong>
                    <span>Бережный, сбалансированный и производительный</span>
                    <small>Одинаковая проверка для выбора подходящего режима</small>
                </button>
            </div>
            <div class="performance-muted">
                {{ selected === 'compare' ? 'Будут проверены три стандартных режима.' : `Будет проверен только режим «${profileName(selected)}».` }}
            </div>
            <div class="performance-muted" role="status" data-testid="performance-save-status">{{ preferenceStatus }}</div>
            <div v-if="selected === 'custom' && customLimits" class="performance-custom">
                <q-input v-for="field in customFields" :key="field.key" v-model.number="customLimits[field.key]" type="number" outlined dense :label="field.label" min="1" :max="info.settings.hardMax" step="1" :disable="running || busy" />
                <div class="performance-muted">Целые значения от 1 до {{ info.settings.hardMax }}. Лимит каждого вида задач не должен превышать общий.</div>
                <div v-if="customError" class="text-negative" role="alert">{{ customError }}</div>
            </div>
            <div class="performance-benchmark">
                <q-select
                    v-model="sourceId" :options="info.sources" option-label="name" option-value="id" emit-value map-options
                    outlined dense label="Хранилище для проверки" :disable="running || busy" class="performance-source"
                />
                <q-btn
                    v-if="!running" color="primary" no-caps :label="selected === 'compare' ? 'Сравнить три режима' : 'Проверить выбранный режим'" :loading="busy" data-testid="performance-start"
                    :disable="!sourceId || !info.settings.benchmarkEnabled || info.databaseCache?.available === false || !!customError" @click="start"
                />
                <q-btn v-else outline no-caps label="Остановить" :loading="busy || info.job.state === 'cancelling'" @click="cancel" />
            </div>
            <div v-if="sourceNotice" class="performance-muted" role="status">{{ sourceNotice }}</div>
            <div class="performance-muted">
                До {{ testConcurrency }} одновременных тестовых задач,
                лимит времени {{ Math.round(info.settings.benchmarkTimeoutMs / 1000) }} с.
                Библиотека используется для чтения. Проверка создаёт временную нагрузку.
            </div>
            <h3 class="performance-section-title">Ход проверки и последний результат</h3>
            <div v-if="!info.settings.benchmarkEnabled" class="performance-muted">
                Проверка отключена параметрами запуска.
            </div>
            <div v-if="info.job" class="performance-job" role="status" aria-live="polite">
                <div>{{ running ? info.job.stage : (info.job.message || info.job.stage) }} <span v-if="running">· {{ Math.round(info.job.progress * 100) }}%</span></div>
                <q-linear-progress v-if="running" rounded size="6px" :value="info.job.progress" color="primary" />
                <div v-if="info.job.sample && running" class="performance-muted">
                    Память {{ bytes(info.job.sample.memoryUsed) }} · пик {{ bytes(info.job.sample.peakMemory) }}
                    · CPU {{ number(info.job.sample.cpuPercent / 100) }} ядра
                </div>
            </div>
            <div v-if="reportSummary" class="performance-recommendation" :data-status="reportSummary.status" data-testid="performance-result">
                <div class="performance-muted">Последний завершённый результат <span class="performance-result-status">{{ statusLabel(reportSummary.status) }}</span></div>
                <strong>{{ reportSummary.title }}</strong>
                <ul v-if="reportSummary.notes.length"><li v-for="(note,index) in reportSummary.notes" :key="index">{{ note }}</li></ul>
                <div class="performance-muted">Источник: {{ info.report.source?.name || 'Не указан' }} · {{ date(info.report.measuredAt) }}</div>
                <div v-if="info.job && info.job.state !== 'completed'" class="performance-muted">Сохранённый результат относится к предыдущей завершённой проверке. Текущий запуск: {{ running ? 'выполняется' : (info.job.message || info.job.state) }}.</div>
            </div>
            <div v-else class="performance-muted">Результатов пока нет. Выберите режим и запустите проверку.</div>
            <div v-if="reportSummary" class="performance-result-cards">
                <article v-for="(row,index) in info.report.rows" :key="index" class="performance-result-card" :data-status="reportSummary.rows[index]?.status || 'insufficient'">
                    <div class="performance-result-card-heading"><strong>{{ profileName(row.profile) }}</strong><span>{{ statusLabel(reportSummary.rows[index]?.status || 'insufficient') }}</span></div>
                    <div class="performance-muted">Проверенные лимиты: изображения {{ row.limits?.images ?? '—' }} · архивы {{ row.limits?.reviews ?? '—' }} · конвертация {{ row.limits?.conversions ?? '—' }}</div>
                    <div class="performance-result-metrics">
                        <span>Лимит задач <b>{{ row.limits?.total ?? '—' }}</b></span>
                        <span>Отклик p95 <b>{{ duration(row.probeP95Ms) }}</b></span>
                        <span>Пик памяти <b>{{ bytes(row.peakMemory) }}</b></span>
                        <span>Пиковый прирост <b>{{ bytes(row.memoryDelta) }}</b></span>
                        <span>Средний CPU <b>{{ number(Number.isFinite(row.cpuPercent) ? row.cpuPercent / 100 : null) }} ядра</b></span>
                    </div>
                    <ul class="performance-row-notes"><li v-for="(note,noteIndex) in reportSummary.rows[index]?.notes || []" :key="noteIndex">{{ note }}</li></ul>
                </article>
            </div>
            <div class="performance-muted performance-recommendation-note">
                {{ info.recommendation.measured ? 'Рекомендация по сравнению режимов' : 'Предварительная оценка сервера' }}: <strong>{{ profileName(info.recommendation.profile) }}</strong>.
                {{ info.recommendation.reason }}
            </div>
            <details v-if="info.report" class="performance-details">
                <summary>Измерения и пояснения{{ info.report.stale ? ' · устаревший результат' : '' }}</summary>
                <div class="performance-table-wrap">
                    <table>
                        <thead><tr><th>Режим</th><th>Лимит задач</th><th>Первый измеряемый проход</th><th>Второй проход</th><th>Медиана повторов</th><th>Внутренний отклик p95</th><th>Пик памяти*</th><th>Пиковый прирост*</th><th>Средний CPU, ядер*</th><th>CPU-время</th></tr></thead>
                        <tbody>
                            <tr v-for="row in info.report.rows" :key="row.profile">
                                <td>{{ profileName(row.profile) }}{{ row.completed ? '' : ' · ошибка проверки' }}</td>
                                <td>{{ row.limits.total }}</td>
                                <td>{{ duration(row.firstPassMs) }}</td><td>{{ duration(row.repeatPassMs) }}</td>
                                <td>{{ duration(row.elapsedMs) }}<span v-if="row.rounds > 1"> · {{ row.rounds - 1 }} повт.</span></td>
                                <td>{{ duration(row.probeP95Ms) }}</td><td>{{ bytes(row.peakMemory) }}</td>
                                <td>{{ bytes(row.memoryDelta) }}</td><td>{{ number(Number.isFinite(row.cpuPercent) ? row.cpuPercent / 100 : null) }}</td><td>{{ duration(row.cpuTimeMs) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="performance-muted">
                    * Периодическая выборка {{ memoryScope(info.report.machine?.memoryScope) }}. Отклик — внутренняя проверка каталога.
                    Меньшее время проходов означает более быстрое выполнение этой проверки. p95 — время, в которое укладываются 95% внутренних проб, а не поиска в браузере.
                    Первый проход выполняется после подготовки инструментов; кэш ОС и NAS не очищается. Пиковый прирост памяти считается от начала режима и не показывает удержание после сборки мусора.
                    CPU — средняя занятость ядер за тест; без метрик контейнера учитывается только Node.js, без дочерних конвертеров. Лимит задач не равен числу занятых ядер.
                    Между отдельными запусками могут отличаться число операций, другая нагрузка и состояние кэша. Их время нельзя напрямую сравнивать как одинаковый тест.
                </div>
                <div v-for="(warning, i) in info.report.warnings" :key="i" class="performance-muted">
                    {{ warning }}
                </div>
            </details>
            <details v-if="selected !== 'compare'" class="performance-details">
                <summary>Параметры следующего запуска · {{ profileName(selected) }}</summary>
                <pre>{{ compose }}</pre>
                <div class="performance-copy">
                    <q-btn outline no-caps label="Скопировать Compose" :disable="!!customError" @click="copy(compose)" />
                    <q-btn flat no-caps label="Скопировать параметры docker run" :disable="!!customError" @click="copy(docker)" />
                </div>
                <div class="performance-muted">
                    Добавьте параметры к текущему запуску и пересоздайте контейнер. Проверка сама настройки не применяет.
                </div>
            </details>
            <div v-else class="performance-muted performance-recommendation-note">Для параметров запуска выберите один режим или свои значения. Сервер продолжает работать с текущими лимитами.</div>
        </template>
        <div v-else-if="!error" class="performance-muted" role="status">
            Загрузка показателей…
        </div>
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
        testConcurrency() {
            return this.selected==='custom' ? this.customLimits?.total : this.selected==='compare'
                ? Math.max(...this.info.settings.profiles.map(profile=>profile.limits.total))
                : this.info.settings.profiles.find(profile=>profile.id===this.selected)?.limits.total;
        },
        running() {return ['running','cancelling'].includes(this.info?.job?.state);},
        customError() {
            if (this.selected !== 'custom') return '';
            const limits = this.customLimits, max = this.info?.settings.hardMax || 1;
            if (!limits || this.customFields.some(({key}) => !Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max)) return `Укажите целые значения от 1 до ${max}.`;
            return this.customFields.some(({key}) => key !== 'total' && limits[key] > limits.total) ? 'Лимит отдельного вида задач превышает общий.' : '';
        },
        environment() {
            if(this.selected==='compare')return {};
            const env = {...this.info?.settings?.launchEnv, INPX_RESOURCE_PROFILE:this.selected === 'custom' ? 'performance' : this.selected};
            if (this.selected === 'custom' && this.customLimits && !this.customError) Object.assign(env, {
                INPX_RESOURCE_MAX_PROCESSES:String(this.customLimits.total), INPX_RESOURCE_IMAGES:String(this.customLimits.images),
                INPX_RESOURCE_TOTAL:String(this.customLimits.total),
                INPX_RESOURCE_BACKGROUND:String(Math.min(this.info.settings.limits.background, this.customLimits.total)),
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
            this.preferenceStatus=!this.preferenceContext ? 'Настройки доступны в текущем сеансе. Войдите в профиль администратора для локального сохранения.'
                : !this.preferences.available ? 'Локальное хранилище недоступно. Настройки сохранятся только до закрытия панели.'
                    : saved ? 'Выбор восстановлен из этого браузера для текущего профиля.' : 'Изменения сохраняются автоматически в этом браузере.';
        },
        savePreferences(scope=this.preferenceContext) {
            if(!this.preferencesReady || !scope || !this.selected || !this.customLimits)return;
            const saved=this.preferences.write(scope,this.testDraft);
            if(scope===this.preferenceContext)this.preferenceStatus=saved ? 'Сохранено в этом браузере для текущего профиля.'
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
                    if(this.sourceId)this.sourceNotice='Сохранённое хранилище недоступно. Выбрано первое доступное; проверьте источник перед тестом.';
                    this.sourceId = info.sources[0]?.id || '';
                }
                if (!this.selected || !['custom','compare',...info.settings.profiles.map(profile=>profile.id)].includes(this.selected))
                    this.selected = info.settings.selected;
                if (!this.customLimits) {
                    const {total, images, reviews, conversions} = info.settings.limits;
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
            const options=preferencesModel.testOptions(this.testDraft);
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
        profileName(id) {return id === 'custom' ? 'Свои значения' : id==='compare' ? 'Сравнение трёх режимов' : this.info?.settings.profiles.find(item => item.id === id)?.name || id;},
        statusLabel(value) {return {pass:'В пределах критериев',attention:'Требует внимания',failed:'Ошибка проверки',insufficient:'Предварительно'}[value] || 'Предварительно';},
        number(value) {return Number.isFinite(value) ? value.toLocaleString('ru-RU', {maximumFractionDigits:1}) : '—';},
        bytes(value) {return Number.isFinite(value) ? (value / (1024 * 1024)).toLocaleString('ru-RU', {maximumFractionDigits:0}) + ' МиБ' : '—';},
        duration(value) {return Number.isFinite(value) ? Math.round(value) + ' мс' : '—';},
        date(value) {return new Date(value).toLocaleString('ru-RU');},
        memoryScope(value) {
            return ['cgroup','container'].includes(value) ? 'контейнера / группы процессов'
                : value === 'host' ? 'общей группы процессов (оценка предварительная)' : 'только процесса Node.js';
        },
    },
};
</script>

<style scoped>
.performance-panel {grid-column: 1 / -1; min-width: 0; padding: 16px; border: 1px solid var(--app-border); border-radius: 8px; color: var(--app-text); background: var(--app-surface);}
.performance-heading {display: flex; align-items: start; justify-content: space-between; gap: 12px;}
.performance-heading > div {min-width: 0; overflow-wrap: anywhere;}
.performance-title {font-size: 16px; font-weight: 700; margin-bottom: 4px;}
.performance-section-title {font-size: 15px; font-weight: 700; margin: 20px 0 8px;}
.performance-active {display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 10px 12px; border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-surface-2); font-size: 13px;}
.performance-muted {font-size: 12px; color: var(--app-muted); line-height: 1.5;}
.performance-stats {display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 14px 0;}
.performance-recommendation {padding: 12px; background: var(--app-surface-2); border-radius: 6px;}
.performance-recommendation ul {padding-left: 20px; margin: 8px 0; font-size: 13px; line-height: 1.6;}
.performance-recommendation-note, .performance-row-notes {margin: 12px 0; line-height: 1.6;}
.performance-row-notes {font-size: 12px;}
.performance-result-cards {display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 10px; margin: 12px 0;}
.performance-result-card {border: 1px solid var(--app-border); border-radius: 8px; padding: 12px; min-width: 0;}
.performance-result-card-heading {display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; font-size: 13px;}
.performance-result-card-heading > span, .performance-result-status {font-size: 12px; color: var(--app-muted);}
.performance-result-metrics {display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 12px 0; font-size: 12px;}
.performance-result-metrics > span {display: grid; gap: 2px;}
.performance-result-card ul {padding-left: 18px; margin-bottom: 0;}
[data-status="attention"], [data-status="failed"] {border-left: 3px solid var(--q-negative);}
[data-status="insufficient"] {border-left: 3px solid var(--q-warning);}
.performance-profiles {display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px; margin: 12px 0 6px;}
.performance-custom {display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr)); gap: 12px; margin-top: 16px;}
.performance-custom > .performance-muted, .performance-custom > .text-negative {grid-column: 1 / -1;}
.performance-profile {
    display: flex; flex-direction: column; align-items: start; gap: 6px; padding: 12px;
    border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-surface);
    color: var(--app-text); font: inherit; text-align: left; cursor: pointer;
}
.performance-profile--selected {border-color: var(--app-link); box-shadow: inset 0 0 0 1px var(--app-link);}
.performance-profile:focus-visible {outline: 2px solid var(--app-link); outline-offset: 3px;}
.performance-profile small {color: var(--app-muted); line-height: 1.5;}
.performance-profile strong {overflow-wrap: anywhere;}
.performance-badge {font-size: 11px; color: var(--app-link); background: var(--app-surface-2); padding: 2px 6px; border-radius: 4px;}
.performance-benchmark, .performance-copy {display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 16px 0 8px;}
.performance-source {flex: 1 1 220px; min-width: 0;}
.performance-job {display: grid; gap: 8px; margin-top: 12px;}
.performance-details {border-top: 1px solid var(--app-border); margin-top: 14px; padding-top: 12px;}
.performance-details summary {cursor: pointer; font-weight: 600; padding: 4px 0;}
.performance-details pre {overflow-x: auto; padding: 12px; background: var(--app-surface-3); border-radius: 6px; font-size: 12px;}
.performance-table-wrap {overflow-x: auto; margin: 10px 0;}
table {border-collapse: collapse; width: 100%; font-size: 12px;}
th, td {text-align: left; padding: 8px; border-bottom: 1px solid var(--app-border); white-space: nowrap;}
@media (max-width: 650px) {.performance-profiles, .performance-custom {grid-template-columns: 1fr;} .performance-panel {padding: 12px;} .performance-benchmark > .q-btn {width: 100%;}}
</style>
