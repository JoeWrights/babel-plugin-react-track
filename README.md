# babel-plugin-react-track

基于 Babel AST 的 React 事件埋点自动插桩插件。通过声明式注释语法，在编译期自动为 React 事件处理器注入埋点代码，实现零侵入的数据采集。

## 特性

- **零侵入** — 只需在函数声明处添加注释，使用侧无需任何改动
- **跨文件解析** — 支持从 hook 定义处追溯到使用处，自动读取跨文件的 `@track` 注释
- **按需插桩** — 只有声明了 `@track.eventName` 的事件才会被注入，未声明的事件代码完全不变
- **自动采集** — 自动提取 DOM `tagName`、`textContent` 等基础数据
- **动态参数提取** — 自动提取箭头函数体内的调用参数，支持自定义 key 映射
- **静态参数** — 通过注释声明任意 JS 表达式作为静态埋点参数，支持变量引用和嵌套对象
- **`data-track-*` 属性** — 自动提取 JSX 上的 `data-track-*` 属性作为动态参数
- **非 click 事件去重** — 非 click 事件自动启用 WeakMap 去重，同一元素只上报一次
- **SDK 兜底** — 自动注入 `queueMicrotask` 兜底逻辑，确保埋点不影响主流程

## 安装

```bash
npm install babel-plugin-react-track
# 或
pnpm add babel-plugin-react-track
```

## 配置

### 基础配置

```js
// babel.config.js 或 rsbuild.config.ts
{
  plugins: [
    [
      "babel-plugin-react-track",
      {
        sdkSource: "your-tracker-sdk", // 埋点 SDK 的 import 来源，默认 'your-tracker-sdk'
        trackFnName: "trackEvent", // 埋点函数名，默认 '__trackEvent'
      },
    ],
  ];
}
```

### Rsbuild 集成

```ts
// rsbuild.config.ts
export default {
  tools: {
    bundlerChain(chain) {
      chain.module
        .rule("react-track")
        .test(/\.[jt]sx?$/)
        .include.add(appDir)
        .end()
        .use("babel-loader")
        .loader("babel-loader")
        .options({
          babelrc: false,
          configFile: false,
          plugins: [
            [
              require.resolve("@babel/plugin-syntax-typescript"),
              { isTSX: true },
            ],
            require.resolve("@babel/plugin-syntax-jsx"),
            [
              trackPlugin,
              {
                sdkSource: resolve(appDir, "src/lib/track.ts"),
                trackFnName: "trackEvent",
              },
            ],
          ],
        });
    },
  },
};
```

## 使用方式

### 基础用法：函数声明处添加注释

在 hook 或函数内部，通过 `@track.eventName` 注释声明事件名：

```ts
// hooks.ts
import { useCallback } from "react";

export const useClick = () => {
  // @track.eventName: handleClick
  const h1Click = useCallback((a: string, b: string) => {
    console.log("business logic");
  }, []);

  return { h1Click };
};
```

```tsx
// App.tsx — 使用侧无需任何注释
const { h1Click } = useClick();

<h1 onClick={() => h1Click("p1", "p2")}>Dashboard</h1>;
```

编译后自动注入埋点代码，上报数据：

```js
{
  tag: "H1",          // 自动采集
  text: "Dashboard",  // 自动采集
  args: ["p1", "p2"]  // 自动提取调用参数
}
// → trackEvent("handleClick", above)
```

### 静态参数

通过 `@track.params` 声明任意 JS 表达式：

```ts
// @track.eventName: buyClick
// @track.params: { source: 'homepage', productId: product.id, meta: { type: 'premium' } }
const handleBuy = useCallback(() => {
  /* ... */
}, []);
```

支持：

- 字面量：字符串、数字、布尔、null
- 变量引用：`product.id`
- 成员表达式：`window.location.href`
- 嵌套对象：`{ f: { h: "h" } }`

### 动态参数（`data-track-*`）

JSX 上的 `data-track-*` 属性自动提取为埋点参数，key 自动转为 camelCase：

```tsx
<h1
  data-track-id="212121"
  data-track-product-id={product.id}
  onClick={() => handleClick()}
>
  Dashboard
</h1>
```

生成参数：`{ id: "212121", productId: product.id, ... }`

### 自定义调用参数 key

通过 `@track.args[N].key` 自定义箭头函数体内调用参数的上报 key：

```ts
// @track.eventName: searchClick
// @track.args[0].key: keyword
// @track.args[1].key: page
const handleSearch = useCallback((_keyword: string, _page: number) => {
  // 业务逻辑不消费参数，只用于埋点
}, []);
```

```tsx
<input onClick={() => handleSearch("react", 1)} />
```

上报数据：`{ keyword: "react", page: 1, ... }`

> **提示**：函数参数使用 `_` 前缀配合 ESLint `argsIgnorePattern: "^_"` 可避免 `no-unused-vars` 报错。

## 注释语法参考

| 注释                        | 位置                   | 说明                                   |
| --------------------------- | ---------------------- | -------------------------------------- |
| `@track.eventName: <name>`  | 函数声明处（**必填**） | 事件名，未声明时不插桩                 |
| `@track.params: { ... }`    | 函数声明处             | 静态参数，支持任意 JS 表达式和嵌套对象 |
| `@track.args[N].key: <key>` | 函数声明处             | 自定义第 N 个调用参数的上报 key        |
| `data-track-<attr>`         | JSX 属性               | 动态参数，自动 camelCase 转换          |

### 注释位置优先级

```
JSXAttribute 注释 > JSXOpeningElement 注释 > 标识符声明注释 > 箭头函数体内调用标识符注释
```

**推荐**：将注释放在 **hook 内部的函数声明处**，通过跨文件解析自动追溯到使用侧。

## 工作原理

```
源码                          编译产物
─────────────────────         ──────────────────────────────────
<h1 onClick={handler}>   →    <h1 onClick={_e => {
                                    __TRACK_SDK__(() => {
                                      try {
                                        const _trackArgs = { tag, text, ... };
                                        trackEvent("handleClick", _trackArgs);
                                      } catch (e) {}
                                    });
                                    return handler(_e);
                                  }}>
```

1. **Program enter** — 扫描文件中的 `on*` 事件，注入 SDK import 和兜底代码
2. **JSXAttribute** — 匹配 `on[A-Z]*` 属性，从注释和 binding 链提取 `@track` 配置
3. **跨文件解析** — 当 binding 追溯到 import 声明时，读取源文件 AST 提取注释
4. **代码注入** — 在事件处理器中注入埋点调用，包裹在 `try-catch` + `queueMicrotask` 中

### 支持的表达式形式

```tsx
{/* 箭头函数 — 注入到函数体 */}
onClick={() => handleClick('arg1', 'arg2')}

{/* 直接引用 — 包装为新函数 */}
onClick={handleClick}
```

## 生成的运行时兜底

插件自动在文件顶部注入：

```js
// SDK 兜底：优先使用 queueMicrotask，降级为 Promise.resolve().then()
const __TRACK_SDK__ =
  window.queueMicrotask || ((cb) => Promise.resolve().then(cb));

// 非 click 事件额外注入去重 WeakMap
const _dedupMap = new WeakMap();
```

所有埋点调用都包裹在 `try-catch` 中，**确保埋点逻辑不影响业务主流程**。

## 限制

- **`@track.eventName` 是必填项** — 未声明时不插桩，避免对所有事件产生不必要的代码注入
- **跨文件仅支持相对路径 import** — 不支持 `node_modules` 或别名路径
- **跨文件注释修改需重启 dev server** — babel-loader 不向插件暴露 `addDependency` API，无法注册跨文件依赖
- **同文件注释修改正常 HMR** — 文件自身变化触发重新编译

## 开发

```bash
# 安装依赖
pnpm install

# 编译 TypeScript → lib/
pnpm build

# 类型检查
npx tsc --noEmit
```

## License

MIT
