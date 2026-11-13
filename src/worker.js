// Donnylol: a keyword search redirector ("g foo" -> Google, "w foo" -> Wikipedia, ...).
//
// Cloudflare Worker in the classic service-worker format, no dependencies, no build step:
// paste this file into the dashboard as is.
//
// Bindings (unchanged from the old webpack build):
//   DONNY_RULES_CACHE  KV namespace. key = rules URL, value = raw YAML text,
//                      metadata = { refresh: <ms timestamp> }, expirationTtl = 3 days.
'use strict'

const STATIC_URL = 'https://raw.githubusercontent.com/swordfeng/donnylol/master/static'
const DEFAULT_RULES_URL = `${STATIC_URL}/rules.yaml`
const RULES_KV_TTL = 86400 * 3 // seconds
const RULES_REFRESH_MS = 86400 * 1000
const RULES_EDGE_CACHE = { cacheTtlByStatus: { '200-299': 86400 * 2, 404: 0, '500-599': 0 } }
const MAX_RULES_BYTES = 1024 * 1024
const MAX_KV_KEY_BYTES = 512
const USER_AGENT = 'donnylol (+https://github.com/swordfeng/donnylol)'

addEventListener('fetch', (event) => {
    event.respondWith(handleEvent(event))
})

async function handleEvent(event) {
    try {
        return await handleRequest(event.request, (promise) => defer(event, promise))
    } catch (e) {
        // Last resort: never let an exception turn into Cloudflare error 1101.
        try { console.error('donnylol: unhandled error', e) } catch (_) { /* ignore */ }
        return textResponse('404: Not Found', 404)
    }
}

function defer(event, promise) {
    const safe = Promise.resolve(promise).catch((e) => console.error('donnylol: background task failed', e))
    try {
        event.waitUntil(safe)
    } catch (_) {
        // no waitUntil (should not happen on Cloudflare); the promise still runs
    }
}

async function handleRequest(request, waitUntil) {
    const url = splitUrl(request.url)
    if (!url) return textResponse('404: Not Found', 404)
    const path = url.path.replace(/\/{2,}/g, '/')

    if (path === '/favicon.ico' || path === '/favicon.jpg') {
        return proxy(`${faviconBase(request)}${path}`)
    }
    if (path === '/') {
        const query = getQueryParam(url.query, 'q')
        const loaded = await loadRules(request, waitUntil)
        if (query && loaded.rules) {
            const redirectUrl = handleQuery(query, loaded.rules)
            if (redirectUrl) return htmlResponse(redirectContent(redirectUrl))
        }
        return htmlResponse(indexContent(request, loaded))
    }
    if (path === '/suggestion') {
        const query = getQueryParam(url.query, 'q')
        if (!query) return textResponse('400: Bad Request', 400)
        const { rules } = await loadRules(request, waitUntil)
        const suggestion = rules ? await handleSuggestion(query, rules) : [query, [], [], []]
        return jsonResponse(suggestion)
    }
    if (path === '/search-plugin.xml') {
        const faviconPath = getQueryParam(url.query, 'favicon_path')
        return new Response(searchPluginContent(url.host, faviconPath), {
            headers: { 'content-type': 'application/opensearchdescription+xml;charset=UTF-8' },
        })
    }
    if (path === '/rules.json') {
        const { rules } = await loadRules(request, waitUntil)
        if (!rules) return textResponse('404: Not Found', 404)
        return jsonResponse(rules)
    }
    if (path === '/sw.js') {
        try {
            const response = await fetch(`${STATIC_URL}/sw.js`)
            const { status, statusText } = response
            return new Response(response.body, {
                status,
                statusText,
                headers: { 'content-type': 'text/javascript;charset=UTF-8' },
            })
        } catch (e) {
            return textResponse('404: Not Found', 404)
        }
    }
    if (path === '/sw.js.map') {
        return proxy(`${STATIC_URL}/sw.js.map`)
    }
    return textResponse('404: Not Found', 404)
}

// ---------------------------------------------------------------- responses

function textResponse(body, status) {
    return new Response(body, { status, headers: { 'content-type': 'text/plain;charset=UTF-8' } })
}

function htmlResponse(body) {
    return new Response(body, { headers: { 'content-type': 'text/html;charset=UTF-8' } })
}

function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json;charset=UTF-8' },
    })
}

async function proxy(target) {
    try {
        return await fetch(target)
    } catch (e) {
        return textResponse('404: Not Found', 404)
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

// ---------------------------------------------------------------- request parsing

// Parsed by hand: the legacy Workers URL implementation (no compatibility date) throws on
// malformed percent-escapes such as "?q=%zz".
function splitUrl(raw) {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(String(raw))
    if (!m) return null
    const authority = m[1]
    return {
        host: authority.slice(authority.lastIndexOf('@') + 1),
        path: m[2] || '/',
        query: m[3] || '',
    }
}

// application/x-www-form-urlencoded value of the first parameter `name`, like
// URLSearchParams.get(): '+' is a space, invalid UTF-8 becomes U+FFFD, never throws.
function getQueryParam(query, name) {
    for (const part of query.split('&')) {
        if (!part) continue
        const eq = part.indexOf('=')
        const key = formDecode(eq === -1 ? part : part.slice(0, eq))
        if (key === name) return formDecode(eq === -1 ? '' : part.slice(eq + 1))
    }
    return null
}

const utf8Decoder = (() => {
    try {
        return new TextDecoder('utf-8', { ignoreBOM: true })
    } catch (e) {
        return new TextDecoder('utf-8')
    }
})()
const utf8Encoder = new TextEncoder()

function isHex(c) {
    return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
}

function formDecode(s) {
    s = s.replace(/\+/g, ' ')
    if (!s.includes('%')) return s
    const input = utf8Encoder.encode(s)
    const out = new Uint8Array(input.length)
    let n = 0
    for (let i = 0; i < input.length; i++) {
        if (input[i] === 0x25 && i + 2 < input.length && isHex(input[i + 1]) && isHex(input[i + 2])) {
            out[n++] = parseInt(String.fromCharCode(input[i + 1], input[i + 2]), 16)
            i += 2
        } else {
            out[n++] = input[i]
        }
    }
    return utf8Decoder.decode(out.subarray(0, n))
}

function safeDecodeURIComponent(s) {
    try {
        return decodeURIComponent(s)
    } catch (e) {
        return s
    }
}

// Last cookie with that name wins (same as before); the value is everything after the first '='.
function getCookie(request, name) {
    let result = ''
    const header = request.headers.get('Cookie')
    if (!header) return result
    for (const cookie of header.split(';')) {
        const eq = cookie.indexOf('=')
        if (eq === -1) continue
        if (cookie.slice(0, eq).trim() === name) result = cookie.slice(eq + 1).trim()
    }
    return result
}

function isHttpUrl(s) {
    try {
        const u = new URL(s)
        return u.protocol === 'https:' || u.protocol === 'http:'
    } catch (e) {
        return false
    }
}

function faviconBase(request) {
    const cookie = getCookie(request, 'favicon_path')
    if (cookie) {
        const base = safeDecodeURIComponent(cookie)
        if (isHttpUrl(`${base}/favicon.ico`)) return base
    }
    return STATIC_URL
}

// ---------------------------------------------------------------- rules loading

const GITHUB_USER_RE = /^[A-Za-z0-9_.-]{1,100}$/
const GIST_ID_RE = /^[A-Za-z0-9]{1,100}$/

function getRulesURL(request) {
    const githubUser = getCookie(request, 'github_user')
    const gistId = getCookie(request, 'gist_id')
    if (
        GITHUB_USER_RE.test(githubUser) && githubUser !== '.' && githubUser !== '..' &&
        GIST_ID_RE.test(gistId)
    ) {
        return `https://gist.githubusercontent.com/${githubUser}/${gistId}/raw`
    }
    return DEFAULT_RULES_URL
}

// Returns { url, text, cached, valid, fallback, rules } where rules is an array or null
// (null only if neither the URL, its KV copy, nor the default rules are usable).
async function loadRules(request, waitUntil) {
    const url = getRulesURL(request)
    const [text, entry] = await Promise.all([fetchRulesText(url), kvGet(url)])
    const cached = entry ? entry.value : null
    const result = { url, text, cached, valid: false, fallback: false, rules: null }

    const fromText = parseRules(text)
    if (fromText) {
        if (cached !== text || isStale(entry)) waitUntil(kvPut(url, text))
        result.valid = true
        result.rules = fromText
        return result
    }
    result.fallback = !!cached
    const fromCache = parseRules(cached)
    if (fromCache) {
        if (isStale(entry)) waitUntil(kvPut(url, cached))
        result.rules = fromCache
        return result
    }
    if (url !== DEFAULT_RULES_URL) {
        const def = await kvGet(DEFAULT_RULES_URL)
        result.rules = parseRules(def && def.value) || parseRules(await fetchRulesText(DEFAULT_RULES_URL))
    }
    return result
}

function parseRules(text) {
    if (typeof text !== 'string' || text === '') return null
    try {
        const rules = parseYaml(text)
        return Array.isArray(rules) ? rules : null
    } catch (e) {
        return null
    }
}

async function fetchRulesText(url) {
    try {
        const response = await fetch(url, { cf: RULES_EDGE_CACHE })
        if (!response.ok) return null
        if (Number(response.headers.get('content-length')) > MAX_RULES_BYTES) return null
        const text = await response.text()
        return text.length > MAX_RULES_BYTES ? null : text
    } catch (e) {
        return null
    }
}

function kvAvailable(key) {
    return typeof DONNY_RULES_CACHE !== 'undefined' && DONNY_RULES_CACHE &&
        utf8Encoder.encode(key).length <= MAX_KV_KEY_BYTES
}

async function kvGet(key) {
    try {
        if (!kvAvailable(key)) return null
        const entry = await DONNY_RULES_CACHE.getWithMetadata(key, { type: 'text' })
        return entry && typeof entry.value === 'string' ? entry : null
    } catch (e) {
        return null
    }
}

async function kvPut(key, text) {
    if (!kvAvailable(key)) return
    await DONNY_RULES_CACHE.put(key, text, {
        expirationTtl: RULES_KV_TTL,
        metadata: { refresh: Date.now() + RULES_REFRESH_MS },
    })
}

function isStale(entry) {
    if (!entry) return false
    const meta = entry.metadata
    return !meta || typeof meta.refresh !== 'number' || meta.refresh < Date.now()
}

// ---------------------------------------------------------------- rule matching

function compileRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null
    const str = (v) => (typeof v === 'string' && v !== '' ? v : null)
    let keywords = []
    if (Array.isArray(rule.keywords)) keywords = rule.keywords.filter((k) => typeof k === 'string')
    else if (typeof rule.keywords === 'string') keywords = [rule.keywords]
    let regex = null
    if (typeof rule.match === 'string' || typeof rule.match === 'number') {
        try {
            regex = new RegExp('^(?:' + rule.match + ')(?=$| )')
        } catch (e) {
            regex = null // invalid pattern: this rule never matches by regex
        }
    }
    return {
        keywords,
        regex,
        catchAll: !rule.keywords && !rule.match,
        search: str(rule.search),
        suggestion: str(rule.suggestion),
        default: str(rule.default),
    }
}

function matchRule(query, rules) {
    const spaceIdx = query.indexOf(' ')
    const keyword = spaceIdx === -1 ? query : query.slice(0, spaceIdx)
    const remainQuery = spaceIdx === -1 ? '' : query.slice(spaceIdx + 1)
    for (const raw of rules) {
        const rule = compileRule(raw)
        if (!rule) continue
        if (rule.keywords.includes(keyword) && ((remainQuery && rule.search) || (!remainQuery && rule.default))) {
            return { rule, keyword, remainQuery }
        }
        if (rule.regex) {
            const match = rule.regex.exec(query)
            if (match) {
                const matchedQuery = query.slice(match[0].length + 1)
                if ((matchedQuery && rule.search) || (!matchedQuery && rule.default)) {
                    return { rule, keyword: match[0], remainQuery: matchedQuery, match }
                }
            }
        }
        if (rule.catchAll && rule.search) {
            return { rule, keyword: '', remainQuery: query }
        }
    }
    return null
}

function handleQuery(query, rules) {
    const ruleMatch = matchRule(query, rules)
    if (!ruleMatch) return null
    const { rule, keyword, remainQuery, match } = ruleMatch
    const template = !remainQuery && rule.default ? rule.default : rule.search
    return replaceUrl(template, keyword, remainQuery, match)
}

async function handleSuggestion(query, rules) {
    const empty = [query, [], [], []]
    const ruleMatch = matchRule(query, rules)
    if (!ruleMatch) return empty
    const { rule, keyword, remainQuery, match } = ruleMatch
    if (!remainQuery || !rule.suggestion) return empty
    const suggestionUrl = replaceUrl(rule.suggestion, keyword, remainQuery, match)
    let result
    try {
        const response = await fetch(suggestionUrl, { headers: { 'User-Agent': USER_AGENT } })
        result = await response.json()
    } catch (e) {
        return empty
    }
    if (!Array.isArray(result) || result[0] !== remainQuery || !Array.isArray(result[1])) return empty
    result[0] = query
    result[1] = result[1].map((suggestion) => (keyword ? `${keyword} ${suggestion}` : `${suggestion}`))
    return result
}

// encodeURIComponent that does not throw on lone surrogates.
function encode(s) {
    return encodeURIComponent(
        String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD'),
    )
}

function replaceUrl(url, keyword, query, match) {
    url = url.replace(/\{keyword\}/g, () => encode(keyword))
    url = url.replace(/\{query\}/g, () => encode(query).replace(/%20/g, '+'))
    if (match) {
        for (let i = 1; i < match.length; i++) {
            url = url.replace(new RegExp(`\\{${i}\\}`, 'g'), () => encode(match[i] === undefined ? '' : match[i]))
        }
    }
    return url
}

// ---------------------------------------------------------------- pages

function redirectContent(url) {
    const js = JSON.stringify(url).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    const attr = url.replaceAll('"', '%22').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return (
        '<html><head><meta name="referrer" content="origin"></head><body>' +
        `<script>window.parent.location.replace(${js});</script>` +
        `<noscript><meta http-equiv="refresh" content="0;URL=${attr}"></noscript>` +
        '</body></html>'
    )
}

function searchPluginContent(host, faviconPath) {
    const h = escapeHtml(host)
    const icons = escapeHtml(faviconPath || `https://${host}`)
    return `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:moz="http://www.mozilla.org/2006/browser/search/">
    <ShortName>donny</ShortName>
    <Description>Donnylol custom search tool</Description>
    <InputEncoding>UTF-8</InputEncoding>
    <Image width="64" height="64" type="image/jpeg">${icons}/favicon.jpg</Image>
    <Image width="16" height="16" type="image/x-icon">${icons}/favicon.ico</Image>
    <Url type="text/html" template="https://${h}/?q={searchTerms}" />
    <Url type="application/x-suggestions+json" template="https://${h}/suggestion?q={searchTerms}"/>
    <moz:SearchForm>https://${h}/</moz:SearchForm>
</OpenSearchDescription>`
}

function indexContent(request, loaded) {
    const { url, text, cached, valid, fallback } = loaded
    const faviconPath = getCookie(request, 'favicon_path')
    const pluginHref = '/search-plugin.xml' + (faviconPath ? '?favicon_path=' + faviconPath : '')
    const shown = fallback ? cached : text
    return `<!doctype html>
<html>
    <head>
        <meta charset="UTF-8">
        <title>Donnylol</title>
        <link rel="search"
                type="application/opensearchdescription+xml"
                title="donny"
                href="${escapeHtml(pluginHref)}">
    </head>
    <body>
        <h1>MAKE SEARCH GREAT AGAIN!</h1>
        <p>Current rules URL: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
        <p>Valid: ${valid}</p>
        <p>Fallback to cache: ${fallback}</p>
        <p>Set another rule: https://gist.github.com/
            <input type="text" id="github_user" style="min-width: 8ch; width: 0ch;">
            /
            <input type="text" id="gist_id" style="width: 32ch;">
            <input type="button" id="set" value="Set">
            <input type="button" id="reset" value="Reset">
        </p>
        <p>Favicon path:
            <input type="text" id="favicon_path" style="min-width: 8ch; width: 0ch;">
            /favicon.{ico,jpg}
            <input type="button" id="icon_set" value="Set">
            <input type="button" id="icon_reset" value="Reset">
        </p>
        <p>Would like to share your rules? Post issues / pull requests to <a href="https://github.com/swordfeng/donnylol">DonnyLOL</a>.</p>
        <p>Rules:</p>
        <pre id="rules">${escapeHtml(shown == null ? '' : shown)}</pre>
        <script>
            const github_user_input = document.getElementById('github_user')
            const gist_id_input = document.getElementById('gist_id')
            const set_button = document.getElementById('set')
            const reset_button = document.getElementById('reset')
            const favicon_path_input = document.getElementById('favicon_path')
            const icon_set_button = document.getElementById('icon_set')
            const icon_reset_button = document.getElementById('icon_reset')

            github_user_input.addEventListener('input', () => {
                github_user_input.style.width = github_user_input.value.length + 'ch'
            })
            set_button.addEventListener('click', () => {
                const expiration_date = new Date();
                expiration_date.setFullYear(expiration_date.getFullYear() + 100);
                document.cookie = 'github_user=' + github_user_input.value + '; path=/; expires=' + expiration_date.toUTCString()
                document.cookie = 'gist_id=' + gist_id_input.value + '; path=/; expires=' + expiration_date.toUTCString()
                location.reload()
            })
            reset_button.addEventListener('click', () => {
                document.cookie = 'github_user=; expires=Thu, 01 Jan 1970 00:00:00 UTC'
                document.cookie = 'gist_id=; expires=Thu, 01 Jan 1970 00:00:00 UTC'
                location.reload()
            })

            for (let ca of document.cookie.split(';')) {
                ca = ca.trim()
                const name = 'favicon_path='
                if (ca.startsWith(name)) {
                    favicon_path_input.value = decodeURIComponent(ca.substring(name.length))
                }
            }
            icon_set_button.addEventListener('click', () => {
                const expiration_date = new Date();
                expiration_date.setFullYear(expiration_date.getFullYear() + 100);
                document.cookie = 'favicon_path=' + encodeURIComponent(favicon_path_input.value) + '; path=/; expires=' + expiration_date.toUTCString()
                location.reload()
            })
            icon_reset_button.addEventListener('click', () => {
                document.cookie = 'favicon_path=; expires=Thu, 01 Jan 1970 00:00:00 UTC'
                location.reload()
            })

            if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                    navigator.serviceWorker.register('/sw.js')
                    .catch(err => {
                        console.log('ServiceWorker registration failed: ', err)
                    })
                    navigator.serviceWorker.ready
                    .then(registration => registration.sync.register('sync-rules'))
                    .catch(err => {
                        console.log('Failed to sync: ', err)
                    })
                })
            }
        </script>
    </body>
</html>`
}

// ---------------------------------------------------------------- YAML subset parser
//
// Replaces the `yaml` npm package. Supports what rule files use: block mappings and
// sequences, flow [..] / {..} (also across lines), plain / 'single' / "double" quoted
// scalars with escapes and line folding, | and > block scalars, comments, a leading
// "---", and YAML 1.2 core-schema scalars (null, booleans, numbers). JSON is accepted.
// Not supported (throws, so the rules count as invalid): anchors/aliases, tags,
// complex keys, multiple documents, tabs as indentation.

class YamlError extends Error {}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

function defineKey(obj, key, value) {
    // defineProperty so that a "__proto__" key is stored as data, never as a prototype.
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

function parseYaml(src) {
    src = String(src).replace(/^\uFEFF/, '')
    const t = src.trim()
    if (t[0] === '[' || t[0] === '{') {
        try {
            return JSON.parse(t)
        } catch (e) {
            // not JSON, parse as YAML flow
        }
    }
    return new YamlParser(src).parseDocument()
}

function resolvePlain(s) {
    if (/^(?:~|null|Null|NULL)?$/.test(s)) return null
    if (/^(?:true|True|TRUE)$/.test(s)) return true
    if (/^(?:false|False|FALSE)$/.test(s)) return false
    if (/^[-+]?[0-9]+$/.test(s)) return Number(s)
    if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8)
    if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16)
    if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(s)) return Number(s)
    if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity
    if (/^\.(?:nan|NaN|NAN)$/.test(s)) return NaN
    return s
}

const isSpace = (c) => c === ' ' || c === '\t'
const isSeqEntry = (text) => text[0] === '-' && (text.length === 1 || isSpace(text[1]))
const isDocMarker = (line) => /^(?:---|\.\.\.)(?:[ \t]|$)/.test(line)
const isBlankLine = (line) => /^[ \t]*(?:#.*)?$/.test(line)
const indentOf = (line) => {
    let n = 0
    while (line[n] === ' ') n++
    return n
}

// Strips a trailing comment (a '#' at the start or preceded by whitespace).
function stripComment(s) {
    for (let j = 0; j < s.length; j++) {
        if (s[j] === '#' && (j === 0 || isSpace(s[j - 1]))) return s.slice(0, j)
    }
    return s
}

// Reads characters across lines; '\n' between lines, '' at the end of input.
class YamlCursor {
    constructor(lines, li, col) {
        this.lines = lines
        this.li = li
        this.col = col
    }
    at(off = 0) {
        const line = this.lines[this.li]
        const p = this.col + off
        if (p < line.length) return line[p]
        return p === line.length && this.li + 1 < this.lines.length ? '\n' : ''
    }
    adv() {
        if (this.col < this.lines[this.li].length) this.col++
        else if (this.li + 1 < this.lines.length) {
            this.li++
            this.col = 0
        }
    }
    prev() {
        return this.col > 0 ? this.lines[this.li][this.col - 1] : '\n'
    }
}

class YamlParser {
    constructor(src) {
        this.lines = src.split(/\r\n|\r|\n/)
        this.i = 0
        this.depth = 0
    }

    fail(msg) {
        throw new YamlError(`YAML line ${this.i + 1}: ${msg}`)
    }

    enter() {
        if (++this.depth > 100) this.fail('nested too deeply')
    }

    skipBlank() {
        while (this.i < this.lines.length && isBlankLine(this.lines[this.i])) this.i++
    }

    // Next content line in the current document, or null.
    peek() {
        this.skipBlank()
        if (this.i >= this.lines.length) return null
        const line = this.lines[this.i]
        if (isDocMarker(line)) return null
        const indent = indentOf(line)
        if (line[indent] === '\t') this.fail('tabs are not allowed for indentation')
        return { indent, text: line.slice(indent) }
    }

    parseDocument() {
        this.skipBlank()
        if (this.i < this.lines.length && this.lines[this.i][0] === '%') this.fail('directives are not supported')
        if (this.i < this.lines.length && /^---(?:[ \t]|$)/.test(this.lines[this.i])) {
            this.lines[this.i] = '    ' + this.lines[this.i].slice(3).replace(/^[ \t]+/, '')
            if (isBlankLine(this.lines[this.i])) this.i++
        }
        const value = this.parseBlock(-1)
        this.skipBlank()
        if (this.i < this.lines.length && /^\.\.\.(?:[ \t]|$)/.test(this.lines[this.i])) {
            this.i++
            this.skipBlank()
        }
        if (this.i < this.lines.length) this.fail('unexpected content (multiple documents are not supported)')
        return value
    }

    // A node more indented than `parent`, or null if there is none.
    parseBlock(parent) {
        const cur = this.peek()
        if (!cur || cur.indent <= parent) return null
        this.enter()
        try {
            if (isSeqEntry(cur.text)) return this.parseSeq(cur.indent)
            if (this.readKey(this.i, cur.indent)) return this.parseMap(cur.indent)
            return this.parseValue(this.i, cur.indent, parent)
        } finally {
            this.depth--
        }
    }

    parseSeq(indent) {
        const arr = []
        for (;;) {
            const cur = this.peek()
            if (!cur || cur.indent < indent) break
            if (cur.indent > indent) this.fail('bad indentation of a sequence entry')
            if (!isSeqEntry(cur.text)) break
            const line = this.lines[this.i]
            let col = indent + 1
            while (isSpace(line[col])) col++
            if (col >= line.length || line[col] === '#') {
                this.i++
                arr.push(this.parseBlock(indent))
            } else {
                // "- foo: bar": re-read the rest of the line as if it started at `col`.
                this.lines[this.i] = ' '.repeat(col) + line.slice(col)
                arr.push(this.parseBlock(indent))
            }
        }
        return arr
    }

    parseMap(indent) {
        const obj = {}
        for (;;) {
            const cur = this.peek()
            if (!cur || cur.indent < indent) break
            if (cur.indent > indent) this.fail('bad indentation of a mapping entry')
            if (isSeqEntry(cur.text)) break
            const key = this.readKey(this.i, indent)
            if (!key) this.fail('expected a mapping key')
            if (hasOwn(obj, key.key)) this.fail(`duplicate key "${key.key}"`)
            defineKey(obj, key.key, this.parseEntryValue(this.i, key.valueCol, indent))
        }
        return obj
    }

    // "key:" at (li, col) -> { key, valueCol } or null.
    readKey(li, col) {
        const line = this.lines[li]
        const c = line[col]
        let key
        let j
        if (c === '"' || c === "'") {
            const cur = new YamlCursor(this.lines, li, col)
            try {
                key = this.readQuoted(cur)
            } catch (e) {
                return null
            }
            if (cur.li !== li) return null
            j = cur.col
            while (isSpace(line[j])) j++
            if (line[j] !== ':' || !(j + 1 === line.length || isSpace(line[j + 1]))) return null
        } else {
            if (c === '[' || c === '{') return null
            if (c === '?' && (col + 1 === line.length || isSpace(line[col + 1]))) this.fail('complex keys are not supported')
            for (j = col; j < line.length; j++) {
                if (line[j] === '#' && j > col && isSpace(line[j - 1])) return null
                if (line[j] === ':' && (j + 1 === line.length || isSpace(line[j + 1]))) break
            }
            if (j >= line.length) return null
            key = line.slice(col, j).replace(/[ \t]+$/, '')
            if (key === '') this.fail('empty mapping key')
            if ('&*!|>%@`'.includes(key[0])) this.fail(`unsupported YAML feature "${key[0]}"`)
        }
        return { key, valueCol: j + 1 }
    }

    // Value of a mapping entry whose text continues at (li, col).
    parseEntryValue(li, col, indent) {
        const line = this.lines[li]
        let j = col
        while (isSpace(line[j])) j++
        if (j < line.length && line[j] !== '#') return this.parseValue(li, j, indent)
        this.i = li + 1
        const next = this.peek()
        if (!next) return null
        if (next.indent > indent) return this.parseBlock(indent)
        if (next.indent === indent && isSeqEntry(next.text)) return this.parseSeq(indent)
        return null
    }

    // Scalar or flow collection starting at (li, col), inside a node indented by `parent`.
    parseValue(li, col, parent) {
        this.i = li
        const line = this.lines[li]
        const c = line[col]
        if (c === '|' || c === '>') return this.readBlockScalar(li, col, parent)
        if (c === '[' || c === '{' || c === '"' || c === "'") {
            const cur = new YamlCursor(this.lines, li, col)
            const value = c === '[' || c === '{' ? this.readFlow(cur) : this.readQuoted(cur)
            const rest = this.lines[cur.li].slice(cur.col)
            if (!/^(?:[ \t]+#.*|[ \t]*)$/.test(rest)) {
                this.i = cur.li
                this.fail('unexpected characters after a value')
            }
            this.i = cur.li + 1
            return value
        }
        if ('&*!%@`'.includes(c)) this.fail(`unsupported YAML feature "${c}"`)
        if ((c === '?' || c === '-') && (col + 1 === line.length || isSpace(line[col + 1]))) {
            this.fail('unexpected indicator')
        }
        const raw = line.slice(col)
        const uncommented = stripComment(raw)
        const commented = uncommented !== raw
        let s = uncommented.replace(/[ \t]+$/, '')
        if (/:(?:[ \t]|$)/.test(s)) this.fail('unexpected mapping value')
        this.i = li + 1
        // Multi-line plain scalar: more-indented lines are folded into it.
        let newlines = 0
        while (!commented && this.i < this.lines.length) {
            const l = this.lines[this.i]
            if (/^[ \t]*$/.test(l)) {
                newlines++
                this.i++
                continue
            }
            if (indentOf(l) <= parent || isDocMarker(l)) break
            const t = l.trim()
            if (t[0] === '#') break
            const part = stripComment(t).replace(/[ \t]+$/, '')
            if (/:(?:[ \t]|$)/.test(part)) this.fail('unexpected mapping value')
            s += newlines ? '\n'.repeat(newlines) : ' '
            s += part
            newlines = 0
            this.i++
            if (part.length !== t.length) break
        }
        return resolvePlain(s)
    }

    readBlockScalar(li, col, parent) {
        const m = /^([|>])([+-]?)([1-9]?)([+-]?)(?:[ \t]+#.*|[ \t]*)$/.exec(this.lines[li].slice(col))
        if (!m || (m[2] && m[4])) this.fail('bad block scalar header')
        const folded = m[1] === '>'
        const chomp = m[2] || m[4]
        const base = Math.max(parent, 0)
        let contentIndent = m[3] ? base + Number(m[3]) : -1
        let k = li + 1
        if (contentIndent < 0) {
            for (let t = k; t < this.lines.length; t++) {
                if (/^[ \t]*$/.test(this.lines[t])) continue
                contentIndent = indentOf(this.lines[t])
                break
            }
            if (contentIndent <= parent) contentIndent = parent + 1
        }
        const out = [] // null = empty line
        for (; k < this.lines.length; k++) {
            const l = this.lines[k]
            if (/^ *$/.test(l)) {
                out.push(l.length > contentIndent ? l.slice(contentIndent) : null)
                continue
            }
            if (indentOf(l) < contentIndent) break
            out.push(l.slice(contentIndent))
        }
        this.i = k
        let result = ''
        let empty = 0
        let didRead = false
        let atMore = false
        for (const l of out) {
            if (l === null) {
                empty++
                continue
            }
            if (folded) {
                if (isSpace(l[0])) {
                    atMore = true
                    result += '\n'.repeat(didRead ? 1 + empty : empty)
                } else if (atMore) {
                    atMore = false
                    result += '\n'.repeat(empty + 1)
                } else if (empty === 0) {
                    if (didRead) result += ' '
                } else {
                    result += '\n'.repeat(empty)
                }
            } else {
                result += '\n'.repeat(didRead ? 1 + empty : empty)
            }
            result += l
            didRead = true
            empty = 0
        }
        if (chomp === '+') result += '\n'.repeat(didRead ? 1 + empty : empty)
        else if (chomp !== '-' && didRead) result += '\n'
        return result
    }

    readQuoted(cur) {
        const q = cur.at()
        cur.adv()
        let out = ''
        let keep = 0 // length of `out` without trailing unescaped whitespace
        for (;;) {
            const c = cur.at()
            if (c === '') {
                this.i = cur.li
                this.fail('unterminated quoted string')
            }
            if (c === q) {
                if (q === "'" && cur.at(1) === "'") {
                    out += "'"
                    keep = out.length
                    cur.adv()
                    cur.adv()
                    continue
                }
                cur.adv()
                return out
            }
            if (c === '\n') {
                out = out.slice(0, keep)
                let breaks = 0
                cur.adv()
                for (;;) {
                    while (isSpace(cur.at())) cur.adv()
                    if (cur.at() !== '\n') break
                    breaks++
                    cur.adv()
                }
                out += breaks ? '\n'.repeat(breaks) : ' '
                keep = out.length
                continue
            }
            if (q === '"' && c === '\\') {
                cur.adv()
                const e = cur.at()
                if (e === '\n') {
                    cur.adv()
                    while (isSpace(cur.at())) cur.adv()
                    keep = out.length
                    continue
                }
                const simple = {
                    0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r',
                    e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0',
                    L: '\u2028', P: '\u2029',
                }
                if (hasOwn(simple, e)) {
                    out += simple[e]
                    cur.adv()
                } else {
                    const len = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0
                    if (!len) this.fail(`bad escape "\\${e}"`)
                    cur.adv()
                    let hex = ''
                    for (let n = 0; n < len; n++) {
                        hex += cur.at()
                        cur.adv()
                    }
                    const cp = /^[0-9a-fA-F]+$/.test(hex) && hex.length === len ? parseInt(hex, 16) : -1
                    if (cp < 0 || cp > 0x10ffff) this.fail('bad escape')
                    out += String.fromCodePoint(cp)
                }
                keep = out.length
                continue
            }
            out += c
            cur.adv()
            if (!isSpace(c)) keep = out.length
        }
    }

    skipFlowSpace(cur) {
        for (;;) {
            const c = cur.at()
            if (c === ' ' || c === '\t' || c === '\n') cur.adv()
            else if (c === '#' && (isSpace(cur.prev()) || cur.prev() === '\n')) cur.col = this.lines[cur.li].length
            else return
        }
    }

    readFlow(cur) {
        this.enter()
        try {
            return this.readFlowNode(cur)
        } finally {
            this.depth--
        }
    }

    flowKey(value) {
        return value === null ? '' : String(value)
    }

    readFlowNode(cur) {
        const c = cur.at()
        if (c === '[' || c === '{') {
            this.enter()
            const isSeq = c === '['
            const close = isSeq ? ']' : '}'
            const coll = isSeq ? [] : {}
            cur.adv()
            for (;;) {
                this.skipFlowSpace(cur)
                if (cur.at() === close) {
                    cur.adv()
                    this.depth--
                    return coll
                }
                const first = this.readFlowNode(cur)
                this.skipFlowSpace(cur)
                let value = first
                let pair = false
                if (cur.at() === ':') {
                    pair = true
                    cur.adv()
                    this.skipFlowSpace(cur)
                    value = cur.at() === ',' || cur.at() === close ? null : this.readFlowNode(cur)
                    this.skipFlowSpace(cur)
                }
                if (isSeq) {
                    if (pair) {
                        const single = {}
                        defineKey(single, this.flowKey(first), value)
                        coll.push(single)
                    } else coll.push(first)
                } else {
                    const key = this.flowKey(first)
                    if (hasOwn(coll, key)) this.fail(`duplicate key "${key}"`)
                    defineKey(coll, key, pair ? value : null)
                }
                if (cur.at() === ',') cur.adv()
                else if (cur.at() !== close) {
                    this.i = cur.li
                    this.fail(cur.at() === '' ? 'unterminated flow collection' : `expected "," or "${close}"`)
                }
            }
        }
        if (c === '"' || c === "'") return this.readQuoted(cur)
        if (c === '') this.fail('unexpected end of input')
        if (',]}'.includes(c)) this.fail(`unexpected "${c}"`)
        if ('&*!|>%@`'.includes(c)) this.fail(`unsupported YAML feature "${c}"`)
        let s = ''
        for (;;) {
            const ch = cur.at()
            if (ch === '' || ch === '\n' || ',[]{}'.includes(ch)) break
            if (ch === ':' && /^(?:[ \t\n,[\]{}])?$/.test(cur.at(1))) break
            if (ch === '#' && isSpace(s.slice(-1))) break
            s += ch
            cur.adv()
        }
        s = s.trim()
        if (s === '') this.fail('empty value in flow collection')
        return resolvePlain(s)
    }
}
