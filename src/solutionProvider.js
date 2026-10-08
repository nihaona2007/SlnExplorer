'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { parseSolution } = require('./slnParser');
const { parseProjectFile } = require('./vcxprojParser');
const { buildContainer, dirHasMatch } = require('./fileTree');
const { HEADER_EXT, SOURCE_EXT } = require('./symbolLocator');
const { pathKey, compareNames, isUnder, commonDirectory, relativeTo, stripExtension } = require('./utils');

const PREDEFINED_FOLDER = 'CMakePredefinedTargets';

class Node extends vscode.TreeItem {
    constructor(label, collapsibleState, nodeType) {
        super(label, collapsibleState);
        this.nodeType = nodeType;
        this.contextValue = nodeType;
        this.parentNode = null;
        this._children = null;
    }
}

class SolutionProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;

        this.solution = null;
        this.solutionPath = '';
        this.filterText = '';
        this.fileIndex = new Map();
        this.matchedProjects = null;
        this.matchedFolders = null;
        this.watcher = null;
        this.diskCache = new Map();
        this.cacheFile = null;
        this._saveTimer = null;
    }

    dispose() {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
        this.flushCache();
        this._onDidChangeTreeData.dispose();
    }

    // ---------------- 项目解析结果缓存（跨会话） ----------------

    async initCache(storageDir) {
        if (!storageDir) {
            return;
        }
        try {
            await fs.promises.mkdir(storageDir, { recursive: true });
        } catch (e) {
            // 忽略
        }
        this.cacheFile = path.join(storageDir, 'projectCache.json');
        try {
            const raw = await fs.promises.readFile(this.cacheFile, 'utf8');
            const obj = JSON.parse(raw);
            for (const key of Object.keys(obj)) {
                this.diskCache.set(key, obj[key]);
            }
        } catch (e) {
            this.diskCache = new Map();
        }
    }

    flushCache() {
        if (!this.cacheFile || !this.diskCache.size) {
            return;
        }
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        try {
            const obj = {};
            for (const [key, value] of this.diskCache) {
                obj[key] = value;
            }
            fs.writeFileSync(this.cacheFile, JSON.stringify(obj));
        } catch (e) {
            // 忽略写入失败
        }
    }

    _scheduleSave() {
        if (!this.cacheFile || this._saveTimer) {
            return;
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.flushCache();
        }, 3000);
        if (this._saveTimer.unref) {
            this._saveTimer.unref();
        }
    }

    // ---------------- 配置 ----------------

    get config() {
        return vscode.workspace.getConfiguration('slnExplorer');
    }

    get showExtensions() {
        return this.config.get('showExtensions', true);
    }

    get showPredefinedTargets() {
        return this.config.get('showPredefinedTargets', false);
    }

    get excludePatterns() {
        return (this.config.get('excludeProjectPatterns', []) || []).map((s) => String(s).toLowerCase());
    }

    // ---------------- 加载 ----------------

    setSolution(slnPath) {
        const parsed = parseSolution(slnPath);
        this.solution = parsed;
        this.solutionPath = slnPath;
        this.fileIndex.clear();
        this.filterText = '';
        this.matchedProjects = null;
        this.matchedFolders = null;
        this._setupWatcher(slnPath);
        this._onDidChangeTreeData.fire();
        return parsed;
    }

    refresh() {
        this.fileIndex.clear();
        this.matchedProjects = null;
        this.matchedFolders = null;
        if (this.solutionPath && fs.existsSync(this.solutionPath)) {
            try {
                this.solution = parseSolution(this.solutionPath);
            } catch (e) {
                // 保留旧结构
            }
        }
        this._onDidChangeTreeData.fire();
    }

    clear() {
        this.solution = null;
        this.solutionPath = '';
        this.fileIndex.clear();
        this._onDidChangeTreeData.fire();
    }

    _setupWatcher(slnPath) {
        if (this.watcher) {
            this.watcher.dispose();
        }
        try {
            this.watcher = vscode.workspace.createFileSystemWatcher(slnPath);
            this.watcher.onDidChange(() => this.refresh());
        } catch (e) {
            this.watcher = null;
        }
    }

    // ---------------- 项目解析 ----------------

    ensureProjectParsed(projectNode) {
        if (projectNode._parsed) {
            return projectNode._parsed;
        }
        const parsed = this._loadProject(projectNode.projectPath);
        parsed.baseDir = this._pickBaseDir(parsed.files, projectNode.projectPath);
        parsed.container = buildContainer(parsed.files, parsed.baseDir);
        projectNode._parsed = parsed;
        this._storeProject(projectNode.projectPath, parsed);
        for (const file of parsed.files) {
            if (!this.fileIndex.has(pathKey(file.abs))) {
                this.fileIndex.set(pathKey(file.abs), { project: projectNode, file });
            }
        }
        return parsed;
    }

    _statOf(filePath) {
        try {
            const stat = fs.statSync(filePath);
            return { m: stat.mtimeMs, s: stat.size };
        } catch (e) {
            return null;
        }
    }

    _loadProject(projPath) {
        const stat = this._statOf(projPath);
        const cached = stat ? this.diskCache.get(projPath) : null;
        if (cached && cached.m === stat.m && cached.s === stat.s) {
            return {
                files: cached.files || [],
                references: cached.references || [],
                stats: cached.stats || { total: 0, skipped: 0 },
                _stat: stat
            };
        }
        const parsed = parseProjectFile(projPath);
        parsed._stat = stat;
        return parsed;
    }

    _storeProject(projPath, parsed) {
        if (!parsed._stat) {
            return;
        }
        this.diskCache.set(projPath, {
            m: parsed._stat.m,
            s: parsed._stat.s,
            files: parsed.files,
            references: parsed.references,
            stats: parsed.stats
        });
        this._scheduleSave();
    }

    _pickBaseDir(files, projectPath) {
        if (!files.length) {
            return path.dirname(projectPath || '.');
        }
        const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : '';
        if (root && files.every((f) => isUnder(root, f.abs))) {
            return root;
        }
        return commonDirectory(files.map((f) => f.abs)) || path.dirname(files[0].abs);
    }

    /** 解析全部项目，用于筛选与“定位当前文件” */
    async ensureAllParsed() {
        if (!this.solution) {
            return;
        }
        const targets = this.solution.projects.filter((p) => !p.isFolder && p.projectPath);
        const pending = targets.filter((p) => !p._node || !p._node._parsed);
        if (!pending.length) {
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: '正在解析解决方案中的项目…', cancellable: false },
            async () => {
                // 先确保项目节点存在（用于索引归属）
                let index = 0;
                for (const project of pending) {
                    const node = this.projectNodeFor(project);
                    this.ensureProjectParsed(node);
                    if (++index % 10 === 0) {
                        await new Promise((resolve) => setTimeout(resolve, 0));
                    }
                }
            }
        );
    }

    /**
     * 只解析「内容中包含关键字」的项目：先并发读取 vcxproj 文本粗筛，再完整解析命中的项目。
     * 用于筛选与定位，避免每次都全量解析上百个项目。
     */
    async _resolveProjectsContaining(keyword) {
        if (!this.solution || !keyword) {
            return;
        }
        const targets = this.solution.projects.filter(
            (p) => !p.isFolder && p.projectPath && (!p._node || !p._node._parsed)
        );
        if (!targets.length) {
            return;
        }
        const lower = String(keyword).toLowerCase();
        const CONCURRENCY = 8;
        const hits = [];
        for (let i = 0; i < targets.length; i += CONCURRENCY) {
            const batch = targets.slice(i, i + CONCURRENCY);
            const texts = await Promise.all(
                batch.map((p) => fs.promises.readFile(p.projectPath, 'utf8').catch(() => ''))
            );
            for (let j = 0; j < batch.length; j++) {
                if (texts[j] && texts[j].toLowerCase().includes(lower)) {
                    hits.push(batch[j]);
                }
            }
        }
        for (const project of hits) {
            this.ensureProjectParsed(this.projectNodeFor(project));
        }
    }

    /** 建立索引：优先按关键字粗筛，无法确定时再全量解析 */
    async _ensureIndex(keyword) {
        await this._resolveProjectsContaining(keyword);
        if (!this.fileIndex.size) {
            await this.ensureAllParsed();
        }
    }

    projectNodeFor(project) {
        if (!project._node) {
            project._node = this._createProjectNode(project);
        }
        return project._node;
    }

    // ---------------- 节点构建 ----------------

    _createSolutionNode() {
        const node = new Node(this.solution.name, vscode.TreeItemCollapsibleState.Expanded, 'solution');
        node.id = 'solution';
        node.resourceUri = vscode.Uri.file(this.solution.path);
        node.tooltip = this.solution.path;
        node.iconPath = new vscode.ThemeIcon('library');
        const count = this.solution.projects.filter((p) => !p.isFolder).length;
        node.description = `${count} 个项目`;
        return node;
    }

    _createProjectNode(project) {
        if (project._node) {
            return project._node;
        }
        const node = new Node(project.name, vscode.TreeItemCollapsibleState.Collapsed, 'project');
        node.id = 'project:' + project.guid;
        node.project = project;
        node.projectPath = project.projectPath;
        node.guid = project.guid;
        node.tooltip = project.projectPath || project.name;
        node.iconPath = new vscode.ThemeIcon('package');
        project._node = node;
        return node;
    }

    _createFolderNode(folder) {
        if (folder._node) {
            return folder._node;
        }
        const node = new Node(folder.name, vscode.TreeItemCollapsibleState.Collapsed, 'folder');
        node.id = 'folder:' + folder.guid;
        node.folder = folder;
        node.guid = folder.guid;
        node.tooltip = folder.name;
        node.iconPath = new vscode.ThemeIcon('folder');
        folder._node = node;
        return node;
    }

    _createFileNode(file, projectNode, parentNode, labelPrefix) {
        const abs = file.abs;
        let label = path.basename(abs);
        if (!this.showExtensions) {
            label = stripExtension(label);
        }
        if (labelPrefix) {
            label = labelPrefix;
        }
        const node = new Node(label, vscode.TreeItemCollapsibleState.None, 'file');
        node.id = projectNode.guid + '|f|' + pathKey(abs);
        node.resourceUri = vscode.Uri.file(abs);
        node.absPath = abs;
        node.file = file;
        node.tooltip = abs;
        node.parentNode = parentNode;
        node.command = {
            command: 'slnExplorer.openFile',
            title: '打开文件',
            arguments: [abs]
        };
        return node;
    }

    _createGroupNode(dirNode, baseDir, projectNode, parentNode) {
        const node = new Node(dirNode.name, vscode.TreeItemCollapsibleState.Collapsed, 'group');
        node.id = projectNode.guid + '|d|' + dirNode.relPath.toLowerCase();
        const abs = path.join(baseDir, dirNode.relPath.split('/').join(path.sep));
        node.resourceUri = vscode.Uri.file(abs);
        node.absPath = abs;
        node.container = dirNode;
        node.baseDir = baseDir;
        node.projectNode = projectNode;
        node.tooltip = abs;
        node.parentNode = parentNode;
        return node;
    }

    _nodesFromContainer(container, baseDir, projectNode, parentNode, filter) {
        const nodes = [];
        const dirs = [...container.dirs.values()].sort((a, b) => compareNames(a.name, b.name));
        for (const dir of dirs) {
            if (filter && !dirHasMatch(dir, filter)) {
                continue;
            }
            nodes.push(this._createGroupNode(dir, baseDir, projectNode, parentNode));
        }
        const files = container.files
            .filter((f) => !filter || pathKey(f.abs).includes(filter))
            .sort((a, b) => compareNames(path.basename(a.abs), path.basename(b.abs)));
        for (const file of files) {
            const label = filter
                ? (relativeTo(baseDir, file.abs) || path.basename(file.abs))
                : undefined;
            nodes.push(this._createFileNode(file, projectNode, parentNode, label));
        }
        return nodes;
    }

    // ---------------- TreeDataProvider ----------------

    getTreeItem(element) {
        return element;
    }

    getParent(element) {
        return element.parentNode || undefined;
    }

    getChildren(element) {
        if (!element) {
            if (!this.solution) {
                return [this._createPlaceholder()];
            }
            if (!this._root || this._root._solutionPath !== this.solutionPath) {
                this._root = this._createSolutionNode();
                this._root._solutionPath = this.solutionPath;
                this._root._children = null;
            }
            return [this._root];
        }

        if (element._children) {
            return element._children;
        }

        let children = [];
        switch (element.nodeType) {
            case 'solution':
                children = this._getSolutionChildren();
                break;
            case 'folder':
                children = this._getFolderChildren(element);
                break;
            case 'project':
                children = this._getProjectChildren(element);
                break;
            case 'group':
                children = this._nodesFromContainer(
                    element.container, element.baseDir, element.projectNode, element, this.filterText
                );
                break;
            case 'references':
                children = element._refNodes || [];
                break;
            default:
                children = [];
        }
        element._children = children;
        for (const child of children) {
            if (!child.parentNode) {
                child.parentNode = element;
            }
        }
        return children;
    }

    _createPlaceholder() {
        const node = new Node('点击工具栏按钮选择 .sln 解决方案', vscode.TreeItemCollapsibleState.None, 'welcome');
        node.iconPath = new vscode.ThemeIcon('info');
        node.command = {
            command: 'slnExplorer.selectSolution',
            title: '选择解决方案',
            arguments: []
        };
        return node;
    }

    _getSolutionChildren() {
        const filter = this.filterText;
        const nodes = [];
        for (const item of this.solution.roots) {
            if (this._isHidden(item)) {
                continue;
            }
            if (filter && item.isFolder && this.matchedFolders && !this.matchedFolders.has(item.guid)) {
                continue;
            }
            if (filter && !item.isFolder && this.matchedProjects && !this.matchedProjects.has(item.guid)) {
                continue;
            }
            nodes.push(this._toNode(item));
        }
        return nodes;
    }

    _toNode(project) {
        return project.isFolder ? this._createFolderNode(project) : this.projectNodeFor(project);
    }

    _isHidden(project) {
        const patterns = this.excludePatterns;
        if (patterns.length && patterns.some((p) => project.name.toLowerCase().includes(p))) {
            return true;
        }
        if (!this.showPredefinedTargets && project.name === PREDEFINED_FOLDER) {
            return true;
        }
        return false;
    }

    _getFolderChildren(folderNode) {
        const folder = folderNode.folder;
        const filter = this.filterText;
        const nodes = [];
        for (const child of this.solution.childrenOf.get(folder.guid) || []) {
            if (this._isHidden(child)) {
                continue;
            }
            if (filter && child.isFolder && this.matchedFolders && !this.matchedFolders.has(child.guid)) {
                continue;
            }
            if (filter && !child.isFolder && this.matchedProjects && !this.matchedProjects.has(child.guid)) {
                continue;
            }
            nodes.push(this._toNode(child));
        }
        // 解决方案文件夹下挂载的零散文件（SolutionItems）
        for (const abs of folder.items || []) {
            if (filter && !pathKey(abs).includes(filter)) {
                continue;
            }
            let label = path.basename(abs);
            if (!this.showExtensions) {
                label = stripExtension(label);
            }
            const node = new Node(label, vscode.TreeItemCollapsibleState.None, 'file');
            node.id = folder.guid + '|i|' + pathKey(abs);
            node.resourceUri = vscode.Uri.file(abs);
            node.absPath = abs;
            node.tooltip = abs;
            node.parentNode = folderNode;
            node.command = { command: 'slnExplorer.openFile', title: '打开文件', arguments: [abs] };
            nodes.push(node);
        }
        return nodes;
    }

    _getProjectChildren(projectNode) {
        const parsed = this.ensureProjectParsed(projectNode);
        const filter = this.filterText;
        const nodes = this._nodesFromContainer(parsed.container, parsed.baseDir, projectNode, projectNode, filter);
        if (!filter && parsed.references.length) {
            const refGroup = new Node('引用', vscode.TreeItemCollapsibleState.Collapsed, 'references');
            refGroup.id = projectNode.guid + '|refs';
            refGroup.iconPath = new vscode.ThemeIcon('list-unordered');
            refGroup.parentNode = projectNode;
            refGroup._refNodes = parsed.references.map((ref) => {
                const node = new Node(ref.name, vscode.TreeItemCollapsibleState.None, 'reference');
                node.id = projectNode.guid + '|r|' + pathKey(ref.abs);
                node.resourceUri = vscode.Uri.file(ref.abs);
                node.absPath = ref.abs;
                node.tooltip = ref.abs;
                node.parentNode = refGroup;
                node.command = { command: 'slnExplorer.openFile', title: '打开项目文件', arguments: [ref.abs] };
                return node;
            });
            nodes.push(refGroup);
        }
        return nodes;
    }

    // ---------------- 筛选 ----------------

    async setFilter(text) {
        this.filterText = (text || '').trim().toLowerCase();
        this._resetChildrenCache();
        if (this.filterText) {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在筛选…', cancellable: false },
                () => this._ensureIndex(this.filterText)
            );
            this._computeMatches();
        } else {
            this.matchedProjects = null;
            this.matchedFolders = null;
        }
        vscode.commands.executeCommand('setContext', 'slnExplorer.hasFilter', !!this.filterText);
        this._onDidChangeTreeData.fire();
    }

    _resetChildrenCache() {
        if (!this.solution) {
            return;
        }
        const stack = [this._root];
        while (stack.length) {
            const node = stack.pop();
            if (!node || !node._children) {
                continue;
            }
            for (const child of node._children) {
                stack.push(child);
            }
            node._children = null;
        }
    }

    _computeMatches() {
        const filter = this.filterText;
        const projects = new Set();
        const folders = new Set();
        const addWithParents = (guid) => {
            let parentGuid = this.solution.parentOf.get(guid);
            while (parentGuid) {
                folders.add(parentGuid);
                parentGuid = this.solution.parentOf.get(parentGuid);
            }
        };
        // 项目名命中：整个项目视为匹配
        for (const project of this.solution.projects) {
            if (!project.isFolder && project.name.toLowerCase().includes(filter)) {
                projects.add(project.guid);
                addWithParents(project.guid);
            }
        }
        for (const entry of this.fileIndex.values()) {
            if (!pathKey(entry.file.abs).includes(filter)) {
                continue;
            }
            const project = entry.project.project;
            projects.add(project.guid);
            addWithParents(project.guid);
        }
        this.matchedProjects = projects;
        this.matchedFolders = folders;
    }

    // ---------------- 符号跳转支持 ----------------

    /** 找到文件所属的项目节点（用于限定符号搜索范围） */
    async projectForFile(abs) {
        const key = pathKey(abs);
        if (!this._fileProject) {
            this._fileProject = new Map();
        }
        if (this._fileProject.has(key)) {
            return this._fileProject.get(key);
        }
        let entry = this.fileIndex.get(key);
        if (!entry) {
            // 启发式：项目名常出现在源文件路径里（如 Source/MyLib/... → MyLib.vcxproj）
            const lower = pathKey(abs);
            const candidates = this.solution.projects
                .filter((p) => !p.isFolder && p.projectPath && p.name.length >= 3 && lower.includes(p.name.toLowerCase()))
                .sort((a, b) => b.name.length - a.name.length)
                .slice(0, 5);
            for (const candidate of candidates) {
                const node = this.projectNodeFor(candidate);
                const parsed = this.ensureProjectParsed(node);
                if (parsed.files.some((f) => pathKey(f.abs) === key)) {
                    entry = { project: node, file: parsed.files.find((f) => pathKey(f.abs) === key) };
                    break;
                }
            }
        }
        if (!entry) {
            await this._resolveProjectsContaining(abs);
            entry = this.fileIndex.get(key);
        }
        if (!entry) {
            // 大小写/相对路径写法差异：按文件名再筛一次
            await this._resolveProjectsContaining(path.basename(abs));
            entry = this.fileIndex.get(key);
        }
        if (entry) {
            this._fileProject.set(key, entry.project);
        }
        return entry ? entry.project : null;
    }

    /** 符号搜索的候选文件（已按“配对文件 → 同目录 → 其他”排序） */
    async candidateFilesFor(abs) {
        const project = await this.projectForFile(abs);
        let files;
        if (project) {
            files = this.ensureProjectParsed(project).files.slice();
        } else {
            files = await listSourceFilesNear(abs, 150);
        }
        const ext = path.extname(abs).toLowerCase();
        const stem = path.basename(abs, ext).toLowerCase();
        const dir = pathKey(path.dirname(abs));
        const fromHeader = HEADER_EXT.has(ext);
        const score = (f) => {
            const fExt = path.extname(f.abs).toLowerCase();
            const fStem = path.basename(f.abs, fExt).toLowerCase();
            let s = 10;
            if (fStem === stem && fExt !== ext) {
                s = 0;
            } else if (pathKey(path.dirname(f.abs)) === dir) {
                s = 4;
            }
            if (fromHeader && SOURCE_EXT.has(fExt)) {
                s -= 1;
            } else if (!fromHeader && HEADER_EXT.has(fExt)) {
                s -= 1;
            }
            return s;
        };
        files.sort((a, b) => score(a) - score(b));
        return files;
    }

    /** 当前项目没找到时，扩展到被引用项目的头文件 */
    /** 解决方案内所有项目的源文件（去重）。用于 solution 级引用搜索 */
    async solutionFiles() {
        if (!this.solution) {
            return [];
        }
        await this.ensureAllParsed();
        const seen = new Set();
        const out = [];
        for (const p of this.solution.projects) {
            if (p.isFolder || !p.projectPath) {
                continue;
            }
            const parsed = this.ensureProjectParsed(this.projectNodeFor(p));
            for (const f of parsed.files) {
                const key = pathKey(f.abs);
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                out.push(f);
            }
        }
        return out;
    }

    async dependentFilesFor(project) {
        const parsed = this.ensureProjectParsed(project);
        const out = [];
        const byName = new Map();
        const byPath = new Map();
        for (const p of this.solution.projects) {
            if (p.isFolder) {
                continue;
            }
            byName.set(p.name.toLowerCase(), p);
            if (p.projectPath) {
                byPath.set(pathKey(p.projectPath), p);
            }
        }
        for (const ref of parsed.references.slice(0, 20)) {
            const target = byPath.get(pathKey(ref.abs)) || byName.get(ref.name.toLowerCase());
            if (!target || target === project) {
                continue;
            }
            const refParsed = this.ensureProjectParsed(this.projectNodeFor(target));
            for (const file of refParsed.files) {
                if (out.length >= 250) {
                    return out;
                }
                if (HEADER_EXT.has(path.extname(file.abs).toLowerCase())) {
                    out.push(file);
                }
            }
        }
        return out;
    }

    // ---------------- 定位 ----------------

    async findFileNode(absPath) {
        if (!this.solution) {
            return null;
        }
        const key = pathKey(absPath);
        let entry = this.fileIndex.get(key);
        if (!entry) {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在定位文件…', cancellable: false },
                () => this._ensureIndex(absPath)
            );
            entry = this.fileIndex.get(key);
        }
        if (!entry) {
            // 大小写/相对路径写法差异导致粗筛未命中，最后兜底全量解析
            await this.ensureAllParsed();
            entry = this.fileIndex.get(key);
        }
        if (!entry) {
            return null;
        }
        const projectNode = entry.project;
        const parsed = this.ensureProjectParsed(projectNode);
        const rel = relativeTo(parsed.baseDir, absPath);
        let current = projectNode;
        let container = parsed.container;
        if (rel && rel.includes('/')) {
            const segs = rel.split('/');
            for (let i = 0; i < segs.length - 1; i++) {
                const seg = segs[i];
                const dir = container.dirs.get(seg);
                if (!dir) {
                    return null;
                }
                const children = this.getChildren(current);
                const next = children.find((c) => c.nodeType === 'group' && c.container === dir);
                if (!next) {
                    return null;
                }
                current = next;
                container = dir;
            }
        }
        const children = this.getChildren(current);
        return children.find((c) => c.nodeType === 'file' && pathKey(c.absPath) === key) || null;
    }
}

/** 文件不属于任何项目时的兜底：取同目录的源文件 */
async function listSourceFilesNear(abs, limit) {
    const dir = path.dirname(abs);
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const files = [];
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }
            const ext = path.extname(entry.name).toLowerCase();
            if (HEADER_EXT.has(ext) || SOURCE_EXT.has(ext)) {
                files.push({ abs: path.join(dir, entry.name) });
                if (files.length >= limit) {
                    break;
                }
            }
        }
        return files;
    } catch (e) {
        return [];
    }
}

module.exports = { SolutionProvider, Node };
