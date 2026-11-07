<template>
    <section class="performance-panel">
        <div class="performance-heading">
            <div>
                <div class="performance-title">
                    Производительность
                </div>
                <div class="performance-muted">
                    Рекомендации для вашего сервера. Профиль применяется при запуске контейнера.
                </div>
            </div>
            <q-btn flat dense round icon="la la-sync" aria-label="Обновить показатели производительности" :disable="busy" @click="refresh" />
        </div>
        <div v-if="error" class="text-negative" role="alert">
            {{ error }}
        </div>
        <template v-if="info">
            <div class="performance-stats">
                <span>Доступно CPU: <b>{{ number(info.machine.cpu) }}</b></span>
                <span>CPU сейчас, ядер: <b>{{ number(cpuPercent === null ? null : cpuPercent / 100) }}</b></span>
                <span>Лимит памяти: <b>{{ bytes(info.machine.memoryLimit) }}</b></span>
                <span>Память сейчас: <b>{{ bytes(info.machine.memoryUsed) }}</b></span>
                <span v-if="info.processMemory">RSS Node: <b>{{ bytes(info.processMemory.rss) }}</b></span>
                <span>Задачи: <b>{{ info.runtime.active }}</b> · в очереди {{ info.runtime.queued }}</span>
            </div>
            <div v-if="info.databaseCache?.available === false" class="text-negative" role="alert">
                {{ info.databaseCache.error || 'Каталог недоступен. Перезапустите сервер для восстановления.' }}
            </div>
            <div class="performance-muted">Текущая память — {{ memoryScope(info.machine.memoryScope) }}. CPU рассчитан между обновлениями показателей.</div>
            <div class="performance-recommendation">
                <b>{{ info.recommendation.measured ? 'По результатам проверки' : 'Предварительная рекомендация' }}: {{ profileName(info.recommendation.profile) }}</b>
                <div class="performance-muted">
                    {{ info.recommendation.reason }}
                </div>
                <div v-if="info.report && !info.report.stale" class="performance-muted">
                    Проверенный источник: {{ info.report.source.name }}
                </div>
            </div>
            <div class="performance-profiles">
                <button
                    v-for="profile in info.settings.profiles" :key="profile.id" type="button"
                    class="performance-profile" :class="{'performance-profile--selected': selected === profile.id}"
                    :aria-pressed="selected === profile.id" :disabled="running || busy" @click="selected = profile.id"
                >
                    <strong>{{ profile.name }}</strong>
                    <span v-if="info.settings.selected === profile.id" class="performance-badge">Действует</span>
                    <span v-if="info.recommendation.profile === profile.id" class="performance-badge">Рекомендуется</span>
                    <span>Одновременно: {{ profile.limits.total }}</span>
                    <small>Изображения {{ profile.limits.images }} · архивы {{ profile.limits.reviews }} · конвертация {{ profile.limits.conversions }}</small>
                </button>
                <button type="button" class="performance-profile" :class="{'performance-profile--selected': selected === 'custom'}" :aria-pressed="selected === 'custom'" :disabled="running || busy" @click="selected = 'custom'">
                    <strong>Свои значения</strong>
                    <span>Задать параллельность</span>
                    <small>Проверить расход CPU и памяти с выбранными лимитами</small>
                </button>
            </div>
            <div class="performance-muted">
                {{ selected === 'custom' ? 'Проверяется один набор своих значений.' : 'Проверка сравнивает три стандартных профиля. Карточка выбирает пример настроек запуска ниже.' }}
                Действующие настройки при проверке не меняются.
            </div>
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
                    v-if="!running" color="primary" no-caps label="Проверить производительность" :loading="busy"
                    :disable="!sourceId || !info.settings.benchmarkEnabled || info.databaseCache?.available === false || !!customError" @click="start"
                />
                <q-btn v-else outline no-caps label="Остановить" :loading="busy || info.job.state === 'cancelling'" @click="cancel" />
            </div>
            <div class="performance-muted">
                До {{ selected === 'custom' ? customLimits?.total : Math.max(...info.settings.profiles.map(profile => profile.limits.total)) }} одновременных тестовых задач,
                лимит времени {{ Math.round(info.settings.benchmarkTimeoutMs / 1000) }} с.
                Библиотека используется для чтения. Проверка создаёт временную нагрузку.
            </div>
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
            <details v-if="info.report" class="performance-details">
                <summary>Результаты проверки · {{ date(info.report.measuredAt) }}{{ info.report.stale ? ' · устарели' : '' }}</summary>
                <div class="performance-table-wrap">
                    <table>
                        <thead><tr><th>Профиль</th><th>Параллельно</th><th>Первый проход</th><th>Повтор</th><th>Отклик p95</th><th>Пик памяти*</th><th>Прирост памяти*</th><th>CPU, ядер*</th><th>CPU-время</th></tr></thead>
                        <tbody>
                            <tr v-for="row in info.report.rows" :key="row.profile">
                                <td>{{ profileName(row.profile) }}{{ row.completed ? '' : ' · ошибка проверки' }}</td>
                                <td>{{ row.limits.total }}</td>
                                <td>{{ duration(row.firstPassMs) }}</td><td>{{ duration(row.repeatPassMs) }}</td>
                                <td>{{ duration(row.probeP95Ms) }}</td><td>{{ bytes(row.peakMemory) }}</td>
                                <td>{{ bytes(row.memoryDelta) }}</td><td>{{ number(Number.isFinite(row.cpuPercent) ? row.cpuPercent / 100 : null) }}</td><td>{{ duration(row.cpuTimeMs) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="performance-muted">
                    * Периодическая выборка {{ memoryScope(info.report.machine.memoryScope) }}. Отклик — внутренняя проверка каталога.
                    CPU — средняя занятость ядер за тест; без метрик контейнера учитывается только Node.js, без дочерних конвертеров.
                </div>
                <div v-for="(warning, i) in info.report.warnings" :key="i" class="performance-muted">
                    {{ warning }}
                </div>
            </details>
            <details class="performance-details">
                <summary>Настройки запуска · {{ profileName(selected) }}</summary>
                <pre>{{ compose }}</pre>
                <div class="performance-copy">
                    <q-btn outline no-caps label="Скопировать Compose" :disable="!!customError" @click="copy(compose)" />
                    <q-btn flat no-caps label="Скопировать параметры docker run" :disable="!!customError" @click="copy(docker)" />
                </div>
                <div class="performance-muted">
                    Добавьте параметры к текущему запуску и пересоздайте контейнер. Проверка сама настройки не применяет.
                </div>
            </details>
        </template>
        <div v-else-if="!error" class="performance-muted" role="status">
            Загрузка показателей…
        </div>
    </section>
</template>

<script>
import {copyToClipboard} from 'quasar';

export default {
    data: () => ({info:null, sourceId:'', selected:'', error:'', busy:false, timer:null, generation:0, disposed:false,
        customLimits:null, previousCpu:null, cpuPercent:null,
        customFields:[{key:'total', label:'Всего одновременно'}, {key:'images', label:'Изображения'}, {key:'reviews', label:'Архивы'}, {key:'conversions', label:'Конвертация'}]}),
    computed: {
        running() {return ['running','cancelling'].includes(this.info?.job?.state);},
        customError() {
            if (this.selected !== 'custom') return '';
            const limits = this.customLimits, max = this.info?.settings.hardMax || 1;
            if (!limits || this.customFields.some(({key}) => !Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max)) return `Укажите целые значения от 1 до ${max}.`;
            return this.customFields.some(({key}) => key !== 'total' && limits[key] > limits.total) ? 'Лимит отдельного вида задач превышает общий.' : '';
        },
        environment() {
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
    mounted() {this.refresh();},
    beforeUnmount() {this.disposed = true; this.generation++; clearTimeout(this.timer);},
    methods: {
        async refresh() {
            clearTimeout(this.timer);
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
                if (!info.sources.some(item => item.id === this.sourceId)) this.sourceId = info.sources[0]?.id || '';
                if (!this.selected) this.selected = info.recommendation.profile;
                if (!this.customLimits) {
                    const {total, images, reviews, conversions} = info.settings.limits;
                    this.customLimits = {total, images, reviews, conversions};
                }
            } catch (error) {
                if (!this.disposed && generation === this.generation) this.error = error.message || String(error);
            } finally {
                if (!this.disposed && generation === this.generation) this.timer = setTimeout(() => this.refresh(), this.running ? 1000 : 5000);
            }
        },
        async start() {
            this.busy = true; this.generation++;
            try {
                const options = {sourceId:this.sourceId};
                if (this.selected === 'custom') {options.mode = 'custom'; options.limits = {...this.customLimits};}
                await this.$root.api.startAdminBenchmark(options); await this.refresh();
            }
            catch (error) {this.error = error.message || String(error);}
            finally {this.busy = false;}
        },
        async cancel() {
            this.busy = true; this.generation++;
            try {await this.$root.api.cancelAdminBenchmark(); await this.refresh();}
            catch (error) {this.error = error.message || String(error);}
            finally {this.busy = false;}
        },
        async copy(value) {
            try {await copyToClipboard(value); this.$q.notify({type:'positive', message:'Настройки запуска скопированы'});}
            catch (_) {this.error = 'Не удалось скопировать. Выделите настройки в блоке выше.';}
        },
        profileName(id) {return id === 'custom' ? 'Свои значения' : this.info?.settings.profiles.find(item => item.id === id)?.name || id;},
        number(value) {return Number.isFinite(value) ? value.toLocaleString('ru-RU', {maximumFractionDigits:1}) : '—';},
        bytes(value) {return Number.isFinite(value) ? (value / (1024 * 1024)).toLocaleString('ru-RU', {maximumFractionDigits:0}) + ' МБ' : '—';},
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
.performance-title {font-size: 16px; font-weight: 700; margin-bottom: 4px;}
.performance-muted {font-size: 12px; color: var(--app-muted); line-height: 1.5;}
.performance-stats {display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 14px 0;}
.performance-recommendation {padding: 12px; background: var(--app-surface-2); border-radius: 6px;}
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
