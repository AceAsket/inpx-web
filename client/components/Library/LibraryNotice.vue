<template>
    <section class="library-notice-card" :class="{'library-notice-card--error': error}" :role="error ? 'alert' : 'status'">
        <span class="library-notice-card__icon"><q-icon :name="error ? 'la la-exclamation-circle' : 'la la-user-lock'" size="25px" aria-hidden="true" /></span>
        <div class="library-notice-card__copy"><h2>{{ title }}</h2><p>{{ message }}</p></div>
        <q-btn unelevated no-caps color="primary" :label="actionLabel" :loading="busy" @click="$emit('action')" />
    </section>
</template>

<script setup>
defineProps({title: String, message: String, actionLabel: String, error: Boolean, busy: Boolean});
defineEmits(['action']);
</script>

<style scoped>
.library-notice-card {display: flex; align-items: center; gap: 16px; padding: 20px; margin: 0 0 24px; border: 1px solid var(--app-border); border-radius: 18px; background: var(--app-surface); color: var(--app-text);}
.library-notice-card__icon {display: grid; place-items: center; width: 46px; height: 46px; flex: 0 0 46px; border-radius: 14px; color: var(--app-primary); background: var(--app-surface-2);}
.library-notice-card--error .library-notice-card__icon {color: var(--app-danger); background: color-mix(in srgb, var(--app-danger) 12%, transparent);}
.library-notice-card__copy {min-width: 0; flex: 1;}
.library-notice-card h2 {font-size: 16px; line-height: 1.45; font-weight: 550; margin: 0 0 4px;}
.library-notice-card p {color: var(--app-muted); font-size: 13px; line-height: 1.6; margin: 0;}
.library-notice-card .q-btn {flex-shrink: 0; border-radius: 11px; min-height: 40px; padding: 8px 16px; font-size: 13px;}
@media (max-width: 599px) {.library-notice-card {flex-wrap: wrap; align-items: flex-start; padding: 16px; gap: 12px;} .library-notice-card__copy {flex-basis: calc(100% - 58px);} .library-notice-card .q-btn {margin-left: 58px;}}
</style>
