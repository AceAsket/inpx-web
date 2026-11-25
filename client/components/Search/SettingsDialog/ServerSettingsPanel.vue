<template>
    <details class="server-section">
        <summary><q-icon name="la la-shield-alt" />Доступ и прокси</summary>
        <div class="server-form">
            <q-checkbox :model-value="access.allowAnonymousAccess && !access.localLoginForced" label="Разрешить гостевой доступ"
                :disable="!!saving || accessLocked('allowAnonymousAccess') || access.localLoginForced"
                @update:model-value="access.allowAnonymousAccess = $event" />
            <p v-if="access.localLoginForced" class="hint">Для входа требуются учётные данные по настройке сервера.</p>
            <small v-if="accessLocked('allowAnonymousAccess')" class="hint">INPX_ALLOW_ANONYMOUS_ACCESS · окружение</small>
            <q-checkbox v-model="access.trustProxy" label="Доверять заголовкам от указанных прокси"
                :disable="!!saving || accessLocked('trustProxy')" />
            <small v-if="accessLocked('trustProxy')" class="hint">INPX_TRUST_PROXY · окружение</small>
            <q-input v-model="networks" type="textarea" autogrow outlined dense
                label="IP и сети доверенных прокси" hint="Одна сеть или адрес на строку"
                placeholder="192.168.1.10/32" :disable="!!saving || accessLocked('trustedProxyCidrs')" />
            <small v-if="accessLocked('trustedProxyCidrs')" class="hint">INPX_TRUSTED_PROXY_CIDRS · окружение</small>
            <p class="hint">TCP-адрес, который видит сервер <code>{{ savedAccess.peer }}</code> · {{ peerInProxyCidrs ? 'в списке адресов прокси' : 'вне списка адресов прокси' }}</p>
            <q-input v-model="adminNetworks" type="textarea" autogrow outlined dense
                label="Разрешённые IP и сети администратора"
                hint="Один IPv4, IPv6 или CIDR на строку. Пустой список снимает ограничение по IP."
                :disable="!!saving || accessLocked('adminAllowedCidrs')" />
            <small v-if="accessLocked('adminAllowedCidrs')" class="hint">INPX_ADMIN_ALLOWED_CIDRS · окружение</small>
            <p class="hint">IP для проверки доступа администратора <code v-if="savedAccess.adminClient">{{ savedAccess.adminClient }}</code>
                <span v-else>· прокси не передал адрес клиента</span>
            </p>
            <details>
                <summary>Правила входа и SSO</summary>
                <div class="server-fields">
                    <div v-for="field in accessFields" :key="field.key" class="server-field">
                        <q-checkbox v-if="field.type === 'boolean'" v-model="access[field.key]" :label="field.label"
                            :disable="!!saving || accessLocked(field.key) || (field.key === 'adminDirectOnly' && legacyRuleLockedHere)" />
                        <q-select v-else-if="field.options" v-model="access[field.key]" :options="field.options"
                            emit-value map-options outlined dense :label="field.label" :disable="!!saving || accessLocked(field.key)" />
                        <q-input v-else v-model="access[field.key]" outlined dense :label="field.label"
                            :disable="!!saving || accessLocked(field.key)" />
                        <small v-if="accessLocked(field.key)" class="hint">{{ field.env }} · окружение</small>
                        <small v-if="field.key === 'adminDirectOnly' && legacyRuleLockedHere" class="hint">
                            Подключитесь с адреса вне списка прокси. Если Docker показывает шлюз для обоих маршрутов,
                            выделите прокси свой IP в общей сети Docker.
                        </small>
                        <small v-else-if="field.hint" class="hint">{{ field.hint }}</small>
                    </div>
                </div>
            </details>
            <div class="server-actions">
                <q-btn unelevated color="primary" no-caps label="Сохранить доступ" :loading="saving === 'access'"
                    :disable="!!saving || !Object.keys(accessPatch).length" @click="saveAccess" />
            </div>
        </div>
    </details>
    <details v-for="group in groups" :key="group.id" class="server-section">
        <summary><q-icon :name="group.icon" />{{ group.title }}</summary>
        <div class="server-form">
            <div v-if="group.id === 'conversion'">
                <p class="hint">Доступны сейчас · {{ availableFormats }}</p>
                <p v-if="runtime.tools" class="hint">{{ converterStatus }}</p>
                <q-option-group v-model="settings.conversionFormats" :options="formatOptions" type="checkbox"
                    inline :disable="isLocked('conversionFormats')" />
                <small v-if="isLocked('conversionFormats')" class="hint">{{ locked.conversionFormats }} · окружение</small>
            </div>
            <p v-if="group.id === 'covers'" class="hint">djxl · {{ runtime.djxl ? 'найден' : 'недоступен' }}</p>
            <p v-if="group.id === 'limits'" class="hint">{{ effectiveLimits }}</p>
            <p v-if="group.id === 'speech'" class="hint">Silero · {{ runtime.ttsActive ? 'включён в настройках' : 'выключен' }}</p>
            <p v-if="group.id === 'logging' && runtime.settings?.logToFile && runtime.logging?.fileActive === false" class="hint">
                Файловый журнал недоступен. Записи идут в консоль.
            </p>
            <p v-if="group.id === 'maintenance' && runtime.indexOptions" class="hint">
                Действует · {{ runtime.indexOptions.filter }} · {{ runtime.indexOptions.lowMemory ? 'экономия памяти' : 'обычный режим' }}
                <span v-if="runtime.indexOptions.pending"> · Применится после переиндексации</span>
            </p>
            <div class="server-fields">
                <div v-for="field in group.fields" :key="field.key" class="server-field">
                    <q-checkbox v-if="field.type === 'boolean'" v-model="settings[field.key]"
                        :label="field.label" :disable="isLocked(field.key)" />
                    <q-select v-else-if="field.options" v-model="settings[field.key]" :options="field.options"
                        emit-value map-options outlined dense :label="field.label" :disable="isLocked(field.key)" />
                    <q-input v-else v-model="settings[field.key]" :type="field.type || 'text'" :min="field.min"
                        :max="field.max" :label="field.label" :hint="field.hint" outlined dense
                        :disable="isLocked(field.key)" :autocomplete="field.type === 'password' ? 'new-password' : undefined"
                        :placeholder="field.type === 'password' && secretSet(field.key) ? 'Ключ задан' : undefined" />
                    <small v-if="isLocked(field.key)" class="hint">{{ locked[field.key] }} · задано при запуске</small>
                </div>
            </div>
            <div class="server-actions">
                <q-btn v-if="group.id === 'logging' && runtime.logging && !runtime.logging.lockedBy"
                    outline color="primary" no-caps :label="debugActive ? 'Завершить debug' : 'Включить debug на 15 минут'"
                    :disable="!!saving" @click="setDebug(!debugActive)" />
                <template v-for="field in group.fields" :key="field.key">
                    <q-checkbox v-if="field.type === 'password' && secretSet(field.key) && !isLocked(field.key)"
                        v-model="removeSecrets[field.key]" label="Удалить сохранённый ключ" />
                </template>
                <q-btn unelevated color="primary" no-caps label="Сохранить" :loading="saving === group.id"
                    :disable="!!saving || !Object.keys(groupPatch(group)).length" @click="saveGroup(group)" />
            </div>
        </div>
    </details>
    <details v-if="config.adminLaunch" class="server-section">
        <summary><q-icon name="la la-terminal" />Параметры запуска</summary>
        <dl class="launch-parameters">
            <dt>Адрес и порт</dt><dd><code>{{ config.adminLaunch.address }}</code></dd>
            <dt>Префикс URL</dt><dd><code>{{ config.adminLaunch.prefix || '/' }}</code></dd>
            <dt>Каталог данных</dt><dd><code>{{ config.adminLaunch.dataDir }}</code></dd>
            <dt>Файл конфигурации</dt><dd><code>{{ config.adminLaunch.configFile }}</code></dd>
        </dl>
    </details>
</template>

<script>
const number = (key, label, min, max, hint) => ({key, label, type: 'number', min, max, hint});
const toggle = (key, label) => ({key, label, type: 'boolean'});
const accessFields = [
    {key: 'authMode', env: 'INPX_AUTH_MODE', label: 'Режим входа', options: [
        {label: 'Локальные профили', value: 'local'}, {label: 'Внешний SSO', value: 'proxy'}, {label: 'Без режима обязательного входа', value: 'none'},
    ]},
    {...toggle('requireAuth', 'Требовать вход'), env: 'INPX_REQUIRE_AUTH'},
    {...toggle('adminDirectOnly', 'Разрешить вход администратора только напрямую'), env: 'INPX_ADMIN_DIRECT_ONLY',
        hint: 'При пустом списке адресов администратора действует правило прямого входа.'},
    {key: 'proxyAuthHeader', label: 'Заголовок с именем пользователя SSO', env: 'INPX_PROXY_AUTH_HEADER'},
    {...toggle('authExemptHealth', 'Разрешить публичную проверку состояния'), env: 'INPX_AUTH_EXEMPT_HEALTH'},
];
const groups = [
    {id: 'logging', title: 'Логирование', icon: 'la la-file-alt', fields: [
        {key: 'logLevel', label: 'Уровень', options: ['error', 'warn', 'info']},
        toggle('logToFile', 'Сохранять журнал в файл'),
    ]},
    {id: 'webDefaults', title: 'Поиск и настройки по умолчанию', icon: 'la la-search', fields: [
        toggle('extendedSearch', 'Расширенный поиск'),
        {key: 'bookReadLink', label: 'Ссылка на внешнюю читалку', hint: 'Можно использовать ${DOWNLOAD_LINK} или ${DOWNLOAD_URI}'},
        {...number('defaultLimit', 'Книг на странице', 1, 120), defaultKey: 'limit', fallback: 20},
        {key: 'defaultLanguage', label: 'Язык книг', hint: 'Код языка, например ru. Пусто — все языки', defaultKey: 'langDefault', fallback: ''},
        {key: 'defaultCardView', label: 'Вид книг', defaultKey: 'bookCardView', fallback: 'cards', options: [
            {label: 'Карточки', value: 'cards'}, {label: 'Список', value: 'list'},
        ]},
        {...toggle('defaultDarkTheme', 'Ночная тема'), defaultKey: 'darkTheme', fallback: false},
    ]},
    {id: 'maintenance', title: 'Проверка INPX и ISBN', icon: 'la la-barcode', fields: [
        {key: 'inpxFilterFile', label: 'JSON-файл фильтра INPX', hint: 'Пусто — filter.json рядом с конфигурацией'},
        toggle('lowMemoryMode', 'Экономить память при переиндексации'),
        number('inpxCheckInterval', 'Проверять изменения INPX каждые, мин', 0, 10080, '0 отключает проверку'),
        number('isbnMaxBookMb', 'Максимальный размер книги для ISBN, МиБ', 1, 16384, 'Со следующей подготовки'),
    ]},
    {id: 'conversion', title: 'Чтение и конвертация', icon: 'la la-exchange-alt', fields: [
        toggle('onlineReaderEnabled', 'Онлайн-читалка'),
        toggle('conversionEnabled', 'Разрешить конвертацию'),
        toggle('mobiEnabled', 'Разрешить MOBI'),
        number('conversionQueueLimit', 'Мест в очереди', 0, 256),
        number('conversionQueueTimeoutMs', 'Ожидание в очереди, мс', 1000, 3600000),
        number('conversionTimeoutMs', 'Время конвертации, мс', 1000, 3600000),
        {key: 'bookFilenameTemplate', label: 'Шаблон имени файла'},
        {key: 'bookTitleTemplate', label: 'Шаблон названия книги'},
    ]},
    {id: 'fb2cng', title: 'Дополнительные настройки fb2cng', icon: 'la la-file-code', fields: [
        {key: 'fb2cngConfigPath', label: 'YAML-конфигурация', hint: 'Путь к файлу на сервере'},
        {key: 'fb2cngArgs', label: 'Аргументы fb2cng', type: 'textarea', hint: 'Каждый аргумент с новой строки'},
    ]},
    {id: 'kosync', title: 'Синхронизация KOReader', icon: 'la la-sync', fields: [
        toggle('kosyncEnabled', 'Разрешить синхронизацию для всей библиотеки'),
    ]},
    {id: 'loginRate', title: 'Ограничение попыток входа', icon: 'la la-user-lock', fields: [
        toggle('loginRateLimitEnabled', 'Ограничивать попытки входа'),
        number('loginRateLimitMaxAttempts', 'Попыток за период', 1, 1000),
        number('loginRateLimitWindowMinutes', 'Период, мин', 1, 1440),
    ]},
    {id: 'abs', title: 'Audiobookshelf', icon: 'la la-headphones', fields: [
        toggle('absEnabled', 'Опубликовать провайдер метаданных'),
        {key: 'absPublicUrl', label: 'Публичный URL библиотеки', type: 'url', hint: 'Пусто — использовать адрес запроса'},
        {key: 'absToken', label: 'Токен Audiobookshelf', type: 'password'},
        number('absMaxResults', 'Максимум результатов', 1, 20),
    ]},
    {id: 'metrics', title: 'Prometheus', icon: 'la la-chart-line', fields: [
        toggle('metricsEnabled', 'Опубликовать метрики'),
        {key: 'metricsPath', label: 'Путь метрик'},
        {key: 'metricsToken', label: 'Токен метрик', type: 'password'},
        toggle('metricsExemptAuth', 'Разрешить сбор без входа через SSO'),
    ]},
    {id: 'covers', title: 'Обложки', icon: 'la la-image', fields: [
        {key: 'jxlDecoder', label: 'Декодер JPEG XL', options: [
            {label: 'Нативный, с резервным djxl', value: 'native'},
            {label: 'Только djxl', value: 'djxl'},
        ]},
        number('coverMemoryMb', 'Кэш обложек в памяти, МиБ', 0, 1024, '0 отключает хранение изображений в памяти'),
    ]},
    {id: 'limits', title: 'Лимиты очередей', icon: 'la la-tachometer-alt', fields: [
        number('resourceTotal', 'Всего задач', 1, 16, 'Пусто — по профилю ресурсов'),
        number('resourceImages', 'Обложки', 1, 16),
        number('resourceReviews', 'Обзоры и предпросмотр', 1, 16),
        number('resourceConversions', 'Конвертации', 1, 16),
        number('resourceBackground', 'Фоновые задачи', 1, 16),
        number('resourceTaskTimeoutMs', 'Ожидание ресурсов, мс', 1000, 3600000),
        toggle('resourceBenchEnabled', 'Разрешить тест производительности'),
        number('resourceBenchTimeoutMs', 'Длительность теста, мс', 10000, 180000),
    ]},
    {id: 'transferLimits', title: 'Размер запросов и резервных копий', icon: 'la la-file-archive', fields: [
        number('wsMessageLimitMb', 'Обычный запрос WebSocket, МиБ', 1, 16, 'Увеличение действует после переподключения'),
        number('importLimitMb', 'Импорт настроек и списков, МиБ', 1, 64),
        number('backupUploadLimitMb', 'Архив резервной копии, МиБ', 1, 128),
        number('backupExpandedLimitMb', 'Распакованная резервная копия, МиБ', 1, 256),
    ]},
    {id: 'speech', title: 'Озвучка Silero', icon: 'la la-headphones', fields: [
        toggle('ttsEnabled', 'Включить серверную озвучку'),
        {key: 'ttsUrl', label: 'URL сервиса', type: 'url'},
        {key: 'ttsModel', label: 'Модель'},
        {key: 'ttsApiKey', label: 'Ключ API', type: 'password'},
        number('ttsTimeoutMs', 'Таймаут задания, мс', 1, 3600000),
        number('ttsCacheSizeMb', 'Дисковый кэш аудио, МиБ', 64, 1048576),
    ]},
];
const formats = ['fb2', 'epub', 'epub3', 'kepub', 'kfx', 'azw3', 'azw8', 'mobi', 'pdf'];
const MIB = 1024 * 1024;
const toolLabels = {fb2cng: 'fb2cng', pdf: 'Конвертер PDF', kindling: 'Kindling'};
const units = {isbnMaxBookMb: ['isbnMaxBookBytes', MIB], loginRateLimitWindowMinutes: ['loginRateLimitWindowMs', 60000]};
const serverKey = key => units[key]?.[0] || key;
const formKey = key => Object.keys(units).find(field => units[field][0] === key) || key;
const secretKeys = groups.flatMap(group => group.fields.filter(field => field.type === 'password').map(field => field.key));

export default {
    props: {config: {type: Object, required: true}},
    data() {
        return {
            access: {...this.config.adminAccess},
            savedAccess: this.config.adminAccess,
            networks: this.config.adminAccess.trustedProxyCidrs.join('\n'),
            adminNetworks: (this.config.adminAccess.adminAllowedCidrs ?? []).join('\n'),
            runtime: this.config.adminRuntime,
            settings: {},
            groups,
            formatOptions: formats.map(value => ({value, label: value.toUpperCase()})),
            removeSecrets: {},
            saving: '',
            debugActive: false,
            debugTimer: null,
        };
    },
    computed: {
        peerInProxyCidrs() { return this.savedAccess.peerInProxyCidrs ?? this.savedAccess.peerTrusted; },
        legacyRuleLockedHere() { return this.peerInProxyCidrs && !this.savedAccess.adminAllowedCidrs?.length; },
        accessFields() { return accessFields.filter(field => field.key !== 'adminDirectOnly' || this.savedAccess.adminDirectOnly); },
        locked() { return this.runtime.locked; },
        availableFormats() { return this.runtime.formats.map(format => format.toUpperCase()).join(', ') || 'исходный формат'; },
        converterStatus() {
            return Object.entries(toolLabels).map(([key, label]) => label + ' ' +
                (this.runtime.tools[key] ? 'найден' : 'отсутствует')).join(' · ');
        },
        effectiveLimits() {
            const {total, images, conversions, background} = this.runtime.limits;
            const current = value => value ?? 'без лимита';
            return `Сейчас действует · всего ${current(total)} · обложки ${current(images)} · конвертации ${current(conversions)} · фон ${current(background)}`;
        },
        accessPatch() {
            const patch = {};
            const original = this.savedAccess;
            for (const key of ['allowAnonymousAccess', 'trustProxy', ...this.accessFields.map(field => field.key)]) {
                if (key === 'adminDirectOnly' && this.legacyRuleLockedHere) continue;
                if (!this.accessLocked(key) && this.access[key] !== original[key])
                    patch[key] = this.access[key];
            }
            for (const [key, draft] of [['trustedProxyCidrs', this.networks], ['adminAllowedCidrs', this.adminNetworks]]) {
                const addresses = draft.split(/[\s,]+/).filter(Boolean);
                if (!this.accessLocked(key) && addresses.join(',') !== (original[key] ?? []).join(','))
                    patch[key] = addresses;
            }
            return patch;
        },
    },
    created() {
        this.loadRuntime(this.runtime);
    },
    beforeUnmount() {
        clearTimeout(this.debugTimer);
    },
    watch: {
        'config.adminRuntime'(next) {
            if (!this.saving) this.syncRuntime(next);
        },
    },
    methods: {
        accessLocked(key) { return this.access.locked.includes(key); },
        secretSet(key) { return this.runtime.settings[key] === '__KEEP__'; },
        isLocked(key) { return !!this.locked[serverKey(key)]; },
        loadRuntime(runtime) {
            this.runtime = runtime;
            this.settings = {...runtime.settings, conversionFormats: [...runtime.settings.conversionFormats],
                fb2cngArgs: (runtime.settings.fb2cngArgs || []).join('\n')};
            for (const [field, [key, unit]] of Object.entries(units)) this.settings[field] = runtime.settings[key] / unit;
            for (const key of secretKeys) this.settings[key] = '';
            const defaults = groups.find(group => group.id === 'webDefaults').fields;
            for (const field of defaults.filter(field => field.defaultKey))
                this.settings[field.key] = runtime.settings.uiDefaults?.[field.defaultKey] ?? field.fallback;
            clearTimeout(this.debugTimer);
            const remaining = runtime.logging?.debugRemainingMs || 0;
            this.debugActive = remaining > 0;
            if (remaining) this.debugTimer = setTimeout(() => { this.debugActive = false; }, remaining);
            this.removeSecrets = {};
        },
        syncRuntime(runtime, savedGroup) {
            const pending = this.groups.filter(group => group.id !== savedGroup)
                .map(group => this.groupPatch(group));
            const draft = this.settings;
            const removeSecrets = this.removeSecrets;
            this.loadRuntime(runtime);
            for (const patch of pending) {
                for (const key of Object.keys(patch)) {
                    if (key === 'uiDefaults') {
                        for (const field of this.groups.find(group => group.id === 'webDefaults').fields)
                            if (Object.hasOwn(patch.uiDefaults, field.defaultKey)) this.settings[field.key] = draft[field.key];
                        continue;
                    }
                    const field = formKey(key);
                    if (!this.isLocked(field)) {
                        this.settings[field] = draft[field];
                        if (secretKeys.includes(key)) this.removeSecrets[key] = removeSecrets[key];
                    }
                }
            }
        },
        groupPatch(group) {
            const patch = {};
            if (group.id === 'conversion' && !this.isLocked('conversionFormats')
                && [...this.settings.conversionFormats].sort().join(',') !== [...this.runtime.settings.conversionFormats].sort().join(','))
                patch.conversionFormats = this.settings.conversionFormats;
            for (const field of group.fields) {
                const key = serverKey(field.key);
                if (this.isLocked(key)) continue;
                let value = this.settings[field.key];
                if (secretKeys.includes(key)) {
                    if (this.removeSecrets[key] || (value && value.trim())) patch[key] = this.removeSecrets[key] ? '' : value;
                    continue;
                }
                if (key === 'fb2cngArgs') {
                    const args = value.split(/\r?\n/).filter(arg => arg.trim());
                    if (JSON.stringify(args) !== JSON.stringify(this.runtime.settings[key])) patch[key] = args;
                    continue;
                }
                if (field.type === 'number') {
                    value = value === '' || value == null ? null : Number(value);
                    if (units[field.key] && value !== null) value *= units[field.key][1];
                }
                if (field.defaultKey) {
                    const previous = this.runtime.settings.uiDefaults?.[field.defaultKey] ?? field.fallback;
                    if (value !== previous) (patch.uiDefaults ??= {})[field.defaultKey] = value;
                    continue;
                }
                if (value !== (this.runtime.settings[key] ?? null)) patch[key] = value;
            }
            return patch;
        },
        async setDebug(enabled) {
            this.saving = 'logging';
            try {
                const {runtime} = await this.$root.api.saveAdminRuntime({}, enabled);
                this.syncRuntime(runtime);
            } catch (error) {
                this.$root.stdDialog.alert(error.message, 'Логирование');
            } finally {
                this.saving = '';
            }
        },
        async saveAccess() {
            this.saving = 'access';
            try {
                const {access} = await this.$root.api.saveAdminAccess(this.accessPatch);
                this.access = {...access};
                this.savedAccess = access;
                this.networks = access.trustedProxyCidrs.join('\n');
                this.adminNetworks = access.adminAllowedCidrs.join('\n');
                this.$root.notify.success('Настройки доступа применены');
            } catch (error) {
                this.$root.notify.error(error.message);
            } finally {
                this.saving = '';
            }
        },
        async saveGroup(group) {
            this.saving = group.id;
            try {
                const {runtime} = await this.$root.api.saveAdminRuntime(this.groupPatch(group));
                this.syncRuntime(runtime, group.id);
                this.$root.notify.success('Настройки применены');
            } catch (error) {
                this.$root.notify.error(error.message);
            } finally {
                this.saving = '';
            }
        },
    },
};
</script>

<style scoped>
.server-section {border: 1px solid var(--app-border); border-radius: 14px; background: var(--app-surface); margin-bottom: 10px;}
.server-section > summary {cursor: pointer; padding: 13px 16px; list-style: none; display: flex; align-items: center; gap: 10px; font-weight: 600;}
.server-section > summary::-webkit-details-marker {display: none;}
.server-section > summary::after {content: '›'; margin-inline-start: auto; color: var(--app-muted); font-size: 1.3em;}
.server-section[open] > summary::after {transform: rotate(90deg);}
.server-form {padding: 0 16px 16px; display: grid; gap: 10px;}
.server-fields {display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px;}
.server-actions {display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 4px;}
.hint {color: var(--app-muted); margin: 0;}
.server-field > small {display: block; margin-top: 3px; overflow-wrap: anywhere;}
.launch-parameters {display:grid; grid-template-columns:auto minmax(0, 1fr); gap:8px 16px; margin:0; padding:0 16px 16px;}
.launch-parameters dt {color:var(--app-muted);}
.launch-parameters dd {margin:0; overflow-wrap:anywhere;}
</style>
