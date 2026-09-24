'use strict';

const fs = require('fs');
const path = require('path');

// 解决方案文件夹（Solution Folder）类型 GUID
const FOLDER_TYPE_GUID = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';

const KNOWN_TYPES = {
    '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}': 'cpp',
    '{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}': 'csharp',
    '{9A19103F-16F7-4668-BE54-9A1E7A4F7556}': 'csharp-sdk',
    '{F184B08F-C81C-45F6-A57F-5ABD9991F28F}': 'vb',
    '{00D1A9C2-B5F0-4AF3-8072-F6C62B433612}': 'database',
    '{A9ACE9BB-CECE-4E62-9AA4-C7E7C5BD2124}': 'wix',
    '{54435603-DBB4-11D2-8724-00A0C9A8B90C}': 'setup'
};

const PROJECT_RE = /^Project\("([^"]+)"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]+)"\s*$/i;
const SECTION_RE = /^ProjectSection\(([^)]*)\)\s*=\s*(\w+)\s*$/i;
const NESTED_RE = /^(\{[0-9a-f-]+\})\s*=\s*(\{[0-9a-f-]+\})$/i;
const SOLUTION_ITEM_RE = /^(.+?)\s*=\s*(.+?)\s*$/;

/**
 * 解析 .sln 文件
 * @param {string} slnPath
 * @returns {{name:string, path:string, dir:string, projects:Array, byGuid:Map, roots:Array, childrenOf:Map, parentOf:Map}}
 */
function parseSolution(slnPath) {
    const text = fs.readFileSync(slnPath, 'utf8').replace(/^﻿/, '');
    const dir = path.dirname(slnPath);
    const projects = [];
    const byGuid = new Map();
    const parentOf = new Map();
    const configurations = [];

    let current = null;
    let section = null;
    let inNested = false;
    let inSolutionConfigs = false;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (inNested) {
            if (/^EndGlobalSection$/i.test(line)) {
                inNested = false;
                continue;
            }
            const m = NESTED_RE.exec(line);
            if (m) {
                parentOf.set(m[1].toUpperCase(), m[2].toUpperCase());
            }
            continue;
        }

        if (inSolutionConfigs) {
            if (/^EndGlobalSection$/i.test(line)) {
                inSolutionConfigs = false;
                continue;
            }
            if (line && !line.startsWith('GlobalSection')) {
                configurations.push(line);
            }
            continue;
        }

        if (/^GlobalSection\(NestedProjects\)/i.test(line)) {
            inNested = true;
            continue;
        }
        if (/^GlobalSection\(SolutionConfigurationPlatforms\)/i.test(line)) {
            inSolutionConfigs = true;
            continue;
        }

        if (/^EndProject$/i.test(line)) {
            current = null;
            section = null;
            continue;
        }

        if (/^EndProjectSection$/i.test(line)) {
            section = null;
            continue;
        }

        if (current && !section) {
            const secMatch = SECTION_RE.exec(line);
            if (secMatch) {
                section = secMatch[1];
                continue;
            }
        }

        if (current && section === 'SolutionItems') {
            const itemMatch = SOLUTION_ITEM_RE.exec(line);
            if (itemMatch && !itemMatch[1].startsWith('ProjectSection')) {
                const raw = itemMatch[1].trim();
                const abs = path.resolve(dir, raw.replace(/\//g, path.sep));
                current.items.push(abs);
            }
            continue;
        }

        const m = PROJECT_RE.exec(line);
        if (m) {
            const typeGuid = m[1].toUpperCase();
            const isFolder = typeGuid === FOLDER_TYPE_GUID;
            const project = {
                typeGuid,
                kind: isFolder ? 'folder' : (KNOWN_TYPES[typeGuid] || 'project'),
                isFolder,
                name: m[2],
                relativePath: m[3],
                guid: m[4].toUpperCase(),
                items: [],
                dependencies: []
            };
            project.projectPath = isFolder
                ? ''
                : path.resolve(dir, project.relativePath.replace(/\//g, path.sep));
            projects.push(project);
            byGuid.set(project.guid, project);
            current = project;
        }
    }

    const childrenOf = new Map();
    const roots = [];
    for (const project of projects) {
        const parentGuid = parentOf.get(project.guid);
        const parent = parentGuid ? byGuid.get(parentGuid) : undefined;
        if (parent) {
            if (!childrenOf.has(parent.guid)) {
                childrenOf.set(parent.guid, []);
            }
            childrenOf.get(parent.guid).push(project);
        } else {
            roots.push(project);
        }
    }

    for (const list of childrenOf.values()) {
        list.sort((a, b) => {
            if (a.isFolder !== b.isFolder) {
                return a.isFolder ? -1 : 1;
            }
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
    }
    roots.sort((a, b) => {
        if (a.isFolder !== b.isFolder) {
            return a.isFolder ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return {
        name: path.basename(slnPath),
        path: slnPath,
        dir,
        projects,
        byGuid,
        roots,
        childrenOf,
        parentOf,
        configurations
    };
}

module.exports = { parseSolution, FOLDER_TYPE_GUID };
