<template>
    <div class="app-connection-settings">
        <q-checkbox :model-value="store.state.settings.showAppPromo !== false" size="32px"
            label="QR-код приложения в боковом меню" @update:model-value="store.commit('setSettings', {showAppPromo: $event})" />
        <AppConnection :root-path="store.state.config.rootPathStatic || ''" button-label="Открыть QR" />
    </div>
</template>

<script setup>
import {useStore} from 'vuex';
import AppConnection from '../Search/AppConnection.vue';

const store = useStore();
</script>

<style scoped>
.app-connection-settings {display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;}
.app-connection-settings :deep(.q-checkbox) {flex: 1; min-width: 180px;}
.app-connection-settings :deep(.q-checkbox__label) {font-size: 12px; line-height: 1.5;}
</style>
