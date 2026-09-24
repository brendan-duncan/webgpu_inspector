/**
 * Live GPU objects grouped by where the page created them, for finding leaks.
 *
 * A leak in a WebGPU page is rarely one object: it is a line of code that
 * creates a buffer or bind group every frame and never lets it go. Grouping
 * live objects by their creation site (the first frame of the creation stack
 * trace) turns thousands of list entries into the handful of call sites that
 * own them, and a baseline — "only objects created since I marked" — shows
 * which of those sites keep growing.
 *
 * Without object stack traces there is no call site, so objects fall back to
 * being grouped by type and label, which still separates a well-labeled
 * app's allocations.
 *
 * DOM-free so it can be unit tested; allocations_view.js draws it.
 */

/**
 * Where an object was created: the first frame of its stack trace, or its
 * label when there is no stack trace.
 * @param {Object} object - a GPU object, or a leak record ({ label, stacktrace })
 * @returns {{key:string, text:string, fromStack:boolean}}
 */
export function creationSite(object) {
    let stack = "";
    try {
        stack = object.stacktrace ?? "";
    } catch (e) {
        stack = "";
    }
    const frame = stack.split("\n").map((l) => l.trim()).find(Boolean);
    if (frame) {
        return { key: `stack:${frame}`, text: frame, fromStack: true };
    }
    const label = object.label || "";
    return { key: `label:${label}`, text: label ? `"${label}"` : "(unlabeled, no stack trace)", fromStack: false };
}

/** An object's estimated GPU memory in bytes (buffers and textures), else 0. */
export function objectBytes(object) {
    const type = object?.constructor?.className;
    if (type === "Buffer") {
        return object.size ?? object.descriptor?.size ?? 0;
    }
    if (type === "Texture" && object.getGpuSize) {
        return Math.max(0, object.getGpuSize());
    }
    return 0;
}

/**
 * Group objects by creation site and type.
 * @param {Iterable<Object>} objects
 * @param {Object} [options]
 * @param {string} [options.type] - only this class name ("Buffer", ...)
 * @param {number} [options.sinceId] - only objects with a larger id (created after a baseline)
 * @returns {{groups: Object[], count: number, bytes: number, withStack: number}}
 *   groups are { key, site, type, count, bytes, objects }, largest first
 */
export function groupLiveObjects(objects, { type, sinceId } = {}) {
    const groups = new Map();
    let count = 0;
    let bytes = 0;
    let withStack = 0;
    for (const object of objects) {
        if (!object || object.isDeleted || !(object.id > 0)) {
            continue;
        }
        const cls = object.constructor?.className ?? "";
        if (cls === "ValidationError" || (type && cls !== type)) {
            continue;
        }
        if (sinceId !== undefined && sinceId !== null && object.id <= sinceId) {
            continue;
        }
        const site = creationSite(object);
        if (site.fromStack) {
            withStack++;
        }
        const key = `${cls}|${site.key}`;
        let group = groups.get(key);
        if (!group) {
            group = { key, site: site.text, type: cls, count: 0, bytes: 0, objects: [] };
            groups.set(key, group);
        }
        const b = objectBytes(object);
        group.count++;
        group.bytes += b;
        group.objects.push(object);
        count++;
        bytes += b;
    }
    return { groups: sortGroups([...groups.values()]), count, bytes, withStack };
}

/**
 * Group leak records (objects garbage collected without destroy()) by
 * creation site and type.
 * @param {Object[]} records - database.leakedObjects
 * @returns {Object[]} { key, site, type, count, bytes, lastTime }, largest first
 */
export function groupLeaks(records, { type } = {}) {
    const groups = new Map();
    for (const record of records) {
        if (type && record.type !== type) {
            continue;
        }
        const site = creationSite(record);
        const key = `${record.type}|${site.key}`;
        let group = groups.get(key);
        if (!group) {
            group = { key, site: site.text, type: record.type, count: 0, bytes: 0, lastTime: 0 };
            groups.set(key, group);
        }
        group.count++;
        group.bytes += record.bytes ?? 0;
        group.lastTime = Math.max(group.lastTime, record.time ?? 0);
    }
    return sortGroups([...groups.values()]);
}

function sortGroups(groups) {
    return groups.sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.site.localeCompare(b.site));
}

/** The largest object id currently alive: a baseline marker, since ids only grow. */
export function baselineId(objects) {
    let max = 0;
    for (const object of objects) {
        if (object?.id > max) {
            max = object.id;
        }
    }
    return max;
}
