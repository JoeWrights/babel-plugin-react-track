// @ts-nocheck

const t = require('@babel/types');
const parser = require('@babel/parser');
const fs = require('fs');
const pathModule = require('path');

// 文件 AST 缓存，避免重复解析
const _fileAstCache = {};

// 每个文件编译期间解析的外部文件路径，用于 addDependency
let _currentResolvedFiles = [];

// 当前插件实例的 alias 配置，由 Program enter 设置
let _currentPluginAlias = null;

// ========== 别名路径解析 ==========

// baseUrl 配置缓存，避免每个文件重复读取 tsconfig
const _baseUrlConfigCache = {};
let _projectRootCache = null;

// 从当前文件向上查找项目根目录（含 package.json 或 tsconfig.json）
function findProjectRoot(currentFile) {
  if (_projectRootCache) return _projectRootCache;
  let dir = pathModule.dirname(currentFile);
  while (true) {
    if (
      fs.existsSync(pathModule.join(dir, 'package.json')) ||
      fs.existsSync(pathModule.join(dir, 'tsconfig.json'))
    ) {
      _projectRootCache = dir;
      return dir;
    }
    const parent = pathModule.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _projectRootCache = dir;
  return dir;
}

// 从 tsconfig/jsconfig 中读取 baseUrl 和 paths
function findBaseUrlConfig(currentFile) {
  const root = findProjectRoot(currentFile);
  if (_baseUrlConfigCache[root] !== undefined) return _baseUrlConfigCache[root];

  let configPath = null;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = pathModule.join(root, name);
    if (fs.existsSync(p)) { configPath = p; break; }
  }
  if (!configPath) { _baseUrlConfigCache[root] = null; return null; }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    // 去除注释和尾逗号（tsconfig 支持 JSONC 格式）
    const cleaned = raw
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/,(\s*[}\]])/g, '$1');
    const config = JSON.parse(cleaned);
    const co = config.compilerOptions || {};
    const result = {
      baseUrl: co.baseUrl ? pathModule.resolve(root, co.baseUrl) : root,
      paths: co.paths || {},
    };
    _baseUrlConfigCache[root] = result;
    return result;
  } catch (e) {
    _baseUrlConfigCache[root] = null;
    return null;
  }
}

// 匹配 paths 配置中的别名模式（如 @/* → src/*）
function matchAlias(source, paths, baseUrl) {
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const starIdx = pattern.indexOf('*');
    if (starIdx === -1) {
      // 精确匹配（如 "@hooks" → ["src/hooks"]）
      if (pattern === source) {
        return pathModule.resolve(baseUrl, targets[0]);
      }
    } else {
      // 通配符匹配（如 "@/*" → ["src/*"]）
      const prefix = pattern.slice(0, starIdx);
      if (source.startsWith(prefix)) {
        const rest = source.slice(prefix.length);
        const target = targets[0];
        const tStarIdx = target.indexOf('*');
        if (tStarIdx !== -1) {
          return pathModule.resolve(baseUrl, target.slice(0, tStarIdx) + rest);
        }
        return pathModule.resolve(baseUrl, target);
      }
    }
  }
  return null;
}

// 将 import source 解析为绝对文件路径，支持相对路径、别名路径和 baseUrl 相对路径
function resolveModulePath(source, currentFile, pluginAlias) {
  // 1. 相对路径
  if (source.startsWith('.')) {
    const dir = pathModule.dirname(currentFile);
    return tryResolveFile(pathModule.resolve(dir, source));
  }

  // 2. 插件选项显式传入的 alias 映射
  if (pluginAlias) {
    const aliased = matchAlias(source, pluginAlias, pathModule.dirname(currentFile));
    if (aliased) {
      const resolved = tryResolveFile(aliased);
      if (resolved) return resolved;
    }
  }

  // 3. 从 tsconfig/jsconfig 自动检测 alias
  const config = findBaseUrlConfig(currentFile);
  if (config) {
    // 3a. paths 别名匹配
    const aliased = matchAlias(source, config.paths, config.baseUrl);
    if (aliased) {
      const resolved = tryResolveFile(aliased);
      if (resolved) return resolved;
    }

    // 3b. baseUrl 相对路径（如 src/hooks 解析为 <baseUrl>/src/hooks）
    const baseUrlResolved = tryResolveFile(pathModule.resolve(config.baseUrl, source));
    if (baseUrlResolved) return baseUrlResolved;
  }

  return null;
}

// 尝试解析文件路径：先直接检查，再逐个尝试常见扩展名
function tryResolveFile(filePath) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    if (fs.existsSync(filePath + ext)) return filePath + ext;
  }
  return null;
}

// 构建埋点代码 AST
// eventType: 从 on* 属性名提取的事件类型（如 'click', 'scroll'）
// useDedup: 非 click 事件启用 WeakMap 去重，同一元素只上报一次
function buildTrackStatement(eventName, trackFnName, paramsNode, eventType, useDedup) {
  const argsUid = t.identifier('_trackArgs');

  const trackCall = t.expressionStatement(
    t.callExpression(t.identifier(trackFnName), [
      t.stringLiteral(eventName),
      argsUid,
    ])
  );

  let innerStatements;
  if (useDedup) {
    // if (!_dedupMap.get(_e.target)) { _dedupMap.set(_e.target, true); trackCall; }
    innerStatements = [
      t.ifStatement(
        t.unaryExpression('!',
          t.callExpression(
            t.memberExpression(t.identifier('_dedupMap'), t.identifier('get')),
            [t.memberExpression(t.identifier('_e'), t.identifier('target'))]
          )
        ),
        t.blockStatement([
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier('_dedupMap'), t.identifier('set')),
              [t.memberExpression(t.identifier('_e'), t.identifier('target')), t.booleanLiteral(true)]
            )
          ),
          trackCall,
        ])
      ),
    ];
  } else {
    innerStatements = [trackCall];
  }

  const tryBlock = t.blockStatement([
    t.variableDeclaration('const', [
      t.variableDeclarator(argsUid, paramsNode),
    ]),
    ...innerStatements,
  ]);

  const tryStatement = t.tryStatement(
    tryBlock,
    t.catchClause(t.identifier('e'), t.blockStatement([]))
  );

  const arrowFunc = t.arrowFunctionExpression([], t.blockStatement([tryStatement]));

  return t.expressionStatement(
    t.callExpression(t.identifier('__TRACK_SDK__'), [arrowFunc])
  );
}

// 构建 SDK 兜底语句：
// const __TRACK_SDK__ = window.queueMicrotask || (cb => Promise.resolve().then(cb));
function buildSdkFallback() {
  const fallback = t.arrowFunctionExpression(
    [t.identifier('cb')],
    t.callExpression(
      t.memberExpression(
        t.callExpression(
          t.memberExpression(t.identifier('Promise'), t.identifier('resolve')),
          []
        ),
        t.identifier('then')
      ),
      [t.identifier('cb')]
    )
  );

  return t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__TRACK_SDK__'),
      t.logicalExpression(
        '||',
        t.memberExpression(t.identifier('window'), t.identifier('queueMicrotask')),
        fallback
      )
    ),
  ]);
}

// 构建去重 WeakMap：const _dedupMap = new WeakMap();
function buildDedupWeakMap() {
  return t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('_dedupMap'),
      t.newExpression(t.identifier('WeakMap'), [])
    ),
  ]);
}

// kebab-case → camelCase
function toCamelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// 从 JSXOpeningElement 提取 data-track-* 属性
// data-track-product-id={product.id} → productId: product.id
function extractDataTrackParams(jsxOpeningPath) {
  if (!jsxOpeningPath || !jsxOpeningPath.node.attributes) return [];
  const params = [];
  for (const attr of jsxOpeningPath.node.attributes) {
    if (!t.isJSXAttribute(attr)) continue;
    const name = attr.name.name;
    if (!name || !name.startsWith('data-track-')) continue;
    const key = toCamelCase(name.slice('data-track-'.length));
    // value 可能是字符串字面量或 JSXExpressionContainer
    let valueNode;
    if (attr.value === null) {
      valueNode = t.booleanLiteral(true);
    } else if (t.isStringLiteral(attr.value)) {
      valueNode = attr.value;
    } else if (t.isJSXExpressionContainer(attr.value)) {
      valueNode = attr.value.expression;
    } else {
      continue;
    }
    params.push(t.objectProperty(t.identifier(key), valueNode));
  }
  return params;
}

// 从注释文本中提取大括号平衡的对象字符串
// 支持嵌套对象如 { f: { h: "h" }, a: 1 }
function extractBraceContent(text, prefix) {
  const idx = text.indexOf(prefix);
  if (idx === -1) return null;
  const start = text.indexOf('{', idx + prefix.length);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let stringChar = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// 从注释解析 @track.params: { source: 'homepage', count: 5, productId: product.id }
// 支持变量引用、成员表达式、函数调用等任意 JS 表达式，支持嵌套对象
function parseStaticParamsFromComment(commentText) {
  const objStr = extractBraceContent(commentText, '@track.params:');
  if (!objStr) return [];

  // 优先用 @babel/parser 解析，支持变量引用、成员表达式等
  try {
    const ast = parser.parseExpression(objStr);
    if (t.isObjectExpression(ast)) {
      return ast.properties.filter(p => t.isObjectProperty(p));
    }
  } catch (e) {
    // 解析失败，回退到字面量解析
  }

  // 回退：仅支持字面量（字符串、数字、布尔、null）
  const propRegex = /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*('[^']*'|"[^"]*"|\d+\.?\d*|true|false|null)/g;
  const props = [];
  let m;
  while ((m = propRegex.exec(objStr)) !== null) {
    const key = m[1];
    const rawVal = m[2];
    let valueNode;
    if (rawVal.startsWith("'") || rawVal.startsWith('"')) {
      valueNode = t.stringLiteral(rawVal.slice(1, -1));
    } else if (rawVal === 'true') {
      valueNode = t.booleanLiteral(true);
    } else if (rawVal === 'false') {
      valueNode = t.booleanLiteral(false);
    } else if (rawVal === 'null') {
      valueNode = t.nullLiteral();
    } else {
      valueNode = t.numericLiteral(Number(rawVal));
    }
    props.push(t.objectProperty(t.identifier(key), valueNode));
  }
  return props;
}

// 从函数体提取第一个 CallExpression
// 支持 BlockStatement 和直接表达式体
function extractCallExpression(node) {
  if (!node) return null;
  if (t.isCallExpression(node)) return node;
  if (t.isBlockStatement(node)) {
    for (const stmt of node.body) {
      if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
        return stmt.expression;
      }
    }
  }
  return null;
}

// 从 CallExpression 提取调用参数 AST 节点数组
function extractCallArgsNodes(arrowFuncNode) {
  const body = arrowFuncNode.body;
  let callExpr = null;
  if (t.isBlockStatement(body)) {
    callExpr = extractCallExpression(body);
  } else {
    callExpr = extractCallExpression(body);
  }
  if (callExpr) return callExpr.arguments;
  return [];
}

// 从注释提取 @track.args[N].key: customKey 映射
function extractArgKeyMapFromComments(comments) {
  const map = {};
  const regex = /@track\.args\[(\d+)\]\.key:\s*(\w+)/g;
  for (const comment of comments) {
    let m;
    while ((m = regex.exec(comment.value)) !== null) {
      map[parseInt(m[1])] = m[2];
    }
    regex.lastIndex = 0;
  }
  return map;
}

// 从声明节点提取 @track 注释配置
function extractTrackFromComments(declNode) {
  const comments = declNode.leadingComments || [];
  let eventName = null;
  let staticParams = [];
  for (const comment of comments) {
    const nameMatch = comment.value.match(/@track\.eventName:\s*(.+)/);
    if (nameMatch && !eventName) eventName = nameMatch[1].trim();
    if (comment.value.includes('@track.params:') && staticParams.length === 0) staticParams = parseStaticParamsFromComment(comment.value);
  }
  const argKeyMap = extractArgKeyMapFromComments(comments);
  if (!eventName && staticParams.length === 0 && Object.keys(argKeyMap).length === 0) return null;
  return { eventName, staticParams, argKeyMap };
}

// 获取 binding 的声明节点（跳过 VariableDeclarator → VariableDeclaration）
function getBindingDeclNode(binding) {
  let declNode = binding.path.node;
  if (binding.path.parentPath && binding.path.parentPath.isVariableDeclaration()) {
    declNode = binding.path.parentPath.node;
  }
  return declNode;
}

// 检查 binding 是否来自 import，返回 { source, importedName }
function getImportInfo(binding) {
  if (!binding.path.isImportSpecifier() && !binding.path.isImportDefaultSpecifier() && !binding.path.isImportNamespaceSpecifier()) {
    return null;
  }
  const importDecl = binding.path.parentPath;
  if (!importDecl || !importDecl.isImportDeclaration()) return null;
  const source = importDecl.node.source.value;
  let importedName;
  if (binding.path.isImportSpecifier()) {
    importedName = binding.path.node.imported.name || binding.path.node.imported.value;
  } else {
    importedName = 'default';
  }
  return { source, importedName };
}

// 解析文件 AST（带缓存）
function parseFileAST(filePath) {
  if (_fileAstCache[filePath]) return _fileAstCache[filePath];
  try {
    const code = fs.readFileSync(filePath, 'utf-8');
    const ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    });
    _fileAstCache[filePath] = ast;
    return ast;
  } catch (e) {
    return null;
  }
}

// 从文件 AST 中找到 export 的函数/变量声明节点
function findExportedDecl(ast, exportedName) {
  if (!ast) return null;
  for (const stmt of ast.program.body) {
    // export function useClick() {} / export const useClick = () => {}
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
      const decl = stmt.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id && decl.id.name === exportedName) {
        return decl;
      }
      if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) {
          if (t.isIdentifier(d.id) && d.id.name === exportedName) return d;
        }
      }
    }
    // export default function ...
    if (t.isExportDefaultDeclaration(stmt)) {
      if (exportedName === 'default') {
        return stmt.declaration;
      }
    }
  }
  return null;
}

// 从函数体中提取指定名称变量的 @track 注释
function extractTrackFromFuncBody(funcNode, varName) {
  let body = null;
  if (t.isFunctionDeclaration(funcNode) || t.isFunctionExpression(funcNode) || t.isArrowFunctionExpression(funcNode)) {
    body = funcNode.body;
  }
  if (!body || !t.isBlockStatement(body)) return null;
  for (const stmt of body.body) {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (t.isVariableDeclarator(decl) && t.isIdentifier(decl.id) && decl.id.name === varName) {
          const result = extractTrackFromComments(stmt);
          if (result) return result;
        }
      }
    }
  }
  return null;
}

// 从 import 的源文件中提取 @track 元数据
// 处理：import { useClick } from './hooks' → const { h1Click } = useClick()
function resolveTrackFromImport(binding, varName) {
  const importInfo = getImportInfo(binding);
  if (!importInfo) return null;
  // 解析源文件路径（支持相对路径、别名路径、baseUrl 相对路径）
  const currentFile = binding.path.hub.file.opts.filename;
  const pluginAlias = _currentPluginAlias;
  const filePath = resolveModulePath(importInfo.source, currentFile, pluginAlias);
  if (!filePath) return null;


  // 记录外部文件依赖，用于 HMR 热更新
  _currentResolvedFiles.push(filePath);

  const ast = parseFileAST(filePath);
  if (!ast) return null;

  // 找到导入的函数声明（如 useClick）
  const decl = findExportedDecl(ast, importInfo.importedName);
  if (!decl) return null;

  // 获取函数节点
  let funcNode = null;
  if (t.isFunctionDeclaration(decl)) {
    funcNode = decl;
  } else if (t.isVariableDeclarator(decl) && decl.init) {
    if (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init)) {
      funcNode = decl.init;
    }
  }
  if (!funcNode) return null;

  // 从函数体中找到 varName 的 @track 注释
  return extractTrackFromFuncBody(funcNode, varName);
}

// 当 binding 来自函数调用返回值时（如 const { x } = useHook()），
// 追溯到源函数体内部，找到同名变量的定义并提取 @track 注释
function resolveTrackFromSource(binding, varName) {
  const declNode = getBindingDeclNode(binding);

  // declNode 可能是 VariableDeclaration（包装层）或 VariableDeclarator
  let declarator = null;
  if (t.isVariableDeclaration(declNode)) {
    // 从解构赋值中找到匹配的变量: const { varName } = call()
    for (const d of declNode.declarations) {
      if (t.isVariableDeclarator(d) && t.isObjectPattern(d.id)) {
        for (const prop of d.id.properties) {
          if (t.isObjectProperty(prop) && t.isIdentifier(prop.value) && prop.value.name === varName) {
            declarator = d;
            break;
          }
        }
      }
      if (t.isVariableDeclarator(d) && t.isIdentifier(d.id) && d.id.name === varName) {
        declarator = d;
        break;
      }
    }
  } else if (t.isVariableDeclarator(binding.path.node)) {
    declarator = binding.path.node;
  }
  if (!declarator || !declarator.init) return null;

  // 处理 @babel/preset-env 的 transform-destructuring 转换：
  // const { h1Click } = useClick()  →  var _ref = useClick(); const h1Click = _ref.h1Click;
  // 此时 init 是 MemberExpression 而不是 CallExpression
  let callExpr = null;
  if (t.isCallExpression(declarator.init)) {
    callExpr = declarator.init;
  } else if (t.isMemberExpression(declarator.init) && !declarator.init.computed) {
    const objNode = declarator.init.object;
    if (t.isIdentifier(objNode)) {
      const objBinding = binding.scope.getBinding(objNode.name);
      if (objBinding && t.isVariableDeclarator(objBinding.path.node) && t.isCallExpression(objBinding.path.node.init)) {
        callExpr = objBinding.path.node.init;
      }
    }
  }
  if (!callExpr) return null;

  // 找到被调用的函数
  const callee = callExpr.callee;

  let funcPath = null;
  if (t.isIdentifier(callee)) {
    const calleeBinding = binding.scope.getBinding(callee.name);
    if (!calleeBinding) {
      // 尝试跨文件解析（callee 可能是 import）
      return resolveTrackFromImport(binding, varName);
    }
    funcPath = calleeBinding.path;
  } else if (t.isArrowFunctionExpression(callee) || t.isFunctionExpression(callee)) {
    return null; // IIFE 不处理
  } else {
    return null;
  }

  // 如果 callee 是 import，跨文件解析 — 传入 callee 的 import binding
  if (funcPath.isImportSpecifier?.() || funcPath.isImportDefaultSpecifier?.()) {
    return resolveTrackFromImport({ path: funcPath, scope: binding.scope, hub: { file: binding.path.hub.file } }, varName);
  }

  // 获取函数体
  let funcBody = null;
  // 处理 const useClick = () => {} 形式：binding.path 是 VariableDeclarator，函数在 init 里
  if (funcPath.isVariableDeclarator()) {
    const initNode = funcPath.node.init;
    if (t.isArrowFunctionExpression(initNode) || t.isFunctionExpression(initNode)) {
      funcBody = initNode.body;
    }
  } else if (funcPath.isFunctionDeclaration() || funcPath.isFunctionExpression()) {
    funcBody = funcPath.node.body;
  } else if (funcPath.isArrowFunctionExpression()) {
    funcBody = funcPath.node.body;
  }
  if (!funcBody || !t.isBlockStatement(funcBody)) return null;

  // 扫描函数体，找到同名变量的声明并提取 @track 注释
  for (const stmt of funcBody.body) {
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (t.isVariableDeclarator(decl) && t.isIdentifier(decl.id) && decl.id.name === varName) {
          const innerDeclNode = stmt;
          const result = extractTrackFromComments(innerDeclNode);
          if (result) return result;
        }
      }
    }
  }
  return null;
}

// 从标识符的声明处提取 @track.eventName 和 @track.params
// 支持：const handleClick = ... / const { x } = useHook()（追溯到 hook 内部）
function extractTrackFromBinding(attrPath) {
  const value = attrPath.node.value;
  if (!t.isJSXExpressionContainer(value)) return null;
  if (!t.isIdentifier(value.expression)) return null;

  const varName = value.expression.name;
  const binding = attrPath.scope.getBinding(varName);
  if (!binding) return null;

  // 先尝试直接从声明节点提取
  const declNode = getBindingDeclNode(binding);

  const direct = extractTrackFromComments(declNode);
  if (direct) return direct;

  // 声明上无 @track，尝试追溯到源函数（如 hook 返回值）
  const fromSource = resolveTrackFromSource(binding, varName);
  if (fromSource) return fromSource;

  // 本地无法解析，尝试跨文件解析（binding 可能是 import）
  const result = resolveTrackFromImport(binding, varName);
  return result;
}

// 从箭头函数体内的调用提取被调用标识符，并提取其声明处的 @track 配置
// 支持：onClick={() => handleClick(...)} → 从 handleClick 声明处提取
function extractTrackFromCallExprBinding(attrPath, exprNode) {
  if (!t.isArrowFunctionExpression(exprNode)) return null;
  const callExpr = extractCallExpression(exprNode.body);
  if (!callExpr || !t.isIdentifier(callExpr.callee)) return null;

  const binding = attrPath.scope.getBinding(callExpr.callee.name);
  if (!binding) return null;

  // 先尝试直接从声明节点提取
  const declNode = getBindingDeclNode(binding);
  const direct = extractTrackFromComments(declNode);
  if (direct) return direct;

  // 声明上无 @track，尝试追溯到源函数（如 hook 返回值）
  const fromSource = resolveTrackFromSource(binding, callExpr.callee.name);
  if (fromSource) return fromSource;

  // 本地无法解析，尝试跨文件解析（binding 可能是 import）
  return resolveTrackFromImport(binding, callExpr.callee.name);
}

// 从注释中提取 @track.eventName 和 @track.params
// 优先级：JSXAttribute 注释 > 标识符声明注释 > 箭头函数体内调用标识符
// 没有 @track.eventName 注释时 eventName 为 null，不插桩
function extractTrackConfig(attrPath, eventType, exprNode) {
  const jsxOpeningPath = attrPath.parentPath;
  let eventName = null;
  let staticParams = [];
  let argKeyMap = {};

  // 1. 检查 JSXAttribute 的 leading comments
  const attrComments = attrPath.node.leadingComments || [];
  for (const comment of attrComments) {
    const nameMatch = comment.value.match(/@track\.eventName:\s*(.+)/);
    if (nameMatch) eventName = nameMatch[1].trim();
    const paramsMatch = comment.value.match(/@track\.params:\s*(\{[^}]+\})/);
    if (paramsMatch) staticParams = parseStaticParamsFromComment(comment.value);
  }
  Object.assign(argKeyMap, extractArgKeyMapFromComments(attrComments));

  // 2. 检查父 JSXOpeningElement 的 comments
  if (jsxOpeningPath && jsxOpeningPath.node.leadingComments) {
    for (const comment of jsxOpeningPath.node.leadingComments) {
      const nameMatch = comment.value.match(/@track\.eventName:\s*(.+)/);
      if (nameMatch && !eventName) eventName = nameMatch[1].trim();
      if (comment.value.includes('@track.params:') && staticParams.length === 0) staticParams = parseStaticParamsFromComment(comment.value);
    }
    Object.assign(argKeyMap, extractArgKeyMapFromComments(jsxOpeningPath.node.leadingComments));
  }

  // 3. 检查标识符声明处的 @track 注释（eventName + params）
  const fromBinding = extractTrackFromBinding(attrPath);
  if (fromBinding) {
    if (fromBinding.eventName && !eventName) eventName = fromBinding.eventName;
    if (fromBinding.staticParams.length > 0 && staticParams.length === 0) {
      staticParams = fromBinding.staticParams;
    }
    Object.assign(argKeyMap, fromBinding.argKeyMap);
  }

  // 3.5 箭头函数体内调用标识符的 @track 注释（如 () => handleClick(...)）
  if (exprNode && t.isArrowFunctionExpression(exprNode)) {
    const fromCallBinding = extractTrackFromCallExprBinding(attrPath, exprNode);
    if (fromCallBinding) {
      if (fromCallBinding.eventName && !eventName) eventName = fromCallBinding.eventName;
      if (fromCallBinding.staticParams.length > 0 && staticParams.length === 0) {
        staticParams = fromCallBinding.staticParams;
      }
      Object.assign(argKeyMap, fromCallBinding.argKeyMap);
    }
  }

  // 4. 没有 @track.eventName 注释 → 不插桩
  if (!eventName) return null;

  // 5. 提取 data-track-* 属性（动态参数）
  const dataTrackProps = extractDataTrackParams(jsxOpeningPath);

  return { eventName, staticParams, dataTrackProps, argKeyMap };
}

// 辅助函数：安全生成 DOM 属性访问代码
// _e.target.tagName → (_e && _e.target && _e.target.tagName) || ''
function buildSafeDomProp(eventParam, propName) {
  const targetExpr = t.memberExpression(eventParam, t.identifier('target'));
  const propExpr = t.memberExpression(targetExpr, t.identifier(propName));
  // _e && _e.target
  const hasTarget = t.logicalExpression('&&', eventParam, targetExpr);
  // _e && _e.target && _e.target.propName
  const safeAccess = t.logicalExpression('&&', hasTarget, propExpr);
  // (_e && _e.target && _e.target.propName) || ''
  return t.logicalExpression('||', safeAccess, t.stringLiteral(''));
}

// 辅助函数：注入到箭头函数
function injectToArrowFunction(attrPath, arrowFuncNode, trackFnName, trackConfig, eventType) {
  const { eventName, staticParams, dataTrackProps, argKeyMap } = trackConfig;
  const useDedup = eventType !== 'click';

  // 获取箭头函数的 event 参数（第一个参数）
  // onClick={(e) => ...} 或 onClick={() => ...}
  let eventParam;
  if (arrowFuncNode.params.length > 0) {
    eventParam = arrowFuncNode.params[0];
  } else {
    // 箭头函数没有参数，添加一个 event 参数
    eventParam = t.identifier('_e');
    arrowFuncNode.params = [eventParam];
  }

  // 构建埋点数据：合并 base + static + data-track + callArgs
  const trackDataProps = [
    t.objectProperty(t.identifier('tag'), buildSafeDomProp(eventParam, 'tagName')),
    t.objectProperty(t.identifier('text'), buildSafeDomProp(eventParam, 'textContent')),
    ...staticParams,
    ...dataTrackProps,
  ];

  // 自动提取箭头函数体内的函数调用参数
  // onClick={() => handleClick("a", "b")} → args: ["a", "b"]
  // 有 @track.args[N].key 注释时使用自定义 key
  const callArgs = extractCallArgsNodes(arrowFuncNode);
  if (callArgs.length > 0) {
    const hasCustomKeys = Object.keys(argKeyMap || {}).length > 0;
    if (hasCustomKeys) {
      callArgs.forEach((arg, i) => {
        const key = (argKeyMap || {})[i];
        if (key) {
          trackDataProps.push(t.objectProperty(t.identifier(key), arg));
        }
      });
    } else {
      trackDataProps.push(
        t.objectProperty(t.identifier('args'), t.arrayExpression(callArgs))
      );
    }
  }

  const trackData = t.objectExpression(trackDataProps);
  const trackNode = buildTrackStatement(eventName, trackFnName, trackData, eventType, useDedup);

  const originalBody = arrowFuncNode.body;
  if (t.isBlockStatement(originalBody)) {
    originalBody.body.unshift(trackNode);
  } else {
    arrowFuncNode.body = t.blockStatement([
      trackNode,
      t.returnStatement(originalBody)
    ]);
  }
}

// 辅助函数：注入到直接引用
function injectToDirectReference(attrPath, identifierNode, trackFnName, trackConfig, eventType) {
  const { eventName, staticParams, dataTrackProps } = trackConfig;
  const eventParam = t.identifier('_e');
  const useDedup = eventType !== 'click';

  // 构建埋点数据：合并 base + static + data-track
  const trackDataProps = [
    t.objectProperty(t.identifier('tag'), buildSafeDomProp(eventParam, 'tagName')),
    t.objectProperty(t.identifier('text'), buildSafeDomProp(eventParam, 'textContent')),
    ...staticParams,
    ...dataTrackProps,
  ];

  const trackData = t.objectExpression(trackDataProps);

  // 构建内层逻辑：可选去重 + trackEvent 调用
  const trackCall = t.expressionStatement(
    t.callExpression(t.identifier(trackFnName), [
      t.stringLiteral(eventName),
      t.identifier('_trackArgs'),
    ])
  );

  let innerStatements;
  if (useDedup) {
    innerStatements = [
      t.ifStatement(
        t.unaryExpression('!',
          t.callExpression(
            t.memberExpression(t.identifier('_dedupMap'), t.identifier('get')),
            [t.memberExpression(eventParam, t.identifier('target'))]
          )
        ),
        t.blockStatement([
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier('_dedupMap'), t.identifier('set')),
              [t.memberExpression(eventParam, t.identifier('target')), t.booleanLiteral(true)]
            )
          ),
          trackCall,
        ])
      ),
    ];
  } else {
    innerStatements = [trackCall];
  }

  const tryBlock = t.blockStatement([
    t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier('_trackArgs'), trackData),
    ]),
    ...innerStatements,
  ]);

  const tryStatement = t.tryStatement(
    tryBlock,
    t.catchClause(t.identifier('e'), t.blockStatement([]))
  );

  const trackNode = t.expressionStatement(
    t.callExpression(t.identifier('__TRACK_SDK__'), [
      t.arrowFunctionExpression([], t.blockStatement([tryStatement]))
    ])
  );

  const newArrowFunc = t.arrowFunctionExpression(
    [eventParam],
    t.blockStatement([
      trackNode,
      t.returnStatement(
        t.callExpression(identifierNode, [eventParam])
      )
    ])
  );

  attrPath.node.value = t.jSXExpressionContainer(newArrowFunc);
}

module.exports = function (_, options = {}) {
  const { sdkSource = 'your-tracker-sdk', trackFnName = '__trackEvent' } = options;

  return {
    visitor: {
      Program: {
        enter(path) {
          _currentResolvedFiles = [];
          _currentPluginAlias = options.alias || null;

          let hasEvents = false;
          let hasNonClickEvents = false;

          path.traverse({
            JSXAttribute(p) {
              const name = p.node.name.name;
              if (name && /^on[A-Z]/.test(name)) {
                hasEvents = true;
                if (name !== 'onClick') hasNonClickEvents = true;
              }
            }
          });

          if (hasEvents) {
            const importDecl = t.importDeclaration(
              [t.importSpecifier(t.identifier(trackFnName), t.identifier(trackFnName))],
              t.stringLiteral(sdkSource)
            );
            path.unshiftContainer('body', importDecl);
            path.unshiftContainer('body', buildSdkFallback());
            // 非 click 事件需要 WeakMap 去重
            if (hasNonClickEvents) {
              path.unshiftContainer('body', buildDedupWeakMap());
            }
          }
        },
        exit(path, state) {
          // babel-loader 不会把 loader context 传给插件的 this，
          // addDependency 无法从插件内部调用。
          // 跨文件注释修改后需要手动刷新页面。
        },
      },

      JSXAttribute(path) {
        const attrName = path.node.name.name;
        if (!attrName || !/^on[A-Z]/.test(attrName)) return;
        const value = path.node.value;
        if (!t.isJSXExpressionContainer(value)) return;

        const expression = value.expression;
        // onClick → 'click', onMouseEnter → 'mouseEnter'
        const eventType = attrName.slice(2, 3).toLowerCase() + attrName.slice(3);
        const trackConfig = extractTrackConfig(path, eventType, expression);
        if (!trackConfig) return; // 没有 @track.eventName 注释，跳过插桩

        if (t.isArrowFunctionExpression(expression)) {
          injectToArrowFunction(path, expression, trackFnName, trackConfig, eventType);
        } else if (t.isIdentifier(expression)) {
          injectToDirectReference(path, expression, trackFnName, trackConfig, eventType);
        }
      }
    }
  };
};
