<template>
    <q-btn v-if="config.telegramShareEnabled || config.emailShareEnabled" :flat="compact" :dense="compact" :outline="!compact"
        aria-label="Отправить книгу" title="Отправить книгу" aria-haspopup="menu" :aria-expanded="open" :loading="sending">
        <BookActionIcon name="send" />
        <q-menu v-model="open" class="book-actions-menu" anchor="bottom right" self="top right">
            <q-list role="menu" aria-label="Отправить книгу">
                <q-item v-if="config.telegramShareEnabled" v-close-popup clickable role="menuitem" @click="send('telegram')">
                    <q-item-section avatar><q-icon name="lab la-telegram-plane" /></q-item-section><q-item-section>Отправить в Telegram</q-item-section>
                </q-item>
                <q-item v-if="config.emailShareEnabled" v-close-popup clickable role="menuitem" @click="send('email')">
                    <q-item-section avatar><q-icon name="la la-envelope" /></q-item-section><q-item-section>Отправить по Email</q-item-section>
                </q-item>
            </q-list>
        </q-menu>
    </q-btn>
</template>
<script setup>
import {getCurrentInstance, ref} from 'vue';
import {QMenu, QList} from 'quasar';
import BookActionIcon from './BookActionIcon.vue';
import {deliverBook} from './bookFileActions';
import bookFormats from '../../../shared/BookFormats';

const props = defineProps({book:{type:Object,required:true}, config:{type:Object,required:true}, compact:Boolean});
const root = getCurrentInstance().proxy.$root;
const open = ref(false), sending = ref(false);
async function send(channel) {
    if (sending.value) return;
    sending.value = true;
    try {
        const format = bookFormats.resolve(props.book.ext, props.config, bookFormats.profilePreference(props.config, channel));
        root.notify.success(await deliverBook(root.api, props.book, channel, format));
    } catch (error) {root.stdDialog.alert(error.message, 'Ошибка отправки');}
    finally {sending.value = false;}
}
</script>
