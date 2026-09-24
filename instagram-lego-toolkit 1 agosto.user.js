// ==UserScript==
// @name         Instagram Lego Toolkit
// @namespace    https://node-builder.local/
// @version      1.0.0
// @description  Compiled by Node Builder -- 26 block(s): Quick Message Recorder, Sidebar Plugin Manager, Recorder Studio, Audio Library, Dual Sidebar UI Shell, menuCollapseModule, Menu Panel Switcher Module, Menu Card Pop-out Module, Header Toolbar Organizer Module, Workspace Profile & Visibility Manager, Instagram Resizer Feature, Sidebar-to-Resizer Sync, Quick Chat Box, Text Library Module (Saved Snippets), image manager, Highlighter, Commands, Reorder Module, text sync Google Sheets, ManyChat Integration, ManyChat Username Detector, Text Library Height Fix (v1), Reset menus, Image Library, Emoji Module, Audio Bunny Sync
// @author       You
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @connect      docs.google.com
// @connect      bunnycdn.com
// @connect      generativelanguage.googleapis.com
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

/* ============================================================
   CORE ENGINE
   ============================================================ */
/* ================================================================
   CORE ENGINE: Instagram Soundboard & Chat Infrastructure (Safe & Clean)
   v2 — Shared Inventory Search (v28.1 token/MRU engine) + Image Set Bridge
        + Sequence State
   Handles IndexedDB storage, hotkey configurations, chat injection
   bridges, shared search/scoring, item fetching and sequence state.
================================================================ */
const LegoCore = (function () {
    let db;
    let mediaRecorder;
    let audioChunks = [];
    let currentBlob = null;
    let originalBlobBackup = null;
    let selectedForStitchId = null;

    let quickMediaRecorder;
    let quickAudioChunks = [];
    let quickCurrentBlob = null;
    let quickOriginalBlobBackup = null;
    let isQuickRecording = false;

    const DB_NAME = 'IG_Soundboard_Fresh_Core_DB';
    const DB_VERSION = 2;

    // Shared storage keys (read-only for core, except sequences)
    const IMAGE_DB_NAME = 'IG_ImageSets_Core_DB';
    const TEXT_LIB_KEY = 'ig_text_library_pro_v1';
    const MC_FLOWS_KEY = 'mc_flows_cache_v1';
    const SEQUENCES_KEY = 'ig_sequences_v1';

    const listeners = {};
    function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); }
    function off(event, fn) { if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== fn); }
    function emit(event, payload) {
        (listeners[event] || []).forEach(fn => {
            try { fn(payload); } catch (e) { console.error('[LegoCore] listener error:', e); }
        });
    }

    // 1. Initialize IndexedDB Database
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = e => console.error("Fresh DB Error:", e);
    request.onupgradeneeded = e => {
        db = e.target.result;
        if (!db.objectStoreNames.contains('clips')) {
            const clipStore = db.createObjectStore('clips', { keyPath: 'id', autoIncrement: true });
            clipStore.createIndex('order', 'order', { unique: false });
        }
        if (!db.objectStoreNames.contains('folders')) {
            const folderStore = db.createObjectStore('folders', { keyPath: 'name' });
            folderStore.put({ name: "General" });
        }
    };

    request.onsuccess = e => {
        db = e.target.result;
        db.onversionchange = () => { db.close(); window.location.reload(); };
        emit('db:ready', db);
    };

    function withDb(cb) {
        if (db) { cb(db); return; }
        const handler = readyDb => { off('db:ready', handler); cb(readyDb); };
        on('db:ready', handler);
    }
    function whenDbReady() { return new Promise(resolve => withDb(resolve)); }

    // Small shared helpers
    function escapeHtml(str) {
        return String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }
    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null) return fallback;
            const val = JSON.parse(raw);
            return val === null || val === undefined ? fallback : val;
        } catch (e) { return fallback; }
    }
    function norm(s) { return String(s === undefined || s === null ? '' : s).trim().toLowerCase(); }

    // 2. Shortcut Configurations
    const getShortcutConfig = (action, defaultKey, defaultMod) => {
        return {
            key: localStorage.getItem(`sb_sc_${action}_key`) || defaultKey,
            mod: localStorage.getItem(`sb_sc_${action}_mod`) || defaultMod
        };
    };

    function getActiveChatZone() {
        const zones = document.querySelectorAll('div[contenteditable="true"], form textarea');
        for (let zone of zones) {
            const rect = zone.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                return zone;
            }
        }
        return null;
    }

    // 3. Chat Injection Bridges (SAFE PASTE ONLY - NO SYNTHETIC ENTER KEYS)
    //    All bridges return true on success, false otherwise.
    //    Pass { silent: true } to suppress the "open a chat" alert.
    function dispatchDropSequence(chatZone, dataTransfer) {
        ['dragenter', 'dragover', 'drop'].forEach(eventType => {
            chatZone.dispatchEvent(new DragEvent(eventType, {
                bubbles: true,
                cancelable: true,
                dataTransfer: dataTransfer
            }));
        });
    }

    function noChatZone(opts) {
        if (!opts || !opts.silent) alert("Open an active Instagram chat window first.");
        return false;
    }

    function injectClipToChat(blob, name, opts = {}) {
        if (!blob) return false;
        const chatZone = getActiveChatZone();
        if (!chatZone) return noChatZone(opts);

        const audioFile = new Blob([blob], { type: 'audio/mp4' });
        const fileObj = new File([audioFile], `${name || 'clip'}.m4a`, { type: 'audio/mp4' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(fileObj);
        dispatchDropSequence(chatZone, dataTransfer);
        return true;
    }

    function injectImageToChat(blob, name, opts = {}) {
        if (!blob) return false;
        const chatZone = getActiveChatZone();
        if (!chatZone) return noChatZone(opts);

        const fileObj = new File([blob], `${name || 'image'}.jpg`, { type: blob.type || 'image/jpeg' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(fileObj);
        dispatchDropSequence(chatZone, dataTransfer);
        return true;
    }

    // NEW: packages a whole image set into ONE DataTransfer (one drop = one album)
    function injectImageSetToChat(imagesArray, opts = {}) {
        const images = (imagesArray || []).filter(img => img && img.blob);
        if (!images.length) return false;
        const chatZone = getActiveChatZone();
        if (!chatZone) return noChatZone(opts);

        const dataTransfer = new DataTransfer();
        images.forEach((img, i) => {
            const type = img.type || img.blob.type || 'image/jpeg';
            const ext = ((type.split('/')[1] || 'jpeg').split('+')[0]) || 'jpeg';
            dataTransfer.items.add(new File([img.blob], `image_${i}.${ext}`, { type }));
        });
        dispatchDropSequence(chatZone, dataTransfer);
        return true;
    }

    function injectTextToChat(text, opts = {}) {
        if (!text) return false;
        const chatZone = getActiveChatZone();
        if (!chatZone) return noChatZone(opts);

        chatZone.focus();
        document.execCommand('insertText', false, text);
        chatZone.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        return true;
    }

    // 4. Window Draggable Helpers
    function makeDraggable(panelElement, headerElement, storageKey) {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        headerElement.onmousedown = e => {
            if (e.button !== 0) return;
            isDragging = true;
            headerElement.style.cursor = "grabbing";
            startX = e.clientX;
            startY = e.clientY;
            const rect = panelElement.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            panelElement.style.bottom = "auto";
            panelElement.style.right = "auto";
            panelElement.style.left = `${initialLeft}px`;
            panelElement.style.top = `${initialTop}px`;

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        };

        function onMouseMove(e) {
            if (!isDragging) return;
            panelElement.style.left = `${initialLeft + (e.clientX - startX)}px`;
            panelElement.style.top = `${initialTop + (e.clientY - startY)}px`;
        }

        function onMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            headerElement.style.cursor = "grab";
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            const rect = panelElement.getBoundingClientRect();
            localStorage.setItem(storageKey, JSON.stringify({ bottom: 'auto', left: `${rect.left}px`, top: `${rect.top}px` }));
        }
    }

    function makeIsolatedDraggable(panel, header, storageKey) {
        let dragging = false, startX, startY, initL, initT;
        header.onmousedown = e => {
            if (e.button !== 0) return;
            dragging = true;
            header.style.cursor = "grabbing";
            startX = e.clientX; startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            initL = rect.left; initT = rect.top;
            panel.style.bottom = "auto"; panel.style.right = "auto";
            panel.style.left = `${initL}px`; panel.style.top = `${initT}px`;

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        };
        function onMove(e) {
            if (!dragging) return;
            panel.style.left = `${initL + (e.clientX - startX)}px`;
            panel.style.top = `${initT + (e.clientY - startY)}px`;
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            header.style.cursor = "grab";
            // FIX: previously removed `onMouseMove` (undefined here) -> ReferenceError on drop
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const rect = panel.getBoundingClientRect();
            localStorage.setItem(storageKey, JSON.stringify({ bottom: 'auto', left: `${rect.left}px`, top: `${rect.top}px` }));
        }
    }

    // 5. Shared Data Readers
    function getClips() {
        return whenDbReady().then(readyDb => new Promise(resolve => {
            try {
                const req = readyDb.transaction(['clips'], 'readonly').objectStore('clips').getAll();
                req.onsuccess = e => resolve(e.target.result || []);
                req.onerror = () => resolve([]);
            } catch (e) { resolve([]); }
        }));
    }

    // Opens the Image Sets DB WITHOUT ever creating it: if it doesn't exist yet,
    // the upgrade is aborted so the image module can still create it properly later.
    function openImageDb() {
        return new Promise(resolve => {
            let req;
            try { req = indexedDB.open(IMAGE_DB_NAME); } catch (e) { resolve(null); return; }
            req.onupgradeneeded = e => { try { e.target.transaction.abort(); } catch (_) { /* noop */ } };
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => { if (e && e.preventDefault) e.preventDefault(); resolve(null); };
            req.onblocked = () => resolve(null);
        });
    }

    async function getImageSets() {
        const idb = await openImageDb();
        if (!idb) return [];
        if (!idb.objectStoreNames.contains('sets')) { idb.close(); return []; }
        return new Promise(resolve => {
            try {
                const tx = idb.transaction(['sets'], 'readonly');
                const req = tx.objectStore('sets').getAll();
                req.onsuccess = ev => resolve(ev.target.result || []);
                req.onerror = () => resolve([]);
                tx.oncomplete = () => idb.close();
                tx.onabort = () => idb.close();
            } catch (e) { idb.close(); resolve([]); }
        });
    }

    function getTextSnippets() {
        const data = readJson(TEXT_LIB_KEY, { items: [], tags: [] });
        return (Array.isArray(data.items) ? data.items : []).filter(i => i && i.type === 'snippet');
    }

    function getMcFlows() {
        const flows = readJson(MC_FLOWS_KEY, []);
        return Array.isArray(flows) ? flows : [];
    }

    function getSequences() {
        const list = readJson(SEQUENCES_KEY, []);
        if (!Array.isArray(list)) return [];
        return list.filter(s => s && typeof s === 'object' && Array.isArray(s.steps));
    }

    function saveSequences(list) {
        localStorage.setItem(SEQUENCES_KEY, JSON.stringify(Array.isArray(list) ? list : []));
        emit('sequences:updated', getSequences());
    }

    async function getSearchableInventory() {
        const [clips, imageSets] = await Promise.all([getClips(), getImageSets()]);
        return {
            clips,
            textItems: getTextSnippets(),
            mcFlows: getMcFlows(),
            imageSets,
            sequences: getSequences()
        };
    }

    // 6. Shared Search (ported 1:1 from quickCommandExtension v28.1 + 'sequence' kind)
    //    Token-based, accent-insensitive, all tokens must match; MRU as tiebreaker.
    const ALL_KINDS = ['text', 'audio', 'flow', 'set', 'sequence'];
    const SEARCH_PREFIXES = [
        ['text', 'text'], ['audio', 'audio'], ['flow', 'flow'], ['set', 'set'],
        ['sequence', 'sequence'], ['seq', 'sequence']
    ];
    const RECENT_USAGE_KEY = 'ig_qcx_recent_usage_v1';

    function normalizeStr(str) {
        return String(str || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'¡¿]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function getSearchTokens(query) {
        const n = normalizeStr(query);
        return n ? n.split(' ').filter(t => t.length > 0) : [];
    }
    function matchAllTokens(searchPool, tokens) {
        if (!tokens.length) return true;
        const pool = normalizeStr(searchPool);
        return tokens.every(tok => pool.includes(tok));
    }

    // --- Most-Recently-Used tracking (same storage key as v28.1, so history is kept) ---
    function getRecentUsageMap() { return readJson(RECENT_USAGE_KEY, {}) || {}; }
    function getItemId(kind, item) { return kind === 'flow' ? item.flow_ns : item.id; }
    function markUsed(kind, id) {
        if (id === undefined || id === null) return;
        const map = getRecentUsageMap();
        map[`${kind}:${id}`] = Date.now();
        try { localStorage.setItem(RECENT_USAGE_KEY, JSON.stringify(map)); } catch (e) { /* quota */ }
    }
    function getUsageTimestamp(kind, id, map) {
        if (id === undefined || id === null) return 0;
        return (map || getRecentUsageMap())[`${kind}:${id}`] || 0;
    }

    // "audio intro" -> { mode:'audio', q:'intro' }   "hola" -> { mode:'all', q:'hola' }
    function parseSearchPrefix(raw) {
        const text = String(raw || '');
        const lower = text.toLowerCase();
        for (const [prefix, mode] of SEARCH_PREFIXES) {
            if (lower === prefix) return { mode, q: '' };
            if (lower.startsWith(prefix + ' ')) return { mode, q: text.slice(prefix.length + 1) };
        }
        return { mode: 'all', q: text };
    }

    // Pure scoring. opts.kinds = whitelist of kinds that may ever appear; opts.limit caps results.
    function scoreInventory(query, mode, inventory, opts = {}) {
        const inv = inventory || {};
        const allowed = new Set(opts.kinds || ALL_KINDS);
        const active = (!mode || mode === 'all') ? allowed : new Set([mode].filter(k => allowed.has(k)));
        const tokens = getSearchTokens(query);
        const rawQuery = normalizeStr(query);
        const results = [];

        if (active.has('text')) {
            (inv.textItems || []).forEach(item => {
                const cmd = normalizeStr(item.customCommand);
                const title = normalizeStr(item.title);
                const body = normalizeStr(item.text);
                if (matchAllTokens(`${title} ${cmd} ${body}`, tokens)) {
                    const cmdExact = cmd && cmd === rawQuery;
                    const cmdPrefix = cmd && rawQuery && cmd.startsWith(rawQuery);
                    const titleHasAll = matchAllTokens(title, tokens);
                    const score = cmdExact ? 110 : cmdPrefix ? 95 : titleHasAll ? 70 : 45;
                    results.push({ kind: 'text', item, score, matchedField: titleHasAll ? 'title' : 'body' });
                }
            });
        }
        if (active.has('audio')) {
            (inv.clips || []).forEach(clip => {
                const cmd = normalizeStr(clip.customCommand);
                const name = normalizeStr(clip.name);
                const transcript = normalizeStr(clip.transcript);
                if (matchAllTokens(`${name} ${cmd} ${transcript}`, tokens)) {
                    const cmdExact = cmd && cmd === rawQuery;
                    const cmdPrefix = cmd && rawQuery && cmd.startsWith(rawQuery);
                    const nameHasAll = matchAllTokens(name, tokens);
                    const score = cmdExact ? 110 : cmdPrefix ? 95 : nameHasAll ? 70 : 50;
                    results.push({ kind: 'audio', item: clip, score, matchedField: nameHasAll ? 'name' : 'transcript' });
                }
            });
        }
        if (active.has('flow')) {
            (inv.mcFlows || []).forEach(flow => {
                const name = normalizeStr(flow.name);
                const folder = normalizeStr(flow.folder);
                const transcript = normalizeStr(flow.transcript);
                if (matchAllTokens(`${name} ${folder} ${transcript}`, tokens)) {
                    const nameHasAll = matchAllTokens(name, tokens);
                    const score = name === rawQuery ? 90 : nameHasAll ? 70 : 55;
                    results.push({ kind: 'flow', item: flow, score, matchedField: nameHasAll ? 'name' : 'transcript' });
                }
            });
        }
        if (active.has('set')) {
            (inv.imageSets || []).forEach(set => {
                const title = normalizeStr(set.title);
                if (matchAllTokens(title, tokens)) {
                    const score = title === rawQuery ? 85 : 50;
                    results.push({ kind: 'set', item: set, score, matchedField: 'title' });
                }
            });
        }
        if (active.has('sequence')) {
            (inv.sequences || []).forEach(seq => {
                const name = normalizeStr(seq.name);
                const stepTitles = normalizeStr((seq.steps || []).map(s => s && s.title).join(' '));
                if (matchAllTokens(`${name} ${stepTitles}`, tokens)) {
                    const nameHasAll = matchAllTokens(name, tokens);
                    const score = name === rawQuery ? 90 : nameHasAll ? 70 : 45;
                    results.push({ kind: 'sequence', item: seq, score, matchedField: nameHasAll ? 'name' : 'steps' });
                }
            });
        }

        const usage = getRecentUsageMap();
        results.forEach(r => { r.lastUsed = getUsageTimestamp(r.kind, getItemId(r.kind, r.item), usage); });
        results.sort((a, b) => (b.score - a.score) || (b.lastUsed - a.lastUsed));
        return results.slice(0, opts.limit || 8);
    }

    async function searchInventory(query, mode = 'all', opts = {}) {
        const inventory = opts.inventory || await getSearchableInventory();
        return scoreInventory(query, mode, inventory, opts);
    }

    // 7. Step Resolution + Data Fetcher
    //    Steps store { kind, refId, title, folder? }. The id is tried first, but because
    //    audio ids (autoIncrement) and pulled image-set ids differ between devices after a
    //    Bunny sync, title (+folder) is used as a fallback so synced sequences keep working.
    function resolveFromList(list, step, getId, getName, getFolder) {
        const idStr = String(step.refId === undefined || step.refId === null ? '' : step.refId);
        const title = norm(step.title);
        const folder = step.folder !== undefined && step.folder !== null ? norm(step.folder) : null;

        const byId = idStr ? (list.find(x => String(getId(x)) === idStr) || null) : null;
        if (byId && (!title || norm(getName(byId)) === title)) return byId;

        if (title) {
            let candidates = list.filter(x => norm(getName(x)) === title);
            if (folder && getFolder) {
                const inFolder = candidates.filter(x => norm(getFolder(x) || 'General') === folder);
                if (inFolder.length) candidates = inFolder;
            }
            if (candidates.length) return candidates[0];
        }
        return byId; // item was renamed but id still valid
    }

    function resolveStep(step, inventory) {
        if (!step || !inventory) return null;
        if (step.kind === 'audio') {
            const clip = resolveFromList(inventory.clips || [], step, c => c.id, c => c.name, c => c.folder);
            return clip && clip.blob ? clip : null;
        }
        if (step.kind === 'set') {
            const set = resolveFromList(inventory.imageSets || [], step, s => s.id, s => s.title);
            return set && Array.isArray(set.images) && set.images.some(i => i && i.blob) ? set : null;
        }
        if (step.kind === 'text') {
            const item = resolveFromList(inventory.textItems || [], step, t => t.id, t => t.title);
            return item && item.text ? item : null;
        }
        return null;
    }

    // Returns a ready-to-inject payload, or null when the item no longer exists.
    //   audio -> { kind, id, name, blob, transcript }
    //   set   -> { kind, id, title, images: [{ blob, type }] }
    //   text  -> { kind, id, title, text }
    async function fetchItemData(kind, refId, hint = {}) {
        const step = Object.assign({}, hint, { kind, refId });
        try {
            if (kind === 'audio') {
                const clip = resolveStep(step, { clips: await getClips() });
                return clip ? { kind, id: clip.id, name: clip.name || 'clip', blob: clip.blob, transcript: clip.transcript || '' } : null;
            }
            if (kind === 'set') {
                const set = resolveStep(step, { imageSets: await getImageSets() });
                if (!set) return null;
                const images = set.images.filter(i => i && i.blob).map(i => ({ blob: i.blob, type: i.type || i.blob.type || 'image/jpeg' }));
                return images.length ? { kind, id: set.id, title: set.title || 'Image set', images } : null;
            }
            if (kind === 'text') {
                const item = resolveStep(step, { textItems: getTextSnippets() });
                return item ? { kind, id: item.id, title: item.title || '', text: item.text } : null;
            }
        } catch (e) {
            console.error('[LegoCore] fetchItemData error:', e);
        }
        return null;
    }

    // 8. Global Sequence State
    let activeSequence = null;   // { id, name, steps: [...] }
    let sequenceStepIndex = 0;

    function normalizeSequence(input) {
        if (!input) return null;
        const steps = Array.isArray(input) ? input : (Array.isArray(input.steps) ? input.steps : null);
        if (!steps) return null;
        return {
            id: Array.isArray(input) ? null : (input.id || null),
            name: Array.isArray(input) ? 'Sequence' : (input.name || 'Sequence'),
            steps: steps.filter(s => s && s.kind).map(s => Object.assign({}, s))
        };
    }

    // Accepts a saved sequence object OR a raw steps array. Returns true if activated.
    function setActiveSequence(input) {
        const seq = normalizeSequence(input);
        if (!seq || !seq.steps.length) return false;
        if (activeSequence) {
            const previous = activeSequence;
            activeSequence = null; sequenceStepIndex = 0;
            emit('sequence:ended', { reason: 'replaced', sequence: previous });
        }
        activeSequence = seq;
        sequenceStepIndex = 0;
        if (seq.id) markUsed('sequence', seq.id);
        emit('sequence:started', { sequence: seq });
        return true;
    }

    function getActiveSequence() { return activeSequence; }
    function getSequenceStepIndex() { return sequenceStepIndex; }

    function setSequenceStepIndex(index) {
        if (!activeSequence) return;
        sequenceStepIndex = Math.max(0, Math.min(activeSequence.steps.length, index | 0));
        emit('sequence:step', { sequence: activeSequence, index: sequenceStepIndex });
    }

    function cancelSequence(reason = 'cancelled') {
        if (!activeSequence) return;
        const ended = activeSequence;
        activeSequence = null;
        sequenceStepIndex = 0;
        emit('sequence:ended', { reason, sequence: ended });
    }

    // 9. Block Registry
    const registeredBlocks = [];
    function registerBlock(block) { registeredBlocks.push(block); }
    function boot() {
        registeredBlocks.forEach(b => {
            try { b.init(api); } catch (e) { console.error('[LegoCore] Block init error:', b.id, e); }
        });
    }

    const api = {
        on, off, emit, registerBlock, boot,
        getDb: () => db, whenDbReady, getShortcutConfig, escapeHtml,
        // injection bridges
        injectClipToChat, injectImageToChat, injectImageSetToChat, injectTextToChat, getActiveChatZone,
        // drag helpers
        makeDraggable, makeIsolatedDraggable,
        // shared inventory + search
        getSearchableInventory, searchInventory, scoreInventory, parseSearchPrefix,
        normalizeStr, getSearchTokens, matchAllTokens, markUsed, getUsageTimestamp,
        // items + sequences data
        fetchItemData, resolveStep, getSequences, saveSequences,
        // sequence state
        setActiveSequence, getActiveSequence, getSequenceStepIndex, setSequenceStepIndex, cancelSequence
    };

    return api;
})();

/* ============================================================
   BLOCK: Quick Message Recorder (v1)
   ============================================================ */
/* ================================================================
   BLOCK: Audio Quick Record (Standalone Plugin)
   Handles the mini rapid-fire recorder, auto-trim, and auto-send.
================================================================ */
LegoCore.registerBlock({
  id: 'audioQuickRecord',
  init(core) {
    let quickMediaRecorder;
    let quickAudioChunks = [];
    let quickCurrentBlob = null;
    let isQuickRecording = false;

    const quickAutoTrimStartPref = localStorage.getItem('sb_quick_autotrim_start') === 'true';
    const quickAutoTrimEndPref = localStorage.getItem('sb_quick_autotrim_end') === 'true';
    const quickAutoSendPref = localStorage.getItem('sb_quick_autosend') === 'true';
    const quickSavedThreshold = localStorage.getItem('sb_quick_silence_threshold') || "0.035";
    const quickSavedLag = localStorage.getItem('sb_quick_trailing_lag') || "800";

    const quickUI = document.createElement('div');
    quickUI.style.cssText = 'display:flex; flex-direction:column; gap:8px; font-size:10px; color:#fff;';
    quickUI.innerHTML = `
      <div style="background:#18181b; padding:6px; border-radius:4px; display:flex; flex-direction:column; gap:6px; border:1px solid #334155;">
          <div style="display:flex; gap:6px; justify-content:space-between;">
              <label style="cursor:pointer; display:flex; align-items:center; gap:2px;"><input type="checkbox" id="sb-quick-trim-start-chk" ${quickAutoTrimStartPref ? 'checked' : ''}> Trim Start</label>
              <label style="cursor:pointer; display:flex; align-items:center; gap:2px;"><input type="checkbox" id="sb-quick-trim-end-chk" ${quickAutoTrimEndPref ? 'checked' : ''}> Trim End</label>
              <label style="cursor:pointer; color:#ffb703; display:flex; align-items:center; gap:2px;"><input type="checkbox" id="sb-quick-auto-send-chk" ${quickAutoSendPref ? 'checked' : ''}> Auto Send</label>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="color:#94a3b8;">Sensitivity:</span>
              <select id="sb-quick-threshold-select" style="background:#0f172a; color:#fff; border:1px solid #334155; border-radius:3px; padding:2px; font-size:9px;">
                  <option value="0.015">Low</option><option value="0.035" ${quickSavedThreshold === "0.035" ? 'selected' : ''}>Medium</option><option value="0.060" ${quickSavedThreshold === "0.060" ? 'selected' : ''}>High</option><option value="0.100" ${quickSavedThreshold === "0.100" ? 'selected' : ''}>Very High</option>
              </select>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="color:#94a3b8;">Delay (ms):</span>
              <input type="number" id="sb-quick-trailing-lag-input" value="${quickSavedLag}" step="100" style="width:50px; background:#0f172a; color:#fff; border:1px solid #334155; border-radius:3px; padding:2px; font-size:9px; text-align:center;">
          </div>
      </div>
      <button id="sb-quick-rec-btn" class="ig-base-btn" style="background:#0284c7; padding:8px; font-size:11px; width:100%; border:none; border-radius:4px; color:white; font-weight:bold; cursor:pointer;">🔴 Quick Record</button>
      <audio id="sb-quick-preview" controls style="width:100%; height:25px; display:none;"></audio>
      <div id="sb-quick-action-container" style="display:none; gap:4px;">
          <button id="sb-quick-send-btn" class="ig-base-btn" style="flex:1; background:#10b981; border:none; border-radius:4px; color:white; padding:6px; font-weight:bold; cursor:pointer;">📤 Send Now</button>
          <button id="sb-quick-delete-btn" class="ig-base-btn" style="width:30px; background:#dc2626; border:none; border-radius:4px; color:white; padding:6px; cursor:pointer;">🗑️</button>
      </div>
    `;

    function mountCards() {
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '💬 Quick Message', quickUI, '⠿', 'audio-quick');
      } else {
        setTimeout(mountCards, 200);
      }
    }
    mountCards();

    quickUI.querySelector('#sb-quick-trim-start-chk').onchange = e => localStorage.setItem('sb_quick_autotrim_start', e.target.checked);
    quickUI.querySelector('#sb-quick-trim-end-chk').onchange = e => localStorage.setItem('sb_quick_autotrim_end', e.target.checked);
    quickUI.querySelector('#sb-quick-auto-send-chk').onchange = e => localStorage.setItem('sb_quick_autosend', e.target.checked);
    quickUI.querySelector('#sb-quick-threshold-select').onchange = e => localStorage.setItem('sb_quick_silence_threshold', e.target.value);
    quickUI.querySelector('#sb-quick-trailing-lag-input').onchange = e => localStorage.setItem('sb_quick_trailing_lag', e.target.value);

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        quickMediaRecorder = new MediaRecorder(stream);
        quickMediaRecorder.ondataavailable = e => quickAudioChunks.push(e.data);
        quickMediaRecorder.onstop = async () => {
            quickCurrentBlob = new Blob(quickAudioChunks, { type: 'audio/mp4' });
            quickAudioChunks = [];
            const trimStart = quickUI.querySelector('#sb-quick-trim-start-chk').checked;
            const trimEnd = quickUI.querySelector('#sb-quick-trim-end-chk').checked;
            if (trimStart || trimEnd) {
                quickCurrentBlob = await detectAndTrimSilence(quickCurrentBlob, trimStart, trimEnd, quickUI.querySelector('#sb-quick-threshold-select').value);
            }
            showQuickActionControls();
        };
    }).catch(err => console.warn("Mic error:", err));

    const quickRecBtn = quickUI.querySelector('#sb-quick-rec-btn');
    quickRecBtn.onclick = () => {
        if (!quickMediaRecorder) return alert("Mic not initialized.");
        if (!isQuickRecording) {
            quickAudioChunks = [];
            quickUI.querySelector('#sb-quick-preview').style.display = "none";
            quickUI.querySelector('#sb-quick-action-container').style.display = "none";
            quickMediaRecorder.start();
            isQuickRecording = true;
            quickRecBtn.innerText = "⏹️ Stop Quick Rec";
            quickRecBtn.style.background = "#dc2626";
        } else {
            const lagMs = parseInt(quickUI.querySelector('#sb-quick-trailing-lag-input').value) || 800;
            quickRecBtn.innerText = "⏳ Finishing...";
            quickRecBtn.style.background = "#555";
            setTimeout(() => {
                if (quickMediaRecorder.state === "recording") quickMediaRecorder.stop();
                isQuickRecording = false;
                quickRecBtn.innerText = "🔴 Quick Record";
                quickRecBtn.style.background = "#0284c7";
            }, lagMs);
        }
    };

    function showQuickActionControls() {
        const preview = quickUI.querySelector('#sb-quick-preview');
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(quickCurrentBlob);
        preview.style.display = "block";
        quickUI.querySelector('#sb-quick-action-container').style.display = "flex";
        if (quickUI.querySelector('#sb-quick-auto-send-chk').checked) {
            core.injectClipToChat(quickCurrentBlob, "quick_audio");
        }
    }

    quickUI.querySelector('#sb-quick-send-btn').onclick = () => { if (quickCurrentBlob) core.injectClipToChat(quickCurrentBlob, "quick_audio"); };
    quickUI.querySelector('#sb-quick-delete-btn').onclick = () => {
        quickCurrentBlob = null; quickUI.querySelector('#sb-quick-preview').style.display = "none"; quickUI.querySelector('#sb-quick-action-container').style.display = "none";
    };

    async function detectAndTrimSilence(blob, cutStart, cutEnd, customThreshold) {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
            const channelData = audioBuffer.getChannelData(0);
            const sr = audioBuffer.sampleRate;
            const threshold = parseFloat(customThreshold) || 0.035;
            let startIdx = 0, endIdx = channelData.length;
            if (cutStart) { for (let i = 0; i < channelData.length; i++) { if (Math.abs(channelData[i]) > threshold) { startIdx = Math.max(0, i - Math.floor(sr * 0.05)); break; } } }
            if (cutEnd) { for (let i = channelData.length - 1; i >= 0; i--) { if (Math.abs(channelData[i]) > threshold) { endIdx = Math.min(channelData.length, i + Math.floor(sr * 0.15)); break; } } }
            if (startIdx >= endIdx) return blob;
            const trimmed = audioCtx.createBuffer(audioBuffer.numberOfChannels, endIdx - startIdx, sr);
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) trimmed.getChannelData(c).set(audioBuffer.getChannelData(c).subarray(startIdx, endIdx));
            return new Blob([audioBufferToWav(trimmed)], { type: 'audio/mp4' });
        } catch (e) { return blob; }
    }

    function audioBufferToWav(buffer) {
        const numChannels = buffer.numberOfChannels, sr = buffer.sampleRate, format = 1, bitDepth = 16;
        const result = numChannels === 2 ? (function(l, r){ const res = new Float32Array(l.length + r.length); for(let i=0, j=0; i<l.length; i++){ res[j++] = l[i]; res[j++] = r[i]; } return res; })(buffer.getChannelData(0), buffer.getChannelData(1)) : buffer.getChannelData(0);
        const dataLength = result.length * (bitDepth / 8);
        const wav = new Uint8Array(44 + dataLength);
        const view = new DataView(wav.buffer);
        const ws = (v, o, s) => { for(let i=0; i<s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        ws(view, 0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
        ws(view, 8, 'WAVE'); ws(view, 12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, format, true);
        view.setUint16(22, numChannels, true); view.setUint32(24, sr, true);
        view.setUint32(28, sr * numChannels * (bitDepth / 8), true);
        view.setUint16(32, numChannels * (bitDepth / 8), true);
        view.setUint16(34, bitDepth, true); ws(view, 36, 'data');
        view.setUint32(40, dataLength, true);
        for (let i = 0, offset = 44; i < result.length; i++, offset += 2) {
            let s = Math.max(-1, Math.min(1, result[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return wav;
    }

    core.emit('block:ready', { id: 'audioQuickRecord' });
  }
});

/* ============================================================
   BLOCK: Sidebar Plugin Manager (v1)
   ============================================================ */
/* ================================================================
   BLOCK: Sidebar Plugin Manager (Layout Registry)
   Provides a universal helper (LegoCore.registerMenu) so any future
   module can instantly plug its UI into your left or right sidebar.

   PATCHED:
   - Cards now get a data-key, so drag-reorder position persists
   - Re-registering the same key replaces the old card instead of
     stacking duplicates
   - Waits/retries for the sidebar container instead of silently
     dumping into document.body
   - Removed inline style overrides so plugin cards match the
     refined preset-card look exactly
================================================================ */
LegoCore.registerBlock({
  id: 'sidebarPluginManager',
  init(core) {
    function slugify(str) {
      return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'menu';
    }

    core.registerMenu = function (targetSide, title, contentElement, iconHTML = '⠿', menuKey = null) {
      const containerId = targetSide === 'right' ? 'ig-right-menu-container' : 'ig-left-menu-container';
      const key = menuKey || ('plugin-' + slugify(title));

      function mount(attemptsLeft) {
        const container = document.getElementById(containerId);

        if (!container) {
          if (attemptsLeft <= 0) {
            console.warn('[SidebarPluginManager] Could not find "' + containerId + '" -- the UI Module may not be loaded. Menu "' + title + '" was not mounted.');
            return;
          }
          setTimeout(() => mount(attemptsLeft - 1), 200);
          return;
        }

        // Re-registering the same key replaces the old card instead of stacking a duplicate
        const existing = container.querySelector('[data-key="' + key + '"]');
        if (existing) existing.remove();

        const card = document.createElement('div');
        card.className = 'ig-draggable-menu';
        card.dataset.key = key;
        card.innerHTML = `
          <div class="ig-menu-header">
            <span>${title}</span>
            <span class="ig-drag-handle">${iconHTML}</span>
          </div>
          <div class="ig-menu-content"></div>
        `;
        card.querySelector('.ig-menu-content').appendChild(contentElement);
        container.appendChild(card);
      }

      mount(10); // retry for up to ~2s if the UI Module hasn't built its containers yet
    };

    console.log('[SidebarPluginManager] Registry initialized. Ready for plugins.');
    core.emit('block:ready', { id: 'sidebarPluginManager' });
  }
});

/* ============================================================
   BLOCK: Recorder Studio (v1)
   ============================================================ */
/* ================================================================
   BLOCK: Audio Recorder Studio (Standalone Plugin)
   Handles main recording, shortcuts, stitching logic, and saves to DB.
================================================================ */
LegoCore.registerBlock({
  id: 'audioRecorderStudio',
  init(core) {
    let db;
    let mediaRecorder;
    let audioChunks = [];
    let currentBlob = null;
    let originalBlobBackup = null;
    let selectedForStitchId = null;
    let isRecording = false;
    let selectedColorTag = "#0095f6";

    const request = indexedDB.open('IG_Soundboard_Fresh_Core_DB', 2);
    request.onerror = e => console.error("DB Error:", e);
    request.onupgradeneeded = e => {
      db = e.target.result;
      if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'id', autoIncrement: true }).createIndex('order', 'order', { unique: false });
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'name' }).put({ name: "General" });
    };
    request.onsuccess = e => {
      db = e.target.result;
      loadFolders();
    };

    const autoTrimStartPref = localStorage.getItem('sb_autotrim_start') === 'true';
    const autoTrimEndPref = localStorage.getItem('sb_autotrim_end') === 'true';
    const autoSendPref = localStorage.getItem('sb_autosend') === 'true';
    const savedThreshold = localStorage.getItem('sb_silence_threshold') || "0.035";
    const savedLag = localStorage.getItem('sb_trailing_lag') || "800";

    const getShortcutConfig = (action, defaultKey, defaultMod) => {
      return { key: localStorage.getItem(`sb_sc_${action}_key`) || defaultKey, mod: localStorage.getItem(`sb_sc_${action}_mod`) || defaultMod };
    };
    const scRec = getShortcutConfig('rec', 'r', 'ctrl'), scSend = getShortcutConfig('send', 's', 'ctrl'), scPlay = getShortcutConfig('play', 'p', 'ctrl');

    const recUI = document.createElement('div');
    recUI.style.cssText = 'display:flex; flex-direction:column; gap:8px; font-size:10px; color:#fff;';
    recUI.innerHTML = `
      <div id="sb-stitch-banner" style="display:none; background:#005f73; padding:6px; border-radius:4px; font-weight:bold; justify-content:space-between; align-items:center;">
          <span id="sb-stitch-text">🔗 Chained: None</span>
          <button id="sb-undo-stitch" style="background:#9d0208; border:none; color:#fff; padding:2px 4px; border-radius:3px; cursor:pointer;">Undo</button>
      </div>
      <div style="background:#18181b; padding:6px; border-radius:4px; display:flex; flex-direction:column; gap:6px; border:1px solid #334155;">
          <div style="display:flex; gap:6px; justify-content:space-between;">
              <label style="cursor:pointer; display:flex; align-items:center; gap:2px;"><input type="checkbox" id="sb-auto-trim-start-chk" ${autoTrimStartPref ? 'checked' : ''}> Cut Start</label>
              <label style="cursor:pointer; display:flex; align-items:center; gap:2px;"><input type="checkbox" id="sb-auto-trim-end-chk" ${autoTrimEndPref ? 'checked' : ''}> Cut End</label>
              <label style="cursor:pointer; color:#ffb703; display:flex; align-items:center; gap:2px;"><input type="checkbox" id="sb-auto-send-chk" ${autoSendPref ? 'checked' : ''}> Auto Send</label>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="color:#94a3b8;">Sensitivity:</span>
              <select id="sb-threshold-select" style="background:#0f172a; color:#fff; border:1px solid #334155; border-radius:3px; padding:2px; font-size:9px;">
                  <option value="0.015">Low</option><option value="0.035" ${savedThreshold === "0.035" ? 'selected' : ''}>Medium</option><option value="0.060" ${savedThreshold === "0.060" ? 'selected' : ''}>High</option><option value="0.100" ${savedThreshold === "0.100" ? 'selected' : ''}>Very High</option>
              </select>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="color:#94a3b8;">Delay (ms):</span>
              <input type="number" id="sb-trailing-lag-input" value="${savedLag}" step="100" style="width:50px; background:#0f172a; color:#fff; border:1px solid #334155; border-radius:3px; padding:2px; font-size:9px; text-align:center;">
          </div>
      </div>
      <div style="display:flex; gap:4px;">
          <button id="sb-rec-btn" class="ig-base-btn" style="flex:1; background:#0284c7; border:none; border-radius:4px; color:white; padding:8px; font-weight:bold; cursor:pointer;">🔴 Record Intro</button>
          <button id="sb-upload-btn" class="ig-base-btn" style="width:30px; background:#334155; border:none; border-radius:4px; color:white; cursor:pointer;">📂</button>
          <button id="sb-open-sc-btn" class="ig-base-btn" style="width:30px; background:#334155; border:none; border-radius:4px; color:white; cursor:pointer;">⚙️</button>
          <input type="file" id="sb-file-input" accept="audio/*" style="display:none;">
      </div>
      <audio id="sb-preview" controls style="width:100%; height:25px; display:none;"></audio>
      <div id="sb-action-container" style="display:none; flex-direction:column; gap:6px; background:#18181b; padding:6px; border-radius:4px; border:1px solid #334155;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
              <button id="sb-undo-trim-btn" style="display:none; background:#43281c; color:#ffb703; border:none; border-radius:3px; padding:2px 4px; font-size:9px; cursor:pointer;">↩️ Undo Trim</button>
          </div>
          <div style="display:flex; gap:4px;">
              <button id="sb-send-chat-btn" class="ig-base-btn" style="flex:1; background:#0284c7; border:none; border-radius:4px; color:white; padding:6px; font-weight:bold; cursor:pointer;">📤 Send Intro</button>
              <button id="sb-send-stitched-btn" class="ig-base-btn" style="flex:1; background:#2a9d8f; display:none; border:none; border-radius:4px; color:white; padding:6px; font-weight:bold; cursor:pointer;">✨ Send Chained</button>
              <button id="sb-delete-rec-btn" class="ig-base-btn" style="width:30px; background:#dc2626; border:none; border-radius:4px; color:white; cursor:pointer;">🗑️</button>
          </div>
          <div style="display:flex; gap:4px;">
              <input type="text" id="sb-name-input" placeholder="Clip name..." style="flex:1; background:#0f172a; color:#fff; border:1px solid #334155; border-radius:3px; padding:4px; font-size:10px;">
              <select id="sb-folder-select" style="width:70px; background:#0f172a; color:#fff; border:1px solid #334155; border-radius:3px; padding:4px; font-size:10px;"></select>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:4px; border-radius:3px;">
              <span style="color:#94a3b8; font-size:9px;">Tag Color:</span>
              <div style="display:flex; gap:4px;" id="sb-color-picker">
                  <div class="sb-color-dot" data-color="#0095f6" style="width:14px; height:14px; border-radius:50%; background:#0095f6; cursor:pointer; border:2px solid #fff;"></div>
                  <div class="sb-color-dot" data-color="#2e7d32" style="width:14px; height:14px; border-radius:50%; background:#2e7d32; cursor:pointer; border:2px solid transparent;"></div>
                  <div class="sb-color-dot" data-color="#f77f00" style="width:14px; height:14px; border-radius:50%; background:#f77f00; cursor:pointer; border:2px solid transparent;"></div>
                  <div class="sb-color-dot" data-color="#9d0208" style="width:14px; height:14px; border-radius:50%; background:#9d0208; cursor:pointer; border:2px solid transparent;"></div>
                  <div class="sb-color-dot" data-color="#7209b7" style="width:14px; height:14px; border-radius:50%; background:#7209b7; cursor:pointer; border:2px solid transparent;"></div>
              </div>
          </div>
          <button id="sb-save-btn" class="ig-base-btn" style="background:#334155; border:none; border-radius:4px; color:white; padding:6px; font-weight:bold; cursor:pointer;">💾 Save to Library</button>
      </div>
    `;

    function mountCards() {
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '🔴 Recorder Studio', recUI, '⠿', 'audio-rec');
      } else {
        setTimeout(mountCards, 200);
      }
    }
    mountCards();

    // Event Bus Triggers from Library Block
    core.on('folders:refresh', () => loadFolders());
    core.on('stitch:select', async data => {
        selectedForStitchId = data.id;
        recUI.querySelector('#sb-stitch-text').innerText = `🔗 Chained: ${data.name}`;
        recUI.querySelector('#sb-stitch-banner').style.display = "flex";
        if (currentBlob) await showActionControls(recUI.querySelector('#sb-name-input').value);
    });

    const scModal = document.createElement('div');
    scModal.style.cssText = "display:none; position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); z-index:2147483647; background:#0f172a; color:#fff; padding:16px; border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,0.6); width:300px; font-family:-apple-system, sans-serif; border:1px solid #334155;";
    const modOptions = `<option value="ctrl">Ctrl</option><option value="shift">Shift</option><option value="alt">Alt</option><option value="ctrl+shift">Ctrl+Shift</option><option value="ctrl+alt">Ctrl+Alt</option><option value="shift+alt">Shift+Alt</option><option value="none">None</option>`;
    scModal.innerHTML = `
        <div style="font-size:14px; font-weight:bold; margin-bottom:12px; display:flex; justify-content:space-between;">
            <span>⌨️ Shortcuts Manager</span>
            <button id="sb-close-sc-modal" style="background:none; border:none; color:#aaa; cursor:pointer;">✕</button>
        </div>
        <div style="display:flex; flex-direction:column; gap:8px; font-size:11px;">
            <div style="display:flex; justify-content:space-between;"><span>Record:</span><div style="display:flex; gap:4px;"><select id="sb-mod-rec" style="background:#1e293b; color:#fff; border:1px solid #334155;">${modOptions}</select><input type="text" id="sb-key-rec" value="${scRec.key}" maxlength="4" style="width:30px; text-align:center; background:#1e293b; color:#fff; border:1px solid #334155;"></div></div>
            <div style="display:flex; justify-content:space-between;"><span>Send:</span><div style="display:flex; gap:4px;"><select id="sb-mod-send" style="background:#1e293b; color:#fff; border:1px solid #334155;">${modOptions}</select><input type="text" id="sb-key-send" value="${scSend.key}" maxlength="4" style="width:30px; text-align:center; background:#1e293b; color:#fff; border:1px solid #334155;"></div></div>
            <div style="display:flex; justify-content:space-between;"><span>Play:</span><div style="display:flex; gap:4px;"><select id="sb-mod-play" style="background:#1e293b; color:#fff; border:1px solid #334155;">${modOptions}</select><input type="text" id="sb-key-play" value="${scPlay.key}" maxlength="4" style="width:30px; text-align:center; background:#1e293b; color:#fff; border:1px solid #334155;"></div></div>
        </div>
        <button id="sb-save-shortcuts" class="ig-base-btn" style="width:100%; margin-top:12px; background:#0284c7; border:none; padding:6px; color:white; border-radius:4px; cursor:pointer; font-weight:bold;">Save Shortcuts</button>
    `;
    document.body.appendChild(scModal);

    document.getElementById('sb-mod-rec').value = scRec.mod;
    document.getElementById('sb-mod-send').value = scSend.mod;
    document.getElementById('sb-mod-play').value = scPlay.mod;
    recUI.querySelector('#sb-open-sc-btn').onclick = () => scModal.style.display = "block";
    scModal.querySelector('#sb-close-sc-modal').onclick = () => scModal.style.display = "none";
    scModal.querySelector('#sb-save-shortcuts').onclick = () => {
        localStorage.setItem('sb_sc_rec_mod', document.getElementById('sb-mod-rec').value);
        localStorage.setItem('sb_sc_rec_key', document.getElementById('sb-key-rec').value.toLowerCase());
        localStorage.setItem('sb_sc_send_mod', document.getElementById('sb-mod-send').value);
        localStorage.setItem('sb_sc_send_key', document.getElementById('sb-key-send').value.toLowerCase());
        localStorage.setItem('sb_sc_play_mod', document.getElementById('sb-mod-play').value);
        localStorage.setItem('sb_sc_play_key', document.getElementById('sb-key-play').value.toLowerCase());
        scModal.style.display = "none";
        alert("Shortcuts updated!");
    };

    recUI.querySelector('#sb-auto-trim-start-chk').onchange = e => localStorage.setItem('sb_autotrim_start', e.target.checked);
    recUI.querySelector('#sb-auto-trim-end-chk').onchange = e => localStorage.setItem('sb_autotrim_end', e.target.checked);
    recUI.querySelector('#sb-auto-send-chk').onchange = e => localStorage.setItem('sb_autosend', e.target.checked);
    recUI.querySelector('#sb-threshold-select').onchange = e => localStorage.setItem('sb_silence_threshold', e.target.value);
    recUI.querySelector('#sb-trailing-lag-input').onchange = e => localStorage.setItem('sb_trailing_lag', e.target.value);

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            currentBlob = new Blob(audioChunks, { type: 'audio/mp4' });
            audioChunks = [];
            originalBlobBackup = currentBlob;
            const trimStart = recUI.querySelector('#sb-auto-trim-start-chk').checked;
            const trimEnd = recUI.querySelector('#sb-auto-trim-end-chk').checked;
            if (trimStart || trimEnd) {
                currentBlob = await detectAndTrimSilence(currentBlob, trimStart, trimEnd, recUI.querySelector('#sb-threshold-select').value);
                recUI.querySelector('#sb-undo-trim-btn').style.display = "inline-block";
            }
            await showActionControls("voice_note");
        };
    }).catch(err => console.warn("Mic error:", err));

    const recBtn = recUI.querySelector('#sb-rec-btn');
    function triggerRecordingToggle() {
        if (!mediaRecorder) return alert("Mic not initialized.");
        if (!isRecording) {
            audioChunks = [];
            recUI.querySelector('#sb-preview').style.display = "none";
            recUI.querySelector('#sb-action-container').style.display = "none";
            mediaRecorder.start();
            isRecording = true;
            recBtn.innerText = "⏹️ Stop Recording";
            recBtn.style.background = "#dc2626";
        } else {
            const lagMs = parseInt(recUI.querySelector('#sb-trailing-lag-input').value) || 800;
            recBtn.innerText = "⏳ Finishing...";
            recBtn.style.background = "#555";
            setTimeout(() => {
                if (mediaRecorder.state === "recording") mediaRecorder.stop();
                isRecording = false;
                recBtn.innerText = "🔴 Record Intro";
                recBtn.style.background = "#0284c7";
            }, lagMs);
        }
    }
    recBtn.onclick = triggerRecordingToggle;

    async function showActionControls(defaultName) {
        recUI.querySelector('#sb-name-input').value = defaultName;
        const preview = recUI.querySelector('#sb-preview');
        let playbackBlob = currentBlob;
        const sendChatBtn = recUI.querySelector('#sb-send-chat-btn');
        const stitchBtn = recUI.querySelector('#sb-send-stitched-btn');

        if (selectedForStitchId) {
            const pitchObj = await getPitchClip(selectedForStitchId);
            if (pitchObj && pitchObj.blob) {
                let trimmedPitch = pitchObj.blob;
                if (pitchObj.trimStart || pitchObj.trimEnd) {
                    trimmedPitch = await trimAudioBlobByMs(pitchObj.blob, pitchObj.trimStart || 0, pitchObj.trimEnd || 0);
                }
                playbackBlob = await mergeAudioBlobs(currentBlob, trimmedPitch);
            }
            sendChatBtn.style.display = "none";
            stitchBtn.style.display = "block";
        } else {
            sendChatBtn.style.display = "block";
            stitchBtn.style.display = "none";
        }

        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(playbackBlob);
        preview.style.display = "block";
        recUI.querySelector('#sb-action-container').style.display = "flex";
    }

    async function getPitchClip(id) {
        return new Promise(resolve => {
            const tx = db.transaction(['clips'], 'readonly');
            const req = tx.objectStore('clips').get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    }

    recUI.querySelector('#sb-undo-trim-btn').onclick = async () => {
        if (!originalBlobBackup) return;
        currentBlob = originalBlobBackup;
        recUI.querySelector('#sb-undo-trim-btn').style.display = "none";
        await showActionControls(recUI.querySelector('#sb-name-input').value);
    };

    recUI.querySelector('#sb-send-chat-btn').onclick = () => {
        if (currentBlob) core.injectClipToChat(currentBlob, recUI.querySelector('#sb-name-input').value.trim() || "voice_note");
    };

    recUI.querySelector('#sb-send-stitched-btn').onclick = async () => {
        if (!currentBlob || !selectedForStitchId) return;
        const pitchObj = await getPitchClip(selectedForStitchId);
        let trimmedPitch = pitchObj.blob;
        if (pitchObj.trimStart || pitchObj.trimEnd) {
            trimmedPitch = await trimAudioBlobByMs(pitchObj.blob, pitchObj.trimStart || 0, pitchObj.trimEnd || 0);
        }
        core.injectClipToChat(await mergeAudioBlobs(currentBlob, trimmedPitch), recUI.querySelector('#sb-name-input').value.trim() || "pitch");
    };

    recUI.querySelector('#sb-delete-rec-btn').onclick = () => {
        currentBlob = originalBlobBackup = null;
        recUI.querySelector('#sb-preview').style.display = "none";
        recUI.querySelector('#sb-action-container').style.display = "none";
    };

    recUI.querySelector('#sb-undo-stitch').onclick = async () => {
        selectedForStitchId = null;
        recUI.querySelector('#sb-stitch-banner').style.display = "none";
        if (currentBlob) await showActionControls(recUI.querySelector('#sb-name-input').value);
    };

    // Audio Processors
    async function detectAndTrimSilence(blob, cutStart, cutEnd, customThreshold) {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
            const channelData = audioBuffer.getChannelData(0);
            const sr = audioBuffer.sampleRate;
            const threshold = parseFloat(customThreshold) || 0.035;
            let startIdx = 0, endIdx = channelData.length;

            if (cutStart) { for (let i = 0; i < channelData.length; i++) { if (Math.abs(channelData[i]) > threshold) { startIdx = Math.max(0, i - Math.floor(sr * 0.05)); break; } } }
            if (cutEnd) { for (let i = channelData.length - 1; i >= 0; i--) { if (Math.abs(channelData[i]) > threshold) { endIdx = Math.min(channelData.length, i + Math.floor(sr * 0.15)); break; } } }
            if (startIdx >= endIdx) return blob;
            const trimmed = audioCtx.createBuffer(audioBuffer.numberOfChannels, endIdx - startIdx, sr);
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) trimmed.getChannelData(c).set(audioBuffer.getChannelData(c).subarray(startIdx, endIdx));
            return new Blob([audioBufferToWav(trimmed)], { type: 'audio/mp4' });
        } catch (e) { return blob; }
    }

    async function trimAudioBlobByMs(blob, startMs, endMs) {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
            const sr = audioBuffer.sampleRate;
            const start = Math.max(0, Math.floor((startMs / 1000) * sr));
            const end = Math.max(start + 1, audioBuffer.length - Math.floor((endMs / 1000) * sr));
            const trimmed = audioCtx.createBuffer(audioBuffer.numberOfChannels, end - start, sr);
            for (let c = 0; c < audioBuffer.numberOfChannels; c++) trimmed.getChannelData(c).set(audioBuffer.getChannelData(c).subarray(start, end));
            return new Blob([audioBufferToWav(trimmed)], { type: 'audio/mp4' });
        } catch (e) { return blob; }
    }

    async function mergeAudioBlobs(b1, b2) {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const buf1 = await audioCtx.decodeAudioData(await b1.arrayBuffer());
            const buf2 = await audioCtx.decodeAudioData(await b2.arrayBuffer());
            const sr = buf1.sampleRate;
            const channels = Math.max(buf1.numberOfChannels, buf2.numberOfChannels);
            const merged = audioCtx.createBuffer(channels, buf1.length + buf2.length, sr);
            for (let c = 0; c < channels; c++) {
                const out = merged.getChannelData(c);
                out.set(buf1.getChannelData(c < buf1.numberOfChannels ? c : 0), 0);
                out.set(buf2.getChannelData(c < buf2.numberOfChannels ? c : 0), buf1.length);
            }
            return new Blob([audioBufferToWav(merged)], { type: 'audio/mp4' });
        } catch (e) { return new Blob([b1, b2], { type: 'audio/mp4' }); }
    }

    function audioBufferToWav(buffer) {
        const numChannels = buffer.numberOfChannels, sr = buffer.sampleRate, format = 1, bitDepth = 16;
        const result = numChannels === 2 ? (function(l, r){ const res = new Float32Array(l.length + r.length); for(let i=0, j=0; i<l.length; i++){ res[j++] = l[i]; res[j++] = r[i]; } return res; })(buffer.getChannelData(0), buffer.getChannelData(1)) : buffer.getChannelData(0);
        const dataLength = result.length * (bitDepth / 8);
        const wav = new Uint8Array(44 + dataLength);
        const view = new DataView(wav.buffer);
        const ws = (v, o, s) => { for(let i=0; i<s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        ws(view, 0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
        ws(view, 8, 'WAVE'); ws(view, 12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, format, true);
        view.setUint16(22, numChannels, true); view.setUint32(24, sr, true);
        view.setUint32(28, sr * numChannels * (bitDepth / 8), true);
        view.setUint16(32, numChannels * (bitDepth / 8), true);
        view.setUint16(34, bitDepth, true); ws(view, 36, 'data');
        view.setUint32(40, dataLength, true);
        for (let i = 0, offset = 44; i < result.length; i++, offset += 2) {
            let s = Math.max(-1, Math.min(1, result[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return wav;
    }

    // Global Hotkeys
    document.addEventListener('keydown', e => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && document.activeElement.id !== 'sb-name-input') return;
        const checkMatch = (action) => {
            const cfg = getShortcutConfig(action, '', 'ctrl');
            if (!cfg.key) return false;
            const targetKey = cfg.key.toLowerCase(), eventKey = e.key.toLowerCase(), eventCode = e.code.toLowerCase();
            if (eventKey !== targetKey && eventCode !== targetKey) return false;
            const mod = cfg.mod, hasCtrl = e.ctrlKey, hasShift = e.shiftKey, hasAlt = e.altKey;
            if (mod === 'ctrl' && (!hasCtrl || hasShift || hasAlt)) return false;
            if (mod === 'shift' && (!hasShift || hasCtrl || hasAlt)) return false;
            if (mod === 'alt' && (!hasAlt || hasCtrl || hasShift)) return false;
            if (mod === 'ctrl+shift' && (!hasCtrl || !hasShift || hasAlt)) return false;
            if (mod === 'ctrl+alt' && (!hasCtrl || !hasAlt || hasShift)) return false;
            if (mod === 'shift+alt' && (!hasShift || !hasAlt || hasCtrl)) return false;
            if (mod === 'none' && (hasCtrl || hasShift || hasAlt)) return false;
            return true;
        };

        if (checkMatch('rec')) { e.preventDefault(); triggerRecordingToggle(); }
        else if (checkMatch('send') && currentBlob) { e.preventDefault(); core.injectClipToChat(currentBlob, recUI.querySelector('#sb-name-input').value.trim() || "voice_note"); }
        else if (checkMatch('play')) {
            e.preventDefault();
            const preview = recUI.querySelector('#sb-preview');
            if (preview.style.display !== "none") { if (preview.paused) preview.play(); else preview.pause(); }
        }
    });

    const fileInput = recUI.querySelector('#sb-file-input');
    recUI.querySelector('#sb-upload-btn').onclick = () => fileInput.click();
    fileInput.onchange = async e => {
        const file = e.target.files[0];
        if (!file) return;
        currentBlob = new Blob([file], { type: 'audio/mp4' });
        originalBlobBackup = currentBlob;
        await showActionControls(file.name.replace(/\.[^/.]+$/, ""));
        fileInput.value = "";
    };

    recUI.querySelectorAll('.sb-color-dot').forEach(dot => {
        dot.onclick = e => {
            recUI.querySelectorAll('.sb-color-dot').forEach(d => d.style.border = "2px solid transparent");
            e.target.style.border = "2px solid #fff";
            selectedColorTag = e.target.getAttribute('data-color');
        };
    });

    recUI.querySelector('#sb-save-btn').onclick = () => {
        const name = recUI.querySelector('#sb-name-input').value.trim() || `clip_${Date.now()}`;
        const folder = recUI.querySelector('#sb-folder-select').value || "General";
        if (!currentBlob) return;
        const tx = db.transaction(['clips'], 'readwrite');
        const store = tx.objectStore('clips');
        const countReq = store.count();
        countReq.onsuccess = () => { store.add({ name, folder, color: selectedColorTag, order: countReq.result, blob: currentBlob }); };
        tx.oncomplete = () => {
            recUI.querySelector('#sb-name-input').value = "";
            recUI.querySelector('#sb-action-container').style.display = "none";
            recUI.querySelector('#sb-preview').style.display = "none";
            core.emit('library:refresh'); // Sync with library
        };
    };

    function loadFolders() {
        if (!db) return;
        const fSelect = recUI.querySelector('#sb-folder-select');
        const curFolder = fSelect.value || "General";
        fSelect.innerHTML = "";
        const tx = db.transaction(['folders'], 'readonly');
        tx.objectStore('folders').openCursor().onsuccess = e => {
            const cursor = e.target.result;
            if (cursor) {
                fSelect.add(new Option(cursor.value.name, cursor.value.name));
                cursor.continue();
            } else {
                fSelect.value = curFolder;
            }
        };
    }

    core.emit('block:ready', { id: 'audioRecorderStudio' });
  }
});

/* ============================================================
   BLOCK: Audio Library (v2)
   ============================================================ */
/* ============================================================
   BLOCK: Audio Library (v13 - Hash-Colored Course Tags & Tooltip Fix)
   ============================================================ */
LegoCore.registerBlock({
  id: 'audioLibrary',
  init(core) {
    let db;
    let activeFolderFilter = 'All';
    let activeTagFilter = 'All';
    let collapsedFolders = new Set();
    let searchTerm = '';
    const COL_PREF_KEY = 'ig_audio_lib_col_width_v1';
    let colWidths = JSON.parse(localStorage.getItem(COL_PREF_KEY)) || { nameWidth: 60 };

    // --- DB Helper to prevent concurrent connection deadlocks ---
    function withDb(cb) {
      const existing = core.getDb();
      if (existing) { cb(existing); return; }
      core.on('db:ready', d => cb(d));
    }

    withDb(database => {
      db = database;
      loadFolders();
      renderClips();
    });

    // --- RAM-Safe Fetcher: Only pull heavy Blobs when explicitly needed ---
    function getClipBlob(id) {
        return new Promise(resolve => {
            withDb(d => {
                const tx = d.transaction(['clips'], 'readonly');
                tx.objectStore('clips').get(id).onsuccess = e => {
                    resolve(e.target.result ? e.target.result.blob : null);
                };
            });
        });
    }

    // --- Global Transcript Tooltip ---
    let txTooltip = document.getElementById('ig-audio-tx-tooltip');
    if (!txTooltip) {
        txTooltip = document.createElement('div');
        txTooltip.id = 'ig-audio-tx-tooltip';
        txTooltip.className = 'ig-audio-tx-tooltip';
        document.body.appendChild(txTooltip);
    }

    // --- HTML Escaper & Pipeline Formatter ---
    function safeHTML(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // String Hash Function for consistent random colors
    function getHashColor(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = Math.abs(hash % 360);
        return `hsl(${hue}, 65%, 45%)`;
    }

    function formatPipelineName(rawName) {
        // Regex: 1. Matches starting number 2. Matches separators 3. Optional (coursename) 4. Matches separators 5. The rest
        const match = rawName.match(/^(\d+)([\s\-\.]*)(?:\(([^)]+)\))?([\s\-\.]*)(.*)$/);
        if (!match) return safeHTML(rawName);

        const numStr = match[1];
        const num = parseInt(numStr, 10);
        const sep1 = match[2] || '';
        const courseName = match[3];
        const sep2 = match[4] || '';
        const rest = match[5] || '';

        // 🎨 Colors come from the Tag Colors block (falls back to the old colors if it's missing)
        const tc = core.tagColors;
        const bg = tc ? tc.getNumberColor(numStr)
          : num === 1 ? '#10b981' : num === 2 ? '#ef4444' : num === 3 ? '#f59e0b' : num === 4 ? '#8b5cf6' : num >= 5 ? '#3b82f6' : '#64748b';
        const fg = tc ? tc.getTextColor(bg) : '#fff';

        let html = `<span class="ig-pipeline-badge" style="background:${bg}; color:${fg};">${numStr}</span>`;

        // Add course tag if detected
        if (courseName) {
            const tagColor = tc ? tc.getCourseColor(courseName) : getHashColor(courseName.toLowerCase().trim());
            const tagFg = tc ? tc.getTextColor(tagColor) : '#fff';
            html += `<span class="ig-course-badge" style="background:${tagColor}; color:${tagFg};">(${safeHTML(courseName.trim())})</span>`;
            html += `<span>${safeHTML(sep2 + rest)}</span>`;
        } else {
            html += `<span>${safeHTML(sep1 + rest)}</span>`;
        }

        return html;
    }

    const style = document.createElement('style');
    style.id = 'ig-audio-lib-v13-styles';
    style.innerHTML = `
      .ig-audio-lib-wrap { display: flex; flex-direction: column; gap: 8px; font-size: 11px; flex: 1; min-height: 0; }
      .ig-audio-lib-header { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
      .ig-audio-lib-header span { font-weight: bold; opacity: 0.8; }
      .ig-audio-lib-new-btn { background: none; border: none; color: var(--ig-accent, #0095f6); cursor: pointer; font-weight: bold; font-size: 10px; }
      .ig-audio-search { width: 100%; box-sizing: border-box; padding: 7px 8px; border-radius: 6px; border: 1px solid var(--ig-border, #333); background: var(--ig-input-bg, #111); color: #fff; font-size: 11px; font-weight: bold; outline: none; transition: border 0.2s; }
      .ig-audio-search:focus { border-color: var(--igls-accent, #c9a876); }
      .ig-audio-lib-filters { display: flex; gap: 6px; }
      .ig-audio-lib-filters select { flex: 1; padding: 6px; border-radius: 6px; border: 1px solid var(--ig-border, #333); background: var(--ig-input-bg, #111); color: inherit; font-size: 10px; cursor: pointer; }
      .ig-audio-lib-tree { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0; padding-right: 2px; }
      .ig-audio-lib-tree::-webkit-scrollbar { width: 4px; }
      .ig-audio-lib-tree::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
      .ig-audio-folder-header { display: flex; align-items: center; gap: 6px; font-weight: bold; font-size: 11px; color: #94a3b8; padding: 8px 6px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.05); cursor: grab; user-select: none; }
      .ig-audio-folder-header:active { cursor: grabbing; }
      .ig-audio-folder-header.ig-audio-folder-drop-top { box-shadow: inset 0 3px 0 0 #10b981; }
      .ig-audio-folder-header.ig-audio-folder-drop-bottom { box-shadow: inset 0 -3px 0 0 #10b981; }
      .ig-audio-caret { font-size: 9px; cursor: pointer; padding: 2px; width: 14px; text-align: center; transition: transform 0.2s; }
      .ig-audio-caret.collapsed { transform: rotate(-90deg); }
      .ig-audio-folder-content { display: flex; flex-direction: column; }
      .ig-audio-folder-content.collapsed { display: none; }
      .ig-audio-clip-row { display: flex; align-items: center; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.03); background: rgba(255,255,255,0.01); cursor: grab; transition: background 0.2s; }
      .ig-audio-clip-row:hover { background: rgba(255,255,255,0.05); }
      .ig-audio-clip-row.alt { background: rgba(255,255,255,0.02); }
      .ig-audio-clip-row:active { cursor: grabbing; }
      .ig-audio-clip-row.ig-audio-hidden { display: none; }
      .ig-audio-grip { color: #475569; font-size: 10px; cursor: grab; margin-right: 6px; flex-shrink: 0; }
      .ig-audio-grip:active { cursor: grabbing; }
      .ig-audio-name { font-size: 11px; color: #f8fafc; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; flex-shrink: 0; }
      .ig-audio-col-resizer { width: 6px; height: 18px; cursor: col-resize; background: rgba(255,255,255,0.05); border-radius: 3px; margin: 0 6px; transition: background 0.1s; flex-shrink: 0; }
      .ig-audio-col-resizer:hover, .ig-audio-col-resizer.active { background: #6366f1; }
      .ig-audio-cmd-badge { font-size: 9px; background: rgba(255,255,255,0.1); color: #c9a876; padding: 1px 6px; border-radius: 8px; font-weight: bold; margin-right: 8px; flex-shrink: 0; }
      .ig-audio-transcript-badge { font-size: 11px; margin-right: 8px; flex-shrink: 0; opacity: 0.75; cursor: help; }
      .ig-audio-actions { display: flex; gap: 4px; align-items: center; margin-left: auto; flex-shrink: 0; }
      .ig-audio-btn { background: transparent; border: none; color: #64748b; cursor: pointer; font-size: 11px; padding: 3px 6px; border-radius: 4px; transition: 0.2s; }
      .ig-audio-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .ig-audio-send-btn { background: #10b981; color: #fff; border-radius: 4px; padding: 4px 8px; font-weight: bold; font-size: 10px; }
      .ig-audio-send-btn:hover { background: #059669; color: #fff; opacity: 0.9; }
      .ig-audio-footer { display: flex; gap: 4px; margin-top: 4px; }
      .ig-audio-footer button { flex: 1; padding: 7px 4px; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 10px; transition: opacity 0.2s; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
      .ig-audio-footer button:hover { opacity: 0.9; }
      .ig-audio-dl-btn { background: #2e7d32; }
      .ig-audio-ul-btn { background: #4527a0; }
      .ig-pipeline-badge { display: inline-block; padding: 1px 5px; border-radius: 4px; font-weight: bold; color: #fff; margin-right: 4px; font-size: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
      .ig-course-badge { display: inline-block; padding: 1px 5px; border-radius: 4px; font-weight: bold; color: #fff; margin-right: 4px; font-size: 9px; text-transform: uppercase; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
      .ig-audio-tx-tooltip { position: fixed; z-index: 2147483647 !important; transform: translateY(-100%); background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(4px); color: #cbd5e1; padding: 10px 12px; border-radius: 6px; border: 1px solid #475569; max-width: 250px; font-size: 11px; pointer-events: none; display: none; box-shadow: 0 10px 25px rgba(0,0,0,0.6); white-space: pre-wrap; word-wrap: break-word; line-height: 1.4; }
      .ig-audio-modal-overlay { position: fixed; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,0.6); z-index: 2147483647; display: flex; justify-content: center; align-items: center; }
      .ig-audio-modal { background: #0f172a; border: 1px solid #334155; border-radius: 8px; width: 320px; max-height: 85vh; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
      .ig-audio-modal h3 { margin: 0; font-size: 14px; color: #fff; }
      .ig-audio-modal-input { width: 100%; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 8px; border-radius: 4px; font-size: 12px; box-sizing: border-box; outline: none; }
      .ig-audio-modal-input:focus { border-color: #6366f1; }
      .ig-audio-modal-textarea { width: 100%; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 8px; border-radius: 4px; font-size: 12px; box-sizing: border-box; outline: none; resize: vertical; min-height: 70px; font-family: inherit; line-height: 1.4; }
      .ig-audio-modal-textarea:focus { border-color: #6366f1; }
      .ig-audio-modal-label { font-size: 11px; font-weight: bold; color: #94a3b8; margin-top: 4px; }
      .ig-audio-modal-play-btn { background: #334155; color: #fff; border: none; border-radius: 6px; padding: 8px; font-weight: bold; cursor: pointer; }
      .ig-audio-modal-play-btn:hover { background: #475569; }
    `;
    document.head.appendChild(style);

    const libUI = document.createElement('div');
    libUI.className = 'ig-audio-lib-wrap';
    libUI.innerHTML = `
      <div class="ig-audio-lib-header">
        <span>Filters:</span>
        <button id="ig-audio-new-folder-btn" class="ig-audio-lib-new-btn">+ New Folder</button>
      </div>
      <input type="text" id="ig-audio-search-input" class="ig-audio-search" placeholder="🔍 Search clips... (Enter to send)">
      <div class="ig-audio-lib-filters">
        <select id="ig-audio-folder-filter" style="flex: 1;">
          <option value="All">📂 All Folders</option>
        </select>
        <select id="ig-audio-tag-filter" style="width: 90px;">
          <option value="All">🏷️ All Tags</option>
          <option value="#0095f6">Blue</option>
          <option value="#2e7d32">Green</option>
          <option value="#f77f00">Orange</option>
          <option value="#9d0208">Red</option>
          <option value="#7209b7">Purple</option>
        </select>
      </div>
      <div id="ig-audio-lib-tree" class="ig-audio-lib-tree"></div>
      <div class="ig-audio-footer">
        <button id="ig-audio-dl-btn" class="ig-audio-dl-btn">📥 DL</button>
        <button id="ig-audio-ul-btn" class="ig-audio-ul-btn">📤 Upload</button>
        <input type="file" id="ig-audio-batch-input" accept="audio/*" multiple style="display: none;">
      </div>
    `;

    function mountCards() {
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '📚 Audio Library', libUI, '⠿', 'audio-lib');
      } else {
        setTimeout(mountCards, 200);
      }
    }
    mountCards();

    core.on('library:refresh', () => renderClips());
    core.on('folders:refresh', () => loadFolders());
    core.on('tagcolors:updated', () => renderClips()); // 🎨 re-color tags live

    libUI.querySelector('#ig-audio-folder-filter').onchange = () => renderClips();
    libUI.querySelector('#ig-audio-tag-filter').onchange = () => renderClips();

    const searchInput = libUI.querySelector('#ig-audio-search-input');
    searchInput.addEventListener('input', () => {
      searchTerm = searchInput.value.toLowerCase();
      renderClips(true);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const tree = libUI.querySelector('#ig-audio-lib-tree');
      const firstVisible = tree.querySelector('.ig-audio-clip-row:not(.ig-audio-hidden)');
      if (firstVisible) {
        const sendBtn = firstVisible.querySelector('.ig-audio-send-btn');
        if (sendBtn) {
          sendBtn.click();
          searchInput.value = '';
          searchTerm = '';
          renderClips(true);
        }
      }
    });

    libUI.querySelector('#ig-audio-new-folder-btn').onclick = () => {
      const fName = prompt("New folder name:");
      if (!fName || !fName.trim()) return;
      const tx = db.transaction(['folders'], 'readwrite');
      tx.objectStore('folders').put({ name: fName.trim(), order: Date.now() });
      tx.oncomplete = () => {
        loadFolders();
        core.emit('folders:refresh');
      };
    };

    function reorderFolders(dragName, targetName, dropBefore) {
      if (!db || dragName === targetName) return;
      const tx = db.transaction(['folders'], 'readwrite');
      const store = tx.objectStore('folders');
      store.getAll().onsuccess = e => {
        const folderRecords = (e.target.result || []).sort((a, b) => (a.order || 0) - (b.order || 0));
        const dragIdx = folderRecords.findIndex(f => f.name === dragName);
        if (dragIdx === -1) return;
        const [moved] = folderRecords.splice(dragIdx, 1);
        let insertIdx = folderRecords.findIndex(f => f.name === targetName);
        if (insertIdx === -1) insertIdx = folderRecords.length;
        else if (!dropBefore) insertIdx++;
        folderRecords.splice(insertIdx, 0, moved);
        folderRecords.forEach((f, i) => { f.order = i; store.put(f); });
      };
      tx.oncomplete = () => { renderClips(); };
    }

    function loadFolders() {
      if (!db) return;
      const folderSelect = libUI.querySelector('#ig-audio-folder-filter');
      const curVal = folderSelect.value || "All";
      folderSelect.innerHTML = '<option value="All">📂 All Folders</option>';
      const tx = db.transaction(['folders'], 'readonly');
      tx.objectStore('folders').openCursor().onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          folderSelect.add(new Option(cursor.value.name, cursor.value.name));
          cursor.continue();
        } else {
          folderSelect.value = curVal;
        }
      };
    }

    let draggedClip = null;
    let draggedFolder = null;
    let activeColResizer = null;

    window.addEventListener('mousemove', (e) => {
      if (!activeColResizer) return;
      const containerRect = activeColResizer.container.getBoundingClientRect();
      const newWidthPercent = ((e.clientX - containerRect.left) / containerRect.width) * 100;
      colWidths.nameWidth = Math.min(85, Math.max(15, newWidthPercent));
      libUI.querySelectorAll('.ig-audio-name').forEach(el => el.style.width = colWidths.nameWidth + '%');
    });
    window.addEventListener('mouseup', () => {
      if (activeColResizer) {
        activeColResizer.el.classList.remove('active');
        activeColResizer = null;
        localStorage.setItem(COL_PREF_KEY, JSON.stringify(colWidths));
      }
    });

    async function openEditModal(clip) {
      const overlay = document.createElement('div');
      overlay.className = 'ig-audio-modal-overlay';

      overlay.innerHTML = `
        <div class="ig-audio-modal">
          <h3>✏️ Edit Clip</h3>
          <div class="ig-audio-modal-label">Name:</div>
          <input type="text" id="ig-audio-modal-name" class="ig-audio-modal-input" value="${String(clip.name || '').replace(/"/g, '&quot;')}">
          <div class="ig-audio-modal-label">Folder:</div>
          <select id="ig-audio-modal-folder" class="ig-audio-modal-input"></select>
          <div class="ig-audio-modal-label">Custom Command (used by Quick Command Bar):</div>
          <div style="display:flex; align-items:center; gap:4px;">
            <span style="color:#94a3b8; font-weight:bold;">/</span>
            <input type="text" id="ig-audio-modal-command" class="ig-audio-modal-input" placeholder="e.g. hola" value="${clip.customCommand || ''}">
          </div>
          <div class="ig-audio-modal-label">Transcript (shown in the Quick Command preview panel):</div>
          <textarea id="ig-audio-modal-transcript" class="ig-audio-modal-textarea" placeholder="Type out what this clip says...">${String(clip.transcript || '').replace(/</g, '&lt;')}</textarea>
          <button id="ig-audio-modal-play" class="ig-audio-modal-play-btn">▶️ Preview</button>
          <div style="display:flex; justify-content:space-between; margin-top:8px;">
            <div style="display:flex; gap:8px;">
              <button id="ig-audio-modal-del" style="background:#dc2626; color:#fff; border:none; padding:6px 12px; border-radius:4px; font-weight:bold; cursor:pointer;">🗑️ Delete</button>
              <button id="ig-audio-modal-dl" style="background:#2e7d32; color:#fff; border:none; padding:6px 12px; border-radius:4px; font-weight:bold; cursor:pointer;">📥 Download</button>
            </div>
            <div style="display:flex; gap:8px;">
              <button id="ig-audio-modal-cancel" style="background:transparent; color:#94a3b8; border:none; cursor:pointer; font-weight:bold;">Cancel</button>
              <button id="ig-audio-modal-save" style="background:#6366f1; color:#fff; border:none; padding:6px 12px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 Save</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const folderSel = overlay.querySelector('#ig-audio-modal-folder');
      const tx0 = db.transaction(['folders'], 'readonly');
      tx0.objectStore('folders').openCursor().onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          const opt = document.createElement('option');
          opt.value = cursor.value.name; opt.innerText = cursor.value.name;
          if (cursor.value.name === (clip.folder || 'General')) opt.selected = true;
          folderSel.appendChild(opt);
          cursor.continue();
        }
      };

      let previewPlayer = null;
      overlay.querySelector('#ig-audio-modal-play').onclick = async (e) => {
        const btn = e.target;
        if (!previewPlayer) {
          const blob = await getClipBlob(clip.id);
          if (!blob) return alert("Audio file not found in DB.");
          previewPlayer = new Audio(URL.createObjectURL(blob));
          btn.innerText = '⏹️ Stop';
          previewPlayer.play();
          previewPlayer.onended = () => { btn.innerText = '▶️ Preview'; previewPlayer = null; };
        } else {
          previewPlayer.pause();
          btn.innerText = '▶️ Preview';
          previewPlayer = null;
        }
      };

      overlay.querySelector('#ig-audio-modal-dl').onclick = async () => {
        const blob = await getClipBlob(clip.id);
        if (!blob) return alert("Audio file not found.");
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${clip.folder || 'General'}.${clip.color || '#0095f6'}.${clip.name}.m4a`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 300);
      };

      overlay.querySelector('#ig-audio-modal-del').onclick = () => {
        if (!confirm('Permanently delete this clip?')) return;
        const tx = db.transaction(['clips'], 'readwrite');
        tx.objectStore('clips').delete(clip.id);
        tx.oncomplete = () => { renderClips(); overlay.remove(); };
      };

      overlay.querySelector('#ig-audio-modal-cancel').onclick = () => overlay.remove();

      overlay.querySelector('#ig-audio-modal-save').onclick = () => {
        const newName = overlay.querySelector('#ig-audio-modal-name').value.trim() || clip.name;
        const newFolder = folderSel.value || 'General';
        const newCommand = overlay.querySelector('#ig-audio-modal-command').value.trim().replace(/^\/+/, '');
        const newTranscript = overlay.querySelector('#ig-audio-modal-transcript').value;
        const tx = db.transaction(['clips'], 'readwrite');
        const store = tx.objectStore('clips');
        store.get(clip.id).onsuccess = e => {
          const c = e.target.result;
          if (c) {
            c.name = newName;
            c.folder = newFolder;
            c.customCommand = newCommand;
            c.transcript = newTranscript;
            store.put(c);
          }
        };
        tx.oncomplete = () => { renderClips(); overlay.remove(); };
      };
    }

    // --- Hover Tooltip Binding Helper ---
    function attachTranscriptTooltip(badgeElement, transcriptText) {
        if (!badgeElement || !transcriptText) return;

        const updatePos = (e) => {
            if (txTooltip && txTooltip.style.display === 'block') {
                let x = e.clientX + 15;
                let y = e.clientY - 10; // TranslateY(-100%) in CSS moves it exactly above cursor
                if (x + 260 > window.innerWidth) x = window.innerWidth - 265;
                txTooltip.style.left = x + 'px';
                txTooltip.style.top = y + 'px';
            }
        };

        badgeElement.addEventListener('mouseenter', (e) => {
            if (txTooltip) {
                document.body.appendChild(txTooltip); // Append to body to reset z-index context
                txTooltip.innerHTML = safeHTML(transcriptText);
                txTooltip.style.display = 'block';
                updatePos(e);
            }
        });
        badgeElement.addEventListener('mousemove', updatePos);
        badgeElement.addEventListener('mouseleave', () => {
            if (txTooltip) txTooltip.style.display = 'none';
        });
    }

    function renderClips(isFilterOnly) {
      if (!db) return;
      const tree = libUI.querySelector('#ig-audio-lib-tree');
      const folderFilter = libUI.querySelector('#ig-audio-folder-filter').value || 'All';
      const tagFilter = libUI.querySelector('#ig-audio-tag-filter').value || 'All';

      if (isFilterOnly) {
        tree.querySelectorAll('.ig-audio-clip-row').forEach(row => {
          const name = row.querySelector('.ig-audio-name').innerText.toLowerCase();
          const clipTx = row.dataset.transcript || '';
          row.classList.toggle('ig-audio-hidden', searchTerm && !name.includes(searchTerm) && !clipTx.includes(searchTerm));
        });
        tree.querySelectorAll('.ig-audio-folder-header').forEach(header => {
          const content = header.nextElementSibling;
          const anyVisible = content && content.querySelector('.ig-audio-clip-row:not(.ig-audio-hidden)');
          header.parentElement.style.display = (searchTerm && !anyVisible) ? 'none' : '';
        });
        return;
      }

      tree.innerHTML = '';
      const tx = db.transaction(['clips'], 'readonly');
      tx.objectStore('clips').getAll().onsuccess = e => {
        const allClipsRaw = e.target.result || [];

        // RAM-SAFE STRIPPING: Remove bloated Blobs from memory immediately
        const allClips = allClipsRaw.map(c => {
            const clone = { ...c };
            delete clone.blob; // Stop closures from trapping megabytes of audio
            return clone;
        }).sort((a, b) => (a.order || 0) - (b.order || 0));

        if (!allClips.length) {
          tree.innerHTML = '<div style="padding:12px; color:#94a3b8; font-size:10px;">No audio clips yet.</div>';
          return;
        }

        const folders = {};
        allClips.forEach(clip => {
          const folder = clip.folder || 'General';
          if (!folders[folder]) folders[folder] = [];
          folders[folder].push(clip);
        });

        const ftx = db.transaction(['folders'], 'readonly');
        const folderOrderMap = {};
        ftx.objectStore('folders').openCursor().onsuccess = fe => {
          const cursor = fe.target.result;
          if (cursor) {
            folderOrderMap[cursor.value.name] = typeof cursor.value.order === 'number' ? cursor.value.order : null;
            cursor.continue();
          } else {
            const sortedFolderNames = Object.keys(folders).sort((a, b) => {
              const oa = folderOrderMap[a];
              const ob = folderOrderMap[b];
              if (oa !== null && oa !== undefined && ob !== null && ob !== undefined && oa !== ob) return oa - ob;
              if (oa !== null && oa !== undefined && (ob === null || ob === undefined)) return -1;
              if (ob !== null && ob !== undefined && (oa === null || oa === undefined)) return 1;
              return a.localeCompare(b);
            });
            renderFolderGroups(sortedFolderNames);
          }
        };

        function renderFolderGroups(sortedFolderNames) {
          let clipCounter = 0;
          sortedFolderNames.forEach(folderName => {
            if (folderFilter !== 'All' && folderFilter !== folderName) return;

            const folderEl = document.createElement('div');
            const isCollapsed = collapsedFolders.has(folderName);
            const headerEl = document.createElement('div');
            headerEl.className = 'ig-audio-folder-header';
            headerEl.draggable = true;
            headerEl.innerHTML = `
              <span class="ig-audio-caret ${isCollapsed ? 'collapsed' : ''}">▼</span>
              <span>📁 ${folderName}</span>
              <span style="margin-left:auto; font-size:9px; opacity:0.6;">${folders[folderName].length} clips</span>
            `;

            headerEl.querySelector('.ig-audio-caret').onclick = (ev) => {
              ev.stopPropagation();
              if (collapsedFolders.has(folderName)) collapsedFolders.delete(folderName);
              else collapsedFolders.add(folderName);
              renderClips();
            };

            headerEl.ondragstart = (ev) => { ev.stopPropagation(); draggedFolder = folderName; headerEl.style.opacity = '0.4'; };
            headerEl.ondragend = () => { draggedFolder = null; headerEl.style.opacity = '1'; };
            headerEl.ondragover = (ev) => {
              if (!draggedFolder || draggedFolder === folderName) return;
              ev.preventDefault(); ev.stopPropagation();
              const rect = headerEl.getBoundingClientRect();
              const isTop = (ev.clientY - rect.top) < rect.height / 2;
              headerEl.classList.toggle('ig-audio-folder-drop-top', isTop);
              headerEl.classList.toggle('ig-audio-folder-drop-bottom', !isTop);
            };
            headerEl.ondragleave = () => headerEl.classList.remove('ig-audio-folder-drop-top', 'ig-audio-folder-drop-bottom');
            headerEl.ondrop = (ev) => {
              if (!draggedFolder || draggedFolder === folderName) return;
              ev.preventDefault(); ev.stopPropagation();
              const rect = headerEl.getBoundingClientRect();
              const isTop = (ev.clientY - rect.top) < rect.height / 2;
              headerEl.classList.remove('ig-audio-folder-drop-top', 'ig-audio-folder-drop-bottom');
              reorderFolders(draggedFolder, folderName, isTop);
              draggedFolder = null;
            };

            folderEl.appendChild(headerEl);
            const contentEl = document.createElement('div');
            contentEl.className = `ig-audio-folder-content ${isCollapsed ? 'collapsed' : ''}`;

            folders[folderName].forEach((clip) => {
              if (tagFilter !== 'All' && clip.color !== tagFilter) return;

              clipCounter++;
              const rowEl = document.createElement('div');
              rowEl.className = `ig-audio-clip-row ${clipCounter % 2 === 0 ? 'alt' : ''}`;
              rowEl.draggable = true;
              rowEl.dataset.clipId = clip.id;
              rowEl.dataset.transcript = String(clip.transcript || '').toLowerCase();

              const clipNameStr = String(clip.name || '');
              const clipNameLower = clipNameStr.toLowerCase();
              if (searchTerm && !clipNameLower.includes(searchTerm) && !rowEl.dataset.transcript.includes(searchTerm)) {
                rowEl.classList.add('ig-audio-hidden');
              }

              // Pipeline Formatter
              const formattedName = formatPipelineName(clipNameStr);

              const cmdBadgeHtml = clip.customCommand ? `<span class="ig-audio-cmd-badge">/${clip.customCommand}</span>` : '';
              const transcriptBadgeHtml = String(clip.transcript || '').trim() ? `<span class="ig-audio-transcript-badge">📄</span>` : '';

              rowEl.innerHTML = `
                <span class="ig-audio-grip">⠿</span>
                <span class="ig-audio-name" style="width: ${colWidths.nameWidth}%;" title="${safeHTML(clipNameStr)}">${formattedName}</span>
                <div class="ig-audio-col-resizer" title="Drag to resize name column"></div>
                ${cmdBadgeHtml}
                ${transcriptBadgeHtml}
                <div class="ig-audio-actions">
                  <button class="ig-audio-btn play-btn" title="Play">▶️</button>
                  <button class="ig-audio-btn ig-audio-send-btn" title="Send to chat">📤 Send</button>
                  <button class="ig-audio-btn edit-btn" title="Edit">✏️</button>
                </div>
              `;

              // Attach Tooltip to the fresh badge
              const txBadge = rowEl.querySelector('.ig-audio-transcript-badge');
              if (txBadge && clip.transcript) {
                  attachTranscriptTooltip(txBadge, clip.transcript);
              }

              const resizer = rowEl.querySelector('.ig-audio-col-resizer');
              resizer.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                resizer.classList.add('active');
                activeColResizer = { el: resizer, container: rowEl };
              });

              rowEl.ondragstart = (e) => {
                if (e.target.closest('.ig-audio-col-resizer')) { e.preventDefault(); return; }
                draggedClip = clip; rowEl.style.opacity = '0.4';
              };
              rowEl.ondragend = () => { draggedClip = null; rowEl.style.opacity = '1'; };
              rowEl.ondragover = e => { e.preventDefault(); rowEl.style.borderTop = '2px solid #10b981'; };
              rowEl.ondragleave = () => { rowEl.style.borderTop = ''; };
              rowEl.ondrop = async (e) => {
                e.preventDefault();
                rowEl.style.borderTop = '';
                if (draggedClip && draggedClip.id !== clip.id) {
                  const tx2 = db.transaction(['clips'], 'readwrite');
                  const store = tx2.objectStore('clips');
                  store.getAll().onsuccess = ev => {
                    const clips = ev.target.result.sort((a, b) => (a.order || 0) - (b.order || 0));
                    const dragIdx = clips.findIndex(c => c.id === draggedClip.id);
                    const targetIdx = clips.findIndex(c => c.id === clip.id);
                    if (dragIdx > -1 && targetIdx > -1) {
                      const [moved] = clips.splice(dragIdx, 1);
                      clips.splice(targetIdx, 0, moved);
                      clips.forEach((c, i) => { c.order = i; store.put(c); });
                    }
                  };
                  tx2.oncomplete = () => renderClips();
                }
              };

              let rowPlayer = null;
              rowEl.querySelector('.play-btn').onclick = async (e) => {
                e.stopPropagation();
                const btn = e.target;
                if (!rowPlayer) {
                  const blob = await getClipBlob(clip.id);
                  if (!blob) return alert("Audio not found in DB.");
                  rowPlayer = new Audio(URL.createObjectURL(blob));
                  btn.innerText = '⏹️';
                  rowPlayer.play();
                  rowPlayer.onended = () => { btn.innerText = '▶️'; rowPlayer = null; };
                } else {
                  rowPlayer.pause(); rowPlayer = null; btn.innerText = '▶️';
                }
              };

              rowEl.querySelector('.ig-audio-send-btn').onclick = async (e) => {
                e.stopPropagation();
                const btn = e.target;
                const originalText = btn.innerText;
                btn.innerText = '⏳';
                const blob = await getClipBlob(clip.id);
                if (blob) core.injectClipToChat(blob, clip.name);
                btn.innerText = '✅ Sent';
                setTimeout(() => btn.innerText = originalText, 1000);
              };

              rowEl.querySelector('.edit-btn').onclick = (e) => {
                e.stopPropagation();
                openEditModal(clip);
              };

              contentEl.appendChild(rowEl);
            });
            folderEl.appendChild(contentEl);
            tree.appendChild(folderEl);
          });
        }
      };
    }

    libUI.querySelector('#ig-audio-dl-btn').onclick = async () => {
      const btn = libUI.querySelector('#ig-audio-dl-btn');
      btn.innerText = '⏳ Wait...';
      const tx = db.transaction(['clips'], 'readonly');
      tx.objectStore('clips').getAll().onsuccess = async e => {
        const clips = e.target.result || [];
        for (let clip of clips) {
          if (!clip.blob) continue;
          const url = URL.createObjectURL(clip.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${clip.folder || 'General'}.${clip.color || '#0095f6'}.${clip.name}.m4a`;
          document.body.appendChild(a); a.click(); a.remove();
          await new Promise(r => setTimeout(r, 150));
          URL.revokeObjectURL(url);
        }
        btn.innerText = '📥 DL';
      };
    };

    const batchBtn = libUI.querySelector('#ig-audio-ul-btn');
    const batchInput = libUI.querySelector('#ig-audio-batch-input');
    batchBtn.onclick = () => batchInput.click();
    batchInput.onchange = e => {
      const files = e.target.files;
      if (!files.length) return;
      batchBtn.innerText = '⏳ Sorting...';
      const tx = db.transaction(['folders', 'clips'], 'readwrite');
      const fStore = tx.objectStore('folders'), cStore = tx.objectStore('clips');
      const folders = new Set(['General']);

      for (let i = 0; i < files.length; i++) {
        const parts = files[i].name.replace(/\.[^/.]+$/, '').split('.');
        let folder = 'General', color = '#0095f6', name = files[i].name;
        if (parts.length >= 3 && parts[1].startsWith('#')) {
          folder = parts[0].trim(); color = parts[1].trim(); name = parts.slice(2).join('.').trim();
        } else if (parts.length >= 2) {
          folder = parts[0].trim(); name = parts.slice(1).join('.').trim();
        }
        folders.add(folder);
        cStore.add({ name, folder, color, order: i, blob: new Blob([files[i]], { type: 'audio/mp4' }) });
      }
      folders.forEach(f => fStore.put({ name: f }));
      tx.oncomplete = () => {
        batchBtn.innerText = '📤 Upload';
        loadFolders();
        renderClips();
        core.emit('folders:refresh');
      };
      batchInput.value = '';
    };

    core.emit('block:ready', { id: 'audioLibrary' });
  }
});

/* ============================================================
   BLOCK: Dual Sidebar UI Shell (v2)
   ============================================================ */
/* ============================================================
   BLOCK: Dual Sidebar UI Shell (v5 - with Module Search)
   ============================================================ */
LegoCore.registerBlock({
  id: 'igDualSidebarUI',
  init(core) {
    const PREF_KEY = 'ig_modular_dual_sidebar_prefs_v22';
    let prefs = JSON.parse(localStorage.getItem(PREF_KEY)) || {
      leftWidth: 80,
      rightWidth: 280,
      uiScale: 100,
      leftHidden: false,
      rightHidden: false,
      leftMenus: [],
      rightMenus: [],
      cardHeights: {}
    };

    if (!prefs.cardHeights) prefs.cardHeights = {};

    const stylesheet = document.createElement('style');
    stylesheet.id = 'ig-modular-dual-styles';

    function updateStyles() {
      const uiScaleVal = prefs.uiScale / 100;

      stylesheet.innerHTML = `
        :root {
          --igls-bg: #131318;
          --igls-surface: #17171d;
          --igls-surface-2: #1c1c23;
          --igls-border: rgba(255,255,255,0.07);
          --igls-border-strong: rgba(255,255,255,0.14);
          --igls-text: #ece9e4;
          --igls-text-dim: #96949c;
          --igls-accent: #c9a876;
          --igls-accent-soft: rgba(201,168,118,0.14);
          --igls-shadow: rgba(0,0,0,0.5);
        }

        #ig-modular-left-panel, #ig-modular-right-panel {
          position: fixed; top: 0; height: 100vh;
          background: var(--igls-bg); color: var(--igls-text);
          z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          display: none; flex-direction: column; overflow-x: hidden;
          zoom: ${uiScaleVal} !important;
        }

        #ig-modular-left-panel {
          left: ${prefs.leftHidden ? `-${prefs.leftWidth}px` : '0'};
          width: ${prefs.leftWidth}px; border-right: 1px solid var(--igls-border);
          box-shadow: 24px 0 60px var(--igls-shadow);
          transition: left 0.28s cubic-bezier(0.22, 0.61, 0.36, 1);
        }

        #ig-modular-right-panel {
          right: ${prefs.rightHidden ? `-${prefs.rightWidth}px` : '0'};
          width: ${prefs.rightWidth}px; border-left: 1px solid var(--igls-border);
          box-shadow: -24px 0 60px var(--igls-shadow);
          transition: right 0.28s cubic-bezier(0.22, 0.61, 0.36, 1);
        }

        body.ig-modular-active #ig-modular-left-panel,
        body.ig-modular-active #ig-modular-right-panel { display: flex; }

        #ig-left-toggle-tab, #ig-right-toggle-tab {
          position: fixed; top: 50%; transform: translateY(-50%);
          background: var(--igls-surface); color: var(--igls-text-dim);
          border: 1px solid var(--igls-border); padding: 14px 7px;
          cursor: pointer; z-index: 2147483648; font-size: 10px; font-weight: 600;
          writing-mode: vertical-rl;
        }

        #ig-left-toggle-tab { left: 0; border-left: none; border-radius: 0 10px 10px 0; display: ${prefs.leftHidden ? 'flex' : 'none'}; }
        #ig-right-toggle-tab { right: 0; border-right: none; border-radius: 10px 0 0 10px; display: ${prefs.rightHidden ? 'flex' : 'none'}; }

        #ig-left-resizer, #ig-right-resizer {
          position: absolute; top: 0; width: 4px; height: 100%; cursor: ew-resize; z-index: 2147483648;
        }
        #ig-left-resizer { right: -2px; display: ${prefs.leftHidden ? 'none' : 'block'}; }
        #ig-right-resizer { left: -2px; display: ${prefs.rightHidden ? 'none' : 'block'}; }

        .ig-panel-header {
          padding: 16px 16px 14px; border-bottom: 1px solid var(--igls-border);
          display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; gap: 10px;
        }

        .ig-panel-title { font-size: 10.5px; font-weight: 600; color: var(--igls-text-dim); text-transform: uppercase; }

        .ig-panel-search { padding: 10px 12px 0 12px; flex-shrink: 0; }
        .ig-panel-search input {
          width: 100%; box-sizing: border-box; background: var(--igls-surface-2);
          color: var(--igls-text); border: 1px solid var(--igls-border);
          border-radius: 6px; padding: 6px 8px; font-size: 11px; outline: none;
          transition: border-color 0.2s;
        }
        .ig-panel-search input:focus { border-color: var(--igls-accent); }

        .ig-draggable-menu.ig-search-hidden { display: none !important; }

        .ig-panel-body {
          padding: 12px; flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 10px;
        }

        .ig-draggable-menu {
          background: var(--igls-surface); border: 1px solid var(--igls-border); border-radius: 11px;
          overflow: hidden; flex-shrink: 0; display: flex; flex-direction: column;
        }

        .ig-menu-header {
          padding: 10px 12px; font-size: 11.5px; font-weight: 600; color: var(--igls-text);
          display: flex; justify-content: space-between; align-items: center; cursor: grab; user-select: none;
        }

        .ig-menu-content {
          padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px;
          resize: vertical; overflow: auto; min-height: 50px; max-height: 80vh;
        }

        .ig-base-btn {
          background: var(--igls-accent); color: #171208; border: none; padding: 8px 10px;
          border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 11px; width: 100%;
        }

        .ig-hide-btn {
          background: transparent; color: var(--igls-text-dim); border: 1px solid var(--igls-border);
          padding: 5px 9px; border-radius: 6px; cursor: pointer; font-size: 10px; font-weight: 600;
        }

        select.ig-ui-scale-select {
          background: var(--igls-surface-2); color: var(--igls-text-dim); border: 1px solid var(--igls-border);
          border-radius: 6px; font-size: 10px; padding: 4px 6px; cursor: pointer;
        }
      `;
    }

    updateStyles();
    document.documentElement.appendChild(stylesheet);

    function buildModularUI() {
      if (document.getElementById('ig-modular-left-panel')) return;

      const leftPanel = document.createElement('div');
      leftPanel.id = 'ig-modular-left-panel';
      leftPanel.innerHTML = `
        <div id="ig-left-resizer"></div>
        <div class="ig-panel-header">
          <span class="ig-panel-title">Left</span>
          <button class="ig-hide-btn" id="ig-hide-left-btn">Hide</button>
        </div>
        <div class="ig-panel-search">
          <input type="text" id="ig-left-search" placeholder="🔍 Search modules...">
        </div>
        <div class="ig-panel-body" id="ig-left-menu-container"></div>
      `;
      document.body.appendChild(leftPanel);

      const rightPanel = document.createElement('div');
      rightPanel.id = 'ig-modular-right-panel';
      rightPanel.innerHTML = `
        <div id="ig-right-resizer"></div>
        <div class="ig-panel-header">
          <button class="ig-hide-btn" id="ig-hide-right-btn">Hide</button>
          <span class="ig-panel-title">Right</span>
          <select id="ig-ui-scale-select" class="ig-ui-scale-select">
            <option value="80">80%</option>
            <option value="90">90%</option>
            <option value="100">100%</option>
            <option value="110">110%</option>
            <option value="120">120%</option>
          </select>
        </div>
        <div class="ig-panel-search">
          <input type="text" id="ig-right-search" placeholder="🔍 Search modules...">
        </div>
        <div class="ig-panel-body" id="ig-right-menu-container"></div>
      `;
      document.body.appendChild(rightPanel);

      const leftTab = document.createElement('div');
      leftTab.id = 'ig-left-toggle-tab';
      leftTab.textContent = 'LEFT';
      document.body.appendChild(leftTab);

      const rightTab = document.createElement('div');
      rightTab.id = 'ig-right-toggle-tab';
      rightTab.textContent = 'RIGHT';
      document.body.appendChild(rightTab);

      document.getElementById('ig-hide-left-btn').addEventListener('click', () => { prefs.leftHidden = true; savePrefs(); });
      leftTab.addEventListener('click', () => { prefs.leftHidden = false; savePrefs(); });
      document.getElementById('ig-hide-right-btn').addEventListener('click', () => { prefs.rightHidden = true; savePrefs(); });
      rightTab.addEventListener('click', () => { prefs.rightHidden = false; savePrefs(); });

      const uiScaleSelect = document.getElementById('ig-ui-scale-select');
      uiScaleSelect.value = prefs.uiScale;
      uiScaleSelect.addEventListener('change', (e) => {
        prefs.uiScale = parseInt(e.target.value);
        savePrefs();
      });

      const leftResizer = document.getElementById('ig-left-resizer');
      let isResizingLeft = false;
      leftResizer.addEventListener('mousedown', () => { isResizingLeft = true; });

      const rightResizer = document.getElementById('ig-right-resizer');
      let isResizingRight = false;
      rightResizer.addEventListener('mousedown', () => { isResizingRight = true; });

      window.addEventListener('mousemove', (e) => {
        if (isResizingLeft) { prefs.leftWidth = Math.min(500, Math.max(50, e.clientX)); updateStyles(); notifyChange(); }
        if (isResizingRight) { prefs.rightWidth = Math.min(500, Math.max(180, window.innerWidth - e.clientX)); updateStyles(); notifyChange(); }
      });

      window.addEventListener('mouseup', () => {
        if (isResizingLeft || isResizingRight) { isResizingLeft = isResizingRight = false; savePrefs(); notifyChange(); }
      });

      // Module Search Filtering Logic
      function attachSearchFilter(inputId, containerId) {
        const input = document.getElementById(inputId);
        const container = document.getElementById(containerId);
        if (!input || !container) return;

        input.addEventListener('input', (e) => {
          const term = e.target.value.toLowerCase();
          const cards = container.querySelectorAll('.ig-draggable-menu');
          cards.forEach(card => {
            const titleEl = card.querySelector('.ig-menu-header span:first-child');
            const title = titleEl ? titleEl.innerText.toLowerCase() : '';
            if (title.includes(term)) {
              card.classList.remove('ig-search-hidden');
            } else {
              card.classList.add('ig-search-hidden');
            }
          });
        });
      }

      attachSearchFilter('ig-left-search', 'ig-left-menu-container');
      attachSearchFilter('ig-right-search', 'ig-right-menu-container');

      startWatcher();
    }

    function savePrefs() {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
      updateStyles();
      notifyChange();
    }

    function notifyChange() {
      core.emit('sidebar:layout-changed', {
        leftWidth: prefs.leftHidden ? 0 : prefs.leftWidth,
        rightWidth: prefs.rightHidden ? 0 : prefs.rightWidth,
        leftHidden: prefs.leftHidden,
        rightHidden: prefs.rightHidden
      });
    }

    function startWatcher() {
      setInterval(() => {
        if (window.location.href.includes('/direct/')) document.body.classList.add('ig-modular-active');
        else document.body.classList.remove('ig-modular-active');
      }, 500);
    }

    if (document.body) buildModularUI();
    else document.addEventListener('DOMContentLoaded', buildModularUI);

    core.getSidebarPrefs = () => prefs;
    core.emit('block:ready', { id: 'igDualSidebarUI' });
  }
});

/* ============================================================
   BLOCK: menuCollapseModule (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Menu Card Collapse Module (v1)
   ============================================================ */
/* ================================================================
   BLOCK: Menu Card Collapse Module (Standalone Feature Plugin)
   - Injects a small collapse button inside every menu header
   - Toggles card visibility and saves states to localStorage
   - Automatically detects cards added dynamically by other modules
================================================================ */
LegoCore.registerBlock({
  id: 'menuCollapseModule',
  init(core) {
    const STORAGE_KEY = 'ig_menu_collapse_states_v1';
    let collapsedStates = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};

    function saveStates() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedStates));
    }

    // Inject CSS for the toggle button and collapsed state
    const style = document.createElement('style');
    style.id = 'ig-menu-collapse-styles';
    style.innerHTML = `
      .ig-collapse-btn {
        background: transparent;
        border: none;
        color: var(--igls-text-dim, #96949c);
        cursor: pointer;
        font-size: 13px;
        font-weight: bold;
        line-height: 1;
        padding: 0 4px;
        margin-left: 6px;
        border-radius: 3px;
        transition: color 0.2s, background 0.2s;
      }
      .ig-collapse-btn:hover {
        color: var(--igls-accent, #c9a876);
        background: rgba(255, 255, 255, 0.08);
      }
      .ig-draggable-menu.is-collapsed .ig-menu-content {
        display: none !important;
      }
      .ig-draggable-menu.is-collapsed {
        min-height: 0 !important;
        height: auto !important;
      }
    `;
    document.head.appendChild(style);

    // Apply collapse logic to a target card
    function processCard(card) {
      const key = card.dataset.key;
      const header = card.querySelector('.ig-menu-header');
      if (!header || !key || header.querySelector('.ig-collapse-btn')) return;

      const dragHandle = header.querySelector('.ig-drag-handle');

      // Create toggle button
      const btn = document.createElement('button');
      btn.className = 'ig-collapse-btn';
      btn.title = 'Collapse/Expand Menu';

      const isCollapsed = !!collapsedStates[key];
      if (isCollapsed) {
        card.classList.add('is-collapsed');
        btn.innerText = '+';
      } else {
        btn.innerText = '−';
      }

      // Prevent card drag handler when clicking the toggle button
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentlyCollapsed = card.classList.toggle('is-collapsed');
        btn.innerText = currentlyCollapsed ? '+' : '−';
        collapsedStates[key] = currentlyCollapsed;
        saveStates();
      });

      // Insert button right before the drag handle
      if (dragHandle) {
        header.insertBefore(btn, dragHandle);
      } else {
        header.appendChild(btn);
      }
    }

    // Attach to existing cards and observe dynamically mounted ones
    function attachToContainer(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;

      // Process initial cards
      container.querySelectorAll('.ig-draggable-menu').forEach(processCard);

      // Listen for newly added cards (e.g. registered later via core.registerMenu)
      const observer = new MutationObserver(() => {
        container.querySelectorAll('.ig-draggable-menu').forEach(processCard);
      });
      observer.observe(container, { childList: true, subtree: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('ig-left-menu-container');
      const right = document.getElementById('ig-right-menu-container');

      if (left && right) {
        attachToContainer('ig-left-menu-container');
        attachToContainer('ig-right-menu-container');
      } else if (attempts > 0) {
        setTimeout(() => initWatcher(attempts - 1), 200);
      }
    }

    initWatcher(10);
    console.log('[MenuCollapseModule] Initialized.');
    core.emit('block:ready', { id: 'menuCollapseModule' });
  }
});

/* ============================================================
   BLOCK: Menu Panel Switcher Module (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Menu Panel Switcher Module (v1)
   ============================================================ */
/* ================================================================
   BLOCK: Menu Panel Switcher (Standalone Feature Plugin)
   - Adds a '⇄' button to every menu card header
   - Moves cards between Left and Right sidebars with 1 click
   - Persists sidebar assignments to localStorage
================================================================ */
LegoCore.registerBlock({
  id: 'menuPanelSwitcherModule',
  init(core) {
    const STORAGE_KEY = 'ig_menu_panel_assignments_v1';
    let panelAssignments = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};

    function saveAssignments() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(panelAssignments));
    }

    // Inject CSS for the swap button
    const style = document.createElement('style');
    style.id = 'ig-menu-switcher-styles';
    style.innerHTML = `
      .ig-switch-panel-btn {
        background: transparent;
        border: none;
        color: var(--igls-text-dim, #96949c);
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        line-height: 1;
        padding: 2px 4px;
        margin-left: 4px;
        border-radius: 3px;
        transition: color 0.2s, background 0.2s;
      }
      .ig-switch-panel-btn:hover {
        color: var(--igls-accent, #c9a876);
        background: rgba(255, 255, 255, 0.08);
      }
    `;
    document.head.appendChild(style);

    // Apply button and handle persistent positioning for a card
    function processCard(card) {
      const key = card.dataset.key;
      const header = card.querySelector('.ig-menu-header');
      if (!header || !key) return;

      const leftContainer = document.getElementById('ig-left-menu-container');
      const rightContainer = document.getElementById('ig-right-menu-container');
      if (!leftContainer || !rightContainer) return;

      // 1. Move card if its saved preference differs from its current parent
      const savedSide = panelAssignments[key];
      if (savedSide === 'left' && card.parentElement !== leftContainer) {
        leftContainer.appendChild(card);
      } else if (savedSide === 'right' && card.parentElement !== rightContainer) {
        rightContainer.appendChild(card);
      }

      // Avoid adding duplicate buttons
      if (header.querySelector('.ig-switch-panel-btn')) return;

      // 2. Create the swap button
      const btn = document.createElement('button');
      btn.className = 'ig-switch-panel-btn';
      btn.title = 'Switch Panel (Left <-> Right)';
      btn.innerText = '⇄';

      // Prevent triggering drag reordering on click/mousedown
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();

        const currentContainer = card.parentElement;
        const isCurrentlyLeft = currentContainer.id === 'ig-left-menu-container';
        const targetContainer = isCurrentlyLeft ? rightContainer : leftContainer;

        // Move DOM element
        targetContainer.appendChild(card);

        // Save preference ('left' or 'right')
        panelAssignments[key] = isCurrentlyLeft ? 'right' : 'left';
        saveAssignments();
      });

      // Insert button right before the collapse button or drag handle
      const collapseBtn = header.querySelector('.ig-collapse-btn');
      const dragHandle = header.querySelector('.ig-drag-handle');

      if (collapseBtn) {
        header.insertBefore(btn, collapseBtn);
      } else if (dragHandle) {
        header.insertBefore(btn, dragHandle);
      } else {
        header.appendChild(btn);
      }
    }

    // Attach to containers and watch for new cards
    function attachToContainer(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.querySelectorAll('.ig-draggable-menu').forEach(processCard);

      const observer = new MutationObserver(() => {
        container.querySelectorAll('.ig-draggable-menu').forEach(processCard);
      });
      observer.observe(container, { childList: true, subtree: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('ig-left-menu-container');
      const right = document.getElementById('ig-right-menu-container');

      if (left && right) {
        attachToContainer('ig-left-menu-container');
        attachToContainer('ig-right-menu-container');
      } else if (attempts > 0) {
        setTimeout(() => initWatcher(attempts - 1), 200);
      }
    }

    initWatcher(10);
    console.log('[MenuPanelSwitcherModule] Switcher enabled.');
    core.emit('block:ready', { id: 'menuPanelSwitcherModule' });
  }
});

/* ============================================================
   BLOCK: Menu Card Pop-out Module (v6)
   ============================================================ */
/* ============================================================
   BLOCK: Menu Card Pop-out Module (v6 - Draggable Icons & Emojis)
   ============================================================ */
LegoCore.registerBlock({
  id: 'menuInPagePopoutModule',
  init(core) {
    const STORAGE_KEY = 'ig_menu_inpage_popouts_v1';
    let popoutStates = {};

    try {
      popoutStates = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
      popoutStates = {};
    }

    function saveStates() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(popoutStates));
      } catch (e) {}
    }

    // Helper to extract an emoji or the first letter from a title
    function extractIcon(text) {
      if (!text) return '⠿';
      const emojiMatch = text.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u);
      if (emojiMatch) return emojiMatch[0];
      const charMatch = text.match(/[A-Za-z0-9]/);
      if (charMatch) return charMatch[0].toUpperCase();
      return '⠿';
    }

    // Inject CSS for popout button, floating window chrome, and iconified state
    const style = document.createElement('style');
    style.id = 'ig-inpage-popout-styles';
    style.innerHTML = `
      .ig-popout-btn {
        background: transparent;
        border: none;
        color: var(--igls-text-dim, #96949c);
        cursor: pointer;
        font-size: 11px;
        font-weight: bold;
        line-height: 1;
        padding: 2px 4px;
        margin-left: 4px;
        border-radius: 3px;
        transition: color 0.2s, background 0.2s;
      }
      .ig-popout-btn:hover {
        color: var(--igls-accent, #c9a876);
        background: rgba(255, 255, 255, 0.08);
      }

      .ig-draggable-menu.is-popped-out {
        display: none !important;
      }

      .ig-floating-modal {
        position: fixed;
        z-index: 2147483647;
        background: var(--igls-surface, #17171d);
        border: 1px solid var(--igls-border-strong, rgba(255,255,255,0.2));
        border-radius: 12px;
        box-shadow: 0 16px 40px rgba(0,0,0,0.6);
        display: flex;
        flex-direction: column;
        min-width: 220px;
        max-width: 95vw;
        min-height: 150px;
        max-height: 95vh;
        overflow: hidden;
        transition: border-radius 0.2s;
      }

      .ig-floating-modal .ig-menu-header {
        background: var(--igls-bg, #131318);
        border-bottom: 1px solid var(--igls-border, rgba(255,255,255,0.07));
        padding: 10px 12px;
        cursor: grab;
        flex-shrink: 0;
      }
      .ig-floating-modal .ig-menu-header:active {
        cursor: grabbing;
      }

      .ig-floating-modal .ig-menu-content {
        padding: 12px;
        overflow: auto;
        flex: 1;
        min-height: 0;
        min-width: 0;
        resize: none;
      }

      /* Resizers */
      .ig-floating-resizer { position: absolute; top: 0; width: 6px; height: 100%; cursor: ew-resize; z-index: 2; }
      .ig-floating-resizer.left { left: 0; }
      .ig-floating-resizer.right { right: 0; }
      .ig-floating-resizer:hover, .ig-floating-resizer.active { background: rgba(201, 168, 118, 0.3); }

      .ig-floating-resizer-bottom { position: absolute; left: 0; bottom: 0; width: 100%; height: 6px; cursor: ns-resize; z-index: 2; }
      .ig-floating-resizer-bottom:hover, .ig-floating-resizer-bottom.active { background: rgba(201, 168, 118, 0.3); }

      .ig-floating-resizer-corner { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 3; }
      .ig-floating-resizer-corner::after {
        content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
        background: linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.35) 50%); border-radius: 1px;
      }
      .ig-floating-resizer-corner:hover::after, .ig-floating-resizer-corner.active::after {
        background: linear-gradient(135deg, transparent 50%, var(--igls-accent, #c9a876) 50%);
      }

      /* === MINIMIZED (TINY ICON) STATE === */
      .ig-floating-modal.is-iconified {
        width: 45px !important;
        height: 45px !important;
        min-width: 0 !important;
        min-height: 0 !important;
        border-radius: 12px;
        cursor: grab;
      }
      .ig-floating-modal.is-iconified:active {
        cursor: grabbing;
      }
      /* Hide all normal contents when iconified */
      .ig-floating-modal.is-iconified > * {
        display: none !important;
      }
      /* Show the extracted Emoji/Letter */
      .ig-floating-modal.is-iconified::before {
        content: attr(data-icon);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        font-size: 20px;
        color: var(--igls-accent, #c9a876);
        background: var(--igls-surface, #17171d);
        border-radius: 11px; /* inner radius */
      }
      .ig-floating-modal.is-iconified:hover::before {
        background: var(--igls-surface-2, #1c1c23);
      }
    `;
    document.head.appendChild(style);

    function createFloatingWindow(card) {
      const key = card.dataset.key;
      if (document.getElementById('ig-float-modal-' + key)) return;

      const savedPos = popoutStates[key] || { top: 100, left: 200 };
      const savedWidth = savedPos.width || 300;
      const savedHeight = savedPos.height || null;

      const modal = document.createElement('div');
      modal.className = 'ig-floating-modal';
      modal.id = 'ig-float-modal-' + key;
      modal.style.top = savedPos.top + 'px';
      modal.style.left = savedPos.left + 'px';
      modal.style.width = savedWidth + 'px';
      if (savedHeight) modal.style.height = savedHeight + 'px';
      modal.style.position = 'fixed';

      // Extract Icon and set it for minimized mode
      const titleSpan = card.querySelector('.ig-menu-header span:first-child');
      const icon = extractIcon(titleSpan ? titleSpan.innerText : key);
      modal.setAttribute('data-icon', icon);

      // Restore iconified state if saved
      if (savedPos.iconified) {
        modal.classList.add('is-iconified');
      }

      const header = card.querySelector('.ig-menu-header').cloneNode(true);
      const content = card.querySelector('.ig-menu-content');

      // Swap popout button for dock back button
      const popBtn = header.querySelector('.ig-popout-btn');
      if (popBtn) {
        popBtn.innerText = '📥';
        popBtn.title = 'Dock back to sidebar';
        popBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          dockBack(card, key);
        });
      }

      // Hide side panel control buttons on float header
      const switchBtn = header.querySelector('.ig-switch-panel-btn');
      if (switchBtn) switchBtn.style.display = 'none';

      // Attach listener to minimize button
      const collapseBtn = header.querySelector('.ig-collapse-btn');
      if (collapseBtn) {
        collapseBtn.innerText = '−';
        collapseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          modal.classList.add('is-iconified');
          popoutStates[key] = Object.assign({}, popoutStates[key], { iconified: true });
          saveStates();
        });
      }

      modal.appendChild(header);
      modal.appendChild(content);

      const leftResizer = document.createElement('div');
      leftResizer.className = 'ig-floating-resizer left';
      const rightResizer = document.createElement('div');
      rightResizer.className = 'ig-floating-resizer right';
      const bottomResizer = document.createElement('div');
      bottomResizer.className = 'ig-floating-resizer-bottom';
      const cornerResizer = document.createElement('div');
      cornerResizer.className = 'ig-floating-resizer-corner';
      modal.appendChild(leftResizer);
      modal.appendChild(rightResizer);
      modal.appendChild(bottomResizer);
      modal.appendChild(cornerResizer);

      document.body.appendChild(modal);
      card.classList.add('is-popped-out');

      makeModalDraggable(modal, key);
      makeModalResizable(modal, leftResizer, rightResizer, bottomResizer, cornerResizer, key);
    }

    function dockBack(card, key) {
      const modal = document.getElementById('ig-float-modal-' + key);
      if (!modal) return;

      const content = modal.querySelector('.ig-menu-content');
      if (content) {
        card.appendChild(content);
      }

      modal.remove();
      card.classList.remove('is-popped-out');

      delete popoutStates[key];
      saveStates();
    }

    // Completely rewritten to handle dragging from both header AND the minimized icon
    function makeModalDraggable(modal, key) {
      let isDragging = false;
      let startX, startY, initLeft, initTop;
      let moved = false; // Used to distinguish between a "click" and a "drag"

      modal.addEventListener('mousedown', (e) => {
        // Only accept left-click and ignore nested buttons (like minimize, dock, etc)
        if (e.button !== 0 || e.target.closest('button')) return;

        const isHeaderClick = e.target.closest('.ig-menu-header');
        const isIconified = modal.classList.contains('is-iconified');

        // Only start drag if we click the header, OR if the whole window is currently a tiny icon
        if (!isHeaderClick && !isIconified) return;

        isDragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        initLeft = modal.offsetLeft;
        initTop = modal.offsetTop;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
      });

      function onMouseMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        // If mouse moves more than 3px, we register this as a drag, not a click
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          moved = true;
        }

        modal.style.left = (initLeft + dx) + 'px';
        modal.style.top = (initTop + dy) + 'px';
      }

      function onMouseUp(e) {
        if (!isDragging) return;
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        const isIconified = modal.classList.contains('is-iconified');

        // If it was a tiny icon and we didn't drag it around, it was a click to Expand
        if (isIconified && !moved) {
          modal.classList.remove('is-iconified');
          popoutStates[key] = Object.assign({}, popoutStates[key], { iconified: false });
        } else {
          // Otherwise, just save its new position
          popoutStates[key] = Object.assign({}, popoutStates[key], {
            top: modal.offsetTop,
            left: modal.offsetLeft
          });
        }
        saveStates();
      }
    }

    function makeModalResizable(modal, leftResizer, rightResizer, bottomResizer, cornerResizer, key) {
      const MIN_WIDTH = 220;
      const MIN_HEIGHT = 150;

      function startResize(mode) {
        return function (e) {
          if (e.button !== 0 || modal.classList.contains('is-iconified')) return;
          e.preventDefault();
          e.stopPropagation();

          const startX = e.clientX;
          const startY = e.clientY;
          const startWidth = modal.offsetWidth;
          const startHeight = modal.offsetHeight;
          const startLeft = modal.offsetLeft;

          const resizerEl = mode === 'left' ? leftResizer
            : mode === 'right' ? rightResizer
            : mode === 'bottom' ? bottomResizer
            : cornerResizer;
          resizerEl.classList.add('active');

          function onMove(ev) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;

            if (mode === 'right' || mode === 'corner') {
              const newWidth = Math.max(MIN_WIDTH, startWidth + dx);
              modal.style.width = newWidth + 'px';
            } else if (mode === 'left') {
              const newWidth = Math.max(MIN_WIDTH, startWidth - dx);
              const widthDelta = newWidth - startWidth;
              modal.style.width = newWidth + 'px';
              modal.style.left = (startLeft - widthDelta) + 'px';
            }

            if (mode === 'bottom' || mode === 'corner') {
              const newHeight = Math.max(MIN_HEIGHT, startHeight + dy);
              modal.style.height = newHeight + 'px';
            }
          }

          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            resizerEl.classList.remove('active');

            popoutStates[key] = Object.assign({}, popoutStates[key], {
              top: modal.offsetTop,
              left: modal.offsetLeft,
              width: modal.offsetWidth,
              height: modal.offsetHeight
            });
            saveStates();
          }

          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        };
      }

      leftResizer.addEventListener('mousedown', startResize('left'));
      rightResizer.addEventListener('mousedown', startResize('right'));
      bottomResizer.addEventListener('mousedown', startResize('bottom'));
      cornerResizer.addEventListener('mousedown', startResize('corner'));
    }

    function processCard(card) {
      if (!card || !card.dataset) return;
      const key = card.dataset.key;
      const header = card.querySelector('.ig-menu-header');
      if (!header || !key || header.querySelector('.ig-popout-btn')) return;

      const btn = document.createElement('button');
      btn.className = 'ig-popout-btn';
      btn.title = 'Pop out as floating window';
      btn.innerText = '⧉';

      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        createFloatingWindow(card);
        popoutStates[key] = popoutStates[key] || { top: 120, left: 220, width: 300, iconified: false };
        saveStates();
      });

      const switchBtn = header.querySelector('.ig-switch-panel-btn');
      const collapseBtn = header.querySelector('.ig-collapse-btn');
      const dragHandle = header.querySelector('.ig-drag-handle');

      if (switchBtn) {
        header.insertBefore(btn, switchBtn);
      } else if (collapseBtn) {
        header.insertBefore(btn, collapseBtn);
      } else if (dragHandle) {
        header.insertBefore(btn, dragHandle);
      } else {
        header.appendChild(btn);
      }

      if (popoutStates[key]) {
        setTimeout(() => createFloatingWindow(card), 100);
      }
    }

    function attachToContainer(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.querySelectorAll('.ig-draggable-menu').forEach(processCard);
      const observer = new MutationObserver(() => {
        container.querySelectorAll('.ig-draggable-menu').forEach(processCard);
      });
      observer.observe(container, { childList: true, subtree: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('ig-left-menu-container');
      const right = document.getElementById('ig-right-menu-container');

      if (left && right) {
        attachToContainer('ig-left-menu-container');
        attachToContainer('ig-right-menu-container');
      } else if (attempts > 0) {
        setTimeout(() => initWatcher(attempts - 1), 200);
      }
    }

    initWatcher(10);
    console.log('[MenuInPagePopoutModule] Floating windows enabled (with draggable emoji icons).');
    core.emit('block:ready', { id: 'menuInPagePopoutModule' });
  }
});

/* ============================================================
   BLOCK: Header Toolbar Organizer Module (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Header Toolbar Organizer Module (v2 - No Move Handle)
   ============================================================ */
/* ================================================================
   BLOCK: Header Toolbar Organizer (Standalone Feature Plugin)
   - Removes the redundant move/drag handle icon
   - Groups remaining action buttons (Pop-out, Switch, Collapse)
     into a clean, unified toolbar pill
   - Retains full drag-reorder functionality on the header area
================================================================ */
LegoCore.registerBlock({
  id: 'headerToolbarOrganizerModule',
  init(core) {
    // Inject CSS to restyle buttons and hide old drag icons
    const style = document.createElement('style');
    style.id = 'ig-header-toolbar-styles';
    style.innerHTML = `
      /* Hide standalone move/drag handle icons across all menus */
      .ig-drag-handle {
        display: none !important;
      }

      /* Unified Header Toolbar Container */
      .ig-card-toolbar {
        display: flex;
        align-items: center;
        gap: 2px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--igls-border, rgba(255, 255, 255, 0.08));
        border-radius: 6px;
        padding: 2px;
        margin-left: auto;
      }

      /* Base Style for All Action Buttons inside Toolbar */
      .ig-card-toolbar button,
      .ig-card-toolbar .ig-popout-btn,
      .ig-card-toolbar .ig-switch-panel-btn,
      .ig-card-toolbar .ig-collapse-btn {
        background: transparent !important;
        border: none !important;
        color: var(--igls-text-dim, #96949c) !important;
        cursor: pointer !important;
        font-size: 11px !important;
        line-height: 1 !important;
        padding: 4px 6px !important;
        margin: 0 !important;
        border-radius: 4px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        transition: color 0.15s, background 0.15s !important;
      }

      .ig-card-toolbar button:hover,
      .ig-card-toolbar .ig-popout-btn:hover,
      .ig-card-toolbar .ig-switch-panel-btn:hover,
      .ig-card-toolbar .ig-collapse-btn:hover {
        color: var(--igls-accent, #c9a876) !important;
        background: rgba(255, 255, 255, 0.1) !important;
      }
    `;
    document.head.appendChild(style);

    function organizeCardHeader(card) {
      const header = card.querySelector('.ig-menu-header');
      if (!header) return;

      // 1. Remove/hide existing move handles
      const dragHandle = header.querySelector('.ig-drag-handle');
      if (dragHandle) {
        dragHandle.remove();
      }

      // 2. Check or create toolbar container
      let toolbar = header.querySelector('.ig-card-toolbar');
      if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.className = 'ig-card-toolbar';
        header.appendChild(toolbar);
      }

      // 3. Collect action buttons
      const popBtn = header.querySelector('.ig-popout-btn');
      const switchBtn = header.querySelector('.ig-switch-panel-btn');
      const collapseBtn = header.querySelector('.ig-collapse-btn');

      // 4. Move controls into the toolbar pill
      if (popBtn && popBtn.parentElement !== toolbar) toolbar.appendChild(popBtn);
      if (switchBtn && switchBtn.parentElement !== toolbar) toolbar.appendChild(switchBtn);
      if (collapseBtn && collapseBtn.parentElement !== toolbar) toolbar.appendChild(collapseBtn);
    }

    function attachToContainer(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.querySelectorAll('.ig-draggable-menu').forEach(organizeCardHeader);

      const observer = new MutationObserver(() => {
        container.querySelectorAll('.ig-draggable-menu').forEach(organizeCardHeader);
      });
      observer.observe(container, { childList: true, subtree: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('ig-left-menu-container');
      const right = document.getElementById('ig-right-menu-container');

      if (left && right) {
        attachToContainer('ig-left-menu-container');
        attachToContainer('ig-right-menu-container');
      } else if (attempts > 0) {
        setTimeout(() => initWatcher(attempts - 1), 200);
      }
    }

    initWatcher(10);
    console.log('[HeaderToolbarOrganizerModule] Move button removed & controls organized.');
    core.emit('block:ready', { id: 'headerToolbarOrganizerModule' });
  }
});

/* ============================================================
   BLOCK: Workspace Profile & Visibility Manager (v2)
   ============================================================ */
/* ============================================================
   BLOCK: Workspace Profile & Visibility Manager (With Plugin Dock)
   ============================================================ */
LegoCore.registerBlock({
  id: 'profileManagerModule',
  init(core) {
    const STORAGE_KEY = 'ig_workspace_profiles_v1';
    const POS_STORAGE_KEY = 'ig_workspace_profile_window_pos_v1';

    let profileData = {
      activeProfile: 'Default',
      profiles: {
        'Default': {},
        'Quick Message Only': { 'audio-quick': true, 'audio-rec': false, 'audio-lib': false, 'command-center-launcher': false },
        'Studio Workstation': { 'audio-quick': false, 'audio-rec': true, 'audio-lib': true, 'command-center-launcher': true },
        'Library Focus': { 'audio-quick': false, 'audio-rec': false, 'audio-lib': true, 'command-center-launcher': true }
      },
      hiddenCards: {}
    };

    let windowPos = { top: 60, left: 90 };

    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved) profileData = Object.assign(profileData, saved);

      const savedPos = JSON.parse(localStorage.getItem(POS_STORAGE_KEY));
      if (savedPos && typeof savedPos.top === 'number' && typeof savedPos.left === 'number') {
        windowPos = savedPos;
      }
    } catch (e) {}

    function saveProfiles() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profileData)); } catch (e) {}
    }

    function saveWindowPosition(top, left) {
      windowPos = { top, left };
      try { localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(windowPos)); } catch (e) {}
    }

    const style = document.createElement('style');
    style.id = 'ig-profile-manager-styles';
    style.innerHTML = `
      .ig-profile-btn {
        background: var(--igls-surface-2, #1c1c23); color: var(--igls-accent, #c9a876);
        border: 1px solid var(--igls-border-strong, rgba(255,255,255,0.14));
        padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 600;
        cursor: pointer; transition: filter 0.2s, border-color 0.2s; margin-left: auto;
      }
      .ig-profile-btn:hover { filter: brightness(1.2); border-color: var(--igls-accent, #c9a876); }
      .ig-draggable-menu.is-profile-hidden { display: none !important; }
      .ig-profile-floating-window {
        position: fixed; width: 320px; z-index: 2147483647; background: var(--igls-surface, #17171d);
        border: 1px solid var(--igls-border-strong, rgba(255,255,255,0.2)); border-radius: 10px;
        padding: 12px; color: var(--igls-text, #ece9e4); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 10px 30px rgba(0,0,0,0.7); display: flex; flex-direction: column; gap: 10px;
      }
      .ig-profile-floating-header {
        display: flex; justify-content: space-between; align-items: center; font-size: 12px;
        font-weight: bold; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; cursor: grab; user-select: none;
      }
      .ig-profile-floating-header:active { cursor: grabbing; }
      .ig-profile-section { display: flex; flex-direction: column; gap: 6px; }
      .ig-profile-section-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--igls-text-dim, #96949c); }
      .ig-profile-select-row { display: flex; gap: 4px; align-items: center; }
      .ig-profile-select-row select { flex: 1; background: #111; color: #fff; border: 1px solid #333; border-radius: 5px; padding: 4px; font-size: 11px; }
      .ig-profile-action-btn { background: var(--igls-surface-2, #1c1c23); color: var(--igls-text, #fff); border: 1px solid #333; border-radius: 5px; padding: 4px 6px; font-size: 10px; font-weight: 600; cursor: pointer; white-space: nowrap; }
      .ig-profile-action-btn:hover { background: rgba(255,255,255,0.1); }
      .ig-profile-action-btn--danger { color: #f43f5e; border-color: rgba(244, 63, 94, 0.3); }
      .ig-profile-action-btn--danger:hover { background: rgba(244, 63, 94, 0.15); }
      .ig-card-toggle-list { display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow-y: auto; background: rgba(0,0,0,0.25); padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05); }
      .ig-card-toggle-item { display: flex; align-items: center; font-size: 11px; padding: 2px 4px; border-radius: 3px; }
      .ig-card-toggle-item:hover { background: rgba(255,255,255,0.05); }
      .ig-card-toggle-item label { display: flex; align-items: center; gap: 6px; cursor: pointer; flex: 1; }
    `;
    document.head.appendChild(style);

    function applyVisibility() {
      const allCards = document.querySelectorAll('.ig-draggable-menu');
      allCards.forEach(card => {
        const key = card.dataset.key;
        if (!key) return;
        card.classList.toggle('is-profile-hidden', !!profileData.hiddenCards[key]);
      });
    }

    function openProfileWindow() {
      const existing = document.getElementById('ig-profile-floating-window');
      if (existing) { existing.remove(); return; }

      const win = document.createElement('div');
      win.id = 'ig-profile-floating-window';
      win.className = 'ig-profile-floating-window';
      win.style.top = windowPos.top + 'px';
      win.style.left = windowPos.left + 'px';

      const header = document.createElement('div');
      header.className = 'ig-profile-floating-header';
      header.innerHTML = '<span>⚙️ Workspace Profiles</span>';

      const closeBtn = document.createElement('button');
      closeBtn.innerText = '✕';
      closeBtn.style.cssText = 'background:none; border:none; color:#999; cursor:pointer; font-size:12px;';
      closeBtn.onclick = () => win.remove();
      header.appendChild(closeBtn);

      const secProfiles = document.createElement('div');
      secProfiles.className = 'ig-profile-section';
      secProfiles.innerHTML = '<span class="ig-profile-section-title">Active Profile</span>';

      const rowSelect = document.createElement('div');
      rowSelect.className = 'ig-profile-select-row';

      const select = document.createElement('select');
      Object.keys(profileData.profiles).forEach(pName => {
        const opt = document.createElement('option');
        opt.value = pName; opt.innerText = pName;
        if (pName === profileData.activeProfile) opt.selected = true;
        select.appendChild(opt);
      });

      const newBtn = document.createElement('button');
      newBtn.className = 'ig-profile-action-btn'; newBtn.innerText = '➕ New';

      const delBtn = document.createElement('button');
      delBtn.className = 'ig-profile-action-btn ig-profile-action-btn--danger'; delBtn.innerText = '🗑️';

      if (profileData.activeProfile === 'Default') {
        delBtn.disabled = true; delBtn.style.opacity = '0.3'; delBtn.style.cursor = 'not-allowed';
      }

      rowSelect.appendChild(select); rowSelect.appendChild(newBtn); rowSelect.appendChild(delBtn);
      secProfiles.appendChild(rowSelect);

      const secToggles = document.createElement('div');
      secToggles.className = 'ig-profile-section';
      secToggles.innerHTML = '<span class="ig-profile-section-title">Visible Modules</span>';

      const toggleList = document.createElement('div');
      toggleList.className = 'ig-card-toggle-list';

      const allCards = Array.from(document.querySelectorAll('.ig-draggable-menu'));
      allCards.forEach(card => {
        const key = card.dataset.key;
        if (!key) return;
        const titleSpan = card.querySelector('.ig-menu-header span');
        const title = titleSpan ? titleSpan.innerText.trim() : key;

        const item = document.createElement('div');
        item.className = 'ig-card-toggle-item';

        const label = document.createElement('label');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = !profileData.hiddenCards[key];

        chk.onchange = () => {
          profileData.hiddenCards[key] = !chk.checked;
          applyVisibility(); saveProfiles();
        };

        label.appendChild(chk); label.appendChild(document.createTextNode(' ' + title));
        item.appendChild(label); toggleList.appendChild(item);
      });

      secToggles.appendChild(toggleList);

      select.onchange = () => {
        const chosen = select.value;
        profileData.activeProfile = chosen;
        const presetRules = profileData.profiles[chosen] || {};
        Object.keys(presetRules).forEach(key => profileData.hiddenCards[key] = !presetRules[key]);
        applyVisibility(); saveProfiles(); win.remove(); openProfileWindow();
      };

      newBtn.onclick = () => {
        const name = prompt('Enter a name for your new workspace profile:');
        if (!name || !name.trim()) return;
        const newName = name.trim();
        const currentRules = {};
        allCards.forEach(card => {
          if (card.dataset.key) currentRules[card.dataset.key] = !profileData.hiddenCards[card.dataset.key];
        });
        profileData.profiles[newName] = currentRules;
        profileData.activeProfile = newName;
        saveProfiles(); win.remove(); openProfileWindow();
      };

      delBtn.onclick = () => {
        const current = profileData.activeProfile;
        if (current === 'Default') return;
        if (confirm(`Are you sure you want to delete profile "${current}"?`)) {
          delete profileData.profiles[current];
          profileData.activeProfile = 'Default';
          profileData.hiddenCards = {};
          applyVisibility(); saveProfiles(); win.remove(); openProfileWindow();
        }
      };

      win.appendChild(header);
      win.appendChild(secProfiles);
      win.appendChild(secToggles);

      // Extension Container for other plugins to dock into
      const extContainer = document.createElement('div');
      extContainer.id = 'ig-profile-extensions-container';
      extContainer.style.cssText = 'display:flex; flex-direction:column; gap:10px; margin-top:5px; border-top:1px solid rgba(255,255,255,0.1); padding-top:10px;';
      win.appendChild(extContainer);

      document.body.appendChild(win);
      makeDraggable(win, header);

      // Emit event so other modules know the window is open and can dock UI into extContainer
      core.emit('profile-window:opened', { container: extContainer });
    }

    function makeDraggable(element, handle) {
      let isDragging = false, startX, startY, initLeft, initTop;
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.tagName === 'BUTTON') return;
        isDragging = true; startX = e.clientX; startY = e.clientY;
        initLeft = element.offsetLeft; initTop = element.offsetTop;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
      });
      function onMouseMove(e) {
        if (!isDragging) return;
        element.style.left = (initLeft + (e.clientX - startX)) + 'px';
        element.style.top = (initTop + (e.clientY - startY)) + 'px';
      }
      function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        saveWindowPosition(element.offsetTop, element.offsetLeft);
      }
    }

    function injectHeaderButtons() {
      const targets = [document.getElementById('ig-modular-left-panel'), document.getElementById('ig-modular-right-panel')];
      targets.forEach(panel => {
        if (!panel) return;
        const pHeader = panel.querySelector('.ig-panel-header');
        if (!pHeader || pHeader.querySelector('.ig-profile-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'ig-profile-btn'; btn.innerText = '⚙️ Profiles';
        btn.onclick = (e) => { e.stopPropagation(); openProfileWindow(); };
        const hideBtn = pHeader.querySelector('.ig-hide-btn');
        if (hideBtn) pHeader.insertBefore(btn, hideBtn); else pHeader.appendChild(btn);
      });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('ig-left-menu-container');
      const right = document.getElementById('ig-right-menu-container');
      if (left && right) {
        injectHeaderButtons(); applyVisibility();
        const observer = new MutationObserver(() => { injectHeaderButtons(); applyVisibility(); });
        observer.observe(left, { childList: true, subtree: true });
        observer.observe(right, { childList: true, subtree: true });
      } else if (attempts > 0) setTimeout(() => initWatcher(attempts - 1), 200);
    }

    initWatcher(10);
    core.emit('block:ready', { id: 'profileManagerModule' });
  }
});

/* ============================================================
   BLOCK: Instagram Resizer Feature (v3)
   ============================================================ */
/* ============================================================
   BLOCK: Instagram Resizer Feature (Profile Window UI + Precision Controls)
   ============================================================ */
LegoCore.registerBlock({
  id: 'igPageResizerFeature',
  init(core) {
    const STATE_KEY = 'ig_page_resizer_state_v2';

    let resizerState = JSON.parse(localStorage.getItem(STATE_KEY)) || {
      enabled: false, editing: false, leftWidth: 156, rightWidth: 248, leftOffset: null, rightOffset: null
    };

    function saveState() {
      localStorage.setItem(STATE_KEY, JSON.stringify(resizerState));
    }

    function recalculateOffsets() {
      const leftPanel = document.getElementById('ig-modular-left-panel');
      const rightPanel = document.getElementById('ig-modular-right-panel');
      let sidebarL = 0; let sidebarR = 0;

      if (leftPanel) {
        const leftHidden = leftPanel.style.left && leftPanel.style.left.startsWith('-');
        sidebarL = leftHidden ? 0 : leftPanel.offsetWidth;
      }
      if (rightPanel) {
        const rightHidden = rightPanel.style.right && rightPanel.style.right.startsWith('-');
        sidebarR = rightHidden ? 0 : rightPanel.offsetWidth;
      }

      resizerState.leftOffset = resizerState.leftWidth - sidebarL;
      resizerState.rightOffset = resizerState.rightWidth - sidebarR;
      saveState();
    }

    const style = document.createElement('style');
    style.id = 'ig-page-resizer-feature-styles';
    style.innerHTML = `
      .ig-resizer-status { font-size: 11px; color: var(--igls-text-dim, #96949c); }
      .ig-resizer-status.is-on { color: #10b981; font-weight: bold; }
      .ig-resizer-status.is-off { color: #f43f5e; font-weight: bold; }
      .ig-interactive-handle {
        position: fixed; top: 0; width: 12px; height: 100vh; z-index: 2147483646;
        cursor: ew-resize; background: rgba(201, 168, 118, 0.15);
        border: 1px dashed var(--igls-accent, #c9a876); display: none;
      }
      .ig-interactive-handle.is-visible { display: block; }
      #ig-interactive-left-handle { left: ${resizerState.leftWidth - 6}px; }
      #ig-interactive-right-handle { right: ${resizerState.rightWidth - 6}px; }
      .ig-resizer-btn-row { display: flex; gap: 6px; }
      .ig-resizer-code-btn {
        background: var(--igls-surface-2, #1c1c23); color: var(--igls-text, #ece9e4);
        border: 1px solid var(--igls-border-strong, rgba(255,255,255,0.14));
        border-radius: 6px; padding: 5px 8px; font-size: 10px; font-weight: 600; cursor: pointer;
        transition: background 0.15s, border-color 0.15s; flex: 1;
      }
      .ig-resizer-code-btn:hover { background: rgba(255,255,255,0.1); border-color: var(--igls-accent, #c9a876); }

      /* Precision Controls UI */
      .ig-prec-container {
        font-size: 10px; color: var(--igls-text-dim, #96949c);
        display: flex; justify-content: space-between; align-items: center;
        background: rgba(0,0,0,0.25); padding: 8px; border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.05);
      }
      .ig-prec-btn {
        background: var(--igls-surface-2, #1c1c23); color: var(--igls-text, #ece9e4);
        border: 1px solid var(--igls-border-strong, rgba(255,255,255,0.14));
        border-radius: 4px; width: 22px; height: 22px; font-size: 14px; font-weight: bold;
        cursor: pointer; display: flex; justify-content: center; align-items: center;
        user-select: none; transition: background 0.1s, transform 0.1s;
      }
      .ig-prec-btn:active { background: var(--igls-accent, #c9a876); color: #000; transform: scale(0.95); }
    `;
    document.head.appendChild(style);

    const leftHandle = document.createElement('div');
    leftHandle.id = 'ig-interactive-left-handle';
    leftHandle.className = 'ig-interactive-handle';
    document.body.appendChild(leftHandle);

    const rightHandle = document.createElement('div');
    rightHandle.id = 'ig-interactive-right-handle';
    rightHandle.className = 'ig-interactive-handle';
    document.body.appendChild(rightHandle);

    const layoutStyle = document.createElement('style');
    layoutStyle.id = 'ig-page-resizer-layout-styles';
    document.head.appendChild(layoutStyle);

    function applyPageDimensions() {
      const lw = resizerState.leftWidth;
      const rw = resizerState.rightWidth;

      leftHandle.style.left = (lw - 6) + 'px';
      rightHandle.style.right = (rw - 6) + 'px';

      if (resizerState.enabled && resizerState.editing) {
        leftHandle.classList.add('is-visible'); rightHandle.classList.add('is-visible');
      } else {
        leftHandle.classList.remove('is-visible'); rightHandle.classList.remove('is-visible');
      }

      if (!resizerState.enabled) {
        layoutStyle.innerHTML = '';
        return;
      }

      layoutStyle.innerHTML = `
        html, body.ig-modular-active { width: 100vw !important; height: 100vh !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; }
        body.ig-modular-active { position: relative !important; background-color: #000 !important; }
        body.ig-modular-active #react-root, body.ig-modular-active div[data-testid="mw-direct-inbox"], body.ig-modular-active main {
          position: absolute !important; top: 0 !important; left: ${lw}px !important;
          width: calc(100vw - ${lw}px - ${rw}px) !important; height: 100vh !important;
          max-width: none !important; max-height: none !important; overflow: auto !important;
        }
      `;
    }

    function updateCardUI() {
      const toggleResizingBtn = document.getElementById('ig-toggle-resizing-btn');
      if (!toggleResizingBtn) return;

      const toggleEditingBtn = document.getElementById('ig-toggle-editing-btn');
      const statusText = document.getElementById('ig-resizer-status-text');
      const valLeft = document.getElementById('ig-val-left');
      const valRight = document.getElementById('ig-val-right');

      toggleResizingBtn.innerText = resizerState.enabled ? '🔴 Turn Resizing Off' : '🟢 Activate Resizing';
      toggleEditingBtn.innerText = resizerState.editing ? '🔒 Lock Editing' : '✏️ Edit Resizing';
      toggleEditingBtn.style.background = resizerState.editing ? '#f43f5e' : 'var(--igls-surface-2, #1c1c23)';
      toggleEditingBtn.style.color = resizerState.editing ? '#fff' : 'var(--igls-text, #ece9e4)';
      statusText.innerText = `Status: ${resizerState.enabled ? (resizerState.editing ? 'RESIZING ACTIVE (Editing)' : 'RESIZING ACTIVE (Locked)') : 'RESIZING OFF'}`;
      statusText.className = `ig-resizer-status ${resizerState.enabled ? 'is-on' : 'is-off'}`;

      valLeft.innerText = resizerState.leftWidth;
      valRight.innerText = resizerState.rightWidth;
    }

    core.on('profile-window:opened', ({ container }) => {
      const section = document.createElement('div');
      section.className = 'ig-profile-section';

      section.innerHTML = `
        <span class="ig-profile-section-title">Webpage Resizer</span>
        <div class="ig-resizer-status ${resizerState.enabled ? 'is-on' : 'is-off'}" id="ig-resizer-status-text">
          Status: ${resizerState.enabled ? (resizerState.editing ? 'RESIZING ACTIVE (Editing)' : 'RESIZING ACTIVE (Locked)') : 'RESIZING OFF'}
        </div>
        <div class="ig-resizer-btn-row">
          <button class="ig-profile-action-btn" id="ig-toggle-resizing-btn" style="flex:1; padding:8px;"></button>
          <button class="ig-profile-action-btn" id="ig-toggle-editing-btn" style="flex:1; padding:8px;"></button>
        </div>

        <!-- Precision Taps & Hold Area -->
        <div class="ig-prec-container">
          <div style="display:flex; align-items:center; gap:4px;">
            <span style="width:24px;">Left:</span>
            <span id="ig-val-left" style="color:#fff; font-weight:bold; width:24px;">${resizerState.leftWidth}</span>
            <button class="ig-prec-btn" data-target="left" data-dir="-1">-</button>
            <button class="ig-prec-btn" data-target="left" data-dir="1">+</button>
          </div>
          <div style="display:flex; align-items:center; gap:4px;">
            <span style="width:28px;">Right:</span>
            <span id="ig-val-right" style="color:#fff; font-weight:bold; width:24px;">${resizerState.rightWidth}</span>
            <button class="ig-prec-btn" data-target="right" data-dir="-1">-</button>
            <button class="ig-prec-btn" data-target="right" data-dir="1">+</button>
          </div>
        </div>

        <div class="ig-resizer-btn-row">
          <button class="ig-resizer-code-btn" id="ig-copy-code-btn">📋 Copy Preset</button>
          <button class="ig-resizer-code-btn" id="ig-paste-code-btn">📥 Import Preset</button>
        </div>
      `;

      container.appendChild(section);
      updateCardUI();

      // Main Toggle Buttons
      document.getElementById('ig-toggle-resizing-btn').onclick = () => {
        resizerState.enabled = !resizerState.enabled;
        if (!resizerState.enabled) resizerState.editing = false;
        saveState(); applyPageDimensions(); updateCardUI();
      };

      document.getElementById('ig-toggle-editing-btn').onclick = () => {
        if (!resizerState.enabled) { alert("Please activate Resizing first before editing bounds!"); return; }
        resizerState.editing = !resizerState.editing;
        saveState(); applyPageDimensions(); updateCardUI();
      };

      // Press, Hold & Tap Logic for Precision Buttons
      let holdInterval;
      let holdTimeout;

      function adjustWidth(target, dir) {
        if (!resizerState.enabled || !resizerState.editing) return;
        if (target === 'left') {
          resizerState.leftWidth = Math.max(0, resizerState.leftWidth + dir);
        } else {
          resizerState.rightWidth = Math.max(0, resizerState.rightWidth + dir);
        }
        applyPageDimensions();
        updateCardUI();
      }

      container.querySelectorAll('.ig-prec-btn').forEach(btn => {
        const target = btn.getAttribute('data-target');
        const dir = parseInt(btn.getAttribute('data-dir'));

        const startHold = (e) => {
          if (e.button !== 0 && e.type === 'mousedown') return;
          if (!resizerState.enabled || !resizerState.editing) {
            alert("Unlock editing mode (✏️ Edit Resizing) first to make adjustments.");
            return;
          }
          e.preventDefault();

          adjustWidth(target, dir); // Immediate tap

          // Wait 300ms, then rapid continuous adjustment
          holdTimeout = setTimeout(() => {
            holdInterval = setInterval(() => {
              adjustWidth(target, dir);
            }, 25);
          }, 300);
        };

        const endHold = () => {
          clearTimeout(holdTimeout);
          clearInterval(holdInterval);
          if (resizerState.enabled && resizerState.editing) {
            recalculateOffsets();
            saveState();
          }
        };

        btn.addEventListener('mousedown', startHold);
        btn.addEventListener('mouseup', endHold);
        btn.addEventListener('mouseleave', endHold);
        btn.addEventListener('touchstart', startHold, {passive: false});
        btn.addEventListener('touchend', endHold);
        btn.addEventListener('touchcancel', endHold);
      });

      // Import / Export Copying
      document.getElementById('ig-copy-code-btn').onclick = () => {
        const btn = document.getElementById('ig-copy-code-btn');
        const codePayload = JSON.stringify({ leftWidth: resizerState.leftWidth, rightWidth: resizerState.rightWidth });
        navigator.clipboard.writeText(codePayload).then(() => {
          btn.innerText = '✅ Copied!'; setTimeout(() => btn.innerText = '📋 Copy Preset', 1500);
        }).catch(() => prompt('Copy this layout preset code:', codePayload));
      };

      document.getElementById('ig-paste-code-btn').onclick = () => {
        const input = prompt('Paste your layout preset code here (JSON format):');
        if (!input || !input.trim()) return;
        try {
          const parsed = JSON.parse(input.trim());
          if (typeof parsed.leftWidth === 'number' && typeof parsed.rightWidth === 'number') {
            resizerState.leftWidth = parsed.leftWidth;
            resizerState.rightWidth = parsed.rightWidth;
            recalculateOffsets();
            applyPageDimensions(); updateCardUI();
            alert('Layout preset successfully applied!');
          } else { alert('Invalid code format.'); }
        } catch (e) { alert('Failed to parse JSON code.'); }
      };
    });

    let activeDragHandle = null;

    leftHandle.addEventListener('mousedown', (e) => {
      if (!resizerState.enabled || !resizerState.editing) return;
      activeDragHandle = 'left'; e.preventDefault();
    });

    rightHandle.addEventListener('mousedown', (e) => {
      if (!resizerState.enabled || !resizerState.editing) return;
      activeDragHandle = 'right'; e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!activeDragHandle || !resizerState.enabled || !resizerState.editing) return;
      if (activeDragHandle === 'left') resizerState.leftWidth = Math.min(500, Math.max(50, e.clientX));
      else if (activeDragHandle === 'right') resizerState.rightWidth = Math.min(500, Math.max(50, window.innerWidth - e.clientX));

      applyPageDimensions();
      updateCardUI();
    });

    window.addEventListener('mouseup', () => {
      if (activeDragHandle) {
        activeDragHandle = null;
        recalculateOffsets();
      }
    });

    window.addEventListener('ig-resizer-update', (e) => {
      if (e.detail && resizerState.enabled) {
        if (resizerState.leftOffset === null) recalculateOffsets();
        resizerState.leftWidth = Math.max(0, e.detail.leftWidth + (resizerState.leftOffset || 0));
        resizerState.rightWidth = Math.max(0, e.detail.rightWidth + (resizerState.rightOffset || 0));
        saveState();
      }
      applyPageDimensions();
      updateCardUI();
    });

    if (resizerState.leftOffset === null) {
      setTimeout(recalculateOffsets, 500);
    }
    applyPageDimensions();

    console.log('[igPageResizerFeature] Profile window docked resizer + Precision Controls loaded.');
    core.emit('block:ready', { id: 'igPageResizerFeature' });
  }
});

/* ============================================================
   BLOCK: Sidebar-to-Resizer Sync (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Sidebar-to-Resizer Sync Feature (Event-Driven Bridge)
   ============================================================ */
LegoCore.registerBlock({
  id: 'igSidebarSyncFeature',
  init(core) {
    // Listen to the native 'sidebar:layout-changed' event emitted by the Dual Sidebar shell
    core.on('sidebar:layout-changed', (layout) => {
      const targetLeft = layout.leftHidden ? 0 : layout.leftWidth;
      const targetRight = layout.rightHidden ? 0 : layout.rightWidth;

      // Dispatch directly to the Resizer Plugin so it updates instantly
      window.dispatchEvent(new CustomEvent('ig-resizer-update', {
        detail: {
          leftWidth: targetLeft,
          rightWidth: targetRight
        }
      }));
    });

    console.log('[igSidebarSyncFeature] Event-driven sidebar-to-resizer sync active.');
    core.emit('block:ready', { id: 'igSidebarSyncFeature' });
  }
});

/* ============================================================
   BLOCK: Quick Chat Box (v2)
   ============================================================ */
/* ============================================================
   BLOCK: Quick Chat Box (Safe & Clean Edition)
   v2 — Sequence-aware: yields Enter/Escape and pauses Keep Focus
        while a sequence is active
   ============================================================ */
LegoCore.registerBlock({
  id: 'quickChatBoxPlugin',
  init(core) {
    const PREF_KEY = 'ig_quick_chat_prefs_v1';
    const EFFECTS_KEY = 'ig_quick_effects_enabled_v1';
    let prefs = JSON.parse(localStorage.getItem(PREF_KEY)) || { keepFocus: true };
    let effectsEnabled = localStorage.getItem(EFFECTS_KEY) !== 'false';

    const chatUI = document.createElement('div');
    chatUI.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
    chatUI.innerHTML = `
      <textarea id="ig-quick-chat-input" placeholder="Type message... (Shift+Enter for new line)"
        style="width: 100%; min-height: 65px; max-height: 250px; background: #0f172a; color: #fff; border: 1px solid #334155; border-radius: 6px; padding: 8px; font-size: 12px; resize: vertical; outline: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; box-sizing: border-box; line-height: 1.4; transition: border 0.2s;"></textarea>

      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
         <label style="color:var(--igls-text-dim, #96949c); font-size:10px; cursor:pointer; display:flex; align-items:center; gap:4px; user-select:none;">
           <input type="checkbox" id="ig-qc-keep-focus" ${prefs.keepFocus ? 'checked' : ''}> Keep Focus (Rapid Fire)
         </label>
         <label style="color:var(--igls-text-dim, #96949c); font-size:9px; cursor:pointer; display:flex; align-items:center; gap:3px; user-select:none;" title="Disables silence-trim processing on quick voice clips for faster sending">
           <input type="checkbox" id="ig-qc-effects-chk" style="width:11px; height:11px;" ${effectsEnabled ? 'checked' : ''}> Effects
         </label>
         <button id="ig-quick-chat-send" class="ig-base-btn" style="background: #10b981; color: white; border: none; border-radius: 6px; padding: 5px 12px; font-weight: bold; cursor: pointer; transition: filter 0.2s; width:auto;">📥 Paste</button>
      </div>
    `;

    const inputField = chatUI.querySelector('#ig-quick-chat-input');
    const sendBtn = chatUI.querySelector('#ig-quick-chat-send');
    const focusChk = chatUI.querySelector('#ig-qc-keep-focus');
    const effectsChk = chatUI.querySelector('#ig-qc-effects-chk');

    focusChk.onchange = (e) => { prefs.keepFocus = e.target.checked; localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); };
    effectsChk.onchange = (e) => { effectsEnabled = e.target.checked; localStorage.setItem(EFFECTS_KEY, String(effectsEnabled)); };

    inputField.addEventListener('focus', () => inputField.style.borderColor = '#6366f1');
    inputField.addEventListener('blur', () => inputField.style.borderColor = '#334155');

    function sequenceIsActive() {
      return typeof core.getActiveSequence === 'function' && !!core.getActiveSequence();
    }

    function sendMessage() {
      const liveInput = document.getElementById('ig-quick-chat-input');
      if (!liveInput) return;

      const text = liveInput.value.trim();
      if (!text) return;

      const chatZone = core.getActiveChatZone();
      if (!chatZone) {
        alert("Open an active Instagram chat window first.");
        return;
      }

      liveInput.value = '';
      const originalText = sendBtn.innerText;
      sendBtn.innerText = '✅ Pasted!';
      sendBtn.style.background = '#059669';
      setTimeout(() => { sendBtn.innerText = originalText; sendBtn.style.background = '#10b981'; }, 1000);

      chatZone.focus();
      document.execCommand('insertText', false, text);
      chatZone.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }

    sendBtn.onclick = sendMessage;
    inputField.addEventListener('keydown', (e) => {
      // SEQUENCE GATE: while a sequence is active, Enter/Escape belong to the Sequence Manager.
      if (sequenceIsActive() && (e.key === 'Enter' || e.key === 'Escape')) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    function forceQuickChatFocus() {
      if (!window.location.href.includes('/direct/')) return;
      // Don't steal focus from Instagram's composer mid-sequence (the next real Enter must land there)
      if (sequenceIsActive()) return;
      const liveInput = document.getElementById('ig-quick-chat-input');
      if (liveInput && prefs.keepFocus) liveInput.focus();
    }

    document.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || window.getSelection().toString().length > 0) return;
      setTimeout(() => {
        const active = document.activeElement;
        const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable || active.closest('[contenteditable="true"]'));
        const isInteractive = e.target.closest('button, a, select, [role="button"], [role="link"], [role="menuitem"], [role="dialog"], [role="tab"], svg');
        if (!isInput && !isInteractive && prefs.keepFocus) forceQuickChatFocus();
      }, 50);
    });

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (location.href.includes('/direct/')) setTimeout(forceQuickChatFocus, 800);
      }
    }, 500);
    setTimeout(forceQuickChatFocus, 1000);

    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') core.registerMenu('right', '💬 Quick Chat', chatUI, '⠿', 'quick-chat-box');
      else if (attemptsLeft > 0) setTimeout(() => mountCard(attemptsLeft - 1), 200);
    }

    mountCard();
    core.emit('block:ready', { id: 'quickChatBoxPlugin' });
  }
});

/* ============================================================
   BLOCK: Text Library Module (Saved Snippets) (v2)
   ============================================================ */
/* ============================================================
   BLOCK: Text Library Module (Saved Snippets) (v6 - Safe Paste Edition)
   ============================================================ */
LegoCore.registerBlock({
  id: 'textLibraryModule',
  init(core) {
    const PRO_KEY = 'ig_text_library_pro_v1';
    const FILTER_PREF_KEY = 'ig_tl_notion_filter_pos';
    const COL_PREF_KEY = 'ig_tl_col_widths_v1';

    let libraryData = JSON.parse(localStorage.getItem(PRO_KEY)) || { items: [], tags: [] };

    if (libraryData.items.length === 0) {
      const oldSnippets = JSON.parse(localStorage.getItem('ig_text_library_v1')) || [];
      if (oldSnippets.length > 0) {
        libraryData.items = oldSnippets.map((s, i) => ({
          id: 'snip_' + Date.now() + i, type: 'snippet', parentId: 'root',
          title: s.text.length > 25 ? s.text.substring(0, 25) + '...' : s.text,
          text: s.text, tags: [], order: i
        }));
        saveData();
      }
    }

    function saveData() { localStorage.setItem(PRO_KEY, JSON.stringify(libraryData)); }
    core.on('textlib:external-refresh', () => { libraryData = JSON.parse(localStorage.getItem(PRO_KEY)) || libraryData; renderTree(); }); // reload after Commands saves/edits a snippet

    let activeFolderFilter = 'All';
    let activeTagFilter = 'All';
    let filterWindowPos = JSON.parse(localStorage.getItem(FILTER_PREF_KEY)) || { top: 150, left: 350, visible: false };
    let colWidths = JSON.parse(localStorage.getItem(COL_PREF_KEY)) || { titleWidth: 50 };

    const style = document.createElement('style');
    style.id = 'ig-text-lib-table-styles';
    style.innerHTML = `
      .ig-tln-container { display: flex; flex-direction: column; gap: 8px; font-family: -apple-system, sans-serif; }
      .ig-tln-header-btns { display: flex; gap: 4px; }
      .ig-tln-hbtn { flex: 1; background: var(--igls-surface-2, #1c1c23); color: #e2e8f0; border: 1px solid #334155; border-radius: 4px; padding: 6px 4px; font-size: 10px; font-weight: bold; cursor: pointer; transition: 0.2s; }
      .ig-tln-hbtn:hover { background: #334155; color: #fff; }
      .ig-tln-hbtn.active-filter { background: #6366f1; color: white; border-color: #8b5cf6; }

      .ig-tln-tree { max-height: 350px; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; }
      .ig-tln-tree::-webkit-scrollbar { width: 4px; }
      .ig-tln-tree::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }

      .ig-tln-drop-top { border-top: 2px solid #10b981 !important; }
      .ig-tln-drop-bottom { border-bottom: 2px solid #10b981 !important; }
      .ig-tln-drop-inside { background: rgba(16, 185, 129, 0.15) !important; border: 1px dashed #10b981 !important; }

      .ig-tln-folder-head { display: flex; align-items: center; gap: 6px; font-weight: bold; font-size: 11px; color: #94a3b8; padding: 6px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.05); cursor: grab; }
      .ig-tln-folder-head:active { cursor: grabbing; }
      .ig-tln-caret { font-size: 9px; cursor: pointer; padding: 2px; width: 14px; text-align: center; transition: transform 0.2s; }
      .ig-tln-caret.collapsed { transform: rotate(-90deg); }
      .ig-tln-folder-content { display: flex; flex-direction: column; }
      .ig-tln-folder-content.collapsed { display: none; }

      .ig-tln-snippet { display: flex; flex-direction: column; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: background 0.2s; }
      .ig-tln-snippet.alt-bg { background: rgba(255,255,255,0.02); }
      .ig-tln-snippet:hover { background: rgba(255,255,255,0.06); }

      .ig-tln-row { display: flex; align-items: center; padding: 4px 6px; }
      .ig-tln-drag-grip { color: #475569; font-size: 10px; cursor: grab; margin-right: 6px; }
      .ig-tln-drag-grip:active { cursor: grabbing; }

      .ig-tln-title-col { display: flex; align-items: center; font-size: 11px; color: #f8fafc; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; gap: 4px;}

      .ig-tln-col-resizer { width: 6px; height: 18px; cursor: col-resize; background: rgba(255,255,255,0.05); border-radius: 3px; margin: 0 4px; transition: background 0.1s; flex-shrink: 0; }
      .ig-tln-col-resizer:hover, .ig-tln-col-resizer.active { background: #6366f1; }

      .ig-tln-tags { flex: 1; display: flex; gap: 4px; overflow: hidden; pointer-events: none; }
      .ig-tln-tag-pill { font-size: 9px; padding: 2px 6px; border-radius: 4px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; max-width: 100%; }

      .ig-tln-cmd-pill { font-size: 9px; padding: 2px 6px; border-radius: 4px; font-weight: 700; white-space: nowrap; background: rgba(255,255,255,0.1); color: #c9a876; flex-shrink: 0; }

      .ig-tln-actions { display: flex; gap: 2px; align-items: center; margin-left: auto; }
      .ig-tln-btn { background: transparent; border: none; color: #64748b; cursor: pointer; font-size: 11px; padding: 4px; border-radius: 4px; transition: 0.2s; }
      .ig-tln-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }

      .ig-tln-preview { font-size: 10px; color: #94a3b8; padding: 0 8px 8px 30px; line-height: 1.4; display: none; white-space: pre-wrap; word-wrap: break-word; background: rgba(0,0,0,0.2); }
      .ig-tln-preview.visible { display: block; }

      .ig-tln-filter-window {
        position: fixed; z-index: 2147483646; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(8px);
        border: 1px solid #334155; border-radius: 8px; width: 220px; padding: 12px; display: flex; flex-direction: column; gap: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5); pointer-events: auto;
      }
      .ig-tln-filter-header { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: bold; color: #fff; cursor: grab; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .ig-tln-filter-header:active { cursor: grabbing; }

      .ig-tlp-modal-overlay { position: fixed; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,0.6); z-index: 2147483647; display: flex; justify-content: center; align-items: center; }
      .ig-tlp-modal { background: #0f172a; border: 1px solid #334155; border-radius: 8px; width: 320px; padding: 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
      .ig-tlp-modal h3 { margin: 0; font-size: 14px; color: #fff; }
      .ig-tlp-input { width: 100%; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 8px; border-radius: 4px; font-size: 12px; box-sizing: border-box; outline: none; }
      .ig-tlp-input:focus { border-color: #6366f1; }
    `;
    document.head.appendChild(style);

    function hexToRgba(hex, alpha) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // SAFE PASTE (NO SYNTHETIC ENTER)
    function injectText(text) {
      const chatZone = core.getActiveChatZone(); 
      if (!chatZone) { alert("Open an active Instagram chat window first."); return; }

      chatZone.focus();
      document.execCommand('insertText', false, text);
      chatZone.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }

    const libUI = document.createElement('div');
    libUI.className = 'ig-tln-container';
    libUI.innerHTML = `
      <div class="ig-tln-header-btns">
        <button id="ig-tlc-new-snip" class="ig-tln-hbtn">📝 New</button>
        <button id="ig-tlc-new-fold" class="ig-tln-hbtn">📁 Fold</button>
        <button id="ig-tlc-filter-btn" class="ig-tln-hbtn ${filterWindowPos.visible ? 'active-filter' : ''}">🔍 Filter</button>
      </div>
      <div id="ig-tlc-tree-root" class="ig-tln-tree"></div>
    `;

    function buildFilterWindow() {
      if (document.getElementById('ig-tln-filter-win')) return;

      const win = document.createElement('div');
      win.id = 'ig-tln-filter-win';
      win.className = 'ig-tln-filter-window';
      win.style.top = filterWindowPos.top + 'px';
      win.style.left = filterWindowPos.left + 'px';
      win.style.display = filterWindowPos.visible ? 'flex' : 'none';

      const header = document.createElement('div');
      header.className = 'ig-tln-filter-header';
      header.innerHTML = `<span>🔍 Filters</span> <button id="ig-tln-close-filter" style="background:none; border:none; color:#94a3b8; cursor:pointer;">✕</button>`;

      const folderSelect = document.createElement('select');
      folderSelect.className = 'ig-tlp-input'; folderSelect.style.padding = '4px';

      const tagSelect = document.createElement('select');
      tagSelect.className = 'ig-tlp-input'; tagSelect.style.padding = '4px';

      function updateDropdowns() {
        folderSelect.innerHTML = `<option value="All">📁 All Folders</option>`;
        libraryData.items.filter(i => i.type === 'folder').forEach(f => {
          const opt = document.createElement('option');
          opt.value = f.id; opt.innerText = '📁 ' + f.name;
          if (activeFolderFilter === f.id) opt.selected = true;
          folderSelect.appendChild(opt);
        });

        tagSelect.innerHTML = `<option value="All">🏷️ All Tags</option>`;
        libraryData.tags.forEach(t => {
          const opt = document.createElement('option');
          opt.value = t.id; opt.innerText = '🏷️ ' + t.name;
          if (activeTagFilter === t.id) opt.selected = true;
          tagSelect.appendChild(opt);
        });
      }
      updateDropdowns();

      folderSelect.onchange = () => { activeFolderFilter = folderSelect.value; renderTree(); };
      tagSelect.onchange = () => { activeTagFilter = tagSelect.value; renderTree(); };

      win.appendChild(header); win.appendChild(folderSelect); win.appendChild(tagSelect);
      document.body.appendChild(win);

      win.querySelector('#ig-tln-close-filter').onclick = () => {
        filterWindowPos.visible = false; win.style.display = 'none';
        localStorage.setItem(FILTER_PREF_KEY, JSON.stringify(filterWindowPos));
        libUI.querySelector('#ig-tlc-filter-btn').classList.remove('active-filter');
      };

      let isDragging = false, startX, startY, initLeft, initTop;
      header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true; startX = e.clientX; startY = e.clientY;
        initLeft = win.offsetLeft; initTop = win.offsetTop;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
      });
      function onMouseMove(e) {
        if (!isDragging) return;
        win.style.left = (initLeft + (e.clientX - startX)) + 'px';
        win.style.top = (initTop + (e.clientY - startY)) + 'px';
      }
      function onMouseUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        filterWindowPos.top = win.offsetTop; filterWindowPos.left = win.offsetLeft;
        localStorage.setItem(FILTER_PREF_KEY, JSON.stringify(filterWindowPos));
      }
      win.updateDropdowns = updateDropdowns;
    }

    libUI.querySelector('#ig-tlc-filter-btn').onclick = (e) => {
      const win = document.getElementById('ig-tln-filter-win');
      if(!win) return;
      filterWindowPos.visible = !filterWindowPos.visible;
      win.style.display = filterWindowPos.visible ? 'flex' : 'none';
      e.target.classList.toggle('active-filter', filterWindowPos.visible);
      localStorage.setItem(FILTER_PREF_KEY, JSON.stringify(filterWindowPos));
    };

    libUI.querySelector('#ig-tlc-new-fold').onclick = () => {
      const name = prompt("Folder Name:");
      if (!name || !name.trim()) return;
      libraryData.items.push({ id: 'fld_' + Date.now(), type: 'folder', parentId: 'root', name: name.trim(), collapsed: false, order: Date.now() });
      saveData();
      const win = document.getElementById('ig-tln-filter-win'); if(win) win.updateDropdowns();
      renderTree();
    };

    libUI.querySelector('#ig-tlc-new-snip').onclick = () => openSnippetEditor(null);

    function openSnippetEditor(itemToEdit) {
      const isEdit = !!itemToEdit;
      let selectedTags = isEdit ? [...(itemToEdit.tags || [])] : [];

      const overlay = document.createElement('div');
      overlay.className = 'ig-tlp-modal-overlay';
      overlay.dataset.thumbnail = isEdit && itemToEdit.thumbnail ? itemToEdit.thumbnail : '';

      const tagOptionsHtml = libraryData.tags.map(t => {
        const isSel = selectedTags.includes(t.id);
        return `<label style="display:flex; align-items:center; gap:6px; font-size:11px; cursor:pointer; background:rgba(255,255,255,0.05); padding:4px 8px; border-radius:4px;">
          <input type="checkbox" class="ig-tlc-tag-chk" data-id="${t.id}" ${isSel ? 'checked' : ''}>
          <span class="ig-tln-tag-pill" style="background:${hexToRgba(t.color, 0.2)}; color:${t.color}; border:1px solid ${t.color};">${t.name}</span>
        </label>`;
      }).join('');

      overlay.innerHTML = `
        <div class="ig-tlp-modal" style="width:380px;" id="ig-tlp-modal-box">
          <h3>${isEdit ? '✏️ Edit Snippet' : '📝 New Snippet'}</h3>
          <div style="font-size:11px; font-weight:bold; color:#94a3b8; margin-top:4px;">Title:</div>
          <input type="text" id="ig-tlc-snip-title" class="ig-tlp-input" placeholder="Short title..." value="${isEdit ? itemToEdit.title : ''}">
          <div style="font-size:11px; font-weight:bold; color:#94a3b8; margin-top:4px;">Message Text:</div>
          <textarea id="ig-tlc-snip-text" class="ig-tlp-input" style="height:60px; resize:vertical;" placeholder="Type your full message...">${isEdit ? itemToEdit.text : ''}</textarea>
          <div style="font-size:11px; font-weight:bold; color:#94a3b8; margin-top:4px;">Custom Command:</div>
          <div style="display:flex; align-items:center; gap:4px;">
            <span style="color:#94a3b8; font-weight:bold;">/</span>
            <input type="text" id="ig-tlc-snip-command" class="ig-tlp-input" placeholder="e.g. hola" value="${isEdit && itemToEdit.customCommand ? itemToEdit.customCommand : ''}">
          </div>
          <div style="font-size:11px; font-weight:bold; color:#94a3b8; margin-top:4px;">Assign Tags:</div>
          <div style="display:flex; flex-wrap:wrap; gap:6px; max-height:80px; overflow-y:auto;">
            ${tagOptionsHtml || '<span style="color:#64748b; font-style:italic;">No tags created yet.</span>'}
          </div>
          <div style="display:flex; justify-content:space-between; margin-top:8px;">
            <div style="display:flex; gap:8px;">
              <button id="ig-tlc-snip-copy" style="background:#334155; color:#fff; border:none; padding:6px 12px; border-radius:4px; font-weight:bold; cursor:pointer;">📋 Copy</button>
              ${isEdit ? '<button id="ig-tlc-snip-del" style="background:#dc2626; color:#fff; border:none; padding:6px 12px; border-radius:4px; font-weight:bold; cursor:pointer;">🗑️ Delete</button>' : ''}
            </div>
            <div style="display:flex; gap:8px;">
              <button id="ig-tlc-snip-cancel" style="background:transparent; color:#94a3b8; border:none; cursor:pointer; font-weight:bold;">Cancel</button>
              <button id="ig-tlc-snip-save" style="background:#6366f1; color:#fff; border:none; padding:6px 12px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 Save</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.querySelector('#ig-tlc-snip-copy').onclick = () => {
        const btn = overlay.querySelector('#ig-tlc-snip-copy');
        const text = overlay.querySelector('#ig-tlc-snip-text').value;
        navigator.clipboard.writeText(text).then(() => {
          const original = btn.innerText;
          btn.innerText = '✅ Copied!';
          setTimeout(() => { btn.innerText = original; }, 1200);
        }).catch(() => alert('Could not copy to clipboard.'));
      };

      overlay.querySelector('#ig-tlc-snip-cancel').onclick = () => overlay.remove();

      if (isEdit) {
        overlay.querySelector('#ig-tlc-snip-del').onclick = () => {
          if(confirm("Permanently delete this snippet?")) {
            libraryData.items = libraryData.items.filter(i => i.id !== itemToEdit.id);
            saveData(); renderTree(); overlay.remove();
          }
        };
      }

      overlay.querySelector('#ig-tlc-snip-save').onclick = () => {
        const text = overlay.querySelector('#ig-tlc-snip-text').value.trim();
        const titleInput = overlay.querySelector('#ig-tlc-snip-title').value.trim();
        if (!text) return;

        const title = titleInput || (text.length > 25 ? text.substring(0, 25) + '...' : text);
        const finalTags = Array.from(overlay.querySelectorAll('.ig-tlc-tag-chk:checked')).map(cb => cb.dataset.id);
        const finalCommand = overlay.querySelector('#ig-tlc-snip-command').value.trim().replace(/^\/+/, '');
        const pendingThumb = overlay.dataset.thumbnail;

        if (isEdit) {
          itemToEdit.title = title;
          itemToEdit.text = text;
          itemToEdit.tags = finalTags;
          itemToEdit.customCommand = finalCommand;
          if (pendingThumb === 'CLEAR') delete itemToEdit.thumbnail;
          else if (pendingThumb) itemToEdit.thumbnail = pendingThumb;
        } else {
          const targetParent = activeFolderFilter === 'All' ? 'root' : activeFolderFilter;
          const newSnip = { id: 'snip_' + Date.now(), type: 'snippet', parentId: targetParent, title: title, text: text, tags: finalTags, customCommand: finalCommand, order: Date.now() };
          if (pendingThumb && pendingThumb !== 'CLEAR') newSnip.thumbnail = pendingThumb;
          libraryData.items.push(newSnip);
        }
        saveData(); renderTree(); overlay.remove();
      };
    }

    let draggedItem = null;
    function handleDragStart(e, id) { draggedItem = libraryData.items.find(i => i.id === id); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => e.target.style.opacity = '0.3', 0); }
    function handleDragOver(e, id, type) {
      e.preventDefault(); e.stopPropagation();
      const targetEl = e.currentTarget;
      document.querySelectorAll('.ig-tln-drop-top, .ig-tln-drop-bottom, .ig-tln-drop-inside').forEach(el => el.classList.remove('ig-tln-drop-top', 'ig-tln-drop-bottom', 'ig-tln-drop-inside'));
      if (!draggedItem || draggedItem.id === id) return;
      const rect = targetEl.getBoundingClientRect(); const y = e.clientY - rect.top; const h = rect.height;
      if (type === 'folder' && y > h * 0.25 && y < h * 0.75) {
        if (draggedItem.type === 'folder' && id === draggedItem.id) return;
        targetEl.classList.add('ig-tln-drop-inside');
      } else if (y < h / 2) targetEl.classList.add('ig-tln-drop-top');
      else targetEl.classList.add('ig-tln-drop-bottom');
    }
    function handleDrop(e, targetId, targetType) {
      e.preventDefault(); e.stopPropagation();
      if (!draggedItem || draggedItem.id === targetId) return;
      const targetEl = e.currentTarget; const rect = targetEl.getBoundingClientRect(); const y = e.clientY - rect.top; const h = rect.height;
      const targetItem = libraryData.items.find(i => i.id === targetId);
      if (targetType === 'folder' && y > h * 0.25 && y < h * 0.75) {
        draggedItem.parentId = targetItem.id; draggedItem.order = Date.now();
      } else {
        draggedItem.parentId = targetItem.parentId;
        const siblings = libraryData.items.filter(i => i.parentId === targetItem.parentId).sort((a,b) => a.order - b.order);
        const cleanSiblings = siblings.filter(i => i.id !== draggedItem.id);
        const targetIndex = cleanSiblings.findIndex(i => i.id === targetId);
        if (y < h / 2) cleanSiblings.splice(targetIndex, 0, draggedItem);
        else cleanSiblings.splice(targetIndex + 1, 0, draggedItem);
        cleanSiblings.forEach((item, index) => { item.order = index; });
      }
      draggedItem = null; saveData(); renderTree();
    }

    let activeColResizer = null;
    window.addEventListener('mousemove', (e) => {
      if (!activeColResizer) return;
      const containerRect = activeColResizer.container.getBoundingClientRect();
      const newWidthPercent = ((e.clientX - containerRect.left) / containerRect.width) * 100;
      colWidths.titleWidth = Math.min(80, Math.max(20, newWidthPercent));
      document.querySelectorAll('.ig-tln-title-col').forEach(el => el.style.width = colWidths.titleWidth + '%');
    });
    window.addEventListener('mouseup', () => {
      if (activeColResizer) {
        activeColResizer.el.classList.remove('active'); activeColResizer = null;
        localStorage.setItem(COL_PREF_KEY, JSON.stringify(colWidths));
      }
    });

    function renderTree() {
      const rootContainer = libUI.querySelector('#ig-tlc-tree-root');
      if (!rootContainer) return;
      rootContainer.innerHTML = '';

      let snippetCounter = 0;
      function buildNode(parentId, containerElement) {
        const children = libraryData.items.filter(i => i.parentId === parentId).sort((a,b) => a.order - b.order);

        children.forEach(item => {
          if (item.type === 'snippet' && activeTagFilter !== 'All') {
            if (!item.tags || !item.tags.includes(activeTagFilter)) return;
          }

          const el = document.createElement('div');

          if (item.type === 'folder') {
            el.className = 'ig-tln-folder-head'; el.draggable = true;
            el.addEventListener('dragstart', (e) => handleDragStart(e, item.id));
            el.addEventListener('dragend', (e) => { e.target.style.opacity = '1'; draggedItem = null; });
            el.addEventListener('dragover', (e) => handleDragOver(e, item.id, item.type));
            el.addEventListener('dragleave', (e) => { e.currentTarget.classList.remove('ig-tln-drop-top', 'ig-tln-drop-bottom', 'ig-tln-drop-inside'); });
            el.addEventListener('drop', (e) => handleDrop(e, item.id, item.type));

            el.innerHTML = `
              <span class="ig-tln-caret ${item.collapsed ? 'collapsed' : ''}">▼</span>
              <span>📁 ${item.name}</span>
              <button class="ig-tln-btn" style="margin-left:auto; padding:0 4px;" title="Edit/Delete Folder">⚙️</button>
            `;

            const contentDiv = document.createElement('div');
            contentDiv.className = `ig-tln-folder-content ${item.collapsed ? 'collapsed' : ''}`;

            el.querySelector('.ig-tln-caret').onclick = () => { item.collapsed = !item.collapsed; saveData(); renderTree(); };
            el.querySelector('.ig-tln-btn').onclick = () => {
              const action = prompt(`Edit Folder: "${item.name}"\n\nType a new name to rename it.\nType "DELETE" (all caps) to delete it and its contents.`);
              if (!action) return;
              if (action === 'DELETE') {
                const deleteNodeAndChildren = (id) => { libraryData.items.filter(i => i.parentId === id).forEach(child => deleteNodeAndChildren(child.id)); libraryData.items = libraryData.items.filter(i => i.id !== id); };
                deleteNodeAndChildren(item.id); saveData(); renderTree();
              } else { item.name = action.trim(); saveData(); renderTree(); }
            };

            containerElement.appendChild(el); containerElement.appendChild(contentDiv); buildNode(item.id, contentDiv);
          } else {
            snippetCounter++;
            el.className = `ig-tln-snippet ${snippetCounter % 2 === 0 ? 'alt-bg' : ''}`;
            el.dataset.id = item.id;

            const tagsHtml = (item.tags || []).map(tid => {
              const t = libraryData.tags.find(x => x.id === tid);
              return t ? `<span class="ig-tln-tag-pill" style="background:${hexToRgba(t.color, 0.2)}; color:${t.color};">${t.name}</span>` : '';
            }).join('');

            const cmdHtml = item.customCommand ? `<span class="ig-tln-cmd-pill">/${item.customCommand}</span>` : '';

            el.innerHTML = `
              <div class="ig-tln-row">
                <span class="ig-tln-drag-grip" draggable="true">⠿</span>
                <div class="ig-tln-title-col" style="width: ${colWidths.titleWidth}%;">
                  ${item.title}
                </div>
                <div class="ig-tln-col-resizer" title="Drag to resize columns"></div>
                ${cmdHtml}
                <div class="ig-tln-tags">${tagsHtml}</div>
                <div class="ig-tln-actions">
                  <button class="ig-tln-btn preview-btn" title="Toggle Text Preview">👁️</button>
                  <button class="ig-tln-btn edit-btn" title="Edit Snippet">✏️</button>
                </div>
              </div>
              <div class="ig-tln-preview">${item.text}</div>
            `;

            const grip = el.querySelector('.ig-tln-drag-grip');
            grip.addEventListener('dragstart', (e) => handleDragStart(e, item.id));
            grip.addEventListener('dragend', (e) => { e.target.style.opacity = '1'; draggedItem = null; });
            el.addEventListener('dragover', (e) => handleDragOver(e, item.id, item.type));
            el.addEventListener('dragleave', (e) => { e.currentTarget.classList.remove('ig-tln-drop-top', 'ig-tln-drop-bottom', 'ig-tln-drop-inside'); });
            el.addEventListener('drop', (e) => handleDrop(e, item.id, item.type));

            const resizer = el.querySelector('.ig-tln-col-resizer');
            resizer.addEventListener('mousedown', (e) => {
              e.stopPropagation(); e.preventDefault();
              resizer.classList.add('active');
              activeColResizer = { el: resizer, container: el.querySelector('.ig-tln-row') };
            });

            el.onclick = (e) => {
              e.stopPropagation();
              if (e.target.tagName === 'BUTTON' || e.target.classList.contains('ig-tln-drag-grip') || e.target.classList.contains('ig-tln-col-resizer') || e.target.classList.contains('ig-tln-thumb-icon')) return;

              injectText(item.text);

              const originalBg = el.style.background;
              el.style.background = 'rgba(16, 185, 129, 0.2)';
              setTimeout(() => { el.style.background = originalBg; }, 200);
            };

            const previewBtn = el.querySelector('.preview-btn');
            const previewBox = el.querySelector('.ig-tln-preview');
            previewBtn.onclick = (e) => { e.stopPropagation(); previewBox.classList.toggle('visible'); };

            const editBtn = el.querySelector('.edit-btn');
            editBtn.onclick = (e) => { e.stopPropagation(); openSnippetEditor(item); };

            containerElement.appendChild(el);
          }
        });
      }

      const renderRoot = activeFolderFilter === 'All' ? 'root' : activeFolderFilter;
      buildNode(renderRoot, rootContainer);
      core.emit('tl:tree-rendered', libUI);
    }

    function mountCard(attemptsLeft = 10) {
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '📝 Text Library', libUI, '⠿', 'text-library-module');
        buildFilterWindow();
        renderTree();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();
  }
});

/* ============================================================
   BLOCK: image manager (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Text Library Image Manager (Right-Side Icon & Viewer)
   - Completely separate extension.
   - Handles file uploading, compression, and hover viewing.
   ============================================================ */
LegoCore.registerBlock({
  id: 'textLibraryImageManager',
  init(core) {
    const PRO_KEY = 'ig_text_library_pro_v1';

    const style = document.createElement('style');
    style.innerHTML = `
      .ig-tln-thumb-btn {
        background: transparent; border: none; font-size: 11px; cursor: pointer;
        padding: 4px; border-radius: 4px; transition: 0.1s; margin-right: 2px;
      }
      .ig-tln-thumb-btn:hover { background: rgba(255,255,255,0.1); }
      .ig-tln-thumb-btn:active { transform: scale(0.9); }
    `;
    document.head.appendChild(style);

    const thumbViewer = document.createElement('div');
    thumbViewer.style.cssText = 'position:fixed; z-index:2147483647; max-width:250px; max-height:250px; border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,0.8); pointer-events:none; display:none; background:#0f172a; padding:6px; border:1px solid #334155;';
    const thumbViewerImg = document.createElement('img');
    thumbViewerImg.style.cssText = 'max-width:100%; max-height:100%; border-radius:4px; object-fit:contain; display:block;';
    thumbViewer.appendChild(thumbViewerImg);
    document.body.appendChild(thumbViewer);

    function compressImage(file, maxSize, callback) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width; let h = img.height;
          if (w > maxSize || h > maxSize) {
            const ratio = Math.min(maxSize / w, maxSize / h);
            w *= ratio; h *= ratio;
          }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          callback(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    core.on('tl:tree-rendered', (contentArea) => {
      const libraryData = JSON.parse(localStorage.getItem(PRO_KEY));
      if (!libraryData) return;

      contentArea.querySelectorAll('.ig-tln-snippet').forEach(row => {
        const id = row.dataset.id;
        const item = libraryData.items.find(i => i.id === id);

        if (item && item.thumbnail && !row.querySelector('.ig-tln-thumb-btn')) {
          const actionsDiv = row.querySelector('.ig-tln-actions');
          const btn = document.createElement('button');
          btn.className = 'ig-tln-thumb-btn ig-tln-thumb-icon';
          btn.title = 'Hold to view thumbnail';
          btn.innerText = '🖼️';

          btn.onmousedown = (e) => {
            e.stopPropagation();
            thumbViewerImg.src = item.thumbnail;
            thumbViewer.style.left = (e.clientX - 265) + 'px';
            thumbViewer.style.top = (e.clientY + 10) + 'px';
            thumbViewer.style.display = 'block';
          };
          const hide = () => thumbViewer.style.display = 'none';
          btn.onmouseup = hide; btn.onmouseleave = hide; btn.onclick = e => e.stopPropagation();

          actionsDiv.insertBefore(btn, actionsDiv.firstChild);
        }
      });
    });

    const observer = new MutationObserver((mutations) => {
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1 && node.querySelector('#ig-tlp-modal-box')) {
            const overlay = node;
            const modal = overlay.querySelector('#ig-tlp-modal-box');
            const tagSection = Array.from(modal.querySelectorAll('div')).find(d => d.innerText.includes('Assign Tags:'));

            if (!tagSection || modal.querySelector('#ig-tlc-thumb-upload')) return;

            const currentThumb = overlay.dataset.thumbnail || '';

            const thumbUI = document.createElement('div');
            thumbUI.innerHTML = `
              <div style="font-size:11px; font-weight:bold; color:#94a3b8; margin-top:4px;">Thumbnail Image (Optional):</div>
              <div style="display:flex; gap:8px; align-items:center;">
                <input type="file" id="ig-tlc-thumb-upload" accept="image/*" style="font-size:10px; color:#fff; width:180px;">
                <button id="ig-tlc-thumb-clear" style="background:transparent; color:#f43f5e; border:none; cursor:pointer; font-size:10px; display:${currentThumb ? 'block' : 'none'};">Clear Image</button>
              </div>
              <img id="ig-tlc-thumb-preview" src="${currentThumb}" style="max-height:40px; border-radius:4px; display:${currentThumb ? 'block' : 'none'}; object-fit:contain; margin-top:4px;">
            `;

            modal.insertBefore(thumbUI, tagSection);

            const upload = thumbUI.querySelector('#ig-tlc-thumb-upload');
            const clear = thumbUI.querySelector('#ig-tlc-thumb-clear');
            const preview = thumbUI.querySelector('#ig-tlc-thumb-preview');

            upload.onchange = (e) => {
              const file = e.target.files[0];
              if (file) {
                compressImage(file, 400, (base64) => {
                  overlay.dataset.thumbnail = base64;
                  preview.src = base64;
                  preview.style.display = 'block';
                  clear.style.display = 'block';
                });
              }
            };

            clear.onclick = () => {
              overlay.dataset.thumbnail = 'CLEAR';
              preview.style.display = 'none';
              clear.style.display = 'none';
              upload.value = '';
            };
          }
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[TextLibraryImageManager] Loaded: Image Logic successfully decoupled.');
    core.emit('block:ready', { id: 'textLibraryImageManager' });
  }
});

/* ============================================================
   BLOCK: Highlighter (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Text Highlighter (v1)
   ------------------------------------------------------------
   Standalone plugin -- no dependency on any other block. Mounts
   its own card into the Dual Sidebar via core.registerMenu, same
   as your other cards.

   Replaces your bookmarklet with:
   - A saved list of highlight rules (term + color + on/off),
     persisted across sessions
   - Each rule gets its own color, chosen via a native color
     swatch, from a rotating default palette when you add one
   - A live match count per rule (how many currently-visible
     elements match it right now)
   - A master pause toggle
   - Clean un-highlighting: turning a rule off or deleting it
     removes exactly the styling it applied (tracked per element
     via a data attribute), rather than just piling more styles
     on top like the bookmarklet did
   ============================================================ */
LegoCore.registerBlock({
  id: 'textHighlighterPlugin',
  init(core) {
    const RULES_KEY = 'ig_text_highlighter_rules_v1';
    const MASTER_KEY = 'ig_text_highlighter_master_v1';
    const PALETTE = ['#f6c344', '#7ee787', '#ff8fa3', '#8ecae6', '#c9a876', '#ff9770', '#c792ea', '#94e2c4'];

    let rules = [];
    try { rules = JSON.parse(localStorage.getItem(RULES_KEY)) || []; } catch (e) { rules = []; }

    let masterEnabled = localStorage.getItem(MASTER_KEY) !== 'false';

    function saveRules() { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); }
    function saveMaster() { localStorage.setItem(MASTER_KEY, String(masterEnabled)); }

    function nextPaletteColor() {
      const used = rules.map(r => r.color);
      const free = PALETTE.find(c => !used.includes(c));
      return free || PALETTE[rules.length % PALETTE.length];
    }

    function contrastColor(hex) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance > 0.6 ? '#000000' : '#ffffff';
    }

    function uid() { return 'hlrule_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    // ---------------- Styles ----------------
    function injectStyles() {
      if (document.getElementById('ig-hl-styles')) return;
      const style = document.createElement('style');
      style.id = 'ig-hl-styles';
      style.innerHTML = `
        .ig-hl-wrap { display:flex; flex-direction:column; gap:8px; font-family:-apple-system,sans-serif; font-size:11px; }
        .ig-hl-master { display:flex; align-items:center; justify-content:space-between; background:var(--igls-surface-2,#1c1c23); border:1px solid var(--igls-border,rgba(255,255,255,.07)); border-radius:6px; padding:6px 8px; }
        .ig-hl-master label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:10.5px; color:var(--igls-text-dim,#96949c); }
        .ig-hl-add-row { display:flex; gap:4px; align-items:center; }
        .ig-hl-input { flex:1; background:var(--igls-surface-2,#1c1c23); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:6px 8px; font-size:11px; outline:none; }
        .ig-hl-input:focus { border-color:var(--igls-accent,#c9a876); }
        .ig-hl-color-input { width:26px; height:26px; border:1px solid var(--igls-border,rgba(255,255,255,.1)); border-radius:6px; cursor:pointer; background:transparent; padding:0; flex-shrink:0; }
        .ig-hl-add-btn { background:var(--igls-accent,#c9a876); color:#171208; border:none; border-radius:6px; padding:6px 10px; font-size:11px; font-weight:700; cursor:pointer; flex-shrink:0; }
        .ig-hl-add-btn:hover { filter:brightness(1.08); }

        .ig-hl-list { display:flex; flex-direction:column; gap:4px; max-height:280px; overflow-y:auto; }
        .ig-hl-row { display:flex; align-items:center; gap:6px; background:rgba(255,255,255,.03); border:1px solid var(--igls-border,rgba(255,255,255,.06)); border-radius:6px; padding:5px 6px; }
        .ig-hl-row.disabled { opacity:.45; }
        .ig-hl-term { flex:1; font-size:11px; color:var(--igls-text,#ece9e4); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
        .ig-hl-term:hover { text-decoration:underline; }
        .ig-hl-count { font-size:9px; color:var(--igls-text-dim,#96949c); background:rgba(255,255,255,.06); padding:1px 6px; border-radius:8px; flex-shrink:0; min-width:14px; text-align:center; }
        .ig-hl-btn { background:transparent; border:none; color:var(--igls-text-dim,#96949c); cursor:pointer; font-size:11px; padding:3px; border-radius:4px; flex-shrink:0; }
        .ig-hl-btn:hover { color:var(--igls-accent,#c9a876); background:rgba(255,255,255,.08); }
        .ig-hl-empty { padding:14px; text-align:center; font-size:10.5px; color:var(--igls-text-dim,#96949c); }
      `;
      document.head.appendChild(style);
    }

    // ---------------- UI ----------------
    const wrap = document.createElement('div');
    wrap.className = 'ig-hl-wrap';
    wrap.innerHTML = `
      <div class="ig-hl-master">
        <label><input type="checkbox" id="ig-hl-master-chk" ${masterEnabled ? 'checked' : ''}> Highlighting active</label>
      </div>
      <div class="ig-hl-add-row">
        <input type="text" id="ig-hl-new-term" class="ig-hl-input" placeholder="Name or word to highlight...">
        <input type="color" id="ig-hl-new-color" class="ig-hl-color-input" value="${nextPaletteColor()}">
        <button id="ig-hl-add-btn" class="ig-hl-add-btn">+ Add</button>
      </div>
      <div id="ig-hl-list" class="ig-hl-list"></div>
    `;

    function renderList() {
      const list = wrap.querySelector('#ig-hl-list');
      list.innerHTML = '';
      if (!rules.length) {
        list.innerHTML = '<div class="ig-hl-empty">No highlights yet. Add a name or word above.</div>';
        return;
      }
      rules.forEach(rule => {
        const row = document.createElement('div');
        row.className = 'ig-hl-row' + (rule.enabled ? '' : ' disabled');
        row.dataset.ruleId = rule.id;
        row.innerHTML = `
          <input type="checkbox" class="ig-hl-toggle" ${rule.enabled ? 'checked' : ''} title="On/off">
          <input type="color" class="ig-hl-color-input ig-hl-row-color" value="${rule.color}">
          <span class="ig-hl-term" title="Click to rename">${rule.term}</span>
          <span class="ig-hl-count" data-count-for="${rule.id}">0</span>
          <button class="ig-hl-btn ig-hl-del" title="Delete">❌</button>
        `;

        row.querySelector('.ig-hl-toggle').onchange = e => {
          rule.enabled = e.target.checked;
          row.classList.toggle('disabled', !rule.enabled);
          saveRules();
          scanAndHighlight();
        };

        row.querySelector('.ig-hl-row-color').onchange = e => {
          rule.color = e.target.value;
          saveRules();
          // Force a fresh pass so already-highlighted elements pick up the new color
          document.querySelectorAll(`[data-ig-hl-id="${rule.id}"]`).forEach(el => {
            el.style.backgroundColor = rule.color;
            el.style.color = contrastColor(rule.color);
          });
        };

        row.querySelector('.ig-hl-term').onclick = () => {
          const name = prompt('Rename highlight:', rule.term);
          if (!name || !name.trim()) return;
          rule.term = name.trim();
          saveRules();
          renderList();
        };

        row.querySelector('.ig-hl-del').onclick = () => {
          if (!confirm(`Remove highlight "${rule.term}"?`)) return;
          document.querySelectorAll(`[data-ig-hl-id="${rule.id}"]`).forEach(el => clearHighlight(el));
          rules = rules.filter(r => r.id !== rule.id);
          saveRules();
          renderList();
        };

        list.appendChild(row);
      });
    }

    wrap.querySelector('#ig-hl-master-chk').onchange = e => {
      masterEnabled = e.target.checked;
      saveMaster();
      if (!masterEnabled) {
        document.querySelectorAll('[data-ig-hl-id]').forEach(el => clearHighlight(el));
      }
    };

    wrap.querySelector('#ig-hl-add-btn').onclick = () => {
      const input = wrap.querySelector('#ig-hl-new-term');
      const colorInput = wrap.querySelector('#ig-hl-new-color');
      const term = input.value.trim();
      if (!term) return;
      rules.push({ id: uid(), term, color: colorInput.value, enabled: true });
      saveRules();
      input.value = '';
      colorInput.value = nextPaletteColor();
      renderList();
      scanAndHighlight();
    };

    wrap.querySelector('#ig-hl-new-term').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); wrap.querySelector('#ig-hl-add-btn').click(); }
    });

    // ---------------- Scan & highlight ----------------
    function clearHighlight(el) {
      delete el.dataset.igHlId;
      el.style.backgroundColor = '';
      el.style.color = '';
      el.style.fontWeight = '';
      el.style.borderRadius = '';
      el.style.padding = '';
    }

    function scanAndHighlight() {
      if (!masterEnabled) return;
      const enabledRules = rules.filter(r => r.enabled && r.term.trim());
      const counts = {};
      enabledRules.forEach(r => { counts[r.id] = 0; });

      const spans = document.querySelectorAll('div[role="link"] span, div[role="button"] span');
      spans.forEach(s => {
        const text = (s.innerText || '').toLowerCase();
        if (!text) { if (s.dataset.igHlId) clearHighlight(s); return; }

        let matched = null;
        for (const r of enabledRules) {
          if (text.includes(r.term.toLowerCase())) { matched = r; break; }
        }

        if (matched) {
          counts[matched.id] = (counts[matched.id] || 0) + 1;
          if (s.dataset.igHlId !== matched.id) {
            s.dataset.igHlId = matched.id;
            s.style.backgroundColor = matched.color;
            s.style.color = contrastColor(matched.color);
            s.style.fontWeight = 'bold';
            s.style.borderRadius = '3px';
            s.style.padding = '0 2px';
          }
        } else if (s.dataset.igHlId) {
          clearHighlight(s);
        }
      });

      Object.keys(counts).forEach(id => {
        const badge = wrap.querySelector(`[data-count-for="${id}"]`);
        if (badge) badge.innerText = counts[id];
      });
    }

    setInterval(scanAndHighlight, 500);

    // ---------------- Mount ----------------
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        injectStyles();
        core.registerMenu('left', '🖍️ Text Highlighter', wrap, '⠿', 'text-highlighter');
        renderList();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    core.emit('block:ready', { id: 'textHighlighterPlugin' });
  }
});

/* ============================================================
   BLOCK: Commands (v5)
   ============================================================ */
/* ============================================================
   BLOCK: Commands (v30 - 📌 Floating always-on-top window + "/save" text snippets
                      + Image drop/paste tray (reorder, save as set, paste)
                      + Instant search setting
                    v29 - Core Shared Search + Sequences (/seq)
                      + Sequence-aware Enter/Escape
                      + /save audio fix + HTML-safe titles
                    v28.1 - Click Shield Bug Fix & Smooth Hover
                      + Quick Edit Modal & Inline AI
                      + Strict Slash Guard Restored
                      + Permanent Markdown Highlights
                      + ManyChat Transcript Search Fix
                      + Full Panel Previews for Text & Flows
                      + Inline Audio Quick-Save)
   ============================================================ */
LegoCore.registerBlock({
  id: 'quickCommandExtension',
  init(core) {
    const TEXT_LIB_KEY = 'ig_text_library_pro_v1';
    const EFFECTS_KEY = 'ig_quick_effects_enabled_v1';
    const MC_FLOWS_KEY = 'mc_flows_cache_v1';
    const MC_API_KEY = 'mc_api_key_v1';
    const MC_TARGET_KEY = 'mc_target_subscriber_v1';
    const SHORTCUT_KEY = 'ig_qcx_shortcut_v1';
    const DEFAULT_SHORTCUT = { key: 'q', ctrl: false, alt: true, shift: false, meta: false };

    let emojiDict = JSON.parse(localStorage.getItem('ig_emoji_dict_v1')) || [];
    core.on('emoji:updated', (newDict) => { emojiDict = newDict; });

    function withDb(cb) {
      const existing = core.getDb();
      if (existing) { cb(existing); return; }
      core.on('db:ready', db => cb(db));
    }

    function getTextLibraryData() {
      try { return JSON.parse(localStorage.getItem(TEXT_LIB_KEY)) || { items: [], tags: [] }; }
      catch (e) { return { items: [], tags: [] }; }
    }
    function saveTextLibraryData(data) { localStorage.setItem(TEXT_LIB_KEY, JSON.stringify(data)); }

    function getShortcutCombo() {
      try { const raw = localStorage.getItem(SHORTCUT_KEY); return raw ? JSON.parse(raw) : { ...DEFAULT_SHORTCUT }; }
      catch (e) { return { ...DEFAULT_SHORTCUT }; }
    }
    function saveShortcutCombo(combo) { localStorage.setItem(SHORTCUT_KEY, JSON.stringify(combo)); }

    // Instant search: when ON, the item list appears as soon as you type — no leading "/" needed.
    const INSTANT_KEY = 'ig_qcx_instant_search_v1';
    let instantSearch = localStorage.getItem(INSTANT_KEY) === 'true';
    function setInstantSearch(on) { instantSearch = !!on; localStorage.setItem(INSTANT_KEY, String(instantSearch)); }

    // Floating window state (docked by default; 📌 pops it out). Synced via Bunny.
    const FLOAT_KEY = 'ig_qcx_float_v1';
    function getFloatState() {
      try { return Object.assign({ floating: false, x: null, y: null, w: 360, h: null }, JSON.parse(localStorage.getItem(FLOAT_KEY)) || {}); }
      catch (e) { return { floating: false, x: null, y: null, w: 360, h: null }; }
    }
    function saveFloatState(s) { localStorage.setItem(FLOAT_KEY, JSON.stringify(s)); }

    // Same thumbnail format the Image Sets module stores (200px JPEG data URL)
    function compressThumbnail(file, maxSize = 200) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > maxSize || h > maxSize) { const r = Math.min(maxSize / w, maxSize / h); w *= r; h *= r; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL('image/jpeg', 0.6));
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
        img.src = url;
      });
    }

    // "/save" for text: "my text /save" or "/save my text" (but never "/save audio …")
    function parseSaveText(val) {
      const v = (val || '').trim();
      if (/^\/save\s+audio\b/i.test(v)) return null;
      let m = v.match(/^\/save(?:\s+([\s\S]*))?$/i);
      if (m) return (m[1] || '').trim();
      m = v.match(/^([\s\S]*\S)\s+\/save$/i);
      return m ? m[1].trim() : null;
    }
    function formatCombo(combo) {
      if (!combo || !combo.key) return 'Not set';
      const parts = [];
      if (combo.ctrl) parts.push('Ctrl');
      if (combo.alt) parts.push('Alt');
      if (combo.shift) parts.push('Shift');
      if (combo.meta) parts.push('⌘');
      parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
      return parts.join('+');
    }
    function eventMatchesCombo(e, combo) {
      if (!combo || !combo.key) return false;
      return e.key.toLowerCase() === combo.key.toLowerCase() && !!e.ctrlKey === !!combo.ctrl && !!e.altKey === !!combo.alt && !!e.shiftKey === !!combo.shift && !!e.metaKey === !!combo.meta;
    }

    // Search engine now lives in LegoCore (shared with the Sequence Manager builder)
    const normalizeStr = core.normalizeStr;
    const getSearchTokens = core.getSearchTokens;
    const esc = core.escapeHtml;

    function sequenceIsActive() {
      return typeof core.getActiveSequence === 'function' && !!core.getActiveSequence();
    }

    function tokenToAccentRegex(token) {
      const map = {
        'a': '[aáàäâã]', 'e': '[eéèëê]', 'i': '[iíìïî]',
        'o': '[oóòöôõ]', 'u': '[uúùüû]', 'n': '[nñ]', 'c': '[cç]'
      };
      const escaped = String(token || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let pattern = '';
      for (const ch of escaped.toLowerCase()) pattern += map[ch] || ch;
      return pattern;
    }

    function highlightTokens(text, tokens) {
      const raw = String(text || '');
      if (!raw) return '';
      let htmlText = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      if (tokens && tokens.length) {
        const patterns = tokens.map(tokenToAccentRegex).filter(Boolean);
        if (patterns.length) {
          const regex = new RegExp(`(${patterns.join('|')})`, 'gi');
          htmlText = htmlText.replace(regex, `<mark style="background: rgba(201, 168, 118, 0.45); color: #fff; border-radius: 3px; padding: 0 3px; font-weight: bold;">$1</mark>`);
        }
      }

      htmlText = htmlText.replace(/\*\*(.*?)\*\*/gs, `<strong style="color: #38bdf8; background: rgba(56, 189, 248, 0.15); padding: 0 3px; border-radius: 3px;">$1</strong>`);

      return htmlText;
    }

    // --- Hash-Colored Number & Name Tags (ported from Audio Library) ---
    function getHashColor(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      const hue = Math.abs(hash % 360);
      return `hsl(${hue}, 65%, 45%)`;
    }

    function formatTitleWithTags(rawName, tokens) {
      const raw = String(rawName || '');
      // Matches: leading number, optional separators, optional (course name), separators, rest of title
      const match = raw.match(/^(\d+)([\s\-\.]*)(?:\(([^)]+)\))?([\s\-\.]*)(.*)$/);
      if (!match) return highlightTokens(raw, tokens);

      const numStr = match[1];
      const num = parseInt(numStr, 10);
      const sep1 = match[2] || '';
      const courseName = match[3];
      const sep2 = match[4] || '';
      const rest = match[5] || '';

      // 🎨 Colors come from the Tag Colors block (falls back to the old colors if it's missing)
      const tc = core.tagColors;
      const bg = tc ? tc.getNumberColor(numStr)
        : num === 1 ? '#10b981' : num === 2 ? '#ef4444' : num === 3 ? '#f59e0b' : num === 4 ? '#8b5cf6' : num >= 5 ? '#3b82f6' : '#64748b';
      const fg = tc ? tc.getTextColor(bg) : '#fff';

      let html = `<span class="ig-pipeline-badge" style="background:${bg}; color:${fg};">${numStr}</span>`;

      if (courseName) {
        const tagColor = tc ? tc.getCourseColor(courseName) : getHashColor(courseName.toLowerCase().trim());
        const tagFg = tc ? tc.getTextColor(tagColor) : '#fff';
        html += `<span class="ig-course-badge" style="background:${tagColor}; color:${tagFg};">(${highlightTokens(courseName.trim(), tokens)})</span>`;
        html += `<span>${highlightTokens(sep2 + rest, tokens)}</span>`;
      } else {
        html += `<span>${highlightTokens(sep1 + rest, tokens)}</span>`;
      }

      return html;
    }

    // MRU tracking, getImageSets, getAllSearchableItems and computeMatches moved to LegoCore:
    //   core.markUsed / core.getSearchableInventory / core.searchInventory / core.parseSearchPrefix
    const markUsed = core.markUsed;

    function getAllFolders() {
      return new Promise(resolve => {
        withDb(db => {
          if (!db) return resolve([]);
          try {
            const tx = db.transaction(['folders'], 'readonly');
            const names = [];
            const req = tx.objectStore('folders').openCursor();
            req.onsuccess = e => {
              const cursor = e.target.result;
              if (cursor) { names.push(cursor.value.name); cursor.continue(); }
              else resolve(names);
            };
            req.onerror = () => resolve([]);
          } catch(e) { resolve([]); }
        });
      });
    }

    function sendManyChatFlow(flowNs) {
      return new Promise((resolve, reject) => {
        const apiKey = localStorage.getItem(MC_API_KEY) || '';
        let subscriberId = sessionStorage.getItem(MC_TARGET_KEY) || '';
        const targetInput = document.getElementById('ig-mc-target-input');
        if (targetInput && targetInput.value.trim()) subscriberId = targetInput.value.trim();
        if (!apiKey) return reject(new Error('No ManyChat API Key found. Configure ManyChat first.'));
        if (!subscriberId) return reject(new Error('No Target Subscriber ID set. Look up user first.'));
        const payload = { subscriber_id: parseInt(subscriberId, 10), flow_ns: flowNs };
        if (typeof GM_xmlhttpRequest === 'undefined') return reject(new Error('GM_xmlhttpRequest not available.'));
        GM_xmlhttpRequest({
          method: 'POST', url: 'https://api.manychat.com/fb/sending/sendFlow',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          data: JSON.stringify(payload),
          onload: function (response) {
            if (response.status >= 200 && response.status < 300) resolve();
            else reject(new Error('API error: ' + response.status));
          },
          onerror: function () { reject(new Error('Network error.')); }
        });
      });
    }

    async function detectAndTrimSilence(blob, cutStart, cutEnd, customThreshold) {
      try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
        const channelData = audioBuffer.getChannelData(0);
        const sr = audioBuffer.sampleRate;
        const threshold = parseFloat(customThreshold) || 0.035;
        let startIdx = 0, endIdx = channelData.length;
        if (cutStart) { for (let i = 0; i < channelData.length; i++) { if (Math.abs(channelData[i]) > threshold) { startIdx = Math.max(0, i - Math.floor(sr * 0.05)); break; } } }
        if (cutEnd) { for (let i = channelData.length - 1; i >= 0; i--) { if (Math.abs(channelData[i]) > threshold) { endIdx = Math.min(channelData.length, i + Math.floor(sr * 0.15)); break; } } }
        if (startIdx >= endIdx) return blob;
        const trimmed = audioCtx.createBuffer(audioBuffer.numberOfChannels, endIdx - startIdx, sr);
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) trimmed.getChannelData(c).set(audioBuffer.getChannelData(c).subarray(startIdx, endIdx));
        return new Blob([audioBufferToWav(trimmed)], { type: 'audio/mp4' });
      } catch (e) { return blob; }
    }

    function audioBufferToWav(buffer) {
      const numChannels = buffer.numberOfChannels, sr = buffer.sampleRate, format = 1, bitDepth = 16;
      const result = numChannels === 2 ? (function (l, r) { const res = new Float32Array(l.length + r.length); for (let i = 0, j = 0; i < l.length; i++) { res[j++] = l[i]; res[j++] = r[i]; } return res; })(buffer.getChannelData(0), buffer.getChannelData(1)) : buffer.getChannelData(0);
      const dataLength = result.length * (bitDepth / 8);
      const wav = new Uint8Array(44 + dataLength);
      const view = new DataView(wav.buffer);
      const ws = (v, o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      ws(view, 0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
      ws(view, 8, 'WAVE'); ws(view, 12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, format, true);
      view.setUint16(22, numChannels, true); view.setUint32(24, sr, true);
      view.setUint32(28, sr * numChannels * (bitDepth / 8), true);
      view.setUint16(32, numChannels * (bitDepth / 8), true);
      view.setUint16(34, bitDepth, true); ws(view, 36, 'data');
      view.setUint32(40, dataLength, true);
      for (let i = 0, offset = 44; i < result.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, result[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
      return wav;
    }

    const style = document.createElement('style');
    style.id = 'ig-qcx-styles';
    style.innerHTML = `
      .ig-qcx-wrapper { position: relative; }
      .ig-qcx-dropdown { position: fixed; max-height: 260px; overflow-y: auto; background: #0f172a; border: 1px solid #334155; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 2147483647 !important; display: none; flex-direction: column; padding: 4px; gap: 2px; }
      .ig-qcx-dropdown::-webkit-scrollbar { width: 4px; }
      .ig-qcx-dropdown::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .ig-qcx-dd-row { padding: 6px 8px; border-radius: 5px; cursor: pointer; transition: background 0.1s; }
      .ig-qcx-dd-row:hover { background: rgba(255,255,255,0.06); }
      .ig-qcx-dd-row.selected { background: #6366f1; }
      .ig-qcx-dd-row-top { display: flex; align-items: center; gap: 6px; }
      .ig-qcx-dd-title { flex: 1; font-weight: bold; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
      .ig-qcx-dd-cmd { font-size: 9px; background: rgba(255,255,255,0.12); color: #c9a876; padding: 1px 6px; border-radius: 8px; font-weight: bold; flex-shrink: 0; }
      .ig-pipeline-badge { display: inline-block; padding: 1px 5px; border-radius: 4px; font-weight: bold; color: #fff; margin-right: 4px; font-size: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
      .ig-course-badge { display: inline-block; padding: 1px 5px; border-radius: 4px; font-weight: bold; color: #fff; margin-right: 4px; font-size: 9px; text-transform: uppercase; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
      .ig-qcx-dd-edit-btn { background: transparent; border: none; color: #94a3b8; cursor: pointer; font-size: 11px; padding: 2px; border-radius: 4px; transition: 0.2s; flex-shrink: 0; margin-left: auto; opacity: 0.6; pointer-events: auto; }
      .ig-qcx-dd-edit-btn:hover { color: #fff; background: rgba(255,255,255,0.15); opacity: 1; }
      .ig-qcx-dd-empty { padding: 10px; text-align: center; color: #94a3b8; font-size: 10px; }
      /* BUG FIX: pointer-events changed to none to allow clicks through the invisible container */
      .ig-qcx-overlay-row { position: absolute; top: 6px; right: 6px; left: 6px; display: flex; align-items: center; justify-content: flex-end; gap: 4px; pointer-events: none; }
      .ig-qcx-overlay-row > * { pointer-events: auto; }
      .ig-qcx-record-btn { background: #dc2626; border: none; color: white; font-size: 11px; width: 26px; height: 26px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: 0.15s; box-shadow: 0 1px 4px rgba(0,0,0,0.4); }
      .ig-qcx-record-btn:hover { filter: brightness(1.1); }
      .ig-qcx-record-btn.recording { background: #7f1d1d; animation: ig-qcx-pulse 1s infinite; }
      .ig-qcx-record-btn.finishing { background: #ea580c; animation: none; }
      .ig-qcx-record-btn:disabled { opacity: 0.6; cursor: default; }
      @keyframes ig-qcx-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .ig-qcx-preview-bar { flex: 1; min-width: 0; display: flex; align-items: center; gap: 3px; background: rgba(15, 23, 42, 0.95); border: 1px solid #334155; border-radius: 6px; padding: 3px 6px; box-shadow: 0 1px 4px rgba(0,0,0,0.4); }
      .ig-qcx-preview-label { flex: 1; min-width: 0; font-size: 10px; font-weight: bold; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ig-qcx-icon-btn { background: transparent; border: none; color: var(--igls-text-dim, #96949c); cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 4px; transition: 0.15s; flex-shrink: 0; }
      .ig-qcx-icon-btn:hover { color: var(--igls-accent, #c9a876); background: rgba(255,255,255,0.1); }
      .ig-qcx-gear-btn { background: transparent; border: none; color: var(--igls-text-dim, #96949c); cursor: pointer; font-size: 12px; padding: 2px 5px; border-radius: 4px; transition: 0.15s; }
      .ig-qcx-gear-btn:hover { color: var(--igls-accent, #c9a876); background: rgba(255,255,255,0.1); }
      .ig-qcx-modal-overlay { position: fixed; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,0.6); z-index: 2147483647; display: flex; justify-content: center; align-items: center; }
      .ig-qcx-modal { background: #0f172a; border: 1px solid #334155; border-radius: 8px; width: 380px; max-height: 85vh; padding: 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
      .ig-qcx-modal h3 { margin: 0; font-size: 14px; color: #fff; }
      .ig-qcx-modal-input { width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 7px 8px; border-radius: 4px; font-size: 11px; outline: none; }
      .ig-qcx-modal-input:focus { border-color: #6366f1; }
      .ig-qcx-modal-textarea { width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 7px 8px; border-radius: 4px; font-size: 11px; outline: none; min-height: 60px; max-height: 140px; resize: vertical; font-family: inherit; line-height: 1.4; }
      .ig-qcx-modal-textarea:focus { border-color: #6366f1; }
      .ig-qcx-modal-label { font-size: 10px; font-weight: bold; color: #94a3b8; text-transform: uppercase; margin-top: 2px; }
      .ig-qcx-mgr-search { width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 8px; border-radius: 4px; font-size: 12px; outline: none; }
      .ig-qcx-mgr-search:focus { border-color: #6366f1; }
      .ig-qcx-mgr-list { overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 4px; }
      .ig-qcx-mgr-row { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.03); padding: 6px 8px; border-radius: 6px; }
      .ig-qcx-mgr-name { flex: 1; font-size: 11px; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ig-qcx-mgr-cmd-input { width: 90px; background: #1e293b; border: 1px solid #475569; color: #c9a876; padding: 4px 6px; border-radius: 4px; font-size: 10px; outline: none; }
      .ig-qcx-mgr-cmd-input:focus { border-color: #6366f1; }
      .ig-qcx-transcript-panel { position: fixed; overflow-y: auto; background: #0f172a; border: 1px solid #334155; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 2147483647 !important; display: none; flex-direction: column; padding: 10px; gap: 6px; }
      .ig-qcx-transcript-panel::-webkit-scrollbar { width: 4px; }
      .ig-qcx-transcript-panel::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .ig-qcx-transcript-title { font-size: 11px; font-weight: bold; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .ig-qcx-transcript-body { font-size: 11px; color: #cbd5e1; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      .ig-qcx-transcript-empty { font-size: 10px; color: #64748b; font-style: italic; }
      .ig-qcx-hdr-btn { background: transparent; border: none; color: var(--igls-text-dim, #96949c); cursor: pointer; font-size: 12px; padding: 2px 5px; border-radius: 4px; transition: 0.15s; }
      .ig-qcx-hdr-btn:hover { color: var(--igls-accent, #c9a876); background: rgba(255,255,255,0.1); }
      /* Floating window — max z-index + kept last among equal-z siblings, so it sits above the sidebars */
      .ig-qcx-float { position: fixed; z-index: 2147483647 !important; display: flex; flex-direction: column; min-width: 260px; min-height: 110px; max-width: 95vw; max-height: 90vh; background: var(--igls-surface, #111118); border: 1px solid #475569; border-radius: 10px; box-shadow: 0 14px 44px rgba(0,0,0,0.65); resize: both; overflow: hidden; box-sizing: border-box; }
      .ig-qcx-float-bar { display: flex; align-items: center; gap: 4px; padding: 5px 6px 5px 10px; background: #1e293b; cursor: move; user-select: none; flex-shrink: 0; }
      .ig-qcx-float-title { flex: 1; font-size: 11px; font-weight: bold; color: #e2e8f0; }
      .ig-qcx-float-body { flex: 1; min-height: 0; overflow: auto; padding: 8px; display: flex; flex-direction: column; }
      .ig-qcx-float-stub { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10px; color: #94a3b8; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 6px; }
      .ig-qcx-float-stub button { background: #1e293b; border: 1px solid #475569; color: #fff; padding: 3px 8px; border-radius: 4px; font-size: 10px; cursor: pointer; }
      /* Image tray */
      .ig-qcx-drop-hover { outline: 2px dashed #10b981 !important; outline-offset: 2px; }
      .ig-qcx-tray { display: none; flex-direction: column; gap: 6px; background: #0f172a; border: 1px dashed #475569; border-radius: 6px; padding: 6px; margin-bottom: 6px; }
      .ig-qcx-tray.show { display: flex; }
      .ig-qcx-tray-strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
      .ig-qcx-tray-strip::-webkit-scrollbar { height: 4px; }
      .ig-qcx-tray-strip::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .ig-qcx-tray-thumb { position: relative; width: 54px; height: 54px; flex-shrink: 0; border-radius: 4px; overflow: hidden; border: 1px solid #334155; background: #1e293b; cursor: grab; }
      .ig-qcx-tray-thumb img { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
      .ig-qcx-tray-thumb.dragging { opacity: 0.3; }
      .ig-qcx-tray-thumb.drop-before { box-shadow: -3px 0 0 #10b981; }
      .ig-qcx-tray-thumb.drop-after { box-shadow: 3px 0 0 #10b981; }
      .ig-qcx-tray-num { position: absolute; left: 2px; bottom: 2px; background: rgba(0,0,0,0.7); color: #fff; font-size: 9px; font-weight: bold; padding: 0 4px; border-radius: 3px; pointer-events: none; }
      .ig-qcx-tray-del { position: absolute; top: 2px; right: 2px; background: rgba(220,38,38,0.9); color: #fff; border: none; width: 16px; height: 16px; border-radius: 3px; font-size: 9px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
      .ig-qcx-tray-bar { display: flex; align-items: center; gap: 4px; }
      .ig-qcx-tray-count { flex: 1; font-size: 10px; font-weight: bold; color: #94a3b8; }
      .ig-qcx-tray-btn { background: #1e293b; border: 1px solid #475569; color: #fff; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; cursor: pointer; }
      .ig-qcx-tray-btn:hover { background: #334155; }
      .ig-qcx-tray-btn.primary { background: #6366f1; border-color: #6366f1; }
      .ig-qcx-tray-btn.go { background: #10b981; border-color: #10b981; }
      .ig-qcx-tag-row { display: flex; flex-wrap: wrap; gap: 4px; }
      .ig-qcx-tag-row label { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #e2e8f0; background: rgba(255,255,255,0.05); padding: 3px 6px; border-radius: 4px; cursor: pointer; }
    `;
    document.head.appendChild(style);

    let enhanced = false;

    function tryEnhance() {
      if (enhanced) return;
      const card = document.querySelector('.ig-draggable-menu[data-key="quick-chat-box"]');
      if (!card) return;

      const oldInput = card.querySelector('#ig-quick-chat-input');
      const oldSendBtn = card.querySelector('#ig-quick-chat-send');
      const header = card.querySelector('.ig-menu-header');
      if (!oldInput || !oldSendBtn || !header) return;

      enhanced = true;
      enhanceCard(card, oldInput, oldSendBtn, header);
    }

    function enhanceCard(card, oldInput, oldSendBtn, header) {
      const input = oldInput.cloneNode(true);
      oldInput.parentNode.replaceChild(input, oldInput);
      input.placeholder = 'Type msg, / to search, /seq for sequences, : for emoji...';
      input.style.paddingRight = '76px';

      const sendBtn = oldSendBtn.cloneNode(true);
      oldSendBtn.parentNode.replaceChild(sendBtn, oldSendBtn);

      const controlsRow = sendBtn.closest('div');
      sendBtn.remove();
      controlsRow.style.justifyContent = 'flex-start';
      sendBtn.innerText = '📥';
      sendBtn.title = 'Paste to Chat';
      sendBtn.style.cssText = 'background:#10b981; color:#fff; border:none; border-radius:50%; width:26px; height:26px; padding:0; font-size:12px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; box-shadow:0 1px 4px rgba(0,0,0,0.4); transition:0.15s;';

      const recordBtn = document.createElement('button');
      recordBtn.className = 'ig-qcx-record-btn';
      recordBtn.title = 'Record a quick audio clip';
      recordBtn.innerText = '🔴';

      const wrapper = document.createElement('div');
      wrapper.className = 'ig-qcx-wrapper';
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      const previewBar = document.createElement('div');
      previewBar.className = 'ig-qcx-preview-bar';
      previewBar.style.display = 'none';
      previewBar.innerHTML = `
        <span class="ig-qcx-preview-label"></span>
        <button class="ig-qcx-icon-btn ig-qcx-preview-play" title="Play audio">▶️</button>
        <button class="ig-qcx-icon-btn ig-qcx-preview-save" title="Save clip to library">💾</button>
        <button class="ig-qcx-icon-btn ig-qcx-preview-discard" title="Discard audio">🗑️</button>
      `;

      const overlayRow = document.createElement('div');
      overlayRow.className = 'ig-qcx-overlay-row';
      overlayRow.appendChild(previewBar);
      overlayRow.appendChild(recordBtn);
      overlayRow.appendChild(sendBtn);
      wrapper.appendChild(overlayRow);

      const previewLabel = previewBar.querySelector('.ig-qcx-preview-label');
      const previewPlayBtn = previewBar.querySelector('.ig-qcx-preview-play');
      const previewSaveBtn = previewBar.querySelector('.ig-qcx-preview-save');
      const previewDiscardBtn = previewBar.querySelector('.ig-qcx-preview-discard');

      const dropdownEl = document.createElement('div');
      dropdownEl.className = 'ig-qcx-dropdown';

      const transcriptPanelEl = document.createElement('div');
      transcriptPanelEl.className = 'ig-qcx-transcript-panel';

      function positionDropdown() {
        const rect = input.getBoundingClientRect();
        const gap = 8;
        const spaceAbove = Math.max(120, rect.top - gap - 12);

        dropdownEl.style.left = rect.left + 'px';
        dropdownEl.style.width = rect.width + 'px';

        dropdownEl.style.top = 'auto';
        dropdownEl.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
        dropdownEl.style.maxHeight = Math.min(320, spaceAbove) + 'px';

        document.body.appendChild(dropdownEl);
      }

      function positionTranscriptPanel() {
        const ddRect = dropdownEl.getBoundingClientRect();
        const gap = 8;
        const panelWidth = 240;
        let left = ddRect.right + gap;
        if (left + panelWidth > window.innerWidth - 8) {
          left = ddRect.left - panelWidth - gap;
          if (left < 8) left = Math.max(8, window.innerWidth - panelWidth - 8);
        }
        transcriptPanelEl.style.left = left + 'px';
        transcriptPanelEl.style.top = 'auto';
        transcriptPanelEl.style.bottom = dropdownEl.style.bottom;
        transcriptPanelEl.style.maxHeight = dropdownEl.style.maxHeight;
        transcriptPanelEl.style.width = panelWidth + 'px';

        document.body.appendChild(transcriptPanelEl);
      }

      function updateTranscriptPanel() {
        if (!dropdownOpen || !matches.length) { transcriptPanelEl.style.display = 'none'; return; }
        const m = matches[selectedIndex];
        transcriptPanelEl.style.display = 'flex';

        const activeTokens = currentSearchTokens;

        if (m && m.kind === 'audio') {
          const rawTranscript = String(m.item.transcript || '').trim();
          const highlightedBody = rawTranscript
            ? highlightTokens(rawTranscript, activeTokens)
            : '<span class="ig-qcx-transcript-empty">No transcript yet.</span>';

          transcriptPanelEl.innerHTML = `
            <div class="ig-qcx-transcript-title">🎵 ${esc(m.item.name)}</div>
            <div class="ig-qcx-transcript-body">${highlightedBody}</div>
          `;

          const firstMark = transcriptPanelEl.querySelector('mark');
          if (firstMark) {
            firstMark.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        } else if (m && m.kind === 'flow') {
          const rawTranscript = String(m.item.transcript || '').trim();
          const highlightedBody = rawTranscript
            ? highlightTokens(rawTranscript, activeTokens)
            : '<span class="ig-qcx-transcript-empty">No notes or transcript saved for this automation.</span>';

          transcriptPanelEl.innerHTML = `
            <div class="ig-qcx-transcript-title">🤖 ${esc(m.item.name)}</div>
            <div class="ig-qcx-transcript-body">${highlightedBody}</div>
          `;

          const firstMark = transcriptPanelEl.querySelector('mark');
          if (firstMark) {
            firstMark.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        } else if (m && m.kind === 'text') {
          const rawTranscript = String(m.item.text || '').trim();
          const highlightedBody = rawTranscript
            ? highlightTokens(rawTranscript, activeTokens)
            : '<span class="ig-qcx-transcript-empty">No text saved.</span>';

          transcriptPanelEl.innerHTML = `
            <div class="ig-qcx-transcript-title">📝 ${esc(m.item.title)}</div>
            <div class="ig-qcx-transcript-body">${highlightedBody}</div>
          `;

          const firstMark = transcriptPanelEl.querySelector('mark');
          if (firstMark) {
            firstMark.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        } else if (m && m.kind === 'sequence') {
          const steps = Array.isArray(m.item.steps) ? m.item.steps : [];
          const icons = { audio: '🎵', set: '🖼️', text: '📝' };
          const listHtml = steps.length
            ? steps.map((st, i) => `${i + 1}. ${icons[st.kind] || '•'} ${highlightTokens(st.title || '(untitled)', activeTokens)}`).join('\n')
            : '<span class="ig-qcx-transcript-empty">Empty sequence.</span>';

          transcriptPanelEl.innerHTML = `
            <div class="ig-qcx-transcript-title">📋 ${esc(m.item.name || 'Untitled')}</div>
            <div class="ig-qcx-transcript-body">${listHtml}</div>
          `;
        } else {
          transcriptPanelEl.innerHTML = `<div class="ig-qcx-transcript-empty">Highlight an audio clip, snippet, automation or sequence to preview its text.</div>`;
        }
        positionTranscriptPanel();
      }

      // --- SMOOTH SELECTION FIX ---
      function updateSelection() {
        const rows = dropdownEl.querySelectorAll('.ig-qcx-dd-row');
        rows.forEach((r, i) => {
          if (i === selectedIndex) r.classList.add('selected');
          else r.classList.remove('selected');
        });
        updateTranscriptPanel();
      }

      const gearBtn = document.createElement('button');
      gearBtn.className = 'ig-qcx-gear-btn';
      gearBtn.title = 'Configure custom commands & activation shortcut';
      gearBtn.innerText = '⚙️';
      header.appendChild(gearBtn);

      document.addEventListener('keydown', (e) => {
        if (document.querySelector('.ig-qcx-shortcut-overlay') || document.querySelector('.ig-qcx-modal-overlay')) return;
        if (eventMatchesCombo(e, getShortcutCombo())) {
          e.preventDefault();
          if (!getFloatState().floating) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          input.focus();
          input.select();
        }
      });

      let dropdownOpen = false;
      let matches = [];
      let currentSearchTokens = [];
      let selectedIndex = 0;
      let searchToken = 0;
      let isEmojiMode = false;
      let emojiStartIndex = -1;

      let pendingAudioBlob = null;
      let pendingAudioName = '';
      let pendingTranscript = '';
      let pendingFlowNs = null;
      let pendingFlowName = '';
      let pendingSet = null;
      let previewPlayer = null;
      core.on('tagcolors:updated', () => { if (dropdownOpen) renderDropdown(); }); // 🎨 re-color tags live

      function openDropdown() {
        dropdownOpen = true;
        // While the dropdown is open, Enter/Escape belong to it, not to an active sequence
        input.setAttribute('data-seq-exempt', '1');
        document.body.appendChild(dropdownEl);
        document.body.appendChild(transcriptPanelEl);
        positionDropdown();
        dropdownEl.style.display = 'flex';
        renderDropdown();
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange);
      }
      function closeDropdown() {
        searchToken++;
        input.removeAttribute('data-seq-exempt');
        dropdownOpen = false; isEmojiMode = false; dropdownEl.style.display = 'none';
        transcriptPanelEl.style.display = 'none'; matches = []; currentSearchTokens = []; selectedIndex = 0;
        window.removeEventListener('scroll', onViewportChange, true);
        window.removeEventListener('resize', onViewportChange);
      }
      function onViewportChange() { if (dropdownOpen) { positionDropdown(); positionTranscriptPanel(); } }

      // --- UNIVERSAL ITEM EDITOR MODAL ---
      function openItemEditModal(m) {
        if (document.querySelector('.ig-qcx-modal-overlay')) return;
        const item = m.item;

        const isAudio = m.kind === 'audio';
        const isText = m.kind === 'text';
        const isFlow = m.kind === 'flow';
        const isSet = m.kind === 'set';

        if (!isAudio && !isText && !isFlow && !isSet) return;

        const itemName = item.name || item.title || '';
        const itemCmd = item.customCommand || '';
        const itemBody = item.transcript || item.text || '';

        const overlay = document.createElement('div');
        overlay.className = 'ig-qcx-modal-overlay';

        const bodyLabel = isAudio ? 'Spoken Transcript:' : isText ? 'Message Text:' : isFlow ? 'Transcript / Notes:' : '';

        let bodyHtml = '';
        if (!isSet) {
            bodyHtml = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                    <div class="ig-qcx-modal-label" style="margin:0;">${bodyLabel}</div>
                </div>
                <textarea id="ig-qcx-edit-body" class="ig-qcx-modal-textarea">${String(itemBody).replace(/</g, '&lt;')}</textarea>
            `;
        }

        let cmdHtml = '';
        if (!isFlow && !isSet) {
            cmdHtml = `
                <div class="ig-qcx-modal-label">Custom Command:</div>
                <div style="display:flex; align-items:center; gap:4px;">
                  <span style="color:#94a3b8; font-weight:bold;">/</span>
                  <input type="text" id="ig-qcx-edit-cmd" class="ig-qcx-modal-input" placeholder="e.g. saludo" value="${itemCmd.replace(/"/g, '&quot;')}">
                </div>
            `;
        }

        overlay.innerHTML = `
          <div class="ig-qcx-modal">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3>✏️ Quick Edit (${m.kind})</h3>
              <button id="ig-qcx-edit-close" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:14px;">✕</button>
            </div>

            <div class="ig-qcx-modal-label">Name / Title:</div>
            <input type="text" id="ig-qcx-edit-name" class="ig-qcx-modal-input" value="${itemName.replace(/"/g, '&quot;')}">

            ${cmdHtml}
            ${bodyHtml}

            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
              <button id="ig-qcx-edit-cancel" style="background:transparent; color:#94a3b8; border:none; cursor:pointer; font-weight:bold;">Cancel</button>
              <button id="ig-qcx-edit-save" style="background:#10b981; color:#fff; border:none; padding:7px 14px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 Save Changes</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);

        const closeMod = () => { overlay.remove(); input.focus(); };
        overlay.querySelector('#ig-qcx-edit-close').onclick = closeMod;
        overlay.querySelector('#ig-qcx-edit-cancel').onclick = closeMod;

        overlay.querySelector('#ig-qcx-edit-save').onclick = () => {
            const newName = overlay.querySelector('#ig-qcx-edit-name').value.trim();
            const cmdEl = overlay.querySelector('#ig-qcx-edit-cmd');
            const newCmd = cmdEl ? cmdEl.value.trim().replace(/^\/+/, '') : itemCmd;
            const bodyEl = overlay.querySelector('#ig-qcx-edit-body');
            const newBody = bodyEl ? bodyEl.value : itemBody;

            if (isAudio) {
                withDb(db => {
                    const tx = db.transaction(['clips'], 'readwrite');
                    const store = tx.objectStore('clips');
                    store.get(item.id).onsuccess = (ev) => {
                        const c = ev.target.result;
                        if (c) {
                            c.name = newName;
                            c.customCommand = newCmd;
                            c.transcript = newBody;
                            store.put(c);
                        }
                    };
                    tx.oncomplete = () => {
                        core.emit('library:refresh');
                        recomputeMatches();
                        closeMod();
                    };
                });
            } else if (isText) {
                const data = getTextLibraryData();
                const found = data.items.find(i => i.id === item.id);
                if (found) {
                    found.title = newName;
                    found.customCommand = newCmd;
                    found.text = newBody;
                    saveTextLibraryData(data);
                    core.emit('textlib:external-refresh');
                    recomputeMatches();
                    closeMod();
                }
            } else if (isFlow) {
                let mcFlows = [];
                try { mcFlows = JSON.parse(localStorage.getItem(MC_FLOWS_KEY)) || []; } catch(e){}
                const found = mcFlows.find(f => f.flow_ns === item.flow_ns);
                if (found) {
                    found.name = newName;
                    found.transcript = newBody;
                    localStorage.setItem(MC_FLOWS_KEY, JSON.stringify(mcFlows));
                    core.emit('block:ready', {id: 'manychatModule'});
                    recomputeMatches();
                    closeMod();
                }
            } else if (isSet) {
                const req = indexedDB.open('IG_ImageSets_Core_DB', 1);
                req.onsuccess = e => {
                    const db = e.target.result;
                    const tx = db.transaction(['sets'], 'readwrite');
                    const store = tx.objectStore('sets');
                    store.get(item.id).onsuccess = ev => {
                        const c = ev.target.result;
                        if (c) {
                            c.title = newName;
                            store.put(c);
                        }
                    };
                    tx.oncomplete = () => {
                        core.emit('images:external-refresh');
                        recomputeMatches();
                        closeMod();
                    };
                };
            }
        };
      }

      function renderDropdown() {
        dropdownEl.innerHTML = '';
        if (!matches.length) {
          dropdownEl.innerHTML = '<div class="ig-qcx-dd-empty">No matches</div>';
          updateTranscriptPanel(); return;
        }

        const tokens = currentSearchTokens;

        matches.forEach((m, idx) => {
          const row = document.createElement('div');
          row.className = 'ig-qcx-dd-row' + (idx === selectedIndex ? ' selected' : '');

          let editBtnHtml = '';
          if (['audio', 'text', 'flow', 'set'].includes(m.kind)) {
              editBtnHtml = `<button class="ig-qcx-dd-edit-btn" title="Quick Edit">✏️</button>`;
          } else if (m.kind === 'sequence') {
              editBtnHtml = `<button class="ig-qcx-dd-edit-btn" title="Edit in Sequence Manager">✏️</button>`;
          }

          if (m.kind === 'emoji') {
            row.innerHTML = `<div class="ig-qcx-dd-row-top"><span style="font-size:16px;">${m.item.e}</span><span class="ig-qcx-dd-title" style="font-family:monospace;">:${esc(m.item.k)}</span></div>`;
          } else if (m.kind === 'folder' || m.kind === 'folder-new') {
            const icon = m.kind === 'folder-new' ? '➕' : '📁';
            const label = m.kind === 'folder-new' ? `Create "${esc(m.name)}"` : esc(m.name);
            row.innerHTML = `<div class="ig-qcx-dd-row-top"><span>${icon}</span><span class="ig-qcx-dd-title">${label}</span></div>`;
          } else if (m.kind === 'flow') {
            const titleHtml = formatTitleWithTags(m.item.name, tokens);
            row.innerHTML = `<div class="ig-qcx-dd-row-top"><span>🤖</span><span class="ig-qcx-dd-title">${titleHtml}</span>${editBtnHtml}</div>`;
          } else if (m.kind === 'sequence') {
            const titleHtml = formatTitleWithTags(m.item.name, tokens);
            const n = Array.isArray(m.item.steps) ? m.item.steps.length : 0;
            row.innerHTML = `<div class="ig-qcx-dd-row-top"><span>📋</span><span class="ig-qcx-dd-title">${titleHtml}</span><span class="ig-qcx-dd-cmd">▶ ${n} step${n === 1 ? '' : 's'}</span>${editBtnHtml}</div>`;
          } else if (m.kind === 'set') {
            const titleHtml = formatTitleWithTags(m.item.title, tokens);
            row.innerHTML = `<div class="ig-qcx-dd-row-top"><span>🖼️</span><span class="ig-qcx-dd-title">${titleHtml}</span>${editBtnHtml}</div>`;
          } else if (m.kind === 'text') {
            const titleHtml = formatTitleWithTags(m.item.title, tokens);
            const cmdBadge = m.item.customCommand ? `<span class="ig-qcx-dd-cmd">/${esc(m.item.customCommand)}</span>` : '';
            row.innerHTML = `<div class="ig-qcx-dd-row-top"><span>📝</span><span class="ig-qcx-dd-title">${titleHtml}</span>${cmdBadge}${editBtnHtml}</div>`;
          } else {
            const titleHtml = formatTitleWithTags(m.item.name, tokens);
            const cmdBadge = m.item.customCommand ? `<span class="ig-qcx-dd-cmd">/${esc(m.item.customCommand)}</span>` : '';
            row.innerHTML = `<div class="ig-qcx-dd-row-top"><span>🎵</span><span class="ig-qcx-dd-title">${titleHtml}</span>${cmdBadge}${editBtnHtml}</div>`;
          }

          row.onmouseenter = () => {
            if (selectedIndex !== idx) {
                selectedIndex = idx;
                updateSelection();
            }
          };
          row.onclick = () => { selectedIndex = idx; pickSelected(); };

          const editBtn = row.querySelector('.ig-qcx-dd-edit-btn');
          if (editBtn) {
              editBtn.onclick = (e) => {
                  e.stopPropagation();
                  if (m.kind === 'sequence') {
                      input.value = '';
                      closeDropdown();
                      core.emit('sequence:edit-request', { id: m.item.id });
                      return;
                  }
                  openItemEditModal(m);
                  closeDropdown();
              };
          }

          dropdownEl.appendChild(row);
        });
        updateTranscriptPanel();
      }

      async function recomputeMatches() {
        const val = input.value;
        const cursor = input.selectionStart;
        const textBefore = val.slice(0, cursor);

        const emojiMatch = textBefore.match(/(?:^|\s):([a-zA-Z0-9_]*)$/);
        if (emojiMatch) {
          isEmojiMode = true; emojiStartIndex = cursor - emojiMatch[1].length - 1;
          const q = emojiMatch[1].toLowerCase();
          matches = emojiDict.filter(item => item.k.includes(q)).map(item => ({ kind: 'emoji', item: item }));
          currentSearchTokens = [];
          selectedIndex = 0;
          if (matches.length > 0) openDropdown(); else closeDropdown();
          return;
        }

        isEmojiMode = false;
        const saveFolderMatch = val.match(/^\/save\s+audio\s+([^.]*)$/i);
        if (saveFolderMatch) {
          const token = ++searchToken;
          const rawQuery = saveFolderMatch[1].trim();
          const query = normalizeStr(rawQuery);
          const folders = await getAllFolders();
          if (token !== searchToken) return; // stale (user kept typing)
          const filtered = folders.filter(f => !query || normalizeStr(f).includes(query));
          matches = filtered.map(f => ({ kind: 'folder', name: f }));
          if (query && !folders.some(f => normalizeStr(f) === query)) matches.push({ kind: 'folder-new', name: rawQuery });
          currentSearchTokens = [];
          selectedIndex = 0; openDropdown(); return;
        }

        // "/save" for text: keep the list closed and claim Enter (even during an active sequence)
        if (parseSaveText(val) !== null) { closeDropdown(); input.setAttribute('data-seq-exempt', '1'); return; }

        // Slash mode: only a leading "/" opens the list. Instant mode: any non-blank text does.
        const hasSlash = val.startsWith('/');
        if (!hasSlash && (!instantSearch || !val.trim())) { closeDropdown(); return; }

        if (/^\/save\s+audio\s+[^.]+\..*$/i.test(val)) { closeDropdown(); return; }

        const remainder = hasSlash ? val.slice(1) : val.trimStart();
        const lower = remainder.toLowerCase();
        if (lower.startsWith('user ') || lower === 'user') { closeDropdown(); return; }

        // Prefixes: /text /audio /flow /set /seq (or /sequence) — parsed + scored in LegoCore
        const { mode, q } = core.parseSearchPrefix(remainder);
        const token = ++searchToken;
        const results = await core.searchInventory(q, mode, { limit: 8 });
        if (token !== searchToken) return; // stale (user kept typing)

        currentSearchTokens = getSearchTokens(q);
        matches = results;
        selectedIndex = 0;

        if (matches.length > 0) openDropdown(); else closeDropdown();
      }

      function pickSelected() {
        if (!matches.length) return;
        const m = matches[selectedIndex];
        if (isEmojiMode && m.kind === 'emoji') {
          const val = input.value, cursor = input.selectionStart;
          const before = val.substring(0, emojiStartIndex), after = val.substring(cursor);
          const insert = m.item.e + ' ';
          input.value = before + insert + after; closeDropdown(); input.focus();
          const newPos = emojiStartIndex + insert.length; input.setSelectionRange(newPos, newPos);
          return;
        }
        if (m.kind === 'folder' || m.kind === 'folder-new') {
          input.value = `/save audio ${m.name}.`; closeDropdown(); input.focus();
          input.setSelectionRange(input.value.length, input.value.length); return;
        }
        if (m.kind === 'sequence') {
          // Sequences are not buffered: picking one activates it right away (raises the HUD).
          input.value = ''; closeDropdown(); clearPending();
          if (!core.setActiveSequence(m.item)) {   // setActiveSequence also records MRU
            previewBar.style.display = 'flex'; previewLabel.innerText = '⚠️ Sequence is empty';
            previewPlayBtn.style.display = 'none'; previewSaveBtn.style.display = 'none';
            setTimeout(() => clearPending(), 1500);
          }
          input.focus(); return;
        }
        if (m.kind === 'flow') {
          pendingFlowNs = m.item.flow_ns; pendingFlowName = m.item.name;
          markUsed('flow', m.item.flow_ns);
          input.value = ''; closeDropdown(); showFlowPreview(); input.focus(); return;
        }
        if (m.kind === 'set') {
          pendingSet = m.item; markUsed('set', m.item.id);
          input.value = ''; closeDropdown(); showSetPreview(); input.focus(); return;
        }
        if (m.kind === 'text') {
          markUsed('text', m.item.id);
          input.value = m.item.text; clearPending(); closeDropdown(); input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        } else {
          markUsed('audio', m.item.id);
          pendingAudioBlob = m.item.blob; pendingAudioName = m.item.name; pendingTranscript = m.item.transcript || '';
          input.value = ''; closeDropdown(); showAudioPreview(); input.focus();
        }
      }

      function showFlowPreview() {
        previewBar.style.display = 'flex';
        previewLabel.innerText = '🤖 ' + pendingFlowName;
        previewPlayBtn.style.display = 'none';
        previewSaveBtn.style.display = 'none';
      }
      function showAudioPreview() {
        previewBar.style.display = 'flex';
        previewLabel.innerText = '🎵 ' + pendingAudioName;
        previewPlayBtn.style.display = '';
        previewSaveBtn.style.display = '';
      }
      function showSetPreview() {
        previewBar.style.display = 'flex';
        previewLabel.innerText = `🖼️ ${pendingSet.title} (${pendingSet.images.length} img)`;
        previewPlayBtn.style.display = 'none';
        previewSaveBtn.style.display = 'none';
      }

      function clearPending() {
        pendingAudioBlob = null; pendingAudioName = ''; pendingTranscript = '';
        pendingFlowNs = null; pendingFlowName = ''; pendingSet = null;
        previewBar.style.display = 'none';
        if (previewPlayer) { previewPlayer.pause(); previewPlayer = null; }
        previewPlayBtn.innerText = '▶️';
        previewPlayBtn.style.display = '';
        previewSaveBtn.style.display = '';
        previewDiscardBtn.style.display = '';
      }

      previewPlayBtn.onclick = () => {
        if (!pendingAudioBlob) return;
        if (!previewPlayer) {
          previewPlayer = new Audio(URL.createObjectURL(pendingAudioBlob));
          previewPlayBtn.innerText = '⏹️'; previewPlayer.play();
          previewPlayer.onended = () => { previewPlayBtn.innerText = '▶️'; previewPlayer = null; };
        } else { previewPlayer.pause(); previewPlayer = null; previewPlayBtn.innerText = '▶️'; }
      };

      // --- INLINE QUICK SAVE MODAL ---
      async function openSaveClipModal(prefill) {
        prefill = (prefill && typeof prefill === 'object' && !(prefill instanceof Event)) ? prefill : {};
        if (!pendingAudioBlob) return alert("No audio loaded to save.");
        if (document.querySelector('.ig-qcx-modal-overlay')) return;

        const folders = await getAllFolders();
        if (prefill.folder && !folders.includes(prefill.folder)) folders.unshift(prefill.folder);
        const defaultName = prefill.name || (pendingTranscript ? pendingTranscript.slice(0, 30).trim() : pendingAudioName);

        const overlay = document.createElement('div');
        overlay.className = 'ig-qcx-modal-overlay';
        overlay.innerHTML = `
          <div class="ig-qcx-modal">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3>💾 Save Audio Clip</h3>
              <button id="ig-qcx-save-close" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:14px;">✕</button>
            </div>

            <div class="ig-qcx-modal-label">Clip Name:</div>
            <input type="text" id="ig-qcx-save-name" class="ig-qcx-modal-input" value="${esc(defaultName)}">

            <div class="ig-qcx-modal-label">Folder / Group:</div>
            <div style="display:flex; gap:6px;">
              <select id="ig-qcx-save-folder-select" class="ig-qcx-modal-input" style="flex:1;">
                ${folders.map(f => `<option value="${esc(f)}" ${f === prefill.folder ? 'selected' : ''}>${esc(f)}</option>`).join('')}
                <option value="__new__">+ New Folder...</option>
              </select>
              <input type="text" id="ig-qcx-save-folder-new" class="ig-qcx-modal-input" placeholder="New folder name" style="flex:1; display:none;">
            </div>

            <div class="ig-qcx-modal-label">Custom Command (Optional):</div>
            <div style="display:flex; align-items:center; gap:4px;">
              <span style="color:#94a3b8; font-weight:bold;">/</span>
              <input type="text" id="ig-qcx-save-cmd" class="ig-qcx-modal-input" placeholder="e.g. saludo">
            </div>

            <div class="ig-qcx-modal-label">Spoken Transcript:</div>
            <textarea id="ig-qcx-save-transcript" class="ig-qcx-modal-textarea" placeholder="Transcript text...">${String(pendingTranscript || '').replace(/</g, '&lt;')}</textarea>

            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
              <button id="ig-qcx-save-cancel" style="background:transparent; color:#94a3b8; border:none; cursor:pointer; font-weight:bold;">Cancel</button>
              <button id="ig-qcx-save-confirm" style="background:#10b981; color:#fff; border:none; padding:7px 14px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 Commit to Library</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);

        const folderSel = overlay.querySelector('#ig-qcx-save-folder-select');
        const folderNewInput = overlay.querySelector('#ig-qcx-save-folder-new');

        folderSel.onchange = () => {
          if (folderSel.value === '__new__') {
            folderNewInput.style.display = 'block';
            folderNewInput.focus();
          } else {
            folderNewInput.style.display = 'none';
          }
        };

        const close = () => overlay.remove();
        overlay.querySelector('#ig-qcx-save-close').onclick = close;
        overlay.querySelector('#ig-qcx-save-cancel').onclick = close;

        overlay.querySelector('#ig-qcx-save-confirm').onclick = () => {
          const finalName = overlay.querySelector('#ig-qcx-save-name').value.trim() || pendingAudioName;
          let finalFolder = folderSel.value;
          if (finalFolder === '__new__') finalFolder = folderNewInput.value.trim() || 'General';
          const finalCmd = overlay.querySelector('#ig-qcx-save-cmd').value.trim().replace(/^\/+/, '');
          const finalTx = overlay.querySelector('#ig-qcx-save-transcript').value.trim();

          withDb(db => {
            const tx = db.transaction(['folders', 'clips'], 'readwrite');
            tx.objectStore('folders').put({ name: finalFolder });
            const store = tx.objectStore('clips');
            const countReq = store.count();
            countReq.onsuccess = () => {
              store.add({
                name: finalName,
                folder: finalFolder,
                color: '#0095f6',
                order: countReq.result,
                blob: pendingAudioBlob,
                customCommand: finalCmd,
                transcript: finalTx
              });
            };
            tx.oncomplete = () => {
              core.emit('folders:refresh');
              core.emit('library:refresh');
              previewLabel.innerText = `✅ Saved to ${finalFolder} / ${finalName}`;
              setTimeout(() => clearPending(), 1200);
              close();
            };
          });
        };
      }

      previewSaveBtn.onclick = () => openSaveClipModal();
      previewDiscardBtn.onclick = () => clearPending();

      function sendImageSet(setObj, btnEl) {
        // Shared core bridge: the whole set goes in ONE DataTransfer (one drop = one album)
        if (!core.injectImageSetToChat(setObj.images || [])) return;
        const original = btnEl.innerText; btnEl.innerText = '⏳';
        setTimeout(() => { btnEl.innerText = '✅'; setTimeout(() => { btnEl.innerText = original; clearPending(); }, 1000); }, 200);
      }

      function sendText(text) {
        const chatZone = core.getActiveChatZone();
        if (!chatZone) { alert("Open an active chat window first."); return; }
        chatZone.focus();
        document.execCommand('insertText', false, text);
        chatZone.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      }

      function sendCurrent() {
        if (pendingAudioBlob) { core.injectClipToChat(pendingAudioBlob, pendingAudioName); clearPending(); return; }
        if (pendingSet) { sendImageSet(pendingSet, sendBtn); return; }
        if (pendingFlowNs) {
          const original = sendBtn.innerText; sendBtn.innerText = '⏳'; previewLabel.innerText = '🤖 Sending...';
          sendManyChatFlow(pendingFlowNs)
            .then(() => { sendBtn.innerText = '✅'; previewLabel.innerText = '✅ Sent!'; setTimeout(() => { sendBtn.innerText = original; clearPending(); }, 1500); })
            .catch(err => { alert('Failed: ' + err.message); sendBtn.innerText = '❌'; previewLabel.innerText = '❌ Failed'; setTimeout(() => { sendBtn.innerText = original; previewLabel.innerText = '🤖 ' + pendingFlowName; }, 1500); });
          return;
        }
        const text = input.value.trim(); if (!text) return;
        input.value = ''; const original = sendBtn.innerText;
        sendBtn.innerText = '✅'; sendBtn.style.background = '#059669';
        setTimeout(() => { sendBtn.innerText = original; sendBtn.style.background = '#10b981'; }, 1000);
        sendText(text);
      }
      sendBtn.onclick = sendCurrent;

      // Short status message in the preview bar (same pattern as /user)
      function flashNote(text, ms) {
        if (pendingAudioBlob || pendingFlowNs || pendingSet) return;
        previewBar.style.display = 'flex'; previewLabel.innerText = text;
        previewPlayBtn.style.display = 'none'; previewSaveBtn.style.display = 'none'; previewDiscardBtn.style.display = 'none';
        clearTimeout(flashNote.t);
        flashNote.t = setTimeout(() => {
          if (pendingAudioBlob || pendingFlowNs || pendingSet) return;
          previewBar.style.display = 'none';
          previewPlayBtn.style.display = ''; previewSaveBtn.style.display = ''; previewDiscardBtn.style.display = '';
        }, ms || 1800);
      }

      // ================= /save → SAVE TEXT SNIPPET =================
      function openSaveSnippetModal(text) {
        if (document.querySelector('.ig-qcx-modal-overlay')) return;
        const data = getTextLibraryData();
        const folders = data.items.filter(i => i.type === 'folder').sort((a, b) => (a.order || 0) - (b.order || 0));
        const tags = data.tags || [];
        const firstLine = (text.split('\n')[0] || '').trim();
        const defaultTitle = firstLine.length > 30 ? firstLine.slice(0, 30).trim() + '…' : firstLine;

        const overlay = document.createElement('div');
        overlay.className = 'ig-qcx-modal-overlay';
        overlay.innerHTML = `
          <div class="ig-qcx-modal">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3>📝 Save Snippet</h3>
              <button class="ig-qcx-snip-close" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:14px;">✕</button>
            </div>
            <div class="ig-qcx-modal-label">Title:</div>
            <input type="text" class="ig-qcx-modal-input ig-qcx-snip-title" value="${esc(defaultTitle)}" placeholder="Snippet title">
            <div class="ig-qcx-modal-label">Folder:</div>
            <div style="display:flex; gap:6px;">
              <select class="ig-qcx-modal-input ig-qcx-snip-folder" style="flex:1;">
                <option value="root">📁 (No folder)</option>
                ${folders.map(f => `<option value="${esc(f.id)}">📁 ${esc(f.name)}</option>`).join('')}
                <option value="__new__">+ New folder…</option>
              </select>
              <input type="text" class="ig-qcx-modal-input ig-qcx-snip-folder-new" placeholder="New folder name" style="flex:1; display:none;">
            </div>
            ${tags.length ? `<div class="ig-qcx-modal-label">Tags:</div>
            <div class="ig-qcx-tag-row">${tags.map(t => `<label><input type="checkbox" class="ig-qcx-snip-tag" data-id="${esc(t.id)}"><span style="color:${esc(t.color || '#c9a876')};">${esc(t.name)}</span></label>`).join('')}</div>` : ''}
            <div class="ig-qcx-modal-label">/Command (optional):</div>
            <input type="text" class="ig-qcx-modal-input ig-qcx-snip-cmd" placeholder="e.g. precio">
            <div class="ig-qcx-modal-label">Text:</div>
            <textarea class="ig-qcx-modal-textarea ig-qcx-snip-text" style="min-height:90px; max-height:220px;">${esc(text)}</textarea>
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
              <button class="ig-qcx-snip-cancel" style="background:transparent; color:#94a3b8; border:none; cursor:pointer; font-weight:bold;">Cancel</button>
              <button class="ig-qcx-snip-save" style="background:#10b981; color:#fff; border:none; padding:7px 14px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 Save</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);

        const titleEl = overlay.querySelector('.ig-qcx-snip-title');
        const folderSel = overlay.querySelector('.ig-qcx-snip-folder');
        const folderNew = overlay.querySelector('.ig-qcx-snip-folder-new');
        const textEl = overlay.querySelector('.ig-qcx-snip-text');
        folderSel.onchange = () => { folderNew.style.display = folderSel.value === '__new__' ? '' : 'none'; if (folderSel.value === '__new__') folderNew.focus(); };

        const close = () => { overlay.remove(); input.focus(); };
        overlay.querySelector('.ig-qcx-snip-close').onclick = close;
        overlay.querySelector('.ig-qcx-snip-cancel').onclick = close;

        function save() {
          const body = textEl.value.trim();
          if (!body) { textEl.focus(); return; }
          const fresh = getTextLibraryData();
          fresh.items = fresh.items || [];
          let parentId = folderSel.value;
          if (parentId === '__new__') {
            const name = folderNew.value.trim();
            if (!name) { folderNew.focus(); return; }
            const existing = fresh.items.find(i => i.type === 'folder' && (i.name || '').toLowerCase() === name.toLowerCase());
            if (existing) parentId = existing.id;
            else {
              parentId = 'fld_' + Date.now();
              fresh.items.push({ id: parentId, type: 'folder', parentId: 'root', name, collapsed: false, order: Date.now() });
            }
          }
          const title = titleEl.value.trim() || (body.length > 25 ? body.substring(0, 25) + '...' : body);
          const tagIds = Array.from(overlay.querySelectorAll('.ig-qcx-snip-tag:checked')).map(cb => cb.dataset.id);
          const cmd = overlay.querySelector('.ig-qcx-snip-cmd').value.trim().replace(/^\/+/, '');
          // Same record shape the Text Library itself creates
          fresh.items.push({ id: 'snip_' + Date.now(), type: 'snippet', parentId, title, text: body, tags: tagIds, customCommand: cmd, order: Date.now() });
          saveTextLibraryData(fresh);
          core.emit('textlib:external-refresh');
          overlay.remove();
          input.value = ''; closeDropdown(); input.focus();
          flashNote('✅ Snippet saved: ' + title);
        }
        overlay.querySelector('.ig-qcx-snip-save').onclick = save;
        overlay.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
          if (ev.key === 'Enter' && (ev.target !== textEl || ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
        });
        titleEl.focus(); titleEl.select();
      }

      // ================= IMAGE TRAY (drop / paste → reorder → save as set or paste) =================
      const chatUI = wrapper.parentElement; // the Quick Chat block's own root (moves with the float)
      let trayImages = [];
      let dragThumbIdx = null;

      const tray = document.createElement('div');
      tray.className = 'ig-qcx-tray';
      tray.innerHTML = `
        <div class="ig-qcx-tray-strip"></div>
        <div class="ig-qcx-tray-bar">
          <span class="ig-qcx-tray-count"></span>
          <button class="ig-qcx-tray-btn primary ig-qcx-tray-save" title="Save as an Image Set">💾 Save set</button>
          <button class="ig-qcx-tray-btn go ig-qcx-tray-paste" title="Put these images in the Instagram chat box (you press Enter to send)">📥 Paste</button>
          <button class="ig-qcx-tray-btn ig-qcx-tray-clear" title="Clear">🗑️</button>
        </div>`;
      chatUI.insertBefore(tray, wrapper);
      const trayStrip = tray.querySelector('.ig-qcx-tray-strip');
      const trayCount = tray.querySelector('.ig-qcx-tray-count');

      function clearDropMarks() { trayStrip.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after')); }

      function renderTray() {
        tray.classList.toggle('show', trayImages.length > 0);
        trayCount.textContent = `🖼️ ${trayImages.length} image${trayImages.length === 1 ? '' : 's'} · drag to reorder`;
        trayStrip.innerHTML = '';
        trayImages.forEach((img, idx) => {
          const th = document.createElement('div');
          th.className = 'ig-qcx-tray-thumb';
          th.draggable = true;
          th.innerHTML = `<img src="${img.thumb}" alt=""><span class="ig-qcx-tray-num">${idx + 1}</span><button class="ig-qcx-tray-del" title="Remove">✕</button>`;
          th.querySelector('.ig-qcx-tray-del').onclick = (ev) => { ev.stopPropagation(); trayImages.splice(idx, 1); renderTray(); };
          th.addEventListener('dragstart', (ev) => { dragThumbIdx = idx; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'qcx-thumb'); setTimeout(() => th.classList.add('dragging'), 0); });
          th.addEventListener('dragend', () => { dragThumbIdx = null; th.classList.remove('dragging'); clearDropMarks(); });
          th.addEventListener('dragover', (ev) => {
            if (dragThumbIdx === null) return;
            ev.preventDefault(); ev.stopPropagation();
            clearDropMarks();
            if (dragThumbIdx === idx) return;
            const r = th.getBoundingClientRect();
            th.classList.add(ev.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
          });
          th.addEventListener('drop', (ev) => {
            if (dragThumbIdx === null) return;
            ev.preventDefault(); ev.stopPropagation();
            const r = th.getBoundingClientRect();
            let to = ev.clientX < r.left + r.width / 2 ? idx : idx + 1;
            const from = dragThumbIdx;
            const [moved] = trayImages.splice(from, 1);
            if (from < to) to--;
            trayImages.splice(to, 0, moved);
            dragThumbIdx = null; renderTray();
          });
          trayStrip.appendChild(th);
        });
      }

      async function addTrayFiles(fileList) {
        const files = Array.from(fileList || []).filter(f => f && f.type && f.type.startsWith('image/'));
        if (!files.length) return;
        trayCount.textContent = '⏳ Processing…'; tray.classList.add('show');
        for (const file of files) {
          const thumb = await compressThumbnail(file);
          trayImages.push({ id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5), type: file.type, blob: file, thumb });
        }
        renderTray();
      }

      function clearTray() { trayImages = []; renderTray(); }

      tray.querySelector('.ig-qcx-tray-clear').onclick = clearTray;
      tray.querySelector('.ig-qcx-tray-paste').onclick = () => {
        if (!trayImages.length) return;
        if (core.injectImageSetToChat(trayImages)) { clearTray(); flashNote('📥 Images in the chat box — press Enter there to send'); }
      };
      tray.querySelector('.ig-qcx-tray-save').onclick = () => openSaveImageSetModal();

      function saveImageSetToDb(title, images) {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open('IG_ImageSets_Core_DB', 1);
          req.onupgradeneeded = e => {  // same schema as the Image Sets module, in case it never ran
            const d = e.target.result;
            if (!d.objectStoreNames.contains('sets')) d.createObjectStore('sets', { keyPath: 'id' }).createIndex('order', 'order', { unique: false });
          };
          req.onerror = () => reject(req.error);
          req.onsuccess = e => {
            const d = e.target.result;
            const tx = d.transaction(['sets'], 'readwrite');
            const store = tx.objectStore('sets');
            const countReq = store.count();
            countReq.onsuccess = () => store.add({ id: 'set_' + Date.now(), title, images, order: countReq.result });
            tx.oncomplete = () => { d.close(); resolve(); };
            tx.onerror = () => { d.close(); reject(tx.error); };
          };
        });
      }

      function openSaveImageSetModal() {
        if (!trayImages.length || document.querySelector('.ig-qcx-modal-overlay')) return;
        const overlay = document.createElement('div');
        overlay.className = 'ig-qcx-modal-overlay';
        overlay.innerHTML = `
          <div class="ig-qcx-modal">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3>🖼️ Save Image Set (${trayImages.length})</h3>
              <button class="ig-qcx-set-close" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:14px;">✕</button>
            </div>
            <div class="ig-qcx-modal-label">Set title:</div>
            <input type="text" class="ig-qcx-modal-input ig-qcx-set-title" placeholder="e.g. Fotos precios">
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
              <button class="ig-qcx-set-cancel" style="background:transparent; color:#94a3b8; border:none; cursor:pointer; font-weight:bold;">Cancel</button>
              <button class="ig-qcx-set-save" style="background:#6366f1; color:#fff; border:none; padding:7px 14px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 Save</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        const titleEl = overlay.querySelector('.ig-qcx-set-title');
        const close = () => { overlay.remove(); input.focus(); };
        overlay.querySelector('.ig-qcx-set-close').onclick = close;
        overlay.querySelector('.ig-qcx-set-cancel').onclick = close;
        const saveBtn = overlay.querySelector('.ig-qcx-set-save');
        async function save() {
          if (saveBtn.disabled) return;
          const title = titleEl.value.trim() || 'Untitled Set';
          saveBtn.disabled = true; saveBtn.innerText = '⏳';
          try {
            await saveImageSetToDb(title, trayImages.slice());
            core.emit('images:external-refresh'); core.emit('images:updated');
            clearTray(); close(); flashNote('✅ Image set saved: ' + title);
          } catch (err) { alert('Could not save the image set: ' + (err && err.message || err)); saveBtn.disabled = false; saveBtn.innerText = '💾 Save'; }
        }
        saveBtn.onclick = save;
        overlay.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Escape') { ev.preventDefault(); close(); }
          else if (ev.key === 'Enter') { ev.preventDefault(); save(); }
        });
        titleEl.focus();
      }

      // File drops anywhere on the Quick Chat box (docked or floating) go to the tray — never to Instagram.
      // Capture phase on window so Instagram's own drop handlers never see them.
      function inDropZone(t) { return !!(t && t.closest && (chatUI.contains(t) || (floatShell && floatShell.contains(t)))); }
      function hasFiles(e) { return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')); }
      let hoverEl = null;
      function setHover(on) {
        const el = floatShell && floatShell.isConnected ? floatShell : chatUI;
        if (hoverEl && hoverEl !== el) hoverEl.classList.remove('ig-qcx-drop-hover');
        hoverEl = el; el.classList.toggle('ig-qcx-drop-hover', on);
      }
      ['dragenter', 'dragover'].forEach(type => window.addEventListener(type, (e) => {
        if (!hasFiles(e)) return;
        if (!inDropZone(e.target)) { if (hoverEl) setHover(false); return; }
        e.preventDefault(); e.stopImmediatePropagation();
        e.dataTransfer.dropEffect = 'copy'; setHover(true);
      }, true));
      window.addEventListener('dragleave', (e) => { if (hoverEl && !e.relatedTarget) setHover(false); }, true);
      window.addEventListener('drop', (e) => {
        if (hoverEl) setHover(false);
        if (!hasFiles(e) || !inDropZone(e.target)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        addTrayFiles(e.dataTransfer.files);
      }, true);

      // Ctrl+V a screenshot into the box → tray
      input.addEventListener('paste', (e) => {
        const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(f => f.type.startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        addTrayFiles(files);
      });

      // ================= FLOATING WINDOW (📌) =================
      let floatShell = null;
      const pinBtn = document.createElement('button');
      pinBtn.className = 'ig-qcx-hdr-btn';
      pinBtn.innerText = '📌';
      pinBtn.title = 'Pop out as a floating window (always on top)';
      header.insertBefore(pinBtn, gearBtn);

      const stub = document.createElement('div');
      stub.className = 'ig-qcx-float-stub';
      stub.innerHTML = `<span>💬 Floating window</span><button type="button">Dock</button>`;
      stub.querySelector('button').onclick = () => dock();

      // Anything with max z-index added to <body> after us would paint on top (equal z → later wins).
      // Slide such elements in *before* the float instead of moving the float (moving it would steal focus).
      const ALLOW_ABOVE = /ig-qcx-|ig-seq-|modal-overlay/;
      const topWatcher = new MutationObserver((muts) => {
        if (!floatShell || !floatShell.isConnected) return;
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || n === floatShell || n.parentNode !== document.body) continue;
          if (ALLOW_ABOVE.test(n.getAttribute('class') || '')) continue;
          const z = parseInt(getComputedStyle(n).zIndex, 10);
          if (z >= 2147483647 && (floatShell.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) {
            document.body.insertBefore(n, floatShell);
          }
        }
      });

      function clampShell(st) {
        const w = floatShell.offsetWidth, h = floatShell.offsetHeight;
        st.x = Math.max(0, Math.min(st.x, window.innerWidth - Math.min(w, 120)));
        st.y = Math.max(0, Math.min(st.y, window.innerHeight - 36));
        if (st.y + h > window.innerHeight && h < window.innerHeight) st.y = Math.max(0, window.innerHeight - h);
        floatShell.style.left = st.x + 'px'; floatShell.style.top = st.y + 'px';
      }

      function buildShell() {
        floatShell = document.createElement('div');
        floatShell.className = 'ig-qcx-float';
        floatShell.innerHTML = `<div class="ig-qcx-float-bar"><span class="ig-qcx-float-title">💬 Quick Chat</span></div><div class="ig-qcx-float-body"></div>`;
        const bar = floatShell.querySelector('.ig-qcx-float-bar');

        // Drag by the title bar
        bar.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || e.target.closest('button')) return;
          e.preventDefault();
          const st = getFloatState();
          const startX = e.clientX, startY = e.clientY;
          const baseX = floatShell.offsetLeft, baseY = floatShell.offsetTop;
          bar.setPointerCapture(e.pointerId);
          const move = (ev) => { st.x = baseX + ev.clientX - startX; st.y = baseY + ev.clientY - startY; clampShell(st); };
          const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); saveFloatState(st); };
          bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up);
        });

        // Resize from the native corner handle; only remember size after a real user resize
        floatShell.addEventListener('pointerdown', (e) => {
          const r = floatShell.getBoundingClientRect();
          if (e.clientX < r.right - 18 || e.clientY < r.bottom - 18) return;
          const up = () => {
            window.removeEventListener('pointerup', up, true);
            const st = getFloatState(); st.w = floatShell.offsetWidth; st.h = floatShell.offsetHeight; saveFloatState(st);
          };
          window.addEventListener('pointerup', up, true);
        });
      }

      function floatOut() {
        if (!floatShell) buildShell();
        const st = getFloatState();
        const body = floatShell.querySelector('.ig-qcx-float-body');
        const bar = floatShell.querySelector('.ig-qcx-float-bar');
        const hadFocus = document.activeElement === input;
        chatUI.parentNode.insertBefore(stub, chatUI);
        body.appendChild(chatUI);
        bar.appendChild(pinBtn); bar.appendChild(gearBtn);
        pinBtn.innerText = '📥'; pinBtn.title = 'Dock back into the sidebar';
        floatShell.style.width = (st.w || 360) + 'px';
        floatShell.style.height = st.h ? st.h + 'px' : '';
        document.body.appendChild(floatShell);   // last in <body> → above every equal-z element present now
        if (st.x === null || st.y === null) { st.x = window.innerWidth - floatShell.offsetWidth - 24; st.y = window.innerHeight - floatShell.offsetHeight - 24; }
        clampShell(st);
        st.floating = true; saveFloatState(st);
        topWatcher.observe(document.body, { childList: true });
        if (dropdownOpen) positionDropdown();
        if (hadFocus || !document.activeElement || document.activeElement === document.body) input.focus();
      }

      function dock() {
        if (!floatShell) return;
        topWatcher.disconnect();
        const hadFocus = document.activeElement === input;
        stub.replaceWith(chatUI);
        header.appendChild(pinBtn); header.appendChild(gearBtn);
        pinBtn.innerText = '📌'; pinBtn.title = 'Pop out as a floating window (always on top)';
        floatShell.remove();
        const st = getFloatState(); st.floating = false; saveFloatState(st);
        closeDropdown();
        if (hadFocus) input.focus();
      }

      pinBtn.onclick = (e) => { e.stopPropagation(); (floatShell && floatShell.isConnected) ? dock() : floatOut(); };
      window.addEventListener('resize', () => { if (floatShell && floatShell.isConnected) clampShell(getFloatState()); });
      if (getFloatState().floating) floatOut();

      input.addEventListener('input', () => { recomputeMatches(); });
      input.addEventListener('keydown', (e) => {
        // SEQUENCE GATE: with the dropdown closed, Enter/Escape belong to the Sequence Manager.
        const saveArmed = e.key === 'Enter' && parseSaveText(input.value) !== null;
        if (sequenceIsActive() && !dropdownOpen && !saveArmed && (e.key === 'Enter' || e.key === 'Escape')) return;

        if (dropdownOpen) {
          if (e.key === 'ArrowDown') { e.preventDefault(); if (matches.length) { selectedIndex = (selectedIndex + 1) % matches.length; updateSelection(); } return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); if (matches.length) { selectedIndex = (selectedIndex - 1 + matches.length) % matches.length; updateSelection(); } return; }
          if ((e.key === 'Enter' || e.key === 'Tab') && matches.length) { e.preventDefault(); e.stopPropagation(); pickSelected(); return; }
          if (e.key === 'Escape') { e.preventDefault(); closeDropdown(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault(); e.stopPropagation(); const val = input.value.trim();
          const saveMatch = val.match(/^\/save\s+audio\s+([^.]+)\.(.*)$/i);
          // FIX: saveAudioToLibrary() no longer existed in v28.1 -> route to the Quick Save modal, prefilled
          if (saveMatch) { input.value = ''; closeDropdown(); openSaveClipModal({ folder: saveMatch[1].trim(), name: saveMatch[2].trim() }); return; }
          const saveText = parseSaveText(val);
          if (saveText !== null) { closeDropdown(); openSaveSnippetModal(saveText); return; }
          const userMatch = val.match(/^\/user\s+(.+)$/i);
          if (userMatch) {
            const overrideUser = userMatch[1].trim().replace(/^@/, ''); input.value = ''; closeDropdown();
            core.emit('mc:manual-override', overrideUser);
            previewBar.style.display = 'flex'; previewLabel.innerText = '✅ Username set to @' + overrideUser;
            previewPlayBtn.style.display = 'none'; previewSaveBtn.style.display = 'none'; previewDiscardBtn.style.display = 'none';
            setTimeout(() => { previewBar.style.display = 'none'; previewDiscardBtn.style.display = ''; }, 2000);
            return;
          }
          sendCurrent(); return;
        }
        if (e.key === 'Escape') { if (pendingAudioBlob || pendingFlowNs || pendingSet) clearPending(); }
      });
      document.addEventListener('click', (e) => { if (dropdownOpen && !wrapper.contains(e.target) && !dropdownEl.contains(e.target)) closeDropdown(); });

      let mediaRecorder;
      let audioChunks = [];
      let isRecording = false;
      let isFinishing = false;
      let lagTimeoutId = null;
      let activeSessionId = 0;
      let discardNextStop = false;

      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

        mediaRecorder.onstop = async () => {
          let blob = new Blob(audioChunks, { type: 'audio/mp4' });
          audioChunks = [];

          if (discardNextStop) { discardNextStop = false; return; }

          const mySession = activeSessionId;
          const effectsEnabled = localStorage.getItem(EFFECTS_KEY) !== 'false';
          const trimStart = effectsEnabled && localStorage.getItem('sb_quick_autotrim_start') === 'true';
          const trimEnd = effectsEnabled && localStorage.getItem('sb_quick_autotrim_end') === 'true';
          const threshold = localStorage.getItem('sb_quick_silence_threshold') || '0.035';

          if (trimStart || trimEnd) blob = await detectAndTrimSilence(blob, trimStart, trimEnd, threshold);
          if (mySession !== activeSessionId) return;

          pendingAudioBlob = blob;
          pendingAudioName = 'quick_audio_' + Date.now();
          pendingTranscript = '';
          showAudioPreview();
        };
      }).catch(err => console.warn("[QuickCommandExtension] Mic error:", err));

      recordBtn.onclick = () => {
        if (!mediaRecorder) { alert("Microphone not initialized."); return; }
        if (isFinishing) {
            clearTimeout(lagTimeoutId); isFinishing = false; discardNextStop = true; activeSessionId = Date.now();
            if (mediaRecorder.state === 'recording') {
                const restartHandler = () => {
                    clearPending(); audioChunks = []; mediaRecorder.start(); isRecording = true;
                    recordBtn.classList.add('recording'); recordBtn.classList.remove('finishing'); recordBtn.innerText = '⏹️';
                    mediaRecorder.removeEventListener('stop', restartHandler);
                };
                mediaRecorder.addEventListener('stop', restartHandler); mediaRecorder.stop();
            }
            return;
        }
        if (!isRecording) {
          clearPending(); audioChunks = []; activeSessionId = Date.now(); mediaRecorder.start(); isRecording = true;
          recordBtn.classList.add('recording'); recordBtn.classList.remove('finishing'); recordBtn.innerText = '⏹️';
        } else {
          isFinishing = true; const lagMs = parseInt(localStorage.getItem('sb_quick_trailing_lag')) || 800;
          recordBtn.innerText = '⏳'; recordBtn.classList.remove('recording'); recordBtn.classList.add('finishing');
          lagTimeoutId = setTimeout(() => {
            isFinishing = false; isRecording = false;
            if (mediaRecorder.state === 'recording') mediaRecorder.stop();
            recordBtn.classList.remove('finishing'); recordBtn.innerText = '🔴';
          }, lagMs);
        }
      };

      document.addEventListener('click', async (e) => {
        if (!e.target.closest('.ig-qcx-gear-btn')) return;
        e.stopPropagation();
        if (document.querySelector('.ig-qcx-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'ig-qcx-modal-overlay';
        overlay.innerHTML = `
          <div class="ig-qcx-modal">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3>⚙️ Settings & Commands</h3>
              <button id="ig-qcx-mgr-close" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:14px;">✕</button>
            </div>

            <div class="ig-qcx-shortcut-row" style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.03); border-radius:6px; padding:8px;">
              <div style="font-size:11px; color:#94a3b8;">⌨️ Jump-to-box shortcut<br><span class="ig-qcx-shortcut-current" style="color:#c9a876; font-weight:bold; font-size:12px;">${esc(formatCombo(getShortcutCombo()))}</span></div>
              <button class="ig-qcx-shortcut-change" style="background:#1e293b; border:1px solid #475569; color:#fff; padding:5px 10px; border-radius:4px; font-size:10px; cursor:pointer;">Change</button>
            </div>
            <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; background:rgba(255,255,255,0.03); border-radius:6px; padding:8px; cursor:pointer; user-select:none;">
              <div style="font-size:11px; color:#94a3b8;">⚡ Instant search<br><span style="font-size:10px; opacity:0.75;">Show the list as you type — no "/" needed</span></div>
              <input type="checkbox" id="ig-qcx-instant-chk" ${instantSearch ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
            </label>
            <input type="text" id="ig-qcx-mgr-search" class="ig-qcx-mgr-search" placeholder="🔍 Search items...">
            <div id="ig-qcx-mgr-list" class="ig-qcx-mgr-list"></div>
          </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#ig-qcx-mgr-close').onclick = () => overlay.remove();
        overlay.querySelector('#ig-qcx-instant-chk').onchange = (ev) => setInstantSearch(ev.target.checked);

        const shortcutCurrentEl = overlay.querySelector('.ig-qcx-shortcut-current');
        const shortcutChangeBtn = overlay.querySelector('.ig-qcx-shortcut-change');
        shortcutChangeBtn.onclick = () => {
          shortcutCurrentEl.innerText = 'Press a key combo… (Esc cancels)';
          shortcutChangeBtn.disabled = true;
          function cleanup() { document.removeEventListener('keydown', captureKey, true); shortcutChangeBtn.disabled = false; }
          function captureKey(ev) {
            ev.preventDefault(); ev.stopPropagation();
            if (ev.key === 'Escape') { shortcutCurrentEl.innerText = formatCombo(getShortcutCombo()); cleanup(); return; }
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(ev.key)) return;
            const combo = { key: ev.key, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, meta: ev.metaKey };
            saveShortcutCombo(combo); shortcutCurrentEl.innerText = formatCombo(combo); cleanup();
          }
          document.addEventListener('keydown', captureKey, true);
        };

        const { clips, textItems } = await core.getSearchableInventory();
        const listEl = overlay.querySelector('#ig-qcx-mgr-list');
        const searchEl = overlay.querySelector('#ig-qcx-mgr-search');

        function renderMgrList() {
          const term = searchEl.value.toLowerCase();
          listEl.innerHTML = '';
          const combined = [ ...textItems.map(i => ({ kind: 'text', item: i })), ...clips.map(c => ({ kind: 'audio', item: c })) ]
            .filter(x => { const name = x.kind === 'text' ? x.item.title : x.item.name; return !term || (name || '').toLowerCase().includes(term); });

          if (!combined.length) { listEl.innerHTML = '<div style="padding:10px; text-align:center; color:#94a3b8; font-size:10px;">Nothing found.</div>'; return; }

          combined.forEach(x => {
            const row = document.createElement('div'); row.className = 'ig-qcx-mgr-row';
            const name = x.kind === 'text' ? x.item.title : x.item.name;
            const icon = x.kind === 'text' ? '📝' : '🎵';
            row.innerHTML = `
              <span>${icon}</span><span class="ig-qcx-mgr-name" title="${esc(name)}">${esc(name)}</span><span style="opacity:0.5;">/</span>
              <input type="text" class="ig-qcx-mgr-cmd-input" placeholder="command" value="${esc(x.item.customCommand || '')}">
            `;
            const cmdInput = row.querySelector('.ig-qcx-mgr-cmd-input');
            cmdInput.onchange = () => {
              const val = cmdInput.value.trim().replace(/^\/+/, '');
              if (x.kind === 'text') {
                const data = getTextLibraryData(); const found = data.items.find(i => i.id === x.item.id);
                if (found) { found.customCommand = val; saveTextLibraryData(data); x.item.customCommand = val; core.emit('textlib:external-refresh'); }
              } else {
                withDb(db => {
                  const tx = db.transaction(['clips'], 'readwrite');
                  tx.objectStore('clips').get(x.item.id).onsuccess = ev => {
                    const c = ev.target.result;
                    if (c) { c.customCommand = val; tx.objectStore('clips').put(c); x.item.customCommand = val; }
                  };
                });
              }
            };
            listEl.appendChild(row);
          });
        }
        renderMgrList(); searchEl.oninput = renderMgrList;
      });
    }

    function initWatcher(attempts) {
      tryEnhance();
      if (enhanced) return;
      attempts = attempts === undefined ? 30 : attempts;
      if (attempts > 0) setTimeout(() => initWatcher(attempts - 1), 300);
    }
    initWatcher();

    function attachObserver(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      const left = document.getElementById('ig-left-menu-container');
      const right = document.getElementById('ig-right-menu-container');
      if (!left && !right) {
        if (attemptsLeft > 0) setTimeout(() => attachObserver(attemptsLeft - 1), 300);
        return;
      }
      [left, right].forEach(container => {
        if (!container) return;
        const observer = new MutationObserver(() => tryEnhance());
        observer.observe(container, { childList: true, subtree: true });
      });
    }
    attachObserver();

    core.emit('block:ready', { id: 'quickCommandExtension' });
  }
});

/* ============================================================
   BLOCK: Reorder Module (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Menu Card Reorder Module (v2 - Infinite Loop Fixed)
   ------------------------------------------------------------
   Standalone plugin -- no dependency on any other block.
   Lets you drag a card by its header and drop it above/below any
   other card in the same panel to reorder it. Order is saved per
   side (left/right) to localStorage.
================================================================ */
LegoCore.registerBlock({
  id: 'menuCardReorderModule',
  init(core) {
    const STORAGE_KEY = 'ig_menu_card_order_v1';
    let orderData = {};
    try { orderData = JSON.parse(localStorage.getItem(STORAGE_KEY)) || { left: [], right: [] }; }
    catch (e) { orderData = { left: [], right: [] }; }
    if (!orderData.left) orderData.left = [];
    if (!orderData.right) orderData.right = [];

    function saveOrder() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(orderData));
    }

    const style = document.createElement('style');
    style.id = 'ig-menu-reorder-styles';
    style.innerHTML = `
      .ig-menu-header { -webkit-user-drag: element; }
      .ig-menu-header button,
      .ig-menu-header select,
      .ig-menu-header input {
        -webkit-user-drag: none;
      }
      .ig-draggable-menu.ig-reorder-dragging { opacity: 0.35; }
      .ig-draggable-menu.ig-reorder-drop-top { box-shadow: inset 0 3px 0 0 var(--igls-accent, #c9a876); }
      .ig-draggable-menu.ig-reorder-drop-bottom { box-shadow: inset 0 -3px 0 0 var(--igls-accent, #c9a876); }
    `;
    document.head.appendChild(style);

    let draggedCard = null;

    function clearDropIndicators() {
      document.querySelectorAll('.ig-reorder-drop-top, .ig-reorder-drop-bottom').forEach(el => {
        el.classList.remove('ig-reorder-drop-top', 'ig-reorder-drop-bottom');
      });
    }

    function recordOrder(container, side) {
      orderData[side] = Array.from(container.children)
        .filter(el => el.classList && el.classList.contains('ig-draggable-menu'))
        .map(el => el.dataset.key)
        .filter(Boolean);
      saveOrder();
    }

    function applyStoredOrder(container, side) {
      const order = orderData[side] || [];
      order.forEach(key => {
        const card = container.querySelector('[data-key="' + key + '"]');
        if (card) container.appendChild(card);
      });
    }

    function processCard(card, side, container) {
      const header = card.querySelector('.ig-menu-header');
      if (!header || header.dataset.reorderBound) return;
      header.dataset.reorderBound = 'true';
      header.setAttribute('draggable', 'true');

      header.addEventListener('dragstart', (e) => {
        draggedCard = card;
        card.classList.add('ig-reorder-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', card.dataset.key || ''); } catch (err) {}
      });

      header.addEventListener('dragend', () => {
        card.classList.remove('ig-reorder-dragging');
        clearDropIndicators();
        draggedCard = null;
      });

      card.addEventListener('dragover', (e) => {
        if (!draggedCard || draggedCard === card) return;
        if (draggedCard.parentElement !== card.parentElement) return;
        e.preventDefault();
        const rect = card.getBoundingClientRect();
        const isTop = (e.clientY - rect.top) < rect.height / 2;
        card.classList.toggle('ig-reorder-drop-top', isTop);
        card.classList.toggle('ig-reorder-drop-bottom', !isTop);
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('ig-reorder-drop-top', 'ig-reorder-drop-bottom');
      });

      card.addEventListener('drop', (e) => {
        if (!draggedCard || draggedCard === card) return;
        if (draggedCard.parentElement !== card.parentElement) return;
        e.preventDefault();
        const rect = card.getBoundingClientRect();
        const isTop = (e.clientY - rect.top) < rect.height / 2;
        card.classList.remove('ig-reorder-drop-top', 'ig-reorder-drop-bottom');
        const parent = card.parentElement;
        if (isTop) parent.insertBefore(draggedCard, card);
        else parent.insertBefore(draggedCard, card.nextSibling);
        recordOrder(parent, side);
      });
    }

    function attachToContainer(containerId, side) {
      const container = document.getElementById(containerId);
      if (!container) return;

      applyStoredOrder(container, side);
      container.querySelectorAll('.ig-draggable-menu').forEach(card => processCard(card, side, container));

      const observer = new MutationObserver(() => {
        // FIX: Pause observer to prevent infinite loop during DOM appendChild operations
        observer.disconnect();

        container.querySelectorAll('.ig-draggable-menu').forEach(card => processCard(card, side, container));
        applyStoredOrder(container, side);

        // Resume observer after DOM is settled
        observer.observe(container, { childList: true });
      });

      observer.observe(container, { childList: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('ig-left-menu-container');
      const right = document.getElementById('ig-right-menu-container');
      if (left && right) {
        attachToContainer('ig-left-menu-container', 'left');
        attachToContainer('ig-right-menu-container', 'right');
      } else if (attempts > 0) {
        setTimeout(() => initWatcher(attempts - 1), 200);
      }
    }
    initWatcher(15);

    console.log('[MenuCardReorderModule] Drag-to-reorder enabled and stabilized.');
    core.emit('block:ready', { id: 'menuCardReorderModule' });
  }
});

/* ============================================================
   BLOCK: Text Library Height Fix (v1) (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Text Library Height Fix (v3 - Fixes Popout Too)
   ============================================================ */
/* ================================================================
   BLOCK: Text Library Height Fix (Standalone Feature Plugin)
   - Does NOT modify the Text Library Module block's code.
   - v2 fixed the docked sidebar card but not the popped-out
     floating window, because .ig-floating-modal itself only gets
     an explicit height once the user has manually dragged its
     resize handle at least once -- before that it's just
     content-sized (auto), so "height:100%" on .ig-menu-content
     had nothing definite to resolve against.
   - v3 gives the floating modal a real default height via CSS.
     Inline styles (set by the popout module once you actually
     resize it) still win over this, so manual resizing continues
     to work exactly as before -- this only sets the *starting*
     size.
   - Scoped only to the Text Library card (data-key="text-library-module")
     so no other card is affected.
================================================================ */
LegoCore.registerBlock({
  id: 'textLibraryHeightFix',
  init(core) {
    const style = document.createElement('style');
    style.id = 'ig-text-lib-height-fix-styles';
    style.innerHTML = `
      /* Docked sidebar card */
      .ig-draggable-menu[data-key="text-library-module"] .ig-menu-content {
        display: flex;
        flex-direction: column;
        height: 60vh;
        max-height: 80vh;
        min-height: 200px;
      }
      .ig-draggable-menu[data-key="text-library-module"] .ig-tln-container {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .ig-draggable-menu[data-key="text-library-module"] .ig-tln-tree {
        max-height: none !important;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }

      /* Popped-out floating window -- give the modal a real default
         height so its flex children (.ig-menu-content is already
         flex:1 from the popout module's own CSS) have something to
         grow into. Inline styles from manual resizing still override
         this since they come after in the cascade. */
      .ig-floating-modal[id="ig-float-modal-text-library-module"] {
        height: 70vh;
        min-height: 300px;
      }
      .ig-floating-modal[id="ig-float-modal-text-library-module"] .ig-tln-container {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .ig-floating-modal[id="ig-float-modal-text-library-module"] .ig-tln-tree {
        max-height: none !important;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }
    `;
    document.head.appendChild(style);

    console.log('[TextLibraryHeightFix v3] Text Library tree now fills both the docked card and the popped-out window.');
    core.emit('block:ready', { id: 'textLibraryHeightFix' });
  }
});

/* ============================================================
   BLOCK: Reset menus (v1)
   ============================================================ */
/* ================================================================
   BLOCK: Floating Menu Rescue Module (Reset Positions)
   ================================================================ */
LegoCore.registerBlock({
  id: 'floatingMenuRescueModule',
  init(core) {
    // Create a small, subtle button fixed to the bottom left
    const resetBtn = document.createElement('button');
    resetBtn.innerText = '⛑️ Reset Menus';
    resetBtn.title = 'Click to reset all floating window positions if they get stuck off-screen';

    resetBtn.style.cssText = `
      position: fixed;
      bottom: 12px;
      left: 12px;
      z-index: 2147483647;
      background: rgba(220, 38, 38, 0.7);
      color: white;
      border: 1px solid #7f1d1d;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: bold;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      transition: opacity 0.2s, background 0.2s;
      opacity: 0.4;
    `;

    // Make it fully visible only when hovered so it stays out of the way
    resetBtn.onmouseover = () => {
      resetBtn.style.opacity = '1';
      resetBtn.style.background = 'rgba(220, 38, 38, 1)';
    };
    resetBtn.onmouseout = () => {
      resetBtn.style.opacity = '0.4';
      resetBtn.style.background = 'rgba(220, 38, 38, 0.7)';
    };

    resetBtn.onclick = () => {
      if (confirm("Reset all floating menu positions? This will reload the page.")) {
        // 1. Clear Popped-out cards
        localStorage.removeItem('ig_menu_inpage_popouts_v1');

        // 2. Clear Workspace Profile window
        localStorage.removeItem('ig_workspace_profile_window_pos_v1');

        // 3. Clear Text Library Filter window
        localStorage.removeItem('ig_tl_notion_filter_pos');

        // Reload to apply the fresh state
        window.location.reload();
      }
    };

    document.body.appendChild(resetBtn);

    core.emit('block:ready', { id: 'floatingMenuRescueModule' });
  }
});

/* ============================================================
   BLOCK: Image Library (v2)
   ============================================================ */
/* ============================================================
   BLOCK: Image Sets Library (v3 - Cleaned UI)
   ============================================================ */
LegoCore.registerBlock({
  id: 'imageSetsLibraryModule',
  init(core) {
    const DB_NAME = 'IG_ImageSets_Core_DB';
    const DB_VERSION = 1;
    let db = null;
    let draggedItem = null;

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = e => console.error("[ImageSets] DB Error:", e);
    request.onupgradeneeded = e => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('sets')) {
        const store = database.createObjectStore('sets', { keyPath: 'id' });
        store.createIndex('order', 'order', { unique: false });
      }
    };
    request.onsuccess = e => {
      db = e.target.result;
      renderTree();
    };

    const style = document.createElement('style');
    style.id = 'ig-image-sets-styles';
    style.innerHTML = `
      .ig-isl-container { display: flex; flex-direction: column; gap: 8px; font-family: -apple-system, sans-serif; font-size: 11px; flex: 1; min-height: 0; }
      .ig-isl-header-btns { display: flex; gap: 4px; }
      .ig-isl-hbtn { flex: 1; background: var(--igls-surface-2, #1c1c23); color: #e2e8f0; border: 1px solid #334155; border-radius: 4px; padding: 6px 4px; font-size: 10px; font-weight: bold; cursor: pointer; transition: 0.2s; text-align: center; }
      .ig-isl-hbtn:hover { background: #334155; color: #fff; }
      .ig-isl-tree { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding-right: 2px; }
      .ig-isl-tree::-webkit-scrollbar { width: 4px; }
      .ig-isl-tree::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }
      .ig-isl-row { display: flex; align-items: center; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.03); background: rgba(255,255,255,0.01); cursor: grab; transition: background 0.2s; }
      .ig-isl-row:hover { background: rgba(255,255,255,0.05); }
      .ig-isl-row.alt { background: rgba(255,255,255,0.02); }
      .ig-isl-row:active { cursor: grabbing; }
      .ig-isl-grip { color: #475569; font-size: 10px; cursor: grab; margin-right: 6px; flex-shrink: 0; }
      .ig-isl-title { flex: 1; font-size: 11px; color: #f8fafc; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
      .ig-isl-count-badge { font-size: 9px; background: rgba(255,255,255,0.1); color: #c9a876; padding: 2px 6px; border-radius: 8px; font-weight: bold; margin: 0 8px; flex-shrink: 0; }
      .ig-isl-actions { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
      .ig-isl-btn { background: transparent; border: none; color: #64748b; cursor: pointer; font-size: 11px; padding: 3px 6px; border-radius: 4px; transition: 0.2s; }
      .ig-isl-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .ig-isl-send-btn { background: #10b981; color: #fff; border-radius: 4px; padding: 4px 8px; font-weight: bold; font-size: 10px; }
      .ig-isl-send-btn:hover { background: #059669; color: #fff; }
      .ig-isl-drop-top { border-top: 2px solid #10b981 !important; }
      .ig-isl-drop-bottom { border-bottom: 2px solid #10b981 !important; }
      .ig-isl-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 2147483647; display: flex; justify-content: center; align-items: center; }
      .ig-isl-modal { background: #0f172a; border: 1px solid #334155; border-radius: 8px; width: 360px; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 10px 25px rgba(0,0,0,0.5); overflow: hidden; }
      .ig-isl-modal-header { padding: 16px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
      .ig-isl-modal-header h3 { margin: 0; font-size: 14px; color: #fff; }
      .ig-isl-modal-body { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; flex: 1; }
      .ig-isl-modal-footer { padding: 12px 16px; border-top: 1px solid #334155; display: flex; justify-content: space-between; background: #1e293b; }
      .ig-isl-input { width: 100%; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 8px; border-radius: 4px; font-size: 12px; box-sizing: border-box; outline: none; }
      .ig-isl-input:focus { border-color: #6366f1; }
      .ig-isl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap: 8px; margin-top: 8px; }
      .ig-isl-thumb-wrap { position: relative; aspect-ratio: 1; background: #1e293b; border: 1px solid #334155; border-radius: 4px; overflow: hidden; }
      .ig-isl-thumb-wrap img { width: 100%; height: 100%; object-fit: cover; }
      .ig-isl-thumb-del { position: absolute; top: 2px; right: 2px; background: rgba(220,38,38,0.9); color: #fff; border: none; width: 18px; height: 18px; border-radius: 3px; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .ig-isl-thumb-del:hover { background: #b91c1c; }
    `;
    document.head.appendChild(style);

    const libUI = document.createElement('div');
    libUI.className = 'ig-isl-container';
    libUI.innerHTML = `
      <div class="ig-isl-header-btns">
        <button id="ig-isl-new-set" class="ig-isl-hbtn">➕ New Image Set</button>
      </div>
      <div id="ig-isl-tree" class="ig-isl-tree"></div>
    `;

    function compressThumbnail(file, maxSize = 200) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            if (w > maxSize || h > maxSize) {
              const ratio = Math.min(maxSize / w, maxSize / h);
              w *= ratio; h *= ratio;
            }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    function openSetEditor(existingSet) {
      const isEdit = !!existingSet;
      let draftImages = isEdit ? [...existingSet.images] : [];

      const overlay = document.createElement('div');
      overlay.className = 'ig-isl-modal-overlay';
      overlay.innerHTML = `
        <div class="ig-isl-modal">
          <div class="ig-isl-modal-header">
            <h3>${isEdit ? '✏️ Edit Image Set' : '🖼️ New Image Set'}</h3>
            <button id="ig-isl-close" style="background:none; border:none; color:#94a3b8; cursor:pointer;">✕</button>
          </div>
          <div class="ig-isl-modal-body">
            <div>
              <div style="font-size:11px; font-weight:bold; color:#94a3b8; margin-bottom:4px;">Set Title:</div>
              <input type="text" id="ig-isl-title" class="ig-isl-input" placeholder="e.g. Welcome Package..." value="${isEdit ? existingSet.title : ''}">
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <div style="font-size:11px; font-weight:bold; color:#94a3b8;">Images: <span id="ig-isl-count">0</span></div>
                <button id="ig-isl-add-imgs" style="background:#334155; color:#fff; border:none; padding:4px 8px; border-radius:4px; font-size:10px; cursor:pointer;">➕ Add Files</button>
                <input type="file" id="ig-isl-file-input" accept="image/*" multiple style="display:none;">
              </div>
              <div id="ig-isl-grid" class="ig-isl-grid"></div>
            </div>
          </div>
          <div class="ig-isl-modal-footer">
            <div style="display:flex; gap:8px;">
              ${isEdit ? '<button id="ig-isl-delete" style="background:#dc2626; color:#fff; border:none; padding:6px 12px; border-radius:4px; font-weight:bold; cursor:pointer;">🗑️ Delete Set</button>' : '<div></div>'}
            </div>
            <div style="display:flex; gap:8px;">
              <button id="ig-isl-cancel" style="background:transparent; color:#94a3b8; border:none; cursor:pointer; font-weight:bold;">Cancel</button>
              <button id="ig-isl-save" style="background:#6366f1; color:#fff; border:none; padding:6px 12px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 Save</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const gridEl = overlay.querySelector('#ig-isl-grid');
      const countEl = overlay.querySelector('#ig-isl-count');
      const titleInput = overlay.querySelector('#ig-isl-title');
      const fileInput = overlay.querySelector('#ig-isl-file-input');

      function renderGrid() {
        gridEl.innerHTML = '';
        countEl.innerText = draftImages.length;
        draftImages.forEach((imgObj, idx) => {
          const wrap = document.createElement('div');
          wrap.className = 'ig-isl-thumb-wrap';
          wrap.innerHTML = `<img src="${imgObj.thumb}" alt="thumb"><button class="ig-isl-thumb-del" data-idx="${idx}">✕</button>`;
          wrap.querySelector('.ig-isl-thumb-del').onclick = () => { draftImages.splice(idx, 1); renderGrid(); };
          gridEl.appendChild(wrap);
        });
      }
      renderGrid();

      overlay.querySelector('#ig-isl-add-imgs').onclick = () => fileInput.click();

      fileInput.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        const addBtn = overlay.querySelector('#ig-isl-add-imgs');
        addBtn.innerText = '⏳ Processing...';
        addBtn.disabled = true;

        for (let file of files) {
          const thumb = await compressThumbnail(file);
          draftImages.push({
            id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            type: file.type, blob: file, thumb: thumb
          });
        }
        fileInput.value = ''; addBtn.innerText = '➕ Add Files'; addBtn.disabled = false; renderGrid();
      };

      const closeModal = () => overlay.remove();
      overlay.querySelector('#ig-isl-close').onclick = closeModal;
      overlay.querySelector('#ig-isl-cancel').onclick = closeModal;

      if (isEdit) {
        overlay.querySelector('#ig-isl-delete').onclick = () => {
          if (!confirm("Permanently delete this entire image set?")) return;
          const tx = db.transaction(['sets'], 'readwrite');
          tx.objectStore('sets').delete(existingSet.id);
          tx.oncomplete = () => { renderTree(); closeModal(); core.emit('images:updated'); };
        };
      }

      overlay.querySelector('#ig-isl-save').onclick = () => {
        const title = titleInput.value.trim() || 'Untitled Set';
        if (!draftImages.length) { alert("Please add at least one image to save a set."); return; }
        const tx = db.transaction(['sets'], 'readwrite');
        const store = tx.objectStore('sets');

        if (isEdit) {
          existingSet.title = title; existingSet.images = draftImages; store.put(existingSet);
        } else {
          const countReq = store.count();
          countReq.onsuccess = () => {
            store.add({ id: 'set_' + Date.now(), title: title, images: draftImages, order: countReq.result });
          };
        }
        tx.oncomplete = () => { renderTree(); closeModal(); core.emit('images:updated'); };
      };
    }

    libUI.querySelector('#ig-isl-new-set').onclick = () => openSetEditor(null);

    function openPreviewModal(setObj) {
      const overlay = document.createElement('div');
      overlay.className = 'ig-isl-modal-overlay';
      const thumbsHtml = setObj.images.map(img => `<div class="ig-isl-thumb-wrap"><img src="${img.thumb}" alt="thumb"></div>`).join('');
      overlay.innerHTML = `
        <div class="ig-isl-modal">
          <div class="ig-isl-modal-header">
            <h3>👁️ Preview: ${setObj.title}</h3>
            <button id="ig-isl-close-prev" style="background:none; border:none; color:#94a3b8; cursor:pointer;">✕</button>
          </div>
          <div class="ig-isl-modal-body"><div class="ig-isl-grid">${thumbsHtml}</div></div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector('#ig-isl-close-prev').onclick = close;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }

    function handleDragStart(e, id) { draggedItem = id; e.dataTransfer.effectAllowed = 'move'; setTimeout(() => e.target.style.opacity = '0.3', 0); }
    function handleDragOver(e, id) {
      e.preventDefault(); e.stopPropagation();
      const targetEl = e.currentTarget;
      document.querySelectorAll('.ig-isl-drop-top, .ig-isl-drop-bottom').forEach(el => el.classList.remove('ig-isl-drop-top', 'ig-isl-drop-bottom'));
      if (!draggedItem || draggedItem === id) return;
      const rect = targetEl.getBoundingClientRect(); const y = e.clientY - rect.top;
      if (y < rect.height / 2) targetEl.classList.add('ig-isl-drop-top'); else targetEl.classList.add('ig-isl-drop-bottom');
    }
    function handleDrop(e, targetId) {
      e.preventDefault(); e.stopPropagation();
      if (!draggedItem || draggedItem === targetId) return;
      const targetEl = e.currentTarget; const rect = targetEl.getBoundingClientRect(); const y = e.clientY - rect.top;
      const tx = db.transaction(['sets'], 'readwrite');
      const store = tx.objectStore('sets');
      store.getAll().onsuccess = ev => {
        const sets = ev.target.result.sort((a,b) => (a.order || 0) - (b.order || 0));
        const dragIdx = sets.findIndex(s => s.id === draggedItem);
        const targetIdx = sets.findIndex(s => s.id === targetId);
        if (dragIdx > -1 && targetIdx > -1) {
          const [moved] = sets.splice(dragIdx, 1);
          if (y < rect.height / 2) sets.splice(targetIdx, 0, moved); else sets.splice(targetIdx + 1, 0, moved);
          sets.forEach((s, i) => { s.order = i; store.put(s); });
        }
      };
      tx.oncomplete = () => { draggedItem = null; renderTree(); };
    }

    function sendImageSet(setObj, btnEl) {
      const chatZone = core.getActiveChatZone();
      if (!chatZone) { alert("Open an active Instagram chat window first."); return; }
      const original = btnEl.innerText; btnEl.innerText = '⏳';
      const dt = new DataTransfer();
      setObj.images.forEach((imgData, i) => {
        const ext = imgData.type ? imgData.type.split('/')[1] : 'jpeg';
        const fileObj = new File([imgData.blob], `image_${i}.${ext}`, { type: imgData.type || 'image/jpeg' });
        dt.items.add(fileObj);
      });
      ['dragenter', 'dragover', 'drop'].forEach(eventType => {
        chatZone.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: dt }));
      });
      setTimeout(() => { btnEl.innerText = '✅'; setTimeout(() => btnEl.innerText = '📤 Send', 1000); }, 200);
    }

    function renderTree() {
      if (!db) return;
      const tree = libUI.querySelector('#ig-isl-tree');
      tree.innerHTML = '';
      const tx = db.transaction(['sets'], 'readonly');
      tx.objectStore('sets').getAll().onsuccess = e => {
        const sets = (e.target.result || []).sort((a,b) => (a.order || 0) - (b.order || 0));
        if (!sets.length) {
          tree.innerHTML = '<div style="padding:12px; color:#94a3b8; font-size:10px; text-align:center;">No Image Sets yet. Click New to bundle images together.</div>';
          return;
        }
        sets.forEach((set, idx) => {
          const row = document.createElement('div');
          row.className = `ig-isl-row ${idx % 2 === 0 ? 'alt' : ''}`;
          row.draggable = true;
          row.innerHTML = `
            <span class="ig-isl-grip">⠿</span>
            <span class="ig-isl-title" title="${set.title}">${set.title}</span>
            <span class="ig-isl-count-badge">🖼️ ${set.images.length}</span>
            <div class="ig-isl-actions">
              <button class="ig-isl-btn prev-btn" title="Preview Contents">👁️</button>
              <button class="ig-isl-btn edit-btn" title="Edit Set">✏️</button>
              <button class="ig-isl-send-btn" title="Send all images in this set">📤 Send</button>
            </div>
          `;
          row.addEventListener('dragstart', (ev) => handleDragStart(ev, set.id));
          row.addEventListener('dragend', (ev) => { ev.target.style.opacity = '1'; draggedItem = null; });
          row.addEventListener('dragover', (ev) => handleDragOver(ev, set.id));
          row.addEventListener('dragleave', (ev) => ev.currentTarget.classList.remove('ig-isl-drop-top', 'ig-isl-drop-bottom'));
          row.addEventListener('drop', (ev) => handleDrop(ev, set.id));
          row.querySelector('.prev-btn').onclick = () => openPreviewModal(set);
          row.querySelector('.edit-btn').onclick = () => openSetEditor(set);
          row.querySelector('.ig-isl-send-btn').onclick = (ev) => sendImageSet(set, ev.target);
          tree.appendChild(row);
        });
      };
    }

    core.on('images:external-refresh', () => { renderTree(); });

    function mountCard(attemptsLeft = 10) {
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '🖼️ Image Sets', libUI, '⠿', 'image-sets-library');
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    core.emit('block:ready', { id: 'imageSetsLibraryModule' });
  }
});

/* ============================================================
   BLOCK: Emoji Module (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Emoji Settings Module (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'emojiSettingsModule',
  init(core) {
    const STORAGE_KEY = 'ig_emoji_dict_v1';

    const defaultEmojis = [
      { e: '😀', k: 'happy' }, { e: '😂', k: 'laugh' }, { e: '🤣', k: 'rofl' },
      { e: '😍', k: 'hearteyes' }, { e: '🥰', k: 'love' }, { e: '😊', k: 'smile' },
      { e: '🙏', k: 'pray' }, { e: '👍', k: 'thumbsup' }, { e: '👎', k: 'thumbsdown' },
      { e: '🔥', k: 'fire' }, { e: '❤️', k: 'heart' }, { e: '💔', k: 'brokenheart' },
      { e: '✨', k: 'sparkles' }, { e: '💯', k: '100' }, { e: '✅', k: 'check' },
      { e: '❌', k: 'x' }, { e: '💀', k: 'skull' }, { e: '😭', k: 'cry' },
      { e: '👀', k: 'eyes' }, { e: '🙌', k: 'praise' }, { e: '🤔', k: 'think' },
      { e: '😎', k: 'cool' }, { e: '😉', k: 'wink' }, { e: '🤷', k: 'shrug' },
      { e: '🤦', k: 'facepalm' }, { e: '🎉', k: 'party' }, { e: '👏', k: 'clap' },
      { e: '🤝', k: 'deal' }, { e: '🚀', k: 'rocket' }, { e: '💡', k: 'idea' }
    ];

    let dict = [];
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) dict = JSON.parse(saved);
      else dict = defaultEmojis;
    } catch(e) { dict = defaultEmojis; }

    function saveDict() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dict));
      core.emit('emoji:updated', dict); // Alert Quick Command to update
      renderList();
    }

    const style = document.createElement('style');
    style.innerHTML = `
      .ig-emj-wrap { display:flex; flex-direction:column; gap:10px; font-family:-apple-system,sans-serif; font-size:11px; color:#fff; }
      .ig-emj-input-row { display:flex; gap:4px; align-items:center; background:#18181b; padding:8px; border-radius:6px; border:1px solid #334155; }
      .ig-emj-input { background:#0f172a; color:#fff; border:1px solid #334155; border-radius:4px; padding:6px; font-size:11px; outline:none; }
      .ig-emj-input:focus { border-color:#6366f1; }
      .ig-emj-btn { background:#10b981; color:#fff; border:none; border-radius:4px; padding:6px 10px; font-weight:bold; cursor:pointer; }
      .ig-emj-btn:hover { background:#059669; }
      .ig-emj-list { display:flex; flex-direction:column; gap:4px; max-height:220px; overflow-y:auto; padding-right:4px; }
      .ig-emj-list::-webkit-scrollbar { width:4px; }
      .ig-emj-list::-webkit-scrollbar-thumb { background:#334155; border-radius:4px; }
      .ig-emj-row { display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.03); padding:4px 8px; border-radius:5px; border:1px solid rgba(255,255,255,0.05); }
      .ig-emj-symbol { font-size:16px; margin-right:8px; }
      .ig-emj-keyword { color:#c9a876; font-weight:bold; font-family:monospace; }
      .ig-emj-del { background:transparent; border:none; color:#64748b; cursor:pointer; font-size:10px; }
      .ig-emj-del:hover { color:#f87171; }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'ig-emj-wrap';
    wrap.innerHTML = `
      <div class="ig-emj-input-row">
        <input type="text" id="ig-emj-val" class="ig-emj-input" placeholder="😀" style="width:30px; text-align:center;" maxlength="4">
        <input type="text" id="ig-emj-key" class="ig-emj-input" placeholder="keyword (e.g. happy)" style="flex:1;">
        <button id="ig-emj-add" class="ig-emj-btn">➕</button>
      </div>
      <div id="ig-emj-list" class="ig-emj-list"></div>
    `;

    function renderList() {
      const listEl = wrap.querySelector('#ig-emj-list');
      listEl.innerHTML = '';
      dict.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'ig-emj-row';
        row.innerHTML = `
          <div><span class="ig-emj-symbol">${item.e}</span> <span class="ig-emj-keyword">:${item.k}</span></div>
          <button class="ig-emj-del" data-idx="${index}">✕</button>
        `;
        row.querySelector('.ig-emj-del').onclick = () => {
          dict.splice(index, 1);
          saveDict();
        };
        listEl.appendChild(row);
      });
    }

    wrap.querySelector('#ig-emj-add').onclick = () => {
      const eVal = wrap.querySelector('#ig-emj-val').value.trim();
      const kVal = wrap.querySelector('#ig-emj-key').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!eVal || !kVal) return alert('Provide both an emoji and a keyword (no spaces).');

      // Check if keyword already exists
      const existing = dict.findIndex(i => i.k === kVal);
      if (existing > -1) dict[existing].e = eVal;
      else dict.unshift({ e: eVal, k: kVal });

      saveDict();
      wrap.querySelector('#ig-emj-val').value = '';
      wrap.querySelector('#ig-emj-key').value = '';
      wrap.querySelector('#ig-emj-val').focus();
    };

    wrap.querySelector('#ig-emj-key').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') wrap.querySelector('#ig-emj-add').click();
    });

    renderList();

    function mountCard(attemptsLeft = 10) {
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '🙂 Emojis', wrap, '⠿', 'emoji-settings-module');
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    // Send initial payload out just in case QC loads after
    setTimeout(() => core.emit('emoji:updated', dict), 500);

    core.emit('block:ready', { id: 'emojiSettingsModule' });
  }
});

/* ============================================================
   BLOCK: Mobile Core (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Mobile Core (v2)   [replaces your existing block 1]
   ------------------------------------------------------------
   Foundation block for all mobile UI variants. Owns:

     core.isMobile        -> boolean, read this in ANY future block
     core.mobilePrefs     -> shared, persisted settings (shell, zoom,
                             tab, keyboardGuard, sheet-only state)
     core.mobileConst     -> shared layout / zoom numbers
     core.mobileKeyboard  -> { isOpen() }, plus 'mobile:keyboard-open'
                             / 'mobile:keyboard-close' events on the
                             core event bus

   SHELL SELECTION
   core.mobilePrefs.get().shell is 'sheet' | 'drawer' | 'fullscreen'.
   Each shell block (igMobileSheetUI, igMobileDrawerUI,
   igMobileFullscreenUI) checks this itself and does nothing if it
   isn't the selected one -- so all three can sit in the same script
   at once, and you flip between them from the Mobile UI Lab card
   instead of commenting blocks in and out.

   KEYBOARD DETECTION, NOT REACTION
   This block only detects the keyboard and emits events. What to DO
   about it (collapse, close, resize, ignore) is each shell's own
   decision, because the right reaction differs by shell -- see the
   comments in each shell block.

   REGISTER THIS FIRST, before any other mobile block.

   TESTING ON DESKTOP
     localStorage.setItem('ig_force_mobile_v1','1')  -> force mobile
     localStorage.setItem('ig_force_mobile_v1','0')  -> force desktop
     localStorage.removeItem('ig_force_mobile_v1')   -> auto-detect
   ============================================================ */
LegoCore.registerBlock({
  id: 'mobileCore',
  init(core) {
    const FORCE_KEY = 'ig_force_mobile_v1';
    const PREF_KEY  = 'ig_mobile_sheet_v1';

    /* ---------- Detection ---------- */
    function detect() {
      const forced = localStorage.getItem(FORCE_KEY);
      if (forced === '1') return true;
      if (forced === '0') return false;
      const uaMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      const narrow   = window.matchMedia('(max-width: 820px)').matches;
      return uaMobile || narrow;
    }
    core.isMobile = detect();

    /* ---------- Shared layout / zoom constants ---------- */
    core.mobileConst = {
      GRAB_H: 54,     // sheet: collapsed handle height, px
      HALF_F: 0.52,   // sheet: "half open" as a fraction of viewport height
      FULL_F: 0.92,   // sheet: "full open"  as a fraction of viewport height
      ZOOM_MIN: 60,
      ZOOM_MAX: 140,
      ZOOM_STEP: 10
    };

    /* ---------- Shared preferences ---------- */
    const defaults = {
      shell: 'sheet',          // 'sheet' | 'drawer' | 'fullscreen'
      state: 'half',           // sheet-only: 'collapsed' | 'half' | 'full'
      lastExpanded: 'half',    // sheet-only
      tab: 'left',             // 'left' | 'right' -- shared by every shell
      zoom: 100,               // shared UI zoom, applied inside every shell
      keyboardGuard: true      // suppress Quick Chat's focus stealing
    };

    let prefs = Object.assign({}, defaults);
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY)) || {};
      // One-time migration from the first, sheet-only version of this pref.
      if (saved.scale && !saved.zoom) saved.zoom = saved.scale;
      Object.assign(prefs, saved);
    } catch (e) {}

    function save() {
      try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
    }

    core.mobilePrefs = {
      get: () => prefs,
      set(patch, silent) {
        Object.assign(prefs, patch);
        save();
        if (!silent) core.emit('mobile:prefs-changed', prefs);
      },
      save,
      reset() {
        prefs = Object.assign({}, defaults);
        save();
        core.emit('mobile:prefs-changed', prefs);
      }
    };

    /* ---------- Shared keyboard detector ----------
       visualViewport.height shrinks when the soft keyboard opens, but
       window.innerHeight does not -- so we track the tallest height
       seen and treat a large drop from it as "keyboard open". */
    let kbOpen = false;
    let maxSeenHeight = 0;

    function checkKeyboard() {
      const vv = window.visualViewport;
      if (!vv) return;
      maxSeenHeight = Math.max(maxSeenHeight, vv.height);
      const shrink = maxSeenHeight - vv.height;
      const nowOpen = shrink > 120;
      if (nowOpen !== kbOpen) {
        kbOpen = nowOpen;
        core.emit(kbOpen ? 'mobile:keyboard-open' : 'mobile:keyboard-close', { height: vv.height });
      }
    }

    core.mobileKeyboard = { isOpen: () => kbOpen };

    if (core.isMobile && window.visualViewport) {
      window.visualViewport.addEventListener('resize', checkKeyboard);
      window.addEventListener('orientationchange', () => {
        maxSeenHeight = 0;
        setTimeout(checkKeyboard, 300);
      });
    }

    console.log('[MobileCore] isMobile =', core.isMobile, '| shell =', prefs.shell);
    core.emit('block:ready', { id: 'mobileCore', isMobile: core.isMobile });
  }
});

/* ============================================================
   BLOCK: Mobile Bottom Sheet UI (v1)
   ============================================================ */


/* ============================================================
   BLOCK: Master Config Bunny Sync (v5)
   ============================================================ */
/* ============================================================
   BLOCK: Central Cloud Sync Center (v3 - Folder Path Fix + Sequences in Master Config)
   ============================================================ */
LegoCore.registerBlock({
  id: 'cloudSyncCenterModule',
  init(core) {
    const BUNNY_PREFS_KEY = 'ig_bunny_sync_prefs_v1';

    // Everything to bundle into master_config.json
    const MASTER_KEYS = [
        'ig_text_library_pro_v1', 'ig_tl_col_widths_v1', 'mc_flows_cache_v1',
        'mc_folders_v1', 'mc_folders_collapsed_v1', 'ig_emoji_dict_v1',
        'ig_workspace_profiles_v1', 'ig_modular_dual_sidebar_prefs_v22',
        'ig_page_resizer_state_v2', 'ig_menu_card_order_v1', 'ig_quick_chat_prefs_v1',
        'ig_quick_effects_enabled_v1', 'sb_quick_autotrim_start', 'sb_quick_autotrim_end',
        'sb_quick_autosend', 'sb_quick_silence_threshold', 'sb_quick_trailing_lag',
        'ig_ub_engine_pref_v1', 'ig_ub_field_name_v1', 'ig_text_highlighter_rules_v1',
        'ig_text_highlighter_master_v1', 'ig_qcx_instant_search_v1', 'ig_qcx_float_v1',
        // Sequence Manager (JSON — rides the master config)
        'ig_sequences_v1', 'ig_seq_col_widths_v1', 'ig_seq_hud_pos_v1',
        // Tag Colors (number + course badge colors)
        'ig_tag_colors_v1'
    ];

    let prefs = JSON.parse(localStorage.getItem(BUNNY_PREFS_KEY)) || { zoneName: '', apiKey: '', region: 'default' };
    function savePrefs() { localStorage.setItem(BUNNY_PREFS_KEY, JSON.stringify(prefs)); }

    // Helpers
    function safeString(str) { return (str || 'Untitled').replace(/[^a-zA-Z0-9-_ \u00C0-\u017F]/g, '_').trim(); }
    function compareKey(folder, name) {
        const f = (folder || 'General').toLowerCase().replace(/[^a-z0-9\u00C0-\u017F]/g, '');
        const n = (name || 'item').toLowerCase().replace(/[^a-z0-9\u00C0-\u017F]/g, '');
        return `${f}||${n}`;
    }

    function blobToArrayBuffer(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read blob'));
            reader.readAsArrayBuffer(blob);
        });
    }

    function compressThumbnail(blob, maxSize = 200) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            if (w > maxSize || h > maxSize) {
              const ratio = Math.min(maxSize / w, maxSize / h);
              w *= ratio; h *= ratio;
            }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(blob);
      });
    }

    // Bunny API Request Engine
    function bunnyRequest(method, path, data = null, responseType = '') {
      return new Promise((resolve, reject) => {
        if (!prefs.zoneName || !prefs.apiKey) return reject(new Error('Missing API Key or Zone Name.'));
        const endpoint = prefs.region === 'default' ? 'storage.bunnycdn.com' : `${prefs.region}.storage.bunnycdn.com`;
        const cleanPath = path ? path.replace(/^\/+/, '') : '';
        const url = `https://${endpoint}/${prefs.zoneName}/${cleanPath}`;

        const reqOpts = {
          method: method,
          url: url,
          headers: { 'AccessKey': prefs.apiKey, 'accept': 'application/json' },
          onload: function(res) {
            if (res.status >= 200 && res.status < 300) {
                if (responseType === 'blob' || responseType === 'arraybuffer') resolve(res.response);
                else {
                    try { resolve(res.responseText ? JSON.parse(res.responseText) : null); }
                    catch(e) { resolve(res.responseText); }
                }
            } else {
                reject(new Error(`API Error ${res.status}: ${res.statusText}`));
            }
          },
          onerror: function() { reject(new Error('Network error.')); }
        };

        if (data) {
            reqOpts.data = data;
            if (data instanceof ArrayBuffer || data instanceof Blob) reqOpts.headers['Content-Type'] = 'application/octet-stream';
            else reqOpts.headers['Content-Type'] = 'application/json';
        }
        if (responseType) reqOpts.responseType = responseType;

        if (typeof GM_xmlhttpRequest !== 'undefined') GM_xmlhttpRequest(reqOpts);
        else reject(new Error('GM_xmlhttpRequest not available.'));
      });
    }

    // DB Getters
    function getLocalClips() {
        return new Promise(resolve => {
            const db = core.getDb();
            if (!db) return resolve([]);
            db.transaction(['clips'], 'readonly').objectStore('clips').getAll().onsuccess = e => resolve(e.target.result || []);
        });
    }
    function saveClipToLocalDB(clipData) {
        return new Promise(resolve => {
            const db = core.getDb();
            const tx = db.transaction(['folders', 'clips'], 'readwrite');
            tx.objectStore('folders').put({ name: clipData.folder });
            const store = tx.objectStore('clips');
            const req = store.count();
            req.onsuccess = () => { clipData.order = req.result; store.add(clipData); };
            tx.oncomplete = resolve;
        });
    }
    function getImageDb() {
        return new Promise(resolve => {
            const req = indexedDB.open('IG_ImageSets_Core_DB', 1);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = () => resolve(null);
        });
    }
    function getLocalImageSets(imgDb) {
        return new Promise(resolve => {
            if (!imgDb) return resolve([]);
            if (!imgDb.objectStoreNames.contains('sets')) return resolve([]);
            imgDb.transaction(['sets'], 'readonly').objectStore('sets').getAll().onsuccess = e => resolve(e.target.result || []);
        });
    }

    // Cloud Inventory Scan
    async function getCloudInventory(folderPath, ext) {
        let inventory = [];
        try {
            // FIX: Added the trailing slash so Bunny.net returns folder contents, not the folder itself!
            const rootItems = await bunnyRequest('GET', folderPath + '/');
            if (!Array.isArray(rootItems)) return inventory;

            for (let item of rootItems) {
                if (item.IsDirectory) {
                    const files = await bunnyRequest('GET', `${folderPath}/${encodeURIComponent(item.ObjectName)}/`);
                    if (Array.isArray(files)) {
                        files.forEach(f => {
                            if (!f.IsDirectory && f.ObjectName.match(ext)) {
                                inventory.push({
                                    folder: item.ObjectName,
                                    name: f.ObjectName.replace(ext, ''),
                                    path: `${folderPath}/${encodeURIComponent(item.ObjectName)}/${encodeURIComponent(f.ObjectName)}`
                                });
                            }
                        });
                    }
                } else if (item.ObjectName.match(ext)) {
                    inventory.push({ folder: 'General', name: item.ObjectName.replace(ext, ''), path: `${folderPath}/${encodeURIComponent(item.ObjectName)}` });
                }
            }
        } catch (e) { if (!e.message.includes('404')) throw e; }
        return inventory;
    }

    // UI Styles
    const style = document.createElement('style');
    style.innerHTML = `
      .ig-csc-wrap { display:flex; flex-direction:column; gap:10px; font-size:11px; color:#fff; }
      .ig-csc-box { background:#18181b; padding:10px; border-radius:6px; border:1px solid #334155; display:flex; flex-direction:column; gap:6px; }
      .ig-csc-title { color:#94a3b8; font-size:10px; font-weight:bold; text-transform:uppercase; letter-spacing:0.03em; margin-bottom:2px; }
      .ig-csc-input { background:#0f172a; color:#fff; border:1px solid #334155; border-radius:4px; padding:6px; font-size:11px; outline:none; width:100%; box-sizing:border-box; }
      .ig-csc-input:focus { border-color:#6366f1; }
      .ig-csc-row { display:flex; gap:6px; }
      .ig-csc-btn { flex:1; border:none; border-radius:4px; padding:6px; font-size:10px; font-weight:bold; cursor:pointer; text-align:center; transition:0.15s; }
      .ig-csc-btn:disabled { opacity:0.5; cursor:not-allowed; }
      .ig-csc-btn-green { background:#10b981; color:#fff; } .ig-csc-btn-green:hover:not(:disabled){ background:#059669; }
      .ig-csc-btn-blue { background:#0284c7; color:#fff; }  .ig-csc-btn-blue:hover:not(:disabled){ background:#0369a1; }
      .ig-csc-btn-red { background:#dc2626; color:#fff; }   .ig-csc-btn-red:hover:not(:disabled){ background:#b91c1c; }
      .ig-csc-status { font-size:10px; text-align:center; margin-top:4px; color:#c9a876; min-height:14px; font-weight:bold; }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'ig-csc-wrap';
    wrap.innerHTML = `
      <div class="ig-csc-box">
        <div class="ig-csc-title">Credentials</div>
        <input type="text" id="ig-csc-zone" class="ig-csc-input" placeholder="Storage Zone Name" value="${prefs.zoneName}">
        <input type="password" id="ig-csc-key" class="ig-csc-input" placeholder="Zone Password" value="${prefs.apiKey}">
        <select id="ig-csc-region" class="ig-csc-input">
          <option value="default" ${prefs.region === 'default' ? 'selected' : ''}>Falkenstein (Default)</option>
          <option value="ny" ${prefs.region === 'ny' ? 'selected' : ''}>New York (ny)</option>
          <option value="la" ${prefs.region === 'la' ? 'selected' : ''}>Los Angeles (la)</option>
          <option value="sg" ${prefs.region === 'sg' ? 'selected' : ''}>Singapore (sg)</option>
          <option value="syd" ${prefs.region === 'syd' ? 'selected' : ''}>Sydney (syd)</option>
          <option value="uk" ${prefs.region === 'uk' ? 'selected' : ''}>United Kingdom (uk)</option>
        </select>
      </div>

      <div class="ig-csc-box">
        <div class="ig-csc-title" title="Syncs all text snippets, sequences, emojis, and layouts">📝 Text & Settings Master</div>
        <div class="ig-csc-row">
            <button class="ig-csc-btn ig-csc-btn-green" id="ig-csc-push-master" title="Push your local config up to the cloud">☁️ Push</button>
            <button class="ig-csc-btn ig-csc-btn-blue" id="ig-csc-pull-master" title="Pull config from cloud and overwrite local">📥 Pull</button>
        </div>
      </div>

      <div class="ig-csc-box">
        <div class="ig-csc-title">🔴 Audio Library</div>
        <div class="ig-csc-row">
            <button class="ig-csc-btn ig-csc-btn-green" id="ig-csc-push-audio" title="Upload new clips & remove deleted ones">☁️ Smart Backup</button>
            <button class="ig-csc-btn ig-csc-btn-blue" id="ig-csc-pull-audio" title="Download missing clips">📥 Pull</button>
            <button class="ig-csc-btn ig-csc-btn-red" id="ig-csc-force-audio" title="Wipe cloud storage and rewrite from local">♻️ Force</button>
        </div>
      </div>

      <div class="ig-csc-box">
        <div class="ig-csc-title">🖼️ Image Sets</div>
        <div class="ig-csc-row">
            <button class="ig-csc-btn ig-csc-btn-green" id="ig-csc-push-img" title="Upload new images & remove deleted ones">☁️ Smart Backup</button>
            <button class="ig-csc-btn ig-csc-btn-blue" id="ig-csc-pull-img" title="Download missing images">📥 Pull</button>
            <button class="ig-csc-btn ig-csc-btn-red" id="ig-csc-force-img" title="Wipe cloud storage and rewrite from local">♻️ Force</button>
        </div>
      </div>
      <div id="ig-csc-status-bar" class="ig-csc-status">Ready.</div>
    `;

    function mountCard() {
      if (typeof core.registerMenu === 'function') core.registerMenu('left', '☁️ Sync Center', wrap, '⠿', 'cloud-sync-center');
      else setTimeout(mountCard, 200);
    }
    mountCard();

    // UI State Management
    const statusEl = wrap.querySelector('#ig-csc-status-bar');
    const allBtns = Array.from(wrap.querySelectorAll('.ig-csc-btn'));

    function setCreds() {
        prefs.zoneName = wrap.querySelector('#ig-csc-zone').value.trim();
        prefs.apiKey = wrap.querySelector('#ig-csc-key').value.trim();
        prefs.region = wrap.querySelector('#ig-csc-region').value;
        savePrefs();
        return prefs.zoneName && prefs.apiKey;
    }

    function lockUI(msg) {
        allBtns.forEach(b => b.disabled = true);
        statusEl.style.color = '#c9a876'; statusEl.innerText = msg;
    }
    function unlockUI(msg, isError = false) {
        allBtns.forEach(b => b.disabled = false);
        statusEl.style.color = isError ? '#f43f5e' : '#10b981'; statusEl.innerText = msg;
        core.emit('folders:refresh'); core.emit('library:refresh'); core.emit('images:external-refresh');
    }

    wrap.querySelector('#ig-csc-zone').onchange = setCreds;
    wrap.querySelector('#ig-csc-key').onchange = setCreds;
    wrap.querySelector('#ig-csc-region').onchange = setCreds;

    // --- MASTER CONFIG LOGIC ---
    wrap.querySelector('#ig-csc-push-master').onclick = async () => {
        if (!setCreds()) return unlockUI('❌ Missing credentials.', true);
        lockUI('☁️ Pushing Master Config...');
        try {
            let payload = {};
            MASTER_KEYS.forEach(k => { const val = localStorage.getItem(k); if (val !== null) payload[k] = val; });
            const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
            const arrayBuf = await blobToArrayBuffer(blob);
            await bunnyRequest('PUT', 'ig_master_config/master_config.json', arrayBuf);
            unlockUI('✅ Master Config pushed!');
        } catch (e) { unlockUI(`❌ ${e.message}`, true); }
    };

    wrap.querySelector('#ig-csc-pull-master').onclick = async () => {
        if (!setCreds()) return unlockUI('❌ Missing credentials.', true);
        if (!confirm("⚠️ Overwrite local text, sequences, emojis, and layouts with cloud config?")) return;
        lockUI('📥 Pulling Master Config...');
        try {
            const data = await bunnyRequest('GET', 'ig_master_config/master_config.json');
            if (!data || typeof data !== 'object') throw new Error("Invalid cloud file.");
            Object.keys(data).forEach(k => { if (MASTER_KEYS.includes(k)) localStorage.setItem(k, data[k]); });
            unlockUI('✅ Config imported! Reloading...');
            setTimeout(() => window.location.reload(), 1000);
        } catch (e) { unlockUI(`❌ ${e.message}`, true); }
    };

    // --- AUDIO LOGIC ---
    wrap.querySelector('#ig-csc-push-audio').onclick = async () => {
        if (!setCreds()) return unlockUI('❌ Missing credentials.', true);
        lockUI('☁️ Scanning Audio...');
        try {
            const localClips = await getLocalClips();
            const cloudInv = await getCloudInventory('ig_audio_backup', /\.m4a$/i);

            const localKeys = new Set(localClips.map(c => compareKey(c.folder, c.name)));
            const cloudKeys = new Set(cloudInv.map(c => compareKey(c.folder, c.name)));

            const toUpload = localClips.filter(c => !cloudKeys.has(compareKey(c.folder, c.name)));
            const toDelete = cloudInv.filter(c => !localKeys.has(compareKey(c.folder, c.name)));

            if (!toUpload.length && !toDelete.length) return unlockUI('✅ Audio is up to date.');

            for (let i=0; i<toDelete.length; i++) { lockUI(`🗑️ Audio: Deleting ${i+1}/${toDelete.length}...`); await bunnyRequest('DELETE', toDelete[i].path); }
            for (let i=0; i<toUpload.length; i++) {
                lockUI(`☁️ Audio: Pushing ${i+1}/${toUpload.length}...`);
                const c = toUpload[i];
                await bunnyRequest('PUT', `ig_audio_backup/${encodeURIComponent(safeString(c.folder))}/${encodeURIComponent(safeString(c.name))}.m4a`, await blobToArrayBuffer(c.blob));
                await new Promise(r => setTimeout(r, 100));
            }
            unlockUI(`✅ Audio Backup: Uploaded ${toUpload.length}, Deleted ${toDelete.length}.`);
        } catch (e) { unlockUI(`❌ ${e.message}`, true); }
    };

    wrap.querySelector('#ig-csc-pull-audio').onclick = async () => {
        if (!setCreds()) return unlockUI('❌ Missing credentials.', true);
        lockUI('📥 Fetching Audio Inventory...');
        try {
            const localClips = await getLocalClips();
            const cloudInv = await getCloudInventory('ig_audio_backup', /\.m4a$/i);
            const localKeys = new Set(localClips.map(c => compareKey(c.folder, c.name)));
            const toDownload = cloudInv.filter(c => !localKeys.has(compareKey(c.folder, c.name)));

            if (!toDownload.length) return unlockUI('✅ Local audio is fully synced.');

            for (let i=0; i<toDownload.length; i++) {
                lockUI(`📥 Audio: Pulling ${i+1}/${toDownload.length}...`);
                const c = toDownload[i];
                const blob = await bunnyRequest('GET', c.path, null, 'blob');
                await saveClipToLocalDB({ name: c.name, folder: c.folder, blob: blob, color: '#0095f6', customCommand: '' });
                await new Promise(r => setTimeout(r, 100));
            }
            unlockUI(`✅ Audio Pulled: ${toDownload.length} clips.`);
        } catch (e) { unlockUI(`❌ ${e.message}`, true); }
    };

    wrap.querySelector('#ig-csc-force-audio').onclick = async () => {
        if (!setCreds()) return unlockUI('❌ Missing credentials.', true);
        if (!confirm("⚠️ Wipe cloud audio and rewrite from local database?")) return;
        lockUI('♻️ Wiping Cloud Audio...');
        try {
            const cloudInv = await getCloudInventory('ig_audio_backup', /\.m4a$/i);
            for (let i=0; i<cloudInv.length; i++) { lockUI(`♻️ Deleting ${i+1}/${cloudInv.length}...`); await bunnyRequest('DELETE', cloudInv[i].path); }

            const localClips = await getLocalClips();
            for (let i=0; i<localClips.length; i++) {
                lockUI(`☁️ Audio: Pushing ${i+1}/${localClips.length}...`);
                const c = localClips[i];
                await bunnyRequest('PUT', `ig_audio_backup/${encodeURIComponent(safeString(c.folder))}/${encodeURIComponent(safeString(c.name))}.m4a`, await blobToArrayBuffer(c.blob));
                await new Promise(r => setTimeout(r, 100));
            }
            unlockUI(`✅ Force Mirror Complete! Pushed ${localClips.length} clips.`);
        } catch (e) { unlockUI(`❌ ${e.message}`, true); }
    };

    // --- IMAGE LOGIC ---
    wrap.querySelector('#ig-csc-push-img').onclick = async () => {
        if (!setCreds()) return unlockUI('❌ Missing credentials.', true);
        lockUI('☁️ Scanning Images...');
        try {
            const imgDb = await getImageDb();
            const localSets = await getLocalImageSets(imgDb);
            const cloudInv = await getCloudInventory('ig_image_backup', /\.(jpg|png|jpeg)$/i);

            let localImgs = [];
            localSets.forEach(s => s.images.forEach(i => localImgs.push({ setTitle: s.title, imgId: i.id, blob: i.blob, type: i.type })));

            const localKeys = new Set(localImgs.map(i => compareKey(i.setTitle, i.imgId)));
            const cloudKeys = new Set(cloudInv.map(c => compareKey(c.folder, c.name)));

            const toUpload = localImgs.filter(i => !cloudKeys.has(compareKey(i.setTitle, i.imgId)));
            const toDelete = cloudInv.filter(c => !localKeys.has(compareKey(c.folder, c.name)));

            if (!toUpload.length && !toDelete.length) return unlockUI('✅ Images are up to date.');

            for (let i=0; i<toDelete.length; i++) { lockUI(`🗑️ Img: Deleting ${i+1}/${toDelete.length}...`); await bunnyRequest('DELETE', toDelete[i].path); }
            for (let i=0; i<toUpload.length; i++) {
                lockUI(`☁️ Img: Pushing ${i+1}/${toUpload.length}...`);
                const img = toUpload[i];
                const ext = img.type ? img.type.split('/')[1] : 'jpeg';
                await bunnyRequest('PUT', `ig_image_backup/${encodeURIComponent(safeString(img.setTitle))}/${encodeURIComponent(safeString(img.imgId))}.${ext}`, await blobToArrayBuffer(img.blob));
                await new Promise(r => setTimeout(r, 100));
            }
            unlockUI(`✅ Image Backup: Uploaded ${toUpload.length}, Deleted ${toDelete.length}.`);
        } catch (e) { unlockUI(`❌ ${e.message}`, true); }
    };

    wrap.querySelector('#ig-csc-pull-img').onclick = async () => {
        if (!setCreds()) return unlockUI('❌ Missing credentials.', true);
        lockUI('📥 Fetching Image Inventory...');
        try {
            const imgDb = await getImageDb();
            if (!imgDb) throw new Error("Image DB not initialized.");
            const localSets = await getLocalImageSets(imgDb);
            const cloudInv = await getCloudInventory('ig_image_backup', /\.(jpg|png|jpeg)$/i);

            let localImgs = [];
            localSets.forEach(s => s.images.forEach(i => localImgs.push({ setTitle: s.title, imgId: i.id })));

            const localKeys = new Set(localImgs.map(i => compareKey(i.setTitle, i.imgId)));
            const toDownload = cloudInv.filter(c => !localKeys.has(compareKey(c.folder, c.name)));

            if (!toDownload.length) return unlockUI('✅ Local images are fully synced.');

            const tx = imgDb.transaction(['sets'], 'readwrite');
            const store = tx.objectStore('sets');
            const setGroups = {};
            toDownload.forEach(c => { if (!setGroups[c.folder]) setGroups[c.folder] = []; setGroups[c.folder].push(c); });

            let dCount = 0;
            for (let setName of Object.keys(setGroups)) {
                let existingSet = localSets.find(s => compareKey(s.title, '') === compareKey(setName, ''));
                if (!existingSet) {
                    existingSet = { id: 'set_' + Date.now() + Math.random(), title: setName, images: [], order: localSets.length + 1 };
                    localSets.push(existingSet);
                }
                for (let file of setGroups[setName]) {
                    dCount++; lockUI(`📥 Img: Pulling ${dCount}/${toDownload.length}...`);
                    const blob = await bunnyRequest('GET', file.path, null, 'blob');
                    const thumb = await compressThumbnail(blob);
                    existingSet.images.push({ id: file.name, type: blob.type || 'image/jpeg', blob: blob, thumb: thumb });
                    await new Promise(r => setTimeout(r, 100));
                }
                store.put(existingSet);
            }
            tx.oncomplete = () => unlockUI(`✅ Images Pulled: ${toDownload.length} files.`);
        } catch (e) { unlockUI(`❌ ${e.message}`, true); }
    };

    wrap.querySelector('#ig-csc-force-img').onclick = async () => {
        if (!setCreds()) return unlockUI('❌ Missing credentials.', true);
        if (!confirm("⚠️ Wipe cloud images and rewrite from local database?")) return;
        lockUI('♻️ Wiping Cloud Images...');
        try {
            const cloudInv = await getCloudInventory('ig_image_backup', /\.(jpg|png|jpeg)$/i);
            for (let i=0; i<cloudInv.length; i++) { lockUI(`♻️ Deleting ${i+1}/${cloudInv.length}...`); await bunnyRequest('DELETE', cloudInv[i].path); }

            const imgDb = await getImageDb();
            const localSets = await getLocalImageSets(imgDb);
            let allLocalImgs = [];
            localSets.forEach(s => s.images.forEach(i => allLocalImgs.push({ setTitle: s.title, imgId: i.id, blob: i.blob, type: i.type })));

            if (!allLocalImgs.length) return unlockUI('✅ Cloud wiped. No local images to push.');

            for (let i=0; i<allLocalImgs.length; i++) {
                lockUI(`☁️ Img: Pushing ${i+1}/${allLocalImgs.length}...`);
                const img = allLocalImgs[i];
                const ext = img.type ? img.type.split('/')[1] : 'jpeg';
                await bunnyRequest('PUT', `ig_image_backup/${encodeURIComponent(safeString(img.setTitle))}/${encodeURIComponent(safeString(img.imgId))}.${ext}`, await blobToArrayBuffer(img.blob));
                await new Promise(r => setTimeout(r, 100));
            }
            unlockUI(`✅ Force Mirror Complete! Pushed ${allLocalImgs.length} images.`);
        } catch (e) { unlockUI(`❌ ${e.message}`, true); }
    };

    console.log('[CloudSyncCenterModule] Unified Sync UI active.');
    core.emit('block:ready', { id: 'cloudSyncCenterModule' });
  }
});

/* ============================================================
   BLOCK: native emoji picker (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Native Emoji Picker (v1)
   - Type ":keyword" in the real Instagram DM compose box to
     trigger an emoji autocomplete dropdown, synced live with
     the Emoji Settings Module's saved dictionary.
   - Arrow Up/Down to navigate, Enter (or Tab) to insert,
     Escape or an outside click to dismiss.
   ============================================================ */
LegoCore.registerBlock({
  id: 'nativeEmojiPicker',
  init(core) {
    const STORAGE_KEY = 'ig_emoji_dict_v1';

    let emojiDict = [];
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      emojiDict = saved ? JSON.parse(saved) : [];
    } catch (e) { emojiDict = []; }

    // Stay in sync with the Emoji Settings Module (live add/edit/delete)
    core.on('emoji:updated', (newDict) => { emojiDict = newDict || []; });

    const style = document.createElement('style');
    style.id = 'ig-nep-styles';
    style.innerHTML = `
      .ig-nep-dropdown { position: fixed; max-height: 220px; overflow-y: auto; background: #0f172a; border: 1px solid #334155; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 2147483647 !important; display: none; flex-direction: column; padding: 4px; gap: 2px; }
      .ig-nep-dropdown::-webkit-scrollbar { width: 4px; }
      .ig-nep-dropdown::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .ig-nep-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px; cursor: pointer; transition: background 0.1s; }
      .ig-nep-row:hover { background: rgba(255,255,255,0.06); }
      .ig-nep-row.selected { background: #6366f1; }
      .ig-nep-symbol { font-size: 16px; flex-shrink: 0; }
      .ig-nep-keyword { font-family: monospace; font-size: 11px; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ig-nep-empty { padding: 10px; text-align: center; color: #94a3b8; font-size: 10px; }
    `;
    document.head.appendChild(style);

    const dropdownEl = document.createElement('div');
    dropdownEl.className = 'ig-nep-dropdown';
    document.body.appendChild(dropdownEl);

    let isOpen = false;
    let matches = [];
    let selectedIndex = 0;
    let triggerRange = null;
    let activeZone = null;

    function closeDropdown() {
      isOpen = false;
      dropdownEl.style.display = 'none';
      matches = [];
      selectedIndex = 0;
      triggerRange = null;
      window.removeEventListener('scroll', positionDropdown, true);
      window.removeEventListener('resize', positionDropdown);
    }

    function openDropdown() {
      isOpen = true;
      dropdownEl.style.display = 'flex';
      renderDropdown();
      positionDropdown();
      window.addEventListener('scroll', positionDropdown, true);
      window.addEventListener('resize', positionDropdown);
    }

    function positionDropdown() {
      if (!activeZone || !activeZone.isConnected) { closeDropdown(); return; }
      const rect = activeZone.getBoundingClientRect();
      const gap = 6;
      const spaceAbove = Math.max(100, rect.top - gap - 12);
      dropdownEl.style.left = rect.left + 'px';
      dropdownEl.style.width = Math.min(240, Math.max(140, rect.width)) + 'px';
      dropdownEl.style.top = 'auto';
      dropdownEl.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
      dropdownEl.style.maxHeight = Math.min(220, spaceAbove) + 'px';
    }

    function renderDropdown() {
      dropdownEl.innerHTML = '';
      if (!matches.length) {
        dropdownEl.innerHTML = '<div class="ig-nep-empty">No matches</div>';
        return;
      }
      matches.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'ig-nep-row' + (idx === selectedIndex ? ' selected' : '');
        row.innerHTML = `<span class="ig-nep-symbol">${item.e}</span><span class="ig-nep-keyword">:${item.k}</span>`;
        row.onmouseenter = () => { if (selectedIndex !== idx) { selectedIndex = idx; updateSelection(); } };
        row.onclick = () => { selectedIndex = idx; commitSelection(); };
        dropdownEl.appendChild(row);
      });
    }

    function updateSelection() {
      dropdownEl.querySelectorAll('.ig-nep-row').forEach((r, i) => {
        r.classList.toggle('selected', i === selectedIndex);
      });
    }

    // Looks at the text immediately before the caret in the current text
    // node and detects a trailing ":keyword" pattern (same rule the Quick
    // Command bar uses for its own emoji trigger). NOTE: this only sees the
    // single text node the caret is currently in - if the caret ends up
    // split across multiple DOM text nodes (e.g. right after a previously
    // inserted emoji or pasted content) the trigger may not be detected
    // until you keep typing into fresh text.
    function detectTrigger(zone) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return null;
      if (!zone.contains(node)) return null;

      const textBefore = node.textContent.slice(0, range.startOffset);
      const emojiMatch = textBefore.match(/(?:^|\s):([a-zA-Z0-9_]*)$/);
      if (!emojiMatch) return null;

      const keyword = emojiMatch[1].toLowerCase();
      const triggerStart = range.startOffset - emojiMatch[1].length - 1;
      if (triggerStart < 0) return null;

      const tRange = document.createRange();
      tRange.setStart(node, triggerStart);
      tRange.setEnd(node, range.startOffset);

      return { keyword, range: tRange };
    }

    function handleInput(e) {
      const zone = core.getActiveChatZone && core.getActiveChatZone();
      if (!zone || !(e.target === zone || zone.contains(e.target))) {
        if (isOpen) closeDropdown();
        return;
      }

      const trigger = detectTrigger(zone);
      if (!trigger) { if (isOpen) closeDropdown(); return; }

      activeZone = zone;
      triggerRange = trigger.range;
      matches = emojiDict.filter(item => item.k.includes(trigger.keyword));
      selectedIndex = 0;

      if (matches.length > 0) openDropdown();
      else closeDropdown();
    }

    // Capture phase so we reliably see typing even if Instagram's own
    // handlers stop propagation somewhere in the bubble phase.
    document.addEventListener('input', handleInput, true);

    function commitSelection() {
      if (!matches.length || !triggerRange || !activeZone) return;
      const chosen = matches[selectedIndex];

      activeZone.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(triggerRange);

      document.execCommand('insertText', false, chosen.e + ' ');
      activeZone.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

      closeDropdown();
    }

    // Capture phase so this runs before Instagram's own Enter-to-send handler
    document.addEventListener('keydown', (e) => {
      if (!isOpen) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        selectedIndex = (selectedIndex + 1) % matches.length;
        updateSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
        updateSelection();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        commitSelection();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        closeDropdown();
        return;
      }
    }, true);

    document.addEventListener('click', (e) => {
      if (isOpen && !dropdownEl.contains(e.target)) closeDropdown();
    });

    core.emit('block:ready', { id: 'nativeEmojiPicker' });
  }
});

/* ============================================================
   BLOCK: Sequence Manager (v3)
   ============================================================ */
/* ============================================================
   BLOCK: Sequence Manager (v2 - Keyboard Builder + Enter-Paced Playback)
   Built for: LegoCore v2 + Commands v29 (from v28.1) + Quick Chat Box v2
   - Builder: Commands v28.1-style dropdown + side preview panel
              (badges, token highlights, smooth hover — duplicated, own classes)
   - Search: core.searchInventory (same accent-insensitive engine as /commands)
   - Saved list: Text-Library-style rows (duplicated styles, own classes)
   - HUD: Enter = next step, Esc = cancel, 1s double-tap lock,
          missing items auto-skipped
   Storage: localStorage 'ig_sequences_v1' (synced via Bunny master config)
   ============================================================ */
LegoCore.registerBlock({
  id: 'sequenceManagerModule',
  init(core) {
    const COL_PREF_KEY = 'ig_seq_col_widths_v1';
    const HUD_POS_KEY = 'ig_seq_hud_pos_v1';
    // Debounce only — NOT a "wait for Instagram" delay. The async-fetch race is already covered
    // by run.sending; this just absorbs OS key-repeat (holding Enter) and stray duplicate
    // keydowns. It must stay short: the user's normal rhythm is load‑Enter, send‑Enter, back to
    // back, and a long lock here would eat the deliberate second tap.
    const LOCK_MS = 280;
    const COMPLETE_MS = 1500;
    const FLASH_MS = 1400;
    const HUD_POLL_MS = 400;
    const STEP_KINDS = ['audio', 'set', 'text'];
    const KIND_ICON = { audio: '🎵', set: '🖼️', text: '📝' };
    const EXEMPT_SELECTOR = '[data-seq-exempt], .ig-seq-modal-overlay, .ig-qcx-modal-overlay, .ig-tlp-modal-overlay';

    function readJson(key, fallback) {
      try { const raw = localStorage.getItem(key); if (raw === null) return fallback; const v = JSON.parse(raw); return v == null ? fallback : v; }
      catch (e) { return fallback; }
    }
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function iconFor(kind) { return KIND_ICON[kind] || '•'; }
    function stepLabel(step) { return `${iconFor(step.kind)} ${step.title || '(untitled)'}`; }

    /* ---- Duplicated render helpers (from Commands v28.1) — kept local so this block can diverge ---- */
    function tokenToAccentRegex(token) {
      const map = { a: '[aáàäâã]', e: '[eéèëê]', i: '[iíìïî]', o: '[oóòöôõ]', u: '[uúùüû]', n: '[nñ]', c: '[cç]' };
      const escaped = String(token || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let pattern = '';
      for (const ch of escaped.toLowerCase()) pattern += map[ch] || ch;
      return pattern;
    }
    // Always HTML-escapes first, then adds <mark> / **bold** markup -> safe for innerHTML
    function highlightTokens(text, tokens) {
      const raw = String(text || '');
      if (!raw) return '';
      let html = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      if (tokens && tokens.length) {
        const patterns = tokens.map(tokenToAccentRegex).filter(Boolean);
        if (patterns.length) html = html.replace(new RegExp(`(${patterns.join('|')})`, 'gi'), '<mark class="ig-seq-mark">$1</mark>');
      }
      return html.replace(/\*\*(.*?)\*\*/gs, '<strong class="ig-seq-bold">$1</strong>');
    }
    function getHashColor(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
      return `hsl(${Math.abs(hash % 360)}, 65%, 45%)`;
    }
    function formatTitleWithTags(rawName, tokens) {
      const raw = String(rawName || '');
      const match = raw.match(/^(\d+)([\s\-\.]*)(?:\(([^)]+)\))?([\s\-\.]*)(.*)$/);
      if (!match) return highlightTokens(raw, tokens);
      const numStr = match[1], num = parseInt(numStr, 10), sep1 = match[2] || '', courseName = match[3], sep2 = match[4] || '', rest = match[5] || '';

      // 🎨 Colors come from the Tag Colors block (falls back to the old colors if it's missing)
      const tc = core.tagColors;
      const bg = tc ? tc.getNumberColor(numStr)
        : num === 1 ? '#10b981' : num === 2 ? '#ef4444' : num === 3 ? '#f59e0b' : num === 4 ? '#8b5cf6' : num >= 5 ? '#3b82f6' : '#64748b';
      const fg = tc ? tc.getTextColor(bg) : '#fff';

      let html = `<span class="ig-seq-pipeline-badge" style="background:${bg}; color:${fg};">${numStr}</span>`;
      if (courseName) {
        const tagColor = tc ? tc.getCourseColor(courseName) : getHashColor(courseName.toLowerCase().trim());
        const tagFg = tc ? tc.getTextColor(tagColor) : '#fff';
        html += `<span class="ig-seq-course-badge" style="background:${tagColor}; color:${tagFg};">(${highlightTokens(courseName.trim(), tokens)})</span>`;
        html += `<span>${highlightTokens(sep2 + rest, tokens)}</span>`;
      } else {
        html += `<span>${highlightTokens(sep1 + rest, tokens)}</span>`;
      }
      return html;
    }

    let colWidths = readJson(COL_PREF_KEY, { titleWidth: 45 });

    /* ---------------------------------------------------------
       STYLES (self-contained copies — no dependency on other blocks)
       --------------------------------------------------------- */
    const style = document.createElement('style');
    style.id = 'ig-seq-styles';
    style.innerHTML = `
      /* ---- Container / header (copied from Text Library) ---- */
      .ig-seq-container { display: flex; flex-direction: column; gap: 8px; font-family: -apple-system, sans-serif; }
      .ig-seq-header-btns { display: flex; gap: 4px; }
      .ig-seq-hbtn { flex: 1; background: var(--igls-surface-2, #1c1c23); color: #e2e8f0; border: 1px solid #334155; border-radius: 4px; padding: 6px 4px; font-size: 10px; font-weight: bold; cursor: pointer; transition: 0.2s; }
      .ig-seq-hbtn:hover { background: #334155; color: #fff; }
      .ig-seq-hbtn.active-filter { background: #6366f1; color: white; border-color: #8b5cf6; }
      .ig-seq-find-input { width: 100%; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 6px 8px; border-radius: 4px; font-size: 11px; box-sizing: border-box; outline: none; }
      .ig-seq-find-input:focus { border-color: #6366f1; }

      /* ---- Builder ---- */
      .ig-seq-builder { display: flex; flex-direction: column; gap: 6px; background: rgba(0,0,0,0.2); border: 1px solid #334155; border-radius: 6px; padding: 8px; }
      .ig-seq-builder.is-editing { border-color: #c9a876; }
      .ig-seq-builder-head { display: flex; align-items: center; gap: 6px; }
      .ig-seq-mode-label { flex: 1; font-size: 11px; font-weight: bold; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ig-seq-builder.is-editing .ig-seq-mode-label { color: #c9a876; }
      .ig-seq-draft-zone { display: flex; flex-wrap: wrap; gap: 4px; min-height: 26px; max-height: 120px; overflow-y: auto; padding: 2px; }
      .ig-seq-draft-zone::-webkit-scrollbar { width: 4px; }
      .ig-seq-draft-zone::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }
      .ig-seq-draft-empty { font-size: 10px; color: #64748b; font-style: italic; padding: 5px 2px; }
      .ig-seq-pill { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; background: #1e293b; border: 1px solid #475569; border-radius: 12px; padding: 2px 4px 2px 6px; font-size: 10px; color: #f8fafc; cursor: grab; user-select: none; }
      .ig-seq-pill:active { cursor: grabbing; }
      .ig-seq-pill.is-dragging { opacity: 0.35; }
      .ig-seq-pill.drop-left { box-shadow: -2px 0 0 #10b981; }
      .ig-seq-pill.drop-right { box-shadow: 2px 0 0 #10b981; }
      .ig-seq-pill-num { font-size: 9px; font-weight: bold; color: #c9a876; }
      .ig-seq-pill-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
      .ig-seq-pill-x { background: transparent; border: none; color: #64748b; cursor: pointer; font-size: 9px; padding: 1px 3px; border-radius: 8px; line-height: 1; }
      .ig-seq-pill-x:hover { color: #fff; background: rgba(220,38,38,0.6); }
      .ig-seq-cmd-input { width: 100%; background: #0f172a; color: #fff; border: 1px solid #334155; border-radius: 6px; padding: 7px 8px; font-size: 12px; outline: none; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; transition: border 0.2s; }
      .ig-seq-cmd-input:focus { border-color: #6366f1; }
      .ig-seq-builder-status { font-size: 10px; color: #64748b; min-height: 13px; line-height: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ig-seq-builder-status.ok { color: #10b981; font-weight: bold; }
      .ig-seq-builder-status.warn { color: #f59e0b; font-weight: bold; }
      .ig-seq-builder-status.info { color: #c9a876; font-weight: bold; }

      /* ---- Dropdown + side panel (copied from Commands v28.1) ---- */
      .ig-seq-dropdown { position: fixed; max-height: 320px; overflow-y: auto; background: #0f172a; border: 1px solid #334155; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 2147483647 !important; display: none; flex-direction: column; padding: 4px; gap: 2px; font-family: -apple-system, sans-serif; }
      .ig-seq-dropdown::-webkit-scrollbar { width: 4px; }
      .ig-seq-dropdown::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .ig-seq-dd-row { padding: 6px 8px; border-radius: 5px; cursor: pointer; transition: background 0.1s; }
      .ig-seq-dd-row:hover { background: rgba(255,255,255,0.06); }
      .ig-seq-dd-row.selected { background: #6366f1; }
      .ig-seq-dd-row-top { display: flex; align-items: center; gap: 6px; }
      .ig-seq-dd-title { flex: 1; font-weight: bold; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
      .ig-seq-dd-cmd { font-size: 9px; background: rgba(255,255,255,0.12); color: #c9a876; padding: 1px 6px; border-radius: 8px; font-weight: bold; flex-shrink: 0; }
      .ig-seq-dd-empty { padding: 10px; text-align: center; color: #94a3b8; font-size: 10px; }
      .ig-seq-pipeline-badge { display: inline-block; padding: 1px 5px; border-radius: 4px; font-weight: bold; color: #fff; margin-right: 4px; font-size: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
      .ig-seq-course-badge { display: inline-block; padding: 1px 5px; border-radius: 4px; font-weight: bold; color: #fff; margin-right: 4px; font-size: 9px; text-transform: uppercase; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
      .ig-seq-mark { background: rgba(201, 168, 118, 0.45); color: #fff; border-radius: 3px; padding: 0 3px; font-weight: bold; }
      .ig-seq-bold { color: #38bdf8; background: rgba(56, 189, 248, 0.15); padding: 0 3px; border-radius: 3px; }
      .ig-seq-side-panel { position: fixed; overflow-y: auto; background: #0f172a; border: 1px solid #334155; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 2147483647 !important; display: none; flex-direction: column; padding: 10px; gap: 6px; font-family: -apple-system, sans-serif; }
      .ig-seq-side-panel::-webkit-scrollbar { width: 4px; }
      .ig-seq-side-panel::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .ig-seq-side-title { font-size: 11px; font-weight: bold; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .ig-seq-side-body { font-size: 11px; color: #cbd5e1; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      .ig-seq-side-empty { font-size: 10px; color: #64748b; font-style: italic; }

      /* ---- Saved list (copied from Text Library) ---- */
      .ig-seq-tree { max-height: 350px; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; }
      .ig-seq-tree::-webkit-scrollbar { width: 4px; }
      .ig-seq-tree::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }
      .ig-seq-list-empty { font-size: 10px; color: #64748b; font-style: italic; padding: 8px 6px; text-align: center; }
      .ig-seq-drop-top { border-top: 2px solid #10b981 !important; }
      .ig-seq-drop-bottom { border-bottom: 2px solid #10b981 !important; }

      .ig-seq-row-item { display: flex; flex-direction: column; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: background 0.2s; }
      .ig-seq-row-item.alt-bg { background: rgba(255,255,255,0.02); }
      .ig-seq-row-item:hover { background: rgba(255,255,255,0.06); }
      .ig-seq-row-item.is-active { background: rgba(99,102,241,0.18); box-shadow: inset 2px 0 0 #6366f1; }
      .ig-seq-row-item.is-editing { box-shadow: inset 2px 0 0 #c9a876; }

      .ig-seq-row { display: flex; align-items: center; padding: 4px 6px; }
      .ig-seq-drag-grip { color: #475569; font-size: 10px; cursor: grab; margin-right: 6px; }
      .ig-seq-drag-grip:active { cursor: grabbing; }
      .ig-seq-title-col { display: flex; align-items: center; font-size: 11px; color: #f8fafc; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; gap: 4px; }
      .ig-seq-title-text { overflow: hidden; text-overflow: ellipsis; }
      .ig-seq-col-resizer { width: 6px; height: 18px; cursor: col-resize; background: rgba(255,255,255,0.05); border-radius: 3px; margin: 0 4px; transition: background 0.1s; flex-shrink: 0; }
      .ig-seq-col-resizer:hover, .ig-seq-col-resizer.active { background: #6366f1; }
      .ig-seq-meta { flex: 1; display: flex; gap: 4px; overflow: hidden; pointer-events: none; align-items: center; }
      .ig-seq-count-pill { font-size: 9px; padding: 2px 6px; border-radius: 4px; font-weight: 700; white-space: nowrap; background: rgba(255,255,255,0.1); color: #c9a876; flex-shrink: 0; }
      .ig-seq-warn-pill { font-size: 9px; padding: 2px 6px; border-radius: 4px; font-weight: 700; white-space: nowrap; background: rgba(245,158,11,0.15); color: #f59e0b; flex-shrink: 0; }
      .ig-seq-kind-icons { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.8; }

      .ig-seq-actions { display: flex; gap: 2px; align-items: center; margin-left: auto; }
      .ig-seq-btn { background: transparent; border: none; color: #64748b; cursor: pointer; font-size: 11px; padding: 4px; border-radius: 4px; transition: 0.2s; }
      .ig-seq-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }

      .ig-seq-preview { font-size: 10px; color: #94a3b8; padding: 0 8px 8px 30px; line-height: 1.5; display: none; white-space: pre-wrap; word-wrap: break-word; background: rgba(0,0,0,0.2); }
      .ig-seq-preview.visible { display: block; }
      .ig-seq-preview-line.missing { color: #f59e0b; }

      /* ---- HUD ---- */
      .ig-seq-hud { position: fixed; z-index: 2147483646; width: 340px; max-width: calc(100vw - 16px); box-sizing: border-box; background: rgba(15, 23, 42, 0.96); backdrop-filter: blur(8px); border: 1px solid #6366f1; border-radius: 10px; padding: 10px 12px; display: none; flex-direction: column; gap: 6px; box-shadow: 0 10px 30px rgba(0,0,0,0.55); font-family: -apple-system, sans-serif; color: #fff; }
      .ig-seq-hud.is-waiting { border-color: #f59e0b; }
      .ig-seq-hud.is-complete { border-color: #10b981; }
      .ig-seq-hud-head { display: flex; align-items: center; gap: 8px; }
      .ig-seq-hud-name { flex: 1; font-size: 11px; font-weight: bold; color: #c9a876; cursor: grab; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; }
      .ig-seq-hud-cancel { background: #1e293b; border: 1px solid #475569; color: #e2e8f0; border-radius: 4px; padding: 3px 8px; font-size: 10px; font-weight: bold; cursor: pointer; }
      .ig-seq-hud-cancel:hover { background: #dc2626; border-color: #dc2626; color: #fff; }
      .ig-seq-hud-track { height: 4px; background: #1e293b; border-radius: 4px; overflow: hidden; }
      .ig-seq-hud-fill { height: 100%; width: 0%; background: #6366f1; transition: width 0.25s; }
      .ig-seq-hud.is-complete .ig-seq-hud-fill { background: #10b981; }
      .ig-seq-hud-status { font-size: 12px; font-weight: bold; color: #f8fafc; line-height: 1.4; word-break: break-word; }
      .ig-seq-hud-sub { font-size: 10px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ig-seq-hud.is-locked .ig-seq-hud-status { opacity: 0.7; }
    `;
    document.head.appendChild(style);

    /* ---------------------------------------------------------
       SIDEBAR CARD SKELETON (static markup only — no user data)
       --------------------------------------------------------- */
    const ui = el('div', 'ig-seq-container');
    ui.innerHTML = `
      <div class="ig-seq-header-btns">
        <button type="button" class="ig-seq-hbtn" data-act="new" title="Start a new empty sequence">➕ New</button>
        <button type="button" class="ig-seq-hbtn" data-act="find" title="Filter saved sequences">🔍 Find</button>
      </div>
      <input type="text" class="ig-seq-find-input" data-seq-exempt="1" placeholder="Filter sequences by name..." style="display:none;">
      <div class="ig-seq-builder">
        <div class="ig-seq-builder-head">
          <span class="ig-seq-mode-label">✨ New sequence</span>
          <button type="button" class="ig-seq-btn ig-seq-cancel-edit" title="Stop editing (discard changes)" style="display:none;">✕</button>
        </div>
        <div class="ig-seq-draft-zone"></div>
        <input type="text" class="ig-seq-cmd-input" data-seq-exempt="1" autocomplete="off" spellcheck="false" placeholder="Type to add step, or /save Name...">
        <div class="ig-seq-builder-status"></div>
      </div>
      <div class="ig-seq-tree"></div>
    `;

    const newBtn = ui.querySelector('[data-act="new"]');
    const findBtn = ui.querySelector('[data-act="find"]');
    const findInput = ui.querySelector('.ig-seq-find-input');
    const builderEl = ui.querySelector('.ig-seq-builder');
    const modeLabel = ui.querySelector('.ig-seq-mode-label');
    const cancelEditBtn = ui.querySelector('.ig-seq-cancel-edit');
    const draftZone = ui.querySelector('.ig-seq-draft-zone');
    const cmdInput = ui.querySelector('.ig-seq-cmd-input');
    const builderStatus = ui.querySelector('.ig-seq-builder-status');
    const tree = ui.querySelector('.ig-seq-tree');

    const dropdownEl = el('div', 'ig-seq-dropdown');
    dropdownEl.setAttribute('data-seq-exempt', '1');
    document.body.appendChild(dropdownEl);
    const sidePanelEl = el('div', 'ig-seq-side-panel');
    sidePanelEl.setAttribute('data-seq-exempt', '1');
    document.body.appendChild(sidePanelEl);

    /* ---------------------------------------------------------
       DRAFT STATE
       --------------------------------------------------------- */
    let draft = { editingId: null, name: '', steps: [] };
    const DEFAULT_HINT = '↑↓ pick · Enter add · ⌫ on empty removes last · /save Name';

    let statusTimer = null;
    function setBuilderStatus(msg, tone, ms) {
      clearTimeout(statusTimer);
      builderStatus.textContent = msg || DEFAULT_HINT;
      builderStatus.className = 'ig-seq-builder-status' + (tone ? ' ' + tone : '');
      if (ms) statusTimer = setTimeout(() => setBuilderStatus(DEFAULT_HINT), ms);
    }

    function resetDraft() {
      draft = { editingId: null, name: '', steps: [] };
      cmdInput.value = '';
      closeDropdown();
      renderDraft();
      highlightRows();
      setBuilderStatus(DEFAULT_HINT);
    }

    function startEditing(seq) {
      draft = { editingId: seq.id, name: seq.name || '', steps: (seq.steps || []).map(s => Object.assign({}, s)) };
      cmdInput.value = '';
      closeDropdown();
      renderDraft();
      highlightRows();
      setBuilderStatus('✏️ Edit steps, then /save (keeps name) or /save New Name', 'info', 3500);
      builderEl.scrollIntoView({ block: 'nearest' });
      cmdInput.focus();
    }

    let draggedPillIdx = null;
    function clearPillDropMarks() {
      draftZone.querySelectorAll('.drop-left, .drop-right').forEach(p => p.classList.remove('drop-left', 'drop-right'));
    }

    function renderDraft() {
      draftZone.innerHTML = '';
      if (!draft.steps.length) {
        draftZone.appendChild(el('div', 'ig-seq-draft-empty', 'Draft is empty — type below to add steps.'));
      }
      draft.steps.forEach((step, idx) => {
        const pill = el('div', 'ig-seq-pill');
        pill.draggable = true;
        pill.title = `${step.title || '(untitled)'} — drag to reorder`;
        const rm = el('button', 'ig-seq-pill-x', '✕');
        rm.type = 'button'; rm.title = 'Remove step';
        rm.onclick = (e) => { e.stopPropagation(); draft.steps.splice(idx, 1); renderDraft(); cmdInput.focus(); };
        pill.append(el('span', 'ig-seq-pill-num', String(idx + 1)), el('span', null, iconFor(step.kind)), el('span', 'ig-seq-pill-title', step.title || '(untitled)'), rm);

        pill.addEventListener('dragstart', (e) => {
          draggedPillIdx = idx;
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', 'ig-seq-pill'); } catch (_) { /* noop */ }
          setTimeout(() => pill.classList.add('is-dragging'), 0);
        });
        pill.addEventListener('dragend', () => { pill.classList.remove('is-dragging'); draggedPillIdx = null; clearPillDropMarks(); });
        pill.addEventListener('dragover', (e) => {
          if (draggedPillIdx === null) return;
          e.preventDefault(); e.stopPropagation();
          clearPillDropMarks();
          if (draggedPillIdx === idx) return;
          const r = pill.getBoundingClientRect();
          pill.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-left' : 'drop-right');
        });
        pill.addEventListener('drop', (e) => {
          if (draggedPillIdx === null) return;
          e.preventDefault(); e.stopPropagation();
          const r = pill.getBoundingClientRect();
          const before = e.clientX < r.left + r.width / 2;
          const moved = draft.steps.splice(draggedPillIdx, 1)[0];
          let target = idx > draggedPillIdx ? idx - 1 : idx;
          if (!before) target += 1;
          draft.steps.splice(target, 0, moved);
          draggedPillIdx = null;
          renderDraft();
        });
        draftZone.appendChild(pill);
      });

      const editing = !!draft.editingId;
      builderEl.classList.toggle('is-editing', editing);
      modeLabel.textContent = editing ? `✏️ Editing: ${draft.name || 'Untitled'}` : '✨ New sequence';
      cancelEditBtn.style.display = editing ? '' : 'none';
      draftZone.scrollTop = draftZone.scrollHeight;
    }

    function addStepFromMatch(m) {
      let step = null;
      if (m.kind === 'audio') step = { kind: 'audio', refId: m.item.id, title: m.item.name || 'Audio clip', folder: m.item.folder || 'General' };
      else if (m.kind === 'set') step = { kind: 'set', refId: m.item.id, title: m.item.title || 'Image set' };
      else if (m.kind === 'text') step = { kind: 'text', refId: m.item.id, title: m.item.title || (m.item.text || '').slice(0, 25) || 'Text' };
      if (!step) return;
      draft.steps.push(step);
      cmdInput.value = '';
      closeDropdown();
      renderDraft();
      setBuilderStatus(`➕ Added ${stepLabel(step)}`, 'ok', 1500);
      cmdInput.focus();
    }

    function saveDraft(nameArg) {
      const name = (nameArg || '').trim() || draft.name;
      if (!draft.steps.length) { setBuilderStatus('⚠️ Add at least one step before saving.', 'warn', 2500); return; }
      if (!name) { setBuilderStatus('⚠️ Name it: /save My Sequence', 'warn', 2500); return; }

      const sequences = core.getSequences();
      const steps = draft.steps.map(s => Object.assign({}, s));
      const now = Date.now();
      let savedName = name;

      const existing = draft.editingId ? sequences.find(s => s.id === draft.editingId) : null;
      if (existing) {
        existing.name = name; existing.steps = steps; existing.updatedAt = now;
      } else {
        sequences.push({ id: draft.editingId || ('seq_' + now), name, steps, createdAt: now, updatedAt: now });
      }
      core.saveSequences(sequences); // emits 'sequences:updated' -> renderList()
      const wasEditing = !!existing;
      resetDraft();
      setBuilderStatus(wasEditing ? `✅ Updated "${savedName}"` : `✅ Saved "${savedName}"`, 'ok', 2200);
    }

    /* ---------------------------------------------------------
       BUILDER DROPDOWN (Quick-Command behavior, own classes)
       --------------------------------------------------------- */
    let dropdownOpen = false;
    let matches = [];
    let currentSearchTokens = [];
    let selectedIndex = 0;
    let searchToken = 0;

    function positionDropdown() {
      const rect = cmdInput.getBoundingClientRect();
      const gap = 8;
      const spaceAbove = rect.top - gap - 12;
      const spaceBelow = window.innerHeight - rect.bottom - gap - 12;
      dropdownEl.style.left = rect.left + 'px';
      dropdownEl.style.width = Math.max(220, rect.width) + 'px';
      // Sidebar card may sit near the top of the screen: open upward like /commands when there's room, else downward
      if (spaceAbove >= 160 || spaceAbove >= spaceBelow) {
        dropdownEl.style.top = 'auto';
        dropdownEl.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
        dropdownEl.style.maxHeight = Math.max(120, Math.min(320, spaceAbove)) + 'px';
      } else {
        dropdownEl.style.bottom = 'auto';
        dropdownEl.style.top = (rect.bottom + gap) + 'px';
        dropdownEl.style.maxHeight = Math.max(120, Math.min(320, spaceBelow)) + 'px';
      }
    }

    function positionSidePanel() {
      const dd = dropdownEl.getBoundingClientRect();
      const gap = 8, panelWidth = 240;
      let left = dd.right + gap;
      if (left + panelWidth > window.innerWidth - 8) {
        left = dd.left - panelWidth - gap;
        if (left < 8) left = Math.max(8, window.innerWidth - panelWidth - 8);
      }
      sidePanelEl.style.left = left + 'px';
      sidePanelEl.style.width = panelWidth + 'px';
      sidePanelEl.style.top = dropdownEl.style.top;
      sidePanelEl.style.bottom = dropdownEl.style.bottom;
      sidePanelEl.style.maxHeight = dropdownEl.style.maxHeight;
    }

    function onViewportChange() { if (dropdownOpen) { positionDropdown(); positionSidePanel(); } }

    function openDropdown() {
      if (!dropdownOpen) {
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange);
      }
      dropdownOpen = true;
      document.body.appendChild(dropdownEl);
      document.body.appendChild(sidePanelEl);
      positionDropdown();
      dropdownEl.style.display = 'flex';
      renderDropdown();
    }
    function closeDropdown() {
      searchToken++;
      dropdownOpen = false; matches = []; currentSearchTokens = []; selectedIndex = 0;
      dropdownEl.style.display = 'none';
      sidePanelEl.style.display = 'none';
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    }

    function updateSidePanel() {
      if (!dropdownOpen || !matches.length) { sidePanelEl.style.display = 'none'; return; }
      const m = matches[selectedIndex];
      const tokens = currentSearchTokens;
      let title = '', body = '', emptyMsg = '';
      if (m.kind === 'audio') { title = m.item.name; body = m.item.transcript; emptyMsg = 'No transcript yet.'; }
      else if (m.kind === 'text') { title = m.item.title; body = m.item.text; emptyMsg = 'No text saved.'; }
      else if (m.kind === 'set') { title = m.item.title; body = ''; emptyMsg = `${(m.item.images || []).length} image(s) — sent together as one album.`; }
      sidePanelEl.innerHTML = '';
      sidePanelEl.appendChild(el('div', 'ig-seq-side-title', `${iconFor(m.kind)} ${title || '(untitled)'}`));
      const bodyEl = el('div', 'ig-seq-side-body');
      const trimmed = String(body || '').trim();
      if (trimmed) bodyEl.innerHTML = highlightTokens(trimmed, tokens); // escaped inside highlightTokens
      else bodyEl.appendChild(el('span', 'ig-seq-side-empty', emptyMsg));
      sidePanelEl.appendChild(bodyEl);
      sidePanelEl.style.display = 'flex';
      positionSidePanel();
      const firstMark = sidePanelEl.querySelector('mark');
      if (firstMark) firstMark.scrollIntoView({ block: 'nearest' });
    }

    // Smooth hover: only toggle classes, never rebuild rows (same fix as Commands v28.1)
    function updateSelection() {
      dropdownEl.querySelectorAll('.ig-seq-dd-row').forEach((r, i) => r.classList.toggle('selected', i === selectedIndex));
      const selectedRow = dropdownEl.children[selectedIndex];
      if (selectedRow && selectedRow.scrollIntoView) selectedRow.scrollIntoView({ block: 'nearest' });
      updateSidePanel();
    }

    function renderDropdown() {
      dropdownEl.innerHTML = '';
      if (!matches.length) { dropdownEl.appendChild(el('div', 'ig-seq-dd-empty', 'No matches')); updateSidePanel(); return; }
      const tokens = currentSearchTokens;
      matches.forEach((m, idx) => {
        const row = el('div', 'ig-seq-dd-row' + (idx === selectedIndex ? ' selected' : ''));
        const top = el('div', 'ig-seq-dd-row-top');
        const titleEl = el('span', 'ig-seq-dd-title');
        titleEl.innerHTML = formatTitleWithTags(m.kind === 'audio' ? m.item.name : m.item.title, tokens); // escaped inside
        top.append(el('span', null, iconFor(m.kind)), titleEl);
        if (m.item.customCommand) top.appendChild(el('span', 'ig-seq-dd-cmd', '/' + m.item.customCommand));
        if (m.kind === 'set') top.appendChild(el('span', 'ig-seq-dd-cmd', `${(m.item.images || []).length} img`));
        row.appendChild(top);
        row.onmouseenter = () => { if (selectedIndex !== idx) { selectedIndex = idx; updateSelection(); } };
        row.onmousedown = (e) => e.preventDefault(); // keep focus in the builder input
        row.onclick = () => { selectedIndex = idx; addStepFromMatch(matches[idx]); };
        dropdownEl.appendChild(row);
      });
      updateSidePanel();
    }

    function saveCommandMatch(val) { return val.trim().match(/^\/save(?:\s+(.*))?$/i); }

    async function recomputeMatches(forceAll) {
      const val = cmdInput.value;
      const saveMatch = saveCommandMatch(val);
      if (saveMatch) {
        closeDropdown();
        const name = (saveMatch[1] || '').trim() || draft.name;
        if (!name) setBuilderStatus('💾 Type a name, then Enter: /save My Sequence', 'info');
        else setBuilderStatus(draft.editingId ? `💾 Enter to update as "${name}"` : `💾 Enter to save as "${name}"`, 'info');
        return;
      }
      if (!val.trim() && !forceAll) { closeDropdown(); setBuilderStatus(DEFAULT_HINT); return; }

      const raw = val.startsWith('/') ? val.slice(1) : val;
      const parsed = core.parseSearchPrefix(raw);
      const mode = STEP_KINDS.includes(parsed.mode) ? parsed.mode : 'all';
      const q = parsed.mode === 'all' || STEP_KINDS.includes(parsed.mode) ? parsed.q : raw;

      const token = ++searchToken;
      const results = await core.searchInventory(q, mode, { kinds: STEP_KINDS, limit: 8 });
      if (token !== searchToken) return; // stale
      currentSearchTokens = core.getSearchTokens(q);
      matches = results;
      selectedIndex = 0;
      openDropdown();
    }

    cmdInput.addEventListener('input', () => recomputeMatches(false));
    cmdInput.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (dropdownOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (matches.length) { selectedIndex = (selectedIndex + 1) % matches.length; updateSelection(); } return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); if (matches.length) { selectedIndex = (selectedIndex - 1 + matches.length) % matches.length; updateSelection(); } return; }
        if ((e.key === 'Enter' || e.key === 'Tab') && matches.length) { e.preventDefault(); e.stopPropagation(); addStepFromMatch(matches[selectedIndex]); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDropdown(); return; }
      }
      if (e.key === 'ArrowDown' && !dropdownOpen) { e.preventDefault(); recomputeMatches(true); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        const saveMatch = saveCommandMatch(cmdInput.value);
        if (saveMatch) { saveDraft(saveMatch[1] || ''); return; }
        if (cmdInput.value.trim()) recomputeMatches(false);
        return;
      }
      if (e.key === 'Backspace' && cmdInput.value === '' && draft.steps.length) {
        e.preventDefault();
        const removed = draft.steps.pop();
        renderDraft();
        setBuilderStatus(`⌫ Removed ${stepLabel(removed)}`, 'warn', 1500);
      }
    });
    cmdInput.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement !== cmdInput && !dropdownEl.matches(':hover') && !sidePanelEl.matches(':hover')) closeDropdown();
    }, 120));
    document.addEventListener('click', (e) => {
      if (dropdownOpen && e.target !== cmdInput && !dropdownEl.contains(e.target) && !sidePanelEl.contains(e.target)) closeDropdown();
    });

    newBtn.onclick = () => { resetDraft(); cmdInput.focus(); };
    cancelEditBtn.onclick = () => { resetDraft(); setBuilderStatus('Edit discarded.', 'warn', 1500); };
    findBtn.onclick = () => {
      const show = findInput.style.display === 'none';
      findInput.style.display = show ? '' : 'none';
      findBtn.classList.toggle('active-filter', show);
      if (show) findInput.focus(); else { findInput.value = ''; renderList(); }
    };
    findInput.addEventListener('input', () => renderList());

    /* ---------------------------------------------------------
       SAVED LIST (Text-Library rows, own classes)
       --------------------------------------------------------- */
    let listToken = 0;
    let draggedSeqId = null;
    let activeColResizer = null;

    function clearRowDropMarks() {
      tree.querySelectorAll('.ig-seq-drop-top, .ig-seq-drop-bottom').forEach(r => r.classList.remove('ig-seq-drop-top', 'ig-seq-drop-bottom'));
    }

    function highlightRows() {
      const active = core.getActiveSequence();
      tree.querySelectorAll('.ig-seq-row-item').forEach(row => {
        row.classList.toggle('is-active', !!active && active.id === row.dataset.id);
        row.classList.toggle('is-editing', !!draft.editingId && draft.editingId === row.dataset.id);
      });
    }

    function loadSequence(seq) {
      if (!seq.steps || !seq.steps.length) { setBuilderStatus('⚠️ That sequence has no steps.', 'warn', 2000); return; }
      core.setActiveSequence(seq);
    }

    function deleteSequence(seq) {
      if (!confirm(`Delete sequence "${seq.name || 'Untitled'}"?`)) return;
      const active = core.getActiveSequence();
      if (active && active.id === seq.id) core.cancelSequence('deleted');
      if (draft.editingId === seq.id) resetDraft();
      core.saveSequences(core.getSequences().filter(s => s.id !== seq.id));
    }

    function reorderSequences(dragId, targetId, before) {
      const list = core.getSequences();
      const from = list.findIndex(s => s.id === dragId);
      if (from < 0) return;
      const moved = list.splice(from, 1)[0];
      let to = list.findIndex(s => s.id === targetId);
      if (to < 0) return;
      if (!before) to += 1;
      list.splice(to, 0, moved);
      core.saveSequences(list);
    }

    function buildRow(seq, index, inventory) {
      const steps = Array.isArray(seq.steps) ? seq.steps : [];
      const missingFlags = inventory ? steps.map(s => !core.resolveStep(s, inventory)) : steps.map(() => false);
      const missingCount = missingFlags.filter(Boolean).length;

      const item = el('div', 'ig-seq-row-item' + (index % 2 === 1 ? ' alt-bg' : ''));
      item.dataset.id = seq.id;

      const row = el('div', 'ig-seq-row');
      const grip = el('span', 'ig-seq-drag-grip', '⠿');
      grip.draggable = true; grip.title = 'Drag to reorder';

      const titleCol = el('div', 'ig-seq-title-col');
      titleCol.style.width = colWidths.titleWidth + '%';
      const titleText = el('span', 'ig-seq-title-text');
      titleText.innerHTML = formatTitleWithTags(seq.name || 'Untitled', []); // escaped inside
      titleCol.append(el('span', null, '📋'), titleText);

      const resizer = el('div', 'ig-seq-col-resizer');
      resizer.title = 'Drag to resize columns';

      const meta = el('div', 'ig-seq-meta');
      meta.appendChild(el('span', 'ig-seq-count-pill', `${steps.length} step${steps.length === 1 ? '' : 's'}`));
      if (missingCount) {
        const warn = el('span', 'ig-seq-warn-pill', `⚠️ ${missingCount}`);
        warn.title = `${missingCount} step(s) reference deleted items and will be skipped`;
        meta.appendChild(warn);
      }
      meta.appendChild(el('span', 'ig-seq-kind-icons', steps.map(s => iconFor(s.kind)).join('')));

      const actions = el('div', 'ig-seq-actions');
      const playBtn = el('button', 'ig-seq-btn', '▶️'); playBtn.type = 'button'; playBtn.title = 'Load sequence (Enter sends each step)';
      const previewBtn = el('button', 'ig-seq-btn', '👁️'); previewBtn.type = 'button'; previewBtn.title = 'Toggle step list';
      const editBtn = el('button', 'ig-seq-btn', '✏️'); editBtn.type = 'button'; editBtn.title = 'Edit sequence';
      const delBtn = el('button', 'ig-seq-btn', '🗑️'); delBtn.type = 'button'; delBtn.title = 'Delete sequence';
      actions.append(playBtn, previewBtn, editBtn, delBtn);

      row.append(grip, titleCol, resizer, meta, actions);

      const preview = el('div', 'ig-seq-preview');
      if (!steps.length) preview.textContent = 'Empty sequence.';
      steps.forEach((s, i) => {
        const line = el('div', 'ig-seq-preview-line' + (missingFlags[i] ? ' missing' : ''), `${i + 1}. ${stepLabel(s)}${missingFlags[i] ? '  ⚠️ missing' : ''}`);
        preview.appendChild(line);
      });

      item.append(row, preview);

      playBtn.onclick = (e) => { e.stopPropagation(); loadSequence(seq); };
      previewBtn.onclick = (e) => { e.stopPropagation(); preview.classList.toggle('visible'); };
      editBtn.onclick = (e) => { e.stopPropagation(); startEditing(seq); };
      delBtn.onclick = (e) => { e.stopPropagation(); deleteSequence(seq); };
      item.onclick = (e) => {
        if (e.target.closest('button') || e.target.classList.contains('ig-seq-drag-grip') || e.target.classList.contains('ig-seq-col-resizer')) return;
        preview.classList.toggle('visible');
      };

      grip.addEventListener('dragstart', (e) => {
        draggedSeqId = seq.id;
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', 'ig-seq-row'); } catch (_) { /* noop */ }
        setTimeout(() => { item.style.opacity = '0.3'; }, 0);
      });
      grip.addEventListener('dragend', () => { item.style.opacity = '1'; draggedSeqId = null; clearRowDropMarks(); });
      item.addEventListener('dragover', (e) => {
        if (!draggedSeqId) return;
        e.preventDefault(); e.stopPropagation();
        clearRowDropMarks();
        if (draggedSeqId === seq.id) return;
        const r = item.getBoundingClientRect();
        item.classList.add(e.clientY - r.top < r.height / 2 ? 'ig-seq-drop-top' : 'ig-seq-drop-bottom');
      });
      item.addEventListener('dragleave', () => item.classList.remove('ig-seq-drop-top', 'ig-seq-drop-bottom'));
      item.addEventListener('drop', (e) => {
        if (!draggedSeqId) return;
        e.preventDefault(); e.stopPropagation();
        const r = item.getBoundingClientRect();
        const before = e.clientY - r.top < r.height / 2;
        const dragId = draggedSeqId;
        draggedSeqId = null;
        clearRowDropMarks();
        if (dragId !== seq.id) reorderSequences(dragId, seq.id, before);
      });

      resizer.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        resizer.classList.add('active');
        activeColResizer = { el: resizer, container: row };
      });

      return item;
    }

    async function renderList() {
      const token = ++listToken;
      const sequences = core.getSequences();
      let inventory = null;
      try { inventory = await core.getSearchableInventory(); } catch (e) { inventory = null; }
      if (token !== listToken) return;

      // keep open previews open across re-renders
      const openIds = new Set(Array.from(tree.querySelectorAll('.ig-seq-row-item')).filter(r => r.querySelector('.ig-seq-preview.visible')).map(r => r.dataset.id));

      tree.innerHTML = '';
      const filter = findInput.value.trim().toLowerCase();
      const visible = sequences.filter(s => !filter || (s.name || '').toLowerCase().includes(filter));
      if (!visible.length) {
        tree.appendChild(el('div', 'ig-seq-list-empty', sequences.length ? 'No sequences match that filter.' : 'No saved sequences yet. Build one above and type /save Name.'));
        return;
      }
      visible.forEach((seq, i) => {
        const row = buildRow(seq, i, inventory);
        if (openIds.has(seq.id)) row.querySelector('.ig-seq-preview').classList.add('visible');
        tree.appendChild(row);
      });
      highlightRows();
    }

    window.addEventListener('mousemove', (e) => {
      if (!activeColResizer) return;
      const rect = activeColResizer.container.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      colWidths.titleWidth = Math.min(80, Math.max(20, pct));
      tree.querySelectorAll('.ig-seq-title-col').forEach(c => { c.style.width = colWidths.titleWidth + '%'; });
    });
    window.addEventListener('mouseup', () => {
      if (!activeColResizer) return;
      activeColResizer.el.classList.remove('active');
      activeColResizer = null;
      localStorage.setItem(COL_PREF_KEY, JSON.stringify(colWidths));
    });

    /* ---------------------------------------------------------
       HUD
       --------------------------------------------------------- */
    const hud = el('div', 'ig-seq-hud');
    hud.innerHTML = `
      <div class="ig-seq-hud-head">
        <span class="ig-seq-hud-name" title="Drag to move · double-click to re-dock above the chat box"></span>
        <button type="button" class="ig-seq-hud-cancel" title="Cancel sequence (Esc)">✕ Cancel</button>
      </div>
      <div class="ig-seq-hud-track"><div class="ig-seq-hud-fill"></div></div>
      <div class="ig-seq-hud-status"></div>
      <div class="ig-seq-hud-sub"></div>
    `;
    document.body.appendChild(hud);
    const hudName = hud.querySelector('.ig-seq-hud-name');
    const hudCancel = hud.querySelector('.ig-seq-hud-cancel');
    const hudFill = hud.querySelector('.ig-seq-hud-fill');
    const hudStatus = hud.querySelector('.ig-seq-hud-status');
    const hudSub = hud.querySelector('.ig-seq-hud-sub');

    core.makeIsolatedDraggable(hud, hudName, HUD_POS_KEY);
    hudName.addEventListener('dblclick', () => { localStorage.removeItem(HUD_POS_KEY); positionHud(); });
    hudCancel.onclick = (e) => { e.stopPropagation(); core.cancelSequence('user'); };

    // run.stage is the module's own record of where we are — 'idle' (nothing loaded, next
    // Enter loads a step) or 'armed' (a step was just injected into Instagram's composer,
    // next Enter is the send keystroke). This replaces inferring it from the page's DOM.
    const run = { stage: 'idle', locked: false, lockTimer: null, sending: false, complete: false, completeTimer: null, flashText: '', flashUntil: 0, token: 0, poll: null };

    function resetRun() {
      clearTimeout(run.lockTimer); clearTimeout(run.completeTimer);
      if (run.poll) clearInterval(run.poll);
      run.stage = 'idle';
      run.locked = false; run.sending = false; run.complete = false;
      run.flashText = ''; run.flashUntil = 0; run.poll = null;
      run.token++;
    }

    function positionHud() {
      const saved = readJson(HUD_POS_KEY, null);
      const w = hud.offsetWidth || 340;
      const h = hud.offsetHeight || 90;
      if (saved && saved.left && saved.top) {
        const left = Math.min(Math.max(8, parseFloat(saved.left)), window.innerWidth - w - 8);
        const top = Math.min(Math.max(8, parseFloat(saved.top)), window.innerHeight - h - 8);
        hud.style.left = left + 'px'; hud.style.top = top + 'px'; hud.style.bottom = 'auto';
        return;
      }
      const zone = core.getActiveChatZone();
      let left, bottom;
      if (zone) {
        const r = zone.getBoundingClientRect();
        left = r.left + r.width / 2 - w / 2;
        bottom = window.innerHeight - r.top + 14;
      } else {
        left = window.innerWidth / 2 - w / 2;
        bottom = 96;
      }
      left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
      bottom = Math.min(Math.max(8, bottom), window.innerHeight - h - 8);
      hud.style.left = left + 'px'; hud.style.top = 'auto'; hud.style.bottom = bottom + 'px';
    }

    function focusIsInComposer(zone) {
      const a = document.activeElement;
      return !!(zone && a && (zone === a || zone.contains(a)));
    }

    function focusComposer(zone) {
      if (!zone) return;
      zone.focus();
      if (zone.isContentEditable) {
        try {
          const range = document.createRange();
          range.selectNodeContents(zone);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(range);
        } catch (_) { /* noop */ }
      }
    }

    function flash(text) { run.flashText = text; run.flashUntil = Date.now() + FLASH_MS; renderHud(); }

    function renderHud() {
      const seq = core.getActiveSequence();
      if (!seq) { hud.style.display = 'none'; return; }
      const total = seq.steps.length;
      const idx = core.getSequenceStepIndex();
      const next = seq.steps[idx];
      const armed = !run.complete && run.stage === 'armed';

      hudName.textContent = '📋 ' + (seq.name || 'Sequence');
      hudFill.style.width = (total ? Math.round((Math.min(idx, total) / total) * 100) : 100) + '%';

      let status;
      let sub = 'Enter = load next · Enter again = send · Esc = cancel';
      if (Date.now() < run.flashUntil) status = run.flashText;
      else if (run.complete) { status = '✅ Complete!'; sub = 'Press ENTER in the chat to send the last item.'; }
      else if (run.sending) status = '⏳ Loading…';
      else if (armed) status = '📤 In the chat box — press ENTER to send it.';
      else if (next) status = `[${idx + 1}/${total}] Up Next: ${stepLabel(next)}. Press ENTER to load it.`;
      else status = '✅ Complete!';

      if (!run.complete && armed && next) sub = `Then: [${idx + 1}/${total}] ${stepLabel(next)}`;

      hudStatus.textContent = status;
      hudSub.textContent = sub;
      hud.classList.toggle('is-waiting', armed);
      hud.classList.toggle('is-complete', run.complete);
      hud.classList.toggle('is-locked', run.locked);
    }

    function lockTrigger() {
      run.locked = true;
      clearTimeout(run.lockTimer);
      run.lockTimer = setTimeout(() => { run.locked = false; renderHud(); }, LOCK_MS);
    }

    function finishSequence() {
      run.complete = true;
      renderHud();
      clearTimeout(run.completeTimer);
      const myToken = run.token;
      run.completeTimer = setTimeout(() => { if (myToken === run.token) core.cancelSequence('complete'); }, COMPLETE_MS);
    }

    function injectPayload(kind, payload) {
      let ok = false;
      if (kind === 'audio') ok = core.injectClipToChat(payload.blob, payload.name, { silent: true });
      else if (kind === 'set') ok = core.injectImageSetToChat(payload.images, { silent: true });
      else if (kind === 'text') ok = core.injectTextToChat(payload.text, { silent: true });
      if (ok && kind !== 'text') {
        // leave the caret in Instagram's composer so the next real Enter sends the attachment
        setTimeout(() => focusComposer(core.getActiveChatZone()), 60);
      }
      return ok;
    }

    async function fireNextStep() {
      const seq = core.getActiveSequence();
      if (!seq) return;
      if (!core.getActiveChatZone()) { flash('⚠️ Open an Instagram chat first.'); return; }

      const myToken = run.token;
      run.sending = true;
      lockTrigger();
      renderHud();

      let idx = core.getSequenceStepIndex();
      let payload = null, step = null, skipped = 0;
      while (idx < seq.steps.length) {
        step = seq.steps[idx];
        try { payload = await core.fetchItemData(step.kind, step.refId, step); } catch (e) { payload = null; }
        if (myToken !== run.token) return; // cancelled/replaced while fetching
        if (payload) break;
        skipped++; idx++;
        core.setSequenceStepIndex(idx);
      }
      run.sending = false;

      if (!payload) { flash('⚠️ Item missing, skipping...'); finishSequence(); return; }

      if (!injectPayload(step.kind, payload)) { flash('⚠️ Chat box not found — step not loaded.'); return; }
      // Loaded into the composer but NOT sent yet — arm the state so the next Enter reads as "send",
      // not "load the next step". core.setSequenceStepIndex already points past this step, but
      // finishSequence() (which tears down the HUD) waits until the send Enter actually fires.
      run.stage = 'armed';
      if (skipped) flash(`⚠️ Item missing, skipping... (${skipped} skipped)`);

      core.setSequenceStepIndex(idx + 1);
      renderHud();
    }

    function swallow(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }

    // Global capture-phase listener: runs before Instagram's and the other blocks' handlers.
    function onGlobalKeydown(e) {
      if (!core.getActiveSequence()) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.target && e.target.closest && e.target.closest(EXEMPT_SELECTOR)) return;

      if (e.key === 'Escape') { swallow(e); core.cancelSequence('escape'); return; }
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;

      // Double-tap lock (also covers the async fetch window)
      if (run.locked || run.sending) { swallow(e); return; }

      if (run.stage === 'armed') {
        // A step is already loaded in Instagram's composer — this Enter is the SEND keystroke.
        // We trust our own state for *what this Enter means*, not the page's DOM: the only thing
        // still worth checking is that focus is actually where Instagram will receive the key.
        const zone = core.getActiveChatZone();
        if (!focusIsInComposer(zone)) {
          swallow(e);
          focusComposer(zone);
          flash('📤 Chat box focused — press ENTER again to send.');
          return; // stay 'armed' — this tap only refocused, it didn't send
        }
        // Let this real keypress reach Instagram natively; we never simulate the send ourselves.
        const seq = core.getActiveSequence();
        const isLastStep = seq && core.getSequenceStepIndex() >= seq.steps.length;
        run.stage = 'idle';
        lockTrigger(); // brief cooldown so Instagram has time to actually send + clear the composer
        if (isLastStep) finishSequence();
        else setTimeout(renderHud, 200);
        return;
      }

      // stage === 'idle': nothing loaded yet — this Enter loads the next step.
      swallow(e);
      if (run.complete) return;
      fireNextStep();
    }
    window.addEventListener('keydown', onGlobalKeydown, true);

    /* ---------------------------------------------------------
       CORE EVENTS
       --------------------------------------------------------- */
    core.on('sequence:started', () => {
      resetRun();
      hud.style.display = 'flex';
      positionHud();
      renderHud();
      run.poll = setInterval(() => { positionHud(); renderHud(); }, HUD_POLL_MS);
      highlightRows();
    });
    core.on('sequence:ended', () => {
      resetRun();
      hud.style.display = 'none';
      highlightRows();
    });
    core.on('sequence:step', () => renderHud());
    core.on('sequences:updated', () => renderList());
    core.on('tagcolors:updated', () => { renderList(); if (dropdownOpen) renderDropdown(); }); // 🎨 re-color tags live
    // ✏️ on a sequence row in the /commands dropdown -> open it here in the builder
    core.on('sequence:edit-request', (payload) => {
      const id = payload && payload.id;
      const seq = core.getSequences().find(sq => sq.id === id);
      if (!seq) return;
      const card = ui.closest('.ig-draggable-menu');
      if (card) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      startEditing(seq);
    });
    ['library:refresh', 'folders:refresh', 'images:external-refresh'].forEach(evt => core.on(evt, () => renderList()));

    /* ---------------------------------------------------------
       MOUNT
       --------------------------------------------------------- */
    function mountCard(attemptsLeft = 10) {
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '📋 Sequences', ui, '⠿', 'sequence-manager');
        renderDraft();
        setBuilderStatus(DEFAULT_HINT);
        renderList();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    core.emit('block:ready', { id: 'sequenceManagerModule' });
  }
});

/* ============================================================
   BLOCK: Tag Colors (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Tag Color Settings (v1)
   ------------------------------------------------------------
   One place to configure the colors of the title tags used by
   Audio Library, Commands (/ dropdown) and Sequence Manager:

       "1 (Anatomía) Intro clase"
        │  └ course badge  -> color by the FIRST LETTER of the course
        └ number badge     -> color per number (0–10, plus "11+")

   - Accents are ignored for the letter (Á -> a, ñ -> n).
   - If a course starts with a digit/symbol, the first letter found
     inside it is used; if there is none, the "Other" color.
   - Badge text switches to dark automatically on light colors
     (so yellow stays readable).

   Exposes:  core.tagColors = { getNumberColor, getCourseColor,
                                getTextColor, get }
   Emits:    'tagcolors:updated'  (other blocks re-render on it)
   Storage:  localStorage 'ig_tag_colors_v1'  (add it to the Sync
             Center MASTER_KEYS to sync across devices)
   ============================================================ */
LegoCore.registerBlock({
  id: 'tagColorSettingsModule',
  init(core) {
    const STORAGE_KEY = 'ig_tag_colors_v1';
    const NUMBER_SLOTS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
    const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    const esc = core.escapeHtml;

    function hslToHex(h, s, l) {
      s /= 100; l /= 100;
      const k = n => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
      return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
    }

    // Numbers keep your current look (1 green, 2 red, 3 orange, 4 purple, 5+ blue).
    // Letters get distinct starting colors (golden-angle hue spread so A and B don't look alike).
    function buildDefaults() {
      const numbers = { '0': '#64748b', '1': '#10b981', '2': '#ef4444', '3': '#f59e0b', '4': '#8b5cf6' };
      NUMBER_SLOTS.forEach(n => { if (!numbers[n]) numbers[n] = '#3b82f6'; });
      const letters = {};
      LETTERS.forEach((ch, i) => { letters[ch] = hslToHex(Math.round((i * 137.508) % 360), 65, 45); });
      return { numbers, numberOther: '#3b82f6', letters, letterOther: '#64748b' };
    }

    function load() {
      const cfg = buildDefaults();
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        if (saved.numbers) Object.keys(saved.numbers).forEach(k => { if (isHex(saved.numbers[k])) cfg.numbers[k] = saved.numbers[k]; });
        if (saved.letters) Object.keys(saved.letters).forEach(k => { if (isHex(saved.letters[k])) cfg.letters[k] = saved.letters[k]; });
        if (isHex(saved.numberOther)) cfg.numberOther = saved.numberOther;
        if (isHex(saved.letterOther)) cfg.letterOther = saved.letterOther;
      } catch (e) { /* keep defaults */ }
      return cfg;
    }

    let cfg = load();

    function save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) { /* quota */ }
      core.emit('tagcolors:updated', cfg);
    }

    /* ---------------- Public API ---------------- */
    function getNumberColor(numStr) {
      const n = parseInt(numStr, 10);
      if (isNaN(n)) return cfg.numberOther;
      return cfg.numbers[String(n)] || cfg.numberOther;
    }
    function firstLetter(name) {
      const m = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z]/);
      return m ? m[0] : null;
    }
    function getCourseColor(name) {
      const ch = firstLetter(name);
      return (ch && cfg.letters[ch]) || cfg.letterOther;
    }
    function getTextColor(bg) {
      const m = /^#?([0-9a-f]{6})$/i.exec(bg || '');
      if (!m) return '#ffffff';
      const v = parseInt(m[1], 16);
      const lum = (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
      return lum > 0.62 ? '#111827' : '#ffffff';
    }

    core.tagColors = { getNumberColor, getCourseColor, getTextColor, get: () => cfg };

    /* ---------------- Styles ---------------- */
    const style = document.createElement('style');
    style.id = 'ig-tcs-styles';
    style.innerHTML = `
      .ig-tcs-wrap { display:flex; flex-direction:column; gap:8px; font-family:-apple-system,sans-serif; font-size:11px; color:#fff; }
      .ig-tcs-section { background:#18181b; border:1px solid #334155; border-radius:6px; padding:8px; display:flex; flex-direction:column; gap:6px; }
      .ig-tcs-label { color:#94a3b8; font-size:10px; font-weight:bold; text-transform:uppercase; letter-spacing:0.03em; }
      .ig-tcs-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(50px, 1fr)); gap:4px; }
      .ig-tcs-cell { display:flex; align-items:center; justify-content:space-between; gap:3px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); border-radius:4px; padding:3px 4px; cursor:pointer; }
      .ig-tcs-cell span { font-size:10px; font-weight:bold; color:#cbd5e1; }
      .ig-tcs-cell input[type=color] { width:22px; height:18px; border:none; padding:0; background:transparent; cursor:pointer; flex-shrink:0; }
      .ig-tcs-preview-input { width:100%; box-sizing:border-box; background:#0f172a; color:#fff; border:1px solid #334155; border-radius:4px; padding:6px 8px; font-size:11px; outline:none; }
      .ig-tcs-preview-input:focus { border-color:#6366f1; }
      .ig-tcs-preview { background:#0f172a; border:1px solid #334155; border-radius:4px; padding:6px 8px; font-size:11px; color:#f8fafc; min-height:16px; }
      .ig-tcs-badge-num { display:inline-block; padding:1px 5px; border-radius:4px; font-weight:bold; margin-right:4px; font-size:10px; box-shadow:0 1px 2px rgba(0,0,0,0.3); }
      .ig-tcs-badge-course { display:inline-block; padding:1px 5px; border-radius:4px; font-weight:bold; margin-right:4px; font-size:9px; text-transform:uppercase; box-shadow:0 1px 2px rgba(0,0,0,0.3); }
      .ig-tcs-reset { background:#334155; color:#fff; border:none; border-radius:4px; padding:6px; font-size:10px; font-weight:bold; cursor:pointer; }
      .ig-tcs-reset:hover { background:#dc2626; }
    `;
    document.head.appendChild(style);

    /* ---------------- UI ---------------- */
    const wrap = document.createElement('div');
    wrap.className = 'ig-tcs-wrap';
    wrap.innerHTML = `
      <div class="ig-tcs-section">
        <span class="ig-tcs-label">Preview</span>
        <input type="text" class="ig-tcs-preview-input" value="1 (Anatomía) Intro clase" placeholder="Type a title to preview...">
        <div class="ig-tcs-preview"></div>
      </div>
      <div class="ig-tcs-section">
        <span class="ig-tcs-label">Number badges</span>
        <div class="ig-tcs-grid ig-tcs-num-grid"></div>
      </div>
      <div class="ig-tcs-section">
        <span class="ig-tcs-label">(Course) badges — by first letter</span>
        <div class="ig-tcs-grid ig-tcs-letter-grid"></div>
      </div>
      <button type="button" class="ig-tcs-reset">↺ Reset to defaults</button>
    `;

    const previewInput = wrap.querySelector('.ig-tcs-preview-input');
    const previewEl = wrap.querySelector('.ig-tcs-preview');
    const numGrid = wrap.querySelector('.ig-tcs-num-grid');
    const letterGrid = wrap.querySelector('.ig-tcs-letter-grid');

    function renderPreview() {
      const raw = previewInput.value;
      const match = raw.match(/^(\d+)([\s\-\.]*)(?:\(([^)]+)\))?([\s\-\.]*)(.*)$/);
      if (!match) { previewEl.textContent = raw || '—'; return; }
      const numStr = match[1], courseName = match[3];
      const bg = getNumberColor(numStr);
      let html = `<span class="ig-tcs-badge-num" style="background:${bg}; color:${getTextColor(bg)};">${esc(numStr)}</span>`;
      if (courseName) {
        const cbg = getCourseColor(courseName);
        html += `<span class="ig-tcs-badge-course" style="background:${cbg}; color:${getTextColor(cbg)};">(${esc(courseName.trim())})</span>`;
        html += `<span>${esc((match[4] || '') + (match[5] || ''))}</span>`;
      } else {
        html += `<span>${esc((match[2] || '') + (match[5] || ''))}</span>`;
      }
      previewEl.innerHTML = html;
    }

    // input = live preview while dragging the picker; change = save + tell other blocks
    function makeCell(label, getVal, setVal) {
      const cell = document.createElement('label');
      cell.className = 'ig-tcs-cell';
      const tag = document.createElement('span');
      tag.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = getVal();
      inp.addEventListener('input', () => { setVal(inp.value); renderPreview(); });
      inp.addEventListener('change', () => { setVal(inp.value); save(); });
      cell.append(tag, inp);
      return cell;
    }

    function renderGrids() {
      numGrid.innerHTML = '';
      NUMBER_SLOTS.forEach(n => numGrid.appendChild(makeCell(n, () => cfg.numbers[n], v => { cfg.numbers[n] = v; })));
      numGrid.appendChild(makeCell('11+', () => cfg.numberOther, v => { cfg.numberOther = v; }));

      letterGrid.innerHTML = '';
      LETTERS.forEach(ch => letterGrid.appendChild(makeCell(ch.toUpperCase(), () => cfg.letters[ch], v => { cfg.letters[ch] = v; })));
      letterGrid.appendChild(makeCell('Other', () => cfg.letterOther, v => { cfg.letterOther = v; }));
      renderPreview();
    }

    previewInput.addEventListener('input', renderPreview);
    wrap.querySelector('.ig-tcs-reset').onclick = () => {
      if (!confirm('Reset all tag colors to defaults?')) return;
      cfg = buildDefaults();
      save();
      renderGrids();
    };

    renderGrids();

    function mountCard(attemptsLeft = 10) {
      if (typeof core.registerMenu === 'function') core.registerMenu('left', '🎨 Tag Colors', wrap, '⠿', 'tag-color-settings');
      else if (attemptsLeft > 0) setTimeout(() => mountCard(attemptsLeft - 1), 200);
    }
    mountCard();

    core.emit('block:ready', { id: 'tagColorSettingsModule' });
  }
});

  LegoCore.boot();
})();
