'use strict';

const fs = require('fs');
const path = require('path');
const { pathKey } = require('./utils');

const HEADER_EXT = new Set(['.h', '.hh', '.hpp', '.hxx', '.inl', '.inc', '.ipp']);
const SOURCE_EXT = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++', '.m', '.mm']);

const KIND_WEIGHT = {
    implementation: 30,
    type: 40,
    declaration: 50,
    variable: 60,
    macro: 70
};

// 文件内容缓存（简单容量控制）
const textCache = new Map();
const TEXT_CACHE_LIMIT = 200;

function readText(abs) {
    const key = pathKey(abs);
    const hit = textCache.get(key);
    if (hit) {
        try {
            const stat = fs.statSync(abs);
            if (stat.size === hit.size && stat.mtimeMs === hit.mtime) {
                return hit.text;
            }
        } catch (e) {
            textCache.delete(key);
            return '';
        }
    }
    let text = '';
    try {
        text = fs.readFileSync(abs, 'utf8');
    } catch (e) {
        return '';
    }
    let size = 0;
    let mtime = 0;
    try {
        const stat = fs.statSync(abs);
        size = stat.size;
        mtime = stat.mtimeMs;
    } catch (e) {
        // 忽略
    }
    if (textCache.size >= TEXT_CACHE_LIMIT) {
        const removeCount = Math.floor(TEXT_CACHE_LIMIT / 3);
        let removed = 0;
        for (const k of textCache.keys()) {
            textCache.delete(k);
            if (++removed >= removeCount) {
                break;
            }
        }
    }
    textCache.set(key, { text, size, mtime });
    return text;
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineColumnOf(text, index) {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < index; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            lineStart = i + 1;
        }
    }
    let end = text.indexOf('\n', index);
    if (end < 0) {
        end = text.length;
    }
    return { line, column: index - lineStart, preview: text.slice(lineStart, end).trim() };
}

/** 构造一组用于查找符号的模式：[正则, kind, 名称捕获组序号] */
function buildPatterns(name, qualifier) {
    const n = escapeRegExp(name);
    const q = qualifier ? '(?:' + escapeRegExp(qualifier) + '\\s*::\\s*)?' : '(?:[A-Za-z_]\\w*\\s*::\\s*)?';
    // 返回类型前允许若干修饰符（含 MYLIB_API 这类导出宏），返回类型本身可缺省（构造函数）
    const typePrefix = '(?:(?:virtual|static|inline|explicit|constexpr|friend|extern|mutable|const|[A-Za-z_][\\w:]*)\\s+){0,3}(?:[A-Za-z_][\\w:]*(?:<[^;{}]*>)?\\s*(?:[*&]+\\s*|\\s+))?';
    const suffix = '\\s*\\([^;{}]*\\)[^{;]*';
    // 排除关键字开头的语句（return foo(); 等）与调用上下文（if (foo)、obj.foo()、p->foo()）
    const notKeyword = '(?!(?:if|for|while|switch|return|case|else|do|throw|new|delete|catch|sizeof|typedef|using|namespace)\\b)';
    const notCall = '(?<![\\w.(,>=\\-&|!])';
    const head = '(?:^|\\n)[ \\t]*' + notKeyword + typePrefix + notCall;

    return [
        // 函数实现（带函数体或初始化列表）
        {
            re: new RegExp(head + '(' + q + ')(' + n + ')' + suffix + '(?:[:{])', 'g'),
            kind: 'implementation',
            nameGroup: 2
        },
        // 函数声明（以分号结束的原型）
        {
            re: new RegExp(head + '(' + q + ')(' + n + ')' + suffix + ';', 'g'),
            kind: 'declaration',
            nameGroup: 2
        },
        // 类 / 结构体 / 枚举 / 命名空间
        {
            re: new RegExp('\\b(class|struct|union|namespace)\\s+(' + n + ')\\b', 'g'),
            kind: 'type',
            nameGroup: 2
        },
        {
            re: new RegExp('\\benum\\s+(?:class\\s+)?(' + n + ')\\b', 'g'),
            kind: 'type',
            nameGroup: 1
        },
        // typedef / using 别名
        {
            re: new RegExp('\\b(?:typedef|using)\\s+[\\w:<>*&\\s]*?\\b(' + n + ')\\b', 'g'),
            kind: 'type',
            nameGroup: 1
        },
        // 变量 / 成员
        {
            re: new RegExp(head + '(' + n + ')\\s*(?:=[^;]*)?;', 'g'),
            kind: 'variable',
            nameGroup: 1
        },
        // 宏
        {
            re: new RegExp('#\\s*define\\s+(' + n + ')\\b', 'g'),
            kind: 'macro',
            nameGroup: 1
        }
    ];
}

/** 判断匹配位置是否处于调用上下文（如 if (foo(...)、return foo(...)：行内左侧有未闭合的 '('） */
function isCallContext(text, index) {
    // 回溯到上一个语句边界（; { }），再统计其中是否仍有未闭合的 '('
    let start = index;
    const limit = Math.max(0, index - 400);
    while (start > limit) {
        const ch = text[start - 1];
        if (ch === ';' || ch === '{' || ch === '}') {
            break;
        }
        start--;
    }
    let open = 0;
    for (let i = start; i < index; i++) {
        const ch = text[i];
        if (ch === '(') {
            open++;
        } else if (ch === ')' && open > 0) {
            open--;
        }
    }
    return open > 0;
}

/** 在单个文件中查找符号 */
function collectInFile(text, name, qualifier, abs) {
    const results = [];
    for (const pattern of buildPatterns(name, qualifier)) {
        pattern.re.lastIndex = 0;
        let m;
        while ((m = pattern.re.exec(text)) !== null) {
            const index = m.indices && m.indices[pattern.nameGroup]
                ? m.indices[pattern.nameGroup][0]
                : m.index + m[0].indexOf(name);
            if (pattern.kind === 'implementation' || pattern.kind === 'declaration' || pattern.kind === 'variable') {
                if (isCallContext(text, index)) {
                    continue;
                }
            }
            const pos = lineColumnOf(text, index);
            const qualifierText = pattern.nameGroup === 2 ? (m[1] || '') : '';
            results.push({
                abs,
                line: pos.line,
                column: pos.column,
                preview: pos.preview,
                kind: pattern.kind,
                qualifier: qualifierText.replace(/\s*::\s*$/, '')
            });
            if (m[0].length === 0) {
                pattern.re.lastIndex++;
            }
        }
    }
    return results;
}

/**
 * 在候选文件中查找符号定义/实现
 * @param {Object} options
 * @param {string} options.name 简单符号名
 * @param {string} [options.qualifier] 限定名（Class::method 中的 Class）
 * @param {Array<{abs:string}>} options.files 候选文件（已按优先级排序）
 * @param {number} [options.maxFiles]
 * @param {number} [options.budgetMs]
 * @param {Array<string>} [options.onlyKinds]
 * @returns {Array} 结果，已按优先级排序
 */
function findSymbols(options) {
    const {
        name,
        qualifier = '',
        files = [],
        maxFiles = 120,
        budgetMs = 1200,
        onlyKinds = null,
        currentFile = '',
        currentLine = -1
    } = options;

    if (!name) {
        return [];
    }
    const started = Date.now();
    const ext = path.extname(currentFile).toLowerCase();
    const fromHeader = HEADER_EXT.has(ext);
    const stem = path.basename(currentFile, ext).toLowerCase();
    const currentDir = pathKey(path.dirname(currentFile));
    const results = [];
    let scanned = 0;

    for (const file of files) {
        if (scanned >= maxFiles || Date.now() - started > budgetMs) {
            break;
        }
        const fileExt = path.extname(file.abs).toLowerCase();
        if (!HEADER_EXT.has(fileExt) && !SOURCE_EXT.has(fileExt)) {
            continue;
        }
        const text = readText(file.abs);
        if (!text) {
            continue;
        }
        scanned++;
        // 粗筛：文件里根本没有这个名字就直接跳过正则（比正则快一个数量级）
        if (text.indexOf(name) < 0) {
            continue;
        }
        const found = collectInFile(text, name, qualifier, file.abs);
        for (const item of found) {
            if (onlyKinds && onlyKinds.indexOf(item.kind) < 0) {
                continue;
            }
            if (pathKey(item.abs) === pathKey(currentFile) && item.line === currentLine) {
                continue;
            }
            const fileStem = path.basename(item.abs, path.extname(item.abs)).toLowerCase();
            let score = KIND_WEIGHT[item.kind] || 80;
            if (fileStem === stem && pathKey(item.abs) !== pathKey(currentFile)) {
                score -= 25; // 配对的 .h/.cpp 优先
            }
            if (qualifier && item.qualifier && item.qualifier.toLowerCase() === qualifier.toLowerCase()) {
                score -= 20; // 限定名一致
            }
            if (fromHeader && SOURCE_EXT.has(fileExt)) {
                score -= 5; // 从头文件中点，优先跳到实现
            }
            if (!fromHeader && HEADER_EXT.has(fileExt)) {
                score -= 3;
            }
            if (pathKey(item.abs) === pathKey(currentFile)) {
                score += 12; // 已经在当前文件里看过的位置降权
            }
            if (pathKey(path.dirname(item.abs)) === currentDir) {
                score -= 2;
            }
            item.score = score;
            results.push(item);
        }
    }

    results.sort((a, b) => a.score - b.score || a.line - b.line);
    // 去重（同一文件同一行）
    const seen = new Set();
    return results.filter((r) => {
        const key = pathKey(r.abs) + ':' + r.line + ':' + r.kind;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

/** 取光标位置的符号：支持 Foo::bar、~Foo */
function symbolAt(document, position, wordPattern) {
    const range = document.getWordRangeAtPosition(position, wordPattern || /[A-Za-z_~][\w:]*/);
    if (!range) {
        return null;
    }
    const raw = document.getText(range).trim();
    if (!raw) {
        return null;
    }
    const segs = raw.split('::').filter((s) => s.length);
    const name = segs.length ? segs[segs.length - 1] : raw;
    const qualifier = segs.length > 1 ? segs[segs.length - 2] : '';
    return { name, qualifier, range, raw };
}

// ---------------- 引用搜索 ----------------

/** findSymbols 的 kind → 引用列表中展示的性质 */
const DECL_KIND = {
    implementation: 'definition',
    declaration: 'declaration',
    type: 'declaration',
    macro: 'declaration',
    variable: 'declaration'
};

/**
 * 把注释与字符串字面量替换成等长空格（保留列号）。
 * state.inBlock 用于跨行的块注释。
 */
function maskLiterals(raw, state) {
    const len = raw.length;
    let out = '';
    let i = 0;
    while (i < len) {
        if (state.inBlock) {
            const end = raw.indexOf('*/', i);
            if (end < 0) {
                out += ' '.repeat(len - i);
                return out;
            }
            out += ' '.repeat(end + 2 - i);
            i = end + 2;
            state.inBlock = false;
            continue;
        }
        const ch = raw[i];
        const next = raw[i + 1];
        if (ch === '/' && next === '/') {
            out += ' '.repeat(len - i);
            return out;
        }
        if (ch === '/' && next === '*') {
            state.inBlock = true;
            out += '  ';
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            let j = i + 1;
            while (j < len) {
                if (raw[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (raw[j] === ch) {
                    j++;
                    break;
                }
                j++;
            }
            if (j > len) {
                j = len;
            }
            out += ' '.repeat(j - i);
            i = j;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/** 只推进块注释状态，不构造替换字符串（用于不含目标符号的行，快路径） */
function updateBlockState(raw, state) {
    let i = 0;
    while (i < raw.length) {
        if (state.inBlock) {
            const end = raw.indexOf('*/', i);
            if (end < 0) {
                return;
            }
            i = end + 2;
            state.inBlock = false;
            continue;
        }
        const start = raw.indexOf('/*', i);
        if (start < 0) {
            return;
        }
        const end = raw.indexOf('*/', start + 2);
        if (end < 0) {
            state.inBlock = true;
            return;
        }
        i = end + 2;
    }
}

/** 在单行文本上判定哪些列是定义/声明（复用 buildPatterns 的成熟规则） */
function kindsInLine(raw, name, patterns, maxIndex) {
    const kinds = new Map();
    for (const pattern of patterns) {
        pattern.re.lastIndex = 0;
        let m;
        while ((m = pattern.re.exec(raw)) !== null) {
            // 名称组总是在匹配文本的最后出现（返回类型 / 限定名都排在它前面）
            const index = m.index + m[0].lastIndexOf(name);
            if (index > maxIndex) {
                continue; // 落在后续行，不属于当前行
            }
            if (!kinds.has(index)) {
                kinds.set(index, DECL_KIND[pattern.kind] || 'declaration');
            }
            if (m[0].length === 0) {
                pattern.re.lastIndex++;
            }
        }
    }
    return kinds;
}

/**
 * 在候选文件中查找符号的全部出现位置（引用 / 定义）。
 * 逐行扫描，跳过注释与字符串；返回的 line/column 均为 0 基。
 */
function findUsages(options) {
    const {
        name,
        files = [],
        maxFiles = 1200,
        budgetMs = 4000
    } = options;

    if (!name) {
        return [];
    }
    const wordRe = new RegExp('\\b' + escapeRegExp(name) + '\\b', 'g');
    const patterns = buildPatterns(name, '');
    const results = [];
    const started = Date.now();
    let scanned = 0;

    for (const file of files) {
        if (scanned >= maxFiles || Date.now() - started > budgetMs) {
            break;
        }
        const ext = path.extname(file.abs).toLowerCase();
        if (!HEADER_EXT.has(ext) && !SOURCE_EXT.has(ext)) {
            continue;
        }
        const text = readText(file.abs);
        if (!text || text.indexOf(name) < 0) {
            continue;
        }
        scanned++;

        const rows = [];
        const lines = [];
        const state = { inBlock: false };
        let lineStart = 0;
        let line = 0;
        while (lineStart < text.length) {
            let lineEnd = text.indexOf('\n', lineStart);
            const last = lineEnd < 0;
            if (last) {
                lineEnd = text.length;
            }
            const raw = text.slice(lineStart, lineEnd);
            lines.push(raw);
            if (raw.indexOf(name) < 0) {
                // 快路径：不含目标符号，只维护跨行注释状态
                updateBlockState(raw, state);
            } else {
                const needMask = state.inBlock
                    || raw.indexOf('//') >= 0
                    || raw.indexOf('/*') >= 0
                    || raw.indexOf('"') >= 0
                    || raw.indexOf("'") >= 0;
                const code = needMask ? maskLiterals(raw, state) : raw;
                if (code.indexOf(name) >= 0) {
                    const columns = [];
                    wordRe.lastIndex = 0;
                    let m;
                    while ((m = wordRe.exec(code)) !== null) {
                        columns.push(m.index);
                        if (m[0].length === 0) {
                            wordRe.lastIndex++;
                        }
                    }
                    if (columns.length) {
                        rows.push({ line, raw, columns });
                    }
                }
            }
            line++;
            if (last) {
                break;
            }
            lineStart = lineEnd + 1;
        }

        if (!rows.length) {
            continue;
        }
        for (const row of rows) {
            // 带上后两行作为上下文：函数体 '{' 或初始化列表常常在下一行
            const window = lines.slice(row.line, row.line + 3).join('\n');
            const kinds = kindsInLine(window, name, patterns, row.raw.length);
            for (const column of row.columns) {
                results.push({
                    abs: file.abs,
                    line: row.line,
                    column,
                    preview: row.raw.trim(),
                    kind: kinds.get(column) || 'usage'
                });
            }
        }
    }

    results.sort((a, b) => {
        const ka = pathKey(a.abs);
        const kb = pathKey(b.abs);
        if (ka !== kb) {
            return ka < kb ? -1 : 1;
        }
        return a.line - b.line || a.column - b.column;
    });
    return results;
}

module.exports = { findSymbols, findUsages, symbolAt, readText, HEADER_EXT, SOURCE_EXT };
