// Scratch tool: works out how Jekyll turns _updates/_wiki/_tutorials files into
// URLs, by testing candidate rules against the live sitemap.
const fs = require('fs');
const path = require('path');

const LIVE = 'https://www.wurstclient.net';
const UA = { 'user-agent': 'Mozilla/5.0' };

// Jekyll's Utils.slugify, default mode: runs of non-alphanumerics become one
// hyphen, leading/trailing hyphens are stripped, then downcased.
function slugify(s) {
    return String(s)
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
}

function collect(dir) {
    const out = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!/\.(md|html)$/.test(e.name)) continue;
            out.push({
                rel: full.replace(/\\/g, '/').replace(`${dir}/`, ''),
                base: e.name.replace(/\.(md|html)$/, '')
            });
        }
    })(dir);
    return out;
}

async function sitemap() {
    const t = await fetch(`${LIVE}/sitemap.xml`, { headers: UA }).then(r => r.text());
    return new Set([...t.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(LIVE, '')));
}

(async () => {
    const live = await sitemap();

    for (const [dir, prefix] of [['_updates', '/updates/'], ['_wiki', '/wiki/'], ['_tutorials', '/tutorials/']]) {
        const files = collect(dir);
        const rules = {
            'date-stripped slugify(base)': f => prefix + slugify(f.base.replace(/^\d{4}-\d{2}-\d{2}-/, '')) + '/',
            'slugify(base)': f => prefix + slugify(f.base) + '/',
            'raw rel path': f => prefix + f.rel.replace(/\.(md|html)$/, '') + '/',
            'slugified rel path': f => prefix + f.rel.split('/').map(x => slugify(x.replace(/\.(md|html)$/, ''))).join('/') + '/'
        };

        console.log(`\n=== ${dir} (${files.length} files) ===`);
        for (const [name, fn] of Object.entries(rules)) {
            let hit = 0;
            const misses = [];
            for (const f of files) {
                const u = fn(f);
                if (live.has(u)) hit++;
                else if (misses.length < 4) misses.push(`${f.rel} -> ${u}`);
            }
            console.log(`  ${String(hit).padStart(4)}/${files.length}  ${name}`);
            if (hit < files.length) for (const m of misses) console.log(`         miss: ${m}`);
        }
    }
})();
