'use strict';

const path = require('path');
const { pathKey, relativeTo } = require('./utils');

/** 按文件路径构建虚拟目录容器（无 vscode 依赖，便于单独测试） */
function buildContainer(files, baseDir) {
    const root = { name: '', relPath: '', dirs: new Map(), files: [] };
    for (const file of files) {
        const rel = relativeTo(baseDir, file.abs);
        if (!rel) {
            root.files.push(file);
            continue;
        }
        const segs = rel.split('/');
        let cursor = root;
        for (let i = 0; i < segs.length - 1; i++) {
            const seg = segs[i];
            let next = cursor.dirs.get(seg);
            if (!next) {
                next = {
                    name: seg,
                    relPath: cursor.relPath ? cursor.relPath + '/' + seg : seg,
                    dirs: new Map(),
                    files: []
                };
                cursor.dirs.set(seg, next);
            }
            cursor = next;
        }
        cursor.files.push(file);
    }
    return root;
}

function dirHasMatch(dir, filter) {
    if (dir.files.some((f) => pathKey(f.abs).includes(filter))) {
        return true;
    }
    for (const child of dir.dirs.values()) {
        if (dirHasMatch(child, filter)) {
            return true;
        }
    }
    return false;
}

function countFiles(container) {
    let total = container.files.length;
    for (const child of container.dirs.values()) {
        total += countFiles(child);
    }
    return total;
}

module.exports = { buildContainer, dirHasMatch, countFiles };
