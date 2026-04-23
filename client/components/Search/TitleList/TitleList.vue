<template>
    <div>
        <a ref="download" style="display: none;"></a>

        <LoadingMessage :message="loadingMessage" z-index="2" />
        <LoadingMessage :message="loadingMessage2" z-index="1" />

        <!-- Формирование списка ------------------------------------------------------------------------>
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

        <div class="title-grid q-mx-md">
            <template v-for="item in tableData" :key="item.key">
                <BookView
                    :book="item.book" mode="title" :genre-map="genreMap" :show-read-link="showReadLink" @book-event="bookEvent"
                />
                <BookView
                    v-for="book in item.books" :key="book.id"
                    :book="book"
                    mode="title"
                    :genre-map="genreMap" :show-read-link="showReadLink"
                    @book-event="bookEvent"
                />
            </template>
        </div>
        <!-- Формирование списка конец ------------------------------------------------------------------>

        <div v-if="!refreshing && (!tableData.length || error)" class="row items-center q-ml-md" style="font-size: 120%">
            <q-icon class="la la-meh q-mr-xs" size="28px" />
            {{ (error ? error : 'Поиск не дал результатов') }}
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

class TitleList extends BaseList {
    get foundCountMessage() {
        return `${this.list.totalFound} уникальн${utils.wordEnding(this.list.totalFound, 6)} назван${utils.wordEnding(this.list.totalFound, 3)}`;
    }

    async updateTableData() {
        let result = [];

        const title = this.searchResult.found;
        if (!title)
            return;

        let num = 0;
        for (const rec of title) {
            const item = reactive({
                key: rec.id,
                title: rec.title,
                num,

                book: false,
                books: [],
            });

            if (rec.books) {
                const filtered = this.filterBooks(rec.books);

                for (let i = 0; i < filtered.length; i++) {
                    if (i === 0)
                        item.book = filtered[i];
                    else
                        item.books.push(filtered[i]);                    
                }

                if (filtered.length) {
                    num++;
                    result.push(item);
                }
            }
        }

        this.tableData = result;
    }

    async refresh() {
        //параметры запроса
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
                this.loadingMessage = 'Поиск книг...';
        })();

        try {
            while (this.queryExecute) {
                const query = this.queryExecute;
                this.queryExecute = null;

                try {
                    const response = await this.api.search('title', query);

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
                    //this.$root.stdDialog.alert(e.message, 'Ошибка');
                    this.error = `Ошибка: ${e.message}`;
                }
            }
        } finally {
            this.refreshing = false;
            this.loadingMessage = '';
        }
    }
}

export default vueComponent(TitleList);
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

.title-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 18px;
    align-items: stretch;
    grid-auto-rows: 1fr;
}

@media (max-width: 760px) {
    .title-grid {
        grid-template-columns: 1fr;
        gap: 12px;
    }
}
</style>
