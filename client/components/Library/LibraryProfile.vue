<template>
    <div class="library-page">
        <div class="library-page__body profile-page">
            <h1>Профиль</h1>
            <p class="library-page__subtitle">Ваша библиотека и её оформление</p>
            <section class="profile-card" aria-label="Текущий профиль">
                <span class="profile-avatar">{{ name.slice(0, 1).toUpperCase() }}</span>
                <div><h2>{{ name }}</h2><p>{{ config.profileAuthorized ? (config.currentUserProfile?.isAdmin ? 'Администратор библиотеки' : 'Личный профиль') : 'Общий профиль' }}</p></div>
                <q-btn flat no-caps :label="config.profileAuthorized ? 'Сменить' : 'Войти'" @click="config.profileAuthorized ? library.openProfiles() : library.login()" />
            </section>
            <section class="profile-section" aria-label="Оформление">
                <AppearanceControl />
                <q-toggle :model-value="!!settings.darkTheme" label="Ночная тема" color="primary" @update:model-value="store.commit('setSettings', {darkTheme: $event})" />
            </section>
            <section class="profile-section profile-links" aria-label="Настройки профиля и библиотеки">
                <button type="button" @click="library.openProfiles()"><q-icon name="la la-users-cog" size="25px" /><span>Профили и личные настройки<small>Вход, синхронизация и получатели книг</small></span><q-icon name="la la-angle-right" /></button>
                <button type="button" @click="library.openLists()"><q-icon name="la la-bookmark" size="25px" /><span>Полки и списки чтения<small>Ваши подборки и умные полки</small></span><q-icon name="la la-angle-right" /></button>
                <button v-if="config.profileAuthorized" type="button" @click="library.openFollows()"><q-icon name="la la-star" size="25px" /><span>Избранные авторы и серии<small>Новые книги любимых авторов</small></span><q-icon name="la la-angle-right" /></button>
                <button type="button" @click="library.openSettings()"><q-icon name="la la-sliders-h" size="25px" /><span>Настройки библиотеки<small>{{ config.currentUserProfile?.isAdmin ? 'Каталог, источники и администрирование' : 'Каталог, карточки и подборки' }}</small></span><q-icon name="la la-angle-right" /></button>
            </section>
            <div class="profile-bottom"><span>{{ config.name || 'INPX Web' }} {{ config.webAppVersion || config.version }}</span><ProfileLogout /></div>
        </div>
    </div>
</template>

<script setup>
import {computed} from 'vue';
import {useStore} from 'vuex';
import AppearanceControl from './AppearanceControl.vue';
import ProfileLogout from '../share/ProfileLogout.vue';
import {useLibraryPage} from './useLibraryPage';

const {library} = useLibraryPage('Профиль', () => {});
const {config, settings} = library;
const store = useStore();
const name = computed(() => config.value.currentUserProfile?.name || 'Общий профиль');
</script>

<style scoped>
.profile-page {max-width: 760px;}
.profile-card {display: flex; align-items: center; gap: 18px; padding: 24px; border-radius: 22px; background: var(--app-surface); margin-bottom: 24px;}
.profile-avatar {display: grid; place-items: center; width: 60px; height: 60px; border-radius: 19px; font-size: 25px; background: var(--app-surface-2); color: var(--app-primary); flex-shrink: 0;}
.profile-card > div {flex: 1; min-width: 0;}
h2 {font-size: 20px; line-height: 1.4; font-weight: 550; margin: 0; overflow-wrap: anywhere;}
.profile-card p {font-size: 12px; color: var(--app-muted); margin: 5px 0 0;}
.profile-section {padding: 24px; border-radius: 22px; background: var(--app-surface); margin-bottom: 24px;}
.profile-links {padding: 10px 24px;}
.profile-links button {display: flex; align-items: center; gap: 16px; width: 100%; background: transparent; color: var(--app-text); border: 0; padding: 18px 0; font: inherit; cursor: pointer; text-align: left;}
.profile-links button + button {border-top: 1px solid var(--app-border);}
.profile-links button > span {flex: 1; font-size: 14px;}
.profile-links button > .q-icon:first-child {color: var(--app-primary);}
small {display: block; color: var(--app-muted); margin-top: 5px; font-size: 12px; line-height: 1.5;}
.profile-bottom {display: flex; align-items: center; justify-content: space-between; gap: 16px; color: var(--app-muted); font-size: 12px;}
@media (max-width: 599px) {.profile-card, .profile-section {padding: 18px;} .profile-links {padding: 0 18px;} .profile-card {gap: 12px;} .profile-avatar {width: 48px; height: 48px; border-radius: 15px;} h2 {font-size: 18px;}}
@media (min-width: 1100px) {.profile-page {max-width: 1160px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 24px; align-items: start;} h1, .library-page__subtitle, .profile-card, .profile-bottom {grid-column: 1 / -1;} .profile-section {margin-bottom: 20px;}}
</style>
