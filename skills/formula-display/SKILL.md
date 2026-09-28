---
name: formula-display
description: 在 CLI 对话中解释数学公式，或向 Markdown、LaTeX 等文件写入数学内容时使用。CLI 使用可读 Unicode，文件使用 LaTeX，按输出目标选择格式。
---

# 公式呈现

按输出目标选择格式：CLI 对话直接展示 Unicode；写入文件使用 LaTeX。同一任务同时回复用户和生成文件时，两处分别使用对应格式。

## CLI 对话

终端不渲染 LaTeX，公式用 Unicode 直接呈现：

- 希腊字母与运算符直接写：α β γ θ λ π σ φ ∑ ∏ ∫ √ ∇ ∂ ∈ ≈ ≤ ≥ ≠ ± × · → ⊙ ‖。
- 上下标优先用 Unicode：`xᵢ`、`x²`、`a₁`、`hₜ`；无法表示时用下划线或花括号：`π_θ`、`π_ref`、`s_{t+1}`。
- 分数写成 `a / b`，复杂分子分母加括号，例如 `(a + b) / (c + d)`。
- 条件概率用 `π(a∣s)`，范数与散度用 `‖`，保持竖线含义清楚，并避免与 Markdown 表格分隔符冲突。
- 行内公式用反引号包住；较复杂的公式放入代码块，一行一个等式，等号对齐。

例如：

```text
A_t = r_t + γ·V(s_{t+1}) − V(s_t)
L   = −𝔼[log π_θ(a∣s) · A_t] + β·KL(π_θ ‖ π_ref)
```

符号含义单独列出，与公式分开。

## 写入文件

使用标准 LaTeX 数学命令和上下标，按文件格式选择数学环境：

- 支持数学渲染的 Markdown：行内用 `$...$`，独立公式用 `$$...$$`；目标渲染器有专门约定时沿用其语法。
- `.tex`：行内用 `\(...\)`，独立公式用 `\[...\]`，多行对齐用 `aligned` 或 `align`。
- 分式用 `\frac{a}{b}`，上下标用 `x_i`、`x^2`、`s_{t+1}`，希腊字母用 `\alpha`、`\theta` 等命令。
- 条件概率用 `\pi_\theta(a \mid s)`；范数或散度用 `\lVert`、`\rVert` 或 `\Vert`。Markdown 表格中的公式使用这些命令表示竖线。

例如，写入支持 LaTeX 的 Markdown 文件：

```latex
$$
\begin{aligned}
A_t &= r_t + \gamma V(s_{t+1}) - V(s_t) \\
L &= -\mathbb{E}\left[\log \pi_\theta(a \mid s) A_t\right]
     + \beta\,\mathrm{KL}\left(\pi_\theta \Vert \pi_{\mathrm{ref}}\right)
\end{aligned}
$$
```

用于渲染的文件正文直接放数学表达式；展示 LaTeX 源码示例时才使用代码围栏。
