const maximumTrustedBrowserDays = 180;
const defaults = Object.freeze({otpRequired:false, trustedBrowsersEnabled:true, trustedBrowserDays:30});

function validDays(days) {
    return Number.isInteger(days) && days >= 1 && days <= maximumTrustedBrowserDays;
}

function normalize(value) {
    return {
        otpRequired:value?.otpRequired === true,
        trustedBrowsersEnabled:typeof value?.trustedBrowsersEnabled === 'boolean' ? value.trustedBrowsersEnabled : defaults.trustedBrowsersEnabled,
        trustedBrowserDays:validDays(value?.trustedBrowserDays) ? value.trustedBrowserDays : defaults.trustedBrowserDays,
    };
}

function valid(value) {
    return typeof value?.otpRequired === 'boolean' && typeof value.trustedBrowsersEnabled === 'boolean'
        && validDays(value.trustedBrowserDays);
}

module.exports = {defaults, maximumTrustedBrowserDays, normalize, valid};
