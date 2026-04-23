<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center" style="font-size: 110%">
                <q-icon class="q-mr-sm text-primary" name="la la-satellite-dish" size="28px" />
                Внешний источник
            </div>
        </template>

        <div class="q-mx-md column" style="min-width: 320px; max-width: 720px; font-size: 110%;">
            <div class="row items-center q-mt-sm">
                <div class="q-mr-sm dialog-label">Тип источника</div>
                <q-select
                    v-model="discoveryExternalSource"
                    :options="externalSourceOptions"
                    class="bg-white col"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="externalDiscoveryEnabled" class="row items-center q-mt-sm">
                <div class="q-mr-sm dialog-label">Название</div>
                <q-input
                    v-model="discoveryExternalName"
                    class="bg-white col"
                    outlined
                    dense
                    clearable
                    placeholder="Например: Партнёрская витрина"
                />
            </div>

            <div v-if="externalDiscoveryEnabled" class="row items-center q-mt-sm">
                <div class="q-mr-sm dialog-label">URL витрины</div>
                <q-input
                    v-model="discoveryExternalUrl"
                    class="bg-white col"
                    outlined
                    dense
                    clearable
                    placeholder="https://..."
                />
            </div>

            <div v-if="externalDiscoveryEnabled" class="q-mt-sm">
                <div class="dialog-label q-mb-xs">Готовые варианты</div>
                <div class="preset-list">
                    <q-btn
                        v-for="preset in externalSourcePresets"
                        :key="preset.name"
                        class="preset-btn"
                        color="primary"
                        flat
                        dense
                        no-caps
                        @click="applyPreset(preset)"
                    >
                        {{ preset.name }}
                    </q-btn>
                </div>
            </div>

            <div v-if="externalDiscoveryEnabled" class="row items-center q-mt-sm">
                <div class="q-mr-sm dialog-label">Лимит</div>
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

            <div v-if="externalDiscoveryEnabled" class="row items-center q-mt-sm">
                <div class="q-mr-sm dialog-label">Обновление</div>
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

            <div v-if="externalDiscoveryEnabled" class="q-mt-md text-grey-7" style="font-size: 85%;">
                Если удалить источник, вкладка и витрина исчезнут, пока администратор не настроит новый источник.
            </div>
        </div>

        <template #footer>
            <q-btn
                v-if="externalDiscoveryEnabled"
                class="q-px-md q-ml-sm"
                color="negative"
                flat
                dense
                no-caps
                @click="removeSource"
            >
                Удалить источник
            </q-btn>
            <q-space />
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
        Dialog,
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
        discoveryExternalSource(newValue) {
            const normalizedValue = (String(newValue || '').trim().toLowerCase() === 'none' ? 'none' : 'web-page');
            if (normalizedValue === 'none') {
                this.discoveryExternalName = '';
                this.discoveryExternalUrl = '';
                this.discoveryExternalLimit = 8;
                this.discoveryExternalTtlMinutes = 1440;
                this.commit('setSettings', {
                    discoveryExternalSource: 'none',
                    discoveryExternalName: '',
                    discoveryExternalUrl: '',
                    discoveryExternalLimit: 8,
                    discoveryExternalTtlMinutes: 1440,
                    showDiscoveryExternal: false,
                });
                return;
            }

            this.commit('setSettings', {discoveryExternalSource: normalizedValue});
        },
        discoveryExternalName(newValue) {
            this.commit('setSettings', {discoveryExternalName: newValue});
        },
        discoveryExternalUrl(newValue) {
            this.commit('setSettings', {discoveryExternalUrl: newValue});
        },
        discoveryExternalLimit(newValue) {
            this.commit('setSettings', {discoveryExternalLimit: newValue});
        },
        discoveryExternalTtlMinutes(newValue) {
            const normalizedValue = Math.max(1440, parseInt(newValue, 10) || 1440);
            if (normalizedValue !== this.discoveryExternalTtlMinutes) {
                this.discoveryExternalTtlMinutes = normalizedValue;
                return;
            }
            this.commit('setSettings', {discoveryExternalTtlMinutes: normalizedValue});
        },
    },
};

class DiscoverySourceDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
    };

    dialogVisible = false;
    discoveryExternalSource = 'none';
    discoveryExternalName = '';
    discoveryExternalUrl = '';
    discoveryExternalLimit = 8;
    discoveryExternalTtlMinutes = 1440;

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

    get settings() {
        return this.$store.state.settings;
    }

    get config() {
        return this.$store.state.config;
    }

    get discoveryConfig() {
        return this.config.discovery || {};
    }

    get externalSourceOptions() {
        return [
            {label: 'Нет', value: 'none'},
            {label: 'Веб-витрина', value: 'web-page'},
        ];
    }

    get externalSourcePresets() {
        return [
            {
                name: 'Литрес · Новинки',
                source: 'web-page',
                externalName: 'Литрес · Новинки',
                externalUrl: 'https://www.litres.ru/showroom/new/',
            },
            {
                name: 'Литрес · Популярное',
                source: 'web-page',
                externalName: 'Литрес · Популярное',
                externalUrl: 'https://www.litres.ru/popular/',
            },
            {
                name: 'МИФ · Новинки',
                source: 'web-page',
                externalName: 'МИФ · Новинки',
                externalUrl: 'https://www.mann-ivanov-ferber.ru/catalog/new/',
            },
            {
                name: 'МИФ · Бестселлеры',
                source: 'web-page',
                externalName: 'МИФ · Бестселлеры',
                externalUrl: 'https://www.mann-ivanov-ferber.ru/books/bestsellers/',
            },
            {
                name: 'Альпина · Бестселлеры',
                source: 'web-page',
                externalName: 'Альпина · Бестселлеры',
                externalUrl: 'https://alpinabook.ru/catalog/filter/best_seller-is-bestseller-books-only/apply/',
            },
        ];
    }

    get externalDiscoveryEnabled() {
        return !!(this.discoveryExternalSource && this.discoveryExternalSource !== 'none');
    }

    loadSettings() {
        const settings = this.settings;
        this.discoveryExternalSource = (String(settings.discoveryExternalSource || this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'web-page');
        this.discoveryExternalName = String(settings.discoveryExternalName || this.discoveryConfig.externalName || '').trim();
        this.discoveryExternalUrl = String(settings.discoveryExternalUrl || this.discoveryConfig.externalUrl || '').trim();
        this.discoveryExternalLimit = parseInt(settings.discoveryExternalLimit, 10) || 8;
        this.discoveryExternalTtlMinutes = Math.max(
            1440,
            parseInt(settings.discoveryExternalTtlMinutes, 10) || parseInt(this.discoveryConfig.externalTtlMinutes, 10) || 1440,
        );
    }

    removeSource() {
        this.discoveryExternalSource = 'none';
    }

    applyPreset(preset = {}) {
        this.discoveryExternalSource = String(preset.source || 'web-page').trim().toLowerCase() || 'web-page';
        this.discoveryExternalName = String(preset.externalName || preset.name || '').trim();
        this.discoveryExternalUrl = String(preset.externalUrl || '').trim();
    }

    okClick() {
        this.dialogVisible = false;
    }
}

export default vueComponent(DiscoverySourceDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.dialog-label {
    min-width: 128px;
}

.preset-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.preset-btn {
    border-radius: 999px;
    background: rgba(25, 118, 210, 0.08);
}
</style>
