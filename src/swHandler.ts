import { openDB, IDBPDatabase } from 'idb'
import { handleQuery, Rule } from './rules'

const DB_NAME = 'db'
const STORE_NAME = 'cached_rules'
const RULES_KEY = 'rules'

export async function handleRequest(request: Request): Promise<Response> {
    const request_url = new URL(request.url)
    if (request_url.pathname === '/') {
        const rules = await fetchRules()
        const query = request_url.searchParams.get("q")
        if (query) {
            const redirect_url = handleQuery(query, rules)
            if (redirect_url) return Response.redirect(redirect_url, 302)
        }
    }
    return fetch(request)
}

async function fetchRules(): Promise<Rule[]> {
    const caches: IDBPDatabase<any> = await openDB(DB_NAME, 1, {
        upgrade(db) {
            db.createObjectStore(STORE_NAME)
        },
    })
    let rules = null
    try {
        rules = JSON.parse(await caches.get(STORE_NAME, RULES_KEY))
    } catch (e) {
        // pass
    }
    if (!rules) {
        rules = await syncRules()
    }
    return rules
}

export async function syncRules(): Promise<Rule[]> {
    const request = new Request('/rules.json')
    const response = await fetch(request, {credentials: 'include'})
    if (!response.ok) throw new Error('no rules available')
    const rules = response.json()
    const caches: IDBPDatabase<any> = await openDB(DB_NAME, 1, {
        upgrade(db) {
            db.createObjectStore(STORE_NAME)
        },
    })
    await caches.put(STORE_NAME, JSON.stringify(rules), RULES_KEY)
    console.log('Rules sync complete')
    return rules
}