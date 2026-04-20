<template>
    <div>
        <a ref="download" style="display: none;"></a>

        <LoadingMessage :message="loadingMessage" z-index="2" />
        <LoadingMessage :message="loadingMessage2" z-index="1" />

        <div class="rating-toolbar q-mx-md q-mb-sm">
            <div class="rating-toolbar-label">
                Топы по оценкам
            </div>
            <q-chip
                v-for="item in ratingFilterOptions"
                :key="item.value"
                class="rating-chip"
                clickable
                :outline="activeRatingFilter !== item.value"
                :color="activeRatingFilter === item.value ? 'primary' : 'grey-7'"
                :text-color="activeRatingFilter === item.value ? 'white' : 'grey-9'"
                @click="applyRatingFilter(item.value)"
            >
                {{ item.label }}
            </q-chip>
            <q-chip
                v-if="activeRatingFilter"
                class="rating-chip rating-chip-reset"
                clickable
                outline
                color="grey-7"
                text-color="grey-9"
                @click="clearRatingFilter"
            >
                Сброс
            </q-chip>
        </div>

        <div class="books-grid q-mx-md">
            <BookView
                v-for="item in tableData"
                :key="item.key"
                :book="item.book"
                mode="extended"
                :genre-map="genreMap"
                :show-read-link="showReadLink"
                @book-event="bookEvent"
            />
        </div>

        <div v-if="!refreshing && (!tableData.length || error)" class="row items-center q-ml-md" style="font-size: 120%">
            <q-icon class="la la-meh q-mr-xs" size="28px" />
            {{ (error ? error : 'Список книг пуст') }}
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';
import { reactive } from 'vue';

import BaseList from '../BaseList';

import * as utils from '../../../share/utils';
import _ from 'lodash';

class AllBooksList extends BaseList {
    get foundCountMessage() {
        const count = this.list.totalFound;
        const mod10 = count % 10;
        const mod100 = count % 100;

        let noun = 'книг';
        if (mod10 === 1 && mod100 !== 11)
            noun = 'книга';
        else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
            noun = 'книги';

        return `${count} ${noun}`;
    }

    async updateTableData() {
        let result = [];

        const books = this.searchResult.found;
        if (!books)
            return;

        let num = 0;
        for (const book of books) {
            const item = reactive({
                key: book._uid || `${book.id}-${num}`,
                num: num++,
                book,
            });

            result.push(item);
        }

        this.tableData = result;
    }

    async refresh() {
        const newQuery = this.getQuery();
        if (_.isEqual(newQuery, this.prevQuery))
            return;
        this.prevQuery = newQuery;

        this.queryExecute = newQuery;

        if (this.refreshing)
            return;

        this.error = '';
        this.refreshing = true;

        (async() => {
            await utils.sleep(500);
            if (this.refreshing)
                this.loadingMessage = 'Загрузка всех книг...';
        })();

        try {
            while (this.queryExecute) {
                const query = this.queryExecute;
                this.queryExecute = null;

                try {
                    const response = await this.api.bookSearch(query);

                    this.list.queryFound = response.found.length;
                    this.list.totalFound = response.totalFound;
                    this.list.inpxHash = response.inpxHash;

                    this.searchResult = response;

                    await utils.sleep(1);
                    if (!this.queryExecute) {
                        await this.updateTableData();
                        this.scrollToTop();
                        this.highlightPageScroller(query);
                    }
                } catch (e) {
                    this.list.queryFound = 0;
                    this.list.totalFound = 0;
                    this.searchResult = {found: []};
                    await this.updateTableData();
                    this.error = `Ошибка: ${e.message}`;
                }
            }
        } finally {
            this.refreshing = false;
            this.loadingMessage = '';
        }
    }
}

export default vueComponent(AllBooksList);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.rating-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}

.rating-toolbar-label {
    color: var(--app-muted);
    font-size: 13px;
    font-weight: 700;
}

.rating-chip {
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    height: 38px;
    padding: 0 10px;
    border-radius: 999px;
    font-weight: 700;
    line-height: 1;
    vertical-align: middle;
    box-shadow: 0 4px 14px rgba(23, 32, 38, 0.08);
    transition: transform 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease;
}

.rating-chip:hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 18px rgba(23, 32, 38, 0.12);
}

.rating-chip:active {
    transform: translateY(0);
}

.rating-chip-reset {
    background: rgba(23, 32, 38, 0.04);
}

.books-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 18px;
    align-items: stretch;
}

@media (max-width: 760px) {
    .books-grid {
        grid-template-columns: 1fr;
        gap: 12px;
    }
}
</style>
