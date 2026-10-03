// Creates exactly one placeholder .jar in download/jars/ for every download
// button that the site can serve from there - and nothing else. No .zip
// files, no -sources.jar file.
//
//   node _scripts/create-placeholder-jars.js
//   node _scripts/create-placeholder-jars.js --dry-run
//
// Every download page under _updates/ is scanned and turned into its official
// file names, all directly in download/jars/, e.g.
//   download/jars/Wurst-Client-v7.54-MC26.2.jar
//   download/jars/Wurst-Client-v6.21-MC1.8.jar
//
// By default only the most downloaded builds get their own file, so the folder
// stays small and every other download button uses the catch-all
// catch-all jar. Pass --all to create a placeholder for every download
// instead.
//
// Placeholders are valid (but empty) jar files whose PLACEHOLDER.txt contains
// the marker string, so _scripts/generate-custom-jars.js ignores them until
// they are replaced with a real build. Existing files are never overwritten:
// drop your build in place of a placeholder and it goes live on the next scan.

const fs = require('fs');
const path = require('path');
const matter = require('front-matter');
const {
    ROOT,
    JARS_DIR,
    FALLBACK_FILE,
    MARKER
} = require('./custom-jars-lib.js');

const UPDATES_DIR = path.join(ROOT, '_updates');
const DRY_RUN = process.argv.includes('--dry-run');
const CREATE_ALL = process.argv.includes('--all');

// The 5 most downloaded Wurst builds, by the download counts of their release
// assets (which is where every download button used to go).
const TOP_DOWNLOADS = [
    'Wurst-Client-v6.16-MC1.12.jar',       // 449,679 downloads
    'Wurst-Client-v6.25-MC1.12.jar',       // 358,480 downloads
    'Wurst-Client-v7.15.2-MC1.16.5.jar',   // 332,866 downloads
    'Wurst-Client-v7.35.1-MC1.20.1.jar',   // 236,494 downloads
    'Wurst-Client-v6.11.1-MC1.12.jar'      // 235,652 downloads
];

// Minecraft versions appear in file names with spaces replaced by dashes.
function slug(mcversion) {
    return String(mcversion).replace(/ /g, '-');
}

// Every official .jar file name that the download pages link to.
// Map of file name -> a short note about where it comes from.
function collectTargets() {
    const targets = new Map();

    function addFile(relative, note) {
        if (!targets.has(relative))
            targets.set(relative, note);
    }

    function visit(file, attributes) {
        const version = attributes['wurst-version'];
        if (!version)
            return;
        if (attributes['old-downloads'] || attributes['old-mcx'])
            return; // page shows the DMCA notice instead of downloads
        if (attributes.layout === 'update_kofi')
            return; // page only links to Ko-fi

        const base = `Wurst-Client-v${version}-MC`;
        const note = path.relative(ROOT, file);

        if (attributes.fabric) {
            const versions = [
                ...(attributes['minecraft-versions'] || []),
                ...(attributes.snapshots || [])
            ];
            for (const mcversion of versions)
                addFile(`${base}${slug(mcversion)}.jar`, note);
        } else {
            for (const mcversion of attributes['minecraft-versions'] || [])
                addFile(`${base}${slug(mcversion)}.jar`, note);
        }
    }

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.md'))
                continue;

            let parsed;
            try {
                parsed = matter(fs.readFileSync(full, 'utf8'));
            } catch (e) {
                console.warn(`Could not parse ${full}: ${e.message}`);
                continue;
            }
            visit(full, parsed.attributes);
        }
    }

    walk(UPDATES_DIR);
    return targets;
}

// --- minimal store-only zip writer -----------------------------------------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++)
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

function buildZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;

    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const data = Buffer.from(content, 'utf8');
        const crc = crc32(data);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);          // version needed
        local.writeUInt16LE(0, 6);           // flags
        local.writeUInt16LE(0, 8);           // method: store
        local.writeUInt16LE(0, 10);          // time
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);          // extra length
        nameBuf.copy(local, 30);
        parts.push(local, data);

        const record = Buffer.alloc(46 + nameBuf.length);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(20, 4);         // version made by
        record.writeUInt16LE(20, 6);         // version needed
        record.writeUInt16LE(0, 8);          // flags
        record.writeUInt16LE(0, 10);         // method: store
        record.writeUInt16LE(0, 12);         // time
        record.writeUInt16LE(DOS_DATE, 14);
        record.writeUInt32LE(crc, 16);
        record.writeUInt32LE(data.length, 20);
        record.writeUInt32LE(data.length, 24);
        record.writeUInt16LE(nameBuf.length, 28);
        record.writeUInt16LE(0, 30);         // extra length
        record.writeUInt16LE(0, 32);         // comment length
        record.writeUInt16LE(0, 34);         // disk number
        record.writeUInt16LE(0, 36);         // internal attributes
        record.writeUInt32LE(0, 38);         // external attributes
        record.writeUInt32LE(offset, 42);
        nameBuf.copy(record, 46);
        central.push(record);

        offset += local.length + data.length;
    }

    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);                // disk number
    eocd.writeUInt16LE(0, 6);                // disk with central dir
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);               // comment length

    return Buffer.concat([...parts, centralBuf, eocd]);
}

function buildPlaceholderJar(fileName) {
    const manifest = [
        'Manifest-Version: 1.0',
        'Created-By: Wurst placeholder jar generator',
        '',
        ''
    ].join('\r\n');

    const note = [
        MARKER,
        `Placeholder for ${fileName}.`,
        '',
        'This file is an empty stub, not a working Wurst build. Replace it with',
        'your real build using this exact file name to make the website serve it.',
        ''
    ].join('\r\n');

    return buildZip([
        ['META-INF/MANIFEST.MF', manifest],
        ['PLACEHOLDER.txt', note]
    ]);
}

// --- main ------------------------------------------------------------------

function main() {
    const allTargets = collectTargets();
    let targets = allTargets;

    if (!CREATE_ALL) {
        targets = new Map();
        for (const name of TOP_DOWNLOADS) {
            if (!allTargets.has(name)) {
                console.warn(`WARNING: ${name} is not a download on any update page.`);
                continue;
            }
            targets.set(name, allTargets.get(name));
        }
        console.log(`${targets.size} top download(s) keep their own file; every other download uses ${FALLBACK_FILE}.`);
        console.log('Use --all to create a placeholder for every download instead.');
    }

    let created = 0;
    let kept = 0;

    for (const [fileName, note] of targets) {
        const full = path.join(JARS_DIR, fileName);
        if (fs.existsSync(full)) {
            kept++;
            continue;
        }

        if (!DRY_RUN)
            fs.writeFileSync(full, buildPlaceholderJar(fileName));
        created++;
        console.log(`+ ${fileName} (from ${note})`);
    }

    const fallbackPath = path.join(JARS_DIR, FALLBACK_FILE);
    let fallbackNote = '';
    if (!fs.existsSync(fallbackPath)) {
        if (!DRY_RUN)
            fs.writeFileSync(fallbackPath, buildPlaceholderJar(FALLBACK_FILE));
        fallbackNote = `, created catch-all ${FALLBACK_FILE}`;
    }

    console.log('');
    console.log(`${DRY_RUN ? 'Would create' : 'Created'} ${created} placeholder jar(s) for ${targets.size} download file name(s); ${kept} file(s) already existed and were left alone${fallbackNote}.`);
    console.log('No .zip placeholders are created.');
    if (!DRY_RUN)
        console.log('Next: node _scripts/generate-custom-jars.js');
}

if (require.main === module)
    main();

module.exports = { buildPlaceholderJar, buildZip, collectTargets, TOP_DOWNLOADS };
