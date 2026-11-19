<template>
    <div class="library-tools">
        <div v-if="$root.api && $root.api.indexWaitMessage" class="library-index-status" role="status">
            <q-spinner size="18px" /> {{ $root.api.indexWaitMessage }}
        </div>
        <q-dialog v-model="tasksOpen" aria-labelledby="library-tasks-title" @hide="stopPolling">
            <q-card class="task-dialog">
                <header class="task-dialog__header">
                    <h2 id="library-tasks-title">
                        Задачи и состояние библиотеки
                    </h2>
                    <q-btn flat round dense icon="la la-times" aria-label="Закрыть задачи" @click="tasksOpen = false" />
                </header>
                <div class="task-dialog__body">
                    <p v-if="error" class="task-error" role="alert">
                        {{ error }}
                    </p>
                    <section class="task-queue" aria-labelledby="task-queue-title">
                        <div class="task-queue__summary">
                            <div>
                                <h3 id="task-queue-title">
                                    Фоновые задачи
                                </h3>
                                <p v-if="!tasks.length" class="task-description" role="status">
                                    {{ loading && !resources ? 'Загрузка задач…' : 'Задач пока нет.' }}
                                </p>
                            </div>
                            <dl v-if="resources" class="task-queue__counts">
                                <div><dt>В работе</dt><dd>{{ count(resources.active) }}</dd></div>
                                <div><dt>В очереди</dt><dd>{{ count(resources.queued) }}</dd></div>
                            </dl>
                        </div>
                        <ul v-if="tasks.length" class="task-list">
                            <li v-for="task in tasks" :key="task.id">
                                <div class="task-list__heading">
                                    <strong>{{ task.title }}</strong><span class="task-status" :data-state="task.state">{{ stateLabel(task.state) }}</span>
                                </div>
                                <p v-if="task.state === 'queued'" class="task-description">
                                    Ожидание свободного места<template v-if="task.queuePosition">
                                        · позиция {{ task.queuePosition }}
                                    </template>
                                </p>
                                <template v-else-if="['running','generating'].includes(task.state)">
                                    <p class="task-description">
                                        {{ task.phase === 'loading' ? 'Загрузка модели озвучки' : task.phase || 'Обработка' }}
                                        <template v-if="task.total">
                                            · {{ count(task.done) }} из {{ count(task.total) }}
                                        </template>
                                        <template v-if="task.remainingSeconds > 0">
                                            · осталось около {{ Math.ceil(task.remainingSeconds / 60) }} мин
                                        </template>
                                    </p>
                                    <q-linear-progress rounded :aria-label="task.title" :indeterminate="task.progress == null" :value="task.progress || 0" />
                                </template>
                                <p v-if="task.waitingReason" class="task-description">
                                    {{ task.waitingReason }}
                                </p>
                                <p v-if="task.error" class="task-error">
                                    {{ task.error }}
                                </p>
                            </li>
                        </ul>
                        <p v-if="resources && resources.queued" class="task-description task-queue__hint">
                            Число параллельных задач задаётся при запуске сервера.
                        </p>
                    </section>
                    <div v-if="isAdmin" class="task-panels">
                        <section v-if="isbnIndex" class="task-panel" aria-labelledby="task-isbn-title">
                            <div class="task-panel__heading">
                                <q-icon class="task-panel__icon" name="la la-barcode" aria-hidden="true" />
                                <h3 id="task-isbn-title">
                                    Индекс ISBN
                                </h3>
                            </div>
                            <span v-if="!isbnIndex.remote && isbnStateLabel" class="task-status" :data-state="isbnIndex.state" role="status">{{ isbnStateLabel }}</span>
                            <p class="task-description">
                                Поиск по ISBN использует номера из каталога и файлов FB2 и EPUB. Пока индекс готовится, обычный поиск доступен.
                            </p>
                            <p v-if="isbnIndex.remote" class="task-description">
                                Индекс готовится на сервере с исходными книгами.
                            </p>
                            <template v-else>
                                <label v-if="isbnIndex.workerLimit" class="task-isbn-workers">
                                    <span>Потоки чтения</span>
                                    <select :value="isbnIndex.workers ?? 'auto'" :disabled="!!taskAction" @change="setIsbnThreads($event)">
                                        <option value="auto">Автоматически</option>
                                        <option v-for="n in [1, 2, 4, 8, 16, 32]" :key="n" :value="n">{{ n }}</option>
                                    </select>
                                    <small>Доступно до {{ isbnIndex.workerLimit }}</small>
                                </label>
                                <dl v-if="isbnIndex.total || isbnIndex.checked || isbnIndex.state !== 'empty'" class="task-metrics">
                                    <div><dt>Обработано</dt><dd>{{ count(isbnIndex.checked) }} / {{ count(isbnIndex.total) }}</dd></div>
                                    <div><dt>С ISBN</dt><dd>{{ count(isbnIndex.found) }}</dd></div>
                                    <div><dt>Не прочитано</dt><dd>{{ count(isbnIndex.errors) }}</dd></div>
                                    <div><dt>Пропущено</dt><dd>{{ count(isbnIndex.skipped) }}</dd></div>
                                </dl>
                                <q-linear-progress
                                    v-if="isbnIndex.state === 'running'" rounded aria-label="Подготовка ISBN"
                                    :indeterminate="!isbnIndex.total" :value="isbnIndex.total ? isbnIndex.checked / isbnIndex.total : 0"
                                />
                            </template>
                            <p v-if="isbnIndex.error" class="task-error" role="alert">
                                {{ isbnIndex.error }}
                            </p>
                            <div v-if="!isbnIndex.remote" class="task-actions">
                                <q-btn
                                    v-if="!['running','ready'].includes(isbnIndex.state)" class="task-primary" unelevated no-caps
                                    :label="isbnIndex.state === 'paused' ? 'Продолжить подготовку' : 'Подготовить ISBN'" :disable="!!taskAction" @click="manageIsbn('start')"
                                />
                                <q-btn v-if="isbnIndex.state === 'running'" outline no-caps label="Отменить подготовку" :disable="!!taskAction" @click="manageIsbn('cancel')" />
                                <q-btn v-else flat no-caps label="Перестроить полностью" :disable="!!taskAction" @click="manageIsbn('start',true)" />
                            </div>
                        </section>
                        <section class="task-panel" aria-labelledby="task-audit-title">
                            <div class="task-panel__heading">
                                <q-icon class="task-panel__icon" name="la la-clipboard-check" aria-hidden="true" />
                                <h3 id="task-audit-title">
                                    Проверка библиотеки
                                </h3>
                            </div>
                            <span v-if="audit" class="task-status" :data-state="auditState" role="status">{{ stateLabel(auditState) }}</span>
                            <p class="task-description">
                                Проверяет наличие архивов и книг на диске.
                            </p>
                            <q-checkbox :model-value="selectedDeep" dense :disable="auditRunning" label="Проверять содержимое FB2 и EPUB" @update:model-value="deep = $event" />
                            <p v-if="selectedDeep" class="task-description">
                                Чтение файлов займёт больше времени. Книги сверх установленного лимита будут пропущены.
                            </p>
                            <dl v-if="audit" class="task-metrics">
                                <div><dt>Проверено</dt><dd>{{ count(audit.checked) }} / {{ count(audit.total) }}</dd></div>
                                <div><dt>Отсутствуют</dt><dd>{{ count(audit.missing) }}</dd></div>
                                <div><dt>С ошибками</dt><dd>{{ count(audit.damaged) }}</dd></div>
                                <div><dt>Пропущено</dt><dd>{{ count(audit.skipped) }}</dd></div>
                            </dl>
                            <q-linear-progress v-if="auditRunning" rounded aria-label="Проверка библиотеки" :indeterminate="!audit.total" :value="audit.total ? audit.checked / audit.total : 0" />
                            <p v-if="audit && audit.error" class="task-error" role="alert">
                                {{ audit.error }}
                            </p>
                            <details v-if="audit && audit.issues.length" class="task-issues">
                                <summary>Замечания проверки ({{ count(audit.issues.length) }})</summary>
                                <ul>
                                    <li v-for="(issue,index) in audit.issues" :key="index">
                                        <strong>{{ issue.title || issue.folder }}</strong> — {{ issue.message }}
                                    </li>
                                </ul>
                                <p v-if="audit.issuesTruncated" class="task-description">
                                    Показаны первые 500 замечаний. Остальные учтены в счётчиках.
                                </p>
                            </details>
                            <div class="task-actions">
                                <q-btn
                                    v-if="!auditRunning" class="task-primary" unelevated no-caps label="Запустить проверку"
                                    :loading="taskAction === 'audit'" :disable="!!taskAction" @click="manageAudit('start')"
                                />
                                <q-btn
                                    v-else outline no-caps label="Отменить проверку"
                                    :loading="taskAction === 'audit'" :disable="!!taskAction || auditState === 'cancelling'" @click="manageAudit('cancel')"
                                />
                                <q-btn v-if="audit" flat no-caps icon="la la-download" label="Скачать отчёт" @click="downloadReport" />
                            </div>
                        </section>
                    </div>
                </div>
            </q-card>
        </q-dialog>
        <q-dialog v-model="followsOpen">
            <q-card class="library-tools-card">
                <q-card-section class="row items-center">
                    <strong class="col">Избранные авторы и серии</strong><q-btn flat round dense icon="la la-times" aria-label="Закрыть избранное" @click="followsOpen = false" />
                </q-card-section>
                <q-card-section>
                    <form class="library-follow-form" @submit.prevent="addFollow">
                        <label>Следить за <select v-model="kind"><option value="author">Автором</option><option value="series">Серией</option></select></label>
                        <q-input v-model="value" outlined dense :maxlength="200" :label="kind === 'author' ? 'Имя автора целиком' : 'Название серии целиком'" />
                        <q-btn type="submit" outline no-caps label="Добавить" :disable="busy || !value.trim()" />
                    </form>
                    <p>Новые книги появятся здесь после обновления коллекции. При добавлении уже имеющиеся книги считаются просмотренными.</p>
                    <p v-if="followError" role="alert" class="text-negative">
                        {{ followError }}
                    </p>
                    <div class="library-tools-buttons">
                        <q-btn flat no-caps icon="la la-sync" label="Проверить новые книги" :loading="busy" @click="refreshFollows(true)" />
                    </div>
                    <article v-for="follow in follows" :key="follow.id" class="library-follow">
                        <div>
                            <strong><a :href="followHref(follow)">{{ follow.value }}</a></strong>
                            <span> · {{ follow.kind === 'author' ? 'Автор' : 'Серия' }}{{ follow.unread ? ` · новых: ${follow.unread}` : '' }}</span>
                        </div>
                        <div class="library-tools-buttons">
                            <q-btn v-if="follow.unread" flat dense no-caps label="Просмотрено" :disable="busy" @click="changeFollow('seen',follow.id)" />
                            <q-btn flat dense no-caps label="Не следить" :disable="busy" @click="changeFollow('remove',follow.id)" />
                        </div>
                    </article>
                    <h3>Появилось в библиотеке</h3>
                    <p v-if="!books.length && !busy">
                        Новых книг пока нет.
                    </p>
                    <article v-for="book in books" :key="book._uid" class="library-follow">
                        <a :href="bookHref(book)">{{ book.title }}</a><div>{{ book.author }}{{ book.series ? ' · ' + book.series : '' }}</div>
                    </article>
                    <p v-if="truncated">
                        Показаны первые 200 новых книг. Полная подборка доступна по ссылке автора или серии.
                    </p>
                </q-card-section>
            </q-card>
        </q-dialog>
    </div>
</template>

<script>
export default {
    name:'LibraryTools',
    props:{author:{type:String,default:''},series:{type:String,default:''}},
    data() {return {tasksOpen:false,followsOpen:false,tasks:[],resources:null,audit:null,isAdmin:false,deep:false,
        isbnIndex:null,taskAction:'',loading:false,error:'',pollTimer:null,generation:0,follows:[],books:[],truncated:false,kind:'author',value:'',busy:false,followError:''};},
    computed:{
        authorized() {return !!this.$store.state.config.profileAuthorized;},
        identity() {return `${this.$store.state.settings.currentUserId}:${this.$store.state.settings.profileAccessToken}:${this.authorized}`;},
        auditRunning() {return !!this.audit && !this.audit.finishedAt;},
        selectedDeep() {return this.auditRunning ? !!this.audit.deep : this.deep;},
        auditState() {
            if (!this.audit) return '';
            if (this.audit.state) return this.audit.state;
            if (this.auditRunning) return this.audit.running === false ? 'cancelling' : 'running';
            if (this.audit.error === 'Проверка отменена') return 'cancelled';
            return this.audit.error ? 'failed' : 'completed';
        },
        isbnStateLabel() {return {ready:'Индекс готов',running:'Идёт подготовка',paused:'Подготовка приостановлена',empty:'Требуется подготовка'}[this.isbnIndex?.state] || '';},
    },
    watch:{identity() {
        this.stopPolling(); this.tasksOpen = this.followsOpen = false;
        this.tasks = []; this.follows = []; this.books = []; this.audit = null; this.isbnIndex = null; this.taskAction = '';
        this.isAdmin = this.busy = this.loading = false; this.resources = null; this.error = this.followError = '';
    }},
    beforeUnmount() {this.stopPolling();},
    methods:{
        count(value) {return (value ?? 0).toLocaleString('ru-RU');},
        stateLabel(state) {
            return {queued:'В очереди',running:'В работе',generating:'В работе',cancelling:'Останавливается',
                ready:'Готово',completed:'Завершено',error:'Ошибка',failed:'Ошибка',cancelled:'Отменено',
                'timed-out':'Истекло время','memory-pressure':'Недостаточно памяти'}[state] || state;
        },
        stopPolling() {clearTimeout(this.pollTimer); this.generation++;},
        openTasks() {
            if (!this.authorized || !this.$store.state.config.currentUserProfile?.isAdmin) return;
            this.taskAction = '';
            this.tasksOpen = true; this.stopPolling(); this.loadTasks(this.generation);
        },
        async loadTasks(generation) {
            this.loading = true;
            try {const result = await this.$root.api.getBackgroundTasks(); if (generation !== this.generation) return;
                Object.assign(this,{tasks:result.tasks,resources:result.resources,audit:result.audit,isbnIndex:result.isbnIndex,isAdmin:result.isAdmin,error:''});
            } catch (error) {if (generation === this.generation) this.error = error.message;}
            finally {if (generation === this.generation) {this.loading = false; if (this.tasksOpen) this.pollTimer = setTimeout(() => this.loadTasks(generation),2000);}}
        },
        manageIsbn(operation, force = false) {
            return this.runTaskAction('isbn', () => this.$root.api.manageIsbnIndex(operation, {force}));
        },
        async setIsbnThreads(event) {
            const select = event.target;
            const workers = select.value === 'auto' ? null : Number(select.value);
            await this.runTaskAction('isbn-threads', () => this.$root.api.setIsbnThreads(workers));
            select.value = this.isbnIndex?.workers ?? 'auto';
        },
        manageAudit(operation) {
            return this.runTaskAction('audit', () => operation === 'start'
                ? this.$root.api.startLibraryAudit({deep:this.deep}) : this.$root.api.cancelLibraryAudit());
        },
        async runTaskAction(kind, request) {
            if (this.taskAction) return;
            this.stopPolling();
            const generation = this.generation;
            this.taskAction = kind;
            try {
                await request();
                if (generation === this.generation) await this.loadTasks(generation);
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                    if (this.tasksOpen) this.pollTimer = setTimeout(() => this.loadTasks(generation), 2000);
                }
            } finally {if (generation === this.generation) this.taskAction = '';}
        },
        downloadReport() {
            const url = URL.createObjectURL(new Blob([JSON.stringify(this.audit,null,2)],{type:'application/json'}));
            const link = document.createElement('a'); link.href = url; link.download = 'inpx-library-audit.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
        },
        openFollows() {
            if (!this.authorized) return;
            this.followsOpen = true;
            this.kind = this.author ? 'author' : this.series ? 'series' : 'author';
            this.value = (this.author || this.series || '').replace(/^=/,'');
            this.refreshFollows(true);
        },
        async followRequest(operation,payload) {
            const identity = this.identity; this.busy = true;
            try {const result = await this.$root.api.libraryFollows(operation,payload); if (identity !== this.identity) return;
                this.follows = result.follows; this.books = result.books; this.truncated = result.truncated; this.followError = '';
            } catch (error) {if (identity === this.identity) this.followError = error.message;}
            finally {if (identity === this.identity) this.busy = false;}
        },
        refreshFollows(refresh) {return this.followRequest('list',{refresh});},
        addFollow() {return this.followRequest('add',{kind:this.kind,value:this.value});},
        changeFollow(operation,id) {return this.followRequest(operation,{id});},
        bookHref(book) {return `#/books?title=${encodeURIComponent('=' + book.title)}`;},
        followHref(follow) {return `#/${follow.kind === 'author' ? 'author' : 'books'}?${follow.kind}=${encodeURIComponent('=' + follow.value)}`;},
    },
};
</script>

<style scoped>
.library-tools { color:inherit; min-width:0; }
.library-tools-buttons,.library-index-status { display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
.library-tools-buttons { padding:4px 8px; }
.library-index-status { padding:10px 16px; }
.library-tools-card { width:min(720px,95vw);max-height:90dvh;overflow:auto; }
.library-follow { padding:12px 0;border-bottom:1px solid #8884;overflow-wrap:anywhere; }
.library-tools-card h3 {font-size:1.1em;margin:12px 0;}
.library-follow-form { display:grid;grid-template-columns:140px minmax(0,1fr) auto;gap:10px;align-items:end; }
.library-follow-form label {display:flex;flex-direction:column;gap:5px;}
.library-follow-form select {background:inherit;color:inherit;padding:8px;border:1px solid #8888;border-radius:5px;}
@media(max-width:600px) {.library-follow-form {grid-template-columns:1fr;} .library-tools-card {width:95vw;}}

.task-dialog.q-card {
    width: 840px; max-width: calc(100vw - 40px); max-height: min(880px, calc(100dvh - 48px));
    display: flex; flex-direction: column; overflow: hidden; border-radius: 22px;
    background: var(--app-surface); color: var(--app-text);
}
.task-dialog__header {
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex: none;
    padding: 18px 20px 16px 24px; border-bottom: 1px solid var(--app-border);
}
.task-dialog h2, .task-dialog h3 {margin: 0; line-height: 1.28; letter-spacing: normal;}
.task-dialog h2 {font-size: 21px; font-weight: 600;}
.task-dialog h3 {font-size: 17px; font-weight: 600;}
.task-dialog__header .q-btn {color: var(--app-muted); min-width: 38px; min-height: 38px;}
.task-dialog__body {padding: 20px 24px 24px; overflow: auto; overscroll-behavior: contain; min-height: 0;}
.task-queue {border-radius: 14px; background: var(--app-surface-2); padding: 16px 18px;}
.task-queue__summary, .task-list__heading {display: flex; gap: 12px; align-items: center; justify-content: space-between;}
.task-queue__counts {display: flex; gap: 16px; margin: 0; flex-wrap: wrap;}
.task-queue__counts div {display: flex; align-items: baseline; gap: 6px;}
.task-queue__counts dt, .task-metrics dt, .task-description {font-size: 13px; line-height: 1.5; color: var(--app-muted);}
.task-queue__counts dd, .task-metrics dd {margin: 0; font-weight: 650; font-variant-numeric: tabular-nums;}
.task-queue__counts dd {font-size: 18px;}
.task-description, .task-error {margin: 0;}
.task-isbn-workers {display:flex; align-items:center; gap:6px 12px; flex-wrap:wrap;}
.task-isbn-workers select {max-width:100%; padding:6px 10px; border:1px solid var(--app-border); border-radius:8px; background:var(--app-surface); color:var(--app-text); font:inherit;}
.task-isbn-workers small {color:var(--app-muted);}
.task-queue__summary p {margin-top: 3px;}
.task-queue__hint {margin-top: 10px;}
.task-list {list-style: none; margin: 12px 0 0; padding: 0;}
.task-list li {display: grid; gap: 5px; padding: 10px 0; border-top: 1px solid var(--app-border); overflow-wrap: anywhere;}
.task-list li:last-child {padding-bottom: 0;}
.task-status {
    display: inline-flex; align-self: flex-start; padding: 3px 9px; border-radius: 20px;
    font-size: 12px; font-weight: 600; white-space: nowrap; background: var(--app-surface-3); color: var(--app-muted);
}
.task-status:is([data-state="running"],[data-state="generating"],[data-state="ready"],[data-state="completed"]) {background: var(--app-surface-2); color: var(--app-link);}
.task-status:is([data-state="failed"],[data-state="error"]), .task-error {color: var(--app-danger);}
.task-dialog__body > .task-error {margin-bottom: 12px;}
.task-panels {display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 14px; margin-top: 16px;}
.task-panel {display: flex; flex-direction: column; align-items: stretch; gap: 12px; min-width: 0; border: 1px solid var(--app-border); border-radius: 16px; padding: 18px; overflow-wrap: anywhere;}
.task-panel__heading {display: flex; align-items: center; gap: 10px;}
.task-panel__icon {flex: none; font-size: 22px; color: var(--app-link);}
.task-panel .q-checkbox {font-size: 14px; line-height: 1.45; min-height: 36px;}
.task-metrics {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; padding-block: 10px; border-block: 1px solid var(--app-border);}
.task-metrics dd {font-size: 15px;}
.task-actions {display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: auto; padding-top: 4px;}
.task-actions .q-btn {min-height: 38px; padding-inline: 12px; border-radius: 9px; font-size: 13px; line-height: 1.35;}
.task-actions .q-btn--flat {color: var(--app-link);}
.task-primary {background: var(--app-primary); color: var(--library-on-primary, white);}
.task-issues {font-size: 13px; line-height: 1.5;}
.task-issues summary {cursor: pointer; color: var(--app-link); font-weight: 600;}
.task-issues ul {margin: 8px 0 0; padding-left: 18px; max-height: 180px; overflow: auto;}
.task-issues li + li {margin-top: 6px;}
@media (max-width: 599px) {
    .task-dialog.q-card {width: 100%; max-width: 100%; max-height: calc(100dvh - 32px); border-radius: 16px;}
    .task-dialog__header {padding: 13px 12px 13px 16px;}
    .task-dialog h2 {font-size: 18px;}
    .task-dialog__body {padding: 14px;}
    .task-queue, .task-panel {padding: 14px;}
    .task-queue__summary {align-items: flex-start; flex-direction: column; gap: 6px;}
    .task-queue__counts dd {font-size: 15px;}
    .task-panels {grid-template-columns: minmax(0, 1fr); gap: 10px; margin-top: 10px;}
    .task-list__heading {align-items: baseline; flex-wrap: wrap; gap: 4px 8px;}
}
</style>
