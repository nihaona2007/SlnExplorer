# C++ 解决方案浏览器 (SLN)

在 VS Code / CodeBuddy / Cursor 中，按 **CMake 生成的 `.sln` 解决方案结构** 浏览 C++ 工程，并提供基于项目清单的符号跳转。

解决的问题：CMake 生成的工程里，物理目录（`build/`、`CMakeFiles/`、中间产物）和代码组织毫无关系；而资源管理器只会按物理目录展开。本插件直接还原 Visual Studio「解决方案资源管理器」的视图。

```
MySolution (解决方案)
└─ Core                     ← 解决方案文件夹（sln 中的 Solution Folder）
   └─ Render
      └─ MyRenderer         ← 项目（.vcxproj）
         ├─ Common          ← 筛选器 / 虚拟目录（Filter 或按相对路径生成）
         │  └─ Renderer.cpp
         ├─ Renderer.h
         └─ 引用             ← 项目依赖（ProjectReference）
```

## 功能

- **还原解决方案层级**：解析 `.sln` 的 `Project`、`SolutionItems`、`NestedProjects`，还原解决方案文件夹的父子层级，而不是物理目录。
- **按项目查看源文件**：解析每个 `.vcxproj` 的 `ClCompile / ClInclude / None / CustomBuild …`，有 `.vcxproj.filters` 时按筛选器分组（对应 CMake 的 `source_group`），否则按文件相对路径生成目录树。
- **项目依赖**：项目下的「引用」节点列出 `ProjectReference`（包含 VS 生成器写进 vcxproj 的依赖）。
- **筛选与定位**：按文件名关键字筛选整棵解决方案树；一键把当前编辑的文件在树中展开定位。
- **跳转定义 / 实现**：Ctrl+左键（或 F12）跳定义，Ctrl+F12 只跳实现，编辑器右键「跳转到定义/实现」列出全部候选。
- **懒加载 + 磁盘缓存**：项目只在展开时才解析，结果按文件 mtime/size 缓存到磁盘，大解决方案二次打开无感。
- **零依赖**：不调用 MSBuild、不需要 cpptools、不需要 `compile_commands.json`，纯文本解析。

## 安装

- 从插件市场搜索 **C++ 解决方案浏览器 (SLN)** 安装；
- 离线安装：在插件目录执行 `npm i -g @vscode/vsce && vsce package` 得到 `.vsix`，再用 IDE 的「从 VSIX 安装」；
- 手动部署：把插件目录复制到 IDE 的扩展目录（如 VS Code 的 `~/.vscode/extensions/sln-explorer/`）后重启。

## 快速开始

1. 打开工作区后，侧边栏「资源管理器」底部出现视图 **解决方案 (SLN)**。
2. 插件自动在工作区中查找 `.sln`（含被 gitignore 的 `build/` 目录），多个时取体积最大的那个；也可以用标题栏第一个按钮手动选择。
3. 单击文件节点打开；右键提供：打开 `.vcxproj`、在资源管理器中显示、在文件管理器中打开、复制（相对）路径。

## 跳转说明

搜索范围与优先级：

1. 先在该文件**所属项目**的源文件清单内查找；没找到像样的结果时，扩展到**被引用项目**的头文件。
2. 命中类型优先级：函数实现 → 类型/类 → 函数声明 → 变量 → 宏。
3. 同名 `.h/.cpp` 互相优先；`Class::method` 会优先匹配限定名一致的结果。
4. 结果唯一时直接跳转；多个时弹出 peek 列表供选择。

这是**文本级**跳转，不做语义分析与重载解析，因此能覆盖 IntelliSense 不可用（缺少编译数据库）的场景；反过来，若你已装好 cpptools/clangd + `compile_commands.json`，可把 `slnExplorer.enableDefinitionProvider` 设为 `false` 交给它们。

排查：输出面板 → `SLN Explorer`，会记录解决方案加载、命令注册情况以及每次查找的候选文件数与命中数。

## 命令

| 命令 | 说明 |
| --- | --- |
| `SLN: 选择解决方案 (.sln)` | 手动切换要加载的解决方案 |
| `SLN: 刷新解决方案` | 重新解析（CMake 重新生成后使用） |
| `SLN: 在解决方案中定位当前文件` | 在树中展开并选中当前文件 |
| `SLN: 在解决方案中筛选文件` / `清除筛选` | 文件名关键字筛选 |
| `SLN: 跳转到定义/实现` | 以列表方式展示全部候选 |
| `SLN: 打开项目文件 (.vcxproj)` | 打开项目文件本身 |

## 配置

| 配置项 | 说明 |
| --- | --- |
| `slnExplorer.solutionPath` | 指定 `.sln`，支持 `${workspaceFolder}`；留空自动查找 |
| `slnExplorer.showExtensions` | 文件节点是否显示扩展名，默认 `true` |
| `slnExplorer.showPredefinedTargets` | 是否显示 `CMakePredefinedTargets`（ALL_BUILD / ZERO_CHECK / INSTALL），默认 `false` |
| `slnExplorer.excludeProjectPatterns` | 隐藏匹配项目名的项，如 `["ALL_BUILD","ZERO_CHECK","INSTALL"]` |
| `slnExplorer.searchDepth` | 自动查找 `.sln` 的递归深度，默认 `6` |
| `slnExplorer.enableDefinitionProvider` | 是否注册 Ctrl+左键跳转，默认 `true` |
| `slnExplorer.definitionSearchBudgetMs` | 符号搜索时间预算（毫秒），默认 `1200` |

## 工作原理

- `src/slnParser.js`：逐行解析 `.sln`，还原解决方案文件夹层级。
- `src/vcxprojParser.js`：解析 `.vcxproj` 与 `.vcxproj.filters`，跳过 `%(...)`、通配符与未展开的 `$(...)` 变量。
- `src/solutionProvider.js`：`TreeDataProvider`，懒加载 + 文件路径索引 + 磁盘缓存。
- `src/symbolLocator.js`：基于正则的符号定位（实现/声明/类型/变量/宏），带关键字粗筛、调用上下文过滤与时间预算。

## 已知限制

- 跳转是文本级实现，不做语义/重载解析，多处命中时给出候选列表。
- 只解析文件清单与引用，不提供补全、诊断等 IntelliSense 能力。
- 主要针对 CMake + Visual Studio 生成器产物；Makefile / Ninja 生成器不产出 `.sln`，本插件不适用（这类工程请用 `compile_commands.json` + clangd）。

## 更新日志

见插件包内的 `CHANGELOG.md`，或插件详情页的「更新日志」。

## 作者与许可

作者：shiyp-a　·　许可：MIT（见插件包内 `LICENSE.txt`）
