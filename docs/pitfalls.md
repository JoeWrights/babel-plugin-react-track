# babel-plugin-react-track 开发踩坑记录

## 目录

- [1. @babel/template 占位符冲突](#1-babeltemplate-占位符冲突)
- [2. path 与 AST 节点混用](#2-path-与-ast-节点混用)
- [3. 插件导出结构错误](#3-插件导出结构错误)
- [4. buildSdkFallback 闭合错误](#4-buildsdkfallback-闭合错误)
- [5. SearchReplace 唯一性匹配失败](#5-searchreplace-唯一性匹配失败)
- [6. @track.params 不支持变量引用](#6-trackparams-不支持变量引用)
- [7. JSDoc 块注释中多匹配丢失](#7-jsdoc-块注释中多匹配丢失)
- [8. matchAll 迭代器被 TypeScript 编译破坏](#8-matchall-迭代器被-typescript-编译破坏)
- [9. @track.params 嵌套对象被截断](#9-trackparams-嵌套对象被截断)
- [10. VariableDeclaration 与 VariableDeclarator 混淆](#10-variabledeclaration-与-variabledeclarator-混淆)
- [11. const fn = () => {} 的 binding path 不是函数节点](#11-const-fn---fn--的-binding-path-不是函数节点)
- [12. 跨文件注释解析](#12-跨文件注释解析)
- [13. Babel 注释附着行为导致 JSX 注释识别失败](#13-babel-注释附着行为导致-jsx-注释识别失败)
- [14. 副作用 import 注入影响 tree-shaking](#14-副作用-import-注入影响-tree-shaking)
- [15. babel-loader 不传递 loader context 给插件](#15-babel-loader-不传递-loader-context-给插件)
- [16. ESLint no-unused-vars 报错](#16-eslint-no-unused-vars-报错)
- [17. eventName 无默认值：未声明 @track.eventName 时不插桩](#17-eventname-无默认值未声明-trackeventname-时不插桩)
- [18. 自定义组件非 DOM 事件参数导致插桩失败](#18-自定义组件非-dom-事件参数导致插桩失败)
- [19. Umi 3 extraBabelPlugins 不覆盖源文件](#19-umi-3-extrababelplugins-不覆盖源文件)
- [20. preset-env transform-destructuring 导致跨文件解析断裂](#20-preset-env-transform-destructuring-导致跨文件解析断裂)
- [附录：注释语法速查](#附录注释语法速查)

---

## 1. @babel/template 占位符冲突

**问题**：使用 `@babel/template` 构建 `__TRACK_SDK__` 相关代码时，报错 `No substitution given for '__TRACK_SDK__'`。

**根因**：`@babel/template` v8 默认将 `__XXX__` 格式的标识符识别为占位符。即使设置 `placeholderAllowlist`，匹配 `__XXX__` 模式但不在白名单中的标识符仍会报错。

**解决**：放弃 `@babel/template`，改用 `t.xxx()` 直接构建所有 AST 节点。

```js
// ❌ 会触发占位符识别
const build = template(`const __TRACK_SDK__ = ...`);

// ✅ 直接构建 AST
t.variableDeclaration('const', [
  t.variableDeclarator(t.identifier('__TRACK_SDK__'), ...)
]);
```

**教训**：涉及 `__XXX__` 格式标识符时，不要使用 `@babel/template`。

---

## 2. path 与 AST 节点混用

**问题**：`injectToArrowFunction` 接收 AST 节点 `arrowFuncNode`，但函数内当作 path 使用（`arrowFuncPath.body`），导致 `Cannot read properties of undefined` 或静默失效。

**根因**：Babel visitor 中 `path.get('key')` 返回 path 对象（有 `.node`, `.body` 等方法），`node.key` 返回 AST 节点（只有 `.type`, `.arguments` 等属性）。两者 API 完全不同。

**解决**：统一使用 AST 节点操作：

```js
// ❌ 传入 node 但当作 path 用
function inject(arrowFuncPath) {
  const body = arrowFuncPath.body; // undefined!
}

// ✅ 直接操作 node
function inject(arrowFuncNode) {
  const body = arrowFuncNode.body; // 正确
}
```

---

## 3. 插件导出结构错误

**问题**：Babel 报错 `Plugin object must have a visitor property` 或类似验证错误。

**根因**：插件返回对象顶层包含非标准属性（如自定义方法 `injectToArrowFunction`），Babel 验证失败。

**解决**：自定义方法放在 visitor 外部作为模块内函数，visitor 只包含标准的 `Program`、`JSXAttribute` 等入口。

```js
// ❌ 顶层包含非标准属性
module.exports = function() {
  return {
    visitor: { ... },
    injectToArrowFunction() { ... }, // 不合法
  };
};

// ✅ 自定义方法放在模块作用域
function injectToArrowFunction() { ... }
module.exports = function() {
  return { visitor: { ... } };
};
```

---

## 4. buildSdkFallback 闭合错误

**问题**：编译通过但运行时报语法错误。

**根因**：`t.variableDeclaration(` 的闭合写成了 `];` 而不是 `]);`，少了一个右括号。

**教训**：使用 `t.xxx()` 构建深层嵌套 AST 时，仔细检查括号闭合。建议用变量分步构建，避免超长嵌套。

---

## 5. SearchReplace 唯一性匹配失败

**问题**：编辑工具报 "original_text is not unique"。

**根因**：`injectToArrowFunction` 和 `injectToDirectReference` 中有完全相同的文本片段（如 "构建埋点数据" 注释和类似的 `buildTrackStatement` 调用）。

**解决**：包含更多上下文（如后续的 `originalBody` 引用）使匹配唯一。

---

## 6. @track.params 不支持变量引用

**问题**：`@track.params: { c: product.id }` 中的 `product.id` 被当作字符串处理。

**根因**：原始实现只用正则匹配字面量值，不支持变量引用和成员表达式。

**解决**：引入 `@babel/parser` 的 `parseExpression` 将注释中的 JS 表达式解析为 AST 节点，失败时回退到字面量正则解析。

```js
const ast = parser.parseExpression(objStr);
if (t.isObjectExpression(ast)) {
  return ast.properties.filter((p) => t.isObjectProperty(p));
}
```

---

## 7. JSDoc 块注释中多匹配丢失

**问题**：JSDoc 块注释中写了多个 `@track.args[N].key`，但只有第一个生效。

```js
/**
 * @track.args[0].key: a
 * @track.args[1].key: b   ← 这条丢失
 */
```

**根因**：使用 `comment.value.match(regex)` 不带 `g` 标志，只返回第一个匹配。

**解决**：改用 `regex.exec()` + `while` 循环提取所有匹配。

---

## 8. matchAll 迭代器被 TypeScript 编译破坏

**问题**：使用 `comment.value.matchAll(regex)` + `for...of` 遍历时，编译后循环不执行。

**根因**：TypeScript 将 `for...of` 编译成 `for (var _i = 0; _i < matches.length; _i++)`，但 `matchAll` 返回的是迭代器，没有 `.length` 属性，循环永远不执行。

**解决**：改用 `while + exec + g 标志` 模式，与 TypeScript 编译完全兼容。

```js
// ❌ matchAll + for...of（编译后失效）
for (const m of text.matchAll(regex)) { ... }

// ✅ while + exec（编译后正常工作）
const regex = /pattern/g;
let m;
while ((m = regex.exec(text)) !== null) { ... }
regex.lastIndex = 0;
```

---

## 9. @track.params 嵌套对象被截断

**问题**：`@track.params: { f: { h: "h" } }` 解析后 `f` 键丢失，只剩 `h: "h"`。

**根因**：正则 `\{[^}]+\}` 用 `[^}]+` 匹配"非 `}` 的任意字符"，遇到第一个 `}` 就停止。`{ f: { h: "h" } }` 被截断为 `{ f: { h: "h" }`。

**解决**：实现 `extractBraceContent` 函数，用大括号深度计数提取完整对象字符串，同时正确处理字符串内的 `{}`。

```js
function extractBraceContent(text, prefix) {
  let depth = 0,
    inString = false;
  for (let i = start; i < text.length; i++) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
}
```

---

## 10. VariableDeclaration 与 VariableDeclarator 混淆

**问题**：`resolveTrackFromSource` 中 `t.isVariableDeclarator(declNode)` 始终为 false。

**根因**：`getBindingDeclNode` 将 `binding.path.node`（VariableDeclarator）提升到父级 `VariableDeclaration`。但 `resolveTrackFromSource` 检查的是 `isVariableDeclarator`，拿到的是 `VariableDeclaration`，类型不匹配。

**解决**：在 `resolveTrackFromSource` 中先检查 `isVariableDeclaration`，从中提取真正的 `VariableDeclarator`，再处理解构赋值中的变量匹配。

```js
// binding.path.node → VariableDeclarator
// getBindingDeclNode → VariableDeclaration（包装层）
// 需要从 VariableDeclaration.declarations 中提取 VariableDeclarator
if (t.isVariableDeclaration(declNode)) {
  for (const d of declNode.declarations) {
    if (t.isObjectPattern(d.id)) {
      /* 解构匹配 */
    }
  }
}
```

---

## 11. `const fn = () => {}` 的 binding path 不是函数节点

**问题**：`resolveTrackFromSource` 中 `funcPath.isArrowFunctionExpression()` 始终为 false。

**根因**：`const useClick = () => {}` 的 binding path 是 `VariableDeclarator`，不是 `ArrowFunctionExpression`。实际的箭头函数在 `declarator.init` 里。

**解决**：增加对 `VariableDeclarator` 的处理，从 `init` 属性获取函数节点。

```js
if (funcPath.isVariableDeclarator()) {
  const initNode = funcPath.node.init;
  if (t.isArrowFunctionExpression(initNode)) {
    funcBody = initNode.body;
  }
}
```

---

## 12. 跨文件注释解析

**问题**：`const { h1Click } = useClick()` 中 `useClick` 从另一个文件 import，插件无法读取源文件中的 `@track` 注释。

**根因**：Babel 逐文件处理，当处理 `App.tsx` 时看不到 `hooks.ts` 的内容。binding 追溯到 import 声明就断了。

**解决**：实现 `resolveTrackFromImport` 函数：

1. 检测 binding 是否来自 import（`ImportSpecifier`）
2. 解析源文件路径（自动补 `.ts/.tsx/.js/.jsx` 扩展名）
3. 用 `@babel/parser` 解析源文件 AST（带缓存）
4. 找到 export 的函数声明，扫描函数体提取 `@track` 注释

**限制**：

- 仅支持同项目内的相对路径 import
- 首次编译和 dev server 重启时正确读取
- 修改外部文件的 `@track` 注释后需要重启 dev server（见 [问题 15](#15-babel-loader-不传递-loader-context-给插件)）

---

## 13. Babel 注释附着行为导致 JSX 注释识别失败

**问题**：写在 JSX 属性前的注释被识别到错误的属性上。

```jsx
<h1
  // @track.eventName: handleClick  ← 注释被附加到 data-track-id
  data-track-id="123"
  onClick={() => handleClick()}
/>
```

**根因**：Babel 把 JSX 属性前的注释附加到**紧随其后的属性节点**的 `leadingComments`，而不是最近的 `onClick`。

**结论**：注释应放在**函数声明处**而非 JSX 使用处。函数声明处的注释通过 binding 追溯可靠提取。

---

## 14. 副作用 import 注入影响 tree-shaking

**问题**：为解决跨文件 HMR 问题，尝试注入 `import "./pages/hooks"` 副作用导入，但影响 tree-shaking。

**根因**：副作用 `import` 告诉打包工具"该模块有副作用，不要消除"，阻止了 tree-shaking 优化。且该导入与已有的 `import { useClick } from './pages/hooks'` 重复。

**解决**：移除副作用 import 注入，接受跨文件注释修改后需重启 dev server 的限制。

---

## 15. babel-loader 不传递 loader context 给插件

**问题**：修改 `hooks.ts` 中的 `@track` 注释后，热更新不生效。

**根因**：

1. `App.tsx` 源码没变 → 打包工具不重新跑 babel-loader → 返回缓存的旧输出
2. 尝试通过 `this.addDependency()` 注册跨文件依赖
3. 但 **babel-loader 不会把 loader context 传给 Babel 插件的 `this`**
4. `this.addDependency` 在插件中始终为 `undefined`

**验证**：

```js
// babel transform 中检查
exit() {
  console.log(typeof this.addDependency); // "undefined"
}
```

**结论**：这是 babel-loader 的设计限制，无法从 Babel 插件内部注册文件依赖。跨文件注释修改后需要重启 dev server。同文件注释修改正常触发热更新。

---

## 16. ESLint no-unused-vars 报错

**问题**：函数参数仅用于埋点、不被业务逻辑消费时，ESLint 报 `no-unused-vars` 错误。

```tsx
const handleClick = useCallback((a: string, b: string) => {
  // a, b 只用于埋点，函数体不消费
}, []);
```

**解决**：使用 `_` 前缀 + ESLint 配置豁免：

```tsx
// @track.args[0].key: a    ← key 仍然是 "a" 不是 "_a"
// @track.args[1].key: b
const handleClick = useCallback((_a: string, _b: string) => {
  console.log("business logic");
}, []);
```

ESLint 配置：

```json
{
  "rules": {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { "argsIgnorePattern": "^_" }
    ]
  }
}
```

---

## 17. eventName 无默认值：未声明 @track.eventName 时不插桩

**问题**：早期版本对所有 `on*` 事件自动插桩，默认生成 `eventType:tagName`（如 `click:h1`）作为 eventName。这导致所有事件处理器都被注入埋点代码，即使没有声明 `@track` 注释。

**根因**：`extractTrackConfig` 中有兜底逻辑：

```js
// 旧行为：没有注释时自动拼接默认值
if (!eventName) eventName = eventType + ":" + tagName.toLowerCase();
if (!eventName) eventName = eventType;
```

**解决**：移除默认拼接，`eventName` 未声明时为 `null`，直接跳过插桩。只有显式声明了 `@track.eventName` 的事件才会被注入埋点代码。

```js
// 新行为：没有 @track.eventName → 不插桩
if (!eventName) return null;
```

```js
// JSXAttribute visitor 中
const trackConfig = extractTrackConfig(path, eventType, expression);
if (!trackConfig) return; // 跳过
```

**影响**：

- 没有 `@track.eventName` 注释的 `onClick` → 代码完全不变 ✅
- 有 `@track.eventName` 注释的 `onClick` → 正常插桩 ✅
- 避免了不必要的代码注入和 SDK import

---

## 18. 自定义组件非 DOM 事件参数导致插桩失败

**问题**：`<Text onClick={h1Click} />` 中 Text 是自定义组件，点击事件执行了但埋点没有上报。

**根因**：Text 组件内部 `onClick?.("子组件参数测试1", "子组件参数测试2")` 传的是**字符串**而非 DOM 事件。插件生成的代码访问 `_e.target.tagName` 时：

```
"子组件参数测试1".target → undefined
undefined.tagName → TypeError: Cannot read properties of undefined
```

异常被 `try-catch` 吞掉 → `trackEvent` 未执行 → 埋点丢失。

**解决**：将 `tag` 和 `text` 的 DOM 属性访问改为安全降级：

```js
//  直接访问，_e 非 DOM 事件时抛异常
tag: _e.target.tagName;
text: _e.target.textContent;

// ✅ 安全降级，非 DOM 事件时返回空字符串
tag: (_e && _e.target && _e.target.tagName) || "";
text: (_e && _e.target && _e.target.textContent) || "";
```

**教训**：`onClick` 回调的参数不一定是 DOM 事件。自定义组件可以传任意值（字符串、对象、数字），埋点代码的 DOM 属性访问必须有安全降级。

---

## 19. Umi 3 extraBabelPlugins 不覆盖源文件

**问题**：track 插件通过 `extraBabelPlugins` 配置后，只对 `.umi` 生成文件生效，`src/` 下的源文件（如 `RemoteApp.tsx`）完全没有被 track 插件处理。

**根因**：Umi 3 的 `extraBabelPlugins` 只注入到 `.umi` 生成文件对应的 babel-loader 中，用户源文件走的是另一条 babel 管线，不包含 `extraBabelPlugins` 中配置的插件。

**验证**：通过 `chainWebpack` 打印 webpack 规则发现：

```
rule="js" test=/\.(js|mjs|jsx|ts|tsx)$/
  include=[项目根目录]  exclude=[/node_modules/, /\.mfsu/]
  babel plugins: 3   ← extraBabelPlugins 的 3 个插件
  presets: 1
```

虽然 `js` rule 的 babel-loader 有 track 插件，但实际编译时只对 `.umi` 文件触发了 `Program.enter`，源文件未触发。

**解决**：通过 `chainWebpack` 直接把 track 插件注入到 `js` rule 的 babel-loader options 中，绕过 `extraBabelPlugins` 的限制：

```ts
// config/config.ts
chainWebpack(config, { webpack }) {
  const jsRule = config.module.rules.get("js");
  const babelUse = jsRule.uses.get("babel-loader");
  const opts = babelUse.get("options") || {};
  const plugins = opts.plugins || [];
  plugins.push([
    trackPlugin,
    {
      sdkSource: path.resolve(__dirname, "../src/lib/track.ts"),
      trackFnName: "trackEvent",
    },
  ]);
  babelUse.set("options", { ...opts, plugins });
}
```

**教训**：Umi 3 的 `extraBabelPlugins` 不等于“全局 Babel 插件”。需要确保插件对所有源文件生效时，应通过 `chainWebpack` 直接操作 webpack 规则。

---

## 20. preset-env transform-destructuring 导致跨文件解析断裂

**问题**：track 插件在 Umi 3 项目中处理 `<Text onClick={h1Click}>` 时，跨文件解析链路断裂，无法从 `hooks.ts` 中读取 `@track.eventName`。

**根因**：`@babel/preset-env` 的 `transform-destructuring` 插件会把解构赋值转换为 MemberExpression：

```js
// 源码（init = CallExpression）
const { h1Click } = useClick();

// 被 preset-env 转换后（init = MemberExpression）
var _ref = useClick();
const h1Click = _ref.h1Click;
```

`resolveTrackFromSource` 中只检查了 `t.isCallExpression(declarator.init)`，遇到 `MemberExpression` 直接返回 null，导致无法追溯到 `useClick()` 调用，跨文件解析链路断裂。

**解决**：在 `resolveTrackFromSource` 中增加 `MemberExpression` 回溯逻辑：

```js
let callExpr = null;
if (t.isCallExpression(declarator.init)) {
  // 原始路径：const { x } = useClick()
  callExpr = declarator.init;
} else if (t.isMemberExpression(declarator.init) && !declarator.init.computed) {
  // preset-env 转换后：const x = _ref.x
  // 追溯到 _ref 的 binding，找到 _ref = useClick()
  const objNode = declarator.init.object;
  if (t.isIdentifier(objNode)) {
    const objBinding = binding.scope.getBinding(objNode.name);
    if (
      objBinding &&
      t.isVariableDeclarator(objBinding.path.node) &&
      t.isCallExpression(objBinding.path.node.init)
    ) {
      callExpr = objBinding.path.node.init;
    }
  }
}
if (!callExpr) return null;
const callee = callExpr.callee;
```

**调试方法**：在插件关键节点加 `process.stderr.write` 日志，跟踪 binding 链路：

```
[TRACK] extractTrackFromBinding: varName=h1Click binding.path.type=VariableDeclarator
[TRACK] resolveTrackFromSource: declNode.type=VariableDeclaration
[TRACK] resolveTrackFromSource: init not CallExpression, type=MemberExpression  ← 断点
```

**教训**：Babel 插桩插件必须考虑其他 Babel 插件/预设对 AST 的变换。`@babel/preset-env` 的 `transform-destructuring` 会改变解构赋值的 AST 结构，插件需要兼容转换前后的两种形态。

---

## 附录：注释语法速查

```ts
// hooks.ts
export const useClick = () => {
  /**
   * @track.eventName: handleClick         ← 事件名
   * @track.params: { f: { h: "h" } }      ← 静态参数（支持嵌套对象、变量引用）
   * @track.args[0].key: a                 ← 自定义第 1 个调用参数的 key
   * @track.args[1].key: b                 ← 自定义第 2 个调用参数的 key
   */
  const h1Click = useCallback((_a: string, _b: string) => {
    console.log("business logic");
  }, []);

  return { h1Click };
};
```

```tsx
// App.tsx — 无需任何注释（但 hook 内必须有 @track.eventName）
const { h1Click } = useClick();

<h1 data-track-id="212121" onClick={() => h1Click("动态参数1", "动态参数2")}>
  Dashboard
</h1>;
```

> **注意**：`@track.eventName` 是插桩的必要条件。未声明时，事件处理器不会被注入任何埋点代码。

生成的埋点数据：

```js
{
  tag: "H1",                      // 自动采集
  text: "Dashboard",              // 自动采集
  f: { h: "h" },                  // @track.params
  id: "212121",                   // data-track-id
  a: "动态参数1",                  // @track.args[0].key
  b: "动态参数2"                   // @track.args[1].key
}
// → trackEvent("handleClick", above)
```
