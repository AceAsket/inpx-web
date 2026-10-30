<template>
    <div class="library-tools">
        <div v-if="$root.api && $root.api.indexWaitMessage" class="library-index-status" role="status">
            <q-spinner size="18px" /> {{ $root.api.indexWaitMessage }}
        </div>
        <div v-if="authorized" class="library-tools-buttons">
            <q-btn dense flat no-caps icon="la la-tasks" label="Задачи" @click="openTasks" />
            <q-btn dense flat no-caps icon="la la-star" label="Избранные авторы и серии" @click="openFollows" />
        </div>
        <q-dialog v-model="tasksOpen" @hide="stopPolling">
            <q-card class="library-tools-card">
                <q-card-section class="row items-center">
                    <strong class="col">Задачи и состояние библиотеки</strong><q-btn flat round dense icon="la la-times" aria-label="Закрыть задачи" @click="tasksOpen = false" />
                </q-card-section>
                <q-card-section>
                    <p v-if="error" class="text-negative" role="alert">
                        {{ error }}
                    </p>
                    <p v-if="loading && !tasks.length" role="status">
                        Загрузка задач…
                    </p>
                    <p v-else-if="!tasks.length">
                        Задач пока нет.
                    </p>
                    <article v-for="task in tasks" :key="task.id" class="library-task">
                        <div><strong>{{ task.title }}</strong><span class="library-task-state">{{ stateLabel(task.state) }}</span></div>
                        <p v-if="task.state === 'queued'">
                            Ожидание свободного места{{ task.queuePosition ? ` · позиция ${task.queuePosition}` : '' }}
                        </p>
                        <p v-else-if="task.state === 'running' || task.state === 'generating'">
                            {{ task.phase === 'loading' ? 'Загрузка модели озвучки' : task.phase || 'Обработка' }}
                            {{ task.total ? ` · ${task.done.toLocaleString()} / ${task.total.toLocaleString()}` : '' }}
                        </p>
                        <q-linear-progress v-if="['running','generating'].includes(task.state)" :indeterminate="task.progress === null || task.progress === undefined" :value="task.progress || 0" />
                        <p v-if="task.waitingReason">
                            {{ task.waitingReason }}
                        </p>
                        <p v-if="task.remainingSeconds > 0 && ['running','generating'].includes(task.state)">
                            Осталось примерно {{ Math.max(1, Math.ceil(task.remainingSeconds / 60)) }} мин
                        </p>
                        <p v-if="task.error" class="text-negative">
                            {{ task.error }}
                        </p>
                    </article>
                    <p v-if="resources" class="library-tools-hint">
                        Обрабатывается: {{ resources.active }} · в очереди: {{ resources.queued }}. Лимиты задаются при запуске контейнера.
                    </p>
                    <section v-if="isAdmin && isbnIndex" class="library-audit">
                        <h3>Индекс ISBN</h3>
                        <p>Номера ISBN берутся из каталога и файлов FB2/EPUB. Первая подготовка большой коллекции может занять много времени; обычный поиск продолжает работать.</p>
                        <p v-if="isbnIndex.remote">
                            Подготовка выполняется на сервере с исходными книгами.
                        </p>
                        <p v-else role="status">
                            {{ isbnStateLabel }}.
                            Обработано {{ isbnIndex.checked }} / {{ isbnIndex.total }} · с ISBN: {{ isbnIndex.found }} · не прочитано: {{ isbnIndex.errors }} · пропущено: {{ isbnIndex.skipped }}
                        </p>
                        <p v-if="isbnIndex.error" class="text-negative">
                            {{ isbnIndex.error }}
                        </p>
                        <div v-if="!isbnIndex.remote" class="library-tools-buttons">
                            <q-btn
                                v-if="isbnIndex.state !== 'running' && isbnIndex.state !== 'ready'" outline no-caps
                                label="Подготовить ISBN" :disable="loading || isbnBusy" @click="manageIsbn('start')"
                            />
                            <q-btn v-if="isbnIndex.state === 'running'" outline no-caps label="Отменить подготовку ISBN" :disable="isbnBusy" @click="manageIsbn('cancel')" />
                            <q-btn v-if="isbnIndex.state !== 'running'" flat no-caps label="Перестроить ISBN полностью" :disable="loading || isbnBusy" @click="manageIsbn('start',true)" />
                        </div>
                    </section>
                    <section v-if="isAdmin" class="library-audit">
                        <h3>Проверка библиотеки</h3>
                        <p>Проверяет наличие архивов и книг. Исходные файлы не изменяются.</p>
                        <q-checkbox v-model="deep" :disable="auditRunning" label="Проверять также содержимое FB2 и EPUB" />
                        <p v-if="deep" class="library-tools-hint">
                            Проверка содержимого может занять много времени. Книги сверх установленного лимита будут пропущены.
                        </p>
                        <div class="library-tools-buttons">
                            <q-btn v-if="!auditRunning" outline no-caps label="Запустить проверку" :disable="loading" @click="startAudit" />
                            <q-btn v-else outline no-caps label="Отменить проверку" @click="cancelAudit" />
                            <q-btn v-if="audit" flat no-caps label="Скачать отчёт" @click="downloadReport" />
                        </div>
                        <p v-if="audit" role="status">
                            Проверено {{ audit.checked }} / {{ audit.total }} · отсутствует: {{ audit.missing }} · ошибки: {{ audit.damaged }} · пропущено: {{ audit.skipped }}
                        </p>
                        <p v-if="audit && audit.error" class="text-negative">
                            {{ audit.error }}
                        </p>
                        <ul v-if="audit && audit.issues.length" class="library-audit-issues">
                            <li v-for="(issue,index) in audit.issues" :key="index">
                                <strong>{{ issue.title || issue.folder }}</strong> — {{ issue.message }}
                            </li>
                        </ul>
                        <p v-if="audit && audit.issuesTruncated">
                            Показаны первые 500 замечаний; счётчики учитывают остальные.
                        </p>
                    </section>
                </q-card-section>
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
        isbnIndex:null,isbnBusy:false,loading:false,error:'',pollTimer:null,generation:0,follows:[],books:[],truncated:false,kind:'author',value:'',busy:false,followError:''};},
    computed:{
        authorized() {return !!this.$store.state.config.profileAuthorized;},
        identity() {return `${this.$store.state.settings.currentUserId}:${this.$store.state.settings.profileAccessToken}:${this.authorized}`;},
        auditRunning() {return !!this.audit && !this.audit.finishedAt;},
        isbnStateLabel() {return {ready:'Индекс готов',running:'Подготовка',paused:'Подготовка приостановлена',empty:'Нужна подготовка индекса'}[this.isbnIndex?.state] || '';},
    },
    watch:{identity() {
        this.stopPolling(); this.tasksOpen = this.followsOpen = false;
        this.tasks = []; this.follows = []; this.books = []; this.audit = null; this.isbnIndex = null; this.isbnBusy = false;
        this.isAdmin = this.busy = this.loading = false; this.resources = null; this.error = this.followError = '';
    }},
    beforeUnmount() {this.stopPolling();},
    methods:{
        stateLabel(state) {return {queued:'В очереди',running:'В работе',generating:'В работе',ready:'Готово',error:'Ошибка',cancelled:'Отменено'}[state] || state;},
        stopPolling() {clearTimeout(this.pollTimer); this.generation++;},
        openTasks() {this.tasksOpen = true; this.stopPolling(); this.loadTasks(this.generation);},
        async loadTasks(generation) {
            this.loading = true;
            try {const result = await this.$root.api.getBackgroundTasks(); if (generation !== this.generation) return;
                Object.assign(this,{tasks:result.tasks,resources:result.resources,audit:result.audit,isbnIndex:result.isbnIndex,isAdmin:result.isAdmin,error:''});
            } catch (error) {if (generation === this.generation) this.error = error.message;}
            finally {if (generation === this.generation) {this.loading = false; if (this.tasksOpen) this.pollTimer = setTimeout(() => this.loadTasks(generation),2000);}}
        },
        async manageIsbn(operation,force = false) {
            this.stopPolling(); const generation = this.generation; this.isbnBusy = true;
            try {await this.$root.api.manageIsbnIndex(operation,{force}); if (generation === this.generation) await this.loadTasks(generation);}
            catch (error) {if (generation === this.generation) {
                this.error = error.message;
                if (this.tasksOpen) this.pollTimer = setTimeout(() => this.loadTasks(generation),2000);
            }}
            finally {if (generation === this.generation) this.isbnBusy = false;}
        },
        async startAudit() {try {await this.$root.api.startLibraryAudit({deep:this.deep}); this.stopPolling(); await this.loadTasks(this.generation);} catch (error) {this.error = error.message;}},
        async cancelAudit() {try {await this.$root.api.cancelLibraryAudit(); this.stopPolling(); await this.loadTasks(this.generation);} catch (error) {this.error = error.message;}},
        downloadReport() {
            const url = URL.createObjectURL(new Blob([JSON.stringify(this.audit,null,2)],{type:'application/json'}));
            const link = document.createElement('a'); link.href = url; link.download = 'inpx-library-audit.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
        },
        openFollows() {
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
.library-tools { color:inherit; }
.library-tools-buttons,.library-index-status { display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
.library-tools-buttons { padding:4px 8px; }
.library-index-status { padding:10px 16px; }
.library-tools-card { width:min(720px,95vw);max-height:90dvh;overflow:auto; }
.library-task,.library-follow { padding:12px 0;border-bottom:1px solid #8884;overflow-wrap:anywhere; }
.library-task-state { margin-left:12px;opacity:.75; }
.library-tools-hint { font-size:.9em;opacity:.8; }
.library-audit { margin-top:20px; }
.library-audit h3,.library-tools-card h3 {font-size:1.1em;margin:12px 0;}
.library-audit-issues { max-height:240px;overflow:auto;padding-left:20px; }
.library-follow-form { display:grid;grid-template-columns:140px minmax(0,1fr) auto;gap:10px;align-items:end; }
.library-follow-form label {display:flex;flex-direction:column;gap:5px;}
.library-follow-form select {background:inherit;color:inherit;padding:8px;border:1px solid #8888;border-radius:5px;}
@media(max-width:600px) {.library-follow-form {grid-template-columns:1fr;} .library-tools-card {width:95vw;}}
</style>
