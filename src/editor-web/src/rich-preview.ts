// Standalone harness to inspect the rich (Milkdown Crepe) rendering in isolation.
// Import order mirrors main.ts so the CSS cascade matches the real app:
// app.css (pulls tokens.css) -> code-theme.css -> rich.ts (pulls Crepe theme).
import './styles/app.css';
import './styles/code-theme.css';
import { mountRichEditor } from './editor/rich';

const SAMPLE = `# 富文本渲染检查 Rich Render Check

普通段落，包含 **粗体**、*斜体*、\`inline code\` 与 [链接](https://example.com)。中英文混排 mixed typography 测试 test。

## 无序列表 Unordered

- 第一项 first
- 第二项，稍微写长一点点，用来观察换行回绕时项目符号是否与文字首行基线对齐
  - 嵌套第二层 nested
  - 又一项 another
- 第三项 third

## 有序列表 Ordered

1. 第一步 step one
2. 第二步 step two
3. 第三步，同样写长一些看序号与文字的对齐关系是否稳定

## 任务列表 Tasks

- [x] 已完成的任务 done
- [ ] 未完成的任务 todo
- [ ] 另一个未完成，检查复选框与文字基线 checkbox baseline

## 引用 Blockquote

> 这是一段引用文字，用来检查左侧竖线与内边距是否协调。
> 第二行 second line。

## 表格 Table

| 名称 name | 类型 type | 说明 description |
| --- | --- | --- |
| foo | string | 示例 sample |
| bar | number | 另一个 another |

## 代码块 Code

\`\`\`ts
function hello(name: string) {
  return \`Hi \${name}\`;
}
\`\`\`

---

结束 End.
`;

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  // #app is height:100% overflow:hidden (tokens.css); make it a flex column so
  // .rich-pane (flex:1, overflow:auto) becomes the scroll container like in-app.
  app.style.display = 'flex';
  app.style.height = '100vh';
  app.innerHTML = `<div class="rich-pane"><div class="milkdown-host" data-rich-root></div></div>`;
  const root = app.querySelector<HTMLElement>('[data-rich-root]');
  if (root) {
    const editor = mountRichEditor(root, SAMPLE, () => {});
    editor.ready.catch((e) => console.error('rich mount failed', e));
  }
}

// Simple theme toggle for inspecting light/dark.
const btn = document.createElement('button');
btn.textContent = 'theme';
btn.style.cssText =
  'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 10px;border:1px solid #8888;border-radius:6px;background:#fff8;';
btn.onclick = () => {
  const el = document.documentElement;
  el.setAttribute('data-theme', el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
};
document.body.appendChild(btn);
