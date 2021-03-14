import { handleRequest } from './handler'

addEventListener('fetch', (event) => {
    try {
        event.respondWith(handleRequest(event.request))
    } catch (e) {
        event.respondWith(new Response('Internal Error', { status: 500 }))
    }
})
