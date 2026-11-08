<template>
    <div class="loading-state" role="status" aria-live="polite">
        <div class="loading-state__heading">
            <q-spinner v-if="normalizedPercent === null" size="20px" color="primary" aria-hidden="true" />
            <span>{{ label }}</span>
            <strong v-if="normalizedPercent !== null" class="loading-state__percent">{{ Math.floor(normalizedPercent) }}%</strong>
        </div>
        <q-linear-progress v-if="normalizedPercent !== null" :value="normalizedPercent / 100" rounded color="primary" :aria-label="label" class="loading-state__progress" />
        <p v-if="detail" class="loading-state__detail">{{ detail }}</p>
    </div>
</template>

<script setup>
import {computed} from 'vue';
const props = defineProps({label: {type: String, default: 'Загрузка'}, detail: {type: String, default: ''}, percent: {type: Number, default: null}});
const normalizedPercent = computed(() => props.percent === null || !Number.isFinite(props.percent) ? null : Math.max(0, Math.min(100, props.percent)));
</script>

<style scoped>
.loading-state {padding: 16px 18px; border: 1px solid var(--app-border); border-radius: 14px; background: var(--app-surface); color: var(--app-text);}
.loading-state__heading {display: flex; align-items: center; gap: 10px; font-size: 14px; line-height: 1.5; font-weight: 550;}
.loading-state__heading > span {flex: 1; min-width: 0;}
.loading-state__percent {flex-shrink: 0; font-size: 13px; font-weight: 550; font-variant-numeric: tabular-nums; color: var(--app-primary);}
.loading-state__progress {margin-top: 14px; height: 5px;}
.loading-state__detail {margin: 9px 0 0; color: var(--app-muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-line;}
@media (prefers-reduced-motion: reduce) {.loading-state :deep(.q-spinner), .loading-state :deep(.q-spinner *) {animation: none;}}
</style>
