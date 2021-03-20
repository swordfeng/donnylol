import YAML from 'yaml'
import { handleQuery, handleSuggestion, Rule } from './rules'

declare const DONNY_RULES_CACHE: KVNamespace

const STATIC_URL = "https://raw.githubusercontent.com/swordfeng/donnylol/master/static"

export async function handleRequest(request: Request): Promise<Response> {
    const request_url = new URL(request.url)

    if (request_url.pathname === '/favicon.ico' || request_url.pathname === '/favicon.jpg') {
        const favicon_path = decodeURIComponent(getCookie(request, "favicon_path") || STATIC_URL)
        return fetch(new Request(`${favicon_path}${request_url.pathname}`))
    }
    if (request_url.pathname === '/') {
        const rules = await fetchRules(request)
        const query = request_url.searchParams.get("q")
        if (query) {
            const redirect_url = handleQuery(query, rules)
            if (redirect_url) return Response.redirect(redirect_url, 302)
        }

        return new Response(await indexContent(request), {
            headers: {
                "content-type": "text/html;charset=UTF-8",
            },
        })
    }
    if (request_url.pathname === '/suggestion') {
        const rules = await fetchRules(request)
        const query = request_url.searchParams.get("q")
        if (query) {
            const suggestion = await handleSuggestion(query, rules)
            return new Response(JSON.stringify(suggestion), {
                headers: {
                    "content-type": "application/json;charset=UTF-8",
                }
            })
        }
        return new Response(`400: Bad Request`, { status: 400 })
    }
    if (request_url.pathname === '/search-plugin.xml') {
        const favicon_path = request_url.searchParams.get("favicon_path")
        return new Response(searchPluginContent(request_url.host, favicon_path), {
            headers: {
                "content-type": "application/opensearchdescription+xml;charset=UTF-8",
            },
        })
    }
    if (request_url.pathname === '/rules.json') {
        const rules = await fetchRules(request)
        return new Response(JSON.stringify(rules), {
            headers: {
                "content-type": "application/json;charset=UTF-8",
            },
        })
    }
    if (request_url.pathname === '/sw.js') {
        const response = await fetch(new Request(`${STATIC_URL}/sw.js`))
        const {status, statusText} = response
        const headers = {"content-type": "text/javascript;charset=UTF-8"}
        return new Response(response.body, {status, statusText, headers})
    }
    if (request_url.pathname === '/sw.js.map') {
        return fetch(new Request(`${STATIC_URL}/sw.js.map`))
    }
    return new Response(`404: Not Found`, { status: 404 })
}

async function indexContent(request: Request): Promise<string> {
    const rules_url = getRulesURL(request)
    const [rules_text, rules_cached] = await Promise.all([fetchRulesFromURL(rules_url), fetchRulesFromKV(rules_url)])
    let valid_yaml = true
    try {
        if (typeof rules_text === 'string') {
            YAML.parse(rules_text)
        } else {
            valid_yaml = false
        }
    } catch (e) {
        valid_yaml = false
    }
    let cache_fallback = false
    if (!valid_yaml && rules_cached) cache_fallback = true
    const favicon_path = getCookie(request, "favicon_path")
    return `<!doctype html>
<html>
    <head>
        <meta charset="UTF-8">
        <title>Donnylol</title>
        <link rel="search"
                type="application/opensearchdescription+xml"
                title="donny"
                href="/search-plugin.xml${(favicon_path ? "?favicon_path=" + favicon_path : "")}">
    </head>
    <body>
        <h1>MAKE SEARCH GREAT AGAIN!</h1>
        <p>Current rules URL: <a href="${rules_url}">${rules_url}</a></p>
        <p>Valid: ${valid_yaml}</p>
        <p>Fallback to cache: ${cache_fallback}</p>
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
        <pre id="rules">${(cache_fallback ? rules_cached : rules_text)}</pre>
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

function searchPluginContent(host: string, favicon_path?: string | null): string {
    favicon_path = favicon_path || `https://${host}/`
    return `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:moz="http://www.mozilla.org/2006/browser/search/">
    <ShortName>donny</ShortName>
    <Description>Donnylol custom search tool</Description>
    <InputEncoding>UTF-8</InputEncoding>
    <Image width="64" height="64" type="image/jpeg">${favicon_path}/favicon.jpg</Image>
    <Image width="16" height="16" type="image/x-icon">${favicon_path}/favicon.ico</Image>
    <Url type="text/html" template="https://${host}/?q={searchTerms}" />
    <Url type="application/x-suggestions+json" template="https://${host}/suggestion?q={searchTerms}"/>
    <moz:SearchForm>https://${host}/</moz:SearchForm>
</OpenSearchDescription>`
}

const DEFAULT_RULES_URL = `${STATIC_URL}/rules.yaml`

function getRulesURL(request: Request): string {
    // lookup cookies
    const github_user = getCookie(request, "github_user")
    const gist_id = getCookie(request, "gist_id")
    let rules_url = DEFAULT_RULES_URL
    if (github_user && gist_id) {
        rules_url = `https://gist.githubusercontent.com/${github_user}/${gist_id}/raw`
    }
    return rules_url
}

async function fetchRules(request: Request): Promise<Rule[]> {
    const rules_url = getRulesURL(request)
    let [rules_text, rules_cache] = await Promise.all([fetchRulesFromURL(rules_url), fetchRulesFromKV(rules_url)])
    if (rules_text) {
        try {
            const rules = YAML.parse(rules_text)
            if (rules_cache !== rules_text) {
                await cacheRulesKV(rules_url, rules_text)
            }
            return rules
        } catch (e) {
            // pass
        }
    } else if (rules_cache) {
        return YAML.parse(rules_cache)
    }
    // fallback
    if (rules_url !== DEFAULT_RULES_URL) {
        rules_text = await fetchRulesFromKV(DEFAULT_RULES_URL)
        if (!rules_text) rules_text = await fetchRulesFromURL(DEFAULT_RULES_URL)
    }
    return YAML.parse(rules_text as string)
}

async function fetchRulesFromURL(url: string): Promise<string | null> {
    try {
        const rules_request = new Request(url, {
            cf: { cacheTtlByStatus: { "200-299": 86400 * 2, 404: 0, "500-599": 0 } }
        })
        const rules_response = await fetch(rules_request)
        if (!rules_response.ok) return null
        return await rules_response.text()
    } catch (e) {
        return null
    }
}

async function fetchRulesFromKV(url: string): Promise<string | null> {
    try {
        const data: {
            value: string | null,
            metadata: { refresh: number } | null,
        } = await DONNY_RULES_CACHE.getWithMetadata(url)
        if (data.value && (!data.metadata || data.metadata.refresh < Date.now())) {
            await cacheRulesKV(url, data.value)
        }
        return data.value
    } catch (e) {
        return null
    }
}

function cacheRulesKV(url: string, text: string): Promise<void> {
    const refresh = Date.now() + 86400 * 1000
    return DONNY_RULES_CACHE.put(url, text, {
        expirationTtl: 86400 * 3,
        metadata: {
            refresh,
        },
    })
}

function getCookie(request: Request, name: string) {
    let result = ""
    const cookieString = request.headers.get("Cookie")
    if (cookieString) {
        const cookies = cookieString.split(";")
        cookies.forEach(cookie => {
            const cookiePair = cookie.split("=", 2)
            const cookieName = cookiePair[0].trim()
            if (cookieName === name) {
                const cookieVal = cookiePair[1]
                result = cookieVal
            }
        })
    }
    return result
}