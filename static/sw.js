!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=e,n.c=t,n.d=function(e,t,r){n.o(e,t)||Object.defineProperty(e,t,{enumerable:!0,get:r})},n.r=function(e){"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})},n.t=function(e,t){if(1&t&&(e=n(e)),8&t)return e;if(4&t&&"object"==typeof e&&e&&e.__esModule)return e;var r=Object.create(null);if(n.r(r),Object.defineProperty(r,"default",{enumerable:!0,value:e}),2&t&&"string"!=typeof e)for(var o in e)n.d(r,o,function(t){return e[t]}.bind(null,o));return r},n.n=function(e){var t=e&&e.__esModule?function(){return e.default}:function(){return e};return n.d(t,"a",t),t},n.o=function(e,t){return Object.prototype.hasOwnProperty.call(e,t)},n.p="",n(n.s=0)}([function(e,t,n){"use strict";Object.defineProperty(t,"__esModule",{value:!0});const r=n(1);self.addEventListener("fetch",e=>{e.respondWith(r.handleRequest(e.request).catch(t=>(console.error(`Failed to handle request ${e.request.url}:`,t),fetch(e.request))))}),self.addEventListener("sync",e=>{e.waitUntil(r.syncRules().catch(e=>{console.error("Failed to sync rules:",e)}))})},function(e,t,n){"use strict";Object.defineProperty(t,"__esModule",{value:!0}),t.syncRules=t.handleRequest=void 0;const r=n(3),o=n(2);async function s(){const e=new Request("/rules.json"),t=await fetch(e);if(!t.ok)throw new Error("no rules available");const n=await t.json(),o=await r.openDB("db",1,{upgrade(e){e.createObjectStore("cached_rules")}});return await o.put("cached_rules",JSON.stringify(n),"rules"),await o.put("cached_rules",Date.now(),"update_time"),console.log("Rules sync complete"),n}t.handleRequest=async function(e){const t=new URL(e.url);if("/"===t.pathname){const e=await async function(){const e=await r.openDB("db",1,{upgrade(e){e.createObjectStore("cached_rules")}});let t=null;try{t=JSON.parse(await e.get("cached_rules","rules"))}catch(e){}if(t){const t=await e.get("cached_rules","update_time");Date.now()-t>144e5&&s()}else t=await s();return t}(),n=t.searchParams.get("q");if(n){const t=o.handleQuery(n,e);if(t)return Response.redirect(t,302)}}return fetch(e)},t.syncRules=s},function(e,t,n){"use strict";function r(e,t){const n=e.indexOf(" "),r=-1===n?e:e.slice(0,n),o=-1===n?"":e.slice(n+1);for(const n of t){if(n.keywords&&-1!==n.keywords.indexOf(r)&&(o&&n.search||!o&&n.default))return{rule:n,keyword:r,remainQuery:o};if(n.match){const t=new RegExp("^(?:"+n.match+")(?=$| )").exec(e);if(t){const r=e.slice(t[0].length+1);if(r&&n.search||!r&&n.default)return{rule:n,keyword:t[0],remainQuery:r,match:t}}}if(!n.keywords&&!n.match)return{rule:n,keyword:"",remainQuery:e}}return null}function o(e,t,n,r){if(e=(e=e.replace(/\{keyword\}/g,encodeURIComponent(t))).replace(/\{query\}/g,encodeURIComponent(n).replace(/%20/g,"+")),r)for(let t=1;t<r.length;t++)e=e.replace(new RegExp(`\\{${t}\\}`,"g"),encodeURIComponent(r[t]));return e}Object.defineProperty(t,"__esModule",{value:!0}),t.handleSuggestion=t.handleQuery=void 0,t.handleQuery=function(e,t){const n=r(e,t);if(!n)return null;const{rule:s,keyword:a,remainQuery:c,match:u}=n;return!c&&s.default?o(s.default,a,c,u):o(s.search,a,c,u)},t.handleSuggestion=async function(e,t){const n=r(e,t);if(!n)return[e,[],[],[]];const{rule:s,keyword:a,remainQuery:c,match:u}=n;if(!c||!s.suggestion)return[e,[],[],[]];const i=o(s.suggestion,a,c,u),d=await fetch(new Request(i)),l=await d.json();return l[0]!==c?[e,[],[],[]]:(l[0]=e,l[1]=l[1].map(e=>`${a} ${e}`),l)}},function(e,t,n){"use strict";n.r(t),n.d(t,"unwrap",(function(){return y})),n.d(t,"wrap",(function(){return p})),n.d(t,"deleteDB",(function(){return g})),n.d(t,"openDB",(function(){return h}));let r,o;const s=new WeakMap,a=new WeakMap,c=new WeakMap,u=new WeakMap,i=new WeakMap;let d={get(e,t,n){if(e instanceof IDBTransaction){if("done"===t)return a.get(e);if("objectStoreNames"===t)return e.objectStoreNames||c.get(e);if("store"===t)return n.objectStoreNames[1]?void 0:n.objectStore(n.objectStoreNames[0])}return p(e[t])},set:(e,t,n)=>(e[t]=n,!0),has:(e,t)=>e instanceof IDBTransaction&&("done"===t||"store"===t)||t in e};function l(e){return e!==IDBDatabase.prototype.transaction||"objectStoreNames"in IDBTransaction.prototype?(o||(o=[IDBCursor.prototype.advance,IDBCursor.prototype.continue,IDBCursor.prototype.continuePrimaryKey])).includes(e)?function(...t){return e.apply(y(this),t),p(s.get(this))}:function(...t){return p(e.apply(y(this),t))}:function(t,...n){const r=e.call(y(this),t,...n);return c.set(r,t.sort?t.sort():[t]),p(r)}}function f(e){return"function"==typeof e?l(e):(e instanceof IDBTransaction&&function(e){if(a.has(e))return;const t=new Promise((t,n)=>{const r=()=>{e.removeEventListener("complete",o),e.removeEventListener("error",s),e.removeEventListener("abort",s)},o=()=>{t(),r()},s=()=>{n(e.error||new DOMException("AbortError","AbortError")),r()};e.addEventListener("complete",o),e.addEventListener("error",s),e.addEventListener("abort",s)});a.set(e,t)}(e),t=e,(r||(r=[IDBDatabase,IDBObjectStore,IDBIndex,IDBCursor,IDBTransaction])).some(e=>t instanceof e)?new Proxy(e,d):e);var t}function p(e){if(e instanceof IDBRequest)return function(e){const t=new Promise((t,n)=>{const r=()=>{e.removeEventListener("success",o),e.removeEventListener("error",s)},o=()=>{t(p(e.result)),r()},s=()=>{n(e.error),r()};e.addEventListener("success",o),e.addEventListener("error",s)});return t.then(t=>{t instanceof IDBCursor&&s.set(t,e)}).catch(()=>{}),i.set(t,e),t}(e);if(u.has(e))return u.get(e);const t=f(e);return t!==e&&(u.set(e,t),i.set(t,e)),t}const y=e=>i.get(e);function h(e,t,{blocked:n,upgrade:r,blocking:o,terminated:s}={}){const a=indexedDB.open(e,t),c=p(a);return r&&a.addEventListener("upgradeneeded",e=>{r(p(a.result),e.oldVersion,e.newVersion,p(a.transaction))}),n&&a.addEventListener("blocked",()=>n()),c.then(e=>{s&&e.addEventListener("close",()=>s()),o&&e.addEventListener("versionchange",()=>o())}).catch(()=>{}),c}function g(e,{blocked:t}={}){const n=indexedDB.deleteDatabase(e);return t&&n.addEventListener("blocked",()=>t()),p(n).then(()=>{})}const w=["get","getKey","getAll","getAllKeys","count"],m=["put","add","delete","clear"],b=new Map;function v(e,t){if(!(e instanceof IDBDatabase)||t in e||"string"!=typeof t)return;if(b.get(t))return b.get(t);const n=t.replace(/FromIndex$/,""),r=t!==n,o=m.includes(n);if(!(n in(r?IDBIndex:IDBObjectStore).prototype)||!o&&!w.includes(n))return;const s=async function(e,...t){const s=this.transaction(e,o?"readwrite":"readonly");let a=s.store;return r&&(a=a.index(t.shift())),(await Promise.all([a[n](...t),o&&s.done]))[0]};return b.set(t,s),s}d=(e=>({...e,get:(t,n,r)=>v(t,n)||e.get(t,n,r),has:(t,n)=>!!v(t,n)||e.has(t,n)}))(d)}]);
//# sourceMappingURL=sw.js.map