'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.vs', '.idea', '.codebuddy',
    '__pycache__', 'cmakefile'
]);

function toPosix(p) {
    return String(p).replace(/\\/g, '/');
}

function pathKey(p) {
    return toPosix(p).toLowerCase();
}

function compareNames(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** 判断 child 是否位于 parent 目录之下（Windows 下大小写不敏感） */
function isUnder(parent, child) {
    const p = pathKey(parent).replace(/\/+$/, '');
    const c = pathKey(child);
    return c === p || c.startsWith(p + '/');
}

/** 计算一组文件的最长公共目录 */
function commonDirectory(files) {
    if (!files.length) {
        return '';
    }
    const segs = files.map((f) => toPosix(path.dirname(f)).split('/'));
    const first = segs[0];
    const common = [];
    for (let i = 0; i < first.length; i++) {
        const seg = first[i];
        const allMatch = segs.every((s) => s.length > i && s[i].toLowerCase() === seg.toLowerCase());
        if (!allMatch) {
            break;
        }
        common.push(seg);
    }
    return common.join('/');
}

function relativeTo(base, target) {
    if (!base || !isUnder(base, target)) {
        return null;
    }
    const rel = toPosix(path.relative(base, target));
    return rel.length ? rel : path.basename(target);
}

/** 在工作区中查找 .sln 文件（不依赖 files.exclude，build 目录被 gitignore 也能找到） */
function findSolutionFiles(workspaceFolders, maxDepth = 6, maxFiles = 200) {
    const results = [];

    function walk(dir, depth) {
        if (depth > maxDepth || results.length >= maxFiles) {
            return;
        }
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            if (results.length >= maxFiles) {
                return;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) {
                    continue;
                }
                walk(full, depth + 1);
            } else if (entry.isFile() && /\.sln$/i.test(entry.name)) {
                let size = 0;
                try {
                    size = fs.statSync(full).size;
                } catch (e) {
                    size = 0;
                }
                results.push({ path: full, size });
            }
        }
    }

    for (const folder of workspaceFolders) {
        walk(folder, 0);
    }
    return results.sort((a, b) => b.size - a.size);
}

/** 解析配置中的 ${workspaceFolder} 等变量 */
function resolvePathTemplate(value, workspaceFolder) {
    if (!value) {
        return '';
    }
    let result = String(value);
    if (workspaceFolder) {
        result = result.replace(/\$\{workspaceFolder\}/g, workspaceFolder)
            .replace(/\$\{workspaceRoot\}/g, workspaceFolder);
    }
    return result.replace(/\//g, path.sep);
}

function stripExtension(name) {
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(0, idx) : name;
}

module.exports = {
    toPosix,
    pathKey,
    compareNames,
    isUnder,
    commonDirectory,
    relativeTo,
    findSolutionFiles,
    resolvePathTemplate,
    stripExtension
};
