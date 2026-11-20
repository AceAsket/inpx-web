<template>
    <q-btn :flat="compact" :dense="compact" :outline="!compact" icon="la la-ellipsis-v"
        aria-label="Быстрые действия" title="Быстрые действия" aria-haspopup="menu" :aria-expanded="open" :loading="busy">
        <q-menu v-model="open" class="book-actions-menu" anchor="bottom right" self="top right" @before-show="loadHistory">
            <q-list role="menu" aria-label="Быстрые действия">
                <slot />
                <q-item v-if="loadError" clickable role="menuitem" @click="loadHistory">
                    <q-item-section avatar><q-icon name="la la-sync" /></q-item-section>
                    <q-item-section>Повторить загрузку истории</q-item-section>
                </q-item>
                <template v-if="history">
                    <q-separator spaced />
                    <q-item v-close-popup clickable role="menuitem" @click="changeHistory(false)">
                        <q-item-section avatar><q-icon :name="history.hidden ? 'la la-undo' : 'la la-eye-slash'" /></q-item-section>
                        <q-item-section>{{ history.hidden ? 'Вернуть в историю' : 'Убрать из чтения' }}</q-item-section>
                    </q-item>
                    <q-item v-if="history.hidden" v-close-popup clickable role="menuitem" class="text-negative" @click="changeHistory(true)">
                        <q-item-section avatar><q-icon name="la la-trash" /></q-item-section>
                        <q-item-section>Удалить из истории</q-item-section>
                    </q-item>
                </template>
            </q-list>
        </q-menu>
    </q-btn>
</template>

<script setup>
import {computed, getCurrentInstance, inject, onBeforeUnmount, onDeactivated, ref, watch} from 'vue';
import {QMenu, QList, QSeparator} from 'quasar';
import escape from 'lodash/escape';
import {clearStoredReaderProgress} from '../Reader/readerProgressStorage';
import {libraryContextKey} from './libraryContext';
import {bookUid, profileLoginError} from './libraryModel';

const props = defineProps({book:{type:Object,required:true}, compact:Boolean, historyGeneration:Number});
const emit = defineEmits(['changed']);
const library = inject(libraryContextKey);
const root = getCurrentInstance().proxy.$root;
const open = ref(false), history = ref(null), busy = ref(false), loadError = ref(false);
const uid = computed(() => bookUid(props.book));
const owner = computed(() => library.config.value.profileAuthorized && library.config.value.currentUserId);
let request = 0;
function reset() {request++; open.value = false; history.value = null; loadError.value = false;}
watch([uid, owner, () => library.state.revision], reset);
onDeactivated(reset);
onBeforeUnmount(reset);

async function loadHistory() {
    const id = ++request;
    history.value = null;
    loadError.value = false;
    if (!owner.value || !uid.value || props.book.discoveryMissingLocal) return;
    if (props.historyGeneration !== undefined) {
        if (['hidden', 'reading'].includes(props.book.state))
            history.value = {hidden:!!props.book.hidden, revision:props.book.revision, generation:props.historyGeneration};
        return;
    }
    try {
        const {progress, progressGeneration} = await library.api.getReaderState(uid.value, {userId:owner.value, suppressProfileLogin:true});
        if (id === request && !progress?.relinkedTo && (progress?.hidden || (progress?.updatedAt && progress.percent < .999)))
            history.value = {hidden:!!progress.hidden, revision:progress.revision || 0, generation:progressGeneration};
    } catch (error) {
        if (id !== request) return;
        if (profileLoginError(error)) library.repository.requireLogin('reading');
        else loadError.value = true;
    }
}
async function changeHistory(remove) {
    if (busy.value || !owner.value || !history.value) return;
    const userId = owner.value, epoch = library.state.revision, id = request;
    const {hidden, revision, generation} = history.value;
    const entry = {bookUid:uid.value, revision};
    busy.value = true;
    try {
        if (remove) {
            const confirmed = await root.stdDialog.confirm(
                `Удалить «${escape(props.book.title)}» из истории? Позиция чтения и все ваши закладки в этой книге будут удалены. Сама книга останется в библиотеке.`,
                'Удалить из истории', {okLabel:'Удалить'});
            if (!confirmed || id !== request || userId !== owner.value || epoch !== library.state.revision) return;
        }
        const result = remove ? await library.api.forgetHiddenBook(entry, generation, userId)
            : await library.api.setReadingHistoryHidden(entry, !hidden, generation, userId);
        if (remove && result.success) clearStoredReaderProgress(userId, entry.bookUid);
        if (epoch !== library.state.revision || userId !== owner.value) return;
        if (remove ? result.success : !result.progress?.conflict && result.progress?.hidden === !hidden) {
            if (id === request) emit('changed');
        } else root.notify.warning('Позиция чтения изменилась. Попробуйте ещё раз.');
        await library.repository.refreshReading();
    } catch (error) {
        if (epoch !== library.state.revision || userId !== owner.value) return;
        if (profileLoginError(error)) library.repository.requireLogin('reading');
        else root.stdDialog.alert(escape(error.message || 'Не удалось изменить историю чтения.'), 'История чтения');
    } finally {busy.value = false;}
}
</script>
