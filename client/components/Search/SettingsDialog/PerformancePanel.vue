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
                <span>CPU: <b>{{ number(info.machine.cpu) }}</b></span>
                <span>Память: <b>{{ bytes(info.machine.memoryLimit) }}</b></span>
                <span>Задачи: <b>{{ info.runtime.active }}</b> · в очереди {{ info.runtime.queued }}</span>
            </div>
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
                    :aria-pressed="selected === profile.id" @click="selected = profile.id"
                >
                    <strong>{{ profile.name }}</strong>
                    <span v-if="info.settings.selected === profile.id" class="performance-badge">Действует</span>
                    <span v-if="info.recommendation.profile === profile.id" class="performance-badge">Рекомендуется</span>
                    <span>Одновременно: {{ profile.limits.total }}</span>
                    <small>Изображения {{ profile.limits.images }} · архивы {{ profile.limits.reviews }} · конвертация {{ profile.limits.conversions }}</small>
                </button>
            </div>
            <div class="performance-muted">
                Лимиты учитывают CPU, память и параметры запуска. Выбор карточки меняет только пример настроек ниже.
            </div>
            <div class="performance-benchmark">
                <q-select
                    v-model="sourceId" :options="info.sources" option-label="name" option-value="id" emit-value map-options
                    outlined dense label="Хранилище для проверки" :disable="running || busy" class="performance-source"
                />
                <q-btn
                    v-if="!running" color="primary" no-caps label="Проверить производительность" :loading="busy"
                    :disable="!sourceId || !info.settings.benchmarkEnabled" @click="start"
                />
                <q-btn v-else outline no-caps label="Остановить" :loading="busy || info.job.state === 'cancelling'" @click="cancel" />
            </div>
            <div class="performance-muted">
                До {{ Math.max(...info.settings.profiles.map(profile => profile.limits.total)) }} одновременных тестовых задач,
                лимит времени {{ Math.round(info.settings.benchmarkTimeoutMs / 1000) }} с.
                Библиотека используется для чтения. Проверка создаёт временную нагрузку.
            </div>
            <div v-if="!info.settings.benchmarkEnabled" class="performance-muted">
                Проверка отключена параметрами запуска.
            </div>
            <div v-if="info.job" class="performance-job" role="status" aria-live="polite">
                <div>{{ running ? info.job.stage : (info.job.message || info.job.stage) }}</div>
                <q-linear-progress v-if="running" rounded size="6px" :value="info.job.progress" color="primary" />
            </div>
            <details v-if="info.report" class="performance-details">
                <summary>Результаты проверки · {{ date(info.report.measuredAt) }}{{ info.report.stale ? ' · устарели' : '' }}</summary>
                <div class="performance-table-wrap">
                    <table>
                        <thead><tr><th>Профиль</th><th>Первый проход</th><th>Повтор</th><th>Отклик p95</th><th>Пик памяти*</th></tr></thead>
                        <tbody>
                            <tr v-for="row in info.report.rows" :key="row.profile">
                                <td>{{ profileName(row.profile) }}{{ row.completed ? '' : ' · ошибка проверки' }}</td>
                                <td>{{ duration(row.firstPassMs) }}</td><td>{{ duration(row.repeatPassMs) }}</td>
                                <td>{{ duration(row.probeP95Ms) }}</td><td>{{ bytes(row.peakMemory) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="performance-muted">
                    * Периодическая выборка {{ memoryScope(info.report.machine.memoryScope) }}. Отклик — внутренняя проверка каталога.
                </div>
                <div v-for="(warning, i) in info.report.warnings" :key="i" class="performance-muted">
                    {{ warning }}
                </div>
            </details>
            <details class="performance-details">
                <summary>Настройки запуска · {{ profileName(selected) }}</summary>
                <pre>{{ compose }}</pre>
                <div class="performance-copy">
                    <q-btn outline no-caps label="Скопировать Compose" @click="copy(compose)" />
                    <q-btn flat no-caps label="Скопировать параметры docker run" @click="copy(docker)" />
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
    data: () => ({info:null, sourceId:'', selected:'', error:'', busy:false, timer:null, generation:0, disposed:false}),
    computed: {
        running() {return ['running','cancelling'].includes(this.info?.job?.state);},
        environment() {return {...this.info?.settings?.launchEnv, INPX_RESOURCE_PROFILE:this.selected};},
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
                this.info = info; this.error = '';
                if (!info.sources.some(item => item.id === this.sourceId)) this.sourceId = info.sources[0]?.id || '';
                if (!this.selected) this.selected = info.recommendation.profile;
            } catch (error) {
                if (!this.disposed && generation === this.generation) this.error = error.message || String(error);
            } finally {
                if (!this.disposed && generation === this.generation) this.timer = setTimeout(() => this.refresh(), this.running ? 1000 : 5000);
            }
        },
        async start() {
            this.busy = true; this.generation++;
            try {await this.$root.api.startAdminBenchmark({sourceId:this.sourceId}); await this.refresh();}
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
        profileName(id) {return this.info?.settings.profiles.find(item => item.id === id)?.name || id;},
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
.performance-profiles {display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 12px 0 6px;}
.performance-profile {
    display: flex; flex-direction: column; align-items: start; gap: 6px; padding: 12px;
    border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-surface);
    color: var(--app-text); font: inherit; text-align: left; cursor: pointer;
}
.performance-profile--selected {border-color: var(--app-link); box-shadow: inset 0 0 0 1px var(--app-link);}
.performance-profile:focus-visible {outline: 2px solid var(--app-link); outline-offset: 3px;}
.performance-profile small {color: var(--app-muted); line-height: 1.5;}
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
@media (max-width: 650px) {.performance-profiles {grid-template-columns: 1fr;} .performance-panel {padding: 12px;} .performance-benchmark > .q-btn {width: 100%;}}
</style>
