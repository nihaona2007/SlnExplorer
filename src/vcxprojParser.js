'use strict';

const fs = require('fs');
const path = require('path');
const { pathKey } = require('./utils');

const ITEM_TAGS = [
    'ClCompile', 'ClInclude', 'None', 'ResourceCompile', 'CustomBuild', 'Midl',
    'Text', 'Image', 'Xml', 'Library', 'Manifest', 'Natvis', 'Page', 'Font',
    'ApplicationDefinition', 'Shader', 'Effect', 'Content', 'EntityDeploy',
    'QtMoc', 'QtRcc', 'QtUic', 'ProjectReference'
];

const KIND_BY_TAG = {
    ClCompile: 'source',
    ClInclude: 'header',
    ResourceCompile: 'resource',
    CustomBuild: 'custom',
    Midl: 'idl',
    Natvis: 'natvis',
    ProjectReference: 'reference'
};

const HEADER_EXT = new Set(['.h', '.hh', '.hpp', '.hxx', '.inl', '.inc', '.ipp']);
const SOURCE_EXT = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++', '.m', '.mm']);

const TAG_ALT = ITEM_TAGS.join('|');

function getAttr(attrs, name) {
    const re = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i');
    const m = re.exec(attrs);
    return m ? m[1] : null;
}

function getElement(body, name) {
    if (!body) {
        return null;
    }
    const re = new RegExp('<' + name + '>\\s*([\\s\\S]*?)\\s*</' + name + '>', 'i');
    const m = re.exec(body);
    return m ? m[1].trim() : null;
}

function toAbsolute(baseDir, include) {
    const p = String(include).trim().replace(/\//g, path.sep);
    if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith(path.sep)) {
        return path.normalize(p);
    }
    return path.normalize(path.resolve(baseDir, p));
}

function kindOf(tag, abs) {
    const byTag = KIND_BY_TAG[tag];
    if (byTag) {
        return byTag;
    }
    const ext = path.extname(abs).toLowerCase();
    if (HEADER_EXT.has(ext)) {
        return 'header';
    }
    if (SOURCE_EXT.has(ext)) {
        return 'source';
    }
    if (ext === '.rc' || ext === '.resx') {
        return 'resource';
    }
    return 'other';
}

/** 取出元素的 body（开始标签结束之后到闭合标签之前） */
function readBody(text, tag, closing, fromIndex) {
    if (closing === '/>') {
        return { body: '', nextIndex: fromIndex };
    }
    const endIdx = text.indexOf('</' + tag + '>', fromIndex);
    if (endIdx < 0) {
        return { body: '', nextIndex: fromIndex };
    }
    return { body: text.slice(fromIndex, endIdx), nextIndex: endIdx + tag.length + 3 };
}

/**
 * 扫描 vcxproj（或 filters）中的所有 item 元素。
 * 先用「Include 紧跟标签名」的快速正则，未命中时回退到通用属性解析。
 */
function scanItems(text, onItem) {
    const fast = new RegExp('<(' + TAG_ALT + ')\\s+Include="([^"]*)"[^>]*?(/>|>)', 'g');
    let count = 0;
    let m;
    while ((m = fast.exec(text)) !== null) {
        count++;
        const read = readBody(text, m[1], m[3], fast.lastIndex);
        onItem(m[1], m[2], read.body);
        fast.lastIndex = read.nextIndex;
    }
    if (count > 0) {
        return;
    }
    const generic = new RegExp('<(' + TAG_ALT + ')\\b([^>]*?)(/>|>)', 'g');
    while ((m = generic.exec(text)) !== null) {
        const include = getAttr(m[2] || '', 'Include');
        if (!include) {
            continue;
        }
        count++;
        const read = readBody(text, m[1], m[3], generic.lastIndex);
        onItem(m[1], include, read.body);
        generic.lastIndex = read.nextIndex;
    }
}

/** 解析 .vcxproj.filters 中的 Filter 分组（CMake 使用 source_group 时才会生成） */
function parseFilters(filtersPath) {
    const map = new Map();
    if (!fs.existsSync(filtersPath)) {
        return map;
    }
    let text;
    try {
        text = fs.readFileSync(filtersPath, 'utf8');
    } catch (e) {
        return map;
    }
    const baseDir = path.dirname(filtersPath);
    scanItems(text, (tag, include, body) => {
        const filter = getElement(body, 'Filter');
        if (filter) {
            map.set(pathKey(toAbsolute(baseDir, include)), filter);
        }
    });
    return map;
}

/**
 * 解析 vcxproj，得到源文件清单与项目引用
 * @param {string} projPath
 * @returns {{files: Array<{abs:string, kind:string, tag:string, filter:string}>, references: Array<{name:string, abs:string}>, stats:Object}}
 */
function parseProjectFile(projPath) {
    const empty = { files: [], references: [], stats: { total: 0, skipped: 0 } };
    if (!projPath || !fs.existsSync(projPath)) {
        return empty;
    }
    let text;
    try {
        text = fs.readFileSync(projPath, 'utf8');
    } catch (e) {
        return empty;
    }

    const baseDir = path.dirname(projPath);
    const filterMap = parseFilters(projPath + '.filters');
    const seen = new Set();
    const files = [];
    const references = [];
    let skipped = 0;

    scanItems(text, (tag, include, body) => {
        if (tag === 'ProjectReference') {
            const abs = toAbsolute(baseDir, include);
            const name = getElement(body, 'Name') || path.basename(abs, path.extname(abs));
            references.push({ name, abs });
            return;
        }

        // 跳过 MSBuild 元数据引用、通配符与未展开的变量
        if (include.includes('%(') || include.includes('*') || include.includes('$(')) {
            skipped++;
            return;
        }

        const abs = toAbsolute(baseDir, include);
        const key = pathKey(abs);
        if (seen.has(key)) {
            return;
        }
        seen.add(key);

        files.push({
            abs,
            kind: kindOf(tag, abs),
            tag,
            filter: filterMap.get(key) || ''
        });
    });

    files.sort((a, b) => path.basename(a.abs).localeCompare(path.basename(b.abs), undefined, { numeric: true, sensitivity: 'base' }));
    references.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return { files, references, stats: { total: files.length, skipped } };
}

module.exports = { parseProjectFile, parseFilters };
