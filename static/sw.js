/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId]) {
/******/ 			return installedModules[moduleId].exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, { enumerable: true, get: getter });
/******/ 		}
/******/ 	};
/******/
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = function(exports) {
/******/ 		if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		}
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/
/******/ 	// create a fake namespace object
/******/ 	// mode & 1: value is a module id, require it
/******/ 	// mode & 2: merge all properties of value into the ns
/******/ 	// mode & 4: return value when already ns object
/******/ 	// mode & 8|1: behave like require
/******/ 	__webpack_require__.t = function(value, mode) {
/******/ 		if(mode & 1) value = __webpack_require__(value);
/******/ 		if(mode & 8) return value;
/******/ 		if((mode & 4) && typeof value === 'object' && value && value.__esModule) return value;
/******/ 		var ns = Object.create(null);
/******/ 		__webpack_require__.r(ns);
/******/ 		Object.defineProperty(ns, 'default', { enumerable: true, value: value });
/******/ 		if(mode & 2 && typeof value != 'string') for(var key in value) __webpack_require__.d(ns, key, function(key) { return value[key]; }.bind(null, key));
/******/ 		return ns;
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = "./src/sw.ts");
/******/ })
/************************************************************************/
/******/ ({

/***/ "./src/rules.ts":
/*!**********************!*\
  !*** ./src/rules.ts ***!
  \**********************/
/*! no static exports found */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSuggestion = exports.handleQuery = void 0;
function matchRule(query, rules) {
    const spaceIdx = query.indexOf(' ');
    const keyword = spaceIdx === -1 ? query : query.slice(0, spaceIdx);
    const remainQuery = spaceIdx === -1 ? '' : query.slice(spaceIdx + 1);
    for (const rule of rules) {
        if (rule.keywords && rule.keywords.indexOf(keyword) !== -1) {
            if (remainQuery || rule.default) {
                return { rule, keyword, remainQuery };
            }
        }
        if (rule.match) {
            const match = new RegExp('^(?:' + rule.match + ')(?=$| )').exec(query);
            if (match) {
                const matchedQuery = query.slice(match[0].length + 1);
                if (matchedQuery || rule.default) {
                    return { rule, keyword: match[0], remainQuery: matchedQuery, match };
                }
            }
        }
        if (!rule.keywords && !rule.match) {
            return { rule, keyword: '', remainQuery: query };
        }
    }
    return null;
}
function handleQuery(query, rules) {
    const ruleMatch = matchRule(query, rules);
    if (!ruleMatch)
        return null;
    const { rule, keyword, remainQuery, match } = ruleMatch;
    if (!remainQuery && rule.default) {
        return replaceUrl(rule.default, keyword, remainQuery, match);
    }
    return replaceUrl(rule.search, keyword, remainQuery, match);
}
exports.handleQuery = handleQuery;
async function handleSuggestion(query, rules) {
    const ruleMatch = matchRule(query, rules);
    if (!ruleMatch)
        return [query, [], [], []];
    const { rule, keyword, remainQuery, match } = ruleMatch;
    if (!remainQuery || !rule.suggestion)
        return [query, [], [], []];
    const suggestionUrl = replaceUrl(rule.suggestion, keyword, remainQuery, match);
    const response = await fetch(new Request(suggestionUrl));
    const result = await response.json();
    if (result[0] !== remainQuery)
        return [query, [], [], []];
    result[0] = query;
    result[1] = result[1].map(suggestion => `${keyword} ${suggestion}`);
    return result;
}
exports.handleSuggestion = handleSuggestion;
function replaceUrl(url, keyword, query, match) {
    url = url.replace(/\{keyword\}/g, encodeURIComponent(keyword));
    url = url.replace(/\{query\}/g, encodeURIComponent(query).replace(/%20/g, '+'));
    if (match) {
        for (let i = 1; i < match.length; i++) {
            url = url.replace(new RegExp(`\\{${i}\\}`, 'g'), encodeURIComponent(match[i]));
        }
    }
    return url;
}


/***/ }),

/***/ "./src/sw.ts":
/*!*******************!*\
  !*** ./src/sw.ts ***!
  \*******************/
/*! no static exports found */
/***/ (function(module, exports, __webpack_require__) {

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
const swHandler_1 = __webpack_require__(/*! ./swHandler */ "./src/swHandler.ts");
self.addEventListener('fetch', (event) => {
    try {
        event.respondWith(swHandler_1.handleRequest(event.request));
    }
    catch (e) {
        event.respondWith(fetch(event.request));
    }
});
self.addEventListener('sync', (event) => {
    event.waitUntil(swHandler_1.syncRules());
});


/***/ }),

/***/ "./src/swHandler.ts":
/*!**************************!*\
  !*** ./src/swHandler.ts ***!
  \**************************/
/*! no static exports found */
/***/ (function(module, exports, __webpack_require__) {

Object.defineProperty(exports, "__esModule", { value: true });
exports.syncRules = exports.handleRequest = void 0;
const rules_1 = __webpack_require__(/*! ./rules */ "./src/rules.ts");
const CACHE_NAME = 'rules';
async function handleRequest(request) {
    const request_url = new URL(request.url);
    if (request_url.pathname === '/') {
        const rules = await fetchRules();
        const query = request_url.searchParams.get("q");
        if (query) {
            const redirect_url = rules_1.handleQuery(query, rules);
            if (redirect_url)
                return Response.redirect(redirect_url, 302);
        }
    }
    return fetch(request);
}
exports.handleRequest = handleRequest;
async function fetchRules() {
    let response = await caches.match(new Request('/rules.json'));
    if (!response) {
        response = await syncRules();
    }
    return response.json();
}
async function syncRules() {
    const request = new Request('/rules.json');
    const response = await fetch(request);
    if (!response.ok)
        throw new Error('no rules available');
    const response_cache_headers = new Headers();
    response_cache_headers.set('cache-control', 'public, max-age=604800, immutable');
    const response_cache = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response_cache_headers
    });
    caches.open(CACHE_NAME).then(cache => cache.put(request, response_cache));
    return response;
}
exports.syncRules = syncRules;


/***/ })

/******/ });
//# sourceMappingURL=sw.js.map