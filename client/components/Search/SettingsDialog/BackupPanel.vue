<template>
    <section class="backup-panel" aria-label="Резервные копии">
        <p>Копии содержат профили, списки, прогресс, закладки и настройки. Каталог книг и поисковый индекс в них не входят.</p>
        <p v-if="error" role="alert" class="backup-panel__error">
            {{ error }}
        </p>
        <div v-if="!status" role="status">
            <q-spinner /> Загружаем настройки…
        </div>
        <template v-else>
            <section class="backup-panel__section">
                <h3>Защита и расписание</h3>
                <p>{{ status.passwordSet ? 'Новые копии будут зашифрованы. Для восстановления понадобится заданный пароль.' : 'Без пароля ZIP содержит ключи и секреты приложения. Задайте пароль для защиты новых копий.' }}</p>
                <p v-if="status.passwordSet">Смена пароля применяется к новым копиям. Для старых зашифрованных копий сохраните прежний пароль.</p>
                <form @submit.prevent="save">
                    <div class="backup-panel__fields">
                        <q-input v-model="password" type="password" outlined dense autocomplete="new-password" :label="status.passwordSet ? 'Новый пароль (необязательно)' : 'Пароль копий (от 10 символов)'" maxlength="1024" />
                        <q-input v-model="confirmation" type="password" outlined dense autocomplete="new-password" label="Повторите пароль" maxlength="1024" />
                        <q-input v-model.number="policy.hour" outlined dense type="number" min="0" max="23" :label="`Час создания (${status.timeZone})`" />
                        <q-input v-model.number="policy.keep" outlined dense type="number" min="1" max="60" label="Хранить автоматических копий" />
                    </div><q-toggle v-model="policy.enabled" label="Создавать копию каждый день" /><div class="backup-panel__actions">
                        <q-btn color="primary" unelevated no-caps label="Сохранить настройки" type="submit" :loading="busy === 'save'" :disable="!!busy" /><q-btn v-if="status.passwordSet" flat no-caps label="Отключить шифрование новых копий" :disable="!!busy" @click="clearPassword" />
                    </div>
                </form>
                <p v-if="status.lastScheduledAt">
                    Последняя автоматическая копия: {{ date(status.lastScheduledAt) }}
                </p>
                <p v-if="status.lastError" role="alert" class="backup-panel__error">
                    {{ status.lastError }}
                </p>
            </section>
            <section class="backup-panel__section">
                <h3>Сохранённые копии</h3><div class="backup-panel__actions">
                    <q-btn color="primary" no-caps unelevated icon="la la-plus" label="Создать копию" :loading="busy === 'create'" :disable="!!busy || dirtyPassword" @click="create" /><q-btn flat no-caps icon="la la-sync" label="Обновить" :disable="!!busy" @click="load" />
                </div>
                <p v-if="dirtyPassword">
                    Сначала сохраните новый пароль.
                </p>
                <div v-for="backup in status.backups" :key="backup.name" class="backup-panel__row">
                    <div><strong>{{ date(backup.createdAt) }}</strong><small>{{ backup.encrypted ? 'Зашифрована' : 'ZIP без пароля' }} · {{ bytes(backup.size) }} · {{ backup.scheduled ? 'Автоматическая' : 'Ручная' }}</small></div><a :href="backup.link" :download="backup.name">Скачать</a><q-btn flat dense no-caps label="Восстановить" :disable="!!busy" @click="selectStored(backup)" /><q-btn flat round dense icon="la la-trash" :aria-label="`Удалить копию от ${date(backup.createdAt)}`" :disable="!!busy" @click="remove(backup)" />
                </div>
                <p v-if="!status.backups.length">
                    Сохранённых копий пока нет.
                </p>
            </section>
            <section class="backup-panel__section">
                <h3>Восстановление</h3><q-file v-model="file" outlined dense clearable accept=".zip,.enc" label="Выберите ZIP или зашифрованную копию" :max-file-size="status.uploadLimit" :disable="!!busy" @rejected="error = 'Файл превышает допустимый размер'" @update:model-value="stored = null; preview = null" />
                <p v-if="stored">
                    Выбрана сохранённая копия: {{ date(stored.createdAt) }}
                </p>
                <q-input v-model="restorePassword" class="q-mt-md" outlined dense type="password" label="Пароль копии (для зашифрованного файла)" autocomplete="off" maxlength="1024" @update:model-value="preview = null" />
                <q-btn class="q-mt-md" outline no-caps label="Проверить копию" :loading="busy === 'preview'" :disable="!!busy || (!file && !stored)" @click="inspect" />
                <div v-if="preview" ref="previewBox" class="backup-panel__preview" role="status" tabindex="-1">
                    <h4>Копия проверена</h4><p>Версия {{ preview.version }} · {{ date(preview.createdAt) }}</p><dl><div><dt>Профили</dt><dd>{{ preview.users }}</dd></div><div><dt>Списки</dt><dd>{{ preview.lists }}</dd></div><div><dt>Позиции чтения</dt><dd>{{ preview.progress }}</dd></div><div><dt>Закладки</dt><dd>{{ preview.bookmarks }}</dd></div></dl><p>Будут заменены: {{ preview.files.map(item => item.name).join(', ') }}.</p><p>После восстановления потребуется войти заново и перезапустить приложение. Файлы книг не изменятся.</p><q-btn no-caps color="negative" label="Восстановить эту копию" :loading="busy === 'restore'" :disable="!!busy" @click="restore" />
                </div>
            </section>
        </template>
    </section>
</template>
<script setup>
import {ref, computed, watch, nextTick, onMounted, onBeforeUnmount, getCurrentInstance} from 'vue';
import {QFile} from 'quasar';
const root = getCurrentInstance().proxy.$root, status = ref(null), error = ref(''), busy = ref('');
const policy = ref({enabled: false, hour: 3, keep: 7}), password = ref(''), confirmation = ref('');
const file = ref(null), stored = ref(null), restorePassword = ref(''), preview = ref(null);
const previewBox = ref(null);
const dirtyPassword = computed(() => !!password.value || !!confirmation.value);
let alive = true, payload = null;
watch(preview, async value => {
    if (!value) return;
    await nextTick();
    previewBox.value?.focus({preventScroll: true});
    previewBox.value?.scrollIntoView({block: 'start', behavior: 'auto'});
});
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru') : 'Дата не указана';
const bytes = value => `${(value / 1048576).toFixed(1)} МБ`;
async function run(kind, action) {
    if (busy.value) return; busy.value = kind; error.value = '';
    try {await action();} catch (e) {if (alive) error.value = e.message;}
    finally {if (alive) busy.value = '';}
}
async function load() {
    const result = await root.api.adminBackupVault('status');
    if (alive) {status.value = result; policy.value = {enabled: result.enabled, hour: result.hour, keep: result.keep};}
}
function save() {return run('save', async() => {
    if (password.value !== confirmation.value) throw new Error('Пароли не совпадают');
    await root.api.adminBackupVault('update', {...policy.value, ...(password.value ? {password: password.value} : {})});
    password.value = ''; confirmation.value = ''; await load(); root.notify.success('Настройки резервных копий сохранены');
});}
async function clearPassword() {
    if (!await root.stdDialog.confirm('Новые копии будут создаваться без шифрования. Ежедневное создание будет отключено. Для старых зашифрованных копий прежний пароль остаётся необходим.', 'Отключить шифрование?')) return;
    return run('save', async() => {await root.api.adminBackupVault('update', {clearPassword: true}); await load();});
}
function create() {return run('create', async() => {await root.api.createAdminBackup(); await load(); root.notify.success('Резервная копия создана');});}
async function remove(backup) {
    if (!await root.stdDialog.confirm(`Удалить резервную копию от ${date(backup.createdAt)}?`, 'Удаление копии')) return;
    return run('delete', async() => {await root.api.adminBackupVault('delete', {name: backup.name}); await load();});
}
function selectStored(backup) {stored.value = backup; file.value = null; preview.value = null; payload = null; restorePassword.value = '';}
async function inspect() {return run('preview', async() => {
    preview.value = null;
    if (stored.value) preview.value = await root.api.adminBackupVault('preview', {name: stored.value.name, password: restorePassword.value});
    else {
        if (!file.value || file.value.size > status.value.uploadLimit) throw new Error('Выберите файл допустимого размера');
        const data = new Uint8Array(await file.value.arrayBuffer()); let binary = '';
        for (let i = 0; i < data.length; i += 16384) binary += String.fromCharCode(...data.subarray(i, i + 16384));
        payload = {contentBase64: btoa(binary), password: restorePassword.value};
        const result = await root.api.previewAdminBackup(payload); if (alive) preview.value = result;
    }
});}
async function restore() {
    if (!preview.value || !await root.stdDialog.confirm('Заменить текущие профили, личные данные и настройки содержимым проверенной копии?', 'Восстановление резервной копии')) return;
    return run('restore', async() => {
        if (stored.value) await root.api.adminBackupVault('restore', {name: stored.value.name, password: restorePassword.value, fingerprint: preview.value.fingerprint});
        else await root.api.importAdminBackup({...payload, fingerprint: preview.value.fingerprint});
        preview.value = null; payload = null; restorePassword.value = ''; file.value = null; stored.value = null;
        root.stdDialog.alert('Резервная копия восстановлена. Перезапустите приложение и войдите в профиль заново.', 'Восстановление завершено');
    });
}
onMounted(() => run('load', load));
onBeforeUnmount(() => {alive = false; payload = null; password.value = ''; confirmation.value = ''; restorePassword.value = '';});
</script>
<style scoped>
.backup-panel {color: inherit; min-width: 0;}
.backup-panel p {font-size: 13px; line-height: 1.65; color: var(--app-muted, #52696d);}
.backup-panel__section {border-top: 1px solid var(--app-border, #d6e3e3); padding: 20px 0;}
.backup-panel h3 {font-size: 16px; line-height: 1.4; margin: 0 0 12px;}
.backup-panel__fields {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px;}
.backup-panel__actions {display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0;}
.backup-panel__row {display: flex; align-items: center; flex-wrap: wrap; gap: 10px; border-bottom: 1px solid var(--app-border, #d6e3e3); padding: 14px 0;}
.backup-panel__row > div {flex: 1; min-width: 200px;}
.backup-panel__row strong {font-size: 13px; font-weight: 550;}
.backup-panel__row small {display: block; font-size: 11px; color: var(--app-muted, #52696d); margin-top: 4px;}
.backup-panel a {font-size: 12px; color: var(--app-primary, #00796f);}
.backup-panel__preview {padding: 18px; border: 1px solid var(--app-border, #d6e3e3); border-radius: 14px; margin-top: 18px; overflow-wrap: anywhere;}
.backup-panel__preview h4 {font-size: 16px; margin: 0;}
.backup-panel dl {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 14px 0;}
.backup-panel dl > div {display: flex; justify-content: space-between; gap: 8px; font-size: 13px;}
.backup-panel dd {margin: 0; font-weight: 600;}
.backup-panel__error {color: var(--app-danger, #c62828) !important;}
@media (max-width: 599px) {.backup-panel__fields {grid-template-columns: minmax(0, 1fr);} .backup-panel__row > div {flex-basis: 100%;} .backup-panel dl {grid-template-columns: minmax(0, 1fr);}}
</style>
