<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center" style="font-size: 110%">
                <q-icon class="q-mr-sm text-green" name="la la-cog" size="28px"></q-icon>
                Настройки
            </div>
        </template>

        <div class="q-mx-md column" style="min-width: 300px; font-size: 120%;">
            <div class="row items-center q-ml-sm">
                <div class="q-mr-sm">
                    Результатов на странице
                </div>
                <q-select
                    v-model="limit"
                    :options="limitOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <q-checkbox v-show="config.latestVersion" v-model="showNewReleaseAvailable" size="36px" label="Уведомлять о выходе новой версии" />
            <q-checkbox v-model="downloadAsZip" size="36px" label="Скачивать книги в виде zip-архива" />
            <q-checkbox v-model="showCounts" size="36px" label="Показывать количество" />
            <q-checkbox v-model="showRates" size="36px" label="Показывать оценки" />
            <q-checkbox v-model="showInfo" size="36px" label="Показывать кнопку «Инфо»" />
            <q-checkbox v-model="showGenres" size="36px" label="Показывать жанры" />
            <q-checkbox v-model="showDates" size="36px" label="Показывать даты поступления" />
            <q-checkbox v-model="showDeleted" size="36px" label="Показывать удалённые" />
            <q-checkbox v-model="abCacheEnabled" size="36px" label="Кешировать запросы" />
            <q-checkbox v-model="darkTheme" size="36px" label="Ночная тема" />

            <div v-if="discoveryEnabled" class="q-mt-sm q-ml-sm text-weight-medium" style="font-size: 92%;">
                Витрины
            </div>
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryNewest" size="36px" label="Показывать вкладку «Новинки»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryPopular" size="36px" label="Показывать вкладку «Популярное»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryContinueReading" size="36px" label="Показывать полку «Продолжить чтение»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryFromLists" size="36px" label="Показывать полку «Из ваших списков»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryUnfinishedSeries" size="36px" label="Показывать полку «Незаконченные серии»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoverySimilar" size="36px" label="Показывать полку «Похоже на то, что вы читали»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryUnreadOnly" size="36px" label="Во вкладке «Для вас» показывать только непрочитанное" />
            <q-checkbox v-if="discoveryEnabled" v-model="compactDiscoveryCards" size="36px" label="Использовать компактные карточки в витринах" />
            <q-checkbox v-if="externalDiscoveryUiEnabled" v-model="showDiscoveryExternal" size="36px" label="Показывать вкладку внешнего источника" />

            <div v-if="discoveryEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Лимит «Новинки»</div>
                <q-select
                    v-model="discoveryNewestLimit"
                    :options="discoveryLimitOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="discoveryEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Лимит «Популярное»</div>
                <q-select
                    v-model="discoveryPopularLimit"
                    :options="discoveryLimitOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="discoveryEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Внешний источник</div>
                <q-select
                    v-model="discoveryExternalSource"
                    :options="externalSourceOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="externalDiscoveryUiEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Название источника</div>
                <q-input
                    v-model="discoveryExternalName"
                    class="bg-white col"
                    outlined
                    dense
                    clearable
                    placeholder="Например: Новинки партнёра"
                />
            </div>

            <div v-if="externalDiscoveryUiEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">URL витрины</div>
                <q-input
                    v-model="discoveryExternalUrl"
                    class="bg-white col"
                    outlined
                    dense
                    clearable
                    placeholder="https://..."
                />
            </div>

            <div v-if="externalDiscoveryUiEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Лимит внешнего источника</div>
                <q-select
                    v-model="discoveryExternalLimit"
                    :options="discoveryLimitOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="externalDiscoveryUiEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Период обновления</div>
                <q-select
                    v-model="discoveryExternalTtlMinutes"
                    :options="discoveryTtlOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>
        </div>

        <template #footer>
            <q-btn class="q-px-md q-ml-sm" color="primary" dense no-caps @click="okClick">
                OK
            </q-btn>
        </template>
    </Dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';

import Dialog from '../../share/Dialog.vue';

const componentOptions = {
    components: {
        Dialog
    },
    watch: {
        modelValue(newValue) {
            this.dialogVisible = newValue;
        },
        dialogVisible(newValue) {
            this.$emit('update:modelValue', newValue);
        },

        settings() {
            this.loadSettings();
        },
        limit(newValue) {
            this.commit('setSettings', {limit: newValue});
        },
        downloadAsZip(newValue) {
            this.commit('setSettings', {downloadAsZip: newValue});
        },
        showCounts(newValue) {
            this.commit('setSettings', {showCounts: newValue});
        },
        showRates(newValue) {
            this.commit('setSettings', {showRates: newValue});
        },
        showInfo(newValue) {
            this.commit('setSettings', {showInfo: newValue});
        },
        showGenres(newValue) {
            this.commit('setSettings', {showGenres: newValue});
        },
        showDates(newValue) {
            this.commit('setSettings', {showDates: newValue});
        },
        showDeleted(newValue) {
            this.commit('setSettings', {showDeleted: newValue});
        },
        abCacheEnabled(newValue) {
            this.commit('setSettings', {abCacheEnabled: newValue});
        },
        showNewReleaseAvailable(newValue) {
            this.commit('setSettings', {showNewReleaseAvailable: newValue});
        },
        darkTheme(newValue) {
            this.commit('setSettings', {darkTheme: newValue});
        },
        showDiscoveryNewest(newValue) {
            this.commit('setSettings', {showDiscoveryNewest: newValue});
        },
        showDiscoveryPopular(newValue) {
            this.commit('setSettings', {showDiscoveryPopular: newValue});
        },
        showDiscoveryContinueReading(newValue) {
            this.commit('setSettings', {showDiscoveryContinueReading: newValue});
        },
        showDiscoveryFromLists(newValue) {
            this.commit('setSettings', {showDiscoveryFromLists: newValue});
        },
        showDiscoveryUnfinishedSeries(newValue) {
            this.commit('setSettings', {showDiscoveryUnfinishedSeries: newValue});
        },
        showDiscoverySimilar(newValue) {
            this.commit('setSettings', {showDiscoverySimilar: newValue});
        },
        showDiscoveryExternal(newValue) {
            this.commit('setSettings', {showDiscoveryExternal: newValue});
        },
        showDiscoveryUnreadOnly(newValue) {
            this.commit('setSettings', {showDiscoveryUnreadOnly: newValue});
        },
        compactDiscoveryCards(newValue) {
            this.commit('setSettings', {compactDiscoveryCards: newValue});
        },
        discoveryNewestLimit(newValue) {
            this.commit('setSettings', {discoveryNewestLimit: newValue});
        },
        discoveryPopularLimit(newValue) {
            this.commit('setSettings', {discoveryPopularLimit: newValue});
        },
        discoveryExternalLimit(newValue) {
            this.commit('setSettings', {discoveryExternalLimit: newValue});
        },
        discoveryExternalSource(newValue) {
            const normalizedValue = (String(newValue || '').trim().toLowerCase() === 'none' ? 'none' : 'web-page');
            if (normalizedValue === 'none') {
                this.discoveryExternalName = '';
                this.discoveryExternalUrl = '';
                this.showDiscoveryExternal = false;
            }
            this.commit('setSettings', {discoveryExternalSource: normalizedValue});
        },
        discoveryExternalName(newValue) {
            this.commit('setSettings', {discoveryExternalName: newValue});
        },
        discoveryExternalUrl(newValue) {
            this.commit('setSettings', {discoveryExternalUrl: newValue});
        },
        discoveryExternalTtlMinutes(newValue) {
            this.commit('setSettings', {discoveryExternalTtlMinutes: newValue});
        },
    }
};

class SettingsDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
    };

    dialogVisible = false;

    limit = 20;
    downloadAsZip = false;
    showCounts = true;
    showRates = true;
    showInfo = true;
    showGenres = true;
    showDates = true;
    showDeleted = false;
    abCacheEnabled = true;
    showNewReleaseAvailable = true;
    darkTheme = false;
    showDiscoveryNewest = true;
    showDiscoveryPopular = true;
    showDiscoveryContinueReading = true;
    showDiscoveryFromLists = true;
    showDiscoveryUnfinishedSeries = true;
    showDiscoverySimilar = true;
    showDiscoveryExternal = true;
    showDiscoveryUnreadOnly = false;
    compactDiscoveryCards = false;
    discoveryNewestLimit = 8;
    discoveryPopularLimit = 8;
    discoveryExternalLimit = 8;
    discoveryExternalSource = '';
    discoveryExternalName = '';
    discoveryExternalUrl = '';
    discoveryExternalTtlMinutes = 1440;

    limitOptions = [
        {label: '10', value: 10},
        {label: '20', value: 20},
        {label: '50', value: 50},
        {label: '100', value: 100},
        {label: '200', value: 200},
        {label: '500', value: 500},
        {label: '1000', value: 1000},
    ];

    discoveryLimitOptions = [
        {label: '4', value: 4},
        {label: '6', value: 6},
        {label: '8', value: 8},
        {label: '10', value: 10},
        {label: '12', value: 12},
        {label: '16', value: 16},
        {label: '20', value: 20},
        {label: '24', value: 24},
    ];

    discoveryTtlOptions = [
        {label: '24 часа', value: 1440},
        {label: '3 дня', value: 4320},
        {label: '7 дней', value: 10080},
    ];

    created() {
        this.commit = this.$store.commit;
        this.loadSettings();
    }

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get discoveryConfig() {
        return this.config.discovery || {};
    }

    get discoveryEnabled() {
        return (this.discoveryConfig.enabled !== false);
    }

    get externalDiscoveryUiEnabled() {
        return !!(this.discoveryEnabled && this.discoveryExternalSource && this.discoveryExternalSource !== 'none');
    }

    get externalSourceOptions() {
        return [
            {label: 'Нет', value: 'none'},
            {label: 'Веб-витрина', value: 'web-page'},
        ];
    }

    loadSettings() {
        const settings = this.settings;

        this.limit = settings.limit;
        this.downloadAsZip = settings.downloadAsZip;
        this.showCounts = settings.showCounts;
        this.showRates = settings.showRates;
        this.showInfo = settings.showInfo;
        this.showGenres = settings.showGenres;
        this.showDates = settings.showDates;
        this.showDeleted = settings.showDeleted;
        this.abCacheEnabled = settings.abCacheEnabled;
        this.showNewReleaseAvailable = settings.showNewReleaseAvailable;
        this.darkTheme = settings.darkTheme;
        this.showDiscoveryNewest = (settings.showDiscoveryNewest !== false);
        this.showDiscoveryPopular = (settings.showDiscoveryPopular !== false);
        this.showDiscoveryContinueReading = (settings.showDiscoveryContinueReading !== false);
        this.showDiscoveryFromLists = (settings.showDiscoveryFromLists !== false);
        this.showDiscoveryUnfinishedSeries = (settings.showDiscoveryUnfinishedSeries !== false);
        this.showDiscoverySimilar = (settings.showDiscoverySimilar !== false);
        this.showDiscoveryExternal = (settings.showDiscoveryExternal !== false);
        this.showDiscoveryUnreadOnly = (settings.showDiscoveryUnreadOnly === true);
        this.compactDiscoveryCards = (settings.compactDiscoveryCards === true);
        this.discoveryNewestLimit = parseInt(settings.discoveryNewestLimit, 10) || 8;
        this.discoveryPopularLimit = parseInt(settings.discoveryPopularLimit, 10) || 8;
        this.discoveryExternalLimit = parseInt(settings.discoveryExternalLimit, 10) || 8;
        this.discoveryExternalSource = (String(settings.discoveryExternalSource || this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'web-page');
        this.discoveryExternalName = String(settings.discoveryExternalName || this.discoveryConfig.externalName || '').trim();
        this.discoveryExternalUrl = String(settings.discoveryExternalUrl || this.discoveryConfig.externalUrl || '').trim();
        this.discoveryExternalTtlMinutes = parseInt(settings.discoveryExternalTtlMinutes, 10) || parseInt(this.discoveryConfig.externalTtlMinutes, 10) || 1440;
    }

    okClick() {
        this.dialogVisible = false;
    }
}

export default vueComponent(SettingsDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
</style>
