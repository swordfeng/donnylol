// Run: node --test   (no npm install needed)
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ORIGIN = 'https://donny.taiho.moe'
const STATIC = 'https://raw.githubusercontent.com/swordfeng/donnylol/master/static'
const DEFAULT_RULES = `${STATIC}/rules.yaml`
const GIST = 'https://gist.githubusercontent.com/alice/0123abcd/raw'
const RULES_YAML = readFileSync(new URL('./fixtures/rules.yaml', import.meta.url), 'utf8')
// What the old worker (npm `yaml`) served on /rules.json for that file.
const RULES_JSON = JSON.parse(readFileSync(new URL('./fixtures/rules.json', import.meta.url), 'utf8'))

// ---------------------------------------------------------------- mocks

function makeKV() {
    const store = new Map()
    const convert = (value, opts) => {
        const type = typeof opts === 'string' ? opts : (opts && opts.type) || 'text'
        if (type === 'text') return value
        if (type === 'json') return JSON.parse(value)
        if (type === 'arrayBuffer') return new TextEncoder().encode(value).buffer
        if (type === 'stream') return new Response(value).body
        throw new TypeError(`bad type ${type}`)
    }
    const live = (key) => {
        const e = store.get(key)
        if (e && e.expires !== null && e.expires <= Date.now()) {
            store.delete(key)
            return null
        }
        return e || null
    }
    return {
        store,
        puts: [],
        failGet: false,
        failPut: false,
        async get(key, opts) {
            if (this.failGet) throw new Error('KV GET failed: 500')
            const e = live(key)
            return e ? convert(e.value, opts) : null
        },
        async getWithMetadata(key, opts) {
            if (this.failGet) throw new Error('KV GET failed: 500')
            const e = live(key)
            return { value: e ? convert(e.value, opts) : null, metadata: e ? e.metadata : null }
        },
        async put(key, value, opts = {}) {
            if (this.failPut) throw new Error('KV PUT failed: 429 Too Many Requests')
            if (new TextEncoder().encode(key).length > 512) throw new Error('KV key too long')
            if (typeof value !== 'string') throw new TypeError('value must be a string here')
            if (opts.expirationTtl !== undefined && !(opts.expirationTtl >= 60)) throw new Error('bad expirationTtl')
            this.puts.push({ key, value, opts })
            store.set(key, {
                value,
                metadata: opts.metadata === undefined ? null : structuredClone(opts.metadata),
                expires: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null,
            })
        },
        seed(key, value, metadata = { refresh: Date.now() + 3600_000 }) {
            store.set(key, { value, metadata, expires: null })
        },
    }
}

let handler
let calls // [{ url, init, headers }]
let upstream // url -> string | Response | (req) => Response | Error
let kv

const ctx = vm.createContext({
    URL, Request, Response, Headers, TextEncoder, TextDecoder, structuredClone,
    console: { log() {}, error() {}, warn() {} },
    addEventListener: (type, fn) => {
        assert.equal(type, 'fetch')
        handler = fn
    },
    fetch: async (input, init) => {
        const req = new Request(input, init)
        calls.push({ url: req.url, init, headers: req.headers })
        const r = upstream.get(req.url)
        if (r === undefined) return new Response('404: Not Found', { status: 404 })
        if (r instanceof Error) throw r
        if (typeof r === 'function') return r(req)
        if (r instanceof Response) return r.clone()
        return new Response(r)
    },
})
vm.runInContext(readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8'), ctx, { filename: 'worker.js' })

async function dispatchEvent(event) {
    let response
    const waits = []
    handler({ ...event, respondWith: (p) => { response = p }, waitUntil: (p) => { waits.push(p) } })
    assert.ok(response, 'respondWith was called synchronously')
    const r = await response
    await Promise.all(waits)
    return r
}

function get(path, { cookie, method = 'GET' } = {}) {
    const headers = cookie ? { Cookie: cookie } : {}
    return dispatchEvent({ request: new Request(`${ORIGIN}${path}`, { method, headers }) })
}

const q = (s) => `/?q=${encodeURIComponent(s)}`

// Target of the redirect page, or null if the page is not a redirect.
async function redirectTarget(response) {
    assert.equal(response.status, 200)
    const html = await response.text()
    const m = /window\.parent\.location\.replace\((".*?")\);<\/script>/.exec(html)
    return m ? JSON.parse(m[1]) : null
}

beforeEach(() => {
    calls = []
    upstream = new Map([[DEFAULT_RULES, RULES_YAML]])
    kv = makeKV()
    ctx.DONNY_RULES_CACHE = kv
})

// ---------------------------------------------------------------- YAML

test('YAML: default rules parse exactly like the npm yaml package did', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.parseYaml(RULES_YAML))), RULES_JSON)
    assert.ok(Array.isArray(ctx.parseYaml(readFileSync(new URL('../static/rules.yaml', import.meta.url), 'utf8'))))
})

test('YAML: supported syntax', () => {
    const p = (s) => JSON.parse(JSON.stringify(ctx.parseYaml(s)))
    assert.deepEqual(p(`
--- # doc start
- keywords: [a, "b", 'c''d']   # comment
  search: https://x.test/?q={query}#frag
- {keywords: [e], default: "http://e.test/"}
- match: "(x)\\\\d+\\t\\u00e9\\x41\\"\\/"
- keywords:
  - f
  -   g
  search: >-
    folded
    text

    para
  default: |
    line1
      line2
- nested:
    - - 1
      - 2.5
    - k: ~
      t: true
      n: null
      o: 0x1F
      s: '0x1F'
- multi: "a
    b

    c"
- plain: one
    two
- [x,
   y, {z: 1},
  ]
`), [
        { keywords: ['a', 'b', "c'd"], search: 'https://x.test/?q={query}#frag' },
        { keywords: ['e'], default: 'http://e.test/' },
        { match: '(x)\\d+\t\u00e9A"/' },
        { keywords: ['f', 'g'], search: 'folded text\npara', default: 'line1\n  line2\n' },
        { nested: [[1, 2.5], { k: null, t: true, n: null, o: 31, s: '0x1F' }] },
        { multi: 'a b\nc' },
        { plain: 'one two' },
        ['x', 'y', { z: 1 }],
    ])
    assert.deepEqual(p('[{"keywords": ["g"], "search": "https://g/?q={query}"}]'), [{ keywords: ['g'], search: 'https://g/?q={query}' }])
    assert.deepEqual(p('\uFEFFa: 1\r\nb:\r\n- x\r\n'), { a: 1, b: ['x'] })
    assert.equal(ctx.parseYaml(''), null)
    assert.equal(ctx.parseYaml('# only a comment\n'), null)
    assert.equal(ctx.parseYaml('just text'), 'just text')
    assert.deepEqual(p('a: 1\n - b\n'), { a: '1 - b' })
    const proto = ctx.parseYaml('__proto__: {polluted: 1}\n')
    assert.equal(Object.getPrototypeOf(proto), vm.runInContext('Object.prototype', ctx))
    assert.equal(proto.polluted, undefined)
    assert.deepEqual(Object.keys(proto), ['__proto__'])
})

test('YAML: malformed or unsupported input throws instead of guessing', () => {
    for (const bad of [
        'a: 1\na: 2',
        '- a: &x 1\n- b: *x',
        '- !!str foo',
        'a:\n\t- b',
        '"unterminated',
        '[a, b',
        '{a: 1',
        'a: b: c',
        '- a\nb: c',
        'a: "x" y',
        '? complex\n: key',
        '- "\\q"',
        'a: 1\n---\nb: 2',
        '['.repeat(500) + 'a' + ']'.repeat(500), // too deep (not JSON, so the YAML parser sees it)
    ]) {
        assert.throws(() => ctx.parseYaml(bad), undefined, JSON.stringify(bad))
    }
})

// ---------------------------------------------------------------- redirects

test('queries redirect like before', async () => {
    const cases = [
        ['g hello world', 'https://www.google.com/search?q=hello+world'],
        ['g', 'https://www.google.com/'],
        ['gh', 'https://github.com/'],
        ['ddg c++ & co', 'https://duckduckgo.com/?q=c%2B%2B+%26+co'],
        ['wikien Tokyo', 'https://en.wikipedia.org/wiki/Special:Search?search=Tokyo'],
        ['wikija', 'https://ja.wikipedia.org/'],
        ['r/rust async', 'https://www.reddit.com/r/rust/search?q=async'],
        ['r/rust', 'https://www.reddit.com/r/rust/'],
        ['BV1xx411c79H', 'https://www.bilibili.com/video/BV1xx411c79H'],
        ['!w tokyo', 'https://duckduckgo.com/?q=!w+tokyo'],
        ['rsdocs serde Value', 'https://docs.rs/serde/latest/?search=Value'],
        ['rsdocs serde', 'https://docs.rs/releases/search?query=serde'],
        ['cups', 'http://localhost:631/'],
        ['unknown words', 'https://www.google.com/search?q=unknown+words'],
        ['BV1xx411c79H extra', 'https://www.google.com/search?q=BV1xx411c79H+extra'],
        ['中文 搜索', 'https://www.google.com/search?q=%E4%B8%AD%E6%96%87+%E6%90%9C%E7%B4%A2'],
    ]
    for (const [query, want] of cases) {
        assert.equal(await redirectTarget(await get(q(query))), want, query)
    }
    // '+' in the raw query string is a space, as with URLSearchParams.
    assert.equal(await redirectTarget(await get('/?q=g+a%2Bb')), 'https://www.google.com/search?q=a%2Bb')
    const html = await (await get(q('g x'))).text()
    assert.match(html, /<meta name="referrer" content="origin">/)
    assert.match(html, /<noscript><meta http-equiv="refresh" content="0;URL=https:\/\/www.google.com\/search\?q=x"><\/noscript>/)
})

test('malformed query strings no longer cause error 1101', async () => {
    for (const path of ['/?q=%zz', '/?q=%E0%A4%A', '/?q=%ED%A0%80', '/?q=%', '/?q=g%20%FF%FE', '/?q=%2', '/?=x&q', '/?&&q=g%20a&q=b', '/?q=%F0%9F%98']) {
        const r = await get(path)
        assert.equal(r.status, 200, path)
        await r.text()
    }
    assert.equal(await redirectTarget(await get('/?q=%zz')), 'https://www.google.com/search?q=%25zz')
    assert.equal(await redirectTarget(await get('/?q=g%20%FF')), 'https://www.google.com/search?q=%EF%BF%BD')
    assert.equal(await redirectTarget(await get('/?&&q=g%20a&q=b')), 'https://www.google.com/search?q=a', 'first q wins')
})

test('index page without a query; empty q shows the index too', async () => {
    for (const path of ['/', '/?q=', '/?x=1']) {
        const r = await get(path)
        assert.equal(r.status, 200)
        assert.equal(r.headers.get('content-type'), 'text/html;charset=UTF-8')
        const html = await r.text()
        assert.match(html, /<h1>MAKE SEARCH GREAT AGAIN!<\/h1>/)
        assert.match(html, /Current rules URL: <a href="https:\/\/raw.githubusercontent.com\/swordfeng\/donnylol\/master\/static\/rules.yaml">/)
        assert.match(html, /<p>Valid: true<\/p>\s*<p>Fallback to cache: false<\/p>/)
        assert.ok(html.includes('# search engines\n- keywords: [&#34;g&#34;]'), 'rules shown, HTML-escaped')
        assert.match(html, /href="\/search-plugin.xml">/)
    }
})

test('redirect page cannot be broken out of by rule templates', async () => {
    upstream.set(DEFAULT_RULES, `- keywords: [x]\n  search: "https://e.test/</script><script>alert(1)</script>?q={query}&\\"a=\\u2028"\n`)
    const html = await (await get(q('x y'))).text()
    assert.ok(!html.includes('</script><script>alert'), html)
    assert.equal(await redirectTarget(await get(q('x y'))), 'https://e.test/</script><script>alert(1)</script>?q=y&"a=\u2028')
    assert.match(html, /content="0;URL=https:\/\/e.test\/&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;\?q=y&amp;%22a=/)
})

// ---------------------------------------------------------------- bad rules

test('broken rule entries are skipped instead of crashing', async () => {
    upstream.set(DEFAULT_RULES, `
- null
- 42
- [nested, list]
- keywords: [bad]
  match: "(unclosed"
  search: https://bad.test/{query}
- match: "(unclosed"
  search: https://never.test/{query}
- keywords: [num]
  search: 12345
  default: https://num.test/
- keywords: str
  search: https://str.test/?q={query}
- match: "opt(-(\\\\d+))?"
  search: https://opt.test/{2}/{query}
  default: https://opt.test/{2}
- keywords: [x]
  default: https://x.test/
- default: https://catch-all-without-search.test/
- keywords: [last]
  search: https://last.test/?q={query}
`)
    assert.equal(await redirectTarget(await get(q('bad thing'))), 'https://bad.test/thing', 'keywords still work when match is invalid')
    assert.equal(await redirectTarget(await get(q('num 1'))), null, 'non-string search is ignored')
    assert.equal(await redirectTarget(await get(q('num'))), 'https://num.test/')
    assert.equal(await redirectTarget(await get(q('str a'))), 'https://str.test/?q=a', 'keywords as a single string')
    assert.equal(await redirectTarget(await get(q('s a'))), null, 'no substring match on a string keyword')
    assert.equal(await redirectTarget(await get(q('opt'))), 'https://opt.test/', 'missing group is empty, not "undefined"')
    assert.equal(await redirectTarget(await get(q('opt-7 a'))), 'https://opt.test/7/a')
    assert.equal(await redirectTarget(await get(q('x y'))), null, 'catch-all without search no longer crashes')
    assert.equal(await redirectTarget(await get(q('last z'))), 'https://last.test/?q=z')
    assert.equal((await get('/suggestion?q=x%20y')).status, 200)
})

test('rules that are not a list count as invalid', async () => {
    for (const text of ['keywords: [g]\nsearch: x\n', '"just a string"', '', '   \n# nothing\n', 'a: [unclosed', '\x00\x01binary']) {
        upstream.set(DEFAULT_RULES, text)
        const r = await get(q('g hi'))
        assert.equal(r.status, 200, JSON.stringify(text))
        assert.equal(await redirectTarget(r), null)
        const index = await (await get('/')).text()
        assert.match(index, /<p>Valid: false<\/p>/)
        assert.equal((await get('/rules.json')).status, 404)
        const s = await get('/suggestion?q=g%20hi')
        assert.deepEqual(await s.json(), ['g hi', [], [], []])
    }
})

// ---------------------------------------------------------------- rules sources and KV

test('default rules are cached in KV with the old key/value/metadata format', async () => {
    const before = Date.now()
    await get(q('g x'))
    assert.equal(kv.puts.length, 1)
    const [put] = kv.puts
    assert.equal(put.key, DEFAULT_RULES)
    assert.equal(put.value, RULES_YAML)
    assert.equal(put.opts.expirationTtl, 86400 * 3)
    assert.deepEqual(Object.keys(put.opts.metadata), ['refresh'])
    assert.ok(put.opts.metadata.refresh >= before + 86400_000 && put.opts.metadata.refresh <= Date.now() + 86400_000)
    const rulesFetch = calls.find((c) => c.url === DEFAULT_RULES)
    assert.deepEqual(JSON.parse(JSON.stringify(rulesFetch.init.cf)), { cacheTtlByStatus: { '200-299': 172800, 404: 0, '500-599': 0 } })

    // Same text and fresh metadata: no write.
    await get(q('g x'))
    assert.equal(kv.puts.length, 1)
    // Stale metadata: rewritten once.
    kv.seed(DEFAULT_RULES, RULES_YAML, { refresh: Date.now() - 1 })
    await get('/')
    assert.equal(kv.puts.length, 2)
    // No metadata at all counts as stale (as before).
    kv.seed(DEFAULT_RULES, RULES_YAML, null)
    await get('/')
    assert.equal(kv.puts.length, 3)
    // Changed upstream text: rewritten.
    upstream.set(DEFAULT_RULES, '- keywords: [n]\n  default: https://n.test/\n')
    assert.equal(await redirectTarget(await get(q('n'))), 'https://n.test/')
    assert.equal(kv.puts.at(-1).value, '- keywords: [n]\n  default: https://n.test/\n')
})

test('upstream down or invalid: falls back to the KV copy of the same URL', async () => {
    kv.seed(DEFAULT_RULES, '- keywords: [k]\n  default: https://cached.test/\n')
    for (const failure of [new Error('network down'), new Response('oops', { status: 500 }), 'not: [valid'] ) {
        upstream.set(DEFAULT_RULES, failure)
        assert.equal(await redirectTarget(await get(q('k'))), 'https://cached.test/')
        const html = await (await get('/')).text()
        assert.match(html, /<p>Valid: false<\/p>\s*<p>Fallback to cache: true<\/p>/)
        assert.ok(html.includes('- keywords: [k]'))
        assert.deepEqual(await (await get('/rules.json')).json(), [{ keywords: ['k'], default: 'https://cached.test/' }])
    }
    assert.equal(kv.puts.length, 0, 'invalid text is never written to KV')
    // A stale cached copy is kept alive while the upstream is broken.
    kv.seed(DEFAULT_RULES, '- keywords: [k]\n  default: https://cached.test/\n', { refresh: 0 })
    await get(q('k'))
    assert.equal(kv.puts.length, 1)
    assert.equal(kv.puts[0].value, '- keywords: [k]\n  default: https://cached.test/\n')
})

test('custom gist rules from cookies, with fallbacks', async () => {
    const cookie = 'github_user=alice; gist_id=0123abcd'
    upstream.set(GIST, '- keywords: [mine]\n  search: https://mine.test/?q={query}\n')
    assert.equal(await redirectTarget(await get(q('mine a'), { cookie })), 'https://mine.test/?q=a')
    assert.equal(kv.puts.length, 1)
    assert.equal(kv.puts[0].key, GIST)
    const index = await (await get('/', { cookie })).text()
    assert.ok(index.includes(`<a href="${GIST}">${GIST}</a>`))

    // Gist becomes invalid: its own KV copy is used (the old worker jumped to the default rules).
    upstream.set(GIST, '{{{')
    assert.equal(await redirectTarget(await get(q('mine b'), { cookie })), 'https://mine.test/?q=b')

    // Gist gone and no KV copy: default rules, KV copy first, then the URL.
    kv.store.clear()
    upstream.delete(GIST)
    kv.seed(DEFAULT_RULES, '- keywords: [d]\n  default: https://default-kv.test/\n')
    assert.equal(await redirectTarget(await get(q('d'), { cookie })), 'https://default-kv.test/')
    kv.store.clear()
    assert.equal(await redirectTarget(await get(q('g a'), { cookie })), 'https://www.google.com/search?q=a')
    // Nothing anywhere.
    upstream.delete(DEFAULT_RULES)
    const r = await get(q('g a'), { cookie })
    assert.equal(await redirectTarget(r), null)
})

test('hostile or malformed cookies cannot crash the worker or pick odd URLs', async () => {
    const cookies = [
        'github_user="><script>alert(1)</script>; gist_id=1',
        `github_user=${'a'.repeat(600)}; gist_id=${'b'.repeat(600)}`,
        'github_user=..; gist_id=abc',
        'github_user=alice; gist_id=../../x',
        'github_user=alice',
        'gist_id=abc',
        '=; ;;; github_user; gist_id==',
        'favicon_path=%E0%A4%A',
        'favicon_path="><x',
    ]
    for (const cookie of cookies) {
        for (const path of ['/', q('g a'), '/rules.json', '/suggestion?q=gh%20a', '/favicon.ico']) {
            const r = await get(path, { cookie })
            assert.ok(r.status < 500, `${cookie} ${path} -> ${r.status}`)
            const body = await r.text()
            assert.ok(!body.includes('<script>alert'), `${cookie} ${path} reflects HTML`)
            assert.ok(!body.includes('"><x'), `${cookie} ${path} reflects HTML`)
        }
    }
    const fetched = calls.map((c) => c.url)
    assert.ok(fetched.every((u) => u.startsWith(STATIC) || u.startsWith('https://')), fetched.join('\n'))
    assert.ok(!fetched.some((u) => u.startsWith('https://gist.')), 'invalid gist cookies use the default rules')
    assert.ok(kv.puts.every((p) => p.key === DEFAULT_RULES))
    // Value containing '=' is no longer truncated.
    const html = await (await get('/', { cookie: 'favicon_path=https%3A%2F%2Fi.test%2Fa%3Db' })).text()
    assert.ok(html.includes('href="/search-plugin.xml?favicon_path=https%3A%2F%2Fi.test%2Fa%3Db"'))
})

test('KV failures and a missing binding are tolerated', async () => {
    kv.failGet = true
    kv.failPut = true
    assert.equal(await redirectTarget(await get(q('g a'))), 'https://www.google.com/search?q=a')
    assert.equal((await get('/')).status, 200)
    delete ctx.DONNY_RULES_CACHE
    try {
        assert.equal(await redirectTarget(await get(q('g a'))), 'https://www.google.com/search?q=a')
        upstream.delete(DEFAULT_RULES)
        assert.equal((await get(q('g a'))).status, 200)
        assert.equal((await get('/rules.json')).status, 404)
    } finally {
        ctx.DONNY_RULES_CACHE = kv
    }
})

test('a KV put failure does not discard valid gist rules (old bug)', async () => {
    kv.failPut = true
    upstream.set(GIST, '- keywords: [mine]\n  default: https://mine.test/\n')
    assert.equal(await redirectTarget(await get(q('mine'), { cookie: 'github_user=alice; gist_id=0123abcd' })), 'https://mine.test/')
})

test('/rules.json serves the parsed rules unchanged', async () => {
    const r = await get('/rules.json')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'application/json;charset=UTF-8')
    assert.deepEqual(await r.json(), RULES_JSON)
})

// ---------------------------------------------------------------- suggestions

test('suggestions', async () => {
    let seenUA
    upstream.set('https://www.bing.com/osjson.aspx?query=hel', (req) => {
        seenUA = req.headers.get('user-agent')
        return Response.json(['hel', ['hello', 'help'], [], []])
    })
    let r = await get('/suggestion?q=b%20hel')
    assert.equal(r.headers.get('content-type'), 'application/json;charset=UTF-8')
    assert.deepEqual(await r.json(), ['b hel', ['b hello', 'b help'], [], []])
    assert.match(seenUA, /donnylol/)

    upstream.set('https://en.wikipedia.org/w/api.php?action=opensearch&search=to&limit=10&namespace=0&format=json',
        Response.json(['to', ['Tokyo'], [''], ['https://en.wikipedia.org/wiki/Tokyo']]))
    assert.deepEqual(await (await get('/suggestion?q=wikien%20to')).json(),
        ['wikien to', ['wikien Tokyo'], [''], ['https://en.wikipedia.org/wiki/Tokyo']])

    assert.equal((await get('/suggestion')).status, 400)
    assert.equal((await get('/suggestion?q=')).status, 400)
    assert.deepEqual(await (await get('/suggestion?q=gh%20foo')).json(), ['gh foo', [], [], []], 'rule without suggestion')
    assert.deepEqual(await (await get('/suggestion?q=g')).json(), ['g', [], [], []], 'no remaining query')
})

test('suggestion upstream failures return an empty list (used to be error 1101)', async () => {
    const url = 'https://suggestqueries.google.com/complete/search?output=firefox&q=hel'
    for (const failure of [
        new Response('<!DOCTYPE html><html>Error 400</html>', { status: 400, headers: { 'content-type': 'text/html' } }),
        new Response('Please set a user-agent', { status: 403 }),
        new Response(null, { status: 204 }),
        Response.json({ not: 'an array' }),
        Response.json(['something else', ['x']]),
        Response.json(['hel', 'not a list']),
        Response.json(null),
        new Error('connection reset'),
    ]) {
        upstream.set(url, failure)
        const r = await get('/suggestion?q=g%20hel')
        assert.equal(r.status, 200)
        assert.deepEqual(await r.json(), ['g hel', [], [], []])
    }
    // Default (catch-all) rule: no keyword, so no leading space (used to be " hello").
    upstream.set('https://suggestqueries.google.com/complete/search?output=firefox&q=hel+lo', Response.json(['hel lo', ['hello']]))
    assert.deepEqual(await (await get('/suggestion?q=hel%20lo')).json(), ['hel lo', ['hello']])
    // Malformed percent-encoding.
    assert.equal((await get('/suggestion?q=%zz')).status, 200)
})

// ---------------------------------------------------------------- static files

test('favicon is proxied from GitHub or the favicon_path cookie', async () => {
    upstream.set(`${STATIC}/favicon.ico`, new Response('ICO', { headers: { 'content-type': 'image/x-icon' } }))
    upstream.set(`${STATIC}/favicon.jpg`, new Response('JPG', { headers: { 'content-type': 'image/jpeg' } }))
    upstream.set('https://icons.test/me/favicon.ico', new Response('MINE'))
    assert.equal(await (await get('/favicon.ico')).text(), 'ICO')
    assert.equal(await (await get('//favicon.jpg')).text(), 'JPG', 'URL from old search plugins with //')
    assert.equal(await (await get('/favicon.ico', { cookie: 'favicon_path=https%3A%2F%2Ficons.test%2Fme' })).text(), 'MINE')
    for (const cookie of ['favicon_path=%E0%A4%A', 'favicon_path=javascript%3Aalert(1)', 'favicon_path=not%20a%20url', 'favicon_path=']) {
        assert.equal(await (await get('/favicon.ico', { cookie })).text(), 'ICO', cookie)
    }
    upstream.set(`${STATIC}/favicon.ico`, new Error('down'))
    assert.equal((await get('/favicon.ico')).status, 404)
})

test('search-plugin.xml', async () => {
    let xml = await (await get('/search-plugin.xml')).text()
    assert.ok(xml.includes('<Image width="64" height="64" type="image/jpeg">https://donny.taiho.moe/favicon.jpg</Image>'))
    assert.ok(xml.includes('<Image width="16" height="16" type="image/x-icon">https://donny.taiho.moe/favicon.ico</Image>'))
    assert.ok(xml.includes('<Url type="text/html" template="https://donny.taiho.moe/?q={searchTerms}" />'))
    assert.ok(xml.includes('<Url type="application/x-suggestions+json" template="https://donny.taiho.moe/suggestion?q={searchTerms}"/>'))
    xml = await (await get('/search-plugin.xml?favicon_path=https%3A%2F%2Fi.test%2Fx')).text()
    assert.ok(xml.includes('>https://i.test/x/favicon.jpg</Image>'))
    const r = await get('/search-plugin.xml?favicon_path=%3C%2FImage%3E%3Cx%3E%26')
    assert.equal(r.headers.get('content-type'), 'application/opensearchdescription+xml;charset=UTF-8')
    xml = await r.text()
    assert.ok(xml.includes('&#60;/Image&#62;&#60;x&#62;&#38;/favicon.jpg'), xml)
    assert.equal((await get('/search-plugin.xml?favicon_path=%zz')).status, 200)
})

test('sw.js and sw.js.map', async () => {
    upstream.set(`${STATIC}/sw.js`, new Response('self.x=1', { headers: { 'content-type': 'text/plain' } }))
    upstream.set(`${STATIC}/sw.js.map`, new Response('{"version":3}'))
    let r = await get('/sw.js')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'text/javascript;charset=UTF-8')
    assert.equal(await r.text(), 'self.x=1')
    assert.equal(await (await get('/sw.js.map')).text(), '{"version":3}')
    upstream.set(`${STATIC}/sw.js`, new Error('down'))
    upstream.set(`${STATIC}/sw.js.map`, new Error('down'))
    assert.equal((await get('/sw.js')).status, 404)
    assert.equal((await get('/sw.js.map')).status, 404)
    upstream.delete(`${STATIC}/sw.js`)
    assert.equal((await get('/sw.js')).status, 404)
})

// ---------------------------------------------------------------- everything else

test('unknown paths are 404, any method', async () => {
    for (const path of ['/nope', '/rules.yaml', '/%zz', '/favicon.png', '/index.html']) {
        const r = await get(path)
        assert.equal(r.status, 404, path)
        assert.equal(await r.text(), '404: Not Found')
    }
    assert.equal((await get('/', { method: 'POST' })).status, 200)
    assert.equal((await get('/x', { method: 'DELETE' })).status, 404)
    assert.equal((await get(q('g a'), { method: 'HEAD' })).status, 200)
})

test('top-level catch: unexpected exceptions become 404, not 1101', async () => {
    const evil = {
        get url() { throw new Error('boom') },
        headers: new Headers(),
    }
    const r = await dispatchEvent({ request: evil })
    assert.equal(r.status, 404)
    const evil2 = {
        url: `${ORIGIN}/?q=g%20a`,
        headers: { get() { throw new Error('boom') } },
    }
    assert.equal((await dispatchEvent({ request: evil2 })).status, 404)
    // A runtime without event.waitUntil still answers.
    let response
    handler({ request: new Request(`${ORIGIN}/`), respondWith: (p) => { response = p } })
    assert.equal((await response).status, 200)
})
