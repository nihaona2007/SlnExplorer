'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { SolutionProvider } = require('./src/solutionProvider');
const { findSolutionFiles, resolvePathTemplate } = require('./src/utils');
const { findSymbols, symbolAt } = require('./src/symbolLocator');

const STATE_KEY = 'slnExplorer.lastSolution';
const CPP_SELECTOR = [
    { language: 'cpp' },
    { language: 'c' },
    { language: 'objective-cpp' },
    { language: 'objective-c' }
];

let provider = null;
let treeView = null;
let extContext = null;
let outChannel = null;

function log(message) {
    if (!outChannel) {
        outChannel = vscode.window.createOutputChannel('SLN Explorer');
    }
    outChannel.appendLine(message);
}

/** 注册命令：ID 被其他版本插件占用时不抛错，避免 activate 整体中断 */
function safeRegister(context, id, fn) {
    try {
        const disposable = vscode.commands.registerCommand(id, fn);
        context.subscriptions.push(disposable);
        return disposable;
    } catch (e) {
        log(`命令注册失败（ID 可能已被同名插件占用）：${id} -> ${e.message || e}`);
        return null;
    }
}

/** 注册语言能力：放在命令之前，保证 Ctrl+左键 / F12 一定可用 */
function registerLanguageProviders(context) {
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(CPP_SELECTOR, {
            async provideDefinition(document, position) {
                if (!vscode.workspace.getConfiguration('slnExplorer').get('enableDefinitionProvider', true)) {
                    return null;
                }
                return toLocations(await locateSymbol(document, position, {}));
            }
        }),
        vscode.languages.registerImplementationProvider(CPP_SELECTOR, {
            async provideImplementation(document, position) {
                return toLocations(await locateSymbol(document, position, { onlyKinds: ['implementation'] }));
            }
        })
    );
    log('已注册 C/C++ 定义/实现提供者（Ctrl+左键、F12）');
}

async function activate(context) {
    extContext = context;
    provider = new SolutionProvider();
    // 跳转能力优先注册，不受后续命令冲突影响
    registerLanguageProviders(context);
    try {
        await provider.initCache(context.globalStorageUri ? context.globalStorageUri.fsPath : '');
    } catch (e) {
        // 缓存不可用时使用纯内存解析
    }
    context.subscriptions.push(provider);

    treeView = vscode.window.createTreeView('slnExplorerView', {
        treeDataProvider: provider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    vscode.commands.executeCommand('setContext', 'slnExplorer.hasFilter', false);

    safeRegister(context, 'slnExplorer.selectSolution', () => selectSolution(context));
    safeRegister(context, 'slnExplorer.refresh', () => {
        if (!provider.solutionPath) {
            return selectSolution(context);
        }
        provider.refresh();
    });
    safeRegister(context, 'slnExplorer.openSolution', async (uri) => {
        let target = uri && uri.fsPath ? uri.fsPath : null;
        if (target && /\.sln$/i.test(target)) {
            try {
                provider.setSolution(target);
                await context.workspaceState.update(STATE_KEY, target);
            } catch (e) {
                vscode.window.showErrorMessage(`解析解决方案失败：${e.message || e}`);
                return;
            }
        } else {
            target = await selectSolution(context);
        }
        if (target && treeView) {
            const roots = provider.getChildren();
            if (roots && roots.length) {
                await treeView.reveal(roots[0], { focus: true, expand: 1 });
            }
        }
    });
    safeRegister(context, 'slnExplorer.filter', () => setFilter());
    safeRegister(context, 'slnExplorer.clearFilter', () => provider.setFilter(''));
    safeRegister(context, 'slnExplorer.revealCurrentFile', (uri) => revealFile(uri));
    safeRegister(context, 'slnExplorer.openFile', (filePath) => openFile(filePath));
    safeRegister(context, 'slnExplorer.openProjectFile', (node) => {
        const target = node && (node.projectPath || node.absPath);
        if (target) {
            return openFile(target);
        }
    });
    safeRegister(context, 'slnExplorer.revealInExplorer', (node, nodes) => {
        const target = pickNode(node, nodes);
        if (target && target.absPath) {
            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target.absPath));
        }
    });
    safeRegister(context, 'slnExplorer.revealFileInOS', (node, nodes) => {
        const target = pickNode(node, nodes);
        if (target && target.absPath) {
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target.absPath));
        }
    });
    safeRegister(context, 'slnExplorer.copyPath', (node, nodes) => {
        const target = pickNode(node, nodes);
        if (target && target.absPath) {
            vscode.env.clipboard.writeText(target.absPath);
        }
    });
    safeRegister(context, 'slnExplorer.copyRelativePath', (node, nodes) => {
        const target = pickNode(node, nodes);
        if (target && target.absPath) {
            vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(target.absPath));
        }
    });
    safeRegister(context, 'slnExplorer.goToSymbol', () => goToSymbol());

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('slnExplorer')) {
                provider.refresh();
            }
        })
    );

    autoSelect(context);
}

function pickNode(node, nodes) {
    if (node && node.absPath) {
        return node;
    }
    if (Array.isArray(nodes) && nodes.length && nodes[0].absPath) {
        return nodes[0];
    }
    return node;
}

function getWorkspaceFolders() {
    return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

async function autoSelect(context) {
    const folders = getWorkspaceFolders();
    if (!folders.length) {
        return;
    }
    const configured = resolvePathTemplate(
        vscode.workspace.getConfiguration('slnExplorer').get('solutionPath', ''),
        folders[0]
    );
    if (configured && fs.existsSync(configured)) {
        provider.setSolution(configured);
        return;
    }
    const remembered = context.workspaceState.get(STATE_KEY);
    if (remembered && fs.existsSync(remembered)) {
        provider.setSolution(remembered);
        return;
    }
    const depth = vscode.workspace.getConfiguration('slnExplorer').get('searchDepth', 6);
    const found = findSolutionFiles(folders, depth);
    // 大仓库里可能有多个 sln，取体积最大的（通常是 CMake 生成的主解决方案）
    if (found.length) {
        log(`自动加载解决方案：${found[0].path}`);
        provider.setSolution(found[0].path);
    }
}

async function selectSolution(context) {
    const folders = getWorkspaceFolders();
    const depth = vscode.workspace.getConfiguration('slnExplorer').get('searchDepth', 6);
    const found = findSolutionFiles(folders, depth);

    const items = found.map((item) => ({
        label: path.basename(item.path),
        description: vscode.workspace.asRelativePath(item.path),
        detail: item.path,
        slnPath: item.path
    }));
    items.push({ label: '浏览本地文件…', description: '从磁盘中选择 .sln', slnPath: null });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: folders.length ? '选择要打开的解决方案' : '请先打开一个文件夹'
    });
    if (!picked) {
        return null;
    }

    let target = picked.slnPath;
    if (!target) {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { '解决方案文件': ['sln'], '所有文件': ['*'] }
        });
        if (!uris || !uris.length) {
            return null;
        }
        target = uris[0].fsPath;
    }

    try {
        provider.setSolution(target);
        await context.workspaceState.update(STATE_KEY, target);
        vscode.window.setStatusBarMessage(`已加载解决方案：${path.basename(target)}`, 4000);
        return target;
    } catch (e) {
        vscode.window.showErrorMessage(`解析解决方案失败：${e.message || e}`);
        return null;
    }
}

async function setFilter() {
    if (!provider.solution) {
        await selectSolution(getContextSafely());
        if (!provider.solution) {
            return;
        }
    }
    const value = await vscode.window.showInputBox({
        prompt: '输入文件名关键字（留空清除筛选）',
        value: provider.filterText,
        placeHolder: '例如：Renderer（文件名关键字）'
    });
    if (value === undefined) {
        return;
    }
    await provider.setFilter(value);
}

function getContextSafely() {
    return extContext;
}

async function revealFile(uriArg) {
    const uri = uriArg && uriArg.fsPath
        ? uriArg
        : (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : null);
    if (!uri || uri.scheme !== 'file') {
        vscode.window.showInformationMessage('没有可定位的文件。');
        return;
    }
    if (!provider.solution) {
        await selectSolution(getContextSafely());
        if (!provider.solution) {
            return;
        }
    }
    const node = await provider.findFileNode(uri.fsPath);
    if (!node) {
        vscode.window.showInformationMessage(`当前解决方案中没有包含该文件：${path.basename(uri.fsPath)}`);
        return;
    }
    await treeView.reveal(node, { focus: true, select: true, expand: true });
}

async function openFile(filePath) {
    if (!filePath) {
        return;
    }
    if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`文件不存在：${filePath}`);
        return;
    }
    try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
        vscode.window.showErrorMessage(`打开失败：${e.message || e}`);
    }
}

// ---------------- 符号跳转 ----------------

async function locateSymbol(document, position, options) {
    if (!provider || !provider.solution || document.uri.scheme !== 'file') {
        log(`跳转失败：${!provider ? '插件未初始化' : '解决方案尚未加载'}（${document.uri.fsPath}）`);
        return [];
    }
    const t0 = Date.now();
    const symbol = symbolAt(document, position);
    if (!symbol || !symbol.name) {
        log(`跳转失败：光标处没有取到符号（${document.uri.fsPath}:${position.line + 1}）`);
        return [];
    }
    const budget = vscode.workspace.getConfiguration('slnExplorer').get('definitionSearchBudgetMs', 1200);
    const currentFile = document.uri.fsPath;
    const files = await provider.candidateFilesFor(currentFile);
    const base = {
        name: symbol.name,
        qualifier: symbol.qualifier,
        maxFiles: 150,
        budgetMs: budget,
        onlyKinds: options && options.onlyKinds ? options.onlyKinds : null,
        currentFile,
        currentLine: position.line
    };
    let results = findSymbols(Object.assign({ files }, base));

    // 当前项目里没找到像样的定义时，扩展到被引用的项目
    const good = results.some((r) => r.kind === 'implementation' || r.kind === 'declaration' || r.kind === 'type');
    if (!good) {
        const project = await provider.projectForFile(currentFile);
        if (project) {
            const extra = await provider.dependentFilesFor(project);
            if (extra.length) {
                results = results.concat(findSymbols(Object.assign({ files: extra }, base)));
                results.sort((a, b) => a.score - b.score || a.line - b.line);
            }
        }
    }
    log(`查找 ${symbol.name}：候选 ${files.length} 个文件，命中 ${results.length} 处，用时 ${Date.now() - t0}ms`);
    return results;
}

function toLocation(result) {
    return new vscode.Location(
        vscode.Uri.file(result.abs),
        new vscode.Position(result.line, result.column)
    );
}

/** 唯一高分结果直接跳转，否则交给 VS Code 的 peek 列表 */
function toLocations(results) {
    if (!results || !results.length) {
        return null;
    }
    const best = results[0];
    const ties = results.filter((r) => Math.abs(r.score - best.score) <= 4);
    if (ties.length === 1) {
        return [toLocation(best)];
    }
    return results.slice(0, 8).map(toLocation);
}

async function jumpTo(result) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.abs));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(result.line, result.column);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function goToSymbol() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const symbol = symbolAt(editor.document, editor.selection.active);
    const results = await locateSymbol(editor.document, editor.selection.active, {});
    if (!results.length) {
        vscode.window.showInformationMessage(
            `未在当前解决方案中找到 ${symbol ? symbol.name : '该符号'} 的定义/实现`
        );
        return;
    }
    if (results.length === 1) {
        await jumpTo(results[0]);
        return;
    }
    const items = results.slice(0, 30).map((r) => ({
        label: `${vscode.workspace.asRelativePath(r.abs)}:${r.line + 1}`,
        description: r.kind === 'implementation' ? '实现' : (r.kind === 'declaration' ? '声明' : r.kind),
        detail: r.preview,
        result: r
    }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `跳转到 ${symbol ? symbol.name : ''} 的定义/实现`,
        matchOnDetail: true
    });
    if (picked) {
        await jumpTo(picked.result);
    }
}

function deactivate() {
    if (provider) {
        provider.dispose();
        provider = null;
    }
}

module.exports = { activate, deactivate };
