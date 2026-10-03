// Scratch tool: compares this working tree against the upstream GitHub repo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OWNER = 'Wurst-Imperium';
const REPO = 'wurstclient.net';
const BRANCH = 'gh-pages';
const SKIP = new Set(['node_modules', '.git', '.freebuff', '.jekyll-cache', '_site']);

async function gh(p) {
    const r = await fetch(`https://api.github.com/${p}`, {
        headers: { 'user-agent': 'local-check', accept: 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
    return r.json();
}

function blobSha(buf) {
    return 'sha1:' + crypto.createHash('sha1')
        .update(Buffer.from(`blob ${buf.length}\0`, 'utf8'))
        .update(buf)
        .digest('hex');
}

// Git normalizes CRLF to LF on check-in, so compare with LF endings.
function normalize(buf) {
    return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

(async () => {
    const tree = await gh(`repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`);
    const upstream = new Map(tree.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]));
    console.log(`upstream blobs: ${upstream.size} (truncated: ${tree.truncated})`);

    const local = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else local.push(full.replace(/\\/g, '/'));
        }
    })('.');
    console.log(`local files: ${local.length}`);

    const differing = [];
    const notUpstream = [];
    for (const f of local) {
        if (!upstream.has(f)) { notUpstream.push(f); continue; }
        const buf = normalize(fs.readFileSync(f));
        if (blobSha(buf) !== upstream.get(f)) differing.push(f);
    }

    const upstreamOnly = [...upstream.keys()].filter(p => !fs.existsSync(p));

    console.log(`\n=== DIFFERENT FROM UPSTREAM (${differing.length}) ===`);
    console.log(differing.slice(0, 120).join('\n'));

    console.log(`\n=== NOT IN UPSTREAM (${notUpstream.length}) ===`);
    console.log(notUpstream.slice(0, 60).join('\n'));

    console.log(`\n=== MISSING LOCALLY (${upstreamOnly.length}) ===`);
    console.log(upstreamOnly.slice(0, 60).join('\n'));
})();
