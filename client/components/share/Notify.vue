<template>
    <div class="hidden"></div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

class Notify {
    notify(opts) {
        const kind = ({positive:'success',negative:'error',warning:'warning',info:'info'})[opts.color] || 'info';
        const style = [opts.style, opts.iconColor && `--app-notice-icon:${opts.iconColor}`,
            opts.captionColor && `--app-notice-muted:${opts.captionColor}`, opts.messageColor && `color:${opts.messageColor}`]
            .filter(Boolean).join(';');
        return this.$q.notify({
            position: opts.position || 'bottom-right',
            color: undefined,
            textColor: undefined,
            classes: `app-notification app-notification--${kind}`,
            icon: opts.icon || '',
            timeout: opts.timeout ?? 5000,
            message: String(opts.message || ''),
            caption: opts.caption ? String(opts.caption) : undefined,
            html: false,
            attrs: {role:kind === 'error' ? 'alert' : 'status', ...(style ? {style} : {})},
            actions: [{icon:'la la-times', 'aria-label':'Закрыть уведомление'}],
        });
    }

    success(message, caption, options) {
        return this.notify(Object.assign({color: 'positive', icon: 'la la-check-circle', message, caption}, options));
    }

    warning(message, caption, options) {
        return this.notify(Object.assign({color: 'warning', icon: 'la la-exclamation-circle', message, caption}, options));
    }

    error(message, caption, options) {
        return this.notify(Object.assign({color: 'negative', icon: 'la la-exclamation-circle', message, caption}, options));
    }

    info(message, caption, options) {
        return this.notify(Object.assign({color: 'info', icon: 'la la-bell', message, caption}, options));
    }
}

export default vueComponent(Notify);
//-----------------------------------------------------------------------------
</script>

<style>
.q-notification.app-notification {background: var(--app-surface, #fff); color: var(--app-text, #183236); border: 1px solid var(--app-border, #d6e3e3); border-radius: 16px; padding: 14px 16px; max-width: min(420px, calc(100vw - 32px)); box-shadow: 0 8px 30px #00000030;}
.app-notification .q-notification__message {font-size: 14px; line-height: 1.5; overflow-wrap: anywhere;}
.app-notification .q-notification__caption {margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--app-notice-muted, var(--app-muted, #52696d)); opacity: 1;}
.app-notification .q-notification__icon {color: var(--app-notice-icon, var(--app-primary, #00796f)); font-size: 25px;}
.app-notification--warning {--app-notice-icon: #bd7b22;}
.app-notification--error {--app-notice-icon: #d75570;}
.app-notification .q-notification__actions .q-btn {color: inherit; min-width: 32px; min-height: 32px; border-radius: 9px;}
@media (prefers-reduced-motion: reduce) {.app-notification {animation: none !important; transition: none !important;}}
</style>
