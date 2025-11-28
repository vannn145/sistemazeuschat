const DEFAULT_TZ = process.env.CLINIC_TIMEZONE || 'America/Sao_Paulo';

function ensureDate(input) {
    if (!input) {
        return null;
    }
    if (input instanceof Date) {
        return Number.isNaN(input.getTime()) ? null : input;
    }
    const parsed = new Date(input);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatClinicDate(input, localeOptions = {}) {
    const date = ensureDate(input);
    if (!date) {
        return '';
    }
    return date.toLocaleDateString('pt-BR', {
        timeZone: DEFAULT_TZ,
        ...localeOptions
    });
}

function formatClinicTime(input, localeOptions = {}) {
    const date = ensureDate(input);
    if (!date) {
        return '';
    }
    return date.toLocaleTimeString('pt-BR', {
        timeZone: DEFAULT_TZ,
        hour: '2-digit',
        minute: '2-digit',
        ...localeOptions
    });
}

function formatClinicDateTime(input, localeOptions = {}) {
    return {
        date: formatClinicDate(input, localeOptions.date || {}),
        time: formatClinicTime(input, localeOptions.time || {})
    };
}

module.exports = {
    ensureDate,
    formatClinicDate,
    formatClinicTime,
    formatClinicDateTime,
    CLINIC_TIMEZONE: DEFAULT_TZ
};
