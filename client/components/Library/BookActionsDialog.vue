<template>
    <Dialog v-model="dialogVisible">
        <template #header>Книга в библиотеке</template>
        <div class="library-book-actions">
            <a ref="download" style="display: none" />
            <LoadingMessage :message="loadingMessage2" />
            <BookView :book="book" mode="extended" presentation="full" :genre-map="genreMap" :show-read-link="showReadLink" @book-event="bookEvent" />
            <q-btn v-if="!book.discoveryMissingLocal" flat no-caps icon="la la-info-circle" label="Описание и сведения" @click="$emit('details', book); dialogVisible = false" />
        </div>
        <template #footer><q-btn flat no-caps label="Закрыть" @click="dialogVisible = false" /></template>
    </Dialog>
</template>

<script>
import vueComponent from '../vueComponent';
import BaseList from '../Search/BaseList';
import BookView from '../Search/BookView/BookView.vue';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import Dialog from '../share/Dialog.vue';

// Use the same download, format, email, Telegram and read-state actions as the catalog.
// This adapter has no search lifecycle or parallel implementation of those operations.
class BookActionsDialog extends BaseList {
    _props = {modelValue: Boolean, book: Object, genreMap: Object};
    _options = {
        components: {Dialog, BookView, LoadingMessage},
        emits: ['update:modelValue', 'listEvent', 'navigate', 'details', 'updated'],
        watch: {
            modelValue(value) {this.dialogVisible = value;},
            dialogVisible(value) {this.$emit('update:modelValue', value);},
            settings() {this.loadSettings();},
        },
    };
    dialogVisible = false;
    list = {liberamaReady: false};

    created() {super.created(); this.dialogVisible = this.modelValue;}
    refresh() {}

    bookEvent(event) {
        const navigation = {authorClick: 'author', seriesClick: 'series', titleClick: 'title', genreClick: 'genre'};
        const type = navigation[event.action];
        if (type) {
            this.$emit('navigate', {type, value: type === 'genre' ? event.format : event.book[type]});
            this.dialogVisible = false;
            return;
        }
        if (['bookInfo', 'authorInfo'].includes(event.action)) {
            this.$emit('details', event.book);
            this.dialogVisible = false;
            return;
        }
        if (['readBook', 'readingList'].includes(event.action)) this.dialogVisible = false;
        super.bookEvent(event);
    }

    async markBooksRead(uids, read) {
        await super.markBooksRead(uids, read);
        this.$emit('updated');
    }
}
export default vueComponent(BookActionsDialog);
</script>

<style scoped>
.library-book-actions {position: relative; width: min(460px, calc(100vw - 64px)); padding: 6px 2px;}
.library-book-actions :deep(.book-card) {height: auto; min-height: 0;}
</style>
