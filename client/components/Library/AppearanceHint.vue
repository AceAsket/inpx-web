<template>
    <aside class="appearance-hint" role="note" aria-label="Новое оформление библиотеки">
        <q-icon name="la la-book-open" size="25px" aria-hidden="true" />
        <div><strong>Попробуйте новый дизайн</strong><span>Обложки, обзор и ваши книги. Вернуться к классическому виду можно в настройках.</span></div>
        <q-btn unelevated no-caps color="primary" label="Переключить дизайн" @click="tryShelves" />
        <q-btn flat round dense icon="la la-times" aria-label="Скрыть подсказку об оформлении" @click="dismiss" />
    </aside>
</template>
<script setup>
import {useStore} from 'vuex';
const store = useStore();
function dismiss() {store.commit('setSettings', {shelvesHintDismissed: true});}
function tryShelves() {store.commit('setSettings', {catalogAppearance: 'shelves', shelvesHintDismissed: true});}
</script>
<style scoped>
.appearance-hint {display: flex; align-items: center; gap: 12px; flex-shrink: 0; margin: 12px 16px; padding: 12px 14px; border: 1px solid var(--app-border); border-radius: 12px; background: var(--app-surface); color: var(--app-text); font-size: 13px;}
.appearance-hint > .q-icon {color: var(--app-primary); flex-shrink: 0;}
.appearance-hint > div {flex: 1; min-width: 0;}
strong, span {display: block; line-height: 1.5;}
span {color: var(--app-muted); font-size: 12px; margin-top: 2px;}
.appearance-hint .q-btn {flex-shrink: 0; font-size: 12px;}
@media (max-width: 599px) {.appearance-hint {flex-wrap: wrap; margin: 10px; padding: 12px;} .appearance-hint > div {flex-basis: calc(100% - 60px);} .appearance-hint .q-btn--unelevated {margin-left: 37px;} .appearance-hint .q-btn--round {margin-left: auto;}}
</style>
