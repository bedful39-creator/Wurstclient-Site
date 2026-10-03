// Scratch tool: probe every _redirects/<path> URL on the live site and record
// the real HTTP status + Location header, so server.js can mirror the hosting
// layer's server-side redirects instead of only rendering the meta-refresh page.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, '_redirects');

function walk(dir, rel = '') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), nextRel));
        else out.push(nextRel);
    }
    return out;
}

const urls = walk(DIR)
    .map((p) => p.replace(/\.(md|html)$/, ''))
    .map((p) => `/${p}/`);

async function probe(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await fetch(`https://www.wurstclient.net${url}`, {
                redirect: 'manual',
                headers: { 'user-agent': 'Mozilla/5.0' }
            });
            return { url, status: r.status, location: r.headers.get('location') || '' };
        } catch (e) {
            if (attempt === 1) return { url, status: 'ERR', location: e.message };
        }
    }
}

async function main() {
    const results = [];
    const queue = [...urls];
    const workers = Array.from({ length: 8 }, async () => {
        while (queue.length) {
            const url = queue.shift();
            results.push(await probe(url));
            process.stdout.write('.');
        }
    });
    await Promise.all(workers);

    const ordered = urls.map((u) => results.find((r) => r.url === u));
    fs.writeFileSync(path.join(ROOT, '_scripts', '_live-redirects.json'), JSON.stringify(ordered, null, 2));

    const redirects = ordered.filter((r) => r.status !== 200);
    console.log(`\nnon-200: ${redirects.length} of ${ordered.length}`);
    for (const r of redirects) console.log(`${r.url} -> ${r.status} ${r.location}`);
}

main();
