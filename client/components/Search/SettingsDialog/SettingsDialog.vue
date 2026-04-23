<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center" style="font-size: 110%">
                <q-icon class="q-mr-sm text-green" name="la la-cog" size="28px"></q-icon>
                РќР°СЃС‚СЂРѕР№РєРё
            </div>
        </template>

        <div class="q-mx-md column" style="min-width: 300px; font-size: 120%;">
            <div class="row items-center q-ml-sm">
                <div class="q-mr-sm">
                    Р РµР·СѓР»СЊС‚Р°С‚РѕРІ РЅР° СЃС‚СЂР°РЅРёС†Рµ
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

            <q-checkbox v-show="config.latestVersion" v-model="showNewReleaseAvailable" size="36px" label="РЈРІРµРґРѕРјР»СЏС‚СЊ Рѕ РІС‹С…РѕРґРµ РЅРѕРІРѕР№ РІРµСЂСЃРёРё" />
            <q-checkbox v-model="downloadAsZip" size="36px" label="РЎРєР°С‡РёРІР°С‚СЊ РєРЅРёРіРё РІ РІРёРґРµ zip-Р°СЂС…РёРІР°" />
            <q-checkbox v-model="showCounts" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РєРѕР»РёС‡РµСЃС‚РІРѕ" />
            <q-checkbox v-model="showRates" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РѕС†РµРЅРєРё" />
            <q-checkbox v-model="showInfo" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РєРЅРѕРїРєСѓ В«РРЅС„РѕВ»" />
            <q-checkbox v-model="showGenres" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ Р¶Р°РЅСЂС‹" />
            <q-checkbox v-model="showDates" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РґР°С‚С‹ РїРѕСЃС‚СѓРїР»РµРЅРёСЏ" />
            <q-checkbox v-model="showDeleted" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ СѓРґР°Р»С‘РЅРЅС‹Рµ" />
            <q-checkbox v-model="abCacheEnabled" size="36px" label="РљРµС€РёСЂРѕРІР°С‚СЊ Р·Р°РїСЂРѕСЃС‹" />
            <q-checkbox v-model="darkTheme" size="36px" label="РќРѕС‡РЅР°СЏ С‚РµРјР°" />

            <div v-if="discoveryEnabled" class="q-mt-sm q-ml-sm text-weight-medium" style="font-size: 92%;">
                Р’РёС‚СЂРёРЅС‹
            </div>
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryNewest" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РІРєР»Р°РґРєСѓ В«РќРѕРІРёРЅРєРёВ»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryPopular" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РІРєР»Р°РґРєСѓ В«РџРѕРїСѓР»СЏСЂРЅРѕРµВ»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryContinueReading" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РїРѕР»РєСѓ В«РџСЂРѕРґРѕР»Р¶РёС‚СЊ С‡С‚РµРЅРёРµВ»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryFromLists" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РїРѕР»РєСѓ В«РР· РІР°С€РёС… СЃРїРёСЃРєРѕРІВ»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryUnfinishedSeries" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РїРѕР»РєСѓ В«РќРµР·Р°РєРѕРЅС‡РµРЅРЅС‹Рµ СЃРµСЂРёРёВ»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoverySimilar" size="36px" label="РџРѕРєР°Р·С‹РІР°С‚СЊ РїРѕР»РєСѓ В«РџРѕС…РѕР¶Рµ РЅР° С‚Рѕ, С‡С‚Рѕ РІС‹ С‡РёС‚Р°Р»РёВ»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryUnreadOnly" size="36px" label="Р’Рѕ РІРєР»Р°РґРєРµ В«Р”Р»СЏ РІР°СЃВ» РїРѕРєР°Р·С‹РІР°С‚СЊ С‚РѕР»СЊРєРѕ РЅРµРїСЂРѕС‡РёС‚Р°РЅРЅРѕРµ" />
            <q-checkbox v-if="discoveryEnabled" v-model="compactDiscoveryCards" size="36px" label="РСЃРїРѕР»СЊР·РѕРІР°С‚СЊ РєРѕРјРїР°РєС‚РЅС‹Рµ РєР°СЂС‚РѕС‡РєРё РІ РІРёС‚СЂРёРЅР°С…" />
            <q-checkbox v-if="effectiveExternalDiscoveryAvailable" v-model="showDiscoveryExternal" size="36px" label="Показывать вкладку внешнего источника" />

            <div v-if="discoveryEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Р›РёРјРёС‚ В«РќРѕРІРёРЅРєРёВ»</div>
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
                <div class="q-mr-sm">Р›РёРјРёС‚ В«РџРѕРїСѓР»СЏСЂРЅРѕРµВ»</div>
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

            <div v-if="discoveryEnabled && canEditExternalDiscovery" class="row items-center q-ml-sm q-mt-sm settings-inline-row">
                <div class="q-mr-sm settings-inline-label">Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє</div>
                <div class="settings-inline-summary text-grey-8">
                    {{ externalDiscoverySummary }}
                </div>
                <q-btn
                    class="q-ml-sm"
                    color="primary"
                    flat
                    dense
                    no-caps
                    icon="la la-sliders-h"
                    @click="discoverySourceDialogVisible = true"
                >
                    РЈРїСЂР°РІР»СЏС‚СЊ
                </q-btn>
            </div>

            <div v-if="effectiveExternalDiscoveryAvailable && !canEditExternalDiscovery" class="q-ml-sm q-mt-sm text-grey-7" style="font-size: 85%;">
                Р’РЅРµС€РЅРёР№ РёСЃС‚РѕС‡РЅРёРє РЅР°СЃС‚СЂР°РёРІР°РµС‚ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ РїСЂРѕС„РёР»СЏ.
            </div>
        </div>

        <DiscoverySourceDialog v-if="canEditExternalDiscovery" v-model="discoverySourceDialogVisible" />

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
import DiscoverySourceDialog from '../DiscoverySourceDialog/DiscoverySourceDialog.vue';

const componentOptions = {
    components: {
        Dialog,
        DiscoverySourceDialog,
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
    },
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
    showDates = false;
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
    discoveryExternalSource = '';
    discoveryExternalName = '';
    discoveryExternalUrl = '';
    discoverySourceDialogVisible = false;

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

    get canEditExternalDiscovery() {
        const current = this.config.currentUserProfile || {};
        return !!(this.config.profileAuthorized && current.isAdmin);
    }

    get externalDiscoveryAvailable() {
        return !!(this.discoveryEnabled && this.discoveryExternalSource && this.discoveryExternalSource !== 'none');
    }

    get effectiveExternalDiscoverySource() {
        const value = String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalSource || this.discoveryConfig.externalSource || '')
                : (this.discoveryConfig.externalSource || ''),
        ).trim().toLowerCase();
        return (value && value !== 'none' ? 'web-page' : 'none');
    }

    get effectiveExternalDiscoveryName() {
        return String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalName || this.discoveryConfig.externalName || '')
                : (this.discoveryConfig.externalName || ''),
        ).trim();
    }

    get effectiveExternalDiscoveryAvailable() {
        return !!(this.discoveryEnabled && this.effectiveExternalDiscoverySource !== 'none');
    }

    get externalDiscoverySummary() {
        if (!this.effectiveExternalDiscoveryAvailable)
            return 'Не настроен';

        const name = this.effectiveExternalDiscoveryName || 'Внешний источник';
        return `${name} · веб-витрина`;
    }

    loadSettings() {
        const settings = this.settings;
        const configExternalSource = (String(this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'web-page');
        const hasStoredExternalSettings = !!(
            String(settings.discoveryExternalSource || '').trim()
            || String(settings.discoveryExternalName || '').trim()
            || String(settings.discoveryExternalUrl || '').trim()
        );

        if (!hasStoredExternalSettings && configExternalSource !== 'none') {
            this.commit('setSettings', {
                discoveryExternalSource: configExternalSource,
                discoveryExternalName: String(this.discoveryConfig.externalName || '').trim(),
                discoveryExternalUrl: String(this.discoveryConfig.externalUrl || '').trim(),
                discoveryExternalTtlMinutes: Math.max(1440, parseInt(this.discoveryConfig.externalTtlMinutes, 10) || 1440),
            });
        }

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
        this.discoveryExternalSource = (String(settings.discoveryExternalSource || this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'web-page');
        this.discoveryExternalName = String(settings.discoveryExternalName || this.discoveryConfig.externalName || '').trim();
        this.discoveryExternalUrl = String(settings.discoveryExternalUrl || this.discoveryConfig.externalUrl || '').trim();
    }

    okClick() {
        this.dialogVisible = false;
    }
}

export default vueComponent(SettingsDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.settings-inline-row {
    flex-wrap: wrap;
    gap: 6px 8px;
}

.settings-inline-label {
    min-width: 132px;
}

.settings-inline-summary {
    flex: 1 1 220px;
    min-width: 180px;
}
</style>


