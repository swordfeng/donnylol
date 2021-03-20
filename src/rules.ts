
export interface Rule {
    keywords?: string[],
    match?: string,
    search: string,
    suggestion?: string,
    default?: string,
}

interface RuleMatch {
    rule: Rule,
    keyword: string,
    remainQuery: string,
    match?: RegExpExecArray
}

function matchRule(query: string, rules: Rule[]): RuleMatch | null {
    const spaceIdx = query.indexOf(' ');
    const keyword = spaceIdx === -1 ? query : query.slice(0, spaceIdx);
    const remainQuery = spaceIdx === -1 ? '' : query.slice(spaceIdx + 1);
    for (const rule of rules) {
        if (rule.keywords && rule.keywords.indexOf(keyword) !== -1) {
            if (remainQuery || rule.default) {
                return {rule, keyword, remainQuery};
            }
        }
        if (rule.match) {
            const match = new RegExp('^(?:' + rule.match + ')(?=$| )').exec(query);
            if (match) {
                const matchedQuery = query.slice(match[0].length + 1);
                if (matchedQuery || rule.default) {
                    return {rule, keyword: match[0], remainQuery: matchedQuery, match}
                }
            }
        }
        if (!rule.keywords && !rule.match) {
            return {rule, keyword: '', remainQuery: query};
        }
    }
    return null
}

export function handleQuery(query: string, rules: Rule[]): string | null {
    const ruleMatch = matchRule(query, rules)
    if (!ruleMatch) return null
    const {rule, keyword, remainQuery, match} = ruleMatch
    if (!remainQuery && rule.default) {
        return replaceUrl(rule.default, keyword, remainQuery, match)
    }
    return replaceUrl(rule.search, keyword, remainQuery, match)
}

type SuggestionResult = [string, string[], any, any]

export async function handleSuggestion(query: string, rules: Rule[]): Promise<SuggestionResult> {
    const ruleMatch = matchRule(query, rules)
    if (!ruleMatch) return [query, [], [], []]
    const {rule, keyword, remainQuery, match} = ruleMatch
    if (!remainQuery || !rule.suggestion) return [query, [], [], []]
    const suggestionUrl = replaceUrl(rule.suggestion, keyword, remainQuery, match)
    const response = await fetch(new Request(suggestionUrl))
    const result: SuggestionResult = await response.json()
    if (result[0] !== remainQuery) return [query, [], [], []]
    result[0] = query
    result[1] = result[1].map(suggestion => `${keyword} ${suggestion}`)
    return result
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