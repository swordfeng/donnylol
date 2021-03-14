import YAML from 'yaml'

const STATIC_URL = "https://raw.githubusercontent.com/swordfeng/donnylol/master/static"


export async function handleRequest(request: Request): Promise<Response> {
    const request_url = new URL(request.url)

    if (request_url.pathname === '/favicon.ico' || request_url.pathname === '/favicon.jpg') {
        return fetch(new Request(`${STATIC_URL}${request_url.pathname}`))
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
    if (request_url.pathname === '/search-plugin.xml') {
        return new Response(searchPluginContent(request_url.host), {
            headers: {
                "content-type": "application/opensearchdescription+xml;charset=UTF-8",
            },
        })
    }
    return new Response(`404: Not Found`, { status: 404 })
}

async function indexContent(request: Request): Promise<string> {
    const rules_url = getRulesURL(request)
    const rules_text = await fetchRulesFromURL(rules_url)
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
    return `<!doctype html>
<html>
    <head>
        <meta charset="UTF-8">
        <title>Donnylol</title>
        <link rel="search"
                type="application/opensearchdescription+xml"
                title="donny"
                href="/search-plugin.xml">
    </head>
    <body>
        <h1>MAKE SEARCH GREAT AGAIN!</h1>
        <p>Current rules URL: <a href="${rules_url}">${rules_url}</a></p>
        <p>Valid: ${valid_yaml}</p>
        <p>Rules:</p>
        <pre id="rules">${rules_text}</pre>
    </body>
</html>`
}

function searchPluginContent(host: string): string {
    return `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:moz="http://www.mozilla.org/2006/browser/search/">
    <ShortName>donny</ShortName>
    <Description>Donnylol custom search tool</Description>
    <InputEncoding>UTF-8</InputEncoding>
    <Image width="64" height="64" type="image/jpeg">https://${host}/favicon.jpg</Image>
    <Image width="16" height="16" type="image/x-icon">https://${host}/favicon.ico</Image>
    <Url type="text/html" template="https://${host}/?q={searchTerms}" />
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
    let rules_text = await fetchRulesFromURL(rules_url)
    if (!rules_text && rules_url !== DEFAULT_RULES_URL) {
        rules_text = await fetchRulesFromURL(DEFAULT_RULES_URL)
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

interface Rule {
    keywords?: string[],
    match?: string,
    search: string,
    default?: string,
}

function handleQuery(query: string, rules: Rule[]): string | null {
    const spaceIdx = query.indexOf(' ');
    const keyword = spaceIdx === -1 ? query : query.slice(0, spaceIdx);
    const remainQuery = spaceIdx === -1 ? '' : query.slice(spaceIdx + 1);
    for (const rule of rules) {
        if (rule.keywords && rule.keywords.indexOf(keyword) !== -1) {
            if (!remainQuery && rule.default) {
                const url = replaceUrl(rule.default, keyword, remainQuery);
                return url;
            }
            if (remainQuery && rule.search) {
                const url = replaceUrl(rule.search, keyword, remainQuery);
                return url;
            }
        }
        if (rule.match) {
            const match = new RegExp('^(?:' + rule.match + ')(?=$| )').exec(query);
            if (match) {
                const matchedQuery = query.slice(match[0].length + 1);
                if (!matchedQuery && rule.default) {
                    const url = replaceUrl(rule.default, match[0], matchedQuery, match);
                    return url;
                }
                if (matchedQuery && rule.search) {
                    const url = replaceUrl(rule.search, match[0], matchedQuery, match);
                    return url;
                }
            }
        }
        if (!rule.keywords && !rule.match && rule.search) {
            const url = replaceUrl(rule.search, '', query);
            return url;
        }
    }
    return null
}

function replaceUrl(url: string, keyword: string, query: string, match?: RegExpExecArray) {
    url = url.replace(/\{keyword\}/g, encodeURIComponent(keyword));
    url = url.replace(/\{query\}/g, encodeURIComponent(query).replace(/%20/g, '+'));
    if (match) {
        for (let i = 1; i < match.length; i++) {
            url = url.replace(new RegExp(`\\{${i}\\}`, 'g'), encodeURIComponent(match[i]));
        }
    }
    return url;
}