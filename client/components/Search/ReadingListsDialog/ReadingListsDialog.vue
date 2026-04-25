<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center full-width dialog-header">
                <div style="font-size: 110%">
                    {{ dialogTitle }}
                </div>
                <div class="header-actions">
                    <q-btn flat dense no-caps icon="la la-file-export" @click="exportLists">
                        Экспорт
                    </q-btn>
                    <q-btn flat dense no-caps icon="la la-file-import" @click="openImport">
                        Импорт
                    </q-btn>
                </div>
            </div>
        </template>

        <div class="dialog-box">
            <input
                ref="importInput"
                type="file"
                accept="application/json,.json"
                style="display: none"
                @change="onImportSelected"
            >

            <div v-if="currentUserName" class="current-user-caption">
                Профиль: <b>{{ currentUserName }}</b>
            </div>

            <div class="create-row">
                <q-input
                    v-model="newListName"
                    class="col"
                    outlined
                    dense
                    clearable
                    label="Новый список"
                    @keydown.enter.prevent="createList"
                />
                <q-select
                    v-model="newListVisibility"
                    outlined
                    dense
                    emit-value
                    map-options
                    :options="visibilityOptions"
                    label="Видимость"
                    style="min-width: 140px"
                />
                <q-btn color="primary" dense no-caps @click="createList">
                    Создать
                </q-btn>
            </div>

            <div v-if="book" class="book-caption">
                {{ bookCaption }}
            </div>

            <div v-if="book && book.series" class="series-actions">
                <q-btn outline color="primary" dense no-caps icon="la la-layer-group" @click="addSeriesToList">
                    Добавить всю серию
                </q-btn>
            </div>

            <div v-if="loading" class="state-box text-grey-7">
                Загрузка списков...
            </div>

            <div v-else-if="!lists.length" class="state-box text-grey-7">
                Списков пока нет
            </div>

            <div v-else class="lists-box">
                <div v-for="item in lists" :key="item.id" class="list-row">
                    <div class="list-main">
                        <q-checkbox
                            v-if="book"
                            :model-value="item.containsBook"
                            toggle-order="ft"
                            @update:model-value="toggleBook(item, $event)"
                        />

                        <div class="list-meta">
                            <div class="list-name">
                                {{ item.name }}
                                <span class="list-visibility">
                                    {{ visibilityLabel(item.visibility) }}
                                </span>
                            </div>
                            <div class="list-subtitle">
                                {{ item.readCount || 0 }} / {{ item.bookCount }} книг прочитано
                            </div>
                        </div>
                    </div>

                    <div class="list-actions">
                        <q-btn
                            flat
                            dense
                            no-caps
                            :icon="isListExpanded(item.id) ? 'la la-angle-up' : 'la la-angle-down'"
                            @click="toggleListExpanded(item)"
                        >
                            {{ isListExpanded(item.id) ? collapseListLabel : booksLabel }}
                        </q-btn>
                        <q-select
                            v-model="item.visibility"
                            dense
                            borderless
                            emit-value
                            map-options
                            :options="visibilityOptions"
                            style="min-width: 112px"
                            @update:model-value="changeVisibility(item, $event)"
                        />
                        <q-checkbox
                            v-if="book && item.containsBook"
                            :model-value="item.readBook"
                            dense
                            label="Прочитано"
                            @update:model-value="toggleRead(item, $event)"
                        />
                        <q-btn flat dense round icon="la la-pen" @click="renameList(item)" />
                        <q-btn flat dense round icon="la la-trash" color="negative" @click="deleteList(item)" />
                    </div>

                    <div v-if="isListExpanded(item.id)" class="list-books">
                        <div v-if="item.booksLoading" class="list-books-state text-grey-7">
                            {{ loadingBooksLabel }}
                        </div>
                        <div v-else-if="item.books && item.books.length" class="list-books-items">
                            <div v-for="bookItem in item.books" :key="`${item.id}-${bookItem.bookUid}`" class="list-book-row">
                                <div class="list-book-main">
                                    <div class="list-book-title">
                                        {{ bookItem.title || untitledBookLabel }}
                                    </div>
                                    <div v-if="bookItem.author" class="list-book-meta">
                                        {{ bookItem.author }}
                                    </div>
                                </div>
                                <q-checkbox
                                    :model-value="bookItem.read"
                                    dense
                                    :label="readBookLabel"
                                    @update:model-value="toggleBookItemRead(item, bookItem, $event)"
                                />
                                <q-btn
                                    flat
                                    dense
                                    round
                                    color="negative"
                                    icon="la la-times"
                                    @click="removeBookFromList(item, bookItem)"
                                />
                            </div>
                        </div>
                        <div v-else class="list-books-state text-grey-7">
                            {{ listEmptyLabel }}
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <template #footer>
            <q-btn class="q-px-md q-ml-sm" color="primary" dense no-caps @click="dialogVisible = false">
                Закрыть
            </q-btn>
        </template>
    </Dialog>
</template>

<script>
import vueComponent from '../../vueComponent.js';

import Dialog from '../../share/Dialog.vue';

const componentOptions = {
    components: {
        Dialog,
    },
    watch: {
        modelValue(newValue) {
            this.dialogVisible = newValue;
            if (newValue)
                this.init();// no await
        },
        dialogVisible(newValue) {
            this.$emit('update:modelValue', newValue);
        },
        book() {
            if (this.dialogVisible)
                this.init();// no await
        },
    },
};

class ReadingListsDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
        book: {type: Object, default: null},
    };

    dialogVisible = false;
    loading = false;
    lists = [];
    newListName = '';
    newListVisibility = 'private';
    expandedLists = {};

    created() {
        this.api = this.$root.api;
    }

    get dialogTitle() {
        return (this.book ? 'Добавить в список чтения' : 'Списки чтения');
    }

    get config() {
        return this.$store.state.config;
    }

    get currentUserName() {
        const users = this.config.userProfiles || [];
        const currentUserId = this.$store.state.settings.currentUserId || this.config.currentUserId || '';
        const user = users.find((item) => item.id === currentUserId) || users[0];
        return (user ? user.name : '');
    }

    get bookCaption() {
        if (!this.book)
            return '';

        return [this.book.author, this.book.title].filter(Boolean).join(' - ');
    }

    get visibilityOptions() {
        return [
            {label: 'Личный', value: 'private'},
            {label: 'OPDS', value: 'opds'},
        ];
    }

    get errorTitle() {
        return '\u041e\u0448\u0438\u0431\u043a\u0430';
    }

    get booksLabel() {
        return '\u041a\u043d\u0438\u0433\u0438';
    }

    get collapseListLabel() {
        return '\u0421\u0432\u0435\u0440\u043d\u0443\u0442\u044c';
    }

    get loadingBooksLabel() {
        return '\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044e \u043a\u043d\u0438\u0433\u0438...';
    }

    get listEmptyLabel() {
        return '\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0443\u0441\u0442';
    }

    get untitledBookLabel() {
        return '\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f';
    }

    get readBookLabel() {
        return '\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e';
    }

    visibilityLabel(value) {
        return (value === 'opds' ? 'OPDS' : 'Личный');
    }

    async init() {
        this.newListName = '';
        this.newListVisibility = 'private';
        await this.loadLists();
    }

    async loadLists() {
        this.loading = true;
        try {
            const response = await this.api.getReadingLists(this.book ? this.book._uid : '');
            const previousLists = new Map((this.lists || []).map((item) => [String(item.id), item]));
            const nextLists = (response.lists || []).map((item) => {
                const key = String(item.id);
                const previous = previousLists.get(key) || {};
                return Object.assign({}, item, {
                    books: Array.isArray(previous.books) ? previous.books : [],
                    booksLoaded: !!previous.booksLoaded,
                    booksLoading: false,
                });
            });
            this.lists = nextLists;
            this.expandedLists = nextLists.reduce((acc, item) => {
                const key = String(item.id);
                acc[key] = !!this.expandedLists[key];
                return acc;
            }, {});
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        } finally {
            this.loading = false;
        }
    }

    async createList() {
        const name = String(this.newListName || '').trim();
        if (!name)
            return;

        try {
            const response = await this.api.createReadingListWithVisibility(name, this.newListVisibility);
            const created = response.list;

            if (this.book)
                await this.api.updateReadingListBook(created.id, this.book._uid, true);

            this.newListName = '';
            this.newListVisibility = 'private';
            await this.loadLists();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async changeVisibility(item, visibility) {
        try {
            await this.api.setReadingListVisibility(item.id, visibility);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
            await this.loadLists();
        }
    }

    async toggleBook(item, enabled) {
        if (!this.book)
            return;

        try {
            await this.api.updateReadingListBook(item.id, this.book._uid, enabled);
            item.containsBook = !!enabled;

            if (!enabled && item.readBook) {
                item.readBook = false;
                item.readCount = Math.max(0, (item.readCount || 0) - 1);
            }

            item.bookCount += (enabled ? 1 : -1);
            if (item.bookCount < 0)
                item.bookCount = 0;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
            await this.loadLists();
        }
    }

    async toggleRead(item, read) {
        if (!this.book)
            return;

        try {
            await this.api.setReadingListBookRead(item.id, this.book._uid, read);
            if (!!item.readBook !== !!read)
                item.readCount = Math.max(0, (item.readCount || 0) + (read ? 1 : -1));
            item.readBook = !!read;
            const bookUid = String(this.book._uid || '').trim();
            const bookItem = (item.books || []).find((row) => String(row.bookUid || '').trim() === bookUid);
            if (bookItem)
                bookItem.read = !!read;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
            await this.loadLists();
        }
    }

    async renameList(item) {
        const response = await this.$root.stdDialog.prompt('Введите новое название списка:', 'Переименовать список', {
            inputValue: item.name,
            inputValidator: (value) => (String(value || '').trim() ? true : 'Название не должно быть пустым'),
        });

        if (!response || response === false)
            return;

        try {
            await this.api.renameReadingList(item.id, response.value);
            await this.loadLists();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async deleteList(item) {
        const confirmed = await this.$root.stdDialog.confirm(
            `Удалить список «${item.name}»?`,
            'Удаление списка',
        );
        if (!confirmed)
            return;

        try {
            await this.api.deleteReadingList(item.id);
            await this.loadLists();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    isListExpanded(listId) {
        return !!this.expandedLists[String(listId)];
    }

    async toggleListExpanded(item) {
        const key = String((item && item.id) || '').trim();
        if (!key)
            return;

        const nextValue = !this.expandedLists[key];
        this.expandedLists = {
            ...this.expandedLists,
            [key]: nextValue,
        };

        if (nextValue && !item.booksLoaded)
            await this.loadListBooks(item);
    }

    async loadListBooks(item) {
        if (!item || !item.id)
            return;

        item.booksLoading = true;
        try {
            const response = await this.api.getReadingList(item.id);
            const books = (response && Array.isArray(response.books) ? response.books : []);
            item.books = books.map((book) => ({
                bookUid: String(book.bookUid || book._uid || '').trim(),
                title: String(book.title || '').trim(),
                author: String(book.author || '').trim(),
                read: !!(book._readingListRead || book.read),
            }));
            item.booksLoaded = true;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.errorTitle);
        } finally {
            item.booksLoading = false;
        }
    }

    async removeBookFromList(list, bookItem) {
        const listId = String((list && list.id) || '').trim();
        const bookUid = String((bookItem && bookItem.bookUid) || '').trim();
        if (!listId || !bookUid)
            return;

        const confirmed = await this.$root.stdDialog.confirm(
            `Убрать книгу «${bookItem.title || this.untitledBookLabel}» из списка «${list.name || ''}»?`,
            'Удаление книги из списка',
        );
        if (!confirmed)
            return;

        try {
            await this.api.updateReadingListBook(listId, bookUid, false);
            if (bookItem.read)
                list.readCount = Math.max(0, (Number(list.readCount || 0) || 0) - 1);
            list.books = (list.books || []).filter((item) => String(item.bookUid || '').trim() !== bookUid);
            list.bookCount = Math.max(0, (Number(list.bookCount || 0) || 0) - 1);

            if (this.book && String(this.book._uid || '').trim() === bookUid) {
                list.containsBook = false;
                list.readBook = false;
            }
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.errorTitle);
        }
    }

    async toggleBookItemRead(list, bookItem, read) {
        const listId = String((list && list.id) || '').trim();
        const bookUid = String((bookItem && bookItem.bookUid) || '').trim();
        if (!listId || !bookUid)
            return;

        try {
            await this.api.setReadingListBookRead(listId, bookUid, read);
            if (!!bookItem.read !== !!read)
                list.readCount = Math.max(0, (Number(list.readCount || 0) || 0) + (read ? 1 : -1));
            bookItem.read = !!read;

            if (this.book && String(this.book._uid || '').trim() === bookUid)
                list.readBook = !!read;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.errorTitle);
            await this.loadListBooks(list);
        }
    }

    downloadJson(data, fileName) {
        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json;charset=utf-8'});
        const href = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => {
            window.URL.revokeObjectURL(href);
        }, 1000);
    }

    async exportLists() {
        try {
            const data = await this.api.exportReadingLists();
            const stamp = new Date().toISOString().substring(0, 10);
            this.downloadJson(data, `reading-lists-${stamp}.json`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    openImport() {
        const input = this.$refs.importInput;
        if (!input)
            return;

        input.value = '';
        input.click();
    }

    async onImportSelected(event) {
        const file = event.target.files && event.target.files[0];
        if (!file)
            return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const result = await this.api.importReadingLists(data);
            await this.loadLists();
            this.$root.notify.success(`Импортировано списков: ${result.importedLists}, книг: ${result.importedBooks}`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async addSeriesToList() {
        if (!this.book || !this.book.series)
            return;

        if (!this.lists.length) {
            this.$root.stdDialog.alert('Сначала создайте хотя бы один список.', 'Информация');
            return;
        }

        const response = await this.$root.stdDialog.prompt(
            'Введите название списка, куда добавить всю серию:',
            'Добавить серию в список',
            {
                inputValidator: (value) => (String(value || '').trim() ? true : 'Название списка не должно быть пустым'),
            },
        );

        if (!response || response === false)
            return;

        const targetName = String(response.value || '').trim().toLowerCase();
        const item = this.lists.find((row) => row.name.toLowerCase() === targetName);
        if (!item) {
            this.$root.stdDialog.alert('Список с таким названием не найден.', 'Ошибка');
            return;
        }

        try {
            const result = await this.api.addSeriesToReadingList(item.id, this.book.series);
            await this.loadLists();
            this.$root.notify.success(`В список добавлено книг серии: ${result.addedBooks}`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }
}

export default vueComponent(ReadingListsDialog);
</script>

<style scoped>
.dialog-box {
    width: min(640px, 92vw);
    max-height: min(72vh, 760px);
    padding: 8px 10px 10px;
    overflow: auto;
}

.dialog-header {
    justify-content: space-between;
    gap: 12px;
}

.header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
}

.current-user-caption {
    margin-bottom: 10px;
    padding: 8px 12px;
    border-radius: 12px;
    background: rgba(15, 159, 143, 0.08);
}

.create-row {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 10px;
}

.book-caption {
    margin-bottom: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(15, 159, 143, 0.08);
    color: var(--app-text);
    font-weight: 600;
}

.series-actions {
    margin-bottom: 10px;
}

.state-box {
    padding: 20px 8px;
}

.lists-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--app-border);
    border-radius: 14px;
    background: var(--app-surface);
}

.list-main {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
}

.list-meta {
    min-width: 0;
}

.list-name {
    font-weight: 700;
    color: var(--app-text);
    word-break: break-word;
}

.list-visibility {
    margin-left: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(15, 159, 143, 0.08);
    color: var(--app-link);
    font-size: 11px;
    font-weight: 700;
}

.list-subtitle {
    font-size: 12px;
    color: var(--app-muted);
}

.list-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
}

.list-books {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 4px;
}

.list-books-items {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.list-books-state {
    padding: 6px 2px 2px;
    font-size: 13px;
}

.list-book-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--app-surface) 86%, var(--app-link) 14%);
}

.list-book-main {
    min-width: 0;
}

.list-book-title {
    font-weight: 600;
    color: var(--app-text);
    word-break: break-word;
}

.list-book-meta {
    margin-top: 2px;
    font-size: 12px;
    color: var(--app-muted);
}

@media (max-width: 700px) {
    .create-row {
        flex-direction: column;
        align-items: stretch;
    }
}

@media (max-width: 560px) {
    .list-row {
        align-items: flex-start;
        flex-direction: column;
    }

    .list-actions {
        width: 100%;
    }
}
</style>
