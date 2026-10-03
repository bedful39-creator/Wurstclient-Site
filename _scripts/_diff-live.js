// Scratch tool: crawls live wurstclient.net and diffs it against the local
// server.js renderer, so the emulator can be fixed until it is 1:1.
//
//   node _scripts/_diff-live.js              # all sitemap URLs
//   node _scripts/_diff-live.js 40           # first 40 URLs
//   node _scripts/_diff-live.js 0 download   # only URLs containing "download"
//
// Compares three extracted signals per page: <title>, the ordered list of
// links, and the visible text. Writes _scripts/_diff-report.txt
const fs = require('fs');
const path = require('path');

const LOCAL = process.env.LOCAL || 'http://localhost:5829';
const LIVE = 'https://www.wurstclient.net';
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const LIMIT = Number(process.argv[2] || 0);
const FILTER = process.argv[3] || '';
const REPORT = path.join(__dirname, '_diff-report.txt');

function strip(html) {
    return html
        .replace(/\r\n/g, '\n')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<ins[\s\S]*?<\/ins>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}

function title(html) {
    const m = html.match(/<title>([\s\S]*?)<\/title>/i);
    return m ? m[1].trim() : '(none)';
}

// Links in document order, as "href|text" so a wrong target or label shows up.
// Email links are left out: Cloudflare rewrites every address into a
// /cdn-cgi/l/email-protection link at the edge, even ones that are plain text
// in the page, so they carry no signal about the rendered site.
function links(html) {
    const out = [];
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
        const attrs = m[1];
        const hrefM = attrs.match(/href\s*=\s*"([^"]*)"/i);
        const onclickM = attrs.match(/onclick\s*=\s*"([^"]*)"/i);
        const dataHrefM = attrs.match(/data-href\s*=\s*"([^"]*)"/i);
        const target = (hrefM && hrefM[1]) || (onclickM && onclickM[1]) || (dataHrefM && dataHrefM[1]) || '';
        if (/^mailto:|\/cdn-cgi\/l\/email-protection/.test(target)) continue;
        const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        out.push(`${target} | ${text}`);
    }
    return out;
}

function text(html) {
    return strip(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        // Block elements become separators so list items don't run together.
        .replace(/<\/(p|li|ul|ol|div|h[1-6]|tr|td|th|section|article|details|summary|aside|main|header|footer|nav|blockquote|pre|table|figure)>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

// Heading ids, in document order, so a wrong kramdown auto id shows up.
function headingIds(html) {
    return [...html.matchAll(/<h[1-6]\b[^>]*>/gi)]
        .map(m => (m[0].match(/\bid\s*=\s*"([^"]*)"/i) || [null, ''])[1])
        .filter(id => id !== '');
}

function normalize(s) {
    return s
        .replace(/https:\/\/www\.wurstclient\.net/g, '')
        .replace(/https:\/\/api\.wurstclient\.(net|local)/g, 'API')
        // Cloudflare rewrites every email address into an obfuscated link at the
        // edge; that is hosting behaviour, not something the site renders.
        .replace(/mailto:[^"'\s<>]+/g, 'EMAIL')
        .replace(/\/cdn-cgi\/l\/email-protection[^"'\s<>]*/g, 'EMAIL')
        .replace(/\[email(?:&#160;|\u00a0| )protected\]/g, 'EMAIL')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'EMAIL')
        // Serving our own jars is an intentional change, so collapse every
        // download target and its "File: x.jar" label to one token. Anything
        // left after this is a genuine template bug.
        .replace(/\/download\/jars\/[A-Za-z0-9._-]+\.jar/g, 'CUSTOMJAR')
        .replace(/File: Wurst-Client-[A-Za-z0-9._-]+\.jar/g, 'File: JAR')
        .replace(/Wurst-Client-v[0-9][A-Za-z0-9._-]*-MC[A-Za-z0-9._-]+\.jar/g, 'JAR');
}

function listDiff(a, b) {
    const setB = new Set(b);
    const setA = new Set(a);
    return {
        onlyLocal: [...new Set(a.filter(x => !setB.has(x)))],
        onlyLive: [...new Set(b.filter(x => !setA.has(x)))],
        same: a.length === b.length && a.every((x, i) => x === b[i])
    };
}

async function sitemapUrls() {
    const r = await fetch(`${LIVE}/sitemap.xml`, { headers: UA });
    const t = await r.text();
    return [...t.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map(m => m[1].replace(LIVE, ''))
        .filter(u => u && !u.includes('.xml'));
}

(async () => {
    let urls = await sitemapUrls();
    if (FILTER) urls = urls.filter(u => u.includes(FILTER));
    if (LIMIT) urls = urls.slice(0, LIMIT);
    console.log(`comparing ${urls.length} URLs...\n`);

    const report = [];
    const statusMismatch = [];
    const bodyMismatch = [];
    const ok = [];

    // Redirects are compared as redirects: the production host answers some
    // legacy URLs with a real 301, so following it here would compare the
    // destination page instead of this site's own response.
    async function get(base, u, headers) {
        const x = await fetch(base + u, { headers, redirect: 'manual' });
        const status = x.status;
        const location = x.headers.get('location') || '';
        return { status, location, body: status >= 300 && status < 400 ? '' : await x.text() };
    }

    async function check(u) {
        const [l, r] = await Promise.allSettled([
            get(LOCAL, u, undefined),
            get(LIVE, u, UA)
        ]);
        const local = l.status === 'fulfilled' ? l.value : { status: 0, location: '', body: '' };
        const live = r.status === 'fulfilled' ? r.value : { status: 0, location: '', body: '' };

        if (local.status !== live.status) {
            statusMismatch.push({ url: u, local: `${local.status} ${local.location}`, live: `${live.status} ${live.location}` });
            return;
        }

        if (local.status >= 300 && local.status < 400) {
            const ll = normalize(local.location);
            const rl = normalize(live.location);
            if (ll === rl) {
                ok.push(u);
            } else {
                statusMismatch.push({ url: u, local: `${local.status} ${local.location}`, live: `${live.status} ${live.location}` });
            }
            return;
        }

        const lt = normalize(title(local.body));
        const rt = normalize(title(live.body));
        const ll = links(strip(local.body)).map(normalize);
        const rl = links(strip(live.body)).map(normalize);
        const lx = normalize(text(local.body));
        const rx = normalize(text(live.body));

        const li = headingIds(local.body);
        const ri = headingIds(live.body);
        const ld = listDiff(ll, rl);
        const titleOk = lt === rt;
        const textOk = lx === rx;
        const idsOk = li.length === ri.length && li.every((x, i) => x === ri[i]);

        if (titleOk && ld.same && textOk && idsOk) {
            ok.push(u);
            return;
        }

        bodyMismatch.push(u);
        const lines = [`\n### ${u}`];
        if (!titleOk) lines.push(`  TITLE local: ${lt}\n  TITLE live : ${rt}`);
        if (!ld.same) {
            lines.push(`  LINKS local=${ll.length} live=${rl.length}`);
            if (ld.onlyLive.length) lines.push(`  -- LINKS ONLY LIVE (${ld.onlyLive.length}) --\n` + ld.onlyLive.slice(0, 15).map(s => '   L ' + s.slice(0, 200)).join('\n'));
            if (ld.onlyLocal.length) lines.push(`  -- LINKS ONLY LOCAL (${ld.onlyLocal.length}) --\n` + ld.onlyLocal.slice(0, 15).map(s => '   E ' + s.slice(0, 200)).join('\n'));
        }
        if (!idsOk) {
            const first = li.findIndex((x, i) => x !== ri[i]);
            lines.push(`  HEADING IDS differ at #${first < 0 ? 'end' : first} (local ${li.length}, live ${ri.length})`);
            lines.push(`   LOCAL: ${li.slice(0, 12).join(', ')}`);
            lines.push(`   LIVE : ${ri.slice(0, 12).join(', ')}`);
        }
        if (!textOk) {
            // locate the first text divergence
            let i = 0;
            const n = Math.min(lx.length, rx.length);
            while (i < n && lx[i] === rx[i]) i++;
            lines.push(`  TEXT differs at char ${i} (local ${lx.length}, live ${rx.length})`);
            lines.push(`   LOCAL: ...${lx.slice(Math.max(0, i - 60), i + 160)}`);
            lines.push(`   LIVE : ...${rx.slice(Math.max(0, i - 60), i + 160)}`);
        }
        report.push(lines.join('\n'));
    }

    // Bounded concurrency so a full-site run finishes in reasonable time.
    const QUEUE = [...urls];
    const WORKERS = 12;
    await Promise.all(Array.from({ length: WORKERS }, async () => {
        while (QUEUE.length) await check(QUEUE.shift());
    }));

    const header = [
        `live diff report`,
        `urls compared : ${urls.length}`,
        `identical     : ${ok.length}`,
        `body differs  : ${bodyMismatch.length}`,
        `status differs: ${statusMismatch.length}`,
        '',
        'STATUS MISMATCHES:',
        ...statusMismatch.map(s => `  ${s.url}  local=${s.local} live=${s.live}`),
        '',
        'BODY MISMATCHES:',
        ...bodyMismatch.map(s => `  ${s}`)
    ].join('\n');

    fs.writeFileSync(REPORT, header + '\n' + report.join('\n') + '\n');
    console.log(header);
    console.log(`\nfull report: ${REPORT}`);
})();
