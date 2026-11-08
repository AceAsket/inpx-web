<template>
    <q-btn
        v-if="canLogout" class="profile-logout" outline dense no-caps color="primary"
        icon="la la-sign-out-alt" :label="label" aria-label="Выйти из профиля" title="Выйти из профиля"
        :loading="busy" :disable="busy" @click="logout"
    />
</template>

<script>
export default {
    props: {label: {type: String, default: 'Выйти'}},
    data: () => ({busy: false}),
    computed: {
        canLogout() {
            const config = this.$store.state.config;
            return !!config.profileAuthorized && !config.profileBoundId;
        },
    },
    methods: {
        async logout() {
            if (this.busy) return;
            this.busy = true;
            try {
                await this.$root.api.signOutProfile();
                // Discard personal dialogs and pending replies from the old session.
                window.location.reload();
            } catch (error) {
                this.$root.stdDialog.alert(error.message || String(error), 'Не удалось выйти из профиля');
            } finally { this.busy = false; }
        },
    },
};
</script>

<style scoped>
.profile-logout {
    flex: none;
    min-height: 32px;
    padding: 4px 10px;
    margin-left: 8px;
    white-space: nowrap;
}
@media(max-width:640px) {
    .profile-logout { margin-left:4px; padding:4px 8px; font-size:12px; }
    .profile-logout :deep(.q-icon) { display:none; }
}
</style>
