import { handleRequest, syncRules } from './swHandler'

self.addEventListener('fetch', (event) => {
    event.respondWith(handleRequest(event.request).catch(e => {
        console.log(`Failed to handle request ${event.request.url}: ${e}`)
        return fetch(event.request)
    }))
})

self.addEventListener('periodicsync', (event) => {
    event.waitUntil(syncRules());
})