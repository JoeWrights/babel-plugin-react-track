# babel-plugin-react-track 技术实现文档

## 一、项目定位

基于 Babel AST 的 React 事件埋点自动插桩插件。在编译期扫描 JSX 中的 `on*` 事件属性，通过声明式注释语法（`@track.*`）自动为事件处理器注入埋点代码，实现**零侵入**的数据采集。

**核心理念**：注释驱动 + 按需插桩。只有声明了 `@track.eventName` 的事件才会被注入埋点代码，未声明的事件处理器完全不受影响。

---

## 二、整体架构

### 2.1 模块结构

```
index.ts（~940 行）
├── 别名路径解析层
│   ├── findProjectRoot()          — 向上查找项目根目录
│   ├── findBaseUrlConfig()        — 从 tsconfig/jsconfig 读取 baseUrl + paths
│   ├── matchAlias()               — 匹配 paths 别名模式（如 @/* → src/*）
│   ├── resolveModulePath()        — 统一路径解析入口（相对路径 / 别名 / baseUrl）
│   └── tryResolveFile()           — 尝试补全扩展名解析文件
│
├── AST 构建层
│   ├── buildTrackStatement()      — 构建埋点调用语句（含去重逻辑）
│   ├── buildSdkFallback()         — 构建 __TRACK_SDK__ 兜底变量
│   ├── buildDedupWeakMap()        — 构建 WeakMap 去重实例
│   └── buildSafeDomProp()         — 构建安全 DOM 属性访问表达式
│
├── 配置提取层
│   ├── extractTrackConfig()       — 主入口：多来源合并 @track 配置
│   ├── extractTrackFromComments() — 从声明节点注释提取配置
│   ├── extractDataTrackParams()   — 从 JSX data-track-* 属性提取动态参数
│   ├── parseStaticParamsFromComment() — 解析 @track.params（支持嵌套对象+变量引用）
│   ├── extractBraceContent()      — 大括号深度计数提取器
│   └── extractArgKeyMapFromComments() — 解析 @track.args[N].key 映射
│
├── 跨文件解析层
│   ├── extractTrackFromBinding()  — 从标识符 binding 链提取配置
│   ├── extractTrackFromCallExprBinding() — 从箭头函数体内调用提取配置
│   ├── resolveTrackFromSource()   — 追溯到源函数（如 hook 返回值）
│   ├── resolveTrackFromImport()   — 跨文件解析 import 源
│   ├── parseFileAST()             — 解析外部文件 AST（带缓存）
│   └── findExportedDecl()         — 定位 export 声明节点
│
├── 代码注入层
│   ├── injectToArrowFunction()    — 注入到箭头函数体
│   └── injectToDirectReference()  — 包装为新的箭头函数
│
└── Visitor 入口
    ├── Program.enter              — 全局扫描 + 注入 SDK import / 兜底代码
    └── JSXAttribute               — 匹配 on[A-Z]* 属性 → 提取配置 → 注入代码
```

### 2.2 编译流程

```
源码文件进入 Babel
    │
    ▼
Program.enter（首次遍历）
    ├── 扫描文件中所有 on[A-Z]* JSX 属性
    ├── 有事件 → 注入 import { trackEvent } from 'sdk'
    ├── 注入 const __TRACK_SDK__ = queueMicrotask || fallback
    └── 有非 click 事件 → 额外注入 const _dedupMap = new WeakMap()
    │
    ▼
JSXAttribute（逐属性遍历）
    ├── 匹配 on[A-Z]* 属性？ ── 否 → 跳过
    ├── 值是 JSXExpressionContainer？ ── 否 → 跳过
    ├── extractTrackConfig() 提取 @track 配置
    │   ├── 优先级 1: JSXAttribute 自身注释
    │   ├── 优先级 2: JSXOpeningElement 注释
    │   ├── 优先级 3: 标识符声明处注释（binding 追溯）
    │   └── 优先级 4: 箭头函数体内调用标识符注释
    │
    ├── 无 @track.eventName？ ── 是 → 跳过（不插桩）
    │
    ├── 表达式类型判断
    │   ├── ArrowFunctionExpression → injectToArrowFunction()
    │   └── Identifier              → injectToDirectReference()
    │
    └── 注入完成
```

---

## 三、支持的事件写法（插桩模式）

插件针对 JSX 中 `on*` 事件的**两种表达式形式**进行插桩，同时支持**跨文件追溯**和**多种参数来源**。

### 3.1 模式一：箭头函数表达式

```tsx
onClick={() => handleClick('arg1', 'arg2')}
onClick={(e) => handleClick('arg1')}
onClick={() => { handleClick('arg1'); doSomething(); }}
```

**插桩方式**：直接在箭头函数体**头部**注入埋点语句。

**注入前**：

```tsx
onClick={() => handleClick('arg1', 'arg2')}
```

**注入后**：

```tsx
onClick={() => {
  __TRACK_SDK__(() => {
    try {
      const _trackArgs = {
        tag: (_e && _e.target && _e.target.tagName) || '',
        text: (_e && _e.target && _e.target.textContent) || '',
        args: ['arg1', 'arg2']   // 自动提取调用参数
      };
      if (!_dedupMap.get(_e.target)) {   // 非 click 事件才有去重
        _dedupMap.set(_e.target, true);
        trackEvent('handleClick', _trackArgs);
      }
    } catch (e) {}
  });
  return handleClick('arg1', 'arg2');
}}
```

**细分场景**：

| 写法              | 处理方式                                             |
| ----------------- | ---------------------------------------------------- |
| `() => fn()`      | 直接表达式体 → 转为 BlockStatement + returnStatement |
| `(e) => fn()`     | 保留原有参数名 `e` 作为事件参数                      |
| `() => fn()`      | 无参数 → 自动添加 `_e` 参数                          |
| `() => { fn(); }` | BlockStatement 体 → `unshift` 到函数体头部           |

**自动参数提取**：通过 `extractCallExpression` + `extractCallArgsNodes` 扫描箭头函数体内的第一个 `CallExpression`，提取其 `arguments` 数组。支持两种 key 模式：

```tsx
// 无 @track.args[N].key → 默认 args 数组
onClick={() => handleClick('react', 1)}
// → { args: ['react', 1], ... }

// 有 @track.args[N].key → 自定义 key
// @track.args[0].key: keyword
// @track.args[1].key: page
onClick={() => handleSearch('react', 1)}
// → { keyword: 'react', page: 1, ... }
```

### 3.2 模式二：直接引用（Identifier）

```tsx
onClick = { handleClick };
onMouseEnter = { handleHover };
```

**插桩方式**：将原引用**包装为新的箭头函数**，先执行埋点再调用原函数。

**注入前**：

```tsx
onClick = { handleClick };
```

**注入后**：

```tsx
onClick={(_e) => {
  __TRACK_SDK__(() => {
    try {
      const _trackArgs = {
        tag: (_e && _e.target && _e.target.tagName) || '',
        text: (_e && _e.target && _e.target.textContent) || '',
        // staticParams + dataTrackProps
      };
      trackEvent('handleClick', _trackArgs);
    } catch (e) {}
  });
  return handleClick(_e);
}}
```

**注意**：直接引用模式下无法自动提取调用参数（因为没有箭头函数体可以扫描），只采集 DOM 基础信息 + 静态参数 + data-track 动态参数。

### 3.3 跨文件追溯（Hook 返回值）

两种表达式形式都支持跨文件追溯到 hook 定义处读取 `@track` 注释。

**场景 A：同文件 hook**

```tsx
// 同一文件内
const { handleClick } = useClick();
<h1 onClick={() => handleClick()}>Dashboard</h1>;
// → binding 追溯到 useClick 函数体 → 找到 handleClick 声明处的 @track 注释
```

**场景 B：跨文件 import**

```tsx
// hooks.ts（源文件）
export const useClick = () => {
  // @track.eventName: handleClick
  // @track.params: { source: 'homepage' }
  const h1Click = useCallback(() => {
    /* ... */
  }, []);
  return { h1Click };
};

// App.tsx（使用侧 — 无需任何注释）
import { useClick } from "./hooks";
const { h1Click } = useClick();
<h1 onClick={() => h1Click()}>Dashboard</h1>;
// → binding 追溯到 import → 解析 hooks.ts AST → 找到 @track.eventName
```

**跨文件解析链路**：

```
JSXAttribute: onClick={h1Click}
  → getBinding('h1Click')
  → binding.path: VariableDeclarator (const { h1Click } = useClick())
  → 直接声明处无 @track 注释
  → resolveTrackFromSource(): 追溯到 useClick() 调用
    → 兼容 preset-env transform-destructuring 转换
       (const h1Click = _ref.h1Click → 回溯到 _ref = useClick())
    → 找到 useClick 函数体
    → 扫描函数体找到 const h1Click = useCallback(...)
    → 提取 leadingComments 中的 @track.eventName
```

### 3.4 支持的事件类型

插件匹配所有 `on[A-Z]*` 格式的 JSX 事件属性：

| 事件类型   | 示例                                          | 去重策略                               |
| ---------- | --------------------------------------------- | -------------------------------------- |
| click 事件 | `onClick`, `onDoubleClick`                    | **不去重**（每次点击都有意义）         |
| 鼠标事件   | `onMouseEnter`, `onMouseLeave`, `onMouseMove` | **WeakMap 去重**（同一元素只上报一次） |
| 滚动事件   | `onScroll`                                    | **WeakMap 去重**                       |
| 焦点事件   | `onFocus`, `onBlur`                           | **WeakMap 去重**                       |
| 键盘事件   | `onKeyDown`, `onKeyUp`, `onKeyPress`          | **WeakMap 去重**                       |
| 其他事件   | `onChange`, `onInput`, `onSubmit` 等          | **WeakMap 去重**                       |

判断逻辑：`eventType !== 'click'` 时启用 WeakMap 去重。

### 3.5 不支持的写法

以下写法**不会被插桩**：

```tsx
{/* 1. 成员表达式 */}
onClick={this.handleClick}

{/* 2. 内联函数表达式（非箭头） */}
onClick={function(e) { handleClick(); }}

{/* 3. bind 绑定 */}
onClick={handleClick.bind(this)}

{/* 4. 条件表达式 */}
onClick={condition ? fn1 : fn2}

{/* 5. 无 @track.eventName 注释的任何写法 */}
onClick={() => handleClick()}   // 声明处无 @track.eventName → 不插桩
```

---

## 四、参数来源与合并机制

埋点数据由四层参数合并而成，优先级从低到高：

### 4.1 基础层：DOM 自动采集（最高优先级）

```js
tag: (_e && _e.target && _e.target.tagName) || "";
text: (_e && _e.target && _e.target.textContent) || "";
```

通过 `buildSafeDomProp` 生成安全访问链，防止自定义组件传递非 DOM 参数时抛异常。

### 4.2 静态层：`@track.params`

```ts
// @track.params: { source: 'homepage', productId: product.id, meta: { type: 'premium' } }
```

通过 `parseStaticParamsFromComment` 解析，优先使用 `@babel/parser` 的 `parseExpression` 支持任意 JS 表达式（变量引用、成员表达式、函数调用、嵌套对象），失败时回退到正则匹配字面量。

嵌套对象通过 `extractBraceContent` 的**大括号深度计数**算法提取完整字符串，正确处理字符串内的 `{}`。

### 4.3 动态层：`data-track-*` 属性

```tsx
<h1 data-track-id="123" data-track-product-id={product.id} onClick={...}>
```

通过 `extractDataTrackParams` 提取，key 自动 kebab → camelCase 转换：

- `data-track-id` → `id`
- `data-track-product-id` → `productId`

支持字符串字面量和 JSXExpressionContainer 两种值形式。

### 4.4 调用参数层：箭头函数体内的调用参数

```tsx
onClick={() => handleClick('react', 1)}
// → args: ['react', 1]  或  { keyword: 'react', page: 1 }（有 @track.args[N].key 时）
```

通过 `extractCallArgsNodes` 提取箭头函数体内第一个 `CallExpression` 的 `arguments`。

### 4.5 合并顺序

```js
{
  tag, text,              // 基础层（DOM 自动采集）
  ...staticParams,        // 静态层（@track.params）
  ...dataTrackProps,      // 动态层（data-track-*）
  args / customKeys       // 调用参数层（箭头函数体内调用）
}
```

---

## 五、运行时安全机制

### 5.1 三层防护

```
第一层：try-catch 包裹
  └── 所有埋点代码包裹在 try { ... } catch(e) {} 中
  └── 任何异常静默吞掉，不影响业务主流程

第二层：queueMicrotask 异步执行
  └── __TRACK_SDK__(cb) → window.queueMicrotask(cb) || Promise.resolve().then(cb)
  └── 埋点逻辑在微任务中执行，不阻塞事件处理主逻辑
  └── 选择 queueMicrotask 而非 setTimeout：延迟更低，上报更及时

第三层：DOM 属性安全降级
  └── (_e && _e.target && _e.target.tagName) || ''
  └── 自定义组件传递非 DOM 参数时返回空字符串，不抛异常
```

### 5.2 按需注入

- 文件中无 `on*` 事件 → 不注入任何代码（包括 SDK import）
- 有 `on*` 事件但无 `@track.eventName` → 不注入埋点调用代码（但仍注入 SDK import）
- 有 `@track.eventName` → 正常插桩

---

## 六、注释语法规范

### 6.1 注释指令一览

| 指令                        | 位置       | 必填   | 说明                                   |
| --------------------------- | ---------- | ------ | -------------------------------------- |
| `@track.eventName: <name>`  | 函数声明处 | **是** | 事件名，未声明时不插桩                 |
| `@track.params: { ... }`    | 函数声明处 | 否     | 静态参数，支持任意 JS 表达式和嵌套对象 |
| `@track.args[N].key: <key>` | 函数声明处 | 否     | 自定义第 N 个调用参数的上报 key        |
| `data-track-<attr>`         | JSX 属性   | 否     | 动态参数，自动 camelCase 转换          |

### 6.2 注释位置优先级

```
JSXAttribute 自身注释
  > JSXOpeningElement 注释
  > 标识符声明处注释（binding 追溯）
  > 箭头函数体内调用标识符注释
```

**推荐实践**：将注释放在 **hook 内部的函数声明处**，通过跨文件解析自动追溯到使用侧，使用侧无需任何注释。

### 6.3 完整示例

```ts
// hooks.ts
export const useClick = () => {
  /**
   * @track.eventName: handleClick
   * @track.params: { source: 'homepage', meta: { type: 'premium' } }
   * @track.args[0].key: keyword
   * @track.args[1].key: page
   */
  const h1Click = useCallback((_a: string, _b: string) => {
    console.log("business logic");
  }, []);

  return { h1Click };
};
```

```tsx
// App.tsx — 使用侧无需任何注释
const { h1Click } = useClick();

<h1 data-track-id="212121" onClick={() => h1Click("react", 1)}>
  Dashboard
</h1>;
```

生成的埋点数据：

```js
{
  tag: 'H1',                      // 自动采集
  text: 'Dashboard',              // 自动采集
  source: 'homepage',             // @track.params
  meta: { type: 'premium' },      // @track.params（嵌套对象）
  id: '212121',                   // data-track-id
  keyword: 'react',               // @track.args[0].key
  page: 1                         // @track.args[1].key
}
// → trackEvent('handleClick', above)
```

---

## 七、关键技术决策

### 7.1 为什么用 `t.xxx()` 而非 `@babel/template`？

`@babel/template` v8 将 `__XXX__` 格式标识符识别为占位符。注入代码中的 `__TRACK_SDK__` 命中此模式，即使设置 `placeholderAllowlist` 也会报错。最终方案是彻底改用 `@babel/types` 直接构建 AST。

### 7.2 为什么用 `@babel/parser` 而非 TypeScript Compiler API？

- 性能：`@babel/parser` 只做语法解析，不需要类型检查，速度快
- 一致性：项目本身用 Babel 编译，AST 格式一致
- 依赖简洁：`@babel/parser` 已是 Babel 插件的依赖
- 够用：需求只是“读取源文件的注释和函数结构”。别名路径解析只需读取 tsconfig.json 的 `compilerOptions.paths`，用 JSON.parse 即可，不需要完整的 TypeScript 类型解析能力

### 7.3 为什么非 click 事件需要 WeakMap 去重？

`onMouseEnter`、`onScroll` 等事件在同一元素上频繁触发，每次上报会产生大量重复数据。WeakMap 以 `event.target`（DOM 元素）为 key，同一元素只上报一次。选择 WeakMap 而非 Map 的原因：DOM 元素被移除后，WeakMap 条目自动 GC 回收，不会内存泄漏。

### 7.4 为什么选择 `queueMicrotask` 而非 `setTimeout`？

微任务在当前宏任务结束后立即执行，延迟更低，数据上报更及时。`setTimeout` 至少 4ms 延迟，且可能被浏览器节流。

---

## 八、已知限制

| 限制                                  | 原因                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 跨文件仅支持相对路径和别名路径 import | 不支持 `node_modules` 内的包路径解析（别名路径通过 tsconfig/jsconfig 自动检测或插件选项手动配置） |
| 跨文件注释修改需重启 dev server       | babel-loader 不向插件暴露 `addDependency` API                                                     |
| `@track.eventName` 是必填项           | 未声明时不插桩，这是设计决策而非缺陷                                                              |
| 仅支持箭头函数和直接引用              | 不支持 `this.handleClick`、`.bind()`、条件表达式等                                                |
| 自定义组件非 DOM 事件参数             | DOM 属性（tag/text）降级为空字符串，不会报错但数据缺失                                            |
