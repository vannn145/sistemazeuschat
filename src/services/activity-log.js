const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
const LOG_PATH = path.join(LOG_DIR, 'webhook-events.json');
const MAX_ENTRIES = 200;

function ensureDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function sanitizePayload(payload) {
    if (!payload) {
        return null;
    }
    try {
        const clone = JSON.parse(JSON.stringify(payload));
        const stringified = JSON.stringify(clone);
        if (stringified.length > 6000) {
            return { truncated: true, approxSize: stringified.length, snapshot: clone }; // keep snapshot when payload is large
        }
        return clone;
    } catch (err) {
        return { error: err.message || String(err) };
    }
}

function readEntries() {
    try {
        if (fs.existsSync(LOG_PATH)) {
            const raw = fs.readFileSync(LOG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed;
            }
        }
    } catch (_) {
        return [];
    }
    return [];
}

function writeEntries(entries) {
    ensureDir();
    const trimmed = Array.isArray(entries) ? entries.slice(0, MAX_ENTRIES) : [];
    fs.writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2));
}

function appendEvent(event) {
    const safeEvent = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        ...event,
        payload: sanitizePayload(event?.payload)
    };
    const entries = readEntries();
    entries.unshift(safeEvent);
    if (entries.length > MAX_ENTRIES) {
        entries.length = MAX_ENTRIES;
    }
    writeEntries(entries);
    return safeEvent;
}

function getRecentEvents({ limit = 50, type = null } = {}) {
    const entries = readEntries();
    const filtered = type ? entries.filter((entry) => entry?.type === type) : entries;
    return filtered.slice(0, Math.max(1, limit));
}

module.exports = {
    appendEvent,
    getRecentEvents
};
