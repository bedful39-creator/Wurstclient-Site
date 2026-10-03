// Shared helpers for the custom jar script. Not used by the site itself.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JARS_DIR = path.join(ROOT, 'download', 'jars');
const DATA_FILE = path.join(ROOT, '_data', 'custom_jars.yml');
const SITE_DIR = '/download/jars';
const FALLBACK_FILE = 'Wurst-Client-V8.1-MC.jar';
const FALLBACK_URL = `${SITE_DIR}/${FALLBACK_FILE}`;
const MARKER = 'WURST-CUSTOM-JAR-PLACEHOLDER';

// Relative (web-style) paths of every .jar/.zip under dir, sorted.
function listFiles(dir, base = '') {
    const found = [];
    if (!fs.existsSync(dir))
        return found;

    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const relative = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory())
            found.push(...listFiles(path.join(dir, entry.name), relative));
        else if (/\.(jar|zip)$/i.test(entry.name))
            found.push(relative);
    }
    return found;
}

// The catch-all build is a stub until it is replaced with a real
// build. A file still counts as a stub if its raw bytes contain the marker.
function isPlaceholder(filePath) {
    if (!fs.existsSync(filePath))
        return false;

    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(65536);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, read).includes(MARKER);
    } catch (e) {
        console.warn(`Could not read ${filePath}: ${e.message}`);
        return false;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

module.exports = {
    ROOT,
    JARS_DIR,
    DATA_FILE,
    SITE_DIR,
    FALLBACK_FILE,
    FALLBACK_URL,
    MARKER,
    listFiles,
    isPlaceholder
};
