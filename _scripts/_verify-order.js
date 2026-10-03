// Scratch tool: works out how Jekyll orders the updates collection, by
// comparing candidate sort keys against the order the live site renders.
const fs = require('fs');
const path = require('path');
const matter = require('front-matter');

const LIVE = 'https://www.wurstclient.net';
const UA = { 'user-agent': 'Mozilla/5.0' };

function slugify(s) {
    return String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function collect(dir) {
    const out = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!/\.(md|html)$/.test(e.name)) continue;
            const rel = full.replace(/\\/g, '/');
            const base = e.name.replace(/\.(md|html)$/, '');
            const attrs = matter(fs.readFileSync(full, 'utf8')).attributes;
            const dm = base.match(/^(\d{4})-(\d{2})-(\d{2})-/);
            out.push({
                rel,
                base,
                attrs,
                slug: slugify(base.replace(/^\d{4}-\d{2}-\d{2}-/, '')),
                fileDate: dm ? new Date(`${dm[1]}-${dm[2]}-${dm[3]}T00:00:00Z`) : null,
                mtime: fs.statSync(full).mtime
            });
        }
    })(dir);
    return out;
}

(async () => {
    const html = await fetch(`${LIVE}/download/all/`, { headers: UA }).then(r => r.text());
    const liveOrder = [...html.matchAll(/href="\/updates\/([^"\/]+)\//g)].map(m => m[1]);
    console.log(`live order: ${liveOrder.length} entries`);

    const files = collect('_updates');
    console.log(`local files: ${files.length}`);

    // The template does `for update in site.updates reversed`, so site.updates
    // must be oldest-first for the render to be newest-first.
    const candidates = {
        'front-matter date, asc': f => f.attrs.date ? new Date(f.attrs.date) : null,
        'filename date, asc': f => f.fileDate,
        'file mtime, asc': f => f.mtime
    };

    for (const [name, keyFn] of Object.entries(candidates)) {
        const sorted = [...files].sort((a, b) => {
            const ka = keyFn(a), kb = keyFn(b);
            if (ka === null || kb === null) return 0;
            return ka - kb;
        });
        const rendered = sorted.map(f => f.slug).reverse();
        const matches = rendered.filter((s, i) => s === liveOrder[i]).length;
        console.log(`\n  ${matches}/${liveOrder.length} positions match  (${name})`);
        // show first mismatch
        for (let i = 0; i < liveOrder.length; i++) {
            if (rendered[i] !== liveOrder[i]) {
                console.log(`    first mismatch at ${i}: rendered=${rendered[i]} live=${liveOrder[i]}`);
                break;
            }
        }
    }

    // Where do the interesting ones sit?
    console.log('\n  sample entries:');
    for (const v of ['7.56pre2', '7.55.2', '7.56pre1', '7.55.1', '7.55', '7.55pre1', '7.54.1', '7.54']) {
        const f = files.find(x => x.slug === `wurst-${slugify(v)}`);
        if (f) console.log(`    ${v.padEnd(10)} file=${f.rel} fileDate=${f.fileDate && f.fileDate.toISOString().slice(0, 10)} mtime=${f.mtime.toISOString().slice(0, 10)} fmDate=${f.attrs.date || '-'}`);
    }
})();
