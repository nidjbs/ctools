# office_read — 行为契约

## 触发

- Launcher / agent 工具：`office_read <路径>`（alias：read_doc / 文档 / office），参数为绝对或 file_roots 内相对路径。

## 输入 / 输出

- 支持格式与解析：
  - 纯文本系：`.txt/.md/.csv/.tsv/.json/.log/.yaml/.yml/.xml/.html` → UTF-8 直读。
  - `.docx` → `jszip` 解包 `word/document.xml`，按段落提取 `<w:t>` 文本，段落以换行连接。
  - `.xlsx` → `jszip` 读 `sharedStrings` + 第一个 worksheet，单元格按行 `|` 连接。
  - `.pdf` → `pdfjs-dist` 逐页 `getTextContent`（**best-effort**：解析失败返回含原因的提示，不崩溃）。
- 输出文本 > 30KB 截断并标注；空输出返回 `(无可提取文本)`；不支持扩展名 → `不支持的格式: <ext>`。

## 边界与失败

- 越界路径（不在 file_roots 内）→ `拒绝`（同 file 工具）。
- 文件不存在/读取失败 → 带原因的错误文本。

## 安全约束

- 只读（agentTool 可放开，与 file_read 同级）；file_roots 限定暴露面。
- PDF/文档可能含宏内容：本命令**只取文本**，不执行任何内嵌内容。
