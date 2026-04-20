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
                            </div>
                            <div class="list-subtitle">
                                {{ item.readCount || 0 }} / {{ item.bookCount }} книг прочитано
                            </div>
                        </div>
                    </div>

                    <div class="list-actions">
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

    created() {
        this.api = this.$root.api;
    }

    get dialogTitle() {
        return (this.book ? 'Добавить в список чтения' : 'Списки чтения');
    }

    get bookCaption() {
        if (!this.book)
            return '';

        return [this.book.author, this.book.title].filter(Boolean).join(' - ');
    }

    async init() {
        this.newListName = '';
        await this.loadLists();
    }

    async loadLists() {
        this.loading = true;
        try {
            const response = await this.api.getReadingLists(this.book ? this.book._uid : '');
            this.lists = response.lists || [];
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
            const response = await this.api.createReadingList(name);
            const created = response.list;

            if (this.book)
                await this.api.updateReadingListBook(created.id, this.book._uid, true);

            this.newListName = '';
            await this.loadLists();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
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
    width: min(560px, 90vw);
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

@media (max-width: 560px) {
    .create-row {
        flex-direction: column;
        align-items: stretch;
    }

    .list-row {
        align-items: flex-start;
    }
}
</style>
