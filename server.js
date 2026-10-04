const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const matter = require('front-matter');
const MarkdownIt = require('markdown-it');
const { Liquid } = require('liquidjs');

// The live site is built by kramdown with its default typographic symbols, so
// "..." becomes "…" and quotes become curly ones. markdown-it's typographer
// does both, and it never touches code spans, so keep it on and let
// protectRawHtml() keep raw HTML away from it. Plain kramdown does not turn
// bare URLs into links, so linkify stays off.
const md = new MarkdownIt({ html: true, linkify: false, breaks: true, typographer: true });

// markdown-it only converts a double quote when it can pair it up, while
// kramdown decides each quote on its own: one that follows whitespace or an
// opening bracket always opens. Convert whatever markdown-it left straight.
md.core.ruler.after('smartquotes', 'kramdown_quotes', (state) => {
    for (const token of state.tokens) {
        if (token.type !== 'inline' || !token.children) continue;
        for (const child of token.children) {
            if (child.type === 'text' && child.content.includes('"')) {
                child.content = child.content
                    .replace(/(^|[\s([{])"/g, '$1\u201C')
                    .replace(/"/g, '\u201D');
            }
        }
    }
});

// kramdown gives every heading an id and turns `{:.no_toc}` into a class on the
// heading itself. prepareKramdown() collects that information in document
// order, so the renderer can read it back off the env object.
const defaultHeadingOpen = md.renderer.rules.heading_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const info = env && env.headings && env.headings.shift();
    if (info) {
        if (info.classes.length) tokens[idx].attrSet('class', info.classes.join(' '));
        if (info.id) tokens[idx].attrSet('id', info.id);
    }
    return defaultHeadingOpen(tokens, idx, options, env, self);
};

const app = express();
const PORT = process.env.PORT || 5829;
const ROOT = __dirname;

// Raw HTML that kramdown would pass through untouched.
const HTML_BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'canvas', 'details', 'div',
    'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'header', 'iframe', 'ins', 'main', 'nav',
    'noscript', 'ol', 'p', 'pre', 'script', 'section', 'style', 'svg',
    'table', 'ul', 'video'
]);
const RAW_INLINE_TAGS = 'code|kbd|samp|var|tt';
const PLACEHOLDER = /<!--HTMLBLOCK:(\d+)-->/g;

// markdown-it closes an HTML block at the first blank line and turns indented
// HTML into a code block, but kramdown keeps raw HTML open until its closing
// tag and never applies typography inside it. Liquid includes are full of both
// blank and indented lines, so lift every raw HTML region out before rendering
// and splice it back in verbatim afterwards.
function protectRawHtml(text) {
    const blocks = [];
    const stash = (value) => {
        blocks.push(value);
        return `<!--HTMLBLOCK:${blocks.length - 1}-->`;
    };

    const lines = text.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>/])/);
        if (!m || !HTML_BLOCK_TAGS.has(m[1].toLowerCase())) {
            kept.push(lines[i]);
            continue;
        }

        const tag = m[1].toLowerCase();
        const open = new RegExp(`<${tag}(?=[\\s>/])`, 'gi');
        const close = new RegExp(`</${tag}\s*>`, 'gi');
        let depth = 0;
        let end = -1;
        for (let j = i; j < lines.length; j++) {
            depth += (lines[j].match(open) || []).length;
            depth -= (lines[j].match(close) || []).length;
            if (depth <= 0) { end = j; break; }
        }
        if (end < 0) {
            kept.push(lines[i]);
            continue;
        }

        kept.push(stash(lines.slice(i, end + 1).join('\n')));
        i = end;
    }

    return {
        text: kept.join('\n').replace(
            new RegExp(`<(${RAW_INLINE_TAGS})(?=[\\s>/])[\\s\\S]*?</\\1\\s*>`, 'gi'),
            (match) => stash(match)
        ),
        blocks
    };
}

// kramdown's heading id: drop inline markup, strip anything that is not a
// letter, digit, space, hyphen or underscore, turn spaces into hyphens,
// lower-case it, and de-duplicate by appending -1, -2, ...
function kramdownHeadingId(text, usedIds) {
    let id = String(text)
        .replace(/<[^>]*>/g, '')
        .replace(/[*`~\[\]]/g, '')
        .replace(/^[^a-zA-Z]+/, '')
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .replace(/ /g, '-')
        .toLowerCase();
    if (!id) id = 'section';
    const base = id;
    let n = 1;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
}

const HEADING_LINE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM_LINE = /^\s*(?:\d+\.|[-*+])\s+/;
const IAL_TOC = /^\s*\{:\s*toc\s*\}\s*$/i;
const IAL_NO_TOC = /^\s*\{:[^}]*\.no_toc[^}]*\}\s*$/;

function renderToc(headings, listType) {
    const items = headings
        .filter((h) => !h.classes.includes('no_toc'))
        .map((h) => `  <li><a href="#${h.id}" id="markdown-toc-${h.id}">${h.text}</a></li>`);
    return `<${listType} id="markdown-toc">\n${items.join('\n')}\n</${listType}>`;
}

// kramdown-only syntax this site uses: heading auto ids, the `{:.no_toc}` IAL
// and `{:toc}` (which replaces the list above it with a table of contents).
function prepareKramdown(text) {
    const lines = text.split('\n');
    const headings = [];
    const usedIds = new Set();
    let fence = null;
    let tocIndex = -1;
    let tocListType = 'ul';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        const fenceMatch = line.match(/^\s*(```|~~~)/);
        if (fenceMatch) {
            if (fence === null) fence = fenceMatch[1];
            else if (line.trim().startsWith(fence)) fence = null;
            continue;
        }
        if (fence) continue;

        const heading = line.match(HEADING_LINE);
        if (heading) {
            const headingText = heading[2].replace(/<[^>]*>/g, '').trim();
            const classes = IAL_NO_TOC.test(lines[i + 1] || '') ? ['no_toc'] : [];
            if (classes.length) lines[i + 1] = '';
            headings.push({
                level: heading[1].length,
                text: headingText,
                id: kramdownHeadingId(headingText, usedIds),
                classes
            });
            continue;
        }

        if (IAL_TOC.test(line)) {
            // The `{:toc}` IAL belongs to the list above it, which kramdown
            // replaces with a table of contents of the whole document.
            const previous = lines[i - 1] || '';
            const isList = LIST_ITEM_LINE.test(previous) && !HEADING_LINE.test(previous);
            tocListType = isList && /^\s*\d+\./.test(previous) ? 'ol' : 'ul';
            if (isList) lines[i - 1] = '';
            lines[i] = '';
            tocIndex = i;
            continue;
        }

        if (IAL_NO_TOC.test(line)) lines[i] = '';
    }

    if (tocIndex >= 0) lines[tocIndex] = renderToc(headings, tocListType);

    return { text: lines.join('\n'), headings };
}

function cleanLiquidComments(str) {
    if (!str) return '';
    return str.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, '');
}

const engine = new Liquid({
    root: [ROOT, path.join(ROOT, '_includes'), path.join(ROOT, '_layouts')],
    extname: '.html',
    dynamicPartials: false,
    strictVariables: false,
    strictFilters: false,
    relativeReference: false,
    jekyllInclude: true,
    fs: {
        readFileSync: (filepath) => {
            let content = fs.readFileSync(filepath, 'utf8');
            return cleanLiquidComments(content);
        },
        readFile: async (filepath) => {
            let content = await fs.promises.readFile(filepath, 'utf8');
            return cleanLiquidComments(content);
        },
        existsSync: (filepath) => fs.existsSync(filepath),
        exists: async (filepath) => fs.existsSync(filepath),
        resolve: (root, file, ext) => {
            if (path.isAbsolute(file)) return file;
            let full = path.resolve(root, file);
            if (fs.existsSync(full)) return full;
            if (ext && fs.existsSync(full + ext)) return full + ext;
            return full;
        }
    }
});

// Custom Liquid filters
engine.registerFilter('slugify', (v) => {
    if (!v) return '';
    return String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
});
engine.registerFilter('jsonify', (v) => JSON.stringify(v));
engine.registerFilter('markdownify', (v) => md.render(v || ''));
engine.registerFilter('date_to_xmlschema', (v) => new Date(v).toISOString());
engine.registerFilter('date_to_long_string', (v) => new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
engine.registerFilter('date_to_string', (v) => new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }));
engine.registerFilter('group_by', (array, key) => {
    if (!Array.isArray(array)) return [];
    const groups = {};
    for (const item of array) {
        const val = item[key] || '';
        if (!groups[val]) groups[val] = { name: val, items: [] };
        groups[val].items.push(item);
    }
    return Object.values(groups);
});
engine.registerFilter('sort_natural', (array, key) => {
    if (!Array.isArray(array)) return [];
    return [...array].sort((a, b) => {
        const valA = key ? a[key] : a;
        const valB = key ? b[key] : b;
        return String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
    });
});
engine.registerFilter('where', (array, key, value) => {
    if (!Array.isArray(array)) return [];
    return array.filter(item => item[key] == value);
});
engine.registerFilter('where_exp', (array, exp) => {
    if (!Array.isArray(array)) return [];
    return array;
});
engine.registerFilter('find', (array, key, value) => {
    if (!Array.isArray(array)) return null;
    return array.find(item => item[key] == value) || null;
});

// Load _config.yml
let siteConfig = {};
try {
    const configContent = fs.readFileSync(path.join(ROOT, '_config.yml'), 'utf8');
    siteConfig = yaml.load(configContent) || {};
} catch (e) {
    console.error('Error loading _config.yml:', e);
}

// Load _data. Jekyll nests subdirectories (e.g. _data/hacks/since_v7_0.yml
// becomes site.data.hacks.since_v7_0), so recurse instead of only reading the
// top level.
const siteData = {};
function loadDataDir(dir, target) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            target[entry.name] = target[entry.name] || {};
            loadDataDir(fullPath, target[entry.name]);
            continue;
        }
        const ext = path.extname(entry.name);
        const name = path.basename(entry.name, ext);
        try {
            if (ext === '.yml' || ext === '.yaml') {
                target[name] = yaml.load(fs.readFileSync(fullPath, 'utf8'));
            } else if (ext === '.json') {
                target[name] = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            }
        } catch (e) {
            console.error(`Error loading data file ${entry.name}:`, e.message);
        }
    }
}
const dataDir = path.join(ROOT, '_data');
if (fs.existsSync(dataDir)) loadDataDir(dataDir, siteData);

// Live custom jar mapping, so the local preview always reflects download/jars/
try {
    siteData.custom_jars = require('./_scripts/generate-custom-jars.js').scanCustomJars();
} catch (e) {
    console.error('Error scanning custom jars:', e.message);
}

// A handful of legacy URLs are answered by the production host itself with a
// real 301 (or 404) before Jekyll's meta-refresh page is ever reached. The map
// is produced by _scripts/_probe-live-redirects.js so the local preview can
// mirror that hosting layer exactly instead of showing "Redirecting...".
const liveRedirects = {};
try {
    const probeFile = path.join(ROOT, '_scripts', '_live-redirects.json');
    if (fs.existsSync(probeFile)) {
        for (const entry of JSON.parse(fs.readFileSync(probeFile, 'utf8'))) {
            if (entry.status === 200) continue;
            liveRedirects[entry.url.replace(/\/$/, '')] = entry;
        }
    }
} catch (e) {
    console.error('Error loading live redirect map:', e.message);
}

// Jekyll's Utils.slugify (default mode): runs of non-alphanumerics collapse
// into a single hyphen, leading/trailing hyphens are stripped, then downcased.
function slugify(str) {
    return String(str == null ? '' : str)
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
}

// Jekyll derives a document's date from a `date:` field in the front matter,
// otherwise from a leading YYYY-MM-DD in the file name, otherwise the mtime.
function documentDate(attributes, baseName, stat) {
    if (attributes.date) {
        const d = new Date(attributes.date);
        if (!isNaN(d)) return d;
    }
    const m = baseName.match(/^(\d{4})-(\d{2})-(\d{2})-/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return stat.mtime;
}

// Load Collections
function loadCollection(dirName, permalinkPrefix) {
    const dirPath = path.join(ROOT, dirName);
    const items = [];
    if (!fs.existsSync(dirPath)) return items;

    function walk(currDir, relPath = '') {
        const files = fs.readdirSync(currDir);
        for (const file of files) {
            const fullPath = path.join(currDir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                walk(fullPath, path.join(relPath, file));
            } else if (file.endsWith('.md') || file.endsWith('.html')) {
                const raw = fs.readFileSync(fullPath, 'utf8');
                const parsed = matter(raw);
                const baseName = file.replace(/\.(md|html)$/, '');
                const rel = relPath ? relPath.replace(/\\/g, '/') + '/' + baseName : baseName;

                // Jekyll's default collection permalink for a file is
                // :collection/:path/, where :path drops a leading date and
                // slugifies each remaining segment. The updates collection
                // overrides this with :collection/:slug/ in _config.yml, and
                // :slug is the date-stripped, slugified file name.
                const dateStripped = baseName.replace(/^\d{4}-\d{2}-\d{2}-/, '');
                let url;
                if (parsed.attributes.permalink) {
                    url = parsed.attributes.permalink;
                } else if (permalinkPrefix === '/updates/') {
                    url = `${permalinkPrefix}${slugify(dateStripped)}/`;
                } else {
                    // :path keeps the on-disk structure and casing verbatim.
                    url = `${permalinkPrefix}${rel}/`;
                }

                items.push({
                    ...parsed.attributes,
                    // Mirrors the `defaults` block in _config.yml, which assigns
                    // a layout per collection.
                    layout: parsed.attributes.layout || {
                        _updates: 'update',
                        _wiki: 'wiki',
                        _tutorials: 'tutorial',
                        _tutorials_de: 'tutorial',
                        _redirects: 'redirect'
                    }[dirName] || 'default',
                    slug: slugify(dateStripped),
                    url,
                    // Jekyll exposes these on every document/page.
                    path: path.relative(ROOT, fullPath).replace(/\\/g, '/'),
                    id: `/${dirName}/${rel}`,
                    collection: dirName.replace(/^_/, ''),
                    filePath: fullPath,
                    isMarkdown: file.endsWith('.md'),
                    rawBody: parsed.body,
                    content: parsed.body,
                    date: documentDate(parsed.attributes, baseName, stat)
                });
            }
        }
    }
    walk(dirPath);
    return items;
}

const updates = loadCollection('_updates', '/updates/');
// Jekyll sorts a collection by date ascending, so the templates can iterate
// `site.updates reversed` to get newest-first.
updates.sort((a, b) => a.date - b.date);

const wiki = loadCollection('_wiki', '/wiki/');
const tutorials = loadCollection('_tutorials', '/tutorials/');
const tutorials_de = loadCollection('_tutorials_de', '/de/tutorials/');
// `permalink: /:path/` in _config.yml, so /_redirects/1.html -> /1/.
const redirects = loadCollection('_redirects', '/');

const site = {
    ...siteConfig,
    data: siteData,
    updates: updates,
    wiki: wiki,
    tutorials: tutorials,
    tutorials_de: tutorials_de,
    redirects: redirects,
    pages: [],
    time: new Date()
};

// Static Asset Mapping
function sendCleanAsset(res, filePath, contentType) {
    if (!fs.existsSync(filePath)) return res.status(404).send('Not Found');
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/^---[\s\S]*?---\r?\n/, '');
    res.setHeader('Content-Type', contentType);
    res.send(content);
}

app.get(/^\/css\/wi-.*\.css$/, (req, res) => sendCleanAsset(res, path.join(ROOT, 'css', 'wi.css'), 'text/css'));
app.get(/^\/js\/wi-.*\.js$/, (req, res) => sendCleanAsset(res, path.join(ROOT, 'js', 'wi.js'), 'application/javascript'));
app.get('/css/wi.css', (req, res) => sendCleanAsset(res, path.join(ROOT, 'css', 'wi.css'), 'text/css'));
app.get('/js/wi.js', (req, res) => sendCleanAsset(res, path.join(ROOT, 'js', 'wi.js'), 'application/javascript'));

app.use('/css', express.static(path.join(ROOT, 'css')));
app.use('/js', express.static(path.join(ROOT, 'js')));
app.use('/fonts', express.static(path.join(ROOT, 'fonts')));
app.use('/api', express.static(path.join(ROOT, 'api')));
app.use('/favicon.ico', (req, res) => res.sendFile(path.join(ROOT, 'favicon.ico')));
app.use('/favicon-48x48.png', (req, res) => res.sendFile(path.join(ROOT, 'favicon-48x48.png')));
app.use('/favicon-96x96.png', (req, res) => res.sendFile(path.join(ROOT, 'favicon-96x96.png')));
app.use('/apple-touch-icon.png', (req, res) => res.sendFile(path.join(ROOT, 'apple-touch-icon.png')));
app.use('/ads.txt', (req, res) => res.sendFile(path.join(ROOT, 'ads.txt')));

async function renderPage(filePath, reqUrl, customData = {}) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(cleanLiquidComments(raw));
    const pageAttrs = {
        ...parsed.attributes,
        url: reqUrl,
        // Jekyll's page.path is the source path relative to the site root.
        path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        ...(customData.page || {})
    };
    
    // 1. Render markdown or liquid body
    let bodyRendered = await engine.parseAndRender(parsed.body, {
        site,
        page: pageAttrs,
        ...customData
    });

    if (filePath.endsWith('.md')) {
        const protectedBody = protectRawHtml(bodyRendered);
        const prepared = prepareKramdown(protectedBody.text);
        bodyRendered = md.render(prepared.text, { headings: prepared.headings }).replace(
            PLACEHOLDER,
            (_, n) => protectedBody.blocks[Number(n)]
        );
    }

    // 2. Wrap the body in its layout, then that layout's parents, until one
    //    has no `layout` of its own. Layouts can nest several levels deep
    //    (e.g. update -> update_base -> default).
    let rendered = bodyRendered;
    let layoutName = pageAttrs.layout || 'default';
    const seen = new Set();

    while (layoutName && layoutName !== 'none' && layoutName !== false) {
        if (seen.has(layoutName)) {
            console.warn(`Layout loop detected at "${layoutName}"`);
            break;
        }
        seen.add(layoutName);

        const layoutFile = path.join(ROOT, '_layouts', `${layoutName}.html`);
        if (!fs.existsSync(layoutFile))
            break;

        const layoutParsed = matter(cleanLiquidComments(fs.readFileSync(layoutFile, 'utf8')));

        // `layout.google_adsense` is read by meta.html, so expose the current
        // layout's own front matter the way Jekyll does.
        rendered = await engine.parseAndRender(layoutParsed.body, {
            site,
            page: pageAttrs,
            layout: layoutParsed.attributes,
            content: rendered,
            ...customData
        });

        layoutName = layoutParsed.attributes.layout;
    }

    return rendered;
}

// Router for all requests
app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let reqPath = req.path;
    if (reqPath.length > 1 && reqPath.endsWith('/')) {
        reqPath = reqPath.slice(0, -1);
    }

    try {
        // 1. Check Root / index
        if (reqPath === '' || reqPath === '/') {
            const html = await renderPage(path.join(ROOT, 'index.html'), '/');
            return res.send(html);
        }

        // 2. Check Collections
        const allCollectionItems = [...updates, ...wiki, ...tutorials, ...tutorials_de, ...redirects];
        const matchedItem = allCollectionItems.find(item => {
            const itemUrl = item.url.replace(/\/$/, '');
            return itemUrl === reqPath || itemUrl === req.path;
        });

        if (matchedItem) {
            const liveRedirect = liveRedirects[matchedItem.url.replace(/\/$/, '')];
            if (liveRedirect && liveRedirect.status >= 300 && liveRedirect.status < 400 && liveRedirect.location) {
                return res.status(liveRedirect.status).set('Location', liveRedirect.location).send();
            }
            if (liveRedirect && liveRedirect.status === 404 && fs.existsSync(path.join(ROOT, '404.html'))) {
                const html = await renderPage(path.join(ROOT, '404.html'), req.path);
                return res.status(404).send(html);
            }

            let layoutName = matchedItem.layout;
            if (!layoutName) {

                // Mirrors the `defaults` block in _config.yml, which assigns a
                // layout per collection.
                if (redirects.includes(matchedItem)) layoutName = 'redirect';
                else if (matchedItem.url.startsWith('/updates/')) layoutName = 'update';
                else if (matchedItem.url.startsWith('/wiki/')) layoutName = 'wiki';
                else if (matchedItem.url.startsWith('/tutorials/') || matchedItem.url.startsWith('/de/tutorials/')) layoutName = 'tutorial';
                else layoutName = 'default';
            }
            // Jekyll renders a document with `page` being that very document
            // object, so identity comparisons like `page != latest` behave.
            // Keep the same reference that lives in site.updates.
            matchedItem.layout = layoutName;
            const html = await renderPage(matchedItem.filePath, matchedItem.url, { page: matchedItem });
            return res.send(html);

        }

        // 3. Check direct files (e.g. /download, /tutorials, /contact.html, /safety.html)
        const candidates = [
            path.join(ROOT, reqPath.slice(1) + '.html'),
            path.join(ROOT, reqPath.slice(1) + '.md'),
            path.join(ROOT, reqPath.slice(1), 'index.html'),
            path.join(ROOT, reqPath.slice(1), 'index.md'),
            path.join(ROOT, reqPath.slice(1))
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                if (candidate.endsWith('.html') || candidate.endsWith('.md')) {
                    const html = await renderPage(candidate, req.path);
                    return res.send(html);
                } else {
                    return res.sendFile(candidate);
                }
            }
        }

        // 4. 404 page
        const notFoundPath = path.join(ROOT, '404.html');
        if (fs.existsSync(notFoundPath)) {
            const html = await renderPage(notFoundPath, req.path);
            return res.status(404).send(html);
        }
        res.status(404).send('Page Not Found');
    } catch (err) {
        console.error('Server error on route:', req.path, err);
        res.status(500).send(`Server Error: ${err.message}<pre>${err.stack}</pre>`);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(` WurstClient.net local server running at:`);
    console.log(` http://localhost:${PORT}`);
    console.log(` http://127.0.0.1:${PORT}`);
    console.log(`======================================================\n`);
});
